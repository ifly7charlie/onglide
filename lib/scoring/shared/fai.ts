// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// FAI ranking-list lookup. Given a contestant name + 2-letter country
// code, queries the FAI ranking-data REST API and returns a numeric
// pilot id (and as a side effect, kicks off a picture download from the
// standard /PilotImages/{id}.jpg URL).
//
// Previously this scraped the HTML search results page; FAI now exposes
// a JSON endpoint at rest/api/rlpilot which returns structured records
// directly, so we use that and skip the DOM-walking entirely.
//
// The scheduler only calls into this file behind the `idsig` gate in
// `shared/pilots.ts`, so the only time this fires is on a brand-new
// pilot insert or when the pilot's name/compno/country actually
// changes. Even then the calls are queued through the 1/min throttle
// below so we don't storm the ranking site on a fresh competition
// import.
//

import escape from 'sql-template-strings';
import getCountryISO3 from 'country-iso-2-to-3';

import type {ClassId, CompNo} from '../source';
import {downloadPictureCached} from './images';
import {ThrottledQueue} from './throttledQueue';
import {fetchFaiPilotDetail, faiPilotImageUrl, FAI_SYNTHETIC_FLOOR, type FaiPilotDetail} from './faiApi';

// Result handed back to the FAI worker: the resolved id plus the
// authoritative portrait filename from rlpilot detail, so the worker
// can write both columns in a single UPDATE.
export interface FaiResolveResult {
    pilotid: number;
    photo?: string;
}

// Throttle window for the background FAI resolve worker. The queue
// drains at roughly one lookup per minute, jittered across this range,
// so that scraping a fresh competition with 100 pilots doesn't smash
// the FAI ranking list with 100 back-to-back requests. Under normal
// steady-state operation (idsig gate means one-off resolves per pilot
// change), the queue is usually empty or near-empty.
const FAI_THROTTLE_MIN_MS = 45 * 1000;
const FAI_THROTTLE_MAX_MS = 75 * 1000;

//
// Background FAI resolve queue. Kept entirely in-memory, per-process —
// on restart we simply re-enqueue any still-unresolved pilots the next
// time upsertPilot sees them (rule 6 in shared/pilots.ts catches this
// via the synthetic-id check: fai > 3000000 → needsResolve).
//
// Dedup by `class:compno` so that re-firing upsertPilot while a lookup
// is already queued is a no-op — prevents re-entry storms from the
// hourly pilot refresh while the worker is still draining a big
// initial burst.
//

interface FaiRequest {
    db: any;
    log: (msg: string, ...args: unknown[]) => void;
    fullName: string;
    country: string;
    classid: ClassId;
    className?: string; // human-readable class name, log-only
    compno: CompNo;
}

function faiTag(req: FaiRequest): string {
    return req.className ? `${req.className}/${req.compno}` : `${req.classid}:${req.compno}`;
}

const faiQueue = new ThrottledQueue<FaiRequest>({
    name: 'fai worker',
    log: (...args) => console.log(...args),
    minMs: FAI_THROTTLE_MIN_MS,
    maxMs: FAI_THROTTLE_MAX_MS,
    keyOf: (req) => `${req.classid}:${req.compno}`,
    handle: async (req) => {
        try {
            const resolved = await findPilotByName(
                req.db, //
                req.log,
                req.fullName,
                req.country,
                req.classid,
                req.compno
            );
            if (resolved) {
                // Persist the resolved fai id. Guard against the worker
                // stomping on a real id that was written in the
                // meantime — only overwrite 0 / synthetic
                // (≥FAI_SYNTHETIC_FLOOR) values. The authoritative
                // portrait URL for this pilot is written to the
                // `images.url` column by findPilotByName's downstream
                // downloadPictureCached call, so no second column on
                // `pilots` is needed here.
                await req.db.query(escape`
                    UPDATE pilots
                    SET fai = ${resolved.pilotid}
                    WHERE class = ${req.classid}
                      AND compno = ${req.compno}
                      AND (fai = 0 OR fai IS NULL OR fai >= ${FAI_SYNTHETIC_FLOOR})
                `);
                req.log(`fai worker: resolved ${faiTag(req)} → ${resolved.pilotid}${resolved.photo ? ` (photo=${resolved.photo})` : ''}`);
            }
        } catch (e) {
            req.log(`fai worker: lookup failed for ${faiTag(req)}:`, e);
        }
    }
});

//
// enqueueFaiLookup — schedule a FAI ranking-list resolution for a
// pilot. Returns immediately; the background worker drains the queue
// at ~1/minute and UPDATEs `pilots.fai` on success. Dedup by
// class:compno means repeat calls during the drain window are no-ops.
//
export function enqueueFaiLookup(req: FaiRequest): void {
    faiQueue.enqueue(req);
}

//
// findPilotByName — search the FAI ranking list. Returns `{pilotid,
// photo?}` on a unique (post-disambiguation) match, or undefined
// otherwise. The caller writes both fields to `pilots` so subsequent
// image downloads can hit the authoritative portrait URL instead of
// guessing `{id}.jpg`.
//
// Side effects:
// - If the matched detail row carries a real `photo` filename (not the
//   "noimage.jpg" sentinel), an image download is started
//   (fire-and-forget) via downloadPictureCached. The 24h in-memory +
//   DB cache makes re-firing cheap.
//
export async function findPilotByName(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    lastname: string,
    countrycode: string,
    classid: ClassId,
    compno: CompNo
): Promise<FaiResolveResult | undefined> {
    const iso3 = getCountryISO3(countrycode) ?? '';
    log(`FAI lookup: "${lastname}" (${countrycode}${iso3 ? '/' + iso3 : ''})`);

    let json: any;
    try {
        const res = await fetch(
            `https://rankingdata.fai.org/rest/api/rlpilot?partialFullname=${encodeURIComponent(lastname)}&limit=10` //
        );
        if (res.status !== 200) {
            log(`FAI lookup returned ${res.status} for ${lastname}`);
            return undefined;
        }
        json = await res.json();
    } catch (e) {
        log(`FAI lookup fetch failed for ${lastname}:`, e);
        return undefined;
    }

    if (json?.status !== 200 || !Array.isArray(json?.data) || !json.data.length) {
        log(`FAI lookup: no data for "${lastname}"`);
        return undefined;
    }

    // Tokenise the supplied name once for the surname-match filter.
    // Every token must appear somewhere in (firstname + " " + surname)
    // to survive — this prevents a partial-prefix API match like
    // "Jenk" returning an unrelated pilot.
    const tokens = lastname
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2);

    const candidates = (json.data as any[]).filter((p) => {
        if (iso3 && p?.nationality && p.nationality !== iso3) return false;
        const full = `${p?.firstname ?? ''} ${p?.surname ?? ''}`.toLowerCase();
        return tokens.every((t) => full.includes(t));
    });

    if (candidates.length === 0) {
        log(`FAI lookup: no matching candidate for "${lastname}"`);
        return undefined;
    }

    // If more than one candidate survives the name+country filter, pull
    // the per-pilot detail endpoint for each and keep only the ones that
    // look active — rankingpts > 0. Stale entries (a pilot who hasn't
    // competed in ~9+ years, or was never used) show rankingpts=0,
    // rankingpos=0, lastcomp=9999. The FAI ranking points decay with age,
    // so "rankingpts > 0" is a decent proxy for "has competed recently".
    //
    // We remember the detail rows we fetch here so the "authoritative
    // photo filename" lookup below doesn't need a second roundtrip for
    // the winner.
    let chosen: FaiPilotDetail | undefined;
    let pilotid: number | undefined;

    if (candidates.length === 1) {
        pilotid = Number(candidates[0]?.pilotid);
    } else {
        log(`FAI lookup: ${candidates.length} candidates for "${lastname}" — checking activity`);
        const active: {detail: FaiPilotDetail; pts: number}[] = [];
        for (const c of candidates) {
            const id = Number(c?.pilotid);
            if (!id || Number.isNaN(id)) continue;
            const detail = await fetchFaiPilotDetail(log, id);
            if (!detail) continue;
            const pts = Number(detail.rankingpts ?? 0);
            if (pts > 0) {
                active.push({detail, pts});
            } else {
                log(`  FAI ${id}: stale (rankingpts=${pts})`);
            }
        }
        if (active.length === 0) {
            log(`FAI lookup: all ${candidates.length} candidates for "${lastname}" are stale`);
            return undefined;
        }
        // Most-active wins if multiple still qualify — highest ranking
        // points is a sensible tiebreaker since the ranking list is
        // literally a leaderboard.
        active.sort((a, b) => b.pts - a.pts);
        chosen = active[0].detail;
        pilotid = Number(chosen.pilotid);
        if (active.length > 1) {
            log(`FAI lookup: ${active.length} active candidates for "${lastname}", picked ${pilotid} (pts=${active[0].pts})`);
        } else {
            log(`FAI lookup: narrowed "${lastname}" to active pilot ${pilotid} (pts=${active[0].pts})`);
        }
    }

    if (!pilotid || Number.isNaN(pilotid)) {
        log(`FAI lookup: invalid pilotid in result for "${lastname}"`);
        return undefined;
    }

    // For the single-candidate path we haven't hit the detail endpoint
    // yet, but we need the authoritative `photo` filename so the caller
    // can store it in `pilots.faiphoto` and the image worker can use a
    // real URL instead of guessing. One extra roundtrip per resolved
    // pilot — acceptable since this is gated behind the idsig change
    // check upstream.
    if (!chosen) {
        chosen = await fetchFaiPilotDetail(log, pilotid);
    }
    const photo = chosen?.photo;

    log(`-> resolved "${lastname}" → fai id ${pilotid}${photo ? ` photo=${photo}` : ''}`);

    // Fire-and-forget image download. Only fires when the detail row
    // actually has a real portrait — skip entirely when photo is the
    // "noimage.jpg" sentinel or missing so we don't eat a guaranteed
    // 404 and poison the 24h cache with a NULL.
    const directUrl = faiPilotImageUrl(photo);
    if (directUrl) {
        downloadPictureCached(db, log, classid, compno, {directUrl}).catch(() => undefined);
    }

    return {pilotid, photo};
}
