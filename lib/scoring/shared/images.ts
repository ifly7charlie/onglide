// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Pilot picture downloader. Backs the existing `images` table:
//   class char(15), compno char(4), image mediumblob, updated int(11)
//
// Layered cache:
//   1. In-memory `Map<class:compno, lastCheckedMs>` — survives one process,
//      stops us from issuing the SELECT below at all if we already checked
//      this pilot in the last 24h. (Rule 6.)
//   2. The DB row's `updated` column — if `unix_timestamp() - updated <
//      86400`, skip the HTTP fetch. Survives process restarts.
//   3. `scoringsource WHERE type='pictureurl'` — list of URL templates
//      with `{PLACEHOLDER}` substitutions. Tried in order.
//
// On a successful download the row's `image` blob is replaced. On a
// failed download the row is upserted with `image = NULL` so a single
// failure doesn't trigger fresh fetches every cycle — the 24h cache
// applies to NULLs too.
//

import escape from 'sql-template-strings';

import type {ClassId, CompNo} from '../source';
import {FAI_SYNTHETIC_FLOOR} from './faiApi';
import {ThrottledQueue} from './throttledQueue';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Throttle window for the background image-download worker. A fresh
// competition with 100 pilots used to fire 100 near-simultaneous
// downloads at the moment upsertPilot ran; the queue below drains them
// one at a time, jittered across this window, so we stay polite to
// whichever host the picture URLs resolve to (usually but not always
// rankingdata.fai.org). Order of magnitude picked to finish a ~100-pilot
// comp in ~15 minutes, well within the first scoring heartbeat cycle.
const IMAGE_THROTTLE_MIN_MS = 5 * 1000;
const IMAGE_THROTTLE_MAX_MS = 15 * 1000;

// Memoised "we already looked at this pilot in this process within the
// last 24h". Keyed `class:compno`. Values are epoch ms of last check.
const memCache = new Map<string, number>();

function memKey(classid: ClassId, compno: CompNo): string {
    return `${classid}:${compno}`;
}

//
// Background image-download queue. Dedup by `class:compno` so that
// re-firing upsertPilot while a download is already queued is a no-op.
// Drained sequentially by the shared ThrottledQueue helper.
//
interface ImageRequest {
    db: any;
    log: (msg: string, ...args: unknown[]) => void;
    classid: ClassId;
    compno: CompNo;
    context: PictureContext;
}

const imageQueue = new ThrottledQueue<ImageRequest>({
    name: 'image worker',
    log: (...args) => console.log(...args),
    minMs: IMAGE_THROTTLE_MIN_MS,
    maxMs: IMAGE_THROTTLE_MAX_MS,
    keyOf: (req) => memKey(req.classid, req.compno),
    handle: async (req) => {
        try {
            await performImageDownload(req.db, req.log, req.classid, req.compno, req.context);
        } catch (e) {
            req.log(`image worker: download failed for ${req.classid}:${req.compno}:`, e);
        }
    }
});

//
// Context handed to the URL templater. The `pictureurl` rows in
// scoringsource use `{IGC_ID}` / `{COMPNO}` / `{CLASS}` / `{GREG}`
// placeholders.
//
export interface PictureContext {
    igc_id?: number;
    compno?: string;
    class?: string;
    greg?: string;
    // Bypass the templater entirely with a fully-resolved URL — used by
    // findPilotByName when it pulls an <img src> off the FAI ranking row.
    directUrl?: string;
}

//
// downloadPictureCached — public entrypoint. Resolves immediately after
// enqueueing; the actual HTTP fetch happens in a background worker that
// drains the queue one at a time with a jittered throttle so we don't
// hammer whichever host the configured `pictureurl` templates resolve
// to. Dedup is by `class:compno`, so re-calling during the worker's
// drain window is a no-op.
//
// Errors never throw out — a failed image is not a fatal scrape error,
// and the worker loop logs and moves on.
//
export async function downloadPictureCached(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    classid: ClassId,
    compno: CompNo,
    context: PictureContext
): Promise<void> {
    // Cheap in-memory short-circuit so a repeat enqueue during the same
    // process window never even makes it into the queue. The DB and
    // HTTP layers of the cache are applied inside the worker's handler
    // so both enqueue paths see a consistent view.
    const memHit = memCache.get(memKey(classid, compno));
    if (memHit && Date.now() - memHit < ONE_DAY_MS) {
        return;
    }
    imageQueue.enqueue({db, log, classid, compno, context});
}

//
// performImageDownload — the actual cache + fetch work that used to live
// inline in downloadPictureCached. Called from the worker handler above,
// one item at a time.
//
async function performImageDownload(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    classid: ClassId,
    compno: CompNo,
    context: PictureContext
): Promise<void> {
    // Layer 1 — in-memory.
    const memHit = memCache.get(memKey(classid, compno));
    if (memHit && Date.now() - memHit < ONE_DAY_MS) {
        return;
    }

    // Layer 2 — DB row freshness check. Also reads the stored `url`
    // column so subsequent refreshes hit exactly the URL we last
    // successfully downloaded from instead of guessing.
    let storedUrl: string | null = null;
    try {
        const row = (
            await db.query(escape`
                SELECT
                    url,
                    image IS NOT NULL AS hasImage,
                    unix_timestamp() - updated AS age
                FROM
                    images
                WHERE
                    class = ${classid}
                    AND compno = ${compno}
            `)
        )?.[0];

        if (row?.hasImage && row?.age != null && Number(row.age) < 86400) {
            memCache.set(memKey(classid, compno), Date.now());
            return;
        }
        if (row?.url) storedUrl = String(row.url);
    } catch (e) {
        log(`images cache check failed for ${classid}:${compno}:`, e);
    }

    // Layer 3 — ordered candidate list.
    //   1. explicit directUrl from the caller (FAI resolver path)
    //   2. previously-successful URL we already stored on this row
    //   3. guessed FAI `{id}.jpg` fallback — only when no real URL is
    //      known yet AND we have a resolved FAI id
    //   4. configured `scoringsource.pictureurl` templates
    const candidates: string[] = [];
    if (context.directUrl) candidates.push(context.directUrl);
    if (storedUrl && !candidates.includes(storedUrl)) candidates.push(storedUrl);

    if (!context.directUrl && !storedUrl) {
        // Built-in FAI fallback: if the context has a real FAI id
        // (anything below the synthetic floor), try the standard pilot
        // photo URL on rankingdata.fai.org. This means a freshly-
        // installed Onglide with no `pictureurl` rows still gets photos
        // for every pilot the FAI resolver placed in the real-id range.
        // A 404 is handled cleanly by fetchAndStore and the next
        // successful download replaces this guess with the real URL
        // in the `images.url` column.
        if (context.igc_id && context.igc_id > 0 && context.igc_id < FAI_SYNTHETIC_FLOOR) {
            candidates.push(`https://rankingdata.fai.org/PilotImages/${context.igc_id}.jpg`);
        }

        try {
            const urlRows = (await db.query(escape`
                SELECT
                    url
                FROM
                    scoringsource
                WHERE
                    type = 'pictureurl'
            `)) as {url: string}[];
            for (const u of urlRows) {
                candidates.push(
                    u.url.replace(/\{([A-Z_]+)\}/gi, (_, v) => {
                        const key = v.toLowerCase();
                        const direct = (context as any)[v] ?? (context as any)[key];
                        return direct != null ? String(direct) : '';
                    })
                );
            }
        } catch (e) {
            log(`images: scoringsource pictureurl lookup failed:`, e);
        }
    }

    let success = false;
    for (const url of candidates) {
        log(`downloading picture for ${classid}:${compno} from ${url}`);
        if (await fetchAndStore(db, log, classid, compno, url)) {
            success = true;
            break;
        }
    }

    if (!success) {
        log(`${classid}:${compno}: image update failed`);
        try {
            // Failed-state upsert leaves the `url` column alone — a
            // previously-known good URL shouldn't be wiped just because
            // one retry failed.
            await db.query(escape`
                INSERT INTO
                    images (class, compno, image, updated)
                VALUES
                    (
                        ${classid},
                        ${compno},
                        NULL,
                        unix_timestamp ()
                    ) ON DUPLICATE KEY
                UPDATE image = NULL,
                updated =
                VALUES
                    (updated)
            `);
        } catch (e) {
            log(`images: failed-state upsert for ${classid}:${compno} threw:`, e);
        }
    }

    // Mark in-memory regardless of outcome — failed fetches should not
    // retry every minute, the 24h debounce applies equally.
    memCache.set(memKey(classid, compno), Date.now());
}

async function fetchAndStore(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    classid: ClassId,
    compno: CompNo,
    url: string
): Promise<boolean> {
    try {
        const res = await fetch(url, {
            headers: {Referer: 'https://' + (process.env.NEXT_PUBLIC_SITEURL ?? '') + '/'}
        });
        if (res.status != 200) {
            log(`${classid}:${compno}: ${url} returned ${res.status}: ${res.statusText}`);
            return false;
        }
        const data = Buffer.from(await res.arrayBuffer());
        if (!data?.length) {
            log(`${classid}:${compno}: ${url} returned no data`);
            return false;
        }
        // Store the successful source URL alongside the blob so a
        // subsequent refresh reuses the known-good URL instead of
        // re-walking the candidate list.
        await db.query(escape`
            INSERT INTO
                images (class, compno, image, updated, url)
            VALUES
                (
                    ${classid},
                    ${compno},
                    ${data},
                    unix_timestamp (),
                    ${url}
                ) ON DUPLICATE KEY
            UPDATE image =
            VALUES
                (image),
                updated =
            VALUES
                (updated),
                url =
            VALUES
                (url)
        `);
        return true;
    } catch (e) {
        log(`${classid}:${compno}: image fetch from ${url} threw:`, e);
        return false;
    }
}
