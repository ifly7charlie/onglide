// Two-phase path similarity check for findtrackers.
//
// When two FlarmIDs both match the same pilot's crossing times, compare their
// full track shapes to determine whether they're the same physical flight (two
// trackers in the same aircraft) or genuinely different flights. Builds on the
// compareShapes / loadStream machinery in lib/flightprocessing/trackshape.ts.
//
// Phase 1 (quick): compare only the pre-start segment. If that's solidly
// "different_flight" the full comparison is skipped — cheap early abort.
// Phase 2 (full): compare the entire flying window.

import type {Compno, FlarmID} from '../../types';
import {compareShapes, loadStream, type ShapeReport, type PointStream, type ShapePoint, type ShapeClassificationKind} from '../../flightprocessing/trackshape';

export type SameFlightKind = 'same_flight' | 'different_flight' | 'insufficient_data';

export interface PathSimilarityResult {
    flarmidA: FlarmID;
    flarmidB: FlarmID;
    kind: SameFlightKind;
    /** Pre-start comparison, null if the slice had < MIN_QUICK_OVERLAP_SEC of data. */
    quickReport: ShapeReport | null;
    /** Full-window comparison, null if aborted after a quick mismatch. */
    fullReport: ShapeReport | null;
    abortedAfterQuick: boolean;
}

// Minimum overlap (seconds) for the quick pre-start slice to be worth comparing.
const MIN_QUICK_OVERLAP_SEC = 120;
// Lag search half-width (seconds). 120s covers clock skew between units and
// any intentional competition anti-cheat delay; same as trackshape's floor.
const DEFAULT_LAG_HALFWIDTH = 120;

export function sliceStream(stream: PointStream, fromT: number, toT: number): PointStream {
    return {id: stream.id, points: stream.points.filter((p: ShapePoint) => p.t >= fromT && p.t <= toT)};
}

export function classifyKind(kind: ShapeClassificationKind): SameFlightKind {
    switch (kind) {
        case 'matching':
        case 'consistent_offset':
            return 'same_flight';
        case 'very_different':
        case 'diverged_abrupt':
        case 'diverged_slow':
        case 'alignment_failed':
            return 'different_flight';
        default:
            return 'insufficient_data';
    }
}

// Returns the span in seconds of a stream's points (0 if fewer than 2 points).
function streamSpanSec(stream: PointStream): number {
    const pts = stream.points;
    return pts.length < 2 ? 0 : pts[pts.length - 1].t - pts[0].t;
}

/**
 * Compare two FlarmID tracks over [since, until] to determine whether they
 * represent the same flight.
 *
 * If `quickUntil` is provided and both pre-`quickUntil` slices have enough
 * data, a quick pre-start comparison is run first. A clear "different_flight"
 * at this stage aborts early without loading the full window.
 */
export async function runPathComparison(
    flarmidA: FlarmID,
    flarmidB: FlarmID,
    since: number,
    until: number,
    quickUntil?: number,
    lagHalfWidth?: number
): Promise<PathSimilarityResult> {
    const hw = lagHalfWidth ?? DEFAULT_LAG_HALFWIDTH;

    const [streamA, streamB] = await Promise.all([loadStream(String(flarmidA), since, until), loadStream(String(flarmidB), since, until)]);

    if (!streamA.points.length || !streamB.points.length) {
        return {flarmidA, flarmidB, kind: 'insufficient_data', quickReport: null, fullReport: null, abortedAfterQuick: false};
    }

    let quickReport: ShapeReport | null = null;
    if (quickUntil !== undefined) {
        const sliceA = sliceStream(streamA, since, quickUntil);
        const sliceB = sliceStream(streamB, since, quickUntil);
        if (streamSpanSec(sliceA) >= MIN_QUICK_OVERLAP_SEC && streamSpanSec(sliceB) >= MIN_QUICK_OVERLAP_SEC) {
            quickReport = compareShapes(sliceA, sliceB, {lagSearchHalfWidth: hw});
            if (classifyKind(quickReport.classification.kind) === 'different_flight') {
                return {flarmidA, flarmidB, kind: 'different_flight', quickReport, fullReport: null, abortedAfterQuick: true};
            }
        }
    }

    const fullReport = compareShapes(streamA, streamB, {lagSearchHalfWidth: hw});
    return {flarmidA, flarmidB, kind: classifyKind(fullReport.classification.kind), quickReport, fullReport, abortedAfterQuick: false};
}

// ---- Prior evidence & decision policy ----

// Counts of how many prior task days classified a given (compno, pair) each way.
export interface PathPrior {
    sameFlightDays: number;
    differentFlightDays: number;
}
// Keyed by pathPriorKey(compno, a, b).
export type PathPriorMap = Map<string, PathPrior>;

// Canonical key for a (compno, flarmid_a, flarmid_b) pair. Sorts the two
// flarmids so (A,B) and (B,A) always map to the same key — matches the
// canonical ordering used by the trackerhistory_paths UNIQUE KEY.
export function pathPriorKey(compno: Compno, fa: FlarmID, fb: FlarmID): string {
    const [a, b] = [String(fa), String(fb)].sort();
    return `${String(compno)}|${a}|${b}`;
}

// A same-day same_flight is auto-joined UNLESS prior history is strongly
// contradictory: this many prior days classified the pair different_flight
// with zero same_flight days. In that case today's match is downgraded to a
// manual-review flag rather than auto-joined.
const PRIOR_VETO_MIN_DIFFERENT_DAYS = 2;

export interface SameFlightDecision {
    // join: lift the demotion and merge both IDs.
    // flag: today says same_flight but prior history vetoes the auto-join —
    //       surface for manual review, leave the demotion in place.
    // none: not a same_flight result; nothing to do.
    action: 'join' | 'flag' | 'none';
    // True when prior history downgraded a same_flight into a flag.
    priorVetoed: boolean;
    prior?: PathPrior;
}

export function resolveSameFlight(sim: PathSimilarityResult, prior?: PathPrior): SameFlightDecision {
    if (sim.kind !== 'same_flight') return {action: 'none', priorVetoed: false, prior};
    if (prior && prior.sameFlightDays === 0 && prior.differentFlightDays >= PRIOR_VETO_MIN_DIFFERENT_DAYS) {
        return {action: 'flag', priorVetoed: true, prior};
    }
    return {action: 'join', priorVetoed: false, prior};
}

// ---- Display ----

function fmtOverlapSec(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

// Render the PATH SIMILARITY report block as indented lines for the CLI to
// print verbatim. Pure — no console I/O. `decision` carries the resolved
// action and prior counts so this needs no further lookups.
export function formatPathSimilarity(sim: PathSimilarityResult, decision: SameFlightDecision): string[] {
    const {flarmidA, flarmidB, kind, quickReport, fullReport, abortedAfterQuick} = sim;
    const report = fullReport ?? quickReport;
    const prior = decision.prior;
    const priorLine = prior ? `prior: ${prior.sameFlightDays}d same, ${prior.differentFlightDays}d different` : null;

    const out: string[] = [`       PATH SIMILARITY (${flarmidA} vs ${flarmidB}):`];
    if (!report) {
        out.push(`         insufficient data — no track for one or both FlarmIDs`);
        if (priorLine) out.push(`         ${priorLine}`);
        return out;
    }
    const kindLabel = kind === 'same_flight' ? '✓ same_flight' : kind === 'different_flight' ? '✗ different_flight' : '? insufficient_data';
    const abortedTag = abortedAfterQuick ? ' (aborted after pre-start check)' : quickReport ? ' (pre-start check passed)' : '';
    out.push(`         ${kindLabel} — ${report.classification.summary}${abortedTag}`);
    if (report.overlapSec > 0) {
        const lagStr = report.lag.lag !== 0 ? ` lag ${report.lag.lag >= 0 ? '+' : ''}${report.lag.lag}s` : '';
        out.push(
            `         overlap ${fmtOverlapSec(report.overlapSec)}  Δpos p50 ${report.deltaPosP50Km.toFixed(3)} km  p95 ${report.deltaPosP95Km.toFixed(3)} km  Δalt bias ${report.altBiasM >= 0 ? '+' : ''}${report.altBiasM.toFixed(0)} m  p95 ${report.altDevP95M.toFixed(0)} m${lagStr}`
        );
    }
    if (priorLine) out.push(`         ${priorLine}`);
    if (decision.action === 'join') {
        out.push(`         → join: both IDs will be included in the tracker assignment`);
    } else if (decision.action === 'flag') {
        out.push(`         ⚑ FLAGGED: today matches but ${prior!.differentFlightDays} prior day${prior!.differentFlightDays === 1 ? '' : 's'} said different — NOT auto-joined, review manually`);
    } else if (kind === 'different_flight') {
        out.push(`         → demotion stands: these are different flights`);
    }
    return out;
}
