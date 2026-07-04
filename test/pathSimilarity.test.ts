import {describe, test, expect} from 'vitest';
import {sliceStream, classifyKind, resolveSameFlight, type SameFlightKind, type PathSimilarityResult} from '../lib/scoring/shared/pathSimilarity';
import type {FlarmID} from '../lib/types';
import type {PointStream, ShapePoint} from '../lib/flightprocessing/trackshape';

function makeStream(id: string, points: {t: number; a: number; lat: number; lng: number}[]): PointStream {
    return {id, points: points as ShapePoint[]};
}

describe('sliceStream', () => {
    const stream = makeStream('A', [
        {t: 100, a: 500, lat: 47.0, lng: 8.0},
        {t: 200, a: 510, lat: 47.1, lng: 8.1},
        {t: 300, a: 520, lat: 47.2, lng: 8.2},
        {t: 400, a: 530, lat: 47.3, lng: 8.3}
    ]);

    test('returns points within the range (inclusive)', () => {
        const result = sliceStream(stream, 150, 350);
        expect(result.points.map((p) => p.t)).toEqual([200, 300]);
    });

    test('preserves stream id', () => {
        const result = sliceStream(stream, 100, 400);
        expect(result.id).toBe('A');
    });

    test('returns all points when range covers full span', () => {
        const result = sliceStream(stream, 100, 400);
        expect(result.points).toHaveLength(4);
    });

    test('returns empty for out-of-range window', () => {
        const result = sliceStream(stream, 500, 600);
        expect(result.points).toHaveLength(0);
    });

    test('is inclusive on both bounds', () => {
        const result = sliceStream(stream, 200, 300);
        expect(result.points.map((p) => p.t)).toEqual([200, 300]);
    });
});

describe('classifyKind', () => {
    const same: SameFlightKind = 'same_flight';
    const different: SameFlightKind = 'different_flight';
    const insufficient: SameFlightKind = 'insufficient_data';

    test('matching → same_flight', () => expect(classifyKind('matching')).toBe(same));
    test('consistent_offset → same_flight', () => expect(classifyKind('consistent_offset')).toBe(same));
    test('diverged_abrupt → different_flight', () => expect(classifyKind('diverged_abrupt')).toBe(different));
    test('diverged_slow → different_flight', () => expect(classifyKind('diverged_slow')).toBe(different));
    test('very_different → different_flight', () => expect(classifyKind('very_different')).toBe(different));
    test('alignment_failed → different_flight', () => expect(classifyKind('alignment_failed')).toBe(different));
    test('insufficient_overlap → insufficient_data', () => expect(classifyKind('insufficient_overlap')).toBe(insufficient));
});

describe('resolveSameFlight (prior-evidence veto)', () => {
    const sim = (kind: SameFlightKind): PathSimilarityResult => ({
        flarmidA: 'AAA111' as FlarmID,
        flarmidB: 'BBB222' as FlarmID,
        kind,
        quickReport: null,
        fullReport: null,
        abortedAfterQuick: false
    });

    test('same_flight with no prior → join', () => {
        expect(resolveSameFlight(sim('same_flight')).action).toBe('join');
    });

    test('same_flight vetoed by ≥2 different and 0 same prior days → flag', () => {
        const d = resolveSameFlight(sim('same_flight'), {sameFlightDays: 0, differentFlightDays: 2});
        expect(d.action).toBe('flag');
        expect(d.priorVetoed).toBe(true);
    });

    test('one prior same_flight day defeats the veto → join', () => {
        expect(resolveSameFlight(sim('same_flight'), {sameFlightDays: 1, differentFlightDays: 3}).action).toBe('join');
    });

    test('a single prior different day is below threshold → join', () => {
        expect(resolveSameFlight(sim('same_flight'), {sameFlightDays: 0, differentFlightDays: 1}).action).toBe('join');
    });

    test('different_flight → none regardless of prior', () => {
        expect(resolveSameFlight(sim('different_flight'), {sameFlightDays: 5, differentFlightDays: 0}).action).toBe('none');
    });

    test('insufficient_data → none', () => {
        expect(resolveSameFlight(sim('insufficient_data')).action).toBe('none');
    });
});
