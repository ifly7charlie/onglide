// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// SgpSource — `ScoringSource` adapter for the Sailplane Grand Prix
// upstream. Replaces the legacy bin/sgp.ts daemon: the JSON fetch and
// parsing live here, the DB writes go through the same shared helpers
// (lib/scoring/shared/*) the SoaringSpot adapter uses. The scheduler
// picks this up by registering an instance against `type = 'sgp'`.
//
// Parity with the retired bin/sgp.ts is pilot roster + task install only
// — the SGP JSON `{task, tracks}` payload has never carried per-pilot
// scoring rows, so we don't populate pilotresult speeds/distances here.
//

import escape from 'sql-template-strings';
import getCountryISO2 from 'country-iso-3-to-2';

import {makeClassId} from '../../classid';
import {toDateCode} from '../../datecode';
import {localDatecode} from '../shared/timezone';
import {upsertClass, syncClassHandicapFlag} from '../shared/classes';
import {PilotFetchAccumulator, upsertPilot, pruneUnseenPilots, type PilotRecord} from '../shared/pilots';
import {upsertTaskAndLegs} from '../shared/tasks';
import {downloadPictureCached} from '../shared/images';
import {updateTracker} from '../shared/trackers';

import type {ClassId, CompNo, FetchPilotsOptions, FetchPilotsResult, FetchResultsOptions, FetchResultsResult, ScoringSource, SkipDayPredicate, SourceCtx} from '../source';

// The legacy daemon used a fixed raw class name 'sgp' hashed with the
// scoringsource.compid to produce a unique classid. Keeping the same
// value here means existing rows in `competition` / `classes` carry
// over unchanged when the adapter takes over from bin/sgp.ts.
const SGP_RAW_CLASS = 'sgp';
const SGP_CLASS_LABEL = 'SGP';
const SGP_TASK_SCRIPT = 'Sailplane Grand Prix';

// SGP turnpoint.type → upsertTaskAndLegs' oz_type. Selects the
// direction value the helper later resolves via lib/scoring/shared/tasks.ts
// oz_types: symmetric→symmetrical, next→np, previous→pp. Matches the
// legacy `oz_direction` map at bin/sgp.ts:37.
const SGP_OZ_TYPE: Record<string, string> = {
    Turnpoint: 'symmetric',
    Finish: 'previous',
    Start: 'next'
};

function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

// Convert SGP's `startOpenTs` (seconds-since-midnight integer) into the
// 'HH:MM:SS' MySQL TIME literal that tasks.nostart expects. The legacy
// daemon refused anything outside 10:00–17:00 local as a sanity check
// against bogus feed values; preserve that gate.
function deriveStartOpen(startOpenTs: number | string | undefined | null): string {
    if (!startOpenTs) return '00:00:00';
    const sec = parseInt(String(startOpenTs));
    if (!sec || isNaN(sec)) return '00:00:00';
    const hh = Math.trunc(sec / 3600);
    if (hh < 10 || hh > 17) return '00:00:00';
    const mm = Math.trunc((sec % 3600) / 60) % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

// Extract a yyyy-mm-dd string from SGP's compDate (which is sometimes a
// pre-formatted ISO string, sometimes a unix-ms-style number).
function extractCompDate(compDate: any): string | null {
    if (typeof compDate === 'string') {
        const m = compDate.match(/^[0-9-]{10}/);
        return m ? m[0] : null;
    }
    if (compDate) {
        try {
            return new Date(compDate).toISOString().substring(0, 10);
        } catch {
            return null;
        }
    }
    return null;
}

async function fetchSgpJson(ctx: SourceCtx): Promise<any | null> {
    try {
        const res = await fetch(ctx.url);
        if (!res.ok) {
            ctx.log(`SGP fetch ${ctx.url} → ${res.status} ${res.statusText}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        ctx.log(`SGP fetch failed for ${ctx.compid}:`, e);
        return null;
    }
}

//
// Mark the SGP class as a regatta-start class. The SoaringSpot adapter
// flips this flag from the contest name regex / from same-time-start
// detection on the daily results page; here the source itself is the
// signal so we set it unconditionally. One-way flip, idempotent.
//
async function flagGrandPrixClass(ctx: SourceCtx, classid: ClassId): Promise<void> {
    await ctx.db.query(escape`
        UPDATE classes
        SET grandprixstart = 'Y'
        WHERE class = ${classid} AND grandprixstart <> 'Y'
    `);
}

//
// ensureCompetitionRow — minimal `competition` row seeding, mirroring
// the soaringspot adapter's INSERT IGNORE pattern. tz defaults to
// 'Europe/London'; the task install later re-runs the IANA tz lookup
// against the taskleg coordinates, so the default is just a placeholder
// for the first heartbeat before any task data arrives.
//
async function ensureCompetitionRow(ctx: SourceCtx): Promise<void> {
    const count = await ctx.db.query(escape`SELECT COUNT(*) cnt FROM competition WHERE compid = ${ctx.compid}`);
    if (count?.[0]?.cnt) return;
    ctx.log(`SGP: pre-populating competition row for ${ctx.compid}`);
    await ctx.db.query(escape`
        INSERT IGNORE INTO competition (compid, tz, tzoffset, mainwebsite, name, start, end)
        VALUES
            (
                ${ctx.compid},
                'Europe/London',
                3600,
                ${ctx.url},
                'Sailplane Grand Prix',
                DATE_SUB(CURDATE(), INTERVAL 30 DAY),
                DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            )
    `);
}

//
// Reshape the SGP task JSON into the `day` shape upsertTaskAndLegs
// understands, then call the helper. The helper owns the full
// transaction (compstatus state, contestday upsert, pilotresult
// placeholders, taskleg bearings/distances, lt/lg backfill, post-tx tz
// refinement) — keeping it as the single source of task-write truth
// avoids drifting between adapters.
//
async function installSgpTask(ctx: SourceCtx, classid: ClassId, task: any): Promise<void> {
    if (!task) return;
    const date = extractCompDate(task.compDate);
    if (!date) {
        ctx.log(`SGP: no usable date in task; skipping`, {compDate: task.compDate, startOpenTs: task.startOpenTs});
        return;
    }

    const startOpen = deriveStartOpen(task.startOpenTs);

    // upsertTaskAndLegs expects task_points in radians (it calls toDeg()
    // internally for both the leg geometry and the angle columns). SGP
    // gives degrees + metres, so we convert here and let the helper
    // round-trip back to degrees for storage.
    const taskPoints = (task.turnpoints || []).map((tp: any, i: number) => {
        const isLine = tp.observationZone === 'Line';
        return {
            point_index: i,
            multiple_start: 0,
            name: String(tp.name ?? ''),
            latitude: toRad(Number(tp.latitude)),
            longitude: toRad(Number(tp.longitude)),
            oz_line: isLine,
            oz_type: SGP_OZ_TYPE[tp.type] ?? 'symmetric',
            oz_radius1: Number(tp.radius ?? 0),
            // For lines the helper hardcodes a1=90, so this is ignored;
            // for SGP sectors we want the legacy a1: 360 for Turnpoints
            // (full cylinder), 90 for Start/Finish (sector apex).
            oz_angle1: isLine ? toRad(90) : toRad(tp.type === 'Turnpoint' ? 360 : 90),
            oz_radius2: 0,
            oz_angle2: 0,
            oz_angle12: 0
        };
    });

    const day = {
        task_date: date,
        task_type: 'racing',
        task_number: 1,
        task_distance: 0,
        no_start: startOpen,
        result_status: '',
        notes: '',
        task_points: taskPoints
    };

    const installed = await upsertTaskAndLegs(ctx.db, ctx.log, classid, SGP_CLASS_LABEL, day);
    if (!installed) return;

    // The helper's contestday upsert leaves `script` empty. Legacy SGP
    // populated it with "Sailplane Grand Prix" so the front-end can show
    // the source on the per-day card; restore that here as a one-line
    // follow-up against the row the helper just wrote.
    try {
        await ctx.db.query(escape`
            UPDATE contestday
            SET script = LEFT(${SGP_TASK_SCRIPT}, 60)
            WHERE class = ${classid} AND datecode = ${toDateCode(date)}
        `);
    } catch (e) {
        ctx.log(`SGP: contestday script update failed for ${classid} ${date}:`, e);
    }
}

//
// Upsert the tracker row for one SGP `tracks[]` entry. SGP carries
// FLARM IDs on the pilot record itself (no separate robocontrol lookup
// needed), so we extract every 6-hex tail from `trackId` and append any
// paired OGN tracker. Routes through `updateTracker` so feed-conflict
// protection (robocontrol vs sgp) and `trackerhistory` rows match the
// other adapters.
//
async function upsertSgpTracker(
    ctx: SourceCtx, //
    classid: ClassId,
    compno: CompNo,
    pilot: any
): Promise<void> {
    const flarmIds: string[] = String(pilot.trackId ?? '').match(/[0-9A-F]{6}$/gi) || [];
    if (pilot.ognTrackerPaired) {
        const m = String(pilot.ognTrackerPaired).match(/[0-9A-F]{6}$/gi);
        if (m) flarmIds.push(...m);
    }
    const trackerid = flarmIds.filter((d) => d?.length).join(',') || 'unknown';

    // updateTracker is UPDATE-only and would no-op for a brand-new
    // pilot — seed an unclaimed placeholder row first. Mirrors the
    // soaringspot adapter at lines 303-314.
    try {
        await ctx.db.query(escape`
            INSERT IGNORE INTO tracker (class, compno, type, trackerid)
            VALUES (${classid}, ${compno}, 'flarm', 'unknown')
        `);
    } catch (e) {
        ctx.log(`SGP tracker placeholder failed for ${classid}/${compno}:`, e);
    }
    await updateTracker(ctx.db, ctx.log, classid, compno, trackerid, 'sgp');
}

//
// SgpSource — implementation of `ScoringSource` for the SGP JSON API.
// Each ctx.url returns `{task, tracks}` in one call; we fetch it twice
// per scheduler tick (once for pilots, once for tasks) so the methods
// stay independent in the scheduler's view. The cost is one extra GET
// per heartbeat, which is far below SGP's polling budget.
//
export class SgpSource implements ScoringSource {
    readonly type = 'sgp';
    readonly trackerIntervalMs = 5 * 60 * 1000;
    // SGP's task+tracks JSON is cheap and the L→S nostart rewrite (start
    // line time) needs to land within seconds, not the 10-min FAST
    // default. Honoured by the scheduler's desiredTaskCadence for L and
    // S phases.
    readonly activeTasksCadenceMs = 60 * 1000;

    async ensureMetadata(ctx: SourceCtx): Promise<void> {
        try {
            await ensureCompetitionRow(ctx);
        } catch (e) {
            ctx.log(`SGP ensureMetadata failed for ${ctx.compid}:`, e);
        }
    }

    async fetchPilots(ctx: SourceCtx, options?: FetchPilotsOptions, prefetchedJson?: any): Promise<FetchPilotsResult> {
        const accumulator = new PilotFetchAccumulator();
        const synthetic = {n: 0};

        const res = prefetchedJson !== undefined ? prefetchedJson : await fetchSgpJson(ctx);
        if (!res || !Array.isArray(res.tracks)) {
            return {observed: accumulator.observed};
        }

        const classid = makeClassId(ctx.compid, SGP_RAW_CLASS) as ClassId;
        const todayDatecode = localDatecode(ctx.tz);

        await upsertClass(ctx.db, ctx.log, ctx.compid, classid, SGP_CLASS_LABEL, todayDatecode);
        await flagGrandPrixClass(ctx, classid);

        for (const pilot of res.tracks) {
            const competitionId = String(pilot?.competitionId ?? '');
            if (!competitionId || /(TBA|TBD)/i.test(competitionId)) {
                continue;
            }
            const compno = competitionId.substring(0, 4) as CompNo;
            const fullName = String(pilot.pilotName ?? '');
            const country3 = pilot.country ? String(pilot.country).substring(0, 3) : null;
            const country2 = country3 ? getCountryISO2(country3) || null : null;

            const record: PilotRecord = {
                classid,
                className: SGP_CLASS_LABEL,
                compno,
                fullName,
                club: null,
                country: country2,
                glider: pilot.aircraft ? String(pilot.aircraft).substring(0, 30) : null,
                greg: pilot.registration ? String(pilot.registration).substring(0, 8) : null,
                handicap: 100
            };

            await upsertPilot(ctx.db, ctx.log, record, accumulator, synthetic);
            await upsertSgpTracker(ctx, classid, compno, pilot);

            // SGP carries a direct portrait URL on the track row; route it
            // through the standard image cache so DB freshness gates and
            // the in-memory dedup apply uniformly across sources.
            if (pilot.portraitUrl) {
                downloadPictureCached(ctx.db, ctx.log, classid, compno, {directUrl: String(pilot.portraitUrl)}).catch((e) => ctx.log(`SGP portrait enqueue failed for ${classid}/${compno}:`, e));
            }
        }

        // skipPrune is set by the trackers-cadence path so a flaky
        // upstream can't wipe the roster at 5-minute intervals. The
        // tracker upsert above is the only side-effect we want then.
        if (!options?.skipPrune) {
            await pruneUnseenPilots(ctx.db, ctx.log, accumulator);
            for (const cid of accumulator.observed.keys()) {
                await syncClassHandicapFlag(ctx.db, ctx.log, cid);
            }
        }

        return {observed: accumulator.observed};
    }

    // Trackers, pilots, and task all come in the same JSON payload, so
    // the trackers cadence fetches once and dispatches to both
    // installSgpTask and fetchPilots(skipPrune). skipPrune avoids wiping
    // the roster on a flap; installing the task here means the FAST
    // tasks cadence isn't the only path that picks up startline-time
    // amendments — the 5 min trackers cadence catches them too, for free.
    async fetchTrackers(ctx: SourceCtx): Promise<void> {
        const res = await fetchSgpJson(ctx);
        if (!res) return;
        if (res.task) {
            const classid = makeClassId(ctx.compid, SGP_RAW_CLASS) as ClassId;
            const todayDatecode = localDatecode(ctx.tz);
            await upsertClass(ctx.db, ctx.log, ctx.compid, classid, SGP_CLASS_LABEL, todayDatecode);
            await flagGrandPrixClass(ctx, classid);
            await installSgpTask(ctx, classid, res.task);
        }
        await this.fetchPilots(ctx, {skipPrune: true}, res);
    }

    async fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate, options?: FetchResultsOptions): Promise<FetchResultsResult> {
        const observedClasses = new Set<ClassId>();

        // SGP has no per-pilot results to fetch — the JSON payload only
        // carries `task` + `tracks`. resultsOnly therefore short-circuits.
        if (options?.resultsOnly) {
            return {observedClasses};
        }

        const res = await fetchSgpJson(ctx);
        if (!res || !res.task) {
            return {observedClasses};
        }

        const classid = makeClassId(ctx.compid, SGP_RAW_CLASS) as ClassId;
        observedClasses.add(classid);

        const todayDatecode = localDatecode(ctx.tz);
        await upsertClass(ctx.db, ctx.log, ctx.compid, classid, SGP_CLASS_LABEL, todayDatecode);
        await flagGrandPrixClass(ctx, classid);

        const date = extractCompDate(res.task.compDate);
        if (date && skipDay(classid, toDateCode(date), date)) {
            ctx.log(`SGP: skipping old day ${date} for class ${classid}`);
            return {observedClasses};
        }

        await installSgpTask(ctx, classid, res.task);

        return {observedClasses};
    }
}
