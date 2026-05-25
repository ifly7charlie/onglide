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
// The DB itself remains the source of truth for compstatus and for the
// per-task start-open time (tasks.nostart on the task='B' row).
//
// Dispatch state (next-due timestamps, last-fetched bookkeeping) lives
// per-source (per ScoringSource.type), not per-competition. That way a
// tracker-only adapter like robocontrol — whose pilots/results methods
// are no-op stubs — can't advance the primary scoring adapter's
// `nextPilotsAt` and starve it of a fetch slot.
//

import escape from 'sql-template-strings';

import type {ClassId, ScoringSource, SkipDayPredicate, SourceCtx} from './source';
import {SourceRegistry} from './source';
import {applyJitter, localDateISO, localDatecode, nowInTz, type LocalTime} from './shared/timezone';
import {diffAndRemoveClasses, resetStaleCompStatus} from './shared/classes';
import {pruneOldDays, dropDeadCompetition} from './shared/tasks';
import {TASK_STATES, LAUNCHED_STATES} from '../types';

// ---------- intervals (rules 2/3/4) ----------

const HEARTBEAT_MS = 60 * 1000;

const INTERVAL_TASKS_FAST_MS = 10 * 60 * 1000; // tasks: pre-task or status==L (catch L→S nostart rewrite)
const INTERVAL_TASKS_SLOW_MS = 30 * 60 * 1000; // tasks: post-brief pre-launch, or post-start until window closes
const INTERVAL_RESULTS_SLOW_MS = 30 * 60 * 1000; // results: post-F/H or post-18:00 until 22:00
const INTERVAL_PILOTS_URGENT_MS = 30 * 60 * 1000; // active comp, DB still empty
const INTERVAL_TRACKERS_DONE_MS = 60 * 60 * 1000; // trackers: hourly once every non-Z class is F or H
const TASK_LAUNCH_WINDOW_BASE_MS = 30 * 60 * 1000; // post-S task window base length (added to per-class pilot count)
const TASK_LAUNCH_WINDOW_PER_PILOT_MS = 60 * 1000; // post-S task window: +1 min per pilot in the class

const STOP_RESULTS_LOCAL_MINUTE = 22 * 60; // 22:00 local — stop results / tasks / trackers for the day
const MORNING_RESUME_LOCAL_MINUTE = 8 * 60; // 08:00 local — earliest minute-of-day pilots/results may run; also the park target after the 22:00 cutoff
const PILOTS_PRETASK_LOCAL_MINUTE = 10 * 60; // 10:00 local — daily pilots fetch fires after this; also the trackers window opens here
const TASK_MORNING_LOCAL_MINUTE = 12 * 60; // 12:00 local — upcoming-day results cutoff
const RESULTS_START_LOCAL_MINUTE = 18 * 60; // 18:00 local — results polling unlocked even if no class has hit F/H yet
const DEFAULT_TRACKER_INTERVAL_MS = 15 * 60 * 1000; // trackers: fallback for adapters that don't declare trackerIntervalMs

// Daily SoaringSpot-style index discovery runs at or after this UTC
// hour, plus once on startup regardless of wall-clock time.
const DISCOVERY_UTC_HOUR = 5;

// Authoritative scoring-source override. A competition with a
// `soaringspotkey` row is fed by the SoaringSpot OAuth API adapter
// (lib/scoring/sources/soaringspot.ts), which is authoritative over an
// HTML scrape of the same data. When such a row exists this scheduler
// skips its own scrape source for that compid — so an operator can
// switch a competition onto the API by adding a key row, without
// deleting the scrape row. Robocontrol is NOT suppressed by an override
// — it's a parallel tracker source, not a competing scoring source.
const OVERRIDE_SOURCE_TYPE = 'soaringspotkey';
const OVERRIDE_TARGET_TYPES: ReadonlySet<string> = new Set<string>(['soaringspotscrape']);

// Per-class compstatus phases used to drive desiredTaskCadence. These
// are scheduler-local — adding 'F' to lib/types.ts:TASK_STATES would
// break the task-scraper guard at lib/scoring/shared/tasks.ts:190 and
// the launched-states veto, so the membership test lives here.
const STATUS_NO_TASK: ReadonlySet<string> = new Set<string>(['?', ':', 'O']); // task not yet installed for the day
const STATUS_INSTALLED_PRELAUNCH: ReadonlySet<string> = new Set<string>(['B', 'G']); // task in DB, class not yet launched

// ---------- in-memory state ----------

interface ClassObservation {
    classid: ClassId;
    status: string; // single-char compstatus.status
    datecode: string | null;
    starttimeMinutes: number | null; // minute-of-day (local), parsed from tasks.nostart for the class's current datecode
    isToday: boolean; // does compstatus.datecode match today's local datecode?
    grandprix: boolean; // classes.grandprixstart='Y' — kept on the observation in case scheduling wants it later
    fullyScored: boolean; // all pilotresult rows for this class/datecode have datafromscoring='Y'
    pilotsInClass: number; // count of pilots in this class; sizes the post-launch task-amend window
    // UTC epoch ms of the most recent compstatus.status transition for
    // this row (maintained by DB triggers — only bumped on real
    // transitions, not no-op rewrites). Used as the process-restart
    // fallback for the in-memory firstLaunch map; trusted for L/S/F.
    laststatuschange: number | null;
}

// Per-source dispatch state. The shared `state` map is keyed by compid,
// but next-due timestamps and the corresponding last-fetched
// bookkeeping all live here so each scoringsource type has its own
// schedule. Robocontrol's no-op pilots/results stubs can no longer
// steal the primary adapter's fetch slots by advancing a shared
// timestamp.
interface SourceState {
    nextPilotsAt: number;
    nextTasksAt: number;
    nextResultsAt: number;
    nextTrackersAt: number;
    lastPilotsFetch: number;
    lastResultsFetch: number;
    lastTrackersFetch: number;
    lastPilotsLocalDate: string | null;
    lastResultsLocalDate: string | null;
    // Classes the pilots page reported on the last successful fetchPilots
    // for this source. Used (per-source) to veto the results-page diff
    // so a staggered task publish doesn't cascade-delete a class.
    lastPilotObservedClasses: Set<ClassId> | null;
    // Classes the tasks fetch saw on its most recent successful pass
    // for this source. Unioned into the diffAndRemoveClasses input on
    // the results-only dispatch.
    lastTaskObservedClasses: Set<ClassId> | null;
}

interface CompState {
    compid: string;
    url: string;
    type: string;
    raw: Record<string, any>;
    tz: string;
    countrycode: string | null;
    metadataLoaded: boolean;
    // Earliest epoch ms at which we'll fire the metadata probe. For
    // brand-new comps (no DB row yet) this is set to "now + jittered
    // delay" in initState so a discovery batch spreads its initial
    // metadata fetches across the jitter window rather than hitting
    // upstream all at once. 0 means "fire on next heartbeat".
    metadataDueAt: number;

    // Competition date window (YYYY-MM-DD strings in the comp's local tz,
    // inclusive). Refreshed from the `competition` row every heartbeat
    // so late-arriving start/end corrections are picked up.
    competitionStart: string | null;
    competitionEnd: string | null;
    // Number of pilot rows currently in DB for this compid, refreshed
    // each heartbeat. Used to decide when an "empty active comp" warrants
    // an urgent pilots fetch instead of waiting for the 10am gate.
    pilotsInDb: number | null;
    // Number of task rows currently in DB for this compid, refreshed
    // each heartbeat. When tasks exist but pilots don't, we trigger an
    // urgent pilots fetch regardless of comp dates — `fetchResultsAndTasks`
    // has already proven the comp is real, so waiting for the date window
    // would leave the front-end with results it can't attribute.
    tasksInDb: number | null;

    // per-class first-seen launch transition for today (epoch ms). On
    // restart we seed from the DB's `laststatuschange` for statuses
    // L/S/F because that timestamp marks a launch-related transition
    // close enough to anchor the post-launch task window. For H the
    // timestamp is the all-home transition (much later than launch) —
    // don't trust it. Cleared on local-date rollover.
    firstLaunch: Map<ClassId, number>;
    // The local date the firstLaunch map is keyed against — when this
    // changes we wipe the map.
    firstLaunchDate: string | null;

    // Sticky "any class today has hit F (FirstFinisher) or H (AllHome)".
    // Used as the results gate alongside the 18:00 local fallback. A
    // class that goes L→S→H quickly without lingering in F still trips
    // the gate via H. Cleared on local-date rollover.
    everFOrHToday: boolean;
    everFOrHTodayDate: string | null;

    // Per-source dispatch state — keyed by ScoringSource.type. Created
    // lazily on the first heartbeat that touches a given source.
    perSource: Map<string, SourceState>;

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
    fetchTasks: boolean;
    fetchResults: boolean;
    pruneOldDays: boolean;
    dropDeadComp: boolean;
    // Cadence interval (ms) to apply to nextTasksAt after a tasks fetch
    // fires. null when no class qualifies — caller parks to tomorrow.
    tasksCadenceMs: number | null;
    // rationale (for logging)
    reasons: string[];
}

//
// desiredTaskCadence — per-class task-fetch cadence based on observed
// compstatus phase. Returns null when this class has nothing left to
// chase today. The caller takes the MIN across today-classes.
//
//   ?, :, O     → FAST (10m)   — task not yet installed; catch publication
//   B, G        → SLOW (30m)   — task in DB, pre-launch; amendments rare but possible
//   L           → FAST (10m)   — class is launching; tasks.nostart will be rewritten on L→S, catch it promptly
//   S           → SLOW (30m)   — post-start within firstLaunch + 30m + 1m*pilotsInClass window; null after
//   F, H, Z     → null         — done for the day
//
// Render a tasks-cadence interval as a human-readable suffix for the
// scheduler reasons log. Used to be a hard-coded "fast"/"slow" label
// based on equality with INTERVAL_TASKS_FAST_MS, but with per-adapter
// overrides (e.g. SGP at 60s) those labels stop matching the real wait.
function formatCadence(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const minutes = ms / 60_000;
    return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

// Render a time-until-next-fire interval (nextXAt - Date.now()) for the
// `wait-next-due` reasons. Truncates to whole seconds under a minute,
// whole minutes between 1m and 1h, and h+m above. Negative deltas
// shouldn't happen in this branch (caller already gated on
// nowMs < nextAt) but normalise to 0s defensively.
function formatWait(ms: number): string {
    if (ms <= 0) return '0s';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const totalMin = Math.round(ms / 60_000);
    if (totalMin < 60) return `${totalMin}m`;
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

function desiredTaskCadence(obs: ClassObservation, firstLaunchAt: number | null, nowMs: number, activeOverrideMs?: number): number | null {
    if (STATUS_NO_TASK.has(obs.status)) return INTERVAL_TASKS_FAST_MS;
    if (STATUS_INSTALLED_PRELAUNCH.has(obs.status)) return INTERVAL_TASKS_SLOW_MS;
    if (obs.status === 'L') return activeOverrideMs ?? INTERVAL_TASKS_FAST_MS;
    if (obs.status === 'S') {
        if (obs.fullyScored) return null;
        if (firstLaunchAt == null) return activeOverrideMs ?? INTERVAL_TASKS_SLOW_MS; // no anchor yet — be safe and keep polling
        const windowMs = TASK_LAUNCH_WINDOW_BASE_MS + obs.pilotsInClass * TASK_LAUNCH_WINDOW_PER_PILOT_MS;
        return nowMs < firstLaunchAt + windowMs ? (activeOverrideMs ?? INTERVAL_TASKS_SLOW_MS) : null;
    }
    // F, H, Z, or any other code — done for the day.
    return null;
}

//
// computeDecisions — pure function over `state`, `srcState`, `localNow`.
// Encapsulates rules 2/3/4. No DB calls, no IO — designed to be unit-testable.
//
export function computeDecisions(
    state: CompState, //
    srcState: SourceState,
    localNow: LocalTime,
    nowMs: number,
    activeTasksCadenceMs?: number
): SchedulerDecisions {
    const reasons: string[] = [];

    // Hard quiet window: no outbound fetches before MORNING_RESUME_LOCAL_MINUTE
    // (08:00 local) — a daemon restart in the small hours mustn't blast
    // through it on a 0-seeded next-due timestamp. The 22:00 upper bound
    // is enforced per-stream below.
    const beforeMorning = localNow.minuteOfDay < MORNING_RESUME_LOCAL_MINUTE;
    if (beforeMorning) {
        reasons.push('quiet:before-morning');
        return {
            fetchPilots: false,
            fetchTasks: false,
            fetchResults: false,
            pruneOldDays: false,
            dropDeadComp: false,
            tasksCadenceMs: null,
            reasons
        };
    }

    const todaysObs = state.observations.filter((o) => o.isToday);

    // ----- pilots -----
    //
    // Pilots barely change day-to-day — daily 10am gate plus an urgent
    // override for active-but-empty comps is enough. The trackers stream
    // (per-source 5-15 min cadence) refreshes the contestants payload
    // anyway as a side effect, so a stale pilots map gets corrected
    // within a tracker tick.

    const isActiveToday = //
        state.competitionStart != null && //
        state.competitionEnd != null && //
        state.competitionStart <= localNow.iso && //
        localNow.iso <= state.competitionEnd;
    const isEmpty = srcState.lastPilotsFetch === 0 || (state.pilotsInDb ?? 0) === 0;
    const tasksWithoutPilots = (state.tasksInDb ?? 0) > 0 && (state.pilotsInDb ?? 0) === 0;
    const urgentPilotsFetch = (isActiveToday || tasksWithoutPilots) && isEmpty;

    let fetchPilots = false;
    if (
        (urgentPilotsFetch || localNow.minuteOfDay >= PILOTS_PRETASK_LOCAL_MINUTE) && //
        srcState.lastPilotsLocalDate !== localNow.iso && //
        nowMs >= srcState.nextPilotsAt
    ) {
        fetchPilots = true;
        if (urgentPilotsFetch) {
            reasons.push(tasksWithoutPilots && !isActiveToday ? 'pilots:urgent-tasks-no-pilots' : 'pilots:urgent-empty-active');
        } else {
            reasons.push('pilots:daily-10am');
        }
    } else if (srcState.lastPilotsLocalDate === localNow.iso) {
        reasons.push('pilots:done-today');
    } else if (localNow.minuteOfDay < PILOTS_PRETASK_LOCAL_MINUTE) {
        reasons.push('pilots:wait-10am');
    } else {
        reasons.push(`pilots:wait-next-due (in ${formatWait(srcState.nextPilotsAt - nowMs)})`);
    }

    // ----- tasks -----
    //
    // Per-class cadence via desiredTaskCadence; MIN across today-classes.
    // null cadence ⇒ no class qualifies, park to tomorrow morning. The
    // pre-22:00 gate still applies (after 22:00 we always park).

    let tasksCadenceMs: number | null = null;
    if (todaysObs.length > 0) {
        for (const obs of todaysObs) {
            const firstLaunchAt = state.firstLaunch.get(obs.classid) ?? null;
            const cadence = desiredTaskCadence(obs, firstLaunchAt, nowMs, activeTasksCadenceMs);
            if (cadence != null && (tasksCadenceMs == null || cadence < tasksCadenceMs)) {
                tasksCadenceMs = cadence;
            }
        }
    } else {
        // No today-classes yet (pre-comp, or compstatus empty). Keep
        // checking at FAST so a freshly-installed task lands quickly.
        tasksCadenceMs = INTERVAL_TASKS_FAST_MS;
    }

    let fetchTasks = false;
    if (localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE) {
        reasons.push('tasks:after-22:00-stop');
    } else if (tasksCadenceMs == null) {
        reasons.push('tasks:all-done-for-day');
    } else if (nowMs >= srcState.nextTasksAt) {
        fetchTasks = true;
        reasons.push(`tasks:due (${formatCadence(tasksCadenceMs)})`);
    } else {
        reasons.push(`tasks:wait-next-due (${formatCadence(tasksCadenceMs)}, in ${formatWait(srcState.nextTasksAt - nowMs)})`);
    }

    // ----- results -----
    //
    // Results aren't worth chasing before any class hits F (FirstFinisher)
    // or H (AllHome) — both flip the sticky `everFOrHToday` gate — or
    // before 18:00 local. Hard 22:00 stop. The all-scored short-circuit
    // and the upcoming-comp gate still apply.

    const allTodayScored = todaysObs.length > 0 && todaysObs.every((o) => o.fullyScored);
    const isUpcoming = state.competitionStart != null && localNow.iso < state.competitionStart;
    const upcomingPastMorning = isUpcoming && localNow.minuteOfDay >= TASK_MORNING_LOCAL_MINUTE;

    let fetchResults = false;
    if (allTodayScored) {
        reasons.push('results:all-scored-stop');
    } else if (upcomingPastMorning) {
        reasons.push('results:upcoming-after-12:00-stop');
    } else if (localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE) {
        reasons.push('results:after-22:00-stop');
    } else if (!state.everFOrHToday && localNow.minuteOfDay < RESULTS_START_LOCAL_MINUTE) {
        reasons.push('results:pre-F-or-H-pre-18:00');
    } else if (nowMs >= srcState.nextResultsAt) {
        fetchResults = true;
        reasons.push(state.everFOrHToday ? 'results:post-F-or-H' : 'results:post-18:00');
    } else {
        reasons.push(`results:wait-next-due (in ${formatWait(srcState.nextResultsAt - nowMs)})`);
    }

    // ----- maintenance -----

    const pruneEligible = localNow.minuteOfDay >= PILOTS_PRETASK_LOCAL_MINUTE && state.lastPruneDay !== localNow.iso;
    if (pruneEligible) reasons.push('prune:daily');

    const deadCheck = nowMs >= state.nextDeadCheckAt;
    if (deadCheck) reasons.push('dead-comp:check');

    return {
        fetchPilots,
        fetchTasks,
        fetchResults,
        pruneOldDays: pruneEligible,
        dropDeadComp: deadCheck,
        tasksCadenceMs,
        reasons
    };
}

// ----- schedule next-due times -----

// scheduleNextResults — next results-fetch time. Once past the 22:00
// cutoff (or every class is fully scored), park to tomorrow morning.
// Pre-F/H / pre-18:00 we still tick at SLOW cadence so that when the
// gate flips open we don't sleep through the first half hour.
function scheduleNextResults(state: CompState, localNow: LocalTime, nowMs: number): number {
    const todaysObs = state.observations.filter((o) => o.isToday);
    const allTodayScored = todaysObs.length > 0 && todaysObs.every((o) => o.fullyScored);

    if (localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE || allTodayScored) {
        return scheduleAtLocalMinuteTomorrow(state.tz, localNow, MORNING_RESUME_LOCAL_MINUTE);
    }
    return nowMs + applyJitter(INTERVAL_RESULTS_SLOW_MS);
}

// scheduleNextTasks — next tasks-fetch time. `cadenceMs` comes from
// computeDecisions (already the MIN across today-classes); null means
// no class qualifies, park to tomorrow. Past the 22:00 cutoff we also
// park.
function scheduleNextTasks(state: CompState, localNow: LocalTime, nowMs: number, cadenceMs: number | null): number {
    if (localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE || cadenceMs == null) {
        return scheduleAtLocalMinuteTomorrow(state.tz, localNow, MORNING_RESUME_LOCAL_MINUTE);
    }
    return nowMs + applyJitter(cadenceMs);
}

// scheduleNextTrackers — per-adapter trackers cadence. Adapter's
// trackerIntervalMs (defaults to 15 min) until every non-Z today-class
// is F or H; hourly after. If every today-class is Z (scrubbed), park
// to tomorrow morning. Hard 22:00 cutoff parks to tomorrow morning.
function scheduleNextTrackers(state: CompState, adapter: ScoringSource, localNow: LocalTime, nowMs: number): number {
    if (localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE) {
        return scheduleAtLocalMinuteTomorrow(state.tz, localNow, MORNING_RESUME_LOCAL_MINUTE);
    }
    const todaysObs = state.observations.filter((o) => o.isToday);
    if (todaysObs.length === 0) {
        // No classes today yet — adapter's normal interval (e.g. SGP 5m,
        // OAuth/robocontrol 15m) so a freshly-installed class lands soon.
        return nowMs + applyJitter(adapter.trackerIntervalMs ?? DEFAULT_TRACKER_INTERVAL_MS);
    }
    const nonZ = todaysObs.filter((o) => o.status !== 'Z');
    if (nonZ.length === 0) {
        // Every today-class is scrubbed — nothing to track till tomorrow.
        return scheduleAtLocalMinuteTomorrow(state.tz, localNow, MORNING_RESUME_LOCAL_MINUTE);
    }
    const allDone = nonZ.every((o) => o.status === 'F' || o.status === 'H');
    const interval = allDone ? INTERVAL_TRACKERS_DONE_MS : adapter.trackerIntervalMs ?? DEFAULT_TRACKER_INTERVAL_MS;
    return nowMs + applyJitter(interval);
}

// scheduleNextPilots — next pilots-fetch time. The "task-day hourly
// until launch" branch is gone (trackers cadence refreshes the
// contestants payload as a side effect); we only need to know when to
// re-arm the daily/urgent gate.
function scheduleNextPilots(state: CompState, srcState: SourceState, localNow: LocalTime, nowMs: number): number {
    const isActiveToday = //
        state.competitionStart != null && //
        state.competitionEnd != null && //
        state.competitionStart <= localNow.iso && //
        localNow.iso <= state.competitionEnd;
    const isEmpty = srcState.lastPilotsFetch === 0 || (state.pilotsInDb ?? 0) === 0;
    const tasksWithoutPilots = (state.tasksInDb ?? 0) > 0 && (state.pilotsInDb ?? 0) === 0;
    if ((isActiveToday || tasksWithoutPilots) && isEmpty) {
        return nowMs + applyJitter(INTERVAL_PILOTS_URGENT_MS);
    }
    if (localNow.minuteOfDay < PILOTS_PRETASK_LOCAL_MINUTE) {
        return localMinuteToEpochMsForward(state.tz, localNow, PILOTS_PRETASK_LOCAL_MINUTE);
    }
    return scheduleAtLocalMinuteTomorrow(state.tz, localNow, PILOTS_PRETASK_LOCAL_MINUTE);
}

// scheduleAtLocalMinuteTomorrow — "wake at HH:MM local tomorrow" with
// forward-only jitter so all comps in the same tz don't land on the
// same heartbeat at the target minute.
function scheduleAtLocalMinuteTomorrow(_tz: string, localNow: LocalTime, targetMinute: number): number {
    const minutesIntoDay = localNow.minuteOfDay;
    const minutesUntilTomorrow = 24 * 60 - minutesIntoDay + targetMinute;
    return localNow.epoch + minutesUntilTomorrow * 60 * 1000 + oneSidedJitter();
}

// Stampede-avoidance window for fixed-time wakeups (e.g. the 10:00
// local daily pilots fetch). All comps in the same tz that wake at
// the same target minute will land somewhere in [target, target+WINDOW]
// when this helper is used in place of localMinuteToEpochMs, so they
// don't all hit upstream on the same heartbeat.
const ONE_SIDED_JITTER_MS = 30 * 60 * 1000;

function oneSidedJitter(): number {
    return Math.floor(Math.random() * ONE_SIDED_JITTER_MS);
}

// Startup jitter — used by initSourceState to spread first-fetch HTTP
// across freshly-registered comps without swallowing the FAST tasks
// cadence (10 min) that the launch window depends on. 30-min one-sided
// jitter is fine for "tomorrow at 10am" parking but too long here.
const STARTUP_JITTER_MS = 5 * 60 * 1000;

function startupJitter(): number {
    return Math.floor(Math.random() * STARTUP_JITTER_MS);
}

// localMinuteToEpochMsForward — like localMinuteToEpochMs but with
// forward-only jitter, so the returned epoch is always >= the target
// local minute (never before). Use for wakeups where bunching at the
// exact target minute would cause a stampede.
function localMinuteToEpochMsForward(_tz: string, localNow: LocalTime, targetMinute: number): number {
    let delta = targetMinute - localNow.minuteOfDay;
    if (delta <= 0) delta += 24 * 60;
    return localNow.epoch + delta * 60 * 1000 + oneSidedJitter();
}

// ----- compstatus refresh + first-launch tracking -----

// Read compstatus rows for `compid` and populate state.observations.
// Also detect L/S/F transitions so state.firstLaunch is seeded, and
// flip the everFOrHToday gate when any class hits F or H.
async function refreshObservations(state: CompState, ctx: SourceCtx, localNow: LocalTime): Promise<void> {
    let rows: any[] = [];
    try {
        rows = (await ctx.db.query(escape`
            SELECT
                cs.class,
                cs.status,
                cs.datecode,
                UNIX_TIMESTAMP(cs.laststatuschange) * 1000 AS laststatusChangeMs,
                TIME_TO_SEC(t.nostart) AS starttimeSecs,
                cl.grandprixstart,
                COUNT(DISTINCT p.compno) AS pilotsInClass,
                (
                    SELECT
                        CASE
                            WHEN COUNT(*) > 0
                                AND COUNT(*) = SUM(CASE WHEN datafromscoring = 'Y' THEN 1 ELSE 0 END)
                            THEN 1
                            ELSE 0
                        END
                    FROM pilotresult pr
                    WHERE pr.class = cs.class
                      AND pr.datecode = cs.datecode
                ) AS fullyScored
            FROM compstatus cs
            JOIN classes cl ON cl.class = cs.class
            LEFT JOIN tasks t ON t.class = cs.class AND t.datecode = cs.datecode
            LEFT JOIN pilots p ON p.class = cs.class
            WHERE cl.compid = ${ctx.compid}
            GROUP BY cs.class, cs.status, cs.datecode, cs.laststatuschange, t.nostart, cl.grandprixstart
        `)) as any[];
    } catch (e) {
        ctx.log(`refreshObservations: query failed for ${ctx.compid}:`, e);
        return;
    }

    // Pull the comp's date window + pilot/task counts in one trip so the
    // urgent-fetch rule can see an up-to-date picture every heartbeat.
    try {
        const meta = (await ctx.db.query(escape`
            SELECT
                DATE_FORMAT(c.start, '%Y-%m-%d') AS compStart,
                DATE_FORMAT(c.end, '%Y-%m-%d') AS compEnd,
                (
                    SELECT COUNT(*) FROM pilots p
                    JOIN classes cl ON cl.class = p.class
                    WHERE cl.compid = ${ctx.compid}
                ) AS pilotCount,
                (
                    SELECT COUNT(*) FROM tasks t
                    JOIN classes cl ON cl.class = t.class
                    WHERE cl.compid = ${ctx.compid}
                ) AS taskCount
            FROM competition c
            WHERE c.compid = ${ctx.compid}
        `)) as any[];
        const row = meta?.[0];
        state.competitionStart = row?.compStart ?? null;
        state.competitionEnd = row?.compEnd ?? null;
        state.pilotsInDb = row ? Number(row.pilotCount ?? 0) : null;
        state.tasksInDb = row ? Number(row.taskCount ?? 0) : null;
    } catch (e) {
        ctx.log(`refreshObservations: meta query failed for ${ctx.compid}:`, e);
    }

    const todayDc = localDatecode(state.tz, localNow.epoch);

    // Local-date rollover wipes per-day in-memory state.
    if (state.firstLaunchDate !== localNow.iso) {
        state.firstLaunch.clear();
        state.firstLaunchDate = localNow.iso;
    }
    if (state.everFOrHTodayDate !== localNow.iso) {
        state.everFOrHToday = false;
        state.everFOrHTodayDate = localNow.iso;
    }

    const observations: ClassObservation[] = [];
    for (const row of rows ?? []) {
        const status = String(row.status ?? ':');
        const isToday = row.datecode === todayDc;
        const starttimeMinutes = row.starttimeSecs != null ? Math.floor(Number(row.starttimeSecs) / 60) : null;
        const laststatuschange = row.laststatusChangeMs != null ? Number(row.laststatusChangeMs) : null;
        const obs: ClassObservation = {
            classid: row.class,
            status,
            datecode: row.datecode ?? null,
            starttimeMinutes,
            isToday,
            grandprix: row.grandprixstart === 'Y',
            fullyScored: Number(row.fullyScored) === 1,
            pilotsInClass: Number(row.pilotsInClass ?? 0),
            laststatuschange
        };
        observations.push(obs);

        if (!isToday) continue;

        // F-or-H-sticky: any today-class that has hit FirstFinisher or
        // AllHome flips the sticky flag for the day. Cleared on date
        // rollover above. A class that goes L→S→H quickly without
        // lingering in F still trips the gate via H.
        if ((status === 'F' || status === 'H') && !state.everFOrHToday) {
            state.everFOrHToday = true;
            ctx.log(`scheduler: everFOrHToday flipped on class ${obs.classid} status=${status}`);
        }

        // First-launch capture: stamp now() the first time we observe a
        // launched-status class today. If the in-memory map is empty
        // (process restart), fall back to the DB's laststatuschange for
        // statuses L/S/F — the timestamp is the most recent transition,
        // which for those phases is launch-related and close enough to
        // anchor the post-launch task window. For H the timestamp is
        // the all-home transition (much later than launch) — don't use it.
        if (LAUNCHED_STATES.has(status) && !state.firstLaunch.has(obs.classid)) {
            const trustLastChange = (status === 'L' || status === 'S' || status === 'F') && laststatuschange != null;
            if (trustLastChange && laststatuschange != null) {
                state.firstLaunch.set(obs.classid, laststatuschange);
                ctx.log(`scheduler: first-launch for class ${obs.classid} seeded from laststatuschange (status=${status})`);
            } else {
                state.firstLaunch.set(obs.classid, Date.now());
                ctx.log(`scheduler: first-launch for class ${obs.classid} captured (status=${status})`);
            }
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

// (compid, type) pairs seen on the most recent successful scoringsource
// read. Used by the next heartbeat to detect (compid, type) entries that
// vanished without dropDeadCompetition having dropped them — a canary
// for transient DB issues (connection lost, slave replication gap) or
// an external row deletion. The dropped set holds entries we removed
// this process via dropDeadCompetition so the canary doesn't false-flag
// our own cleanup.
const previousScoringSourceEntries = new Set<string>();
const droppedScoringSourceEntries = new Set<string>();

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
        // Deterministic order (type, then compid) so log streams are
        // stable across heartbeats. The per-source state split means
        // iteration order is no longer load-bearing, but stable logs
        // make audit easier.
        sources = (await db.query(escape`SELECT * FROM scoringsource WHERE type IN (${registry.types()}) ORDER BY type, compid`)) as any[];
    } catch (e) {
        // DB connection / query failure — abort the heartbeat. We
        // deliberately do NOT touch in-memory state or trigger any
        // cleanup here: an empty (or unreadable) scoringsource result
        // must NOT be interpreted as "all comps removed". The next
        // heartbeat will retry.
        log('scheduler: scoringsource read failed — aborting heartbeat (in-memory state preserved):', e);
        return;
    }

    // Canary: which (compid, type) entries were present last heartbeat
    // that aren't here now, excluding ones the scheduler explicitly
    // dropped? When this fires for a comp you didn't expect to lose, it
    // points at either an external row delete or a DB read returning
    // stale/partial results.
    const currentEntries = new Set<string>();
    for (const src of sources ?? []) {
        if (src.compid && src.type) currentEntries.add(`${src.compid}|${src.type}`);
    }
    for (const prev of previousScoringSourceEntries) {
        if (currentEntries.has(prev) || droppedScoringSourceEntries.has(prev)) continue;
        const [compid, type] = prev.split('|');
        log(`scheduler: ${compid} (${type}) missing from scoringsource read — was present last heartbeat and NOT dropped by the scheduler. Likely DB connection blip or external row removal; in-memory state preserved, will resume when the row returns.`);
    }
    previousScoringSourceEntries.clear();
    for (const e of currentEntries) previousScoringSourceEntries.add(e);

    // Override gate: collect every compid that has an authoritative
    // `soaringspotkey` row. Any registered source for one of those
    // compids is skipped below — see OVERRIDE_SOURCE_TYPE. A failed scan
    // degrades to "no overrides" rather than stalling the heartbeat.
    const overriddenComps = new Set<string>();
    try {
        const rows = (await db.query(escape`SELECT DISTINCT compid FROM scoringsource WHERE type = ${OVERRIDE_SOURCE_TYPE}`)) as any[];
        for (const r of rows ?? []) {
            if (r.compid) overriddenComps.add(r.compid);
        }
    } catch (e) {
        // Override scan failure degrades to "no overrides" — adapters
        // continue firing rather than mis-classifying as suppressed.
        log('scheduler: override scan failed (treating as no overrides for this heartbeat):', e);
    }

    for (const src of sources ?? []) {
        if (!src.compid || !src.url) continue;
        const adapter = registry.get(src.type);
        if (!adapter) continue;
        // Override gate: a comp with `soaringspotkey` suppresses its
        // scrape source only. Robocontrol (and any other tracker-only
        // adapter) is orthogonal and continues firing.
        if (overriddenComps.has(src.compid) && OVERRIDE_TARGET_TYPES.has(src.type)) {
            log(`scheduler: skipping ${src.compid} (${src.type}) — overridden by '${OVERRIDE_SOURCE_TYPE}' source`);
            continue;
        }
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
        // Refresh tz/countrycode from DB in case they were updated by a previous fetch.
        const fields = await readCompetitionFields(db, src.compid);
        st.tz = fields.tz ?? st.tz;
        st.countrycode = fields.countrycode ?? st.countrycode;
    }

    const ctx: SourceCtx = {
        compid: src.compid,
        url: src.url,
        tz: st.tz,
        countrycode: st.countrycode,
        db,
        log: (msg: string, ...args: unknown[]) => log(`[${src.compid}/${src.type}] ${msg}`, ...args),
        raw: src
    };

    // First time: ensure metadata so we have a competition row + tz +
    // countrycode. Skip the HTTP probe entirely if the DB already has
    // name+sitename for this comp — a restart should not refetch
    // metadata it already has, since the multi-URL probe is the kind
    // of batch scan that pushes us into rate-limit territory.
    //
    // For brand-new comps, initState set metadataDueAt to a random
    // future epoch so a discovery batch spreads its initial fetches.
    // Skip the entire heartbeat for this comp until that timer expires.
    if (!st.metadataLoaded) {
        const existing = await readCompetitionFields(db, src.compid);
        if (existing.name && existing.sitename) {
            st.tz = existing.tz ?? st.tz;
            st.countrycode = existing.countrycode ?? st.countrycode;
            ctx.tz = st.tz;
            ctx.countrycode = st.countrycode;
            st.metadataLoaded = true;
        } else {
            if (Date.now() < st.metadataDueAt) {
                // Deferred — wait for the jitter window to expire so we
                // don't blast upstream right after discovery.
                return;
            }
            await adapter.ensureMetadata(ctx);
            const fields = await readCompetitionFields(db, src.compid);
            st.tz = fields.tz ?? st.tz;
            st.countrycode = fields.countrycode ?? st.countrycode;
            ctx.tz = st.tz;
            ctx.countrycode = st.countrycode;
            st.metadataLoaded = true;
        }
    }

    const localNow = nowInTz(st.tz);
    await refreshObservations(st, ctx, localNow);

    // Look up (or lazily create) the per-source dispatch state for this
    // adapter type.
    let srcState = st.perSource.get(src.type);
    if (!srcState) {
        srcState = initSourceState(st.tz, localNow);
        st.perSource.set(src.type, srcState);
    }

    const decisions = computeDecisions(st, srcState, localNow, Date.now(), adapter.activeTasksCadenceMs);

    // skipDay (rule 1) needs to know whether any class has a task today.
    let anyTaskToday = false;
    for (const obs of st.observations) {
        if (obs.isToday && TASK_STATES.has(obs.status)) {
            anyTaskToday = true;
            break;
        }
    }

    // ----- trackers (per-adapter, evaluated locally) -----
    //
    // The trackers stream sits outside computeDecisions because its
    // cadence is per-source (5m for SGP, 15m for OAuth/robocontrol) and
    // robocontrol + a primary adapter can both fire for the same compid.
    // Window opens at 10:00 local — there's nothing worth tracking
    // before the morning gate that pilots and tasks share.
    //
    // Reason label is computed before the fetch so it reflects the
    // decision (due / wait / off-hours / no-adapter), matching the
    // pilots/tasks/results pattern computeDecisions uses.
    let trackersReason: string;
    if (!adapter.fetchTrackers) {
        trackersReason = 'trackers:no-adapter';
    } else if (localNow.minuteOfDay < PILOTS_PRETASK_LOCAL_MINUTE) {
        trackersReason = 'trackers:before-10am';
    } else if (localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE) {
        trackersReason = 'trackers:after-22:00-stop';
    } else if (Date.now() >= srcState.nextTrackersAt) {
        trackersReason = 'trackers:due';
    } else {
        trackersReason = `trackers:wait-next-due (in ${formatWait(srcState.nextTrackersAt - Date.now())})`;
    }
    decisions.reasons.push(trackersReason);

    if (adapter.fetchTrackers && localNow.minuteOfDay >= PILOTS_PRETASK_LOCAL_MINUTE && localNow.minuteOfDay < STOP_RESULTS_LOCAL_MINUTE) {
        if (Date.now() >= srcState.nextTrackersAt) {
            try {
                await adapter.fetchTrackers(ctx);
            } catch (e) {
                ctx.log('fetchTrackers threw:', e);
            }
            srcState.lastTrackersFetch = Date.now();
            srcState.nextTrackersAt = scheduleNextTrackers(st, adapter, nowInTz(st.tz), Date.now());
        }
    }

    // Always emit decisions reasons so audit has visibility into
    // "why isn't anything firing" — not just when a fetch fires.
    ctx.log(`scheduler: ${decisions.reasons.join(', ')}`);

    if (decisions.fetchTasks) {
        const skipDay = makeSkipDayPredicate(st.tz, localNow, anyTaskToday);
        const acceptYesterday = srcState.lastResultsLocalDate !== localNow.iso;
        try {
            const result = await adapter.fetchResultsAndTasks(ctx, skipDay, {tasksOnly: true, acceptYesterday});
            if (result?.observedClasses) {
                srcState.lastTaskObservedClasses = result.observedClasses;
            }
            // Refresh observations — a task install promotes compstatus to
            // 'B', which the next decisions evaluation needs to see.
            await refreshObservations(st, ctx, nowInTz(st.tz));
        } catch (e) {
            ctx.log('fetchResultsAndTasks (tasks-only) threw:', e);
        }
        srcState.nextTasksAt = scheduleNextTasks(st, nowInTz(st.tz), Date.now(), decisions.tasksCadenceMs);
    }

    if (decisions.fetchPilots) {
        try {
            const pilotsResult = await adapter.fetchPilots(ctx);
            if (pilotsResult?.observed && pilotsResult.observed.size > 0) {
                srcState.lastPilotObservedClasses = new Set(pilotsResult.observed.keys());
            }
            srcState.lastPilotsFetch = Date.now();
            srcState.lastPilotsLocalDate = localDateISO(st.tz);
        } catch (e) {
            ctx.log('fetchPilots threw:', e);
        }
        srcState.nextPilotsAt = scheduleNextPilots(st, srcState, localNow, Date.now());
    }

    if (decisions.fetchResults) {
        const skipDay = makeSkipDayPredicate(st.tz, localNow, anyTaskToday);
        const acceptYesterday = srcState.lastResultsLocalDate !== localNow.iso;
        try {
            const result = await adapter.fetchResultsAndTasks(ctx, skipDay, {resultsOnly: true, acceptYesterday});
            if (srcState.lastPilotObservedClasses === null) {
                ctx.log('diffAndRemoveClasses: no pilots fetch yet this process; skipping prune');
            } else {
                const merged = new Set<ClassId>(result.observedClasses);
                for (const c of srcState.lastPilotObservedClasses) merged.add(c);
                if (srcState.lastTaskObservedClasses) {
                    for (const c of srcState.lastTaskObservedClasses) merged.add(c);
                }
                await diffAndRemoveClasses(db, ctx.log, src.compid, merged);
            }
            await refreshObservations(st, ctx, nowInTz(st.tz));
        } catch (e) {
            ctx.log('fetchResultsAndTasks (results-only) threw:', e);
        }
        srcState.lastResultsFetch = Date.now();
        srcState.lastResultsLocalDate = localNow.iso;
        srcState.nextResultsAt = scheduleNextResults(st, nowInTz(st.tz), Date.now());
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
                ctx.log(`scheduler: dropped competition (cascade complete, no leftover rows). Removing from in-memory state; will not appear in subsequent heartbeats unless re-added to scoringsource.`);
                state.delete(src.compid);
                // Remember every (compid, type) tuple we removed so the
                // heartbeat canary doesn't flag this as an unexpected
                // disappearance on the next read.
                droppedScoringSourceEntries.add(`${src.compid}|${src.type}`);
                return;
            }
        } catch (e) {
            ctx.log('dropDeadCompetition threw:', e);
        }
        st.nextDeadCheckAt = Date.now() + applyJitter(60 * 60 * 1000);
    }

    // Prime any next-due timestamps that didn't already get advanced by
    // a real fetch this heartbeat — so subsequent heartbeats skip cheaply
    // rather than re-firing the gate every tick.
    if (srcState.nextPilotsAt === 0) {
        srcState.nextPilotsAt = scheduleNextPilots(st, srcState, localNow, Date.now());
    }
    if (srcState.nextTasksAt === 0) {
        srcState.nextTasksAt = scheduleNextTasks(st, localNow, Date.now(), decisions.tasksCadenceMs);
    }
    if (srcState.nextResultsAt === 0) {
        srcState.nextResultsAt = scheduleNextResults(st, localNow, Date.now());
    }
    if (st.nextDeadCheckAt === 0) {
        st.nextDeadCheckAt = Date.now() + applyJitter(60 * 60 * 1000);
    }
}

// Jitter window over which a discovery batch's initial metadata
// fetches are spread. Brand-new comps (no DB row yet) wait a uniform
// random delay inside this window before their first 3-URL probe so
// N freshly-discovered comps don't blast upstream in one heartbeat.
const METADATA_JITTER_MS = 30 * 60 * 1000; // 30 min

async function initState(
    db: any, //
    src: any,
    log: (msg: string, ...args: unknown[]) => void
): Promise<CompState> {
    const fields = await readCompetitionFields(db, src.compid);
    const tz = fields.tz ?? 'Europe/London';
    const alreadyKnown = !!(fields.name && fields.sitename);
    const metadataDueAt = alreadyKnown
        ? 0
        : Date.now() + Math.floor(Math.random() * METADATA_JITTER_MS);
    log(`scheduler: registering compid=${src.compid} type=${src.type} tz=${tz}${alreadyKnown ? '' : ` metadataDueAt=+${Math.round((metadataDueAt - Date.now()) / 1000)}s`}`);

    return {
        compid: src.compid,
        url: src.url,
        type: src.type,
        raw: src,
        tz,
        countrycode: fields.countrycode,
        metadataLoaded: false,
        metadataDueAt,
        competitionStart: null,
        competitionEnd: null,
        pilotsInDb: null,
        tasksInDb: null,
        firstLaunch: new Map(),
        firstLaunchDate: null,
        everFOrHToday: false,
        everFOrHTodayDate: null,
        perSource: new Map(),
        observations: [],
        lastPruneDay: null,
        nextDeadCheckAt: 0
    };
}

// initSourceState — seed a brand-new SourceState. Per-source first-fetch
// times use forward jitter; if the daemon starts in the night-quiet
// window (before 08:00 or after 22:00), defer the first fetch to the
// next morning's MORNING_RESUME_LOCAL_MINUTE so we don't queue up
// fetches the decision-time gate will then refuse.
function initSourceState(tz: string, localNow: LocalTime): SourceState {
    const inNightQuiet = localNow.minuteOfDay < MORNING_RESUME_LOCAL_MINUTE || localNow.minuteOfDay >= STOP_RESULTS_LOCAL_MINUTE;
    const morningOrJitter = (): number =>
        inNightQuiet //
            ? localMinuteToEpochMsForward(tz, localNow, MORNING_RESUME_LOCAL_MINUTE)
            : Date.now() + startupJitter();
    return {
        nextPilotsAt: morningOrJitter(),
        nextTasksAt: morningOrJitter(),
        nextResultsAt: morningOrJitter(),
        nextTrackersAt: morningOrJitter(),
        lastPilotsFetch: 0,
        lastResultsFetch: 0,
        lastTrackersFetch: 0,
        lastPilotsLocalDate: null,
        lastResultsLocalDate: null,
        lastPilotObservedClasses: null,
        lastTaskObservedClasses: null
    };
}

async function readCompetitionFields(db: any, compid: string): Promise<{tz: string | null; countrycode: string | null; name: string | null; sitename: string | null}> {
    try {
        const row = (
            await db.query(escape`
                SELECT tz, countrycode, name, sitename FROM competition WHERE compid = ${compid}
            `)
        )?.[0];
        return {
            tz: row?.tz ?? null,
            countrycode: row?.countrycode ?? null,
            name: row?.name ?? null,
            sitename: row?.sitename ?? null
        };
    } catch {
        return {tz: null, countrycode: null, name: null, sitename: null};
    }
}

//
// dumpSchedulerState — print the full per-comp scheduler state to the
// daemon log. Wired to SIGUSR1 in bin/ssscrape.ts. Quietest possible
// in normal operation, on-demand when something looks wrong.
//
export function dumpSchedulerState(log: (msg: string, ...args: unknown[]) => void = console.log): void {
    const nowMs = Date.now();
    const fmt = (ms: number): string => {
        if (ms === 0) return '0';
        const dt = new Date(ms);
        const deltaSec = Math.round((ms - nowMs) / 1000);
        return `${dt.toISOString()} (${deltaSec >= 0 ? '+' : ''}${deltaSec}s)`;
    };
    log(`scheduler dump: ${state.size} comp(s) tracked, t=${new Date(nowMs).toISOString()}`);
    for (const [compid, st] of state) {
        const localNow = nowInTz(st.tz);
        const hh = Math.floor(localNow.minuteOfDay / 60).toString().padStart(2, '0');
        const mm = (localNow.minuteOfDay % 60).toString().padStart(2, '0');
        log(`  [${compid}] tz=${st.tz} localNow=${localNow.iso} ${hh}:${mm}`);
        log(`    competition: ${st.competitionStart ?? '?'}..${st.competitionEnd ?? '?'} pilotsInDb=${st.pilotsInDb ?? '?'} tasksInDb=${st.tasksInDb ?? '?'}`);
        log(`    everFOrHToday=${st.everFOrHToday} (date=${st.everFOrHTodayDate ?? 'n/a'}) lastPruneDay=${st.lastPruneDay ?? 'n/a'} nextDeadCheckAt=${fmt(st.nextDeadCheckAt)}`);
        const fl = [...st.firstLaunch.entries()].map(([c, t]) => `${c}@${new Date(t).toISOString()}`).join(', ');
        log(`    firstLaunch: ${fl || '(empty)'} firstLaunchDate=${st.firstLaunchDate ?? 'n/a'}`);
        log(`    observations (${st.observations.length}):`);
        for (const obs of st.observations) {
            log(`      ${obs.classid} status=${obs.status} datecode=${obs.datecode ?? '?'} today=${obs.isToday} fullyScored=${obs.fullyScored} pilotsInClass=${obs.pilotsInClass} startMin=${obs.starttimeMinutes ?? '?'}`);
        }
        log(`    perSource (${st.perSource.size}):`);
        for (const [type, src] of st.perSource) {
            log(`      [${type}] nextPilots=${fmt(src.nextPilotsAt)} nextTasks=${fmt(src.nextTasksAt)} nextResults=${fmt(src.nextResultsAt)} nextTrackers=${fmt(src.nextTrackersAt)}`);
            log(`              lastPilotsFetch=${fmt(src.lastPilotsFetch)} lastResultsFetch=${fmt(src.lastResultsFetch)} lastTrackersFetch=${fmt(src.lastTrackersFetch)}`);
            log(`              lastPilotsLocalDate=${src.lastPilotsLocalDate ?? 'n/a'} lastResultsLocalDate=${src.lastResultsLocalDate ?? 'n/a'}`);
            const pilotObs = src.lastPilotObservedClasses ? [...src.lastPilotObservedClasses].join(',') : 'null';
            const taskObs = src.lastTaskObservedClasses ? [...src.lastTaskObservedClasses].join(',') : 'null';
            log(`              lastPilotObservedClasses=${pilotObs} lastTaskObservedClasses=${taskObs}`);
        }
    }
}

// Re-export for the entry binary.
export {SourceRegistry};
