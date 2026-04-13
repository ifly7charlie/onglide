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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Memoised "we already looked at this pilot in this process within the
// last 24h". Keyed `class:compno`. Values are epoch ms of last check.
const memCache = new Map<string, number>();

function memKey(classid: ClassId, compno: CompNo): string {
    return `${classid}:${compno}`;
}

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
// downloadPictureCached — cache-friendly entrypoint. Returns silently if
// the cache is fresh, otherwise tries each `pictureurl` template (or the
// supplied `directUrl`) until one succeeds. Errors never throw out — a
// failed image is not a fatal scrape error.
//
export async function downloadPictureCached(
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

    // Layer 2 — DB row freshness check. Mirrors the previous behaviour
    // exactly: only SELECT rows that have a non-NULL image AND were
    // touched within the last 24h. NULL rows still trigger a re-attempt
    // (mediated by the in-memory cache above).
    try {
        const lastUpdated = (
            await db.query(escape`
                SELECT
                    updated
                FROM
                    images
                WHERE
                    class = ${classid}
                    AND compno = ${compno}
                    AND image IS NOT NULL
                    AND unix_timestamp () - updated < 86400
            `)
        )?.[0];

        if (lastUpdated) {
            memCache.set(memKey(classid, compno), Date.now());
            return;
        }
    } catch (e) {
        log(`images cache check failed for ${classid}:${compno}:`, e);
    }

    // Layer 3 — try the configured templates (or the explicit directUrl).
    const candidates: string[] = [];
    if (context.directUrl) candidates.push(context.directUrl);

    if (!context.directUrl) {
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
        await db.query(escape`
            INSERT INTO
                images (class, compno, image, updated)
            VALUES
                (
                    ${classid},
                    ${compno},
                    ${data},
                    unix_timestamp ()
                ) ON DUPLICATE KEY
            UPDATE image =
            VALUES
                (image),
                updated =
            VALUES
                (updated)
        `);
        return true;
    } catch (e) {
        log(`${classid}:${compno}: image fetch from ${url} threw:`, e);
        return false;
    }
}
