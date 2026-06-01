// Probabilistic scoring for flarmid↔pilot pair candidates. Pure functions:
// signal extraction, score combination, two-sided margin computation. No DB,
// no I/O. Persistence and assignment optimisation live elsewhere.
//
// Units: nats. Score = Σ wᵢ · sᵢ where sᵢ ∈ [0,1] is a saturating support
// function and wᵢ is the per-signal weight. Missing signals contribute 0,
// never negative — contradictions emerge by competing pairs scoring more.
// The sole exception is `prior`, which carries a signed margin from earlier
// task days and may be negative (a past loss to a competitor stays negative).

import {
    DEFAULT_TOLERANCE_SEC,
    DEFAULT_DIST_TOLERANCE_KM,
    DEFAULT_GAP_MODULATION_SEC,
    DEFAULT_INBBOX_FULL_COUNT,
    DEFAULT_INBBOX_MIN_RATIO,
    DEFAULT_PRIOR_DECAY_DAYS,
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
    /** Sum of decayed prior-day two-sided margins for this (compno, flarmid) within the same comp. Already in nats; signed — negative when a prior day's match lost to a competing candidate. */
    priorNats: number;

    // --- Cross-competition identity evidence (from OTHER comps; flarmid ≈ aircraft) ---
    /** Candidate greg == the flarmid's known aircraft greg, OR the flarmid IS the aircraft's permanent ICAO address matching it. Aircraft-permanent → strongest. */
    xcGregMatch: boolean;
    /** Candidate glider key == the flarmid's known aircraft glider key. */
    xcGliderMatch: boolean;
    /** Candidate compno == the flarmid's last-seen aircraft compno (weak — usually consistent but not unique). */
    xcCompnoMatch: boolean;
    /** Best privacy-preserving name-token overlap in [0,1] over the flarmid's prior pilot clues. null when no clue carried name tokens. Partial overlap (e.g. a solo pilot vs an "A & B" crew) scores < a full match. */
    xcNameOverlap: number | null;
    /** Candidate real-FAI == a prior pilot clue's FAI (the best-overlap clue). */
    xcFaiMatch: boolean;
    /** Candidate club hash == a prior pilot clue's club hash (the best-overlap clue). */
    xcClubMatch: boolean;
    /** Candidate country == the flarmid's known aircraft country. */
    xcCountryMatch: boolean;
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
    xcGreg: number;
    xcGlider: number;
    xcCompno: number;
    xcName: number;
    xcFai: number;
    xcClub: number;
    xcCountry: number;
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

    // Δstart / Δfinish — full credit at Δ=0, zero at |Δ|≥T_tol.
    const sStart = s.deltaStart === null ? 0 : linKnee(Math.abs(s.deltaStart), T_tol);
    const sFinish = s.deltaFinish === null ? 0 : linKnee(Math.abs(s.deltaFinish), T_tol);

    // Distance-at-official-time, gap-modulated. Full credit only when the
    // bracketing gap is small and the bracketing-segment distance is tight.
    const sDistStart = s.distAtStartKm === null || s.gapAroundStartSec === null //
        ? 0
        : distSupport(s.distAtStartKm, D_tol) * gapMod(s.gapAroundStartSec, T_gap);
    const sDistFinish = s.distAtFinishKm === null || s.gapAroundFinishSec === null //
        ? 0
        : distSupport(s.distAtFinishKm, D_tol) * gapMod(s.gapAroundFinishSec, T_gap);

    // Presence: count saturates at N_full and is multiplied by the in/out
    // ratio so a flarmid that mostly flew elsewhere doesn't get credit.
    const ratio = inBboxRatio(s);
    const sInBbox = ratio < knees.inBboxMinRatio //
        ? 0
        : sat(s.inBboxPackets / knees.inBboxFullCount) * ratio;

    // Pre-launch sighting: glider was in the area ≥30 min before the
    // earliest pilot start. Typical for a real competition glider.
    const sPreLaunch = s.firstSeenT !== null && s.firstSeenT <= s.earliestPilotStartUtc - 30 * 60 ? 1 : 0;

    const sDdbCn = s.ddbCnMatch ? 1 : 0;
    const sDdbGlider = s.ddbGliderMatch ? 1 : 0;
    const sBaseline = s.baselineMatch ? 1 : 0;

    // Cross-comp identity: booleans → {0,1}; name overlap is already a [0,1]
    // fraction (best over the flarmid's prior pilot clues, partial < full).
    const sXcGreg = s.xcGregMatch ? 1 : 0;
    const sXcGlider = s.xcGliderMatch ? 1 : 0;
    const sXcCompno = s.xcCompnoMatch ? 1 : 0;
    const sXcName = s.xcNameOverlap === null ? 0 : sat(s.xcNameOverlap);
    const sXcFai = s.xcFaiMatch ? 1 : 0;
    const sXcClub = s.xcClubMatch ? 1 : 0;
    const sXcCountry = s.xcCountryMatch ? 1 : 0;

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
        xcGreg: weights.xcGreg * sXcGreg,
        xcGlider: weights.xcGlider * sXcGlider,
        xcCompno: weights.xcCompno * sXcCompno,
        xcName: weights.xcName * sXcName,
        xcFai: weights.xcFai * sXcFai,
        xcClub: weights.xcClub * sXcClub,
        xcCountry: weights.xcCountry * sXcCountry,
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
        breakdown.xcGreg +
        breakdown.xcGlider +
        breakdown.xcCompno +
        breakdown.xcName +
        breakdown.xcFai +
        breakdown.xcClub +
        breakdown.xcCountry;
    return breakdown;
}

/** Decay a single prior pair_score by its age in days. */
export function decayPrior(scoreNats: number, ageDays: number, knees: ScoreKnees = DEFAULT_KNEES): number {
    if (ageDays <= 0) return scoreNats;
    return scoreNats * Math.exp(-ageDays / knees.priorDecayDays);
}

/** Sum of decayed prior contributions for one (compno, flarmid) pair. Each
 *  row carries a signed margin (use `null` to signal a legacy row that gets
 *  the caller-supplied legacy weight) and an age expressed in task-days
 *  (calendar days are *not* used — comp rest days shouldn't decay priors).
 *  A negative margin decays toward 0 from below, preserving its sign.
 */
export function summarisePrior(rows: {scoreNats: number | null; taskDaysAgo: number}[], legacyNats: number, knees: ScoreKnees = DEFAULT_KNEES): number {
    let total = 0;
    for (const r of rows) {
        if (r.taskDaysAgo < 0) continue;
        const base = r.scoreNats ?? legacyNats;
        total += decayPrior(base, r.taskDaysAgo, knees);
    }
    return total;
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
