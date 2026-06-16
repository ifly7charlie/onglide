// Probabilistic scoring for flarmid↔pilot pair candidates. Pure functions:
// signal extraction, score combination, two-sided margin computation. No DB,
// no I/O. Persistence and assignment optimisation live elsewhere.
//
// Units: nats. Score = Σ wᵢ · sᵢ where sᵢ ∈ [0,1] is a saturating support
// function and wᵢ is the per-signal weight. Missing signals contribute 0,
// never negative — contradictions emerge by competing pairs scoring more.
// `prior` carries only start/finish line-crossing evidence from earlier task
// days (≥0, capped per day); a whole pair's total is driven negative separately
// by `contentionPenalty` when a different glider confidently holds the flarmid.

import {
    DEFAULT_TOLERANCE_SEC,
    DEFAULT_DIST_TOLERANCE_KM,
    DEFAULT_GAP_MODULATION_SEC,
    DEFAULT_INBBOX_FULL_COUNT,
    DEFAULT_INBBOX_MIN_RATIO,
    DEFAULT_PRIOR_DECAY_DAYS,
    AMBIGUOUS_DELTA_FACTOR,
    MAX_PRIOR_PER_DAY_NATS,
    PRIOR_PROTECT_NATS,
    TRACKER_SCORE_WEIGHTS
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
    /** Decay timescale (days) for prior-day pair_scores. */
    priorDecayDays: number;
}

export const DEFAULT_KNEES: ScoreKnees = {
    timeToleranceSec: DEFAULT_TOLERANCE_SEC,
    distToleranceKm: DEFAULT_DIST_TOLERANCE_KM,
    gapModulationSec: DEFAULT_GAP_MODULATION_SEC,
    inBboxFullCount: DEFAULT_INBBOX_FULL_COUNT,
    inBboxMinRatio: DEFAULT_INBBOX_MIN_RATIO,
    priorDecayDays: DEFAULT_PRIOR_DECAY_DAYS
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
    /** Sum of decayed per-day start/finish crossing scores for this (compno, flarmid) within the same comp. Already in nats; ≥0 (each day capped at MAX_PRIOR_PER_DAY_NATS). Carries no ddb/identity-derived evidence. */
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
    inBbox: number;
    preLaunch: number;
    ddbCn: number;
    ddbGlider: number;
    baseline: number;
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
        inBbox: weights.inBbox * sInBbox,
        preLaunch: weights.preLaunch * sPreLaunch,
        ddbCn: weights.ddbCn * sDdbCn,
        ddbGlider: weights.ddbGlider * sDdbGlider,
        baseline: weights.baseline * sBaseline,
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
        breakdown.inBbox +
        breakdown.preLaunch +
        breakdown.ddbCn +
        breakdown.ddbGlider +
        breakdown.baseline +
        breakdown.prior +
        breakdown.xc;
    return breakdown;
}

/**
 * Physical-track confidence of a match, in nats — the parts of the breakdown
 * that measure the actual tracked flight (Δstart/Δfinish, distance-at-time,
 * in-area presence, pre-launch). Deliberately EXCLUDES prior, baseline, ddb*
 * and xc so this value can be stored as cross-comp evidence confidence without
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

/** Decay a single prior crossing score by its age in task days. */
export function decayPrior(scoreNats: number, ageDays: number, knees: ScoreKnees = DEFAULT_KNEES): number {
    if (ageDays <= 0) return scoreNats;
    return scoreNats * Math.exp(-ageDays / knees.priorDecayDays);
}

/** Sum of decayed per-day crossing scores for one (compno, flarmid) pair. Each
 *  row carries that day's `crossingScore` (≥0, already capped) and an age in
 *  task-days (calendar days are *not* used — comp rest days shouldn't decay
 *  priors). Repeated confirmations accumulate; a no-crossing day contributes 0.
 */
export function summarisePrior(rows: {scoreNats: number; taskDaysAgo: number}[], knees: ScoreKnees = DEFAULT_KNEES): number {
    let total = 0;
    for (const r of rows) {
        if (r.taskDaysAgo < 0) continue;
        total += decayPrior(r.scoreNats, r.taskDaysAgo, knees);
    }
    return total;
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
