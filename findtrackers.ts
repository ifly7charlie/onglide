//
// findtrackers — match unknown flarm IDs to pilots by replaying the day's
// APRS log against a task's start and finish lines, then comparing the
// resulting crossing times against the official pilotresult start/finish.
//
// Pure-ish: the caller hands in a fully-built Task (calculateTask'd) and
// the official-time list, and we hand back match candidates. No DB / argv.
// `bin/findtrackers.ts` wraps this; `bin/ogn.ts` will too.
//
// Streaming-only: we never accumulate the day's points. Per-flarmid state
// is one previous point + a crossings array, both bounded.
//

import type {Task, Compno, Epoch, BasePositionMessage, AltitudeAMSL, FlarmID} from '../../types';
import {PreparedTurnpoint} from '../../flightprocessing/preparedTurnpoint';
import {loadPointsForIds} from '../../webworkers/pointlog';

const MAX_FLARM_DIST_KM = 50; // first sighting >50 km from the relevant TP → skip
const DEFAULT_MAX_GAP_SEC = 60; // don't run hasCrossed across a coverage gap (override via opts.maxGapSec)
const DEFAULT_REORDER_WINDOW_SEC = 20; // per-flarmid sliding reorder buffer (override via opts.reorderWindowSec)
const DEFAULT_TOLERANCE_SEC = 5;

export interface OfficialResult {
    compno: Compno;
    name: string;
    trackerid: string; // current value in tracker.trackerid (or '')
    startUtc: Epoch;
    finishUtc: Epoch;
}

export interface TrackerMatch {
    compno: Compno;
    name: string;
    flarmid: FlarmID;
    /** seconds, signed (flarm crossing - official); null when no usable crossing pair (assigned-tracker reports only) */
    deltaStart: number | null;
    deltaFinish: number | null;
    /** max(|deltaStart|, |deltaFinish|), lower is better; null when deltas are null */
    confidence: number | null;
    currentTrackerid: string;
    /** This flarmid is one of the pilot's currently-recorded trackerids. */
    assigned: boolean;
    /** confidence ≤ tolerance. False on assigned-only rows that fall outside, or when no crossings. */
    withinTolerance: boolean;
    /** >1 within-tolerance candidate per pilot, OR >1 within-tolerance pilot per flarmid */
    ambiguous: boolean;
    /**
     * For assigned-tracker rows only: the flarmid was geographically gated
     * out (first sighting >MAX_FLARM_DIST_KM from the start and/or finish
     * TP), so it never produced crossings — strong signal that the recorded
     * id is wrong, or the pilot wasn't actually flying this comp.
     */
    skipped: boolean;
}

export interface FindTrackersOptions {
    task: Task; // already calculateTask'd (preparedLegs populated)
    results: OfficialResult[];
    toleranceSec?: number;
    /** Skip running hasCrossed on a pair whose Δt exceeds this. Default 60s. */
    maxGapSec?: number;
    /** Per-flarmid sliding reorder buffer (and stale-latency threshold). Default 20s. */
    reorderWindowSec?: number;
    excludeFlarmids?: Set<FlarmID>;
    log?: (msg: string) => void;
    /**
     * If set, emit verbose per-packet / per-segment trace lines through
     * `log()` for these flarmids — useful when "no crossings" is reported
     * for a tracker that visibly crossed the line. Case-insensitive match.
     */
    debugFlarmids?: Set<FlarmID>;
}

type CrossingMap = Map<FlarmID, Epoch[]>;

export async function findTrackerMatches(opts: FindTrackersOptions): Promise<TrackerMatch[]> {
    const {task, results} = opts;
    const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
    const maxGapSec = opts.maxGapSec ?? DEFAULT_MAX_GAP_SEC;
    const reorderWindowSec = opts.reorderWindowSec ?? DEFAULT_REORDER_WINDOW_SEC;
    const excludeFlarmids = opts.excludeFlarmids ?? new Set<FlarmID>();
    const log = opts.log ?? (() => {});
    const debugFlarmids = normaliseFlarmIds(opts.debugFlarmids);

    if (!task.preparedLegs?.length) {
        throw new Error('findTrackerMatches: task.preparedLegs missing — call calculateTask first');
    }
    if (!results.length) return [];

    const startTP = task.preparedLegs[0];
    const finishTP = task.preparedLegs[task.preparedLegs.length - 1];

    const slack = Math.max(60, tolerance + 5);
    let minStart = Infinity,
        maxStart = -Infinity,
        minFinish = Infinity,
        maxFinish = -Infinity;
    for (const r of results) {
        if (r.startUtc < minStart) minStart = r.startUtc;
        if (r.startUtc > maxStart) maxStart = r.startUtc;
        if (r.finishUtc < minFinish) minFinish = r.finishUtc;
        if (r.finishUtc > maxFinish) maxFinish = r.finishUtc;
    }

    // Pilots whose official start AND finish are both within 2×tolerance of
    // each other can't be told apart on times alone — any flarmid matching
    // one will match the others within tolerance. Surface those groups up
    // front so the operator knows the ambiguity flags downstream are
    // structural, not a tracker-quality issue.
    for (const group of findConcurrentPilots(results, tolerance)) {
        const labels = group.map((r) => `${r.compno} ${r.name}`.trim()).join(', ');
        log(`⚠ ${group.length} pilots have identical official times (within ±${tolerance}s on start and finish) — matches will be ambiguous: ${labels}`);
    }

    // Watch times for the debug trace: each pilot's official start (resp.
    // finish), labelled so the trace marker tells you which pilot.
    const labelOf = (r: OfficialResult) => `${r.compno}${r.name ? ' ' + r.name : ''}`;
    const startWatch: WatchTime[] = results.map((r) => ({t: r.startUtc, label: labelOf(r)})).sort((a, b) => a.t - b.t);
    const finishWatch: WatchTime[] = results.map((r) => ({t: r.finishUtc, label: labelOf(r)})).sort((a, b) => a.t - b.t);

    log(`start scan: window ${Math.round((maxStart - minStart) / 60 + (2 * slack) / 60)} min, ${results.length} pilots, maxGap=${maxGapSec}s, reorderWindow=${reorderWindowSec}s`);
    const startScan = await scanLine(startTP, minStart - slack, maxStart + slack, 'start', excludeFlarmids, log, debugFlarmids, startWatch, maxGapSec, reorderWindowSec);

    log(`finish scan: window ${Math.round((maxFinish - minFinish) / 60 + (2 * slack) / 60)} min`);
    const finishScan = await scanLine(finishTP, minFinish - slack, maxFinish + slack, 'finish', excludeFlarmids, log, debugFlarmids, finishWatch, maxGapSec, reorderWindowSec);

    return matchCrossings(results, startScan, finishScan, tolerance);
}

interface FlarmState {
    prev?: BasePositionMessage; // last drained (processed) point — used for hasCrossed
    buf: BasePositionMessage[]; // pending points, sorted by t ascending
    latestSeen: number; // max t observed for this flarmid (across both arrival and reorder)
    skipped: boolean; // failed the geographic gate on first arrival
}

interface ScanResult {
    crossings: CrossingMap;
    skipped: Set<FlarmID>; // failed the geographic gate
}

interface WatchTime {
    t: number;
    label: string;
}

function fmtUtcHms(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(11, 19);
}

const DEBUG_WATCH_WINDOW_SEC = 60;

async function scanLine(
    tp: PreparedTurnpoint, //
    since: number,
    until: number,
    kind: 'start' | 'finish',
    excludeFlarmids: Set<FlarmID>,
    log: (msg: string) => void,
    debugFlarmids: Set<FlarmID>,
    debugWatchTimes: WatchTime[],
    maxGapSec: number,
    reorderWindowSec: number
): Promise<ScanResult> {
    const center: BasePositionMessage = {lat: tp.leg.nlat, lng: tp.leg.nlng, a: 0 as AltitudeAMSL, t: 0 as Epoch};
    const state = new Map<FlarmID, FlarmState>();
    const crossings: CrossingMap = new Map();
    let lateDropped = 0;
    let staleDropped = 0;

    // Per-debug-flarmid stats and trace storage. We aggregate inline and
    // only print at end-of-scan to keep the trace one tidy block per id.
    interface DebugStats {
        firstArrivalT?: number;
        firstArrivalDistKm?: number;
        skipped: boolean;
        accepted: number;
        late: number;
        stale: number;
        duplicates: number;
        drainedPairs: number;
        crossingsRecorded: number;
        // Notable pair traces, each tagged with `cur.t` so we can interleave
        // the official-time markers at the right place when emitting.
        pairTraces: {ts: number; line: string}[];
    }
    const dbg = new Map<FlarmID, DebugStats>();
    const isDebug = (f: FlarmID) => debugFlarmids.has(f) || debugFlarmids.has(f.toLowerCase() as FlarmID) || debugFlarmids.has(f.toUpperCase() as FlarmID);
    const dbgFor = (f: FlarmID): DebugStats | undefined => {
        if (!isDebug(f)) return undefined;
        let d = dbg.get(f);
        if (!d) {
            d = {skipped: false, accepted: 0, late: 0, stale: 0, duplicates: 0, drainedPairs: 0, crossingsRecorded: 0, pairTraces: []};
            dbg.set(f, d);
        }
        return d;
    };
    // A pair is "in a watch window" when at least one official time falls
    // inside [prev.t - W, cur.t + W]. With watch times sorted we could
    // bisect, but the list is small (one entry per pilot) so the linear
    // probe is fine and keeps the code obvious.
    const inWatchWindow = (prevT: number, curT: number): boolean => {
        const lo = prevT - DEBUG_WATCH_WINDOW_SEC;
        const hi = curT + DEBUG_WATCH_WINDOW_SEC;
        for (const w of debugWatchTimes) if (w.t >= lo && w.t <= hi) return true;
        return false;
    };

    // Drain stable points (t ≤ until) from a flarmid's buffer, running
    // hasCrossed on each consecutive pair as we go. Same crossing rules
    // as taskpositiongenerator.ts: strict for start (line 245), first
    // crossing wins for finish (line 395).
    const drain = (f: FlarmID, st: FlarmState, threshold: number) => {
        const d = dbgFor(f);
        while (st.buf.length && st.buf[0].t <= threshold) {
            const cur = st.buf.shift()!;
            if (st.prev && cur.t - st.prev.t <= maxGapSec && cur.t > st.prev.t) {
                if (d) d.drainedPairs++;
                const hc = tp.hasCrossed(st.prev, cur);
                let recorded: number | null = null;
                if (kind === 'start') {
                    if (hc.everInside && !hc.finalInside && hc.crossings.length) {
                        recorded = hc.crossings[hc.crossings.length - 1].at.t;
                        pushCrossing(crossings, f, recorded as Epoch);
                        if (d) d.crossingsRecorded++;
                    }
                } else {
                    if (hc.crossings.length) {
                        recorded = hc.crossings[0].at.t;
                        pushCrossing(crossings, f, recorded as Epoch);
                        if (d) d.crossingsRecorded++;
                    }
                }
                if (d && (recorded !== null || inWatchWindow(st.prev.t, cur.t))) {
                    d.pairTraces.push({
                        ts: cur.t,
                        line:
                            `pair t=${fmtUtcHms(st.prev.t)}→${fmtUtcHms(cur.t)} (${cur.t - st.prev.t}s)  ` +
                            `ev=${hc.everInside} fi=${hc.finalInside} xs=${hc.crossings.length}  ` +
                            `d=${hc.distanceKm?.toFixed(3) ?? '-'}km` +
                            (hc.nearMissBeyondM !== undefined ? `  nmB=${hc.nearMissBeyondM.toFixed(0)}m` : '') +
                            (recorded !== null ? `  → recorded ${fmtUtcHms(recorded)}` : '')
                    });
                }
            } else if (d && st.prev && inWatchWindow(st.prev.t, cur.t)) {
                // Pair was rejected (gap, non-monotonic). Surface only
                // those near a watch time so the trace stays focused.
                const gap = cur.t - st.prev.t;
                if (gap > maxGapSec) d.pairTraces.push({ts: cur.t, line: `pair t=${fmtUtcHms(st.prev.t)}→${fmtUtcHms(cur.t)} skipped: gap ${gap}s > ${maxGapSec}s`});
                else if (gap <= 0) d.pairTraces.push({ts: cur.t, line: `pair t=${fmtUtcHms(st.prev.t)}→${fmtUtcHms(cur.t)} skipped: non-monotonic`});
            }
            st.prev = cur;
        }
    };

    for await (const msg of loadPointsForIds({since, until})) {
        const f = msg.f;
        if (excludeFlarmids.has(f)) continue;
        // The packet itself records the latency at write time as `d` (now − fix
        // time). A packet declaring d > reorderWindowSec is by definition
        // older than our reorder buffer can absorb when its real-time peers
        // have already passed through — drop it before it enters the buffer.
        // This is more reliable than the file-order-based "predates prev"
        // check because some late packets sneak in before prev advances.
        if (typeof msg.d === 'number' && msg.d > reorderWindowSec) {
            staleDropped++;
            const d = dbgFor(f);
            if (d) d.stale++;
            continue;
        }
        const pos: BasePositionMessage = {lat: msg.lat, lng: msg.lng, a: msg.a, t: msg.t};
        let st = state.get(f);
        if (!st) {
            // First sighting in this scan: geographic gate.
            const dist = PreparedTurnpoint.geodesicDistance(center, pos);
            const d = dbgFor(f);
            if (d) {
                d.firstArrivalT = pos.t;
                d.firstArrivalDistKm = dist;
            }
            if (dist > MAX_FLARM_DIST_KM) {
                state.set(f, {buf: [], latestSeen: pos.t, skipped: true});
                if (d) d.skipped = true;
                continue;
            }
            st = {buf: [], latestSeen: pos.t, skipped: false};
            state.set(f, st);
        }
        if (st.skipped) continue;

        const d = dbgFor(f);

        // Predates everything we've already drained → can't reinsert.
        if (st.prev && pos.t <= st.prev.t) {
            lateDropped++;
            if (d) d.late++;
            continue;
        }
        // Falls outside the reorder window — too late to be useful.
        if (pos.t < st.latestSeen - reorderWindowSec) {
            lateDropped++;
            if (d) d.late++;
            continue;
        }

        // Insertion-sort into the (small) buffer; drop exact-time duplicates.
        let i = st.buf.length;
        while (i > 0 && st.buf[i - 1].t > pos.t) i--;
        if (i < st.buf.length && st.buf[i].t === pos.t) {
            if (d) d.duplicates++;
            continue;
        }
        if (i > 0 && st.buf[i - 1].t === pos.t) {
            if (d) d.duplicates++;
            continue;
        }
        st.buf.splice(i, 0, pos);
        if (d) d.accepted++;

        if (pos.t > st.latestSeen) st.latestSeen = pos.t;

        // Drain anything that is now older than latestSeen − reorderWindowSec,
        // i.e. settled — no later out-of-order packet can shuffle in front.
        drain(f, st, st.latestSeen - reorderWindowSec);
    }

    // End-of-scan flush: drain remaining buffer (last reorderWindowSec
    // worth) for every non-skipped flarmid.
    let tracked = 0;
    const skipped = new Set<FlarmID>();
    for (const [f, st] of state) {
        if (st.skipped) {
            skipped.add(f);
            continue;
        }
        tracked++;
        drain(f, st, Infinity);
    }

    log(
        `  → ${tracked} tracked, ${skipped.size} skipped (>${MAX_FLARM_DIST_KM} km), ${staleDropped} stale (self-reported d>${reorderWindowSec}s), ${lateDropped} late (>${reorderWindowSec}s out of order), ${crossings.size} with ${kind} crossings`
    );

    // Emit the per-debug-flarmid trace as a tidy block per id per scan.
    if (debugFlarmids.size && debugWatchTimes.length) {
        const fmt = (w: WatchTime) => `${w.label} ${fmtUtcHms(w.t)}`;
        const head = debugWatchTimes.slice(0, 6).map(fmt).join(', ');
        const more = debugWatchTimes.length > 6 ? ` … (+${debugWatchTimes.length - 6} more)` : '';
        log(`  [debug ${kind}] ${debugWatchTimes.length} watch times (±${DEBUG_WATCH_WINDOW_SEC}s): ${head}${more}`);
    }
    for (const f of debugFlarmids) {
        // Try the id we were asked about, then any case variant present.
        let key = f;
        let d = dbg.get(key);
        if (!d) {
            for (const [k, v] of dbg)
                if (k.toUpperCase() === f.toUpperCase()) {
                    key = k;
                    d = v;
                    break;
                }
        }
        log(`  [debug ${kind} ${f}] ` + (d ? formatDebugStats(d) : 'never seen in this window'));
        if (d?.pairTraces.length) {
            // Interleave watch-time markers between pair traces. Only show
            // markers that fall within ±W of an actual emitted pair, so the
            // marker is always anchored to nearby context.
            const traces = d.pairTraces;
            const traceMin = traces[0].ts - DEBUG_WATCH_WINDOW_SEC;
            const traceMax = traces[traces.length - 1].ts + DEBUG_WATCH_WINDOW_SEC;
            const watches = debugWatchTimes.filter((w) => w.t >= traceMin && w.t <= traceMax);

            const merged: Array<{ts: number; line: string; isMarker: boolean}> = [];
            for (const pt of traces) merged.push({ts: pt.ts, line: pt.line, isMarker: false});
            for (const w of watches) merged.push({ts: w.t, line: `---- ${fmtUtcHms(w.t)} (${w.t}) official ${kind}: ${w.label} ----`, isMarker: true});
            // Sort by ts; on ties put the marker before the pair so the
            // marker appears immediately above the relevant pair.
            merged.sort((a, b) => a.ts - b.ts || (a.isMarker === b.isMarker ? 0 : a.isMarker ? -1 : 1));
            for (const e of merged) log(`    [debug ${kind} ${f}] ${e.line}`);
        }
        const recorded = crossings.get(key);
        if (recorded?.length) log(`    [debug ${kind} ${f}] recorded crossings: ${recorded.map((t) => `${fmtUtcHms(t)} (${t})`).join(', ')}`);
    }
    return {crossings, skipped};
}

function formatDebugStats(d: {
    firstArrivalT?: number;
    firstArrivalDistKm?: number;
    skipped: boolean;
    accepted: number;
    late: number;
    stale: number;
    duplicates: number;
    drainedPairs: number;
    crossingsRecorded: number;
}): string {
    const arr = d.firstArrivalT !== undefined ? `first arrival t=${d.firstArrivalT} dist=${d.firstArrivalDistKm?.toFixed(1)}km` : 'no arrivals';
    const skip = d.skipped ? ` SKIPPED (>${MAX_FLARM_DIST_KM}km)` : '';
    return `${arr}${skip}; accepted=${d.accepted}, stale=${d.stale}, late=${d.late}, dup=${d.duplicates}, pairs=${d.drainedPairs}, recorded=${d.crossingsRecorded}`;
}

function normaliseFlarmIds(s: Set<FlarmID> | undefined): Set<FlarmID> {
    if (!s) return new Set();
    const out = new Set<FlarmID>();
    for (const id of s) {
        const t = id.trim();
        if (t) out.add(t as FlarmID);
    }
    return out;
}

function pushCrossing(map: CrossingMap, f: FlarmID, t: Epoch): void {
    const arr = map.get(f);
    if (arr) arr.push(t);
    else map.set(f, [t]);
}

// tracker.trackerid may carry comma-separated backup units. Split into a
// normalised set; drop the sentinel/blank values.
function parseAssignedIds(raw: string): Set<FlarmID> {
    const out = new Set<FlarmID>();
    if (!raw) return out;
    for (const part of raw.split(',')) {
        const id = part.trim();
        if (!id) continue;
        const lc = id.toLowerCase();
        if (lc === 'unknown' || lc === 'blocked') continue;
        out.add(id as FlarmID);
    }
    return out;
}

function bestPair(sList: Epoch[], fList: Epoch[], startUtc: Epoch, finishUtc: Epoch): {ds: number; df: number; score: number} {
    let bestDS = 0,
        bestDF = 0,
        bestScore = Infinity;
    for (const sC of sList) {
        const ds = sC - startUtc;
        for (const fC of fList) {
            const dF = fC - finishUtc;
            const score = Math.max(Math.abs(ds), Math.abs(dF));
            if (score < bestScore) {
                bestScore = score;
                bestDS = ds;
                bestDF = dF;
            }
        }
    }
    return {ds: bestDS, df: bestDF, score: bestScore};
}

function matchCrossings(results: OfficialResult[], startScan: ScanResult, finishScan: ScanResult, tolerance: number): TrackerMatch[] {
    const startCrossings = startScan.crossings;
    const finishCrossings = finishScan.crossings;
    const flarmidsWithBoth: FlarmID[] = [];
    for (const f of startCrossings.keys()) {
        if (finishCrossings.has(f)) flarmidsWithBoth.push(f);
    }

    // Phase 1 — for each pilot, every flarmid that crosses both lines within
    // tolerance of that pilot's official times. These are the candidates we
    // already report.
    const perPilot = new Map<Compno, TrackerMatch[]>();
    const perFlarm = new Map<FlarmID, TrackerMatch[]>();

    for (const r of results) {
        const assignedIds = parseAssignedIds(r.trackerid);
        for (const f of flarmidsWithBoth) {
            const {ds, df, score} = bestPair(startCrossings.get(f)!, finishCrossings.get(f)!, r.startUtc, r.finishUtc);
            if (score <= tolerance) {
                const m: TrackerMatch = {
                    compno: r.compno,
                    name: r.name,
                    flarmid: f,
                    deltaStart: ds,
                    deltaFinish: df,
                    confidence: score,
                    currentTrackerid: r.trackerid,
                    assigned: assignedIds.has(f),
                    withinTolerance: true,
                    ambiguous: false,
                    skipped: false
                };
                listAppend(perPilot, r.compno, m);
                listAppend(perFlarm, f, m);
            }
        }
    }

    // Ambiguity is only meaningful for within-tolerance candidates.
    for (const arr of perPilot.values()) if (arr.length > 1) arr.forEach((m) => (m.ambiguous = true));
    for (const arr of perFlarm.values()) if (arr.length > 1) arr.forEach((m) => (m.ambiguous = true));

    // Phase 2 — for every pilot with a recorded trackerid, ensure there's a
    // row for each assigned id even if it falls outside tolerance (or has no
    // crossings at all). Lets the operator spot a bad assignment: the row
    // shows the actual delta the assigned id achieves, however large.
    for (const r of results) {
        const assignedIds = parseAssignedIds(r.trackerid);
        if (!assignedIds.size) continue;
        const existing = perPilot.get(r.compno);
        const existingIds = new Set(existing?.map((m) => m.flarmid) ?? []);
        for (const id of assignedIds) {
            if (existingIds.has(id)) continue; // already covered by phase 1
            const sList = startCrossings.get(id);
            const fList = finishCrossings.get(id);
            const wasSkipped = startScan.skipped.has(id) || finishScan.skipped.has(id);
            let row: TrackerMatch;
            if (sList?.length && fList?.length) {
                const {ds, df, score} = bestPair(sList, fList, r.startUtc, r.finishUtc);
                row = {
                    compno: r.compno,
                    name: r.name,
                    flarmid: id,
                    deltaStart: ds,
                    deltaFinish: df,
                    confidence: score,
                    currentTrackerid: r.trackerid,
                    assigned: true,
                    withinTolerance: false,
                    ambiguous: false,
                    skipped: false
                };
            } else {
                // No usable crossings for the assigned id — could be skipped
                // by the geographic gate (id was active but never near the
                // task), tracker off, or out of coverage.
                row = {
                    compno: r.compno,
                    name: r.name,
                    flarmid: id,
                    deltaStart: null,
                    deltaFinish: null,
                    confidence: null,
                    currentTrackerid: r.trackerid,
                    assigned: true,
                    withinTolerance: false,
                    ambiguous: false,
                    skipped: wasSkipped
                };
            }
            listAppend(perPilot, r.compno, row);
        }
    }

    // Flatten. perFlarm only held phase-1 rows, but every row also lives in
    // perPilot, so iterating perPilot covers everything.
    const out: TrackerMatch[] = [];
    for (const arr of perPilot.values()) for (const m of arr) out.push(m);
    out.sort((a, b) => {
        // group by compno; within a pilot put assigned-and-withinTolerance
        // first, then other within-tolerance, then assigned-outside-tolerance.
        const c = a.compno.localeCompare(b.compno);
        if (c !== 0) return c;
        const aRank = (a.assigned && a.withinTolerance ? 0 : 0) + (a.withinTolerance ? 0 : 2) + (a.assigned ? 0 : 1);
        const bRank = (b.assigned && b.withinTolerance ? 0 : 0) + (b.withinTolerance ? 0 : 2) + (b.assigned ? 0 : 1);
        if (aRank !== bRank) return aRank - bRank;
        const ac = a.confidence ?? Infinity;
        const bc = b.confidence ?? Infinity;
        return ac - bc;
    });
    return out;
}

// Group pilots whose (startUtc, finishUtc) are pairwise within 2×tolerance
// on BOTH axes. Union-find over the "could-not-be-distinguished" relation;
// returns groups of size ≥ 2.
function findConcurrentPilots(results: OfficialResult[], tolerance: number): OfficialResult[][] {
    const n = results.length;
    if (n < 2) return [];
    const parent = Array.from({length: n}, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const limit = 2 * tolerance;
    for (let i = 0; i < n; i++) {
        const a = results[i];
        for (let j = i + 1; j < n; j++) {
            const b = results[j];
            if (Math.abs(a.startUtc - b.startUtc) <= limit && Math.abs(a.finishUtc - b.finishUtc) <= limit) {
                parent[find(i)] = find(j);
            }
        }
    }
    const groups = new Map<number, OfficialResult[]>();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        const arr = groups.get(root);
        if (arr) arr.push(results[i]);
        else groups.set(root, [results[i]]);
    }
    return Array.from(groups.values()).filter((g) => g.length > 1);
}

function listAppend<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const arr = map.get(key);
    if (arr) arr.push(value);
    else map.set(key, [value]);
}
