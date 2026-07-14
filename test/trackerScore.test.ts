import {describe, test, expect} from 'vitest';
import {
    scoreSignals,
    computeMargins,
    summarisePrior,
    crossingScore,
    negCrossScore,
    contentionPenalty,
    pilotContentionPenalty,
    applyContentionPenalties,
    inBboxRatio,
    passesCandidateFilter,
    physicalMatchScore,
    ognSignalsFrom,
    ognRawSupport,
    ognMatchCount,
    ognCoverageFactor,
    OGN_SIGNALS_NONE,
    type Signals,
    type OgnDaemonPilot
} from '../lib/scoring/shared/trackerScore';
import {
    DEFAULT_TOLERANCE_SEC,
    DEFAULT_DIST_TOLERANCE_KM,
    DEFAULT_GAP_MODULATION_SEC,
    DEFAULT_INBBOX_FULL_COUNT,
    AMBIGUOUS_DELTA_FACTOR,
    MAX_PRIOR_PER_DAY_NATS,
    MAX_TOTAL_PRIOR_NATS,
    PRIOR_PROTECT_NATS,
    TRACKER_SCORE_WEIGHTS,
    WRONG_CROSS_SCALE,
    OGN_CHECK_TIME_TOLERANCE_SEC,
    OGN_CHECK_NEG_ONSET_SEC,
    OGN_CHECK_NEG_SCALE,
    OGN_CHECK_DIST_ABS_KM,
    OGN_CHECK_DIST_REL,
    OGN_CHECK_CROSS_FACTOR,
    OGN_CHECK_CROSS_MATCH_FLOOR,
    OGN_CHECK_COVERAGE_GOOD_GAP_SEC,
    OGN_CHECK_COVERAGE_BAD_GAP_SEC
} from '../lib/constants';

const baseSignals = (over: Partial<Signals> = {}): Signals => ({
    deltaStart: null,
    deltaFinish: null,
    distAtStartKm: null,
    gapAroundStartSec: null,
    distAtFinishKm: null,
    gapAroundFinishSec: null,
    inBboxPackets: 0,
    bboxRejectedPackets: 0,
    firstSeenT: null,
    earliestPilotStartUtc: 1700000000,
    ddbCnMatch: false,
    ddbGliderMatch: false,
    baselineMatch: false,
    ognDeltaStart: null,
    ognDeltaFinish: null,
    ognTaskDistKm: null,
    officialDistKm: null,
    ognAvgGapSec: null,
    priorNats: 0,
    xcNats: 0,
    ...over
});

describe('scoreSignals', () => {
    test('all-zero signals score 0', () => {
        const b = scoreSignals(baseSignals());
        expect(b.total).toBe(0);
    });

    test('clean Δstart=0 yields full deltaStart contribution', () => {
        const b = scoreSignals(baseSignals({deltaStart: 0}));
        expect(b.deltaStart).toBeCloseTo(1.0, 6);
        expect(b.total).toBeCloseTo(1.0, 6);
    });

    test('Δstart at the tolerance knee scores 0', () => {
        const b = scoreSignals(baseSignals({deltaStart: DEFAULT_TOLERANCE_SEC}));
        expect(b.deltaStart).toBeCloseTo(0, 6);
    });

    test('Δstart sign does not matter (absolute value used)', () => {
        const a = scoreSignals(baseSignals({deltaStart: -2}));
        const b = scoreSignals(baseSignals({deltaStart: 2}));
        expect(a.deltaStart).toBeCloseTo(b.deltaStart, 6);
    });

    test('distance at official time only contributes when both km and gap are present', () => {
        const noGap = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: null}));
        const both = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 1}));
        expect(noGap.distAtStart).toBe(0);
        expect(both.distAtStart).toBeGreaterThan(0);
    });

    test('a within-tolerance start crossing zeroes distAtStart (the crossing already carries it)', () => {
        // Same tight distance + gap, but now a clean start crossing exists.
        const noCross = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 1}));
        const withCross = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 1, deltaStart: 0}));
        expect(noCross.distAtStart).toBeGreaterThan(0);
        expect(withCross.distAtStart).toBe(0);
        // A start crossing OUTSIDE tolerance does not suppress the distance signal.
        const outOfTol = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 1, deltaStart: DEFAULT_TOLERANCE_SEC + 5}));
        expect(outOfTol.distAtStart).toBeGreaterThan(0);
        // Finish distance is unaffected by a start crossing.
        const withFinishDist = scoreSignals(baseSignals({distAtFinishKm: 0.05, gapAroundFinishSec: 1, deltaStart: 0}));
        expect(withFinishDist.distAtFinish).toBeGreaterThan(0);
    });

    test('large bracketing gap suppresses the distance contribution', () => {
        const tight = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 1}));
        const wide = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 120}));
        expect(wide.distAtStart).toBeLessThan(tight.distAtStart * 0.4);
    });

    test('distance contribution decays linearly to 0 at 2× knee', () => {
        const at0 = scoreSignals(baseSignals({distAtStartKm: 0, gapAroundStartSec: 0}));
        const atKnee = scoreSignals(baseSignals({distAtStartKm: DEFAULT_DIST_TOLERANCE_KM, gapAroundStartSec: 0}));
        const atDouble = scoreSignals(baseSignals({distAtStartKm: 2 * DEFAULT_DIST_TOLERANCE_KM, gapAroundStartSec: 0}));
        expect(at0.distAtStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.distAtStart, 4);
        expect(atKnee.distAtStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.distAtStart * 0.5, 4);
        expect(atDouble.distAtStart).toBeCloseTo(0, 4);
    });

    test('a within-tolerance finish crossing zeroes distAtFinish, mirroring the start gate', () => {
        const noCross = scoreSignals(baseSignals({distAtFinishKm: 0.05, gapAroundFinishSec: 1}));
        const withCross = scoreSignals(baseSignals({distAtFinishKm: 0.05, gapAroundFinishSec: 1, deltaFinish: 0}));
        expect(noCross.distAtFinish).toBeGreaterThan(0);
        expect(withCross.distAtFinish).toBe(0);
        // A finish crossing OUTSIDE tolerance does not suppress the distance signal.
        const outOfTol = scoreSignals(baseSignals({distAtFinishKm: 0.05, gapAroundFinishSec: 1, deltaFinish: DEFAULT_TOLERANCE_SEC + 5}));
        expect(outOfTol.distAtFinish).toBeGreaterThan(0);
        // Start distance is unaffected by a finish crossing.
        const withStartDist = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 1, deltaFinish: 0}));
        expect(withStartDist.distAtStart).toBeGreaterThan(0);
    });

    test('ambiguous flag downgrades only the Δ supports by AMBIGUOUS_DELTA_FACTOR', () => {
        // distAtFinish kept live by leaving deltaFinish out of tolerance.
        const sig = {deltaStart: -1, deltaFinish: DEFAULT_TOLERANCE_SEC + 2, distAtFinishKm: 0.1, gapAroundFinishSec: 1, inBboxPackets: 800, ddbCnMatch: true};
        const plain = scoreSignals(baseSignals(sig));
        const ambig = scoreSignals(baseSignals({...sig, ambiguous: true}));
        expect(plain.deltaStart).toBeGreaterThan(0);
        expect(ambig.deltaStart).toBeCloseTo(plain.deltaStart * AMBIGUOUS_DELTA_FACTOR, 6);
        expect(plain.distAtFinish).toBeGreaterThan(0);
        expect(ambig.distAtFinish).toBeCloseTo(plain.distAtFinish, 6);
        expect(ambig.inBbox).toBeCloseTo(plain.inBbox, 6);
        expect(ambig.ddbCn).toBeCloseTo(plain.ddbCn, 6);
    });

    test('ambiguous defaults to false — omitting it scores identically to today', () => {
        const explicit = scoreSignals(baseSignals({deltaStart: 0, ambiguous: false}));
        const omitted = scoreSignals(baseSignals({deltaStart: 0}));
        expect(explicit.total).toBeCloseTo(omitted.total, 6);
    });

    test('low in-bbox ratio kills the presence contribution entirely', () => {
        const goodRatio = scoreSignals(baseSignals({inBboxPackets: DEFAULT_INBBOX_FULL_COUNT, bboxRejectedPackets: 50}));
        const badRatio = scoreSignals(baseSignals({inBboxPackets: 100, bboxRejectedPackets: 1000}));
        expect(goodRatio.inBbox).toBeGreaterThan(0.3);
        expect(badRatio.inBbox).toBe(0);
    });

    test('pre-launch sighting only scores when ≥30 min before earliest pilot start', () => {
        const ref = 1700000000;
        const tooLate = scoreSignals(baseSignals({firstSeenT: ref - 10 * 60, earliestPilotStartUtc: ref}));
        const earlyEnough = scoreSignals(baseSignals({firstSeenT: ref - 35 * 60, earliestPilotStartUtc: ref}));
        expect(tooLate.preLaunch).toBe(0);
        expect(earlyEnough.preLaunch).toBeGreaterThan(0);
    });

    test('DDB CN match contributes its weight', () => {
        const b = scoreSignals(baseSignals({ddbCnMatch: true}));
        expect(b.ddbCn).toBeGreaterThan(0);
        expect(b.total).toBe(b.ddbCn);
    });

    test('DDB glider match is a weak signal, lower than CN', () => {
        const cn = scoreSignals(baseSignals({ddbCnMatch: true}));
        const glider = scoreSignals(baseSignals({ddbGliderMatch: true}));
        expect(glider.ddbGlider).toBeGreaterThan(0);
        expect(glider.ddbGlider).toBeLessThan(cn.ddbCn);
        expect(glider.total).toBe(glider.ddbGlider);
    });

    test('DDB CN and glider both fire and stack additively', () => {
        const both = scoreSignals(baseSignals({ddbCnMatch: true, ddbGliderMatch: true}));
        expect(both.total).toBeCloseTo(both.ddbCn + both.ddbGlider, 6);
    });

    test('clean both-side match with DDB and baseline produces a strong score', () => {
        const b = scoreSignals(
            baseSignals({
                deltaStart: -1,
                deltaFinish: 0,
                distAtStartKm: 0.05,
                gapAroundStartSec: 2,
                distAtFinishKm: 0.04,
                gapAroundFinishSec: 1,
                inBboxPackets: 800,
                bboxRejectedPackets: 30,
                firstSeenT: 1700000000 - 60 * 60,
                earliestPilotStartUtc: 1700000000,
                ddbCnMatch: true,
                baselineMatch: true
            })
        );
        // Expect comfortably above any reasonable auto-apply floor (0.8 nats).
        // Both dist signals are gated by the within-tolerance crossings, so
        // ≈ Δs 0.8 + Δf 1.0 + presence 0.48 + pre 0.3 + ddbCN 1.5 + base 1.0.
        expect(b.total).toBeGreaterThan(4.5);
    });

    test('missing signals contribute exactly 0 (no penalty for absence)', () => {
        const partialOnly = scoreSignals(baseSignals({deltaStart: 0, baselineMatch: true}));
        // deltaStart (1.0) + baseline (1.0) — nothing else.
        expect(partialOnly.total).toBeCloseTo(2.0, 6);
    });

    test('prior nats are added directly with default weight 1', () => {
        const withPrior = scoreSignals(baseSignals({priorNats: 1.5}));
        expect(withPrior.prior).toBeCloseTo(1.5, 6);
        expect(withPrior.total).toBeCloseTo(1.5, 6);
    });

    // ---- Cross-competition identity (single collapsed nats value) ----------
    test('xcNats is added with the xc weight (default 1) and nothing else', () => {
        const b = scoreSignals(baseSignals({xcNats: 1.4}));
        expect(b.xc).toBeCloseTo(TRACKER_SCORE_WEIGHTS.xc * 1.4, 6);
        expect(b.total).toBeCloseTo(TRACKER_SCORE_WEIGHTS.xc * 1.4, 6);
    });

    test('zero xcNats contributes nothing', () => {
        const b = scoreSignals(baseSignals({xcNats: 0}));
        expect(b.xc).toBe(0);
        expect(b.total).toBe(0);
    });

    test('xc stacks additively with same-comp signals', () => {
        const b = scoreSignals(baseSignals({deltaStart: 0, xcNats: 2.0}));
        expect(b.total).toBeCloseTo(1.0 + TRACKER_SCORE_WEIGHTS.xc * 2.0, 6);
    });
});

describe('negStart / negFinish in scoreSignals', () => {
    test('no crossing, no dist data → both zero', () => {
        const b = scoreSignals(baseSignals());
        expect(b.negStart).toBe(0);
        expect(b.negFinish).toBe(0);
    });

    test('within-tolerance crossing → negStart stays 0 (positive evidence wins)', () => {
        const b = scoreSignals(baseSignals({deltaStart: 0, distAtStartKm: 1.0, gapAroundStartSec: 10}));
        expect(b.negStart).toBe(0);
        expect(b.deltaStart).toBeGreaterThan(0);
    });

    test('wrong-time crossing (|Δ| > T_tol) with tight gap → negative negStart', () => {
        // Δ = T_tol + WRONG_CROSS_SCALE×T_tol/2 → wrongTimeFactor = 0.5
        const delta = DEFAULT_TOLERANCE_SEC + (WRONG_CROSS_SCALE * DEFAULT_TOLERANCE_SEC) / 2;
        const b = scoreSignals(baseSignals({deltaStart: delta, gapAroundStartSec: 0}));
        expect(b.negStart).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross * 0.5, 4);
    });

    test('wrong-time crossing saturates at |Δ| = (1+WRONG_CROSS_SCALE)×T_tol', () => {
        // At full saturation, wrongTimeFactor = 1; gapMod(0) = 1 → negStart = -negCross weight
        const saturated = (1 + WRONG_CROSS_SCALE) * DEFAULT_TOLERANCE_SEC;
        const b = scoreSignals(baseSignals({deltaStart: saturated, gapAroundStartSec: 0}));
        expect(b.negStart).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross, 4);

        // Beyond saturation the value is clamped
        const beyond = saturated * 5;
        const b2 = scoreSignals(baseSignals({deltaStart: beyond, gapAroundStartSec: 0}));
        expect(b2.negStart).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross, 4);
    });

    test('confirmed absent (dist > 2×D_tol, no crossing) → negStart = -weight × gapMod', () => {
        const farKm = 3 * DEFAULT_DIST_TOLERANCE_KM; // 1km > 2×0.3
        const gap = DEFAULT_GAP_MODULATION_SEC; // gapMod = 0.5
        const b = scoreSignals(baseSignals({distAtStartKm: farKm, gapAroundStartSec: gap}));
        // notHereFactor = 1, gapMod(30,30) = 0.5 → raw = -0.5 → weighted by negCross
        expect(b.negStart).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross * 0.5, 4);
    });

    test('Math.max: both strands fire, stronger one wins', () => {
        // wrongTimeFactor = 0.5 (Δ = midpoint), notHereFactor = 1 → max is 1
        const delta = DEFAULT_TOLERANCE_SEC + (WRONG_CROSS_SCALE * DEFAULT_TOLERANCE_SEC) / 2;
        const farKm = 3 * DEFAULT_DIST_TOLERANCE_KM;
        const b = scoreSignals(baseSignals({deltaStart: delta, distAtStartKm: farKm, gapAroundStartSec: 0}));
        // notHere wins; gapMod(0) = 1 → raw = -1 → weighted
        expect(b.negStart).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross, 4);
    });

    test('large gap attenuates the negative signal toward zero', () => {
        const farKm = 3 * DEFAULT_DIST_TOLERANCE_KM;
        const tight = scoreSignals(baseSignals({distAtStartKm: farKm, gapAroundStartSec: 1}));
        const wide = scoreSignals(baseSignals({distAtStartKm: farKm, gapAroundStartSec: 3000}));
        expect(tight.negStart).toBeLessThan(-0.1);
        expect(wide.negStart).toBeGreaterThan(-0.01); // large gap → gapMod near 0
    });

    test('null gapAroundStartSec → negStart ≈ 0 (no coverage info, gapMod(Infinity)→0)', () => {
        // Even with a wrong-time crossing, if gap is null the modulator collapses to 0.
        // gapMod(Infinity) = 1/(1+Infinity) = 0; result may be -0 vs 0 in IEEE 754.
        const delta = DEFAULT_TOLERANCE_SEC * 10;
        const b = scoreSignals(baseSignals({deltaStart: delta, gapAroundStartSec: null}));
        expect(Math.abs(b.negStart)).toBeCloseTo(0, 6);
    });

    test('negStart and negFinish are independent (symmetric behaviour)', () => {
        const delta = DEFAULT_TOLERANCE_SEC * 10;
        const bStart = scoreSignals(baseSignals({deltaStart: delta, gapAroundStartSec: 0}));
        const bFinish = scoreSignals(baseSignals({deltaFinish: delta, gapAroundFinishSec: 0}));
        expect(bStart.negStart).toBeLessThan(0);
        expect(bStart.negFinish).toBe(0);
        expect(bFinish.negFinish).toBeLessThan(0);
        expect(bFinish.negStart).toBe(0);
        // symmetric
        expect(bStart.negStart).toBeCloseTo(bFinish.negFinish, 6);
    });

    test('negStart / negFinish are excluded from physicalMatchScore', () => {
        const delta = DEFAULT_TOLERANCE_SEC * 10;
        const b = scoreSignals(baseSignals({deltaStart: delta, gapAroundStartSec: 0, deltaFinish: delta, gapAroundFinishSec: 0}));
        expect(b.negStart).toBeLessThan(0);
        expect(b.negFinish).toBeLessThan(0);
        expect(physicalMatchScore(b)).toBe(0); // no positive physical components
    });

    test('negative signals reduce the total (can drive it below zero)', () => {
        const delta = DEFAULT_TOLERANCE_SEC * 10;
        const b = scoreSignals(baseSignals({deltaStart: delta, gapAroundStartSec: 0, deltaFinish: delta, gapAroundFinishSec: 0}));
        expect(b.total).toBeLessThan(0);
    });
});

describe('negCrossScore', () => {
    test('all null → 0', () => {
        expect(negCrossScore(null, null, null, null, null, null)).toBe(0);
    });

    test('wrong-time start crossing at saturation → -(negCross weight)', () => {
        const saturated = (1 + WRONG_CROSS_SCALE) * DEFAULT_TOLERANCE_SEC;
        const score = negCrossScore(saturated, 0, null, null, null, null);
        expect(score).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross, 4);
    });

    test('confirmed absent on both sides adds both contributions', () => {
        const farKm = 3 * DEFAULT_DIST_TOLERANCE_KM;
        const score = negCrossScore(null, 0, farKm, null, 0, farKm);
        // Each side: notHereFactor=1, gapMod(0)=1 → raw=-1 → weight × -1 per side
        expect(score).toBeCloseTo(-2 * TRACKER_SCORE_WEIGHTS.negCross, 4);
    });

    test('within-tolerance crossing on start side → start contribution = 0', () => {
        const farKm = 3 * DEFAULT_DIST_TOLERANCE_KM;
        // deltaStart within tolerance: even though dist is far, crossing took priority
        const score = negCrossScore(0, 0, farKm, null, 0, farKm);
        // start is clear (within tol), finish is absent → only finish contributes
        expect(score).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross, 4);
    });

    test('gap modulation applies: large gap attenuates negative contribution', () => {
        const saturated = (1 + WRONG_CROSS_SCALE) * DEFAULT_TOLERANCE_SEC;
        const tightGap = negCrossScore(saturated, 0, null, null, null, null);
        const wideGap = negCrossScore(saturated, 3000, null, null, null, null);
        expect(tightGap).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.negCross, 4);
        expect(wideGap).toBeGreaterThan(-0.01); // almost zero
    });
});

describe('physicalMatchScore', () => {
    test('sums only the physical-track components, excluding prior/baseline/ddb/xc', () => {
        const b = scoreSignals(
            baseSignals({
                deltaStart: 0,
                deltaFinish: 0,
                distAtStartKm: 0,
                gapAroundStartSec: 0,
                inBboxPackets: DEFAULT_INBBOX_FULL_COUNT,
                bboxRejectedPackets: 0,
                firstSeenT: 1700000000 - 60 * 60,
                ddbCnMatch: true, // excluded from physical score
                baselineMatch: true, // excluded
                priorNats: 5, // excluded
                xcNats: 5 // excluded
            })
        );
        const physical = b.deltaStart + b.deltaFinish + b.distAtStart + b.distAtFinish + b.inBbox + b.preLaunch;
        expect(physicalMatchScore(b)).toBeCloseTo(physical, 6);
        // strictly less than the inflated total (which includes ddb/baseline/prior/xc)
        expect(physicalMatchScore(b)).toBeLessThan(b.total);
    });

    test('ogn cross-check fields are excluded', () => {
        const b = scoreSignals(baseSignals({ognDeltaStart: 0, ognDeltaFinish: 0, ognTaskDistKm: 300, officialDistKm: 300, ognAvgGapSec: 5}));
        expect(b.total).toBeGreaterThan(0);
        expect(physicalMatchScore(b)).toBe(0);
    });
});

describe('ogn daemon cross-check in scoreSignals', () => {
    // Good coverage (below the GOOD knee) so covFactor = 1 unless a test says otherwise.
    const goodCov = {ognAvgGapSec: 5};

    test('all-null ogn fields are a no-op', () => {
        const b = scoreSignals(baseSignals());
        expect(b.ognStart).toBe(0);
        expect(b.ognFinish).toBe(0);
        expect(b.ognDist).toBe(0);
        expect(b.total).toBe(0);
    });

    test('full agreement on both times and distance', () => {
        const b = scoreSignals(baseSignals({...goodCov, ognDeltaStart: 0, ognDeltaFinish: 0, ognTaskDistKm: 300, officialDistKm: 300}));
        expect(b.ognStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime, 6);
        expect(b.ognFinish).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime, 6);
        expect(b.ognDist).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognDist, 6);
        expect(b.total).toBeCloseTo(2 * TRACKER_SCORE_WEIGHTS.ognTime + TRACKER_SCORE_WEIGHTS.ognDist, 6);
    });

    test('positive time knee: half support at half the knee, zero at the knee, sign-symmetric', () => {
        const half = OGN_CHECK_TIME_TOLERANCE_SEC / 2;
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: half})).ognStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime * 0.5, 6);
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: -half})).ognStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime * 0.5, 6);
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: OGN_CHECK_TIME_TOLERANCE_SEC})).ognStart).toBe(0);
    });

    test('dead zone between the positive knee and the negative onset scores exactly 0', () => {
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: 100})).ognStart).toBe(0);
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: OGN_CHECK_NEG_ONSET_SEC})).ognStart).toBe(0);
    });

    test('negative path: ramps past the onset, saturates, clamps beyond', () => {
        const w = TRACKER_SCORE_WEIGHTS.ognTime;
        const satPoint = (1 + OGN_CHECK_NEG_SCALE) * OGN_CHECK_NEG_ONSET_SEC;
        const mid = (OGN_CHECK_NEG_ONSET_SEC + satPoint) / 2;
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: mid})).ognStart).toBeCloseTo(-w * 0.5, 6);
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: satPoint})).ognStart).toBeCloseTo(-w, 6);
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaStart: satPoint * 10})).ognStart).toBeCloseTo(-w, 6);
        expect(scoreSignals(baseSignals({...goodCov, ognDeltaFinish: satPoint})).ognFinish).toBeCloseTo(-w, 6);
    });

    test('within-tolerance replay crossing suppresses the daemon signal on that side, both directions', () => {
        // agreement suppressed (would double-count the crossing)
        const agree = scoreSignals(baseSignals({...goodCov, deltaStart: 0, ognDeltaStart: 0}));
        expect(agree.deltaStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.deltaStart, 6);
        expect(agree.ognStart).toBe(0);
        // disagreement suppressed (can only be a scoring-algorithm difference)
        const disagree = scoreSignals(baseSignals({...goodCov, deltaStart: 0, ognDeltaStart: 1000}));
        expect(disagree.ognStart).toBe(0);
        // an OUT-of-tolerance crossing does not suppress
        const outOfTol = scoreSignals(baseSignals({...goodCov, deltaStart: DEFAULT_TOLERANCE_SEC + 5, ognDeltaStart: 0}));
        expect(outOfTol.ognStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime, 6);
        // per-side: a start crossing does not affect the finish side
        const finishSide = scoreSignals(baseSignals({...goodCov, deltaStart: 0, ognDeltaFinish: 0}));
        expect(finishSide.ognFinish).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime, 6);
    });

    test('distance knee: relative above the absolute floor, floor below it, never negative', () => {
        // official 300 km -> knee = max(5, 15) = 15
        const rel = scoreSignals(baseSignals({...goodCov, ognTaskDistKm: 310, officialDistKm: 300}));
        expect(rel.ognDist).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognDist * (1 - 10 / (OGN_CHECK_DIST_REL * 300)), 6);
        // official 40 km -> knee = max(5, 2) = 5 (absolute floor)
        const abs = scoreSignals(baseSignals({...goodCov, ognTaskDistKm: 43, officialDistKm: 40}));
        expect(abs.ognDist).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognDist * (1 - 3 / OGN_CHECK_DIST_ABS_KM), 6);
        // gross disagreement scores 0, never negative
        const far = scoreSignals(baseSignals({...goodCov, ognTaskDistKm: 100, officialDistKm: 300}));
        expect(far.ognDist).toBe(0);
    });

    test('landout: both-no-finish contributes nothing on the finish side, distance still scores', () => {
        const b = scoreSignals(baseSignals({...goodCov, ognDeltaFinish: null, ognTaskDistKm: 123, officialDistKm: 123}));
        expect(b.ognFinish).toBe(0);
        expect(b.ognDist).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognDist, 6);
    });

    test('cross pairs are positive-only and scaled by the cross factor', () => {
        // a huge delta never goes negative on a cross pair
        const neg = scoreSignals(baseSignals({...goodCov, ognIsCross: true, ognDeltaStart: 10000}));
        expect(neg.ognStart).toBe(0);
        // agreement earns the cross-scaled support
        const pos = scoreSignals(baseSignals({...goodCov, ognIsCross: true, ognDeltaStart: 0, ognTaskDistKm: 300, officialDistKm: 300}));
        expect(pos.ognStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime * OGN_CHECK_CROSS_FACTOR, 6);
        expect(pos.ognDist).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognDist * OGN_CHECK_CROSS_FACTOR, 6);
    });

    test('cross-pair support is diluted by the ambiguity divisor k; k is ignored on assigned pairs', () => {
        const diluted = scoreSignals(baseSignals({...goodCov, ognIsCross: true, ognMatchCount: 4, ognDeltaStart: 0}));
        expect(diluted.ognStart).toBeCloseTo((TRACKER_SCORE_WEIGHTS.ognTime * OGN_CHECK_CROSS_FACTOR) / 4, 6);
        const assigned = scoreSignals(baseSignals({...goodCov, ognMatchCount: 4, ognDeltaStart: 0}));
        expect(assigned.ognStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime, 6);
    });
});

describe('ognCoverageFactor', () => {
    test('shape: 1 at or below GOOD, linear between, 0 at or above BAD, 0 at null', () => {
        expect(ognCoverageFactor(null)).toBe(0);
        expect(ognCoverageFactor(0)).toBe(1);
        expect(ognCoverageFactor(OGN_CHECK_COVERAGE_GOOD_GAP_SEC)).toBe(1);
        const mid = (OGN_CHECK_COVERAGE_GOOD_GAP_SEC + OGN_CHECK_COVERAGE_BAD_GAP_SEC) / 2;
        expect(ognCoverageFactor(mid)).toBeCloseTo(0.5, 6);
        expect(ognCoverageFactor(OGN_CHECK_COVERAGE_BAD_GAP_SEC)).toBe(0);
        expect(ognCoverageFactor(OGN_CHECK_COVERAGE_BAD_GAP_SEC * 5)).toBe(0);
    });

    test('scales the ogn supports on both signs; replay signals are unaffected', () => {
        const mid = (OGN_CHECK_COVERAGE_GOOD_GAP_SEC + OGN_CHECK_COVERAGE_BAD_GAP_SEC) / 2;
        const pos = scoreSignals(baseSignals({ognAvgGapSec: mid, ognDeltaStart: 0}));
        expect(pos.ognStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.ognTime * 0.5, 6);
        const satPoint = (1 + OGN_CHECK_NEG_SCALE) * OGN_CHECK_NEG_ONSET_SEC;
        const neg = scoreSignals(baseSignals({ognAvgGapSec: mid, ognDeltaStart: satPoint}));
        expect(neg.ognStart).toBeCloseTo(-TRACKER_SCORE_WEIGHTS.ognTime * 0.5, 6);
        // no measurable track -> no ogn evidence even with perfect agreement
        const none = scoreSignals(baseSignals({ognAvgGapSec: null, ognDeltaStart: 0, ognTaskDistKm: 300, officialDistKm: 300}));
        expect(none.ognStart).toBe(0);
        expect(none.ognDist).toBe(0);
        // the replay crossing signal does not depend on ognAvgGapSec
        const replay = scoreSignals(baseSignals({ognAvgGapSec: null, deltaStart: 0}));
        expect(replay.deltaStart).toBeCloseTo(TRACKER_SCORE_WEIGHTS.deltaStart, 6);
    });
});

describe('ognSignalsFrom', () => {
    const daemon: OgnDaemonPilot = {utcStart: 1000, utcFinish: 5000, taskDistanceKm: 300};
    const official = {startUtc: 990, finishUtc: 5020, distanceKm: 305};

    test('missing daemon or official -> all null', () => {
        expect(ognSignalsFrom(undefined, official, false)).toEqual(OGN_SIGNALS_NONE);
        expect(ognSignalsFrom(null, official, false)).toEqual(OGN_SIGNALS_NONE);
        expect(ognSignalsFrom(daemon, undefined, false)).toEqual(OGN_SIGNALS_NONE);
    });

    test('signed deltas, daemon minus official', () => {
        const f = ognSignalsFrom(daemon, official, false);
        expect(f.ognDeltaStart).toBe(10);
        expect(f.ognDeltaFinish).toBe(-20);
        expect(f.ognTaskDistKm).toBe(300);
        expect(f.officialDistKm).toBe(305);
    });

    test('landout both-no-finish: finish delta null, distance kept', () => {
        const f = ognSignalsFrom({utcStart: 1000, utcFinish: null, taskDistanceKm: 123}, {startUtc: 990, finishUtc: null, distanceKm: 123}, false);
        expect(f.ognDeltaStart).toBe(10);
        expect(f.ognDeltaFinish).toBeNull();
        expect(f.ognTaskDistKm).toBe(123);
        expect(f.officialDistKm).toBe(123);
    });

    test('one-sided finish -> null, both directions', () => {
        expect(ognSignalsFrom(daemon, {...official, finishUtc: null}, false).ognDeltaFinish).toBeNull();
        expect(ognSignalsFrom({...daemon, utcFinish: null}, official, false).ognDeltaFinish).toBeNull();
    });

    test('commonStart (grandprix) nulls the start delta only', () => {
        const f = ognSignalsFrom(daemon, official, true);
        expect(f.ognDeltaStart).toBeNull();
        expect(f.ognDeltaFinish).toBe(-20);
        expect(f.ognTaskDistKm).toBe(300);
    });

    test('unset daemon start and non-positive official distance -> null', () => {
        expect(ognSignalsFrom({...daemon, utcStart: null}, official, false).ognDeltaStart).toBeNull();
        expect(ognSignalsFrom(daemon, {...official, distanceKm: 0}, false).officialDistKm).toBeNull();
        expect(ognSignalsFrom(daemon, {...official, distanceKm: null}, false).officialDistKm).toBeNull();
    });
});

describe('ognRawSupport / ognMatchCount', () => {
    test('gaggle: a start-only triple matches every pilot sharing the start time', () => {
        const daemon: OgnDaemonPilot = {utcStart: 1000, utcFinish: 5000, taskDistanceKm: null};
        // 10 pilots share the start within the knee; finishes are all far from the daemon's
        const officials = Array.from({length: 10}, (_, i) => ({startUtc: 1000, finishUtc: 20000 + i * 1000, distanceKm: null}));
        expect(ognMatchCount(daemon, officials, false)).toBe(10);
    });

    test('finish+distance agreement is discriminating: exactly one match -> k=1', () => {
        const daemon: OgnDaemonPilot = {utcStart: 1000, utcFinish: 5000, taskDistanceKm: 300};
        const officials = [
            {startUtc: 1000, finishUtc: 5000, distanceKm: 300},
            {startUtc: 1000, finishUtc: 9000, distanceKm: 100},
            {startUtc: 1000, finishUtc: 12000, distanceKm: 150}
        ];
        // all three share the start, but only the first clears the floor on finish+distance too
        expect(ognMatchCount(daemon, officials, true)).toBe(1); // commonStart drops the shared start
    });

    test('unique landout distance-only match -> k=1', () => {
        const daemon: OgnDaemonPilot = {utcStart: 1000, utcFinish: null, taskDistanceKm: 123};
        const officials = [
            {startUtc: 90000, finishUtc: null, distanceKm: 123},
            {startUtc: 90000, finishUtc: null, distanceKm: 400}
        ];
        expect(ognMatchCount(daemon, officials, false)).toBe(1);
    });

    test('floor boundary on the raw support', () => {
        const daemon: OgnDaemonPilot = {utcStart: 1000, utcFinish: null, taskDistanceKm: null};
        // support 0.5 at half the knee (counts), just under at one second more (does not)
        const atFloor = {startUtc: 1000 - OGN_CHECK_TIME_TOLERANCE_SEC / 2, finishUtc: null, distanceKm: null};
        const underFloor = {startUtc: 1000 - OGN_CHECK_TIME_TOLERANCE_SEC / 2 - 1, finishUtc: null, distanceKm: null};
        expect(ognRawSupport(ognSignalsFrom(daemon, atFloor, false))).toBeCloseTo(OGN_CHECK_CROSS_MATCH_FLOOR, 6);
        expect(ognMatchCount(daemon, [{startUtc: 1000, finishUtc: null, distanceKm: null}, atFloor], false)).toBe(2);
        expect(ognMatchCount(daemon, [{startUtc: 1000, finishUtc: null, distanceKm: null}, underFloor], false)).toBe(1);
    });

    test('no matches still returns k=1', () => {
        const daemon: OgnDaemonPilot = {utcStart: 1000, utcFinish: null, taskDistanceKm: null};
        expect(ognMatchCount(daemon, [{startUtc: 90000, finishUtc: null, distanceKm: null}], false)).toBe(1);
    });
});

describe('computeMargins', () => {
    test('chosen − best alternatives, min of two sides', () => {
        const m = computeMargins({chosenScore: 4.0, bestOtherFlarmidForPilot: 1.0, bestOtherPilotForFlarmid: 2.5});
        expect(m.pilotMargin).toBe(3.0);
        expect(m.flarmidMargin).toBe(1.5);
        expect(m.margin).toBe(1.5);
    });

    test('zero alternatives → margin equals chosen score', () => {
        const m = computeMargins({chosenScore: 2.0, bestOtherFlarmidForPilot: 0, bestOtherPilotForFlarmid: 0});
        expect(m.margin).toBe(2.0);
    });

    test('negative margin when alternative beats chosen — flagged as ambiguous downstream', () => {
        const m = computeMargins({chosenScore: 1.0, bestOtherFlarmidForPilot: 1.5, bestOtherPilotForFlarmid: 0});
        expect(m.pilotMargin).toBe(-0.5);
        expect(m.margin).toBe(-0.5);
    });
});

describe('inBboxRatio / passesCandidateFilter', () => {
    test('zero packets → ratio 0, fails filter', () => {
        const s = {inBboxPackets: 0, bboxRejectedPackets: 0};
        expect(inBboxRatio(s)).toBe(0);
        expect(passesCandidateFilter(s)).toBe(false);
    });

    test('mostly-out-of-bbox flarmid fails the filter', () => {
        const s = {inBboxPackets: 100, bboxRejectedPackets: 1000};
        expect(passesCandidateFilter(s)).toBe(false);
    });

    test('mostly-in-bbox flarmid passes the filter', () => {
        const s = {inBboxPackets: 800, bboxRejectedPackets: 50};
        expect(passesCandidateFilter(s)).toBe(true);
    });
});

describe('crossingScore', () => {
    test('no crossings (both null) → 0', () => {
        expect(crossingScore(null, null)).toBe(0);
    });

    test('both crossings spot-on → capped at MAX_PRIOR_PER_DAY_NATS', () => {
        // sStart = sFinish = 1, weighted sum = 2, capped to 1.
        expect(crossingScore(0, 0)).toBeCloseTo(MAX_PRIOR_PER_DAY_NATS, 6);
    });

    test('one-sided start crossing → just that side, ≤ cap', () => {
        // sStart=1 (weight 1), finish absent → 1.0; still ≤ cap.
        expect(crossingScore(0, null)).toBeCloseTo(Math.min(MAX_PRIOR_PER_DAY_NATS, TRACKER_SCORE_WEIGHTS.deltaStart), 6);
    });

    test('crossing at the tolerance knee contributes 0', () => {
        expect(crossingScore(DEFAULT_TOLERANCE_SEC, null)).toBeCloseTo(0, 6);
    });

    test('partial crossings below the cap sum linearly', () => {
        // |Δ| = half the knee → support 0.5 on each side; 0.5+0.5 = 1.0 (= cap).
        const half = DEFAULT_TOLERANCE_SEC / 2;
        expect(crossingScore(half, half)).toBeCloseTo(MAX_PRIOR_PER_DAY_NATS, 6);
        // A single half-knee crossing stays well under the cap.
        expect(crossingScore(half, null)).toBeCloseTo(0.5 * TRACKER_SCORE_WEIGHTS.deltaStart, 6);
    });
});

describe('summarisePrior', () => {
    test('zero rows → zero prior', () => {
        expect(summarisePrior([])).toBe(0);
    });

    test('single row contributes its full score regardless of age', () => {
        expect(summarisePrior([{scoreNats: 0.8, taskDaysAgo: 0}])).toBeCloseTo(0.8, 6);
        expect(summarisePrior([{scoreNats: 0.8, taskDaysAgo: 10}])).toBeCloseTo(0.8, 6);
    });

    test('repeated confirmations sum directly without decay', () => {
        const total = summarisePrior([
            {scoreNats: 0.6, taskDaysAgo: 1},
            {scoreNats: 0.8, taskDaysAgo: 2},
            {scoreNats: 1.0, taskDaysAgo: 3}
        ]);
        expect(total).toBeCloseTo(2.4, 6);
    });

    test("negative ages (future rows, shouldn't happen) are ignored", () => {
        const total = summarisePrior([
            {scoreNats: 1.0, taskDaysAgo: -1},
            {scoreNats: 0.7, taskDaysAgo: 0}
        ]);
        expect(total).toBeCloseTo(0.7, 6);
    });

    test('positive total is capped at MAX_TOTAL_PRIOR_NATS', () => {
        const rows = Array.from({length: 10}, (_, i) => ({scoreNats: MAX_PRIOR_PER_DAY_NATS, taskDaysAgo: i + 1}));
        expect(summarisePrior(rows)).toBeCloseTo(MAX_TOTAL_PRIOR_NATS, 6);
    });

    test('negative total is capped at -MAX_TOTAL_PRIOR_NATS', () => {
        const rows = Array.from({length: 10}, (_, i) => ({scoreNats: -MAX_PRIOR_PER_DAY_NATS, taskDaysAgo: i + 1}));
        expect(summarisePrior(rows)).toBeCloseTo(-MAX_TOTAL_PRIOR_NATS, 6);
    });

    test('mixed positive and negative rows combine before cap', () => {
        // 2 good days then 1 bad day: net = 2*1.0 + 1*(-0.5) = 1.5 (under cap)
        const total = summarisePrior([
            {scoreNats: 1.0, taskDaysAgo: 3},
            {scoreNats: 1.0, taskDaysAgo: 2},
            {scoreNats: -0.5, taskDaysAgo: 1}
        ]);
        expect(total).toBeCloseTo(1.5, 6);
    });
});

describe('contentionPenalty', () => {
    const key = (c: string, f: string) => `${c}|${f}`;

    test('no competitor → nobody penalised', () => {
        const out = contentionPenalty([{compno: 'AA', flarmid: 'F1', total: 5, baseline: true}], key);
        expect(out.size).toBe(0);
    });

    test('confident baseline holder protects flarmid; weaker contender penalised', () => {
        const out = contentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
                {compno: 'BB', flarmid: 'F1', total: 2, baseline: false}
            ],
            key
        );
        expect(out.has('BB|F1')).toBe(true);
        expect(out.has('AA|F1')).toBe(false);
    });

    test('baseline below threshold does not protect — best-this-run holder used instead', () => {
        // AA is baseline but weak (≤ threshold); BB is the strong run winner.
        const out = contentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: 1, baseline: true},
                {compno: 'BB', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: false}
            ],
            key
        );
        expect(out.has('AA|F1')).toBe(true); // weak baseline contender is penalised
        expect(out.has('BB|F1')).toBe(false); // strong run winner holds it
    });

    test('baseline precedence: protected even when a contender scores higher', () => {
        const out = contentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
                {compno: 'BB', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 5, baseline: false}
            ],
            key
        );
        expect(out.has('BB|F1')).toBe(true); // higher-scoring contender still loses to baseline
        expect(out.has('AA|F1')).toBe(false);
    });

    test('no holder clears the threshold → nobody penalised', () => {
        const out = contentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: 2, baseline: true},
                {compno: 'BB', flarmid: 'F1', total: 2.5, baseline: false}
            ],
            key
        );
        expect(out.size).toBe(0);
    });

    test('independent flarmids do not cross-penalise', () => {
        const out = contentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
                {compno: 'BB', flarmid: 'F1', total: 2, baseline: false},
                {compno: 'CC', flarmid: 'F2', total: 5, baseline: true}
            ],
            key
        );
        expect(out.has('BB|F1')).toBe(true);
        expect(out.has('CC|F2')).toBe(false);
        expect(out.size).toBe(1);
    });
});

describe('pilotContentionPenalty', () => {
    const key = (c: string, f: string) => `${c}|${f}`;

    test('single claim per pilot → nobody penalised', () => {
        const out = pilotContentionPenalty([{compno: 'AA', flarmid: 'F1', total: 5, baseline: true}], key);
        expect(out.size).toBe(0);
    });

    test('confident pilot-holder demotes that pilot’s other claims', () => {
        const out = pilotContentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
                {compno: 'AA', flarmid: 'F2', total: 2, baseline: false}
            ],
            key
        );
        expect(out.has('AA|F2')).toBe(true);
        expect(out.has('AA|F1')).toBe(false);
    });

    test('baseline precedence: held even when another of the pilot’s claims scores higher', () => {
        const out = pilotContentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
                {compno: 'AA', flarmid: 'F2', total: PRIOR_PROTECT_NATS + 5, baseline: false}
            ],
            key
        );
        expect(out.has('AA|F2')).toBe(true);
        expect(out.has('AA|F1')).toBe(false);
    });

    test('no claim clears the threshold → nobody penalised', () => {
        const out = pilotContentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: 2, baseline: true},
                {compno: 'AA', flarmid: 'F2', total: 2.5, baseline: false}
            ],
            key
        );
        expect(out.size).toBe(0);
    });

    test('multi-unit pilot: the second baseline flarmid is never penalised', () => {
        const out = pilotContentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 2, baseline: true},
                {compno: 'AA', flarmid: 'F2', total: 1, baseline: true},
                {compno: 'AA', flarmid: 'F3', total: 1, baseline: false}
            ],
            key
        );
        expect(out.has('AA|F2')).toBe(false); // operator's statement, not a competing claim
        expect(out.has('AA|F3')).toBe(true);
    });

    test('independent pilots do not cross-penalise', () => {
        const out = pilotContentionPenalty(
            [
                {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
                {compno: 'AA', flarmid: 'F2', total: 2, baseline: false},
                {compno: 'BB', flarmid: 'F2', total: 2, baseline: false}
            ],
            key
        );
        expect(out.has('AA|F2')).toBe(true);
        expect(out.has('BB|F2')).toBe(false);
        expect(out.size).toBe(1);
    });
});

describe('applyContentionPenalties', () => {
    const key = (c: string, f: string) => `${c}|${f}`;

    test('union of both sides with per-key reasons; each key reported once', () => {
        // AA confidently holds F1 (baseline). BB weakly claims F1 (flarm-side
        // demotion) — and BB also confidently holds F2, so BB's F1 claim is
        // demoted from the pilot side too → 'both'.
        const pairs = [
            {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 2, baseline: true},
            {compno: 'BB', flarmid: 'F1', total: 2, baseline: false},
            {compno: 'BB', flarmid: 'F2', total: PRIOR_PROTECT_NATS + 1, baseline: true},
            {compno: 'CC', flarmid: 'F2', total: 1, baseline: false}
        ];
        const {penalised, reason} = applyContentionPenalties(pairs, key);
        expect(penalised.has('BB|F1')).toBe(true);
        expect(reason.get('BB|F1')).toBe('both');
        expect(penalised.has('CC|F2')).toBe(true);
        expect(reason.get('CC|F2')).toBe('flarm');
        expect(penalised.has('AA|F1')).toBe(false);
        expect(penalised.has('BB|F2')).toBe(false);
    });

    test('pilot-only demotion gets the pilot reason', () => {
        // AA confidently holds F1; AA's weak claim on F2 has no flarm-side
        // competitor, so only the pilot side demotes it.
        const pairs = [
            {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
            {compno: 'AA', flarmid: 'F2', total: 1.5, baseline: false}
        ];
        const {penalised, reason} = applyContentionPenalties(pairs, key);
        expect(penalised.has('AA|F2')).toBe(true);
        expect(reason.get('AA|F2')).toBe('pilot');
    });

    test('deterministic: both sets computed from pre-penalty totals (re-running on the same input is identical)', () => {
        const pairs = [
            {compno: 'AA', flarmid: 'F1', total: PRIOR_PROTECT_NATS + 1, baseline: true},
            {compno: 'BB', flarmid: 'F1', total: 2, baseline: false},
            {compno: 'BB', flarmid: 'F2', total: PRIOR_PROTECT_NATS + 1, baseline: true}
        ];
        const a = applyContentionPenalties(pairs, key);
        const b = applyContentionPenalties(pairs, key);
        expect([...a.penalised].sort()).toEqual([...b.penalised].sort());
    });
});
