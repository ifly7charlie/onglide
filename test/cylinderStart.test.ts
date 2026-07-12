import {describe, test, expect} from 'vitest';
import {classifyStartForCylinderStart} from '../lib/scoring/shared/tasks';
import {CYLINDER_START_MIN_RADIUS_KM} from '../lib/constants';

// classifyStartForCylinderStart takes a parsed start task_point (angles in
// radians, radii in metres — the shape every ScoringSource hands to
// upsertTaskAndLegs) and the minimum full-cylinder radius. It only ever runs
// for a competition that has opted into cylinder starts.

const toRad = (deg: number) => (deg * Math.PI) / 180;

// A full start cylinder is encoded as a full-circle sector: oz_angle1 == 0
// (the zero-angle cylinder marker) with a radius and no second radius.
const cylinder = (radiusKm: number, angleDeg = 0) => ({
    oz_line: false,
    oz_radius1: radiusKm * 1000,
    oz_radius2: 0,
    oz_angle1: toRad(angleDeg),
    multiple_start: 0,
    point_index: 0
});

const MIN = CYLINDER_START_MIN_RADIUS_KM;

describe('classifyStartForCylinderStart', () => {
    test('full cylinder at the minimum radius enables the PEV start', () => {
        expect(classifyStartForCylinderStart(cylinder(MIN), MIN)).toEqual({pevstart: 'Y', convertStartToLine: false});
    });

    test('full cylinder larger than the minimum enables the PEV start', () => {
        expect(classifyStartForCylinderStart(cylinder(MIN + 5), MIN)).toEqual({pevstart: 'Y', convertStartToLine: false});
    });

    test('full cylinder smaller than the minimum is converted to a line', () => {
        expect(classifyStartForCylinderStart(cylinder(MIN - 5), MIN)).toEqual({pevstart: 'N', convertStartToLine: true});
    });

    test('full cylinder just under the minimum is converted to a line', () => {
        expect(classifyStartForCylinderStart(cylinder(MIN - 0.01), MIN)).toEqual({pevstart: 'N', convertStartToLine: true});
    });

    test('a full cylinder encoded with a 180° apex angle is still recognised', () => {
        expect(classifyStartForCylinderStart(cylinder(MIN + 2, 180), MIN)).toEqual({pevstart: 'Y', convertStartToLine: false});
    });

    test('a start line keeps existing handling (no cylinder start, no conversion)', () => {
        const line = {oz_line: true, oz_radius1: 5000, oz_radius2: 0, oz_angle1: toRad(90), multiple_start: 0, point_index: 0};
        expect(classifyStartForCylinderStart(line, MIN)).toEqual({pevstart: 'N', convertStartToLine: false});
    });

    test('a partial start sector is not a full cylinder', () => {
        // 90° half-angle FAI-style sector with a large radius must NOT be
        // treated as a cylinder start even though it is big enough.
        const sector = {oz_line: false, oz_radius1: 20000, oz_radius2: 0, oz_angle1: toRad(90), multiple_start: 0, point_index: 0};
        expect(classifyStartForCylinderStart(sector, MIN)).toEqual({pevstart: 'N', convertStartToLine: false});
    });

    test('an annular OZ (with a second radius) is not treated as a full cylinder', () => {
        const annulus = {oz_line: false, oz_radius1: 15000, oz_radius2: 5000, oz_angle1: 0, multiple_start: 0, point_index: 0};
        expect(classifyStartForCylinderStart(annulus, MIN)).toEqual({pevstart: 'N', convertStartToLine: false});
    });

    test('a sector with no radius is not treated as a cylinder start', () => {
        const noRadius = {oz_line: false, oz_radius1: 0, oz_radius2: 0, oz_angle1: 0, multiple_start: 0, point_index: 0};
        expect(classifyStartForCylinderStart(noRadius, MIN)).toEqual({pevstart: 'N', convertStartToLine: false});
    });
});
