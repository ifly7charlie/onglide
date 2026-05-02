import {describe, test, expect} from 'vitest';

import {pointInBbox, type Bbox} from '../lib/flightprocessing/taskBbox';

// Bbox convention: [minLat, minLng, maxLat, maxLng]
const box: Bbox = [50.0, -2.0, 53.0, 1.0];

describe('pointInBbox', () => {
    test('point inside the bbox returns true', () => {
        expect(pointInBbox(box, 51.5, -0.5)).toBe(true);
    });

    test('all four corners are inside (inclusive bounds)', () => {
        expect(pointInBbox(box, 50.0, -2.0)).toBe(true);
        expect(pointInBbox(box, 50.0, 1.0)).toBe(true);
        expect(pointInBbox(box, 53.0, -2.0)).toBe(true);
        expect(pointInBbox(box, 53.0, 1.0)).toBe(true);
    });

    test('just outside on each axis returns false', () => {
        expect(pointInBbox(box, 49.999, -0.5)).toBe(false); // S of minLat
        expect(pointInBbox(box, 53.001, -0.5)).toBe(false); // N of maxLat
        expect(pointInBbox(box, 51.5, -2.001)).toBe(false); // W of minLng
        expect(pointInBbox(box, 51.5, 1.001)).toBe(false); // E of maxLng
    });

    test('lat/lng arg order: passing lng first would falsely report inside', () => {
        // (lat=51.5, lng=-0.5) is inside; swapping would test (lat=-0.5,
        // lng=51.5) which is outside on both axes — confirms the helper
        // doesn't accidentally accept swapped args.
        expect(pointInBbox(box, -0.5, 51.5)).toBe(false);
    });

    test('bbox crossing the equator', () => {
        const equatorBox: Bbox = [-1.0, -1.0, 1.0, 1.0];
        expect(pointInBbox(equatorBox, 0, 0)).toBe(true);
        expect(pointInBbox(equatorBox, -0.5, 0.5)).toBe(true);
        expect(pointInBbox(equatorBox, 1.5, 0)).toBe(false);
    });
});
