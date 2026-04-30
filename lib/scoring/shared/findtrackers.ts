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
const MAX_GAP_SEC = 60; // don't run hasCrossed across a coverage gap
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
    deltaStart: number; // seconds, signed (flarm crossing - official)
    deltaFinish: number;
    confidence: number; // max(|deltaStart|, |deltaFinish|), lower is better
    currentTrackerid: string;
    ambiguous: boolean; // >1 candidate per pilot OR >1 pilot per flarmid
}

export interface FindTrackersOptions {
    task: Task; // already calculateTask'd (preparedLegs populated)
    results: OfficialResult[];
    toleranceSec?: number;
    excludeFlarmids?: Set<FlarmID>;
    log?: (msg: string) => void;
}

type CrossingMap = Map<FlarmID, Epoch[]>;

export async function findTrackerMatches(opts: FindTrackersOptions): Promise<TrackerMatch[]> {
    const {task, results} = opts;
    const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
    const excludeFlarmids = opts.excludeFlarmids ?? new Set<FlarmID>();
    const log = opts.log ?? (() => {});

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

    log(`start scan: window ${Math.round((maxStart - minStart) / 60 + (2 * slack) / 60)} min, ${results.length} pilots`);
    const startCrossings = await scanLine(startTP, minStart - slack, maxStart + slack, 'start', excludeFlarmids, log);

    log(`finish scan: window ${Math.round((maxFinish - minFinish) / 60 + (2 * slack) / 60)} min`);
    const finishCrossings = await scanLine(finishTP, minFinish - slack, maxFinish + slack, 'finish', excludeFlarmids, log);

    return matchCrossings(results, startCrossings, finishCrossings, tolerance);
}

async function scanLine(
    tp: PreparedTurnpoint, //
    since: number,
    until: number,
    kind: 'start' | 'finish',
    excludeFlarmids: Set<FlarmID>,
    log: (msg: string) => void
): Promise<CrossingMap> {
    const center: BasePositionMessage = {lat: tp.leg.nlat, lng: tp.leg.nlng, a: 0 as AltitudeAMSL, t: 0 as Epoch};
    const prevByFlarm = new Map<FlarmID, BasePositionMessage>();
    const skip = new Set<FlarmID>();
    const crossings: CrossingMap = new Map();

    for await (const msg of loadPointsForIds({since, until})) {
        const f = msg.f;
        if (excludeFlarmids.has(f) || skip.has(f)) continue;
        const pos: BasePositionMessage = {lat: msg.lat, lng: msg.lng, a: msg.a, t: msg.t};
        const prev = prevByFlarm.get(f);
        if (prev === undefined) {
            // First sighting of this flarmid in this scan: geographic gate.
            const dist = PreparedTurnpoint.geodesicDistance(center, pos);
            if (dist > MAX_FLARM_DIST_KM) {
                skip.add(f);
                continue;
            }
            prevByFlarm.set(f, pos);
            continue;
        }
        // APRS log isn't strictly ordered per-flarmid (relay paths, dedupe
        // happens further upstream). Drop anything not strictly newer than
        // prev — running hasCrossed on a backwards segment would invent
        // crossings and corrupt prev.
        if (pos.t <= prev.t) continue;
        if (pos.t - prev.t <= MAX_GAP_SEC) {
            const hc = tp.hasCrossed(prev, pos);
            if (kind === 'start') {
                // Strict start crossing — same rule as taskpositiongenerator.ts:245
                if (hc.everInside && !hc.finalInside && hc.crossings.length) {
                    pushCrossing(crossings, f, hc.crossings[hc.crossings.length - 1].at.t);
                }
            } else {
                // Finish — sector-entry / line-cross, first crossing wins
                if (hc.crossings.length) {
                    pushCrossing(crossings, f, hc.crossings[0].at.t);
                }
            }
        }
        prevByFlarm.set(f, pos);
    }

    log(`  → ${prevByFlarm.size} tracked, ${skip.size} skipped (>${MAX_FLARM_DIST_KM} km), ${crossings.size} with ${kind} crossings`);
    return crossings;
}

function pushCrossing(map: CrossingMap, f: FlarmID, t: Epoch): void {
    const arr = map.get(f);
    if (arr) arr.push(t);
    else map.set(f, [t]);
}

function matchCrossings(results: OfficialResult[], startCrossings: CrossingMap, finishCrossings: CrossingMap, tolerance: number): TrackerMatch[] {
    const flarmidsWithBoth: FlarmID[] = [];
    for (const f of startCrossings.keys()) {
        if (finishCrossings.has(f)) flarmidsWithBoth.push(f);
    }
    if (!flarmidsWithBoth.length) return [];

    const perPilot = new Map<Compno, TrackerMatch[]>();
    const perFlarm = new Map<FlarmID, TrackerMatch[]>();

    for (const r of results) {
        for (const f of flarmidsWithBoth) {
            const sList = startCrossings.get(f)!;
            const fList = finishCrossings.get(f)!;
            let bestDS = 0,
                bestDF = 0,
                bestScore = Infinity;
            for (const sC of sList) {
                const ds = sC - r.startUtc;
                if (Math.abs(ds) > tolerance) continue; // can't beat tolerance even on its own
                for (const fC of fList) {
                    const dF = fC - r.finishUtc;
                    const score = Math.max(Math.abs(ds), Math.abs(dF));
                    if (score < bestScore) {
                        bestScore = score;
                        bestDS = ds;
                        bestDF = dF;
                    }
                }
            }
            if (bestScore <= tolerance) {
                const m: TrackerMatch = {
                    compno: r.compno,
                    name: r.name,
                    flarmid: f,
                    deltaStart: bestDS,
                    deltaFinish: bestDF,
                    confidence: bestScore,
                    currentTrackerid: r.trackerid,
                    ambiguous: false
                };
                listAppend(perPilot, r.compno, m);
                listAppend(perFlarm, f, m);
            }
        }
    }

    for (const arr of perPilot.values()) if (arr.length > 1) arr.forEach((m) => (m.ambiguous = true));
    for (const arr of perFlarm.values()) if (arr.length > 1) arr.forEach((m) => (m.ambiguous = true));

    // Each match was inserted into perPilot AND perFlarm. Flatten via Set
    // to dedup, then sort by compno then confidence.
    const out = new Set<TrackerMatch>();
    for (const arr of perPilot.values()) for (const m of arr) out.add(m);
    return Array.from(out).sort((a, b) => a.compno.localeCompare(b.compno) || a.confidence - b.confidence);
}

function listAppend<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const arr = map.get(key);
    if (arr) arr.push(value);
    else map.set(key, [value]);
}
