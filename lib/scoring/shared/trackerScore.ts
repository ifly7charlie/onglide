// Probabilistic scoring for flarmid↔pilot pair candidates. Pure functions:
// signal extraction, score combination, two-sided margin computation. No DB,
// no I/O. Persistence and assignment optimisation live elsewhere.
//
// Units: nats. Score = Σ wᵢ · sᵢ where positive signals sᵢ ∈ [0,1] use
// saturating support functions. Two unified negative signals (negStart, negFinish)
// take sᵢ ∈ [-1,0] — fired when the tracker is confirmed to NOT match this pilot's
// line crossing (wrong-time crossing or positionally absent with good coverage).
// `prior` carries start/finish evidence from earlier task days, capped per day
// and in total; whole-pair totals may also be driven negative by `contentionPenalty`.

import {
    DEFAULT_TOLERANCE_SEC,
    DEFAULT_DIST_TOLERANCE_KM,
    DEFAULT_GAP_MODULATION_SEC,
    DEFAULT_INBBOX_FULL_COUNT,
    DEFAULT_INBBOX_MIN_RATIO,
    WRONG_CROSS_SCALE,
    AMBIGUOUS_DELTA_FACTOR,
    MAX_PRIOR_PER_DAY_NATS,
    MAX_TOTAL_PRIOR_NATS,
    PRIOR_PROTECT_NATS,
    TRACKER_SCORE_WEIGHTS,
    OGN_CHECK_TIME_TOLERANCE_SEC,
    OGN_CHECK_NEG_ONSET_SEC,
    OGN_CHECK_NEG_SCALE,
    OGN_CHECK_DIST_ABS_KM,
    OGN_CHECK_DIST_REL,
    OGN_CHECK_CROSS_FACTOR,
    OGN_CHECK_CROSS_MATCH_FLOOR,
    OGN_CHECK_COVERAGE_GOOD_GAP_SEC,
    OGN_CHECK_COVERAGE_BAD_GAP_SEC
} from '../../constants';

export interface ScoreKnees {
    /** Δstart/Δfinish saturating knee in seconds. Beyond this, the time signal contributes 0. */
    timeToleranceSec: number;
    /** Distance-to-line knee in km. Distance signal × 0 at 2× this value. */
    distToleranceKm: number;
    /** Gap-modulation half-life. Distance signal × 1/(1 + gap/T_gap). */
    gapModulationSec: number;
    /** Saturation point for the in-bbox presence count. */
    inBboxFullCount: number;
    /** Minimum inBboxPackets / (inBboxPackets + bboxRejectedPackets) for a flarmid to be a candidate. Below this, presence weight is forced to 0. */
    inBboxMinRatio: number;
}

export const DEFAULT_KNEES: ScoreKnees = {
    timeToleranceSec: DEFAULT_TOLERANCE_SEC,
    distToleranceKm: DEFAULT_DIST_TOLERANCE_KM,
    gapModulationSec: DEFAULT_GAP_MODULATION_SEC,
    inBboxFullCount: DEFAULT_INBBOX_FULL_COUNT,
    inBboxMinRatio: DEFAULT_INBBOX_MIN_RATIO
};

export type ScoreWeights = typeof TRACKER_SCORE_WEIGHTS;
export const DEFAULT_WEIGHTS: ScoreWeights = TRACKER_SCORE_WEIGHTS;

/** Raw per-pair signals fed into the scorer. All numeric fields use null for "absent" — never 0 — so missingness never gets confused with a hit on the line. */
export interface Signals {
    /** Signed seconds, scan-crossing − official. null when no start crossing was recorded. */
    deltaStart: number | null;
    /** Signed seconds. null when no finish crossing. */
    deltaFinish: number | null;
    /** km, line/sector-aware closest approach of the bracketing segment. null when bracket not available. */
    distAtStartKm: number | null;
    /** Bracketing-segment seconds. null when bracket not available. */
    gapAroundStartSec: number | null;
    distAtFinishKm: number | null;
    gapAroundFinishSec: number | null;
    /** In-bbox packet count for this flarmid, summed across both scans. */
    inBboxPackets: number;
    /** Out-of-bbox packet count. Used together with inBboxPackets for the ratio. */
    bboxRejectedPackets: number;
    /** Earliest in-area sighting (epoch seconds), or null if never seen. */
    firstSeenT: number | null;
    /** Earliest official pilot start across the comp (epoch seconds), reference for the pre-launch sighting signal. */
    earliestPilotStartUtc: number;
    /** DDB match flags. CN: ddb.cn == pilot.compno. Glider: normalised ddb.aircraft_model == normalised pilot.glidertype (a weak corroborating signal that fires independently of CN). */
    ddbCnMatch: boolean;
    ddbGliderMatch: boolean;
    /** This flarmid is currently in the operator-set tracker.trackerid for the pilot. */
    baselineMatch: boolean;

    // ---- OGN-daemon score cross-check --------------------------------------
    // The daemon scored the flarmid's owning channel-pilot live; these fields
    // compare that scored triple (utcStart/utcFinish/actual.taskDistance)
    // against THIS pair's pilot's official result. All four are null when the
    // daemon was unreachable, had no score, or the flarmid has no daemon-scored
    // owner. Built by `ognSignalsFrom`.
    /** Signed seconds, daemon utcStart - official startUtc. null when grandprix common start (non-discriminating) or either side unset. KEPT on pev cylinder-start days, where it is the only per-pilot start evidence. */
    ognDeltaStart: number | null;
    /** Signed seconds, daemon utcFinish - official finishUtc. null unless BOTH sides have a finish (daemon may be mid-flight; official landouts have none). */
    ognDeltaFinish: number | null;
    /** Daemon actual.taskDistance, km (the /scores JSON route serves real units). */
    ognTaskDistKm: number | null;
    /** Official scored distance, km (pilotresult.distance). null when absent or <= 0. */
    officialDistKm: number | null;
    /** Mean in-bbox packet interval for this flarmid (TrackerDiag.avgGapSec) - whole-track coverage input for the ogn-check supports. null (no measurable track) -> coverage factor 0. */
    ognAvgGapSec: number | null;
    /** Pair is (B, F) where F's owning channel-pilot != B: cross-check evidence is positive-only and scaled by OGN_CHECK_CROSS_FACTOR / ognMatchCount. */
    ognIsCross?: boolean;
    /** k: how many pilots' official results the owning pilot's daemon triple matches (>= 1). Dilutes cross-pair positives; ignored on assigned pairs. */
    ognMatchCount?: number;
    /** Sum of per-day start/finish crossing scores for this (compno, flarmid) within the same comp, capped at ±MAX_TOTAL_PRIOR_NATS. Each day capped at ±MAX_PRIOR_PER_DAY_NATS; no decay applied. Carries no ddb/identity-derived evidence. */
    priorNats: number;

    /**
     * Cross-competition identity evidence, already collapsed to a single value
     * in nats by `xcEvidenceScore` (lib/scoring/shared/identity.ts): the
     * confidence-scaled, age-decayed identity match from the single best PRIOR
     * competition (the current comp is excluded). 0 when there's no qualifying
     * prior evidence. The per-facet detail is carried separately for display.
     */
    xcNats: number;

    /**
     * Match was flagged ambiguous by the scan (multiple within-tolerance
     * candidates or a concurrent-times group). Downgrades only the Δstart /
     * Δfinish supports by AMBIGUOUS_DELTA_FACTOR — a matching time is weaker
     * evidence when it matches several pilots.
     */
    ambiguous?: boolean;
}

export interface ScoreBreakdown {
    deltaStart: number;
    deltaFinish: number;
    distAtStart: number;
    distAtFinish: number;
    /** ≤0: unified negative evidence for start — wrong-time crossing OR confirmed positional absence, whichever is stronger, modulated by coverage quality. */
    negStart: number;
    /** ≤0: same for finish. */
    negFinish: number;
    inBbox: number;
    preLaunch: number;
    ddbCn: number;
    ddbGlider: number;
    baseline: number;
    /** Signed: weights.ognTime x daemon-vs-official start-time support. Positive within the wide knee; negative beyond the onset (assigned pairs only); 0 when suppressed by a within-tolerance replay crossing or zero coverage. */
    ognStart: number;
    /** Signed: same for the finish side. */
    ognFinish: number;
    /** >=0: weights.ognDist x daemon-vs-official task-distance agreement (never negative - optimiser/penalty differences must not demote). */
    ognDist: number;
    prior: number;
    xc: number; // weights.xc × xcNats — cross-comp identity, single value
    total: number;
}

const sat = (x: number) => Math.max(0, Math.min(1, x));

/** Linear knee: 1 at 0, 0 at `knee`, clamped to [0,1]. */
const linKnee = (value: number, knee: number) => sat(1 - value / knee);

/** Distance-credit decays linearly to 0 at 2× the knee. */
const distSupport = (km: number, knee: number) => sat(1 - km / (2 * knee));

/** Gap-modulation: distance signal × 1/(1 + gap/T_gap). At gap=0 → 1; at gap=T_gap → 0.5; at 2·T_gap → 0.33. */
const gapMod = (gapSec: number, halfLife: number) => 1 / (1 + gapSec / halfLife);

/** inBboxRatio = in / (in + rejected); 0 when there's no signal at all. */
export function inBboxRatio(s: Pick<Signals, 'inBboxPackets' | 'bboxRejectedPackets'>): number {
    const total = s.inBboxPackets + s.bboxRejectedPackets;
    return total > 0 ? s.inBboxPackets / total : 0;
}

/** Returns true if this flarmid is plausible enough to enter the candidate set at all. */
export function passesCandidateFilter(s: Pick<Signals, 'inBboxPackets' | 'bboxRejectedPackets'>, knees: ScoreKnees = DEFAULT_KNEES): boolean {
    if (s.inBboxPackets === 0) return false;
    return inBboxRatio(s) >= knees.inBboxMinRatio;
}

/** Compute pair_score in nats with a per-signal breakdown. */
export function scoreSignals(s: Signals, weights: ScoreWeights = DEFAULT_WEIGHTS, knees: ScoreKnees = DEFAULT_KNEES): ScoreBreakdown {
    const T_tol = knees.timeToleranceSec;
    const D_tol = knees.distToleranceKm;
    const T_gap = knees.gapModulationSec;

    // Δstart / Δfinish — full credit at Δ=0, zero at |Δ|≥T_tol. Ambiguous rows
    // (time matches several pilots) carry less discrimination per match.
    const ambig = s.ambiguous ? AMBIGUOUS_DELTA_FACTOR : 1;
    const sStart = (s.deltaStart === null ? 0 : linKnee(Math.abs(s.deltaStart), T_tol)) * ambig;
    const sFinish = (s.deltaFinish === null ? 0 : linKnee(Math.abs(s.deltaFinish), T_tol)) * ambig;

    // Distance-at-official-time, gap-modulated. Full credit only when the
    // bracketing gap is small and the bracketing-segment distance is tight.
    // When a crossing was actually found AND it's within tolerance, the Δ
    // signal already carries that evidence — the distance would just be
    // ≈0 km (the segment crosses the line) and double-count, so score it 0.
    const startCrossingWithinTol = s.deltaStart !== null && Math.abs(s.deltaStart) <= T_tol;
    const sDistStart =
        startCrossingWithinTol || s.distAtStartKm === null || s.gapAroundStartSec === null //
            ? 0
            : distSupport(s.distAtStartKm, D_tol) * gapMod(s.gapAroundStartSec, T_gap);
    const finishCrossingWithinTol = s.deltaFinish !== null && Math.abs(s.deltaFinish) <= T_tol;
    const sDistFinish =
        finishCrossingWithinTol || s.distAtFinishKm === null || s.gapAroundFinishSec === null //
            ? 0
            : distSupport(s.distAtFinishKm, D_tol) * gapMod(s.gapAroundFinishSec, T_gap);

    // Negative evidence: wrong-time crossing (tracker crossed at a different pilot's time)
    // and confirmed positional absence (tracker was far from the line at the official time
    // with good coverage). Both strands are computed as [0,1] factors; we take the stronger
    // (Math.max) to avoid double-counting when both fire for the same physical fact, then
    // negate and scale by gap-coverage quality.
    //
    // wrongTimeFactor: saturates to 1 at |Δ| = (1+WRONG_CROSS_SCALE)×T_tol (=30s default).
    const wrongTimeStartFactor = s.deltaStart !== null && Math.abs(s.deltaStart) > T_tol
        ? sat((Math.abs(s.deltaStart) - T_tol) / (WRONG_CROSS_SCALE * T_tol))
        : 0;
    // notHereFactor: 1 when confirmed far (> 2×D_tol) and no within-tolerance crossing.
    const notHereStartFactor = !startCrossingWithinTol && s.distAtStartKm !== null && s.gapAroundStartSec !== null && s.distAtStartKm > 2 * D_tol ? 1.0 : 0;
    const sNegStart = (wrongTimeStartFactor > 0 || notHereStartFactor > 0)
        ? -Math.max(wrongTimeStartFactor, notHereStartFactor) * gapMod(s.gapAroundStartSec ?? Infinity, T_gap)
        : 0;

    const wrongTimeFinishFactor = s.deltaFinish !== null && Math.abs(s.deltaFinish) > T_tol
        ? sat((Math.abs(s.deltaFinish) - T_tol) / (WRONG_CROSS_SCALE * T_tol))
        : 0;
    const notHereFinishFactor = !finishCrossingWithinTol && s.distAtFinishKm !== null && s.gapAroundFinishSec !== null && s.distAtFinishKm > 2 * D_tol ? 1.0 : 0;
    const sNegFinish = (wrongTimeFinishFactor > 0 || notHereFinishFactor > 0)
        ? -Math.max(wrongTimeFinishFactor, notHereFinishFactor) * gapMod(s.gapAroundFinishSec ?? Infinity, T_gap)
        : 0;

    // OGN-daemon cross-check. Per side: positive support inside the wide knee,
    // dead zone, then a wrongTime-style negative beyond the onset (assigned
    // pairs only - for a cross pair, absence of a match is not evidence against
    // a hypothesis nobody made). When the replay already found a
    // within-tolerance crossing on a side, the daemon signal is zeroed in BOTH
    // directions: the crossing is direct evidence from the same APRS data
    // (agreement would double-count; assigned-pair disagreement can then only
    // be a scoring-algorithm difference, which must not fire the negative).
    // Everything is scaled by the whole-track coverage factor - poor coverage
    // biases the daemon's scored values away from the official ones even for
    // the correct tracker.
    const ognCross = s.ognIsCross ?? false;
    const ognCov = ognCoverageFactor(s.ognAvgGapSec);
    const ognScale = (ognCross ? OGN_CHECK_CROSS_FACTOR / Math.max(1, s.ognMatchCount ?? 1) : 1) * ognCov;
    const ognTimeSupport = (delta: number | null, replayWithinTol: boolean): number => {
        if (delta === null || replayWithinTol || ognCov === 0) return 0;
        const a = Math.abs(delta);
        const pos = linKnee(a, OGN_CHECK_TIME_TOLERANCE_SEC);
        if (pos > 0) return pos * ognScale;
        if (ognCross) return 0;
        const negFactor = sat((a - OGN_CHECK_NEG_ONSET_SEC) / (OGN_CHECK_NEG_SCALE * OGN_CHECK_NEG_ONSET_SEC));
        return negFactor > 0 ? -negFactor * ognCov : 0;
    };
    const sOgnStart = ognTimeSupport(s.ognDeltaStart, startCrossingWithinTol);
    const sOgnFinish = ognTimeSupport(s.ognDeltaFinish, finishCrossingWithinTol);
    const sOgnDist =
        s.ognTaskDistKm === null || s.officialDistKm === null //
            ? 0
            : linKnee(Math.abs(s.ognTaskDistKm - s.officialDistKm), Math.max(OGN_CHECK_DIST_ABS_KM, OGN_CHECK_DIST_REL * s.officialDistKm)) * ognScale;

    // Presence: count saturates at N_full and is multiplied by the in/out
    // ratio so a flarmid that mostly flew elsewhere doesn't get credit.
    const ratio = inBboxRatio(s);
    const sInBbox =
        ratio < knees.inBboxMinRatio //
            ? 0
            : sat(s.inBboxPackets / knees.inBboxFullCount) * ratio;

    // Pre-launch sighting: glider was in the area ≥30 min before the
    // earliest pilot start. Typical for a real competition glider.
    const sPreLaunch = s.firstSeenT !== null && s.firstSeenT <= s.earliestPilotStartUtc - 30 * 60 ? 1 : 0;

    const sDdbCn = s.ddbCnMatch ? 1 : 0;
    const sDdbGlider = s.ddbGliderMatch ? 1 : 0;
    const sBaseline = s.baselineMatch ? 1 : 0;

    const breakdown: ScoreBreakdown = {
        deltaStart: weights.deltaStart * sStart,
        deltaFinish: weights.deltaFinish * sFinish,
        distAtStart: weights.distAtStart * sDistStart,
        distAtFinish: weights.distAtFinish * sDistFinish,
        negStart: weights.negCross * sNegStart,
        negFinish: weights.negCross * sNegFinish,
        inBbox: weights.inBbox * sInBbox,
        preLaunch: weights.preLaunch * sPreLaunch,
        ddbCn: weights.ddbCn * sDdbCn,
        ddbGlider: weights.ddbGlider * sDdbGlider,
        baseline: weights.baseline * sBaseline,
        ognStart: weights.ognTime * sOgnStart,
        ognFinish: weights.ognTime * sOgnFinish,
        ognDist: weights.ognDist * sOgnDist,
        prior: weights.prior * s.priorNats,
        // Cross-comp identity already collapsed to a single nats value by
        // xcEvidenceScore (confidence-scaled, age-decayed, best prior comp).
        xc: weights.xc * s.xcNats,
        total: 0
    };
    breakdown.total =
        breakdown.deltaStart +
        breakdown.deltaFinish +
        breakdown.distAtStart +
        breakdown.distAtFinish +
        breakdown.negStart +
        breakdown.negFinish +
        breakdown.inBbox +
        breakdown.preLaunch +
        breakdown.ddbCn +
        breakdown.ddbGlider +
        breakdown.baseline +
        breakdown.ognStart +
        breakdown.ognFinish +
        breakdown.ognDist +
        breakdown.prior +
        breakdown.xc;
    return breakdown;
}

// ---- OGN-daemon score cross-check helpers ---------------------------------

/** One channel-pilot's scored triple from the daemon's /scores JSON. All fields null when the daemon payload had them unset (0/absent in the protobuf shape). */
export interface OgnDaemonPilot {
    utcStart: number | null; // epoch seconds
    utcFinish: number | null;
    taskDistanceKm: number | null; // actual.taskDistance, real km on the JSON route
}

export type OgnSignalFields = Pick<Signals, 'ognDeltaStart' | 'ognDeltaFinish' | 'ognTaskDistKm' | 'officialDistKm'>;

export const OGN_SIGNALS_NONE: OgnSignalFields = {ognDeltaStart: null, ognDeltaFinish: null, ognTaskDistKm: null, officialDistKm: null};

/**
 * Map one pilot's daemon triple + one official result to the ogn* Signals
 * fields. All-null (a scoring no-op) when either side is missing.
 * `commonStart` (grandprix single common start) nulls the start delta - a
 * shared start time carries no per-pilot information; a pev cylinder start
 * does NOT (the daemon start is per-pilot and is the only start evidence
 * on those days). A missing finish on EITHER side yields null - landout
 * agreement is carried by the distance signal, and a daemon still
 * mid-flight must not fire anything on the finish side.
 */
export function ognSignalsFrom(daemon: OgnDaemonPilot | null | undefined, official: {startUtc: number; finishUtc: number | null; distanceKm: number | null} | undefined, commonStart: boolean): OgnSignalFields {
    if (!daemon || !official) return OGN_SIGNALS_NONE;
    return {
        ognDeltaStart: commonStart || daemon.utcStart === null ? null : daemon.utcStart - official.startUtc,
        ognDeltaFinish: daemon.utcFinish === null || official.finishUtc === null ? null : daemon.utcFinish - official.finishUtc,
        ognTaskDistKm: daemon.taskDistanceKm,
        officialDistKm: official.distanceKm !== null && official.distanceKm > 0 ? official.distanceKm : null
    };
}

/**
 * Raw combined support in [0,3] for a daemon triple vs one official result -
 * the sum of the three unweighted component supports (same knees as
 * `scoreSignals`, no suppression/coverage/weights). Shared by the
 * ambiguity-divisor computation so k uses identical match math.
 */
export function ognRawSupport(f: OgnSignalFields): number {
    const sStart = f.ognDeltaStart === null ? 0 : linKnee(Math.abs(f.ognDeltaStart), OGN_CHECK_TIME_TOLERANCE_SEC);
    const sFinish = f.ognDeltaFinish === null ? 0 : linKnee(Math.abs(f.ognDeltaFinish), OGN_CHECK_TIME_TOLERANCE_SEC);
    const sDist = f.ognTaskDistKm === null || f.officialDistKm === null ? 0 : linKnee(Math.abs(f.ognTaskDistKm - f.officialDistKm), Math.max(OGN_CHECK_DIST_ABS_KM, OGN_CHECK_DIST_REL * f.officialDistKm));
    return sStart + sFinish + sDist;
}

/**
 * k: how many pilots' official results this daemon triple matches (raw
 * combined support >= OGN_CHECK_CROSS_MATCH_FLOOR), min 1. Divides
 * cross-pair positives - a triple matching a whole gaggle's start says
 * little about any one of them, while a unique match keeps full credit.
 */
export function ognMatchCount(daemon: OgnDaemonPilot, officials: {startUtc: number; finishUtc: number | null; distanceKm: number | null}[], commonStart: boolean): number {
    let k = 0;
    for (const o of officials) {
        if (ognRawSupport(ognSignalsFrom(daemon, o, commonStart)) >= OGN_CHECK_CROSS_MATCH_FLOOR) k++;
    }
    return Math.max(1, k);
}

/**
 * Whole-track coverage factor for the ogn-check supports: 1 at or below
 * OGN_CHECK_COVERAGE_GOOD_GAP_SEC mean packet interval, 0 at or above
 * OGN_CHECK_COVERAGE_BAD_GAP_SEC, linear between; 0 when there is no
 * measurable track (null).
 */
export function ognCoverageFactor(avgGapSec: number | null): number {
    if (avgGapSec === null) return 0;
    return sat((OGN_CHECK_COVERAGE_BAD_GAP_SEC - avgGapSec) / (OGN_CHECK_COVERAGE_BAD_GAP_SEC - OGN_CHECK_COVERAGE_GOOD_GAP_SEC));
}

/**
 * Physical-track confidence of a match, in nats — the parts of the breakdown
 * that measure the actual tracked flight (Δstart/Δfinish, distance-at-time,
 * in-area presence, pre-launch). Deliberately EXCLUDES prior, baseline, ddb*,
 * xc and the ogn* cross-check (the ogn check exists only for pairs with a
 * daemon-scored owner and derives from official results, so including it
 * would bias cross-comp identity collection toward existing assignments)
 * so this value can be stored as cross-comp evidence confidence without
 * feeding back on itself across competitions.
 */
export function physicalMatchScore(b: ScoreBreakdown): number {
    return b.deltaStart + b.deltaFinish + b.distAtStart + b.distAtFinish + b.inBbox + b.preLaunch;
}

/**
 * Per-day prior contribution from a single task day's start/finish crossings,
 * in nats. This is the ONLY thing the within-comp prior is built from — purely
 * line-crossing evidence, nothing derivable from ddb / the flarm_* identity
 * tables (those are recomputed live each run, never persisted into the prior).
 *
 * Each crossing earns its weighted saturating support (same knee as the live
 * Δstart/Δfinish signals); the day's total is capped at MAX_PRIOR_PER_DAY_NATS
 * so one strong day can't outweigh several days of confirmation. Both deltas
 * null (no crossing that day) → 0, i.e. "no match".
 */
export function crossingScore(deltaStart: number | null, deltaFinish: number | null, weights: ScoreWeights = DEFAULT_WEIGHTS, knees: ScoreKnees = DEFAULT_KNEES): number {
    const sStart = deltaStart === null ? 0 : linKnee(Math.abs(deltaStart), knees.timeToleranceSec);
    const sFinish = deltaFinish === null ? 0 : linKnee(Math.abs(deltaFinish), knees.timeToleranceSec);
    return Math.min(MAX_PRIOR_PER_DAY_NATS, weights.deltaStart * sStart + weights.deltaFinish * sFinish);
}

/**
 * Negative contribution to the per-day prior from stored dist/gap data in
 * trackerhistory. Mirrors the sNegStart/sNegFinish logic in `scoreSignals`
 * but works from persisted values (dist_at_start, gap_around_start, etc.)
 * rather than live Signals. Returns a value in [-2×weights.negCross, 0].
 * Called by `loadPriorEvidence` for rows where the new columns are present.
 */
export function negCrossScore(
    deltaStart: number | null,
    gapAroundStartSec: number | null,
    distAtStartKm: number | null,
    deltaFinish: number | null,
    gapAroundFinishSec: number | null,
    distAtFinishKm: number | null,
    weights: ScoreWeights = DEFAULT_WEIGHTS,
    knees: ScoreKnees = DEFAULT_KNEES
): number {
    const T_tol = knees.timeToleranceSec;
    const D_tol = knees.distToleranceKm;
    const T_gap = knees.gapModulationSec;

    const startCrossingWithinTol = deltaStart !== null && Math.abs(deltaStart) <= T_tol;
    const wrongTimeStartFactor = deltaStart !== null && Math.abs(deltaStart) > T_tol
        ? sat((Math.abs(deltaStart) - T_tol) / (WRONG_CROSS_SCALE * T_tol))
        : 0;
    const notHereStartFactor = !startCrossingWithinTol && distAtStartKm !== null && gapAroundStartSec !== null && distAtStartKm > 2 * D_tol ? 1.0 : 0;
    const sNegStart = (wrongTimeStartFactor > 0 || notHereStartFactor > 0)
        ? -Math.max(wrongTimeStartFactor, notHereStartFactor) * gapMod(gapAroundStartSec ?? Infinity, T_gap)
        : 0;

    const finishCrossingWithinTol = deltaFinish !== null && Math.abs(deltaFinish) <= T_tol;
    const wrongTimeFinishFactor = deltaFinish !== null && Math.abs(deltaFinish) > T_tol
        ? sat((Math.abs(deltaFinish) - T_tol) / (WRONG_CROSS_SCALE * T_tol))
        : 0;
    const notHereFinishFactor = !finishCrossingWithinTol && distAtFinishKm !== null && gapAroundFinishSec !== null && distAtFinishKm > 2 * D_tol ? 1.0 : 0;
    const sNegFinish = (wrongTimeFinishFactor > 0 || notHereFinishFactor > 0)
        ? -Math.max(wrongTimeFinishFactor, notHereFinishFactor) * gapMod(gapAroundFinishSec ?? Infinity, T_gap)
        : 0;

    return weights.negCross * (sNegStart + sNegFinish);
}

/** Sum of per-day crossing scores for one (compno, flarmid) pair, capped at
 *  ±MAX_TOTAL_PRIOR_NATS. Each row carries that day's `crossingScore + negCrossScore`
 *  (already capped at ±MAX_PRIOR_PER_DAY_NATS). No decay: tracker-to-glider
 *  mapping doesn't degrade with age, so old confirmed evidence is as valid as recent.
 *  The total cap prevents accumulated days from dominating current-day live signals.
 *  taskDaysAgo is retained to guard against impossible future rows (taskDaysAgo < 0).
 */
export function summarisePrior(rows: {scoreNats: number; taskDaysAgo: number}[]): number {
    let total = 0;
    for (const r of rows) {
        if (r.taskDaysAgo < 0) continue;
        total += r.scoreNats;
    }
    return Math.max(-MAX_TOTAL_PRIOR_NATS, Math.min(MAX_TOTAL_PRIOR_NATS, total));
}

/**
 * Contention guard: stop a poor match from displacing a likely-good one.
 *
 * For each flarmid, the glider that "confidently holds" it is the operator
 * baseline assignment if that pair's total clears `protectThreshold`, otherwise
 * the highest-scoring pair this run if *it* clears the threshold (the "Either"
 * rule — baseline takes precedence so an existing good assignment is protected).
 * Every OTHER glider competing for the same flarmid is a contender whose
 * (prior + current) total should be negated, so it can never win the
 * assignment away from the confident holder.
 *
 * Pure: takes the per-pair totals + baseline flags, returns the set of pair
 * keys whose total the caller must negate. `key(compno, flarmid)` lets the
 * caller use whatever pair-key convention it already has.
 */
export function contentionPenalty<P extends {compno: string; flarmid: string; total: number; baseline: boolean}>(
    pairs: P[],
    key: (compno: string, flarmid: string) => string,
    protectThreshold: number = PRIOR_PROTECT_NATS
): Set<string> {
    const byFlarmid = new Map<string, P[]>();
    for (const p of pairs) {
        const arr = byFlarmid.get(p.flarmid) ?? [];
        arr.push(p);
        byFlarmid.set(p.flarmid, arr);
    }
    const penalise = new Set<string>();
    for (const group of byFlarmid.values()) {
        if (group.length < 2) continue; // no contention without a competitor
        const best = (cands: P[]): P | null => cands.reduce<P | null>((m, p) => (m === null || p.total > m.total ? p : m), null);
        const baselineHolder = best(group.filter((p) => p.baseline));
        const bestHolder = best(group);
        const holder = baselineHolder && baselineHolder.total > protectThreshold ? baselineHolder : bestHolder && bestHolder.total > protectThreshold ? bestHolder : null;
        if (!holder) continue;
        for (const p of group) {
            if (p.compno === holder.compno) continue;
            penalise.add(key(p.compno, p.flarmid));
        }
    }
    return penalise;
}

/**
 * Pilot-side analog of `contentionPenalty`: once a pilot confidently holds one
 * flarmid (the baseline pair if it clears `protectThreshold`, else this run's
 * best pair if *it* clears), the pilot's claims on OTHER flarmids are negated —
 * so a flarmid that happens to match their times doesn't block its rightful
 * claimant's margin. Baseline rows are never penalised: a multi-unit pilot's
 * second assigned flarmid is the operator's statement, not a competing claim.
 */
export function pilotContentionPenalty<P extends {compno: string; flarmid: string; total: number; baseline: boolean}>(
    pairs: P[],
    key: (compno: string, flarmid: string) => string,
    protectThreshold: number = PRIOR_PROTECT_NATS
): Set<string> {
    const byCompno = new Map<string, P[]>();
    for (const p of pairs) {
        const arr = byCompno.get(p.compno) ?? [];
        arr.push(p);
        byCompno.set(p.compno, arr);
    }
    const penalise = new Set<string>();
    for (const group of byCompno.values()) {
        if (group.length < 2) continue; // no contention without a second claim
        const best = (cands: P[]): P | null => cands.reduce<P | null>((m, p) => (m === null || p.total > m.total ? p : m), null);
        const baselineHolder = best(group.filter((p) => p.baseline));
        const bestHolder = best(group);
        const holder = baselineHolder && baselineHolder.total > protectThreshold ? baselineHolder : bestHolder && bestHolder.total > protectThreshold ? bestHolder : null;
        if (!holder) continue;
        for (const p of group) {
            if (p.flarmid === holder.flarmid || p.baseline) continue;
            penalise.add(key(p.compno, p.flarmid));
        }
    }
    return penalise;
}

/**
 * Both contention penalties evaluated from the SAME pre-penalty totals, then
 * unioned — the caller negates each key once, so the result is independent of
 * application order and cannot oscillate. `reason` distinguishes which side(s)
 * demoted a pair for display.
 */
export function applyContentionPenalties<P extends {compno: string; flarmid: string; total: number; baseline: boolean}>(
    pairs: P[],
    key: (compno: string, flarmid: string) => string,
    protectThreshold: number = PRIOR_PROTECT_NATS
): {penalised: Set<string>; reason: Map<string, 'flarm' | 'pilot' | 'both'>} {
    const flarmSide = contentionPenalty(pairs, key, protectThreshold);
    const pilotSide = pilotContentionPenalty(pairs, key, protectThreshold);
    const penalised = new Set<string>([...flarmSide, ...pilotSide]);
    const reason = new Map<string, 'flarm' | 'pilot' | 'both'>();
    for (const k of penalised) reason.set(k, flarmSide.has(k) ? (pilotSide.has(k) ? 'both' : 'flarm') : 'pilot');
    return {penalised, reason};
}

/** Two-sided margins for a chosen pair (p*, f*) given its score and the score of every alternative on each side. Pure data — no assignment search. */
export interface MarginInputs {
    chosenScore: number;
    bestOtherFlarmidForPilot: number; // max score for p* over flarmids ≠ f*
    bestOtherPilotForFlarmid: number; // max score for f* over pilots ≠ p*
}
export interface Margins {
    pilotMargin: number; // chosen − best alternative on pilot side
    flarmidMargin: number; // chosen − best alternative on flarmid side
    margin: number; // min(pilotMargin, flarmidMargin)
}
export function computeMargins(m: MarginInputs): Margins {
    const pilotMargin = m.chosenScore - m.bestOtherFlarmidForPilot;
    const flarmidMargin = m.chosenScore - m.bestOtherPilotForFlarmid;
    return {pilotMargin, flarmidMargin, margin: Math.min(pilotMargin, flarmidMargin)};
}
