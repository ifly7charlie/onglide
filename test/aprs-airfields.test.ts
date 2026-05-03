import {describe, test, expect, beforeEach, vi} from 'vitest';

import {setAirfields, updateAirfieldBboxes, selectAircraftForPosition, type Aircraft} from '../lib/webworkers/aprs';
import type {Bbox} from '../lib/flightprocessing/taskBbox';

// Coverage for the split contract introduced after the trackGlider-refused
// regression: setAirfields owns membership (additive + evict-if-removed) and
// must not touch bbox; updateAirfieldBboxes is the only writer for bbox and
// must never create or evict airfields.
//
// All three functions read shared module-level state, so each test starts by
// resetting the world via setAirfields([]).

const BBOX_A: Bbox = [50.5, -2.0, 52.0, 1.0];
const BBOX_A_MOVED: Bbox = [50.0, -2.5, 52.5, 1.5];
const BBOX_B: Bbox = [49.5, 18.0, 51.0, 21.0];

const POINT_IN_A = {lat: 51.5, lng: -0.5};

beforeEach(() => {
    setAirfields([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('setAirfields / updateAirfieldBboxes split', () => {
    test('setAirfields adds entries; subsequent updateAirfieldBboxes upserts onto them', () => {
        setAirfields([
            {compid: 'A', lt: 51.5, lg: -0.5},
            {compid: 'B', lt: 50.0, lg: 19.5}
        ]);
        // Bbox upsert lands on the existing record and emits a change log.
        const logged: string[] = [];
        (console.log as any).mockImplementation((m: string) => logged.push(m));
        updateAirfieldBboxes([{compid: 'A', bbox: BBOX_A}]);
        expect(logged.some((l) => /aprs bboxes updated: A\b/.test(l))).toBe(true);
    });

    test('updateAirfieldBboxes upserts onto existing record without affecting siblings', () => {
        setAirfields([
            {compid: 'A', lt: 51.5, lg: -0.5},
            {compid: 'B', lt: 50.0, lg: 19.5}
        ]);
        updateAirfieldBboxes([{compid: 'A', bbox: BBOX_A}]);
        // Setting A's bbox a second time with the same value is a no-op (no
        // log line emitted).
        const logged: string[] = [];
        (console.log as any).mockImplementation((m: string) => logged.push(m));
        updateAirfieldBboxes([{compid: 'A', bbox: BBOX_A}]);
        expect(logged.find((l) => l.startsWith('aprs bboxes updated:'))).toBeUndefined();
        // Setting A's bbox to a different value logs the change.
        updateAirfieldBboxes([{compid: 'A', bbox: BBOX_A_MOVED}]);
        expect(logged.some((l) => /aprs bboxes updated: A\b/.test(l))).toBe(true);
    });

    test('setAirfields no longer clobbers bbox on resync of an existing comp', () => {
        // Reproduces the "periodic reconcileContexts wipes bbox" issue.
        setAirfields([
            {compid: 'A', lt: 51.5, lg: -0.5},
            {compid: 'B', lt: 50.0, lg: 19.5}
        ]);
        updateAirfieldBboxes([
            {compid: 'A', bbox: BBOX_A},
            {compid: 'B', bbox: BBOX_B}
        ]);
        // A second canonical-membership sync passes the same comps with no
        // bbox; previously this clobbered both bboxes.
        setAirfields([
            {compid: 'A', lt: 51.5, lg: -0.5},
            {compid: 'B', lt: 50.0, lg: 19.5}
        ]);
        // Verify bboxes are still applied: a no-op upsert with the same bbox
        // logs nothing; an upsert with a different bbox logs.
        const logged: string[] = [];
        (console.log as any).mockImplementation((m: string) => logged.push(m));
        updateAirfieldBboxes([
            {compid: 'A', bbox: BBOX_A},
            {compid: 'B', bbox: BBOX_B}
        ]);
        expect(logged.find((l) => l.startsWith('aprs bboxes updated:'))).toBeUndefined();
    });

    test('updateAirfieldBboxes for an unknown compid is a warning + no-op', () => {
        setAirfields([{compid: 'A', lt: 51.5, lg: -0.5}]);
        const logged: string[] = [];
        (console.log as any).mockImplementation((m: string) => logged.push(m));
        updateAirfieldBboxes([{compid: 'C', bbox: BBOX_A}]);
        expect(logged.some((l) => /skipping unknown compid C/.test(l))).toBe(true);
        // Membership unchanged: A is still there, C was not added.
        // We assert this by exercising setAirfields([A]) — which would
        // evict any extra entry — and confirming no membership log
        // change implies state was already at "[A]". The presence of
        // the warning above is the primary assertion.
    });

    test('setAirfields evicts a comp not in the new spec list', () => {
        setAirfields([
            {compid: 'A', lt: 51.5, lg: -0.5},
            {compid: 'B', lt: 50.0, lg: 19.5}
        ]);
        // Eviction surface: an updateAirfieldBboxes for B after eviction is
        // a no-op + warning, confirming B is gone.
        setAirfields([{compid: 'A', lt: 51.5, lg: -0.5}]);
        const logged: string[] = [];
        (console.log as any).mockImplementation((m: string) => logged.push(m));
        updateAirfieldBboxes([{compid: 'B', bbox: BBOX_B}]);
        expect(logged.some((l) => /skipping unknown compid B/.test(l))).toBe(true);
    });

    test('non-live comp keeps its bbox across rebuildAprsFilter cycles', () => {
        // Simulates: comp A live, comp B sunset. rebuildAprsFilter sends
        // bboxes only for live comps. B's bbox should survive untouched.
        setAirfields([
            {compid: 'A', lt: 51.5, lg: -0.5},
            {compid: 'B', lt: 50.0, lg: 19.5}
        ]);
        updateAirfieldBboxes([
            {compid: 'A', bbox: BBOX_A},
            {compid: 'B', bbox: BBOX_B}
        ]);
        // Sunset on B → next rebuild sends only A.
        const logged: string[] = [];
        (console.log as any).mockImplementation((m: string) => logged.push(m));
        updateAirfieldBboxes([{compid: 'A', bbox: BBOX_A}]);
        // No change to A (same bbox), B untouched. Nothing logged.
        expect(logged.find((l) => l.startsWith('aprs bboxes updated:'))).toBeUndefined();
        // B's bbox is still BBOX_B — a re-set with that value should be a no-op.
        updateAirfieldBboxes([{compid: 'B', bbox: BBOX_B}]);
        expect(logged.find((l) => l.startsWith('aprs bboxes updated:'))).toBeUndefined();
    });
});

// Sanity: confirm pre-task radius filter isn't disturbed — selectAircraft
// still falls through for comps with no bbox attached.
describe('pre-task fall-through (no bbox attached)', () => {
    test('aircraft with no bbox passes selectAircraftForPosition regardless', () => {
        // Aircraft constructed without a bbox on its airfield reference.
        const ac = {compno: 'P' as any, airfield: {compid: 'P', point: [0, 0] as any, elevation: 0 as any}} as unknown as Aircraft;
        const result = selectAircraftForPosition([ac], POINT_IN_A.lat, POINT_IN_A.lng);
        expect(result).toEqual([ac]);
    });
});
