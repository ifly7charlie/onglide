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
import {enqueueFaiLookup, enqueuePortraitRefresh} from './fai';
import {FAI_SYNTHETIC_FLOOR} from './faiApi';

//
// PilotRecord — the canonical shape adapters hand in. Adapters convert
// SoaringSpot's `Contestant`/`CN`/`Class`/`Glider`/etc columns or RST's
// equivalents into this before calling upsertPilot().
//
export interface PilotRecord {
    classid: ClassId;
    className?: string; // human-readable class label, log-only
    compno: CompNo;
    fullName: string; // "First Last" — used for FAI search and gravatar
    club: string | null;
    country: string | null; // 2-letter code; null = source doesn't provide one (don't touch existing)
    glider: string | null;
    greg: string | null;
    handicap: number;
}

// Helper used by the various per-pilot log lines so we never have to
// stare at a raw classid hash. Falls back to the classid alone when no
// name has been threaded through.
function pilotTag(pilot: Pick<PilotRecord, 'classid' | 'className' | 'compno'>): string {
    return pilot.className ? `${pilot.className}/${pilot.compno}` : `${pilot.classid}:${pilot.compno}`;
}

// Wrap a single fetch's worth of upserts so the adapter can hand the
// observed set straight back to the scheduler for diff-based pruning.
// Also remembers the human-readable class name per classid so that
// downstream log lines (eg. pruneUnseenPilots) can show something more
// useful than the hashed classid.
export class PilotFetchAccumulator {
    readonly observed = new Map<ClassId, Set<CompNo>>();
    readonly classNames = new Map<ClassId, string>();

    record(classid: ClassId, compno: CompNo, className?: string): void {
        let set = this.observed.get(classid);
        if (!set) {
            set = new Set();
            this.observed.set(classid, set);
        }
        set.add(compno);
        if (className && !this.classNames.has(classid)) {
            this.classNames.set(classid, className);
        }
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

// Polish competitions publish handicaps as raw fs values (typically
// 600–1000+, where higher fs = worse glider). Convert with H = fsm/fs
// where fsm is the worst (highest) fs value in the class, so the worst
// glider maps to 100 and better gliders map above 100 — same shape as
// the standard percentage handicap. Gated on competition.countrycode =
// 'PL' AND at least one raw handicap > 600 (the threshold is a sanity
// check so a PL comp using normal % handicaps still falls through to
// correctHandicap). Returns a per-class converter.
export function correctClassHandicaps(
    rawHandicaps: (number | string | null | undefined)[], //
    countrycode: string | null | undefined,
    log?: (msg: string, ...args: unknown[]) => void
): (raw: number | string | null | undefined) => number {
    if ((countrycode ?? '').toUpperCase() !== 'PL') return correctHandicap;
    let fsm = 0;
    for (const h of rawHandicaps) {
        const v = typeof h === 'number' ? h : parseFloat(String(h ?? ''));
        if (!isNaN(v) && v > fsm) fsm = v;
    }
    if (fsm <= 600) return correctHandicap;
    if (log) log(`Polish handicap detected: fsm=${fsm} (worst glider in class)`);
    return (raw) => {
        const v = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
        if (!v || isNaN(v) || v <= 0) return 100;
        return (fsm / v) * 100;
    };
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
    // FAI ids (and their portraits) are assigned well before a comp
    // starts and effectively never change mid-event, so we only look
    // them up on:
    //   - a brand-new pilot (no row yet, fai column is 0/null), or
    //   - an idsig change (organizer fixed the name / country / compno).
    // An unresolved synthetic id is left alone — re-querying FAI every
    // fetchPilots run just burns requests on a ranking list that isn't
    // changing. If the first attempt misses and the name later gets
    // corrected upstream, sigChanged catches it and queues a fresh
    // lookup.
    const needsResolve = sigChanged || !fainumber;

    if (needsResolve) {
        const country = pilot.country || existing[0]?.country || '';
        // Hand the FAI lookup off to the background queue — it
        // throttles to ~1/min so initial loads of a fresh competition
        // don't hammer the ranking site. In the meantime we UPSERT
        // with a synthetic id; the worker writes the real fai back
        // later via a targeted UPDATE.
        enqueueFaiLookup({
            db,
            log,
            fullName: pilot.fullName,
            country,
            classid: pilot.classid,
            className: pilot.className,
            compno: pilot.compno
        });
        if (!fainumber) {
            // Synthetic id — reserved range starts at 3,000,000 and is
            // bumped per call so distinct unresolved pilots get distinct
            // ids within a single fetch.
            fainumber = FAI_SYNTHETIC_FLOOR + ++syntheticCounterRef.n;
        }
    }

    // Portrait refresh:
    //   - sigChanged (name/country/compno edit): the worker path above
    //     does a full findPilotByName + downloadPictureCached, so a
    //     changed portrait filename is picked up there.
    //   - resolved, sig unchanged: kick off a daily detail-only refresh.
    //     enqueuePortraitRefresh dedups to 24h per pilot per process and
    //     goes direct to the FAI detail endpoint (no name search), so
    //     the common case costs one lightweight request per pilot per
    //     day and picks up portrait changes without hammering the
    //     ranking list.
    if (!sigChanged && fainumber && fainumber < FAI_SYNTHETIC_FLOOR) {
        enqueuePortraitRefresh(db, log, pilot.classid, pilot.compno, fainumber);
    }

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
                    ${pilot.fullName.substring(0, 30)},
                    ${''},
                    ${pilot.club?.substring(0, 80) ?? ''},
                    NULL,
                    ${fainumber},
                    ${newSig},
                    ${pilot.country ?? ''},
                    ${gravatar(pilot.fullName)},
                    ${pilot.compno},
                    'Y',
                    ${pilot.glider?.substring(0, 30) ?? ''},
                    ${pilot.greg?.substring(0, 8) ?? ''},
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
                country = COALESCE(NULLIF(VALUES(country), ''), country),
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
        accumulator.record(pilot.classid, pilot.compno, pilot.className);
    } catch (e) {
        log(`pilot INSERT failed ${pilotTag(pilot)}:`, e);
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
                const label = accumulator.classNames.get(classid) ?? classid;
                log(`pruned ${r.affectedRows} unseen pilot(s) from class ${label}`);
            }
        } catch (e) {
            const label = accumulator.classNames.get(classid) ?? classid;
            log(`pruneUnseenPilots failed for class ${label}:`, e);
        }
    }

    // Trackers needs a row for each pilot so fill any missing.
    try {
        await db.query('INSERT IGNORE INTO tracker ( class, compno, type, trackerid ) select class, compno, "flarm", "unknown" from pilots');
    } catch (e) {
        log(`tracker backfill failed:`, e);
    }
}
