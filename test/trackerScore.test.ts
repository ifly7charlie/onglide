import {describe, test, expect} from 'vitest';
import {scoreSignals, computeMargins, decayPrior, inBboxRatio, passesCandidateFilter, type Signals} from '../lib/scoring/shared/trackerScore';
import {DEFAULT_TOLERANCE_SEC, DEFAULT_DIST_TOLERANCE_KM, DEFAULT_INBBOX_FULL_COUNT} from '../lib/constants';

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
    ddbRegistrationMatch: false,
    baselineMatch: false,
    priorNats: 0,
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

    test('large bracketing gap suppresses the distance contribution', () => {
        const tight = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 1}));
        const wide = scoreSignals(baseSignals({distAtStartKm: 0.05, gapAroundStartSec: 120}));
        expect(wide.distAtStart).toBeLessThan(tight.distAtStart * 0.4);
    });

    test('distance contribution decays linearly to 0 at 2× knee', () => {
        const at0 = scoreSignals(baseSignals({distAtStartKm: 0, gapAroundStartSec: 0}));
        const atKnee = scoreSignals(baseSignals({distAtStartKm: DEFAULT_DIST_TOLERANCE_KM, gapAroundStartSec: 0}));
        const atDouble = scoreSignals(baseSignals({distAtStartKm: 2 * DEFAULT_DIST_TOLERANCE_KM, gapAroundStartSec: 0}));
        expect(at0.distAtStart).toBeCloseTo(1.0, 4);
        expect(atKnee.distAtStart).toBeCloseTo(0.5, 4);
        expect(atDouble.distAtStart).toBeCloseTo(0, 4);
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
        expect(b.total).toBeGreaterThan(5.0);
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
