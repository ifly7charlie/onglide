// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// SgpaeroSource — `ScoringSource` adapter for the Sailplane Grand Prix
// data served by the crosscountry.aero native REST API, e.g.
//   https://www.crosscountry.aero/c/sgp/rest/comp/92
//
// This is a separate, much richer feed than the legacy SGP JSON the
// `sgp` adapter consumes (glidertracking.fai.org/.../SGPrace-latest.json)
// — the two formats are NOT interchangeable, so this is a standalone
// parser rather than a subclass of SgpSource.
//
// Beyond the roster + task that the legacy SGP feed carried, this feed
// also exposes per-pilot start/finish/distance/points, so this adapter
// additionally writes scores into `pilotresult` the way the SoaringSpot
// adapter does (see processAeroResults / soaringspot.ts processDayResults).
//
// Feed shape (top level): { p, c, d, t, i, z, j }
//   p — pilots, object keyed by pilot-id
//   c — competition meta
//   d — the current race day { i, d(date), l, a(start-open ms-of-day), k(task), r.s[](results) }
//   t — overall results { s: {pilotId: totalPoints}, r: {dayId: {pilotId: status}} }
//   i — day schedule list (unused — we only keep the latest day, `d`)
//
// Only the latest day (`d`) is installed/scored; the feed's other days
// are intentionally ignored.
//

import escape from 'sql-template-strings';

import {makeClassId} from '../../classid';
import {toDateCode} from '../../datecode';
import {localDatecode, nowInTz} from '../shared/timezone';
import {upsertClass, syncClassHandicapFlag} from '../shared/classes';
import {PilotFetchAccumulator, upsertPilot, pruneUnseenPilots, type PilotRecord} from '../shared/pilots';
import {upsertTaskAndLegs} from '../shared/tasks';
import {updateTracker} from '../shared/trackers';

import type {ClassId, CompNo, FetchPilotsOptions, FetchPilotsResult, FetchResultsOptions, FetchResultsResult, ScoringSource, SkipDayPredicate, SourceCtx} from '../source';

// Reuse the legacy SGP raw class name so a comp's classid is stable
// regardless of which SGP feed (sgp or sgpaero) it is wired to. The two
// adapters never run for the same comp, but keeping makeClassId's input
// identical means the existing `competition`/`classes` rows carry over.
const SGP_RAW_CLASS = 'sgp';
const SGP_CLASS_LABEL = 'SGP';
const SGP_TASK_SCRIPT = 'Sailplane Grand Prix';

// crosscountry turnpoint geometry. Each `data.g[]` entry has y='line'|
// 'cylinder'; index 0 is the Start, the last is the Finish, everything
// between is a Turnpoint. We map those positions to the same oz_types the
// SGP adapter uses: Start→np (next), Finish→pp (previous), Turnpoint→
// symmetrical. upsertTaskAndLegs resolves these to direction values.
const SGP_OZ_TYPE_START = 'next';
const SGP_OZ_TYPE_FINISH = 'previous';
const SGP_OZ_TYPE_TURN = 'symmetric';

// Same rationale as the SGP adapter: a stalled socket must not pin the
// per-heartbeat slot. 20 s timeout, abort-with-error rather than hang.
const SGP_FETCH_TIMEOUT_MS = 20_000;

function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

// Two-digit zero pad for HH:MM:SS assembly.
function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

// Convert an absolute epoch (ms) into an 'HH:MM:SS' MySQL TIME literal in
// the competition's local timezone. Returns null for a falsy/zero epoch
// so the COALESCE in the UPDATE leaves the existing value untouched.
function epochToLocalTime(tz: string, epochMs: number | null | undefined): string | null {
    if (!epochMs) return null;
    const lt = nowInTz(tz, epochMs);
    return `${pad2(lt.hour)}:${pad2(lt.minute)}:${pad2(lt.second)}`;
}

// The day's start-gate-open arrives as milliseconds-since-local-midnight
// (e.g. 62160000 → 17:16). Mirror the SGP adapter's 10:00–17:00 sanity
// gate against bogus feed values; out-of-range collapses to '00:00:00'.
function deriveStartOpen(startOpenMs: number | string | undefined | null): string {
    if (!startOpenMs) return '00:00:00';
    const ms = parseInt(String(startOpenMs));
    if (!ms || isNaN(ms)) return '00:00:00';
    const hh = Math.trunc(ms / 3_600_000);
    if (hh < 10 || hh > 17) return '00:00:00';
    const mm = Math.trunc((ms % 3_600_000) / 60_000) % 60;
    return `${pad2(hh)}:${pad2(mm)}:00`;
}

// The feed never carries a per-turnpoint cylinder radius — start/finish
// lines have `r`, intermediate cylinders do not. Instead `d.k.data.h`
// lists the distinct sector sizes used in the task, keyed by handicap,
// e.g. {"100": [500, 1700]}. The feed gives no way to tell which
// turnpoint uses which size, so per operator instruction we apply the
// LARGEST size to every turnpoint cylinder (the lenient choice for
// crossing detection). Returns null when no usable size is present.
function extractTurnRadius(task: any): number | null {
    const h = task?.data?.h;
    if (!h || typeof h !== 'object') return null;
    const radii: number[] = [];
    for (const v of Object.values<any>(h)) {
        const list = Array.isArray(v) ? v : [v];
        for (const n of list) {
            const num = Number(n);
            if (num > 0) radii.push(num);
        }
    }
    return radii.length ? Math.max(...radii) : null;
}

// Extract the trailing 6-hex FLARM/ICAO id from the feed's `q` field,
// which carries a 3-letter prefix (ICA/FLR/NAV) + 6 hex, e.g.
// 'ICA4065B4' → '4065B4'. Returns null when absent/unparseable.
function flarmFromQ(q: string | null | undefined): string | null {
    const m = String(q ?? '').match(/[0-9A-F]{6}$/i);
    return m ? m[0] : null;
}

async function fetchSgpAeroJson(ctx: SourceCtx): Promise<any | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SGP_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(ctx.url, {signal: ac.signal});
        if (!res.ok) {
            ctx.log(`SGPaero fetch ${ctx.url} → ${res.status} ${res.statusText}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        if ((e as any)?.name === 'AbortError') {
            ctx.log(`SGPaero fetch timed out after ${SGP_FETCH_TIMEOUT_MS} ms for ${ctx.compid} (${ctx.url})`);
        } else {
            ctx.log(`SGPaero fetch failed for ${ctx.compid}:`, e);
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Mark the SGP class as a regatta-start class. Like the SGP adapter, the
// source itself is the signal, so set it unconditionally. Idempotent.
async function flagGrandPrixClass(ctx: SourceCtx, classid: ClassId): Promise<void> {
    await ctx.db.query(escape`
        UPDATE classes
        SET grandprixstart = 'Y'
        WHERE class = ${classid} AND grandprixstart <> 'Y'
    `);
}

// Pull the IANA timezone the feed advertises for the day's takeoff
// airfield (d.k.data.at.z), or null if absent.
function extractFeedTz(json: any): string | null {
    const tz = json?.d?.k?.data?.at?.z;
    return typeof tz === 'string' && tz.length ? tz : null;
}

//
// Minimal `competition` row seeding, mirroring the SGP adapter. tz is
// seeded from the feed's airfield tz when available (more immediate than
// the post-task-install coordinate refinement); otherwise a placeholder.
//
async function ensureCompetitionRow(ctx: SourceCtx, feedTz: string | null): Promise<void> {
    const tz = feedTz ?? 'Europe/London';
    const count = await ctx.db.query(escape`SELECT COUNT(*) cnt FROM competition WHERE compid = ${ctx.compid}`);
    if (count?.[0]?.cnt) {
        // Existing row — only correct the tz if the feed gives a real one
        // and the stored value is still the placeholder default.
        if (feedTz) {
            await ctx.db.query(escape`
                UPDATE competition SET tz = ${feedTz}
                WHERE compid = ${ctx.compid} AND tz = 'Europe/London' AND tz <> ${feedTz}
            `);
        }
        return;
    }
    ctx.log(`SGPaero: pre-populating competition row for ${ctx.compid}`);
    await ctx.db.query(escape`
        INSERT IGNORE INTO competition (compid, tz, tzoffset, mainwebsite, name, start, end)
        VALUES
            (
                ${ctx.compid},
                ${tz},
                3600,
                ${ctx.url},
                'Sailplane Grand Prix',
                DATE_SUB(CURDATE(), INTERVAL 30 DAY),
                DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            )
    `);
}

//
// Reshape the crosscountry task (d.k) into the `day` shape
// upsertTaskAndLegs understands, then call the helper. The helper owns
// the full transaction (compstatus, contestday, pilotresult placeholders,
// taskleg geometry, tz refinement) — keeping it the single source of
// task-write truth.
//
async function installAeroTask(ctx: SourceCtx, classid: ClassId, day: any): Promise<boolean> {
    const task = day?.k;
    const date = typeof day?.d === 'string' ? day.d.match(/^[0-9-]{10}/)?.[0] : null;
    if (!task || !date) {
        ctx.log(`SGPaero: no usable task/date; skipping`, {date: day?.d});
        return false;
    }

    const turnpoints: any[] = task?.data?.g ?? [];
    if (!turnpoints.length) {
        ctx.log(`SGPaero: task ${task?.name ?? ''} has no turnpoints; skipping`);
        return false;
    }

    const startOpen = deriveStartOpen(day.a);
    const lastIdx = turnpoints.length - 1;

    // Turnpoint cylinders carry no radius in the feed; derive the shared
    // size from data.h (largest, per operator instruction). 500 m fallback
    // when the feed omits data.h entirely.
    const turnRadius = extractTurnRadius(task) ?? 500;
    if (extractTurnRadius(task) === null) {
        ctx.log(`SGPaero: task ${task?.name ?? ''} has no data.h sector sizes; defaulting turnpoint radius to ${turnRadius} m`);
    }

    // upsertTaskAndLegs expects task_points in radians (it toDeg()s back
    // for storage). The feed gives degrees + metres.
    const taskPoints = turnpoints.map((tp: any, i: number) => {
        const isLine = String(tp.y).toLowerCase() === 'line';
        const ozType = i === 0 ? SGP_OZ_TYPE_START : i === lastIdx ? SGP_OZ_TYPE_FINISH : SGP_OZ_TYPE_TURN;
        // Lines carry their own radius (start/finish, e.g. 2500/250);
        // cylinders use the shared turnpoint radius from data.h.
        return {
            point_index: i,
            multiple_start: 0,
            name: String(tp.n ?? ''),
            latitude: toRad(Number(tp.a)),
            longitude: toRad(Number(tp.o)),
            oz_line: isLine,
            oz_type: ozType,
            oz_radius1: isLine ? Number(tp.r ?? 0) : turnRadius,
            // Lines hardcode a1=90 in the helper; for cylinders we want a
            // full 360 turnpoint cylinder, 90 for a start/finish sector.
            oz_angle1: isLine ? toRad(90) : toRad(i === 0 || i === lastIdx ? 90 : 360),
            oz_radius2: 0,
            oz_angle2: 0,
            oz_angle12: 0
        };
    });

    const dayRecord = {
        task_date: date,
        task_type: 'racing',
        task_number: 1,
        task_distance: 0,
        no_start: startOpen,
        result_status: '',
        notes: '',
        task_points: taskPoints
    };

    const installed = await upsertTaskAndLegs(ctx.db, ctx.log, classid, SGP_CLASS_LABEL, dayRecord);
    if (!installed) return false;

    // The helper leaves contestday.script empty; restore the SGP label so
    // the front-end per-day card shows the source. Same follow-up as the
    // SGP adapter.
    try {
        await ctx.db.query(escape`
            UPDATE contestday
            SET script = LEFT(${SGP_TASK_SCRIPT}, 60)
            WHERE class = ${classid} AND datecode = ${toDateCode(date)}
        `);
    } catch (e) {
        ctx.log(`SGPaero: contestday script update failed for ${classid} ${date}:`, e);
    }

    return true;
}

//
// Upsert the tracker row for one crosscountry pilot. The FLARM id lives
// on the pilot record's `q` field. Routes through updateTracker so feed-
// conflict protection and trackerhistory match the other adapters. Uses
// the 'sgp' feed tag (sgp/sgpaero never coexist for one comp).
//
async function upsertAeroTracker(ctx: SourceCtx, classid: ClassId, compno: CompNo, pilot: any): Promise<void> {
    const flarm = flarmFromQ(pilot?.q);
    const trackerid = flarm ?? 'unknown';

    // updateTracker is UPDATE-only — seed an unclaimed placeholder first
    // so a brand-new pilot's row exists. Mirrors the SGP adapter.
    try {
        await ctx.db.query(escape`
            INSERT IGNORE INTO tracker (class, compno, type, trackerid)
            VALUES (${classid}, ${compno}, 'flarm', 'unknown')
        `);
    } catch (e) {
        ctx.log(`SGPaero tracker placeholder failed for ${classid}/${compno}:`, e);
    }
    await updateTracker(ctx.db, ctx.log, classid, compno, trackerid, 'sgp');
}

//
// processAeroResults — write the day's per-pilot scores into pilotresult.
// Patterned on processDayResults() in the SoaringSpot adapter, but reading
// crosscountry fields. Runs AFTER installAeroTask, which creates the
// pilotresult placeholder rows (syncPilotResultRows). Grand-prix is a flat
// 100 handicap so handicapped == actual.
//
// Linkage: each result row's `h` is the pilot-id (object key into `p`);
// `result.j` is a compno that can be stale, so we always take the compno
// from the pilot record (`p[h].d`).
//
async function processAeroResults(
    ctx: SourceCtx, //
    classid: ClassId,
    date: string,
    day: any,
    pilotsById: Record<string, any>,
    totals: Record<string, any>
): Promise<number> {
    const {db, log, tz} = ctx;
    const dateCode = toDateCode(date);
    const results: any[] = day?.r?.s ?? [];
    let rows = 0;

    for (const row of results) {
        const pilotId = String(row?.h ?? '');
        const pilot = pilotsById[pilotId];
        if (!pilot) continue;
        const compno = String(pilot.d ?? '').substring(0, 4);
        if (!compno || /(TBA|TBD)/i.test(compno)) continue;

        const start = epochToLocalTime(tz, row.a);
        const finish = epochToLocalTime(tz, row.b);
        const speed = Number(row.s ?? 0);
        const distance = Number(row.d ?? 0);
        const daypoints = Number(row.p ?? 0);
        const totalpoints = Number(totals?.[pilotId] ?? 0);

        // Same status derivation as the SoaringSpot path: a scored speed
        // means finished, a scored distance means landed-out, else started.
        const scoredStatus = speed > 0 ? 'F' : distance > 0 ? 'H' : 'S';

        const r = await db.query(escape`
            UPDATE pilotresult
            SET
                start = TIME(COALESCE(${start}, start)),
                finish = TIME(COALESCE(${finish}, finish)),
                duration = COALESCE(TIMEDIFF(${finish}, ${start}), duration),
                statuschanged = (CASE WHEN (scoredstatus = ${scoredStatus}) THEN statuschanged ELSE NOW() END),
                datafromscoring = 'Y',
                igcavailable = 'N',
                scoredstatus = ${scoredStatus},
                status = (
                    CASE
                        WHEN ((status = '-' OR status = 'S' OR status = 'G') AND ${finish ?? ''} != '')
                            THEN 'F'
                        WHEN ((status = '-' OR status = 'S' OR status = 'G') AND ${distance > 0 ? 'Y' : ''} != '')
                            THEN 'H'
                        ELSE status
                    END
                ),
                speed = ${speed},
                distance = ${distance},
                hspeed = ${speed},
                hdistance = ${distance},
                daypoints = ${daypoints},
                totalpoints = ${totalpoints}
            WHERE
                datecode = ${dateCode}
                AND compno = ${compno}
                AND class = ${classid}
        `);
        rows += r?.affectedRows ?? 0;
    }

    if (rows) {
        await db.query(escape`
            UPDATE contestday
            SET results_uploaded = NOW()
            WHERE class = ${classid} AND datecode = ${dateCode} AND status != 'Z'
        `);
    }

    log(`SGPaero: processed ${rows} score row(s) for ${date}`);
    return rows;
}

//
// SgpaeroSource — implementation of `ScoringSource` for the
// crosscountry.aero SGP REST API. As with the SGP adapter, the single
// JSON payload carries pilots, task, and results, so we re-fetch it on
// each stream and dispatch.
//
export class SgpaeroSource implements ScoringSource {
    readonly type = 'sgpaero';
    readonly trackerIntervalMs = 5 * 60 * 1000;
    // Cheap JSON + the L→S nostart rewrite needs to land within seconds,
    // so override the L/S task cadence to 1 min (same as SGP).
    readonly activeTasksCadenceMs = 60 * 1000;

    async ensureMetadata(ctx: SourceCtx): Promise<void> {
        try {
            // A cheap fetch here gives us the feed tz up front; if it
            // fails we still seed the row with the default placeholder.
            const json = await fetchSgpAeroJson(ctx);
            await ensureCompetitionRow(ctx, extractFeedTz(json));
        } catch (e) {
            ctx.log(`SGPaero ensureMetadata failed for ${ctx.compid}:`, e);
        }
    }

    async fetchPilots(ctx: SourceCtx, options?: FetchPilotsOptions, prefetchedJson?: any): Promise<FetchPilotsResult> {
        const accumulator = new PilotFetchAccumulator();
        const synthetic = {n: 0};

        const res = prefetchedJson !== undefined ? prefetchedJson : await fetchSgpAeroJson(ctx);
        const pilots = res?.p;
        if (!pilots || typeof pilots !== 'object') {
            return {observed: accumulator.observed};
        }

        const classid = makeClassId(ctx.compid, SGP_RAW_CLASS) as ClassId;
        const todayDatecode = localDatecode(ctx.tz);

        await upsertClass(ctx.db, ctx.log, ctx.compid, classid, SGP_CLASS_LABEL, todayDatecode);
        await flagGrandPrixClass(ctx, classid);

        for (const pilot of Object.values<any>(pilots)) {
            const compnoRaw = String(pilot?.d ?? '');
            if (!compnoRaw || /(TBA|TBD)/i.test(compnoRaw)) {
                continue;
            }
            const compno = compnoRaw.substring(0, 4) as CompNo;
            const first = String(pilot.f ?? '').trim();
            const last = String(pilot.l ?? '').trim();
            const fullName = `${first} ${last}`.trim();
            const country = pilot.z ? String(pilot.z).substring(0, 2).toUpperCase() : null;

            const record: PilotRecord = {
                classid,
                className: SGP_CLASS_LABEL,
                compno,
                fullName,
                club: null,
                country,
                glider: pilot.s ? String(pilot.s).substring(0, 30) : null,
                greg: pilot.w ? String(pilot.w).substring(0, 8) : null,
                handicap: 100
            };

            await upsertPilot(ctx.db, ctx.log, record, accumulator, synthetic);
            await upsertAeroTracker(ctx, classid, compno, pilot);
        }

        // skipPrune (trackers-cadence path) keeps a flaky upstream from
        // wiping the roster at 5-minute intervals.
        if (!options?.skipPrune) {
            await pruneUnseenPilots(ctx.db, ctx.log, accumulator);
            for (const cid of accumulator.observed.keys()) {
                await syncClassHandicapFlag(ctx.db, ctx.log, cid);
            }
        }

        return {observed: accumulator.observed};
    }

    // Trackers, pilots, task, and results all arrive in the same payload,
    // so the trackers cadence fetches once and dispatches to task install
    // + fetchPilots(skipPrune) + results. Installing here means the 5-min
    // trackers cadence also picks up startline-time amendments for free.
    async fetchTrackers(ctx: SourceCtx): Promise<void> {
        const res = await fetchSgpAeroJson(ctx);
        if (!res) return;

        const classid = makeClassId(ctx.compid, SGP_RAW_CLASS) as ClassId;
        const todayDatecode = localDatecode(ctx.tz);
        await upsertClass(ctx.db, ctx.log, ctx.compid, classid, SGP_CLASS_LABEL, todayDatecode);
        await flagGrandPrixClass(ctx, classid);

        if (res.d) {
            const installed = await installAeroTask(ctx, classid, res.d);
            const date = typeof res.d.d === 'string' ? res.d.d.match(/^[0-9-]{10}/)?.[0] : null;
            if (installed && date) {
                await processAeroResults(ctx, classid, date, res.d, res.p ?? {}, res.t?.s ?? {});
            }
        }
        await this.fetchPilots(ctx, {skipPrune: true}, res);
    }

    async fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate, options?: FetchResultsOptions): Promise<FetchResultsResult> {
        const observedClasses = new Set<ClassId>();

        const res = await fetchSgpAeroJson(ctx);
        if (!res || !res.d) {
            return {observedClasses};
        }

        const classid = makeClassId(ctx.compid, SGP_RAW_CLASS) as ClassId;
        observedClasses.add(classid);

        const todayDatecode = localDatecode(ctx.tz);
        await upsertClass(ctx.db, ctx.log, ctx.compid, classid, SGP_CLASS_LABEL, todayDatecode);
        await flagGrandPrixClass(ctx, classid);

        const date = typeof res.d.d === 'string' ? res.d.d.match(/^[0-9-]{10}/)?.[0] : null;
        if (date && skipDay(classid, toDateCode(date), date)) {
            ctx.log(`SGPaero: skipping old day ${date} for class ${classid}`);
            return {observedClasses};
        }

        // resultsOnly: scores without re-running the task install. The task
        // install is what creates the pilotresult rows, so on a fresh day
        // resultsOnly assumes a prior tasks pass already ran.
        if (!options?.resultsOnly) {
            const installed = await installAeroTask(ctx, classid, res.d);
            if (!installed) return {observedClasses};
        }

        if (!options?.tasksOnly && date) {
            await processAeroResults(ctx, classid, date, res.d, res.p ?? {}, res.t?.s ?? {});
        }

        return {observedClasses};
    }
}
