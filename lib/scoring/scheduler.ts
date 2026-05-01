// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Competition-aware scoring scheduler.
//
// The old scraper hammered every configured competition every 5 minutes,
// re-fetching pilots and walking every historical day on /results
// regardless of where the competition was in its day. This scheduler is
// the inverse: a 60-second heartbeat that consults per-competition state
// and only fires the fetches that are actually due, all in the
// competition's local timezone (rules 2/3/4) with jitter so adjacent
// competitions never lock-step (rule 7).
//
// State is in-memory, per-process. On restart, decisions reset to "fetch
// soon" so any time-sensitive recovery happens within a heartbeat or two.
// The DB itself remains the source of truth for compstatus and
// compstatus.starttime.
//

import escape from 'sql-template-strings';

import type {ClassId, ScoringSource, SkipDayPredicate, SourceCtx} from './source';
import {SourceRegistry} from './source';
import {applyJitter, localDateISO, localDatecode, nowInTz, type LocalTime} from './shared/timezone';
import {diffAndRemoveClasses, resetStaleCompStatus} from './shared/classes';
import {pruneOldDays, dropDeadCompetition} from './shared/tasks';

// ---------- intervals (rules 2/3/4) ----------

const HEARTBEAT_MS = 60 * 1000;

const INTERVAL_RESULTS_FAST_MS = 10 * 60 * 1000; // pre-task / briefed / first hour after launch
const INTERVAL_RESULTS_SLOW_MS = 30 * 60 * 1000; // after launch+1h until end-of-day
const INTERVAL_PILOTS_HOURLY_MS = 60 * 60 * 1000; // task day, before launch
const INTERVAL_PILOTS_URGENT_MS = 30 * 60 * 1000; // active comp, DB still empty

const STOP_RESULTS_LOCAL_MINUTE = 20 * 60; // 20:00 local — stop results checks
const PILOTS_PRETASK_LOCAL_MINUTE = 10 * 60; // 10:00 local — daily pilots fetch fires after this
const LAUNCH_GRID_LEAD_MINUTES = 30; // fallback "launch starts" anchor: starttime - 30m

// Daily SoaringSpot-style index discovery runs at or after this UTC
// hour, plus once on startup regardless of wall-clock time.
const DISCOVERY_UTC_HOUR = 5;

// "After launch" cadence drops from fast→slow at +1h.
const LAUNCH_FAST_TAIL_MS = 60 * 60 * 1000;

// ---------- per-class status helpers ----------

// compstatus.status values that mean "we have a task for this date".
const TASK_STATES = new Set<string>(['B', 'L', 'S', 'R', 'H', 'Z']);
// compstatus.status values that mean "launching has begun".
const LAUNCHED_STATES = new Set<string>(['L', 'S', 'R', 'H']);

// ---------- in-memory state ----------

interface ClassObservation {
    classid: ClassId;
    status: string; // single-char compstatus.status
    datecode: string | null;
    starttimeMinutes: number | null; // minute-of-day (local), parsed from compstatus.starttime
    isToday: boolean; // does compstatus.datecode match today's local datecode?
}

interface CompState {
    compid: string;
    url: string;
    type: string;
    raw: Record<string, any>;
    tz: string;
    metadataLoaded: boolean;

    // last successful fetches (epoch ms)
    lastPilotsFetch: number;
    lastResultsFetch: number;
    // local-day bookkeeping
    lastPilotsLocalDate: string | null;

    // Competition date window (YYYY-MM-DD strings in the comp's local tz,
    // inclusive). Refreshed from the `competition` row every heartbeat
    // so late-arriving start/end corrections are picked up.
    competitionStart: string | null;
    competitionEnd: string | null;
    // Number of pilot rows currently in DB for this compid, refreshed
    // each heartbeat. Used to decide when an "empty active comp" warrants
    // an urgent pilots fetch instead of waiting for the 10am gate.
    pilotsInDb: number | null;
    // Classes the pilots page reported on the last successful fetchPilots
    // in this process. Authoritative for "which classes are registered"
    // and used to veto the results-page class-diff so a staggered task
    // publish doesn't cascade-delete classes that just haven't flown yet.
    // `null` until the first pilots fetch succeeds.
    lastPilotObservedClasses: Set<ClassId> | null;

    // per-class first-seen 'L' for today (epoch ms). Cleared when the
    // local date rolls over.
    firstLaunch: Map<ClassId, number>;
    // The local date the firstLaunch map is keyed against — when this
    // changes we wipe the map.
    firstLaunchDate: string | null;

    // Computed next-due (epoch ms). Defaults to 0 so the first heartbeat
    // fires both fetches.
    nextPilotsAt: number;
    nextResultsAt: number;

    // observations from the most recent compstatus snapshot
    observations: ClassObservation[];

    // book-keeping for the once-per-day rule-1 prune
    lastPruneDay: string | null;
    // book-keeping for the dead-competition check (don't run it every
    // heartbeat — once per hour is plenty)
    nextDeadCheckAt: number;
}

// ---------- decisions ----------

interface SchedulerDecisions {
    fetchPilots: boolean;
    fetchResults: boolean;
    pruneOldDays: boolean;
    dropDeadComp: boolean;
    // rationale (for logging)
    reasons: string[];
}

//
// computeDecisions — pure function over `state` + `localNow`. Encapsulates
// rules 2/3/4. No DB calls, no IO — designed to be unit-testable.
//
// Inputs:
//   - state: the per-competition CompState (read-only)
//   - localNow: precomputed local time in the competition's tz
//   - nowMs: Date.now() (passed in for testability)
//
export function computeDecisions(state: CompState, localNow: LocalTime, nowMs: number): SchedulerDecisions {
    const reasons: string[] = [];

    // ----- pilots -----

    // Bucket the classes by where they are in the day:
    //   - anyTaskToday: any class whose compstatus shows we have a task for today
    //   - anyLaunchedToday: any class whose status is in LAUNCHED_STATES today
    let anyTaskToday = false;
    let anyLaunchedToday = false;
    for (const obs of state.observations) {
        if (!obs.isToday) continue;
        if (TASK_STATES.has(obs.status)) anyTaskToday = true;
        if (LAUNCHED_STATES.has(obs.status)) anyLaunchedToday = true;
    }

    let fetchPilots = false;

    // Rule 2-urgent: if the comp is inside its date window (inclusive)
    // AND we either haven't fetched pilots in this process or the DB is
    // still empty for this comp, bypass the 10am gate and the
    // nextPilotsAt cooldown. Handles newly-added or restart-after-crash
    // comps whose scraper would otherwise sleep until 10:00 local while
    // the comp is already flying.
    const isActiveToday = //
        state.competitionStart != null && //
        state.competitionEnd != null && //
        state.competitionStart <= localNow.iso && //
        localNow.iso <= state.competitionEnd;
    const isEmpty = state.lastPilotsFetch === 0 || (state.pilotsInDb ?? 0) === 0;
    const urgentPilotsFetch = isActiveToday && isEmpty;

    // Rule 2: pre-task daily fetch — only if no class has a task today,
    // we're past 10:00 local (or urgent), and we haven't already fetched
    // today. Urgent overrides the 10am gate; nextPilotsAt still gates
    // frequency — scheduleNextPilots picks a 30-minute retry interval
    // while urgent conditions persist, so a flaky scrape doesn't hammer
    // upstream every 60s.
    if (
        !anyTaskToday && //
        (urgentPilotsFetch || localNow.minuteOfDay >= PILOTS_PRETASK_LOCAL_MINUTE) && //
        state.lastPilotsLocalDate !== localNow.iso && //
        nowMs >= state.nextPilotsAt
    ) {
        fetchPilots = true;
        reasons.push(urgentPilotsFetch ? 'pilots:urgent-empty-active' : 'pilots:daily-10am');
    }

    // Rule 4: hourly pilots fetch on a task day until first launch.
    // After first launch, stop until next day (lastPilotsLocalDate gates
    // re-firing tomorrow).
    if (!fetchPilots && anyTaskToday && !anyLaunchedToday && nowMs >= state.nextPilotsAt) {
        fetchPilots = true;
        reasons.push('pilots:task-hourly');
    }

    // ----- results -----

    let fetchResults = false;
    if (localNow.minuteOfDay < STOP_RESULTS_LOCAL_MINUTE) {
        if (nowMs >= state.nextResultsAt) {
            fetchResults = true;
            reasons.push('results:due');
        }
    } else {
        reasons.push('results:after-20:00-stop');
    }

    // ----- maintenance -----

    // Rule 1 prune runs at most once per local day, after 10:00, on the
    // first heartbeat that satisfies that window.
    const pruneEligible = localNow.minuteOfDay >= PILOTS_PRETASK_LOCAL_MINUTE && state.lastPruneDay !== localNow.iso;
    if (pruneEligible) {
        reasons.push('prune:daily');
    }

    // Dead-competition check: cheap-ish (a few SELECTs) but not free —
    // run hourly per competition.
    const deadCheck = nowMs >= state.nextDeadCheckAt;
    if (deadCheck) reasons.push('dead-comp:check');

    return {
        fetchPilots,
        fetchResults,
        pruneOldDays: pruneEligible,
        dropDeadComp: deadCheck,
        reasons
    };
}

// ----- schedule next-due times -----

// scheduleNextResults — figure out the right cadence for the next results
// fetch. Chooses the *fastest* (lowest interval) cadence across all
// observed classes today, then jitters it. Stops entirely (returns
// Infinity) once we're past 20:00 local.
function scheduleNextResults(state: CompState, localNow: LocalTime, nowMs: number): number {
    if (localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE) {
        // Wake again at 04:00 local tomorrow — early enough to catch
        // anything that gets briefed overnight.
        return scheduleAtLocalMinuteTomorrow(state.tz, localNow, 4 * 60);
    }

    let fastest = INTERVAL_RESULTS_SLOW_MS;
    let anyClassToday = false;
    for (const obs of state.observations) {
        if (!obs.isToday) continue;
        anyClassToday = true;
        const interval = perClassResultsInterval(state, obs, localNow, nowMs);
        if (interval < fastest) fastest = interval;
    }
    if (!anyClassToday) {
        // Nothing today yet — keep the fast cadence so we notice
        // briefing as soon as it appears.
        fastest = INTERVAL_RESULTS_FAST_MS;
    }
    return nowMs + applyJitter(fastest);
}

// perClassResultsInterval — rule-3 cadence for a single class. Returns
// the *minimum gap* until the next fetch, NOT an absolute deadline. The
// caller folds it across all classes via min().
function perClassResultsInterval(state: CompState, obs: ClassObservation, localNow: LocalTime, nowMs: number): number {
    if (!TASK_STATES.has(obs.status)) {
        // No task yet — fast cadence so we catch one when it appears.
        return INTERVAL_RESULTS_FAST_MS;
    }

    if (!LAUNCHED_STATES.has(obs.status)) {
        // Briefed but not launched — fast cadence.
        return INTERVAL_RESULTS_FAST_MS;
    }

    // Launched. Look up the launch anchor: prefer the in-memory
    // first-observed-L epoch, fall back to (starttime - 30 min) if no
    // OGN coverage ever set status=L.
    const anchor = launchAnchorMs(state, obs, localNow);
    if (anchor != null) {
        const tail = anchor + LAUNCH_FAST_TAIL_MS;
        if (nowMs < tail) return INTERVAL_RESULTS_FAST_MS;
        return INTERVAL_RESULTS_SLOW_MS;
    }
    // Status is L but we don't know when — assume +1h has passed and
    // back off. This is the conservative branch.
    return INTERVAL_RESULTS_SLOW_MS;
}

// launchAnchorMs — when did launching start for this class today, in
// epoch ms? Either the in-memory first-L observation, or the fallback
// "starttime - 30 min" if we never saw L.
function launchAnchorMs(state: CompState, obs: ClassObservation, localNow: LocalTime): number | null {
    const seen = state.firstLaunch.get(obs.classid);
    if (seen) return seen;
    if (obs.starttimeMinutes != null) {
        const fallbackMin = obs.starttimeMinutes - LAUNCH_GRID_LEAD_MINUTES;
        return localMinuteToEpochMs(state.tz, localNow, fallbackMin);
    }
    return null;
}

// scheduleNextPilots — when should the next pilots fetch fire?
function scheduleNextPilots(state: CompState, localNow: LocalTime, nowMs: number, anyTaskToday: boolean, anyLaunchedToday: boolean): number {
    if (anyLaunchedToday) {
        // Done for today — wake at 04:00 local tomorrow so the next
        // local-day kicks off on schedule.
        return scheduleAtLocalMinuteTomorrow(state.tz, localNow, 4 * 60);
    }
    if (anyTaskToday) {
        // Hourly until launch.
        return nowMs + applyJitter(INTERVAL_PILOTS_HOURLY_MS);
    }
    // If the comp is inside its date window and the DB is still empty,
    // retry every ~30 minutes rather than sleeping until the 10am gate.
    // The urgent condition in computeDecisions re-validates before each
    // fire, so once pilots land (or the comp falls out of its window)
    // the normal 10am cadence takes over.
    const isActiveToday = //
        state.competitionStart != null && //
        state.competitionEnd != null && //
        state.competitionStart <= localNow.iso && //
        localNow.iso <= state.competitionEnd;
    const isEmpty = state.lastPilotsFetch === 0 || (state.pilotsInDb ?? 0) === 0;
    if (isActiveToday && isEmpty) {
        return nowMs + applyJitter(INTERVAL_PILOTS_URGENT_MS);
    }
    // Pre-task. If we're already past 10:00 today, the next chance is
    // 10:00 tomorrow. Otherwise wake at 10:00 today.
    if (localNow.minuteOfDay < PILOTS_PRETASK_LOCAL_MINUTE) {
        return localMinuteToEpochMs(state.tz, localNow, PILOTS_PRETASK_LOCAL_MINUTE);
    }
    return scheduleAtLocalMinuteTomorrow(state.tz, localNow, PILOTS_PRETASK_LOCAL_MINUTE);
}

// scheduleAtLocalMinuteTomorrow — "wake at HH:MM local tomorrow" with
// jitter. Coarse-grained: assumes the day after `localNow` is exactly
// 24h away, which is fine for ±1h DST drift since the heartbeat will
// re-evaluate once the wakeup fires.
function scheduleAtLocalMinuteTomorrow(_tz: string, localNow: LocalTime, targetMinute: number): number {
    const minutesIntoDay = localNow.minuteOfDay;
    const minutesUntilTomorrow = 24 * 60 - minutesIntoDay + targetMinute;
    return localNow.epoch + applyJitter(minutesUntilTomorrow * 60 * 1000);
}

// localMinuteToEpochMs — convert "minute X today, in this tz" to an
// epoch-ms wakeup, applying jitter. If the target is in the past
// relative to localNow, wraps to tomorrow.
function localMinuteToEpochMs(_tz: string, localNow: LocalTime, targetMinute: number): number {
    let delta = targetMinute - localNow.minuteOfDay;
    if (delta <= 0) delta += 24 * 60;
    return localNow.epoch + applyJitter(delta * 60 * 1000);
}

// ----- compstatus refresh + first-launch tracking -----

// Read compstatus rows for `compid` and populate state.observations.
// Also detect L transitions so state.firstLaunch is updated.
async function refreshObservations(state: CompState, ctx: SourceCtx, localNow: LocalTime): Promise<void> {
    let rows: any[] = [];
    try {
        rows = (await ctx.db.query(escape`
            SELECT
                cs.class,
                cs.status,
                cs.datecode,
                TIME_TO_SEC(cs.starttime) AS starttimeSecs
            FROM compstatus cs
            JOIN classes cl ON cl.class = cs.class
            WHERE cl.compid = ${ctx.compid}
        `)) as any[];
    } catch (e) {
        ctx.log(`refreshObservations: query failed for ${ctx.compid}:`, e);
        return;
    }

    // Pull the comp's date window + pilot count in one trip so the
    // urgent-fetch rule can see an up-to-date picture every heartbeat.
    // Cheap: a single row scan on competition + an indexed COUNT over
    // pilots for this compid. Failures degrade silently — the urgent
    // rule falls back to the normal 10am/hourly cadence.
    try {
        const meta = (await ctx.db.query(escape`
            SELECT
                DATE_FORMAT(c.start, '%Y-%m-%d') AS compStart,
                DATE_FORMAT(c.end, '%Y-%m-%d') AS compEnd,
                (
                    SELECT COUNT(*) FROM pilots p
                    JOIN classes cl ON cl.class = p.class
                    WHERE cl.compid = ${ctx.compid}
                ) AS pilotCount
            FROM competition c
            WHERE c.compid = ${ctx.compid}
        `)) as any[];
        const row = meta?.[0];
        state.competitionStart = row?.compStart ?? null;
        state.competitionEnd = row?.compEnd ?? null;
        state.pilotsInDb = row ? Number(row.pilotCount ?? 0) : null;
    } catch (e) {
        ctx.log(`refreshObservations: meta query failed for ${ctx.compid}:`, e);
    }

    const todayDc = localDatecode(state.tz, localNow.epoch);

    // If the local date has rolled over, drop yesterday's first-launch
    // observations.
    if (state.firstLaunchDate !== localNow.iso) {
        state.firstLaunch.clear();
        state.firstLaunchDate = localNow.iso;
    }

    const observations: ClassObservation[] = [];
    for (const row of rows ?? []) {
        const status = String(row.status ?? ':');
        const isToday = row.datecode === todayDc;
        const starttimeMinutes = row.starttimeSecs != null ? Math.floor(Number(row.starttimeSecs) / 60) : null;
        const obs: ClassObservation = {
            classid: row.class,
            status,
            datecode: row.datecode ?? null,
            starttimeMinutes,
            isToday
        };
        observations.push(obs);

        // First-launch capture: if status indicates launched and we
        // haven't recorded a first-L for today, stamp it now.
        if (isToday && LAUNCHED_STATES.has(status) && !state.firstLaunch.has(obs.classid)) {
            state.firstLaunch.set(obs.classid, Date.now());
            ctx.log(`scheduler: first-launch for class ${obs.classid} captured`);
        }
    }

    state.observations = observations;
}

// ----- skip-day predicate (rule 1) -----

function makeSkipDayPredicate(tz: string, localNow: LocalTime, anyTaskToday: boolean): SkipDayPredicate {
    const todayDc = localDatecode(tz, localNow.epoch);
    const past10am = localNow.minuteOfDay >= PILOTS_PRETASK_LOCAL_MINUTE;
    return (_classid, datecode, _dateISO) => {
        if (datecode === todayDc) return false;
        // It's not today. Skip if we're past 10am local OR if we already
        // know there's a task for today.
        return past10am || anyTaskToday;
    };
}

// ---------- main scheduler entrypoint ----------

export interface SchedulerOptions {
    db: any;
    registry: SourceRegistry;
    log?: (msg: string, ...args: unknown[]) => void;
    heartbeatMs?: number;
}

const state = new Map<string, CompState>();

// Per-adapter bookkeeping for the daily discovery hook. `null` means
// "never run yet in this process" — the first heartbeat always fires
// discovery so a freshly-started daemon picks up new competitions
// immediately instead of waiting until 05:00 UTC.
const lastDiscoveryUtcDate = new Map<string, string>();

export async function runScheduler(opts: SchedulerOptions): Promise<void> {
    const log = opts.log ?? ((msg: string, ...args: unknown[]) => console.log(msg, ...args));
    const interval = opts.heartbeatMs ?? HEARTBEAT_MS;

    log(`scheduler: starting; types=${opts.registry.types().join(',')} heartbeat=${interval}ms`);

    // Run the first heartbeat immediately so a fresh process picks up
    // work before the first interval elapses.
    await heartbeat(opts.db, opts.registry, log);

    setInterval(() => {
        heartbeat(opts.db, opts.registry, log).catch((e) => log('scheduler heartbeat failed:', e));
    }, interval);
}

async function heartbeat(db: any, registry: SourceRegistry, log: (msg: string, ...args: unknown[]) => void): Promise<void> {
    // Daily competition discovery. Runs once at process startup (so a
    // fresh daemon picks up new comps immediately), and thereafter once
    // per UTC day on the first heartbeat at/after 05:00 UTC.
    await maybeRunDiscovery(db, registry, log);

    let sources: any[] = [];
    try {
        sources = (await db.query(escape`SELECT * FROM scoringsource WHERE type IN (${registry.types()})`)) as any[];
    } catch (e) {
        log('scheduler: scoringsource read failed:', e);
        return;
    }

    for (const src of sources ?? []) {
        if (!src.compid || !src.url) continue;
        const adapter = registry.get(src.type);
        if (!adapter) continue;
        try {
            await processCompetition(db, adapter, src, log);
        } catch (e) {
            log(`scheduler: competition ${src.compid} failed:`, e);
        }
    }
}

//
// maybeRunDiscovery — iterate the adapters that implement the optional
// `discoverCompetitions` hook and INSERT IGNORE any newly-listed
// competitions into `scoringsource` so the next heartbeat pass picks
// them up naturally. Per-adapter gating lets a registry with mixed
// sources schedule each source's discovery independently.
//
async function maybeRunDiscovery(
    db: any, //
    registry: SourceRegistry,
    log: (msg: string, ...args: unknown[]) => void
): Promise<void> {
    const now = new Date();
    const utcDate = now.toISOString().substring(0, 10);
    const utcHour = now.getUTCHours();

    for (const type of registry.types()) {
        const adapter = registry.get(type);
        if (!adapter?.discoverCompetitions) continue;

        const last = lastDiscoveryUtcDate.get(type);
        if (last != null) {
            // Not a first run — require both a new UTC day AND to be
            // past the 05:00 UTC trigger hour before firing again.
            if (last === utcDate) continue;
            if (utcHour < DISCOVERY_UTC_HOUR) continue;
        }
        lastDiscoveryUtcDate.set(type, utcDate);

        log(`scheduler: running discovery for type=${type}`);
        let discovered: {compid: string; url: string}[] = [];
        try {
            discovered = await adapter.discoverCompetitions({db, log});
        } catch (e) {
            log(`scheduler: discovery[${type}] threw:`, e);
            continue;
        }

        let added = 0;
        for (const d of discovered) {
            if (!d.compid || !d.url) continue;
            try {
                const existing = (await db.query(escape`
                    SELECT compid FROM scoringsource
                    WHERE compid = ${d.compid} AND type = ${type}
                `)) as any[];
                if (existing?.length) continue;
                await db.query(escape`
                    INSERT IGNORE INTO scoringsource (compid, type, url)
                    VALUES (${d.compid}, ${type}, ${d.url})
                `);
                log(`scheduler: discovered new competition ${d.compid} (${type}) → ${d.url}`);
                added++;
            } catch (e) {
                log(`scheduler: discovery insert failed for ${d.compid}:`, e);
            }
        }
        if (!added) {
            log(`scheduler: discovery[${type}] returned ${discovered.length}, none new`);
        }
    }
}

async function processCompetition(
    db: any, //
    adapter: ScoringSource,
    src: any,
    log: (msg: string, ...args: unknown[]) => void
): Promise<void> {
    let st = state.get(src.compid);
    if (!st) {
        st = await initState(db, src, log);
        state.set(src.compid, st);
    } else {
        // Refresh tz from DB in case it was updated by a previous fetch.
        st.tz = (await readCompetitionTz(db, src.compid)) ?? st.tz;
    }

    const ctx: SourceCtx = {
        compid: src.compid,
        url: src.url,
        tz: st.tz,
        db,
        log: (msg: string, ...args: unknown[]) => log(`[${src.compid}] ${msg}`, ...args),
        raw: src
    };

    // First time: ensure metadata so we have a competition row + tz.
    if (!st.metadataLoaded) {
        await adapter.ensureMetadata(ctx);
        st.tz = (await readCompetitionTz(db, src.compid)) ?? st.tz;
        ctx.tz = st.tz;
        st.metadataLoaded = true;
    }

    const localNow = nowInTz(st.tz);
    await refreshObservations(st, ctx, localNow);

    const decisions = computeDecisions(st, localNow, Date.now());

    // Compute "anyTaskToday" / "anyLaunchedToday" once for both the
    // skipDay predicate and the scheduling.
    let anyTaskToday = false;
    let anyLaunchedToday = false;
    for (const obs of st.observations) {
        if (!obs.isToday) continue;
        if (TASK_STATES.has(obs.status)) anyTaskToday = true;
        if (LAUNCHED_STATES.has(obs.status)) anyLaunchedToday = true;
    }

    if (decisions.fetchPilots || decisions.fetchResults) {
        ctx.log(`scheduler: ${decisions.reasons.join(', ')}`);
    }

    if (decisions.fetchPilots) {
        try {
            const pilotsResult = await adapter.fetchPilots(ctx);
            if (pilotsResult?.observed && pilotsResult.observed.size > 0) {
                st.lastPilotObservedClasses = new Set(pilotsResult.observed.keys());
            }
            st.lastPilotsFetch = Date.now();
            st.lastPilotsLocalDate = localDateISO(st.tz);
        } catch (e) {
            ctx.log('fetchPilots threw:', e);
        }
        // Reschedule whether or not we got results.
        st.nextPilotsAt = scheduleNextPilots(st, localNow, Date.now(), anyTaskToday, anyLaunchedToday);
    }

    if (decisions.fetchResults) {
        const skipDay = makeSkipDayPredicate(st.tz, localNow, anyTaskToday);
        try {
            const result = await adapter.fetchResultsAndTasks(ctx, skipDay);
            // Only prune classes when fetchPilots has given us a trustworthy
            // "these classes are registered" set this process — otherwise a
            // staggered task publish (one class has a task, others don't
            // yet) looks identical to a class being deleted and we'd wipe
            // pilots for classes that just haven't flown yet.
            if (st.lastPilotObservedClasses === null) {
                ctx.log('diffAndRemoveClasses: no pilots fetch yet this process; skipping prune');
            } else {
                const merged = new Set<ClassId>(result.observedClasses);
                for (const c of st.lastPilotObservedClasses) merged.add(c);
                await diffAndRemoveClasses(db, ctx.log, src.compid, merged);
            }
            // Refresh observations after the fetch — compstatus may have
            // been promoted to 'B' by the task install, which changes
            // the next-due interval.
            await refreshObservations(st, ctx, nowInTz(st.tz));
        } catch (e) {
            ctx.log('fetchResultsAndTasks threw:', e);
        }
        st.lastResultsFetch = Date.now();
        st.nextResultsAt = scheduleNextResults(st, nowInTz(st.tz), Date.now());
    }

    if (decisions.pruneOldDays) {
        const todayDc = localDatecode(st.tz, localNow.epoch);
        try {
            await pruneOldDays(db, ctx.log, src.compid, todayDc);
        } catch (e) {
            ctx.log('pruneOldDays threw:', e);
        }
        try {
            await resetStaleCompStatus(db, ctx.log, src.compid, todayDc);
        } catch (e) {
            ctx.log('resetStaleCompStatus threw:', e);
        }
        st.lastPruneDay = localNow.iso;
    }

    if (decisions.dropDeadComp) {
        try {
            const dropped = await dropDeadCompetition(db, ctx.log, src.compid);
            if (dropped) {
                state.delete(src.compid);
                return;
            }
        } catch (e) {
            ctx.log('dropDeadCompetition threw:', e);
        }
        st.nextDeadCheckAt = Date.now() + applyJitter(60 * 60 * 1000);
    }

    // If we did neither a pilots nor a results fetch and we don't have
    // a next-time set yet (fresh process), prime them now so subsequent
    // heartbeats skip cheaply.
    if (st.nextPilotsAt === 0) {
        st.nextPilotsAt = scheduleNextPilots(st, localNow, Date.now(), anyTaskToday, anyLaunchedToday);
    }
    if (st.nextResultsAt === 0) {
        st.nextResultsAt = scheduleNextResults(st, localNow, Date.now());
    }
    if (st.nextDeadCheckAt === 0) {
        st.nextDeadCheckAt = Date.now() + applyJitter(60 * 60 * 1000);
    }
}

async function initState(
    db: any, //
    src: any,
    log: (msg: string, ...args: unknown[]) => void
): Promise<CompState> {
    const tz = (await readCompetitionTz(db, src.compid)) ?? 'Europe/London';
    log(`scheduler: registering compid=${src.compid} type=${src.type} tz=${tz}`);
    return {
        compid: src.compid,
        url: src.url,
        type: src.type,
        raw: src,
        tz,
        metadataLoaded: false,
        lastPilotsFetch: 0,
        lastResultsFetch: 0,
        lastPilotsLocalDate: null,
        lastPilotObservedClasses: null,
        competitionStart: null,
        competitionEnd: null,
        pilotsInDb: null,
        firstLaunch: new Map(),
        firstLaunchDate: null,
        nextPilotsAt: 0,
        nextResultsAt: 0,
        observations: [],
        lastPruneDay: null,
        nextDeadCheckAt: 0
    };
}

async function readCompetitionTz(db: any, compid: string): Promise<string | null> {
    try {
        const row = (
            await db.query(escape`
                SELECT tz FROM competition WHERE compid = ${compid}
            `)
        )?.[0];
        return row?.tz ?? null;
    } catch {
        return null;
    }
}

// Re-export for the entry binary.
export {SourceRegistry};
