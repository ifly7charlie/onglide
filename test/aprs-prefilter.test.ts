import {describe, test, expect} from 'vitest';

import {selectAircraftForPosition, type Aircraft} from '../lib/webworkers/aprs';
import type {Bbox} from '../lib/flightprocessing/taskBbox';

// Disjoint comp bboxes — comp A in southern England, comp B in southern Poland.
const BBOX_A: Bbox = [50.5, -2.0, 52.0, 1.0];
const BBOX_B: Bbox = [49.5, 18.0, 51.0, 21.0];

const POINT_IN_A = {lat: 51.5, lng: -0.5};
const POINT_IN_B = {lat: 50.0, lng: 19.5};
const POINT_IN_NEITHER = {lat: 47.0, lng: 8.0};

// Build the minimal Aircraft shape selectAircraftForPosition reads. The
// rest of the type is irrelevant to the bbox decision.
function makeAircraft(compid: string, bbox?: Bbox): Aircraft {
    return {
        compno: compid as any,
        airfield: {compid, point: [0, 0] as any, elevation: 0 as any, bbox}
    } as unknown as Aircraft;
}

describe('selectAircraftForPosition', () => {
    test('empty aircraft list returns empty (unknown FLARM path)', () => {
        expect(selectAircraftForPosition([], POINT_IN_A.lat, POINT_IN_A.lng)).toEqual([]);
    });

    test('out-of-bbox known tracker is dropped (no fallback)', () => {
        // Single comp A, point in neither — the bbox is a hard clip, so a
        // lone tracker outside its task bbox is dropped rather than delivered.
        const ac = makeAircraft('A', BBOX_A);
        const result = selectAircraftForPosition([ac], POINT_IN_NEITHER.lat, POINT_IN_NEITHER.lng);
        expect(result).toEqual([]);
    });

    test('multi-comp disjoint bboxes: only the matching comp receives', () => {
        const acA = makeAircraft('A', BBOX_A);
        const acB = makeAircraft('B', BBOX_B);
        const inA = selectAircraftForPosition([acA, acB], POINT_IN_A.lat, POINT_IN_A.lng);
        expect(inA).toEqual([acA]);
        const inB = selectAircraftForPosition([acA, acB], POINT_IN_B.lat, POINT_IN_B.lng);
        expect(inB).toEqual([acB]);
    });

    test('multi-comp overlapping bboxes: both receive', () => {
        // Two comps whose bboxes overlap on the point.
        const overlapBoxA: Bbox = [50.0, -2.0, 53.0, 5.0];
        const overlapBoxB: Bbox = [51.0, -1.0, 52.5, 3.0];
        const acA = makeAircraft('A', overlapBoxA);
        const acB = makeAircraft('B', overlapBoxB);
        const result = selectAircraftForPosition([acA, acB], 52.0, 1.0);
        expect(result).toEqual([acA, acB]);
    });

    test('pre-task comp (no bbox) always passes', () => {
        const acA = makeAircraft('A', BBOX_A);
        const acB = makeAircraft('B'); // no bbox
        // Point in A, not in B: A passes via bbox, B passes via no-bbox.
        const result = selectAircraftForPosition([acA, acB], POINT_IN_A.lat, POINT_IN_A.lng);
        expect(result).toEqual([acA, acB]);
    });

    test('all aircraft out of bbox → all dropped (hard clip)', () => {
        // Both have bboxes, neither contains the point: every aircraft is
        // outside its task area, so nothing is delivered.
        const acA = makeAircraft('A', BBOX_A);
        const acB = makeAircraft('B', BBOX_B);
        const result = selectAircraftForPosition([acA, acB], POINT_IN_NEITHER.lat, POINT_IN_NEITHER.lng);
        expect(result).toEqual([]);
    });
});
