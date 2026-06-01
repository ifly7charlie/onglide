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

// 24-bit fid of a StreamId as the 6-hex FlarmID. findtrackers operates at
// device identity (one flarmid → one pilot); the src byte is for upstream
// fusion, not for matching, so we mask it off before joining against the
// FlarmID-keyed state maps.
function fidHex(streamId: number): FlarmID {
    return (streamId & 0xffffff)
        .toString(16)
        .toUpperCase()
        .padStart(6, '0') as FlarmID;
}
import {Bbox, taskBbox, expandBbox, pointInBbox} from '../../flightprocessing/taskBbox';

import {MAX_FLARM_DIST_KM, DEFAULT_MAX_GAP_SEC, DEFAULT_REORDER_WINDOW_SEC, DEFAULT_TOLERANCE_SEC} from '../../constants';

/**
 * Pilot's official scoring entry for one (class, datecode). `finishUtc`
 * is null for landout pilots (started but did not complete the task —
 * scorer didn't record a finish time). They still participate in the
 * scan so we can recognise their flarmid via the start crossing alone.
 * Distinct from DNF / DNS in the codebase, which mean "did not fly" /
 * "did not start" — those don't appear in OfficialResult at all.
 */
export interface OfficialResult {
    compno: Compno;
    name: string;
    trackerid: string; // current value in tracker.trackerid (or '')
    startUtc: Epoch;
    finishUtc: Epoch | null; // null for landout pilots (no recorded finish time)
    glidertype: string; // pilots.glidertype, '' when unset; used for the weak DDB aircraft_model match
    // Identity facets for cross-comp evidence (collection + scoring). Defaults
    // ('' / 0) when unset; the identity layer treats those as absent.
    homeclub: string; // pilots.homeclub
    country: string; // pilots.country (2-letter), '' when unset
    fai: number; // pilots.fai (0/synthetic when unresolved)
    greg: string; // pilots.greg (ICAO registration), '' when unset
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
    /**
     * True when:
     *   (a) >1 within-tolerance candidate flarmid for this pilot, OR
     *   (b) this flarmid is within tolerance of >1 pilot, OR
     *   (c) the pilot is in a "concurrent" group — ≥2 pilots whose start
     *       AND finish times are pairwise within ±2×tolerance, so any match
     *       is structurally indistinguishable from another pilot's.
     * Pilots with any ambiguous row should be skipped from automatic
     * proposals — the diagnosis is unsafe.
     */
    ambiguous: boolean;
    /**
     * For assigned-tracker rows only: the flarmid was geographically gated
     * out (first sighting >MAX_FLARM_DIST_KM from the start and/or finish
     * TP), so it never produced crossings — strong signal that the recorded
     * id is wrong, or the pilot wasn't actually flying this comp.
     */
    skipped: boolean;
    /**
     * For assigned-tracker rows only: the flarmid was active during the
     * scan window but every packet was rejected by the task bbox prefilter
     * — i.e. the tracker was flying somewhere else entirely. Stronger
     * "wrong tracker" signal than `skipped`.
     */
    bboxOnly: boolean;
    /**
     * Per-row diagnostic info populated for assigned-tracker rows that the
     * caller may decide to remove (assigned=true, withinTolerance=false).
     * Tells the operator whether the tracker was seen at all, how good
     * the track was, and how close it got to the task.
     */
    diag?: TrackerDiag;
}

/**
 * Combined stats for one flarmid across both the start and finish scans,
 * plus per-pilot context computed from the pilot's official times. Times
 * and gaps are unsigned seconds.
 */
export interface TrackerDiag {
    /** Packets that passed the task-bbox prefilter, summed across scans. */
    inBboxPackets: number;
    /** Packets dropped by the bbox prefilter, summed across scans. */
    bboxRejectedPackets: number;
    /** Min closest-approach (km) of any consecutive-pair segment to the start/finish line or sector boundary, across both scans. null if no in-bbox packets or no consecutive pair survived the gap filter. */
    minDistanceKm: number | null;
    /** Mean interval (s) between consecutive in-bbox packets, across both scans. null if <2 in-bbox packets total. */
    avgGapSec: number | null;
    /** Largest interval (s) between consecutive in-bbox packets. null if <2 in-bbox packets total. */
    maxGapSec: number | null;
    /** Earliest packet observed (any source: bbox-rejected or accepted). null if never seen. */
    firstSeenT: Epoch | null;
    /** Latest packet observed (any source). null if never seen. */
    lastSeenT: Epoch | null;
    /** Gap (s) between the in-bbox packets bracketing the pilot's official start time. null if start time is outside the in-bbox packet range, or <2 in-bbox start-scan packets. */
    gapAroundStartSec: number | null;
    /** Same, around the pilot's official finish time, using finish-scan packets. */
    gapAroundFinishSec: number | null;
    /** Closest approach (km) to the start line/sector among the segments touching the two in-bbox packets bracketing the pilot's official start time. null when gapAroundStartSec is null or both bracketing samples lack a segment-distance reading. */
    distAtStartKm: number | null;
    /** Same, around the pilot's official finish time, against the finish geometry. */
    distAtFinishKm: number | null;
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

    // Same expansion margin we use for the live aprsc filter and the worker
    // prefilter — keeps log points from neighbouring comps out of this scan
    // entirely, so they don't clutter the per-flarmid `state` map or the
    // pair-drain trace. taskBbox unions every leg's sector so AAT-style
    // tasks aren't clipped. Null bbox (degenerate task) → no filter.
    const rawBbox = taskBbox(task);
    const expandedBbox: Bbox | null = rawBbox ? expandBbox(rawBbox, 10) : null;

    const slack = Math.max(60, tolerance + 5);
    let minStart = Infinity,
        maxStart = -Infinity,
        minFinish = Infinity,
        maxFinish = -Infinity;
    for (const r of results) {
        if (r.startUtc < minStart) minStart = r.startUtc;
        if (r.startUtc > maxStart) maxStart = r.startUtc;
        if (r.finishUtc !== null) {
            if (r.finishUtc < minFinish) minFinish = r.finishUtc;
            if (r.finishUtc > maxFinish) maxFinish = r.finishUtc;
        }
    }
    // If no pilot finished, fall back to the start-window's outer edge so
    // the finish scan still runs over a reasonable interval — most landout
    // days still have some traffic worth surveying for ghost finishes.
    if (!Number.isFinite(minFinish)) {
        minFinish = maxStart;
        maxFinish = maxStart;
    }

    // Pilots whose official start AND finish are both within 2×tolerance of
    // each other can't be told apart on times alone — any flarmid matching
    // one will match the others within tolerance. Surface those groups up
    // front so the operator knows the ambiguity flags downstream are
    // structural, not a tracker-quality issue.
    const concurrentGroups = findConcurrentPilots(results, tolerance);
    const concurrentCompnos = new Set<Compno>();
    for (const group of concurrentGroups) {
        const labels = group.map((r) => String(r.compno)).join(', ');
        log(`⚠ ${group.length} pilots have identical official times (within ±${tolerance}s on start and finish) — matches will be ambiguous: ${labels}`);
        for (const r of group) concurrentCompnos.add(r.compno);
    }

    // Watch times for the debug trace: each pilot's official start (resp.
    // finish), labelled so the trace marker tells you which pilot.
    const labelOf = (r: OfficialResult) => String(r.compno);
    const startWatch: WatchTime[] = results.map((r) => ({t: r.startUtc, label: labelOf(r)})).sort((a, b) => a.t - b.t);
    const finishWatch: WatchTime[] = results //
        .filter((r): r is OfficialResult & {finishUtc: Epoch} => r.finishUtc !== null)
        .map((r) => ({t: r.finishUtc, label: labelOf(r)}))
        .sort((a, b) => a.t - b.t);

    log(`start scan: window ${Math.round((maxStart - minStart) / 60 + (2 * slack) / 60)} min, ${results.length} pilots, maxGap=${maxGapSec}s, reorderWindow=${reorderWindowSec}s${expandedBbox ? ', bbox prefilter on' : ''}`);
    const startScan = await scanLine(startTP, minStart - slack, maxStart + slack, 'start', excludeFlarmids, log, debugFlarmids, startWatch, maxGapSec, reorderWindowSec, expandedBbox);

    log(`finish scan: window ${Math.round((maxFinish - minFinish) / 60 + (2 * slack) / 60)} min`);
    const finishScan = await scanLine(finishTP, minFinish - slack, maxFinish + slack, 'finish', excludeFlarmids, log, debugFlarmids, finishWatch, maxGapSec, reorderWindowSec, expandedBbox);

    return matchCrossings(results, startScan, finishScan, tolerance, concurrentCompnos);
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
    bboxOnly: Set<FlarmID>; // had bbox-rejected packets and never made it past the bbox
    stats: Map<FlarmID, FlarmStatsAcc>;
}

interface SampleRow extends BasePositionMessage {
    /** Min boundary distance (km) over the consecutive-pair segments touching this fix; Infinity until the post-scan pass fills it in. */
    lineKm: number;
}

interface FlarmStatsAcc {
    bboxRejected: number;
    inBbox: number;
    minDistanceKm: number; // closest approach (km) of any consecutive-pair segment to the line/sector boundary; Infinity until populated by the post-scan pass
    firstSeenT: number; // -1 until any packet seen
    lastSeenT: number;
    samples: SampleRow[]; // in-bbox packets sorted ascending by t at end-of-scan; lineKm filled in by post-scan pass
    sumGapSec: number;
    countGap: number;
    maxGapSec: number;
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
    reorderWindowSec: number,
    bbox: Bbox | null
): Promise<ScanResult> {
    const center: BasePositionMessage = {lat: tp.leg.nlat, lng: tp.leg.nlng, a: 0 as AltitudeAMSL, t: 0 as Epoch};
    const state = new Map<FlarmID, FlarmState>();
    const crossings: CrossingMap = new Map();
    const bboxRejectedFor = new Set<FlarmID>(); // flarmids that had ≥1 bbox-rejected packet
    const stats = new Map<FlarmID, FlarmStatsAcc>();
    const getStats = (f: FlarmID): FlarmStatsAcc => {
        let s = stats.get(f);
        if (!s) {
            s = {bboxRejected: 0, inBbox: 0, minDistanceKm: Infinity, firstSeenT: -1, lastSeenT: -1, samples: [], sumGapSec: 0, countGap: 0, maxGapSec: 0};
            stats.set(f, s);
        }
        return s;
    };
    let lateDropped = 0;
    let staleDropped = 0;
    let bboxDropped = 0;

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
        const f = fidHex(msg.f);
        if (excludeFlarmids.has(f)) continue;
        const sStats = getStats(f);
        if (sStats.firstSeenT < 0 || msg.t < sStats.firstSeenT) sStats.firstSeenT = msg.t;
        if (msg.t > sStats.lastSeenT) sStats.lastSeenT = msg.t;
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
        // Per-comp bbox prefilter. Drops points from flarmids that happen to
        // be in the time window but flying a different comp's task in the
        // same region. Applied before any per-flarmid state is created so
        // a flarmid that's entirely outside the bbox never enters `state`.
        // The 10 km expansion is the same margin used by the live aprsc
        // filter and the worker prefilter — wide enough that genuine
        // approach paths from outside the strict bbox still survive.
        if (bbox && !pointInBbox(bbox, msg.lat, msg.lng)) {
            bboxDropped++;
            bboxRejectedFor.add(f);
            sStats.bboxRejected++;
            continue;
        }
        const pos: BasePositionMessage = {lat: msg.lat, lng: msg.lng, a: msg.a, t: msg.t};
        // Centroid distance is used only for the first-sighting 150 km gate
        // (a sanity filter against far-away ghost packets). Line/sector-aware
        // distance for diag and scoring is filled in by a post-scan pass that
        // re-runs `hasCrossed` on consecutive pairs and reads its `distanceKm`.
        const centroidKm = PreparedTurnpoint.geodesicDistance(center, pos);
        sStats.inBbox++;
        sStats.samples.push({t: msg.t as Epoch, lat: msg.lat, lng: msg.lng, a: msg.a, lineKm: Infinity});
        let st = state.get(f);
        if (!st) {
            // First sighting in this scan: geographic gate.
            const d = dbgFor(f);
            if (d) {
                d.firstArrivalT = pos.t;
                d.firstArrivalDistKm = centroidKm;
            }
            if (centroidKm > MAX_FLARM_DIST_KM) {
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

    // bboxOnly = had bbox-rejected packets and never made it past the bbox
    // (i.e. the flarmid was active in this time window but every packet was
    // outside the task area). state.has(f) is true for any flarmid with at
    // least one bbox-passing packet, including geo-gated (skipped) ones.
    const bboxOnly = new Set<FlarmID>();
    for (const f of bboxRejectedFor) if (!state.has(f)) bboxOnly.add(f);

    // Finalize per-flarmid gap stats and line/sector distances. Packets are
    // pushed in observation order during scan, which is mostly time-
    // ascending modulo the small reorder window — sort once here so
    // consumers can binary-search.
    //
    // For each consecutive in-bbox pair we run hasCrossed and harvest the
    // no-cross distanceKm (line: perpendicular to the segment with endpoint
    // clamping; sector: closest boundary point). That distance is folded
    // into the per-flarmid running min (`minDistanceKm`) and into both
    // endpoints of the sample, so bracketDist returns the closest approach
    // in the neighbourhood of `target`.
    for (const s of stats.values()) {
        if (s.samples.length < 2) continue;
        s.samples.sort((a, b) => a.t - b.t);
        for (let i = 1; i < s.samples.length; i++) {
            const gap = s.samples[i].t - s.samples[i - 1].t;
            if (gap > 0) {
                s.sumGapSec += gap;
                s.countGap++;
                if (gap > s.maxGapSec) s.maxGapSec = gap;
            }
            if (gap > maxGapSec) continue; // matches drain's per-pair gate
            const hc = tp.hasCrossed(s.samples[i - 1], s.samples[i]);
            // Real crossing → segment passed through the line. Distance to
            // the line is 0 by definition. Near-miss (crossings empty +
            // distanceKm set) and no-cross both fall through to the
            // distanceKm path. Anything else (no distance reported) is
            // skipped.
            const d = hc.crossings.length > 0 && hc.distanceKm === undefined ? 0 : (hc.distanceKm as number | undefined);
            if (d === undefined) continue;
            if (d < s.samples[i].lineKm) s.samples[i].lineKm = d;
            if (d < s.samples[i - 1].lineKm) s.samples[i - 1].lineKm = d;
            if (d < s.minDistanceKm) s.minDistanceKm = d;
        }
    }

    log(
        `  → ${tracked} tracked, ${skipped.size} skipped (>${MAX_FLARM_DIST_KM} km), ${bboxDropped} out-of-bbox (${bboxOnly.size} flarmids never in-area), ${staleDropped} stale (self-reported d>${reorderWindowSec}s), ${lateDropped} late (>${reorderWindowSec}s out of order), ${crossings.size} with ${kind} crossings`
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
    return {crossings, skipped, bboxOnly, stats};
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

function buildDiag(flarmid: FlarmID, startScan: ScanResult, finishScan: ScanResult, startUtc: Epoch, finishUtc: Epoch | null): TrackerDiag {
    const sStart = startScan.stats.get(flarmid);
    const sFinish = finishScan.stats.get(flarmid);

    const inBboxPackets = (sStart?.inBbox ?? 0) + (sFinish?.inBbox ?? 0);
    const bboxRejectedPackets = (sStart?.bboxRejected ?? 0) + (sFinish?.bboxRejected ?? 0);

    let minDistanceKm: number | null = null;
    for (const s of [sStart, sFinish]) {
        if (s && Number.isFinite(s.minDistanceKm)) {
            minDistanceKm = minDistanceKm === null ? s.minDistanceKm : Math.min(minDistanceKm, s.minDistanceKm);
        }
    }

    let firstSeenT: Epoch | null = null;
    let lastSeenT: Epoch | null = null;
    for (const s of [sStart, sFinish]) {
        if (s && s.firstSeenT >= 0) {
            firstSeenT = firstSeenT === null ? (s.firstSeenT as Epoch) : ((Math.min(firstSeenT as number, s.firstSeenT) as number) as Epoch);
            lastSeenT = lastSeenT === null ? (s.lastSeenT as Epoch) : ((Math.max(lastSeenT as number, s.lastSeenT) as number) as Epoch);
        }
    }

    let totalSumGap = 0;
    let totalCountGap = 0;
    let totalMaxGap = 0;
    for (const s of [sStart, sFinish]) {
        if (!s) continue;
        totalSumGap += s.sumGapSec;
        totalCountGap += s.countGap;
        if (s.maxGapSec > totalMaxGap) totalMaxGap = s.maxGapSec;
    }
    const avgGapSec = totalCountGap > 0 ? totalSumGap / totalCountGap : null;
    const maxGapSec = totalCountGap > 0 ? totalMaxGap : null;

    return {
        inBboxPackets,
        bboxRejectedPackets,
        minDistanceKm,
        avgGapSec,
        maxGapSec,
        firstSeenT,
        lastSeenT,
        gapAroundStartSec: bracketGap(sStart?.samples ?? [], startUtc),
        gapAroundFinishSec: finishUtc === null ? null : bracketGap(sFinish?.samples ?? [], finishUtc),
        distAtStartKm: bracketDist(sStart?.samples ?? [], startUtc),
        distAtFinishKm: finishUtc === null ? null : bracketDist(sFinish?.samples ?? [], finishUtc)
    };
}

type Sample = {t: number; lineKm: number};

// Locate the consecutive sample pair [lo, lo+1] whose timestamps bracket
// `target`. Returns null if target is outside [first, last] or fewer than
// two samples exist. Shared by bracketGap / bracketDist so they agree on
// which two packets count as "bracketing".
function bracketIndex(samples: Sample[], target: number): number | null {
    if (samples.length < 2) return null;
    if (target < samples[0].t || target > samples[samples.length - 1].t) return null;
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (samples[mid].t <= target) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1 < samples.length ? lo : null;
}

// Largest interval (s) between consecutive samples that brackets `target`.
function bracketGap(samples: Sample[], target: number): number | null {
    const i = bracketIndex(samples, target);
    return i === null ? null : samples[i + 1].t - samples[i].t;
}

// Smaller of the two bracketing samples' line/sector distance (km). Picks
// the closer of the before/after points — tightest upper bound on how far
// the pilot was from the start/finish geometry at `target`.
function bracketDist(samples: Sample[], target: number): number | null {
    const i = bracketIndex(samples, target);
    if (i === null) return null;
    const d = Math.min(samples[i].lineKm, samples[i + 1].lineKm);
    return Number.isFinite(d) ? d : null;
}

// Smallest signed delta (crossing − target) across `list`. Used for
// single-sided phase-2 rows where only start or only finish fired.
function closestDelta(list: Epoch[], target: Epoch): number {
    let best = list[0] - target;
    for (let i = 1; i < list.length; i++) {
        const d = list[i] - target;
        if (Math.abs(d) < Math.abs(best)) best = d;
    }
    return best;
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

function matchCrossings(results: OfficialResult[], startScan: ScanResult, finishScan: ScanResult, tolerance: number, concurrentCompnos: Set<Compno>): TrackerMatch[] {
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
        // Landout pilots (no official finish time) can't produce a
        // both-sided match — Phase 1.5 picks them up via start-only.
        if (r.finishUtc === null) continue;
        const finishUtc = r.finishUtc;
        for (const f of flarmidsWithBoth) {
            const {ds, df, score} = bestPair(startCrossings.get(f)!, finishCrossings.get(f)!, r.startUtc, finishUtc);
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
                    skipped: false,
                    bboxOnly: false,
                    diag: buildDiag(f, startScan, finishScan, r.startUtc, finishUtc)
                };
                listAppend(perPilot, r.compno, m);
                listAppend(perFlarm, f, m);
            }
        }
    }

    // Ambiguity is only meaningful for within-tolerance candidates.
    // Computed BEFORE Phase 1.5 / Phase 2 so single-sided/assigned-only rows
    // don't artificially mark a clean two-sided match as ambiguous.
    for (const arr of perPilot.values()) if (arr.length > 1) arr.forEach((m) => (m.ambiguous = true));
    for (const arr of perFlarm.values()) if (arr.length > 1) arr.forEach((m) => (m.ambiguous = true));

    // Phase 1.5 — single-sided matches: flarmids that crossed only start
    // (or only finish) within tolerance of a pilot's official time. Surfaces
    // landed-out pilots (start-only) and pilots whose start was missed by
    // APRS coverage but who finished cleanly (finish-only).
    //
    // These rows carry withinTolerance=false: single-sided evidence is
    // genuinely weaker, and pair-flying makes one-sided ambiguity common,
    // so they're visible for operator review and scoring but don't bypass
    // the within-tolerance auto-apply gate. Phase 2 below skips ids
    // already present here, so assigned single-sided cases route through
    // this phase rather than getting a confidence=null Phase 2 row.
    const startOnlyFlarmids: FlarmID[] = [];
    const finishOnlyFlarmids: FlarmID[] = [];
    for (const f of startCrossings.keys()) if (!finishCrossings.has(f)) startOnlyFlarmids.push(f);
    for (const f of finishCrossings.keys()) if (!startCrossings.has(f)) finishOnlyFlarmids.push(f);
    for (const r of results) {
        const assignedIds = parseAssignedIds(r.trackerid);
        const existingIds = new Set((perPilot.get(r.compno) ?? []).map((m) => m.flarmid));
        // For landout pilots (finishUtc=null) we widen the start-side
        // candidate pool to *every* flarmid that crossed the start, not
        // just the single-sided ones. Phase 1 only runs for pilots with
        // an official finish, so a flarmid in `flarmidsWithBoth` (it
        // also produced a finish crossing for somebody else, or transited
        // the finish line later) would otherwise be invisible — even
        // when its start crossing matches this landout pilot's official
        // start cleanly.
        const startCandidates = r.finishUtc === null ? Array.from(startCrossings.keys()) : startOnlyFlarmids;
        for (const f of startCandidates) {
            if (existingIds.has(f)) continue;
            const ds = closestDelta(startCrossings.get(f)!, r.startUtc);
            if (Math.abs(ds) > tolerance) continue;
            const m: TrackerMatch = {
                compno: r.compno,
                name: r.name,
                flarmid: f,
                deltaStart: ds,
                deltaFinish: null,
                confidence: Math.abs(ds),
                currentTrackerid: r.trackerid,
                assigned: assignedIds.has(f),
                withinTolerance: false,
                ambiguous: false,
                skipped: false,
                bboxOnly: false,
                diag: buildDiag(f, startScan, finishScan, r.startUtc, r.finishUtc)
            };
            listAppend(perPilot, r.compno, m);
            listAppend(perFlarm, f, m);
        }
        // No finish-only candidates for landout pilots — there's no
        // official finish to anchor against.
        if (r.finishUtc === null) continue;
        const finishUtc = r.finishUtc;
        for (const f of finishOnlyFlarmids) {
            if (existingIds.has(f)) continue;
            const df = closestDelta(finishCrossings.get(f)!, finishUtc);
            if (Math.abs(df) > tolerance) continue;
            const m: TrackerMatch = {
                compno: r.compno,
                name: r.name,
                flarmid: f,
                deltaStart: null,
                deltaFinish: df,
                confidence: Math.abs(df),
                currentTrackerid: r.trackerid,
                assigned: assignedIds.has(f),
                withinTolerance: false,
                ambiguous: false,
                skipped: false,
                bboxOnly: false,
                diag: buildDiag(f, startScan, finishScan, r.startUtc, r.finishUtc)
            };
            listAppend(perPilot, r.compno, m);
            listAppend(perFlarm, f, m);
        }
    }

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
            const wasBboxOnly = startScan.bboxOnly.has(id) || finishScan.bboxOnly.has(id);
            let row: TrackerMatch;
            // Landout pilots can never produce a both-sided pair — fall
            // through to the single-sided branch with finish set to null.
            if (sList?.length && fList?.length && r.finishUtc !== null) {
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
                    skipped: false,
                    bboxOnly: false
                };
            } else if (sList?.length || fList?.length) {
                // One side crossed but not the other — common for landout
                // pilots (start only) or pilots that never started.
                // Surface the delta we do have so the operator can see the
                // assigned id's behaviour on the line that did fire;
                // confidence stays null because there's no paired score.
                const ds = sList?.length ? closestDelta(sList, r.startUtc) : null;
                const df = fList?.length && r.finishUtc !== null ? closestDelta(fList, r.finishUtc) : null;
                row = {
                    compno: r.compno,
                    name: r.name,
                    flarmid: id,
                    deltaStart: ds,
                    deltaFinish: df,
                    confidence: null,
                    currentTrackerid: r.trackerid,
                    assigned: true,
                    withinTolerance: false,
                    ambiguous: false,
                    skipped: false,
                    bboxOnly: false
                };
            } else {
                // No usable crossings for the assigned id. Three causes,
                // ranked by how strongly they say "wrong tracker":
                //   bboxOnly: had packets but every one was outside the
                //             task area — definitely the wrong glider.
                //   skipped:  packets in-area but first sighting >
                //             MAX_FLARM_DIST_KM from the start/finish TP.
                //   neither:  no APRS packets at all in the time window —
                //             tracker off, out of coverage, or wrong id.
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
                    skipped: wasSkipped,
                    bboxOnly: wasBboxOnly
                };
            }
            row.diag = buildDiag(id, startScan, finishScan, r.startUtc, r.finishUtc);
            listAppend(perPilot, r.compno, row);
        }
    }

    // Structural ambiguity: every row of any pilot in a concurrent-times
    // group is unsafe to act on, even if the row itself looks unique. The
    // pilots can't be told apart on times alone, so a single matching
    // flarmid might really belong to either of them.
    for (const c of concurrentCompnos) {
        const arr = perPilot.get(c);
        if (arr) for (const m of arr) m.ambiguous = true;
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
            // Landout pilots have null finishUtc — they can't be in a
            // structurally-concurrent group (no finish time to compare).
            if (a.finishUtc === null || b.finishUtc === null) continue;
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
