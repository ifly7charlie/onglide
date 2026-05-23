// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// SoaringSpotApiSource — `ScoringSource` adapter for the SoaringSpot
// OAuth API (HMAC-SHA256 auth, JSON+HAL responses). Replaces the legacy
// bin/soaringspot.ts daemon: the scheduler in lib/scoring/scheduler.ts
// drives the cadence, this file only owns HTTP fetch + parsing.
//
// Each scoringsource row of type='soaringspotkey' carries the API
// credentials (client_id / secret) plus optional `contest_name` and
// `actuals` fields. The compid in the row is the local DB identifier;
// the SoaringSpot API knows nothing about it — when the key has access
// to more than one contest, `contest_name` picks the right one.
//

import {createHmac, randomBytes} from 'crypto';
import escape from 'sql-template-strings';

import {makeClassId} from '../../classid';
import {toDateCode} from '../../datecode';
import {getElevationOffset} from '../../getelevationoffset';
import {findApproximateContestLocation} from '../shared/contestLocation';
import {getTzOffset, localDatecode} from '../shared/timezone';
import {upsertClass, syncClassHandicapFlag} from '../shared/classes';
import {PilotFetchAccumulator, upsertPilot, pruneUnseenPilots, type PilotRecord} from '../shared/pilots';
import {upsertTaskAndLegs} from '../shared/tasks';
import {updateTracker} from '../shared/trackers';
import {downloadPictureCached} from '../shared/images';

import type {ClassId, CompNo, FetchPilotsOptions, FetchPilotsResult, FetchResultsOptions, FetchResultsResult, ScoringSource, SkipDayPredicate, SourceCtx} from '../source';

const API_ROOT = 'https://api.soaringspot.com/v1/';
const REL_CONTESTS = 'http://api.soaringspot.com/rel/contests';
const REL_CLASSES = 'http://api.soaringspot.com/rel/classes';
const REL_CONTESTANTS = 'http://api.soaringspot.com/rel/contestants';
const REL_PILOT = 'http://api.soaringspot.com/rel/pilot';
const REL_TASKS = 'http://api.soaringspot.com/rel/tasks';
const REL_POINTS = 'http://api.soaringspot.com/rel/points';
const REL_CONTESTANT = 'http://api.soaringspot.com/rel/contestant';
const REL_RESULTS = 'http://api.soaringspot.com/rel/results';
const REL_CLASS_RESULTS = 'http://api.soaringspot.com/rel/class_results';
const REL_LOCATION = 'http://api.soaringspot.com/rel/location';
const REL_WWW = 'http://api.soaringspot.com/rel/www';

// SoaringSpot turnpoint type label → upsertTaskAndLegs oz_type. Matches
// the legacy oz_types map in bin/soaringspot.ts.
const OZ_TYPES: Record<string, string> = {
    symmetric: 'symmetric',
    next: 'next',
    previous: 'previous',
    fixed: 'fixed',
    start: 'start'
};

function toDeg(a: number): number {
    return (a / Math.PI) * 180;
}

// Convert "2026-05-23T13:45:00" → "13:45:00" (strip the date prefix so
// MySQL TIME() accepts it). Returns null when the input is missing.
function convertToMysqlTime(s: string | undefined | null): string | null {
    if (!s) return null;
    return s.replace(/^.*T/, '');
}

// SoaringSpot exposes handicaps in several shapes (decimals, percentages,
// per-mil); fold them all to BGA-style percentages. Lifted from the
// legacy `correct_handicap` helper.
function correctHandicap(h: number | string | null | undefined): number {
    const v = typeof h === 'number' ? h : parseFloat(String(h ?? ''));
    if (!v || isNaN(v)) return 100;
    if (v < 2) return v * 100;
    if (v > 140) return v / 10;
    return v;
}

//
// HMAC-SHA256 auth header per SoaringSpot's OAuth-v1 scheme. The nonce +
// timestamp are regenerated on every call so a clock skew survives — the
// server only rejects when its own clock is too far off.
//
interface ApiKeys {
    client_id: string;
    secret: string;
}

function authHeaders(keys: ApiKeys): RequestInit {
    const nonce = randomBytes(30).toString('base64');
    const dt = new Date().toISOString();
    const message = nonce + dt + keys.client_id;
    const hash = createHmac('sha256', keys.secret).update(message).digest('base64');
    return {
        headers: {
            Authorization: `http://api.soaringspot.com/v1/hmac/v1 ClientID="${keys.client_id}", Signature="${hash}", Nonce="${nonce}", Created="${dt}"`
        }
    };
}

async function apiGet(url: string, keys: ApiKeys, log: (msg: string, ...args: unknown[]) => void): Promise<any | null> {
    try {
        const res = await fetch(url, authHeaders(keys));
        if (!res.ok) {
            log(`soaringspot api ${url} returned ${res.status}: ${res.statusText}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        log(`soaringspot api ${url} threw:`, e);
        return null;
    }
}

//
// Extract credentials from the scoringsource row. Returns null if the
// row is incomplete — the scheduler then skips fetches for this comp
// rather than firing unauthed requests that 401.
//
function extractKeys(ctx: SourceCtx): ApiKeys | null {
    const client_id = String(ctx.raw?.client_id ?? '').trim();
    const secret = String(ctx.raw?.secret ?? '').trim();
    if (!client_id || !secret) return null;
    return {client_id, secret};
}

function contestNameFilter(ctx: SourceCtx): string {
    return String(ctx.raw?.contest_name ?? '').trim();
}

// Scoring mode the OAuth API ships scored values in:
//   1  = actuals (FAI/IGC) — speed/distance are real values
//   0  = handicapped         — speed/distance are pre-handicapped
//  -1  = BGA decimal-encoded — scored_distance is "<hcapd>.<actuald>"
function actualsMode(ctx: SourceCtx): -1 | 0 | 1 {
    const raw = ctx.raw?.actuals;
    if (raw == null || raw === '') return 1;
    const n = parseInt(String(raw), 10);
    return n === -1 ? -1 : n === 0 ? 0 : 1;
}

//
// Pick the right contest record from the /v1/ enumeration. The legacy
// daemon iterates every contest under one compid; per the adapter
// model, one scoringsource row = one compid = one contest, so we
// reduce to a single record here.
//
function pickContest(contests: any[], filter: string): any | null {
    if (!contests?.length) return null;
    if (filter) {
        const m = contests.find((c) => c.name === filter);
        if (m) return m;
    }
    return contests[0];
}

//
// updateCompetitionRow — write the contest header (name/dates/location/
// tz/website) into the `competition` table. Mirrors the OAuth-API half
// of update_contest() in bin/soaringspot.ts, minus the deep-reset path.
//
async function updateCompetitionRow(ctx: SourceCtx, contest: any): Promise<void> {
    const {db, log, compid} = ctx;

    // Seed the row if it doesn't exist. The placeholder dates put `end`
    // in the past so dropDeadCompetition can reap a misconfigured
    // credential row whose enumeration never returns the right contest.
    const count = await db.query(escape`SELECT COUNT(*) cnt FROM competition WHERE compid = ${compid}`);
    if (!count?.[0]?.cnt) {
        log(`empty competition for compid=${compid}, pre-populating`);
        await db.query(escape`
            INSERT IGNORE INTO competition (compid, tz, tzoffset, start, end)
            VALUES (
                ${compid},
                'Europe/Stockholm',
                7200,
                DATE_SUB(CURDATE(), INTERVAL 30 DAY),
                DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            )
        `);
    }

    await db.query(escape`
        UPDATE competition
        SET
            start = ${contest.start_date},
            end = ${contest.end_date},
            countrycode = ${contest.country ?? null},
            name = ${String(contest.name ?? '').substring(0, 59)}
        WHERE compid = ${compid}
    `);

    const loc = contest._embedded?.[REL_LOCATION];
    if (loc?.latitude && loc?.longitude) {
        const lat = toDeg(loc.latitude);
        const lng = toDeg(loc.longitude);
        await db.query(escape`
            UPDATE competition
            SET lt = ${lat}, lg = ${lng}, sitename = ${loc.name ?? null}
            WHERE compid = ${compid}
        `);
        getElevationOffset(lat, lng, (agl: number) => log(`SITE Altitude: ${agl}`));
    } else if (loc?.name) {
        // API ships a sitename but no coordinates — geocode the name,
        // matching the scrape adapter's fallback. Only run when we
        // don't already have lt/lg, to stay polite to Nominatim/Overpass.
        const existing = (await db.query(escape`SELECT lt, lg FROM competition WHERE compid = ${compid}`))?.[0];
        if (!existing?.lt || !existing?.lg) {
            log(`location "${loc.name}" has no coordinates from soaringspot — geocoding`);
            const acl = await findApproximateContestLocation(log, loc.name);
            if (acl.lt && acl.lg) {
                await db.query(escape`
                    UPDATE competition
                    SET lt = ${acl.lt}, lg = ${acl.lg}, sitename = ${String(loc.name).substring(0, 40)}
                    WHERE compid = ${compid}
                `);
                getElevationOffset(acl.lt, acl.lg, (agl: number) => log(`SITE Altitude: ${agl}`));
            } else {
                log(`geocode of "${loc.name}" returned no result — leaving competition.lt/lg unset`);
            }
        }
    }

    // Timezone: API ships an IANA name; refine the offset from the
    // resolved tz so we don't rely on MySQL's CONVERT_TZ (which needs the
    // tz tables installed). The scrape adapter goes further and
    // re-derives tz from coordinates after geocoding, so do the same
    // here for consistency.
    const tz = contest.time_zone || (await db.query(escape`SELECT tz FROM competition WHERE compid = ${compid}`))?.[0]?.tz;
    if (tz) {
        try {
            await db.query(escape`
                UPDATE competition
                SET tz = ${tz}, tzoffset = ${getTzOffset(tz)}
                WHERE compid = ${compid}
            `);
        } catch (e) {
            log('tz update failed:', e);
        }
    }

    const wwwUrl = String(contest._links?.[REL_WWW]?.href ?? '').match(/(http[^']*)/)?.[0];
    if (wwwUrl) {
        await db.query(escape`UPDATE competition SET mainwebsite = ${wwwUrl} WHERE compid = ${compid}`);
    }
}

//
// updatePilotsFromApi — pull /contestants, upsert each pilot, then
// updateTracker() for each pilot whose `live_track_id` we can parse a
// FLARM id out of. updateTracker only writes trackerhistory when the
// trackerid actually changed (gated on UPDATE … affectedRows), so
// repeated polls don't churn history rows.
//
async function updatePilotsFromApi(
    ctx: SourceCtx, //
    classUrl: string,
    classid: ClassId,
    className: string,
    accumulator: PilotFetchAccumulator,
    synthetic: {n: number},
    keys: ApiKeys
): Promise<void> {
    const results = await apiGet(classUrl + '/contestants', keys, ctx.log);
    if (!results) {
        ctx.log(`${classid}: unable to fetch contestants`);
        return;
    }

    const contestants: any[] = results._embedded?.[REL_CONTESTANTS] ?? [];
    for (const pilot of contestants) {
        const number = String(pilot?.contestant_number ?? '');
        if (!number || /(TBA|TBD)/i.test(number)) continue;

        const compno = number.substring(0, 4) as CompNo;
        const epilot = pilot._embedded?.[REL_PILOT]?.[0] ?? {};

        const record: PilotRecord = {
            classid,
            className,
            compno,
            fullName: String(pilot.name ?? '').substring(0, 30),
            club: pilot.club ? String(pilot.club).substring(0, 80) : null,
            country: epilot.nationality ? String(epilot.nationality).substring(0, 2) : null,
            glider: pilot.aircraft_model ? String(pilot.aircraft_model).substring(0, 30) : null,
            greg: pilot.aircraft_registration ? String(pilot.aircraft_registration).substring(0, 8) : null,
            handicap: correctHandicap(pilot.handicap)
        };

        await upsertPilot(ctx.db, ctx.log, record, accumulator, synthetic);

        // FLARM ids from live_track_id — comma-/colon-separated, last 6
        // hex of each entry. Skip when empty so the placeholder
        // (trackerid='unknown') from pruneUnseenPilots stays in place
        // and another feed (robocontrol) can claim the row.
        const liveIds: string = String(pilot.live_track_id ?? '').trim();
        if (liveIds) {
            const flarms = liveIds
                .split(/[,:]/)
                .map((s) => s.match(/([a-f0-9]{6})$/i)?.[1])
                .filter((s): s is string => !!s);
            if (flarms.length) {
                // Ensure the tracker placeholder row exists before the
                // update — pruneUnseenPilots normally seeds it after the
                // pilot loop, but updateTracker is an UPDATE-only
                // operation and would no-op for a brand-new pilot.
                try {
                    await ctx.db.query(escape`
                        INSERT IGNORE INTO tracker (class, compno, type, trackerid)
                        VALUES (${classid}, ${compno}, 'flarm', 'unknown')
                    `);
                } catch (e) {
                    ctx.log(`tracker placeholder failed for ${classid}/${compno}:`, e);
                }
                await updateTracker(ctx.db, ctx.log, classid, compno, flarms.join(','), 'soaringspot');
            }
        }

        // Pilot picture refresh — routed through the shared image cache
        // (24h debounce + queue), same path used by the scrape and SGP
        // adapters. Currently disabled at the helper level; safe no-op.
        if (epilot.igc_id) {
            downloadPictureCached(ctx.db, ctx.log, classid, compno, {
                igc_id: Number(epilot.igc_id),
                compno,
                class: classid,
                greg: record.greg ?? undefined
            }).catch((e) => ctx.log(`portrait enqueue failed for ${classid}/${compno}:`, e));
        }
    }
}

//
// reshapeTaskForUpsert — turn the OAuth API's task/turnpoints payload
// into the `day` shape upsertTaskAndLegs accepts. The helper already
// owns the transaction, hash check, leg insertion and contestday
// upsert; we just translate field names.
//
function reshapeTaskForUpsert(taskDetails: any, dayMeta: any, turnpoints: any[]): any {
    const task_points = (turnpoints ?? []).map((tp: any) => ({
        point_index: tp.point_index,
        multiple_start: tp.multiple_start ?? 0,
        name: String(tp.name ?? ''),
        latitude: tp.latitude,
        longitude: tp.longitude,
        oz_line: !!tp.oz_line,
        oz_type: OZ_TYPES[tp.oz_type] ?? 'symmetric',
        oz_radius1: tp.oz_radius1 ?? 0,
        oz_angle1: tp.oz_angle1 ?? 0,
        oz_radius2: tp.oz_radius2 ?? 0,
        oz_angle2: tp.oz_angle2 ?? 0,
        oz_angle12: tp.oz_angle12 ?? 0
    }));

    return {
        task_date: dayMeta.task_date,
        task_type: taskDetails.task_type,
        task_duration: taskDetails.task_duration ?? 0,
        task_distance: dayMeta.task_distance ?? 0,
        task_number: dayMeta.task_number ?? 1,
        no_start: taskDetails.no_start ?? null,
        result_status: dayMeta.result_status ?? '',
        notes: String(taskDetails.notes ?? ''),
        task_points
    };
}

//
// processDayResults — write the daily scores into pilotresult. Mirrors
// process_day_scores() in bin/soaringspot.ts; kept inside this adapter
// because the column names (scored_speed/scored_distance/etc) are
// API-specific.
//
async function processDayResults(
    ctx: SourceCtx, //
    classid: ClassId,
    className: string,
    day: any,
    actuals: -1 | 0 | 1
): Promise<number> {
    const {db, log} = ctx;
    const date = day.task_date;
    const dateCode = toDateCode(date);
    let rows = 0;

    const results: any[] = day._embedded?.[REL_RESULTS] ?? [];
    for (const row of results) {
        const contestant = row._embedded?.[REL_CONTESTANT] ?? {};
        const number = String(contestant.contestant_number ?? '');
        if (!number || /(TBA|TBD)/i.test(number)) continue;
        const pilot = number.substring(0, 4);
        const handicap = correctHandicap(contestant.handicap);

        const start = row.scored_start ? new Date(row.scored_start).getTime() / 1000 : 0;
        const finish = row.scored_finish ? new Date(row.scored_finish).getTime() / 1000 : 0;
        const duration = finish && start ? (finish - start) / 3600 : 0;

        let as = 0;
        let ad = 0;
        let hs = 0;
        let hd = 0;
        if (actuals === -1) {
            // BGA special case: scored_distance is "hcapd.actuald" packed
            // into one decimal. Split on '.', right-pad actuald to 7
            // digits so partial values keep their magnitude.
            const [hcapds, actualdsRaw] = String(row.scored_distance ?? '').split('.');
            const hcapd = hcapds ? parseInt(hcapds, 10) || 0 : 0;
            let actualds = actualdsRaw ?? '';
            while (actualds.length < 7) actualds += '0';
            const actuald = actualds ? parseInt(actualds, 10) || 0 : 0;
            if (duration && row.scored_distance) {
                as = actuald / 1000 / duration / 3.6;
                ad = actuald;
                hs = Number(row.scored_speed ?? 0);
                hd = hcapd;
            } else {
                as = hs = 0;
                ad = actuald;
                hd = hcapd;
            }
        } else if (actuals === 1) {
            as = Number(row.scored_speed ?? 0);
            ad = Number(row.scored_distance ?? 0);
            hs = duration ? ad / (handicap / 100) / duration / 3600 : 0;
            hd = ad / (handicap / 100);
        } else {
            // actuals = 0 — speed/distance are pre-handicapped.
            ad = Number(row.scored_distance ?? 0) * (handicap / 100);
            as = duration ? ad / duration / 3600 : 0;
            hs = Number(row.scored_speed ?? 0);
            hd = Number(row.scored_distance ?? 0);
        }

        const finished = Number(row.scored_speed ?? 0) > 0;
        const scoredStatus = finished ? 'F' : Number(row.scored_distance ?? 0) > 0 ? 'H' : 'S';

        if (row.status_evaluated) {
            const r = await db.query(escape`
                UPDATE pilotresult
                SET
                    start = TIME(COALESCE(${convertToMysqlTime(row.scored_start)}, start)),
                    finish = TIME(COALESCE(${convertToMysqlTime(row.scored_finish)}, finish)),
                    duration = COALESCE(
                        TIMEDIFF(${convertToMysqlTime(row.scored_finish)}, ${convertToMysqlTime(row.scored_start)}),
                        duration
                    ),
                    statuschanged = (CASE WHEN (scoredstatus = ${scoredStatus}) THEN statuschanged ELSE NOW() END),
                    datafromscoring = 'Y',
                    igcavailable = 'N',
                    scoredstatus = ${scoredStatus},
                    status = (
                        CASE
                            WHEN ((status = '-' OR status = 'S' OR status = 'G') AND ${row.scored_finish ?? ''} != '')
                                THEN 'F'
                            WHEN ((status = '-' OR status = 'S' OR status = 'G') AND ${row.igc_file ?? ''} != '')
                                THEN 'H'
                            ELSE status
                        END
                    ),
                    speed = ${as * 3.6},
                    distance = ${ad / 1000},
                    hspeed = ${hs * 3.6},
                    hdistance = ${hd / 1000},
                    daypoints = ${row.points ?? 0},
                    dayrank = ${row.rank ?? 0},
                    totalpoints = ${row.points_total ?? 0},
                    totalrank = ${row.rank_total ?? 0},
                    penalty = ${row.penalty ?? 0}
                WHERE
                    datecode = ${dateCode}
                    AND compno = ${pilot}
                    AND class = ${classid}
            `);
            rows += r?.affectedRows ?? 0;
        } else if (row.scored_start) {
            // Manually entered start time, no full evaluation yet —
            // capture it so the front-end can show the start before
            // any results are scored.
            await db.query(escape`
                UPDATE pilotresult
                SET start = TIME(COALESCE(${convertToMysqlTime(row.scored_start)}, start))
                WHERE datecode = ${dateCode} AND compno = ${pilot} AND class = ${classid}
            `);
        }

        if (row.points_total || row.rank_total) {
            await db.query(escape`
                UPDATE pilotresult
                SET totalpoints = ${row.points_total ?? 0}, totalrank = ${row.rank_total ?? 0}
                WHERE datecode = ${dateCode} AND compno = ${pilot} AND class = ${classid}
            `);
        }
    }

    if (rows) {
        await db.query(escape`
            UPDATE contestday
            SET results_uploaded = NOW()
            WHERE class = ${classid} AND datecode = ${dateCode} AND status != 'Z'
        `);
    }

    log(`${className}: processed ${rows} score row(s) for ${date}`);
    return rows;
}

//
// SoaringSpotApiSource — implements ScoringSource. The scheduler:
//   - ensures the competition row exists via ensureMetadata,
//   - calls fetchPilots on the rule-2/-4 cadence,
//   - calls fetchResultsAndTasks on the rule-3 cadence with a skipDay
//     predicate that rejects stale datecodes.
//
export class SoaringSpotApiSource implements ScoringSource {
    readonly type = 'soaringspotkey';
    readonly trackerIntervalMs = 15 * 60 * 1000;

    //
    // Pull the contests enumeration once and pick the right contest;
    // every method below reuses this so a single heartbeat issues at
    // most one root-list fetch.
    //
    private async loadContest(ctx: SourceCtx, keys: ApiKeys): Promise<any | null> {
        const root = await apiGet(API_ROOT, keys, ctx.log);
        if (!root) return null;
        const contests: any[] = root._embedded?.[REL_CONTESTS] ?? [];
        const contest = pickContest(contests, contestNameFilter(ctx));
        if (!contest) {
            ctx.log(`no contest found for compid=${ctx.compid} (filter="${contestNameFilter(ctx)}", saw ${contests.length})`);
        }
        return contest;
    }

    async ensureMetadata(ctx: SourceCtx): Promise<void> {
        const keys = extractKeys(ctx);
        if (!keys) {
            ctx.log(`soaringspotkey row for ${ctx.compid} is missing client_id/secret — skipping`);
            return;
        }
        const contest = await this.loadContest(ctx, keys);
        if (!contest) return;
        await updateCompetitionRow(ctx, contest);
    }

    async fetchPilots(ctx: SourceCtx, options?: FetchPilotsOptions): Promise<FetchPilotsResult> {
        const accumulator = new PilotFetchAccumulator();
        const synthetic = {n: 0};
        const keys = extractKeys(ctx);
        if (!keys) return {observed: accumulator.observed};

        const contest = await this.loadContest(ctx, keys);
        if (!contest) return {observed: accumulator.observed};

        // Refresh competition metadata while we're holding the contest.
        await updateCompetitionRow(ctx, contest);

        const todayDatecode = localDatecode(ctx.tz);
        const cclasses: any[] = contest._embedded?.[REL_CLASSES] ?? [];

        for (const cclass of cclasses) {
            const rawName: string = cclass.name || cclass.type;
            if (!rawName) continue;
            // OAuth-API hash uses the raw upstream name (the API key is
            // stable, and existing rows in `classes` were hashed this
            // way by the legacy daemon — see lib/classid.ts header).
            const classid = makeClassId(ctx.compid, rawName) as ClassId;
            const displayName = rawName.replace(/[_]/gi, ' ');

            await upsertClass(ctx.db, ctx.log, ctx.compid, classid, displayName, todayDatecode);

            const classUrl = cclass._links?.self?.href;
            if (!classUrl) {
                ctx.log(`${classid}: no self link on class object — skipping pilots`);
                continue;
            }

            await updatePilotsFromApi(ctx, classUrl, classid, displayName, accumulator, synthetic, keys);
        }

        // skipPrune is set by the trackers-cadence path: a flap on the
        // OAuth side at 15-minute cadence must not delete pilots. The
        // per-pilot upsert + updateTracker writes already ran above.
        if (!options?.skipPrune) {
            await pruneUnseenPilots(ctx.db, ctx.log, accumulator);
            for (const classid of accumulator.observed.keys()) {
                await syncClassHandicapFlag(ctx.db, ctx.log, classid);
            }
        }

        return {observed: accumulator.observed};
    }

    // Trackers come embedded in the contestants payload (`live_track_id`),
    // so the trackers cadence re-uses fetchPilots with skipPrune. Pilots
    // get refreshed as a side effect, which is acceptable.
    async fetchTrackers(ctx: SourceCtx): Promise<void> {
        await this.fetchPilots(ctx, {skipPrune: true});
    }

    async fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate, options?: FetchResultsOptions): Promise<FetchResultsResult> {
        const observedClasses = new Set<ClassId>();
        const keys = extractKeys(ctx);
        if (!keys) return {observedClasses};

        const tasksOnly = options?.tasksOnly === true;
        const resultsOnly = options?.resultsOnly === true;
        const forceResults = options?.forceResults === true;
        const acceptYesterday = options?.acceptYesterday === true;
        const todayDatecode = localDatecode(ctx.tz);
        const yesterdayDatecode = acceptYesterday ? localDatecode(ctx.tz, Date.now() - 24 * 60 * 60 * 1000) : null;

        const contest = await this.loadContest(ctx, keys);
        if (!contest) return {observedClasses};

        const actuals = actualsMode(ctx);
        const cclasses: any[] = contest._embedded?.[REL_CLASSES] ?? [];

        for (const cclass of cclasses) {
            const rawName: string = cclass.name || cclass.type;
            if (!rawName) continue;
            // OAuth-API hash uses the raw upstream name (the API key is
            // stable, and existing rows in `classes` were hashed this
            // way by the legacy daemon — see lib/classid.ts header).
            const classid = makeClassId(ctx.compid, rawName) as ClassId;
            const displayName = rawName.replace(/[_]/gi, ' ');
            observedClasses.add(classid);

            await upsertClass(ctx.db, ctx.log, ctx.compid, classid, displayName, todayDatecode);

            const classUrl = cclass._links?.self?.href;
            if (!classUrl) continue;

            // ----- Tasks: latest day only -----
            // resultsOnly skips this whole block — the results-cadence
            // call path has no reason to spend 3 round-trips re-fetching
            // the task it already imported on the tasks-cadence call.
            if (!resultsOnly) {
            const tasksDoc = await apiGet(classUrl + '/tasks', keys, ctx.log);
            const tasksList: any[] = tasksDoc?._embedded?.[REL_TASKS] ?? [];
            const latestTask = [...tasksList].sort((a, b) => String(a.task_date).localeCompare(String(b.task_date))).at(-1);
            if (latestTask?._links?.self?.href) {
                const dateISO = latestTask.task_date;
                const dateCode = toDateCode(dateISO);
                if (skipDay(classid, dateCode, dateISO)) {
                    ctx.log(`${classid}: skipping old day ${dateISO}`);
                } else {
                    const isToday = dateCode === todayDatecode;
                    const isYesterdayWindow = yesterdayDatecode != null && dateCode === yesterdayDatecode;
                    if (forceResults || isToday || isYesterdayWindow) {
                        const taskDetails = await apiGet(latestTask._links.self.href, keys, ctx.log);
                        if (taskDetails?._links?.[REL_POINTS]) {
                            const pts = await apiGet(taskDetails._links[REL_POINTS].href, keys, ctx.log);
                            const turnpoints = pts?._embedded?.[REL_POINTS] ?? [];
                            if (turnpoints.length >= 2) {
                                const day = reshapeTaskForUpsert(taskDetails, latestTask, turnpoints);
                                try {
                                    await upsertTaskAndLegs(ctx.db, ctx.log, classid, displayName, day);
                                } catch (e) {
                                    ctx.log(`task install failed for ${classid} ${dateISO}:`, e);
                                }
                            } else {
                                ctx.log(`${classid} ${dateISO}: <2 turnpoints, skipping task install`);
                            }
                        }
                    } else {
                        ctx.log(`${classid}: ${dateISO}/${dateCode} not today/yesterday (today=${todayDatecode}${yesterdayDatecode ? `, yesterday=${yesterdayDatecode}` : ''}), skipping`);
                    }
                }
            } else {
                ctx.log(`${classid}: no tasks published yet`);
            }
            }

            if (tasksOnly) continue;

            // ----- Results: latest day only -----
            const resultsDoc = await apiGet(classUrl + '/results', keys, ctx.log);
            const resultsList: any[] = resultsDoc?._embedded?.[REL_CLASS_RESULTS] ?? [];
            const latestResult = [...resultsList].sort((a, b) => String(a.task_date).localeCompare(String(b.task_date))).at(-1);
            if (latestResult) {
                const dateISO = latestResult.task_date;
                const dateCode = toDateCode(dateISO);
                if (skipDay(classid, dateCode, dateISO)) {
                    ctx.log(`${classid}: skipping old results day ${dateISO}`);
                } else {
                    const isToday = dateCode === todayDatecode;
                    const isYesterdayWindow = yesterdayDatecode != null && dateCode === yesterdayDatecode;
                    if (forceResults || isToday || isYesterdayWindow) {
                        try {
                            await processDayResults(ctx, classid, displayName, latestResult, actuals);
                        } catch (e) {
                            ctx.log(`results processing failed for ${classid} ${dateISO}:`, e);
                        }
                    }
                }
            }
        }

        return {observedClasses};
    }
}
