import {describe, test, expect} from 'vitest';
import {
    scoreSignals,
    computeMargins,
    decayPrior,
    summarisePrior,
    crossingScore,
    contentionPenalty,
    pilotContentionPenalty,
    applyContentionPenalties,
    inBboxRatio,
    passesCandidateFilter,
    physicalMatchScore,
    type Signals
} from '../lib/scoring/shared/trackerScore';
import {
    DEFAULT_TOLERANCE_SEC,
    DEFAULT_DIST_TOLERANCE_KM,
    DEFAULT_INBBOX_FULL_COUNT,
    DEFAULT_PRIOR_DECAY_DAYS,
    AMBIGUOUS_DELTA_FACTOR,
    MAX_PRIOR_PER_DAY_NATS,
    PRIOR_PROTECT_NATS,
    TRACKER_SCORE_WEIGHTS
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

describe('decayPrior', () => {
    test('zero age preserves the score', () => {
        expect(decayPrior(2.0, 0)).toBe(2.0);
    });

    test('ages decay by the configured τ (default 4 days)', () => {
        const decayed = decayPrior(2.0, 4);
        expect(decayed).toBeCloseTo(2.0 / Math.E, 4);
    });

    test('large ages decay toward zero', () => {
        expect(decayPrior(2.0, 100)).toBeLessThan(0.001);
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

    test('single row at age 0 contributes its full per-day score', () => {
        expect(summarisePrior([{scoreNats: 0.8, taskDaysAgo: 0}])).toBeCloseTo(0.8, 6);
    });

    test('decay is exp(-ageDays / τ) with default τ', () => {
        const decayed = summarisePrior([{scoreNats: 1.0, taskDaysAgo: DEFAULT_PRIOR_DECAY_DAYS}]);
        expect(decayed).toBeCloseTo(1.0 / Math.E, 4);
    });

    test('repeated confirmations across days accumulate (each independently decayed)', () => {
        const total = summarisePrior([
            {scoreNats: 1.0, taskDaysAgo: 0},
            {scoreNats: 1.0, taskDaysAgo: DEFAULT_PRIOR_DECAY_DAYS},
            {scoreNats: 1.0, taskDaysAgo: 2 * DEFAULT_PRIOR_DECAY_DAYS}
        ]);
        expect(total).toBeCloseTo(1.0 + 1.0 / Math.E + 1.0 / (Math.E * Math.E), 4);
    });

    test("negative ages (future rows, shouldn't happen) are ignored", () => {
        const total = summarisePrior([
            {scoreNats: 1.0, taskDaysAgo: -1},
            {scoreNats: 0.7, taskDaysAgo: 0}
        ]);
        expect(total).toBeCloseTo(0.7, 4);
    });

    test('task-day decay ignores calendar gaps — a 4-task-day prior decays as 4 days regardless of intervening weather days', () => {
        // The caller computes taskDaysAgo from task-day rank deltas, so by
        // construction summarisePrior never sees the calendar gap.
        const a = summarisePrior([{scoreNats: 1.0, taskDaysAgo: 4}]);
        expect(a).toBeCloseTo(1.0 / Math.E, 4);
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
