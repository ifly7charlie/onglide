// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Pilot upsert + per-class roster diff. Source-agnostic — every adapter
// hands `PilotRecord`s into here and lets this file own the SQL +
// `idsig`/FAI bookkeeping. The previous monolithic `update_pilots()` lived
// in ssscrape.ts; this is the same shape minus the source-specific HTML
// parsing, plus rule 6 (FAI lookups only on new pilot or
// firstname|lastname|compno change).
//

import {createHash} from 'crypto';
import escape from 'sql-template-strings';

import type {ClassId, CompNo} from '../source';
import {findPilotByName} from './fai';
import {downloadPictureCached} from './images';

//
// PilotRecord — the canonical shape adapters hand in. Adapters convert
// SoaringSpot's `Contestant`/`CN`/`Class`/`Glider`/etc columns or RST's
// equivalents into this before calling upsertPilot().
//
export interface PilotRecord {
    classid: ClassId;
    compno: CompNo;
    fullName: string; // "First Last" — used for FAI search and gravatar
    club: string | null;
    country: string; // 2-letter code
    glider: string | null;
    greg: string | null;
    handicap: number;
}

// Wrap a single fetch's worth of upserts so the adapter can hand the
// observed set straight back to the scheduler for diff-based pruning.
export class PilotFetchAccumulator {
    readonly observed = new Map<ClassId, Set<CompNo>>();

    record(classid: ClassId, compno: CompNo): void {
        let set = this.observed.get(classid);
        if (!set) {
            set = new Set();
            this.observed.set(classid, set);
        }
        set.add(compno);
    }
}

// Stable hash of the columns that gate FAI re-resolution. Rule 6: only
// re-call findPilotByName when one of these changes. Country matters
// because the FAI search is nationality-scoped, so a pilot switching
// flag means the previous lookup is no longer authoritative.
function computeIdSig(pilot: PilotRecord): string {
    return createHash('sha1')
        .update(
            [
                (pilot.fullName ?? '').toLowerCase().trim(),
                (pilot.compno ?? '').toLowerCase().trim(),
                (pilot.country ?? '').toLowerCase().trim()
            ].join('|')
        )
        .digest('hex')
        .substring(0, 32);
}

// Email gravatar key, matching the previous behaviour (lower-case,
// whitespace stripped, suffixed with @comps.onglide.com).
function gravatar(name: string): string {
    return createHash('md5')
        .update(((name ?? '') + '@comps.onglide.com').replace(/\s/g, '').toLowerCase())
        .digest('hex');
}

// Some scoring sources hand back handicaps in funky units. Same
// normalisation the old ssscrape used.
export function correctHandicap(handicap: number | string | null | undefined): number {
    const h = typeof handicap === 'number' ? handicap : parseFloat(String(handicap ?? ''));
    if (!h || isNaN(h)) return 100;
    if (h < 2) return h * 100;
    if (h > 140) return h / 10;
    return h;
}

//
// upsertPilot — INSERT … ON DUPLICATE KEY UPDATE for one row, gated FAI
// resolve, fire-and-forget image refresh. The fai-lookup gate is rule 6:
// only call findPilotByName when (a) no row exists yet, or (b) idsig
// changed. The result is persisted in the new `idsig` column so it
// survives process restarts.
//
export async function upsertPilot(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    pilot: PilotRecord,
    accumulator: PilotFetchAccumulator,
    syntheticCounterRef: {n: number}
): Promise<void> {
    const newSig = computeIdSig(pilot);

    // Existing row — used for both the FAI gate and country fallback.
    const existing =
        (await db.query(escape`
            SELECT
                fai,
                country,
                idsig
            FROM
                pilots
            WHERE
                compno = ${pilot.compno}
                AND class = ${pilot.classid}
        `)) ?? [];

    let fainumber = existing[0]?.fai ?? 0;
    const sigChanged = !existing.length || existing[0]?.idsig !== newSig;
    const needsResolve = sigChanged || !fainumber || fainumber > 3000000;

    if (needsResolve) {
        const country = pilot.country || existing[0]?.country || '';
        const resolved = sigChanged ? await findPilotByName(db, log, pilot.fullName, country, pilot.classid, pilot.compno) : undefined;
        if (resolved) {
            fainumber = resolved;
        } else if (!fainumber) {
            // Synthetic id — reserved range starts at 3,000,000 and is
            // bumped per call so distinct unresolved pilots get distinct
            // ids within a single fetch.
            fainumber = 3000000 + ++syntheticCounterRef.n;
        }
    }

    // fire-and-forget image refresh; downloadPictureCached has its own
    // 24h debounce so this is a no-op on hot paths.
    downloadPictureCached(db, log, pilot.classid, pilot.compno, {
        igc_id: fainumber,
        compno: pilot.fullName,
        class: pilot.classid,
        greg: pilot.greg ?? undefined
    }).catch((e) => log(`image refresh failed for ${pilot.classid}:${pilot.compno}:`, e));

    try {
        await db.query(escape`
            INSERT INTO
                pilots (
                    class,
                    firstname,
                    lastname,
                    homeclub,
                    username,
                    fai,
                    idsig,
                    country,
                    email,
                    compno,
                    participating,
                    glidertype,
                    greg,
                    handicap,
                    registered,
                    registereddt
                )
            VALUES
                (
                    ${pilot.classid},
                    ${pilot.fullName},
                    ${''},
                    ${pilot.club},
                    NULL,
                    ${fainumber},
                    ${newSig},
                    ${pilot.country},
                    ${gravatar(pilot.fullName)},
                    ${pilot.compno},
                    'Y',
                    ${pilot.glider},
                    ${pilot.greg ?? ''},
                    ${pilot.handicap},
                    'Y',
                    NOW()
                ) ON DUPLICATE KEY
            UPDATE class =
            VALUES
                (class),
                firstname =
            VALUES
                (firstname),
                lastname =
            VALUES
                (lastname),
                homeclub =
            VALUES
                (homeclub),
                fai =
            VALUES
                (fai),
                idsig =
            VALUES
                (idsig),
                country =
            VALUES
                (country),
                email =
            VALUES
                (email),
                participating =
            VALUES
                (participating),
                handicap =
            VALUES
                (handicap),
                glidertype =
            VALUES
                (glidertype),
                greg =
            VALUES
                (greg),
                registereddt = NOW()
        `);
        accumulator.record(pilot.classid, pilot.compno);
    } catch (e) {
        log(`pilot INSERT failed ${pilot.compno} ${pilot.classid}:`, e);
    }
}

//
// pruneUnseenPilots — replaces the old `DELETE FROM pilots WHERE
// registereddt < NOW() - 15 MIN` watermark, which only worked under a
// 5-minute scrape cadence. Now that fetches can be hourly+, we instead
// diff against the explicit set of `(class, compno)` pairs the adapter
// just observed and delete anything in the touched classes that didn't
// show up.
//
export async function pruneUnseenPilots(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    accumulator: PilotFetchAccumulator
): Promise<void> {
    if (accumulator.observed.size === 0) return;

    for (const [classid, seen] of accumulator.observed) {
        if (seen.size === 0) {
            // No pilots seen for this class at all — be conservative and
            // skip the diff rather than nuke everyone, since an empty
            // fetch is more likely a parse glitch than a true empty roster.
            continue;
        }
        const compnoList = Array.from(seen);
        try {
            const r = await db.query(
                'DELETE FROM pilots WHERE class = ? AND compno NOT IN (' + compnoList.map(() => '?').join(',') + ')', //
                [classid, ...compnoList]
            );
            if (r?.affectedRows) {
                log(`pruned ${r.affectedRows} unseen pilot(s) from class ${classid}`);
            }
        } catch (e) {
            log(`pruneUnseenPilots failed for class ${classid}:`, e);
        }
    }

    // Trackers needs a row for each pilot so fill any missing.
    try {
        await db.query('INSERT IGNORE INTO tracker ( class, compno, type, trackerid ) select class, compno, "flarm", "unknown" from pilots');
    } catch (e) {
        log(`tracker backfill failed:`, e);
    }
}
