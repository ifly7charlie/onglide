import {describe, test, expect} from 'vitest';

import {accumulateCompBbox, pointInBbox, type Bbox} from '../lib/flightprocessing/taskBbox';

// Bbox convention: [minLat, minLng, maxLat, maxLng].
//
// Models a comp running two classes from the same field: a short task
// (CLASS_A) and a longer one (CLASS_B) reaching further east. Both share one
// compid and one prefilter box in the worker, so the box must cover both.
const CLASS_A: Bbox = [50.5, -2.0, 52.0, 0.5];
const CLASS_B: Bbox = [50.5, -2.0, 52.0, 4.0];

// In CLASS_B's task area but east of CLASS_A — the point that regressed when
// the per-comp map overwrote instead of unioning (last class iterated won).
const POINT_IN_B_ONLY = {lat: 51.0, lng: 3.0};

describe('accumulateCompBbox', () => {
    test('first class for a comp stores its bbox as-is', () => {
        const map = new Map<string, Bbox>();
        accumulateCompBbox(map, 'comp1', CLASS_A);
        expect(map.get('comp1')).toEqual(CLASS_A);
    });

    test('second class unions in rather than overwriting', () => {
        const map = new Map<string, Bbox>();
        accumulateCompBbox(map, 'comp1', CLASS_A);
        accumulateCompBbox(map, 'comp1', CLASS_B);
        // Union spans both: east edge comes from B, everything else shared.
        expect(map.get('comp1')).toEqual([50.5, -2.0, 52.0, 4.0]);
    });

    test('a point in only the larger class survives the union', () => {
        const map = new Map<string, Bbox>();
        // Order independence: smaller class added last must not clip the box.
        accumulateCompBbox(map, 'comp1', CLASS_B);
        accumulateCompBbox(map, 'comp1', CLASS_A);
        const box = map.get('comp1')!;
        expect(pointInBbox(box, POINT_IN_B_ONLY.lat, POINT_IN_B_ONLY.lng)).toBe(true);
    });

    test('different comps stay independent', () => {
        const map = new Map<string, Bbox>();
        accumulateCompBbox(map, 'comp1', CLASS_A);
        accumulateCompBbox(map, 'comp2', CLASS_B);
        expect(map.get('comp1')).toEqual(CLASS_A);
        expect(map.get('comp2')).toEqual(CLASS_B);
    });
});
