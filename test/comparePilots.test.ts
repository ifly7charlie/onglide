import {describe, test, expect} from 'vitest';
import {buildArcSpec, buildArc, buildVias, buildMeasure, pathMidpoint, distKm, type CompareTask, type CompareScore, type LngLatAlt} from '../lib/react/comparePilotsGeometry';

// A simple square-ish task: start, two turnpoints, finish. Leg lengths are the
// data the racing radius depends on (distanceRemaining minus the legs beyond the
// current turnpoint), so they're set to round numbers for exact arithmetic.
const legs: NonNullable<CompareTask['legs']> = [
    {nlng: 0, nlat: 0, length: 0}, //   0 start
    {nlng: 0, nlat: 1, length: 111}, // 1 TP1
    {nlng: 1, nlat: 1, length: 111}, // 2 TP2
    {nlng: 1, nlat: 0, length: 111} //  3 finish
];

describe('racing arcs', () => {
    test('radius = glider distance to the next turnpoint; the arc passes through the glider', () => {
        const gliderPos: LngLatAlt = [0.5, 1, 1000];
        const spec = buildArcSpec(false, legs, {currentLeg: 2}, gliderPos)!;

        // centre = next turnpoint (legs[2]); radius = geodesic distance glider→centre
        expect(spec.center).toEqual([1, 1]);
        expect(spec.radius).toBeCloseTo(distKm([1, 1], [0.5, 1]), 6);

        // the arc's glider-end (fromBearing) lands back on the glider
        const arc = buildArc(spec);
        expect(arc.arc2d[0][0]).toBeCloseTo(0.5, 4);
        expect(arc.arc2d[0][1]).toBeCloseTo(1, 4);

        // anchor sits on the track-line (C→prev = due west of TP2), short of the centre
        expect(spec.anchor[0]).toBeLessThan(1);
        expect(spec.anchor[1]).toBeCloseTo(1, 2);
    });

    test('same leg: measurement gap = difference in the two arc radii (no via points)', () => {
        const selPos: LngLatAlt = [0.3, 1, 1000]; // farther from TP2 (behind)
        const tgtPos: LngLatAlt = [0.6, 1, 1200]; // closer (ahead)
        const selSpec = buildArcSpec(false, legs, {currentLeg: 2}, selPos)!;
        const tgtSpec = buildArcSpec(false, legs, {currentLeg: 2}, tgtPos)!;

        expect(Math.abs(selSpec.radius - tgtSpec.radius)).toBeCloseTo(distKm([1, 1], [0.3, 1]) - distKm([1, 1], [0.6, 1]), 6);

        // same leg ⇒ no via points; measurement line is the bare radial segment
        expect(buildVias(false, legs, {currentLeg: 2}, 2, 2)).toEqual([]);
    });

    test('different legs: measurement routes through the intervening turnpoint centre', () => {
        // behind on leg 1 (more remaining), ahead on leg 2
        const vias = buildVias(false, legs, {currentLeg: 1}, 1, 2);
        expect(vias).toEqual([[0, 1]]); // legs[1] centre

        const measure = buildMeasure([0, 0.5, 1000], [1, 1, 1000], vias);
        expect(measure.measure2d).toEqual([[0, 0.5], [0, 1], [1, 1]]);
    });

    test('arc collapses to a point when the glider is at the turnpoint', () => {
        const spec = buildArcSpec(false, legs, {currentLeg: 2}, [1, 1, 1000])!; // sitting on TP2
        expect(spec.radius).toBeCloseTo(0, 6);
        expect(buildArc(spec).arc2d).toHaveLength(1); // degenerate → just the anchor
    });
});

describe('AAT arcs', () => {
    test('pivots backward on the previous turnpoint, with the scored point on the arc', () => {
        const score: CompareScore = {
            currentLeg: 2, // previous area turnpoint = legs[1] = (0,1)
            actual: {minPossible: 200},
            scoredPoints: [0.2, 0.9, 10, 0, 0.5, 1, 60, 0] // current scored point = last group (0.5,1)
        };
        const spec = buildArcSpec(true, legs, score, [0.4, 1, 1000])!;

        expect(spec.center).toEqual([0, 1]); // previous turnpoint legs[1], not the scored point
        expect(spec.anchor).toEqual([0.5, 1]); // the pilot's current scored point...
        expect(spec.radius).toBeCloseTo(distKm([0, 1], [0.5, 1]), 6); // ...ON the arc
        expect(spec.radius).toBeGreaterThan(50);
        expect(spec.toBearing).toBeGreaterThan(89);
        expect(spec.toBearing).toBeLessThan(91); // due east of the previous turnpoint

        // the arc's far end lands on the scored point
        const arc = buildArc(spec);
        expect(arc.arc2d[arc.arc2d.length - 1][0]).toBeCloseTo(0.5, 4);
        expect(arc.arc2d[arc.arc2d.length - 1][1]).toBeCloseTo(1, 4);
    });

    test('no arc (falls back to a direct connector) when there is no scored point or no previous turnpoint', () => {
        expect(buildArcSpec(true, legs, {currentLeg: 2}, [0.4, 1, 1000])).toBeNull(); // no scoredPoints
        expect(buildArcSpec(true, legs, {currentLeg: 0, scoredPoints: [0.5, 1, 60, 0]}, [0.4, 1, 1000])).toBeNull(); // no previous turnpoint
    });

    test('vias come from the behind pilot’s suggested track (current pos + finish dropped, count capped)', () => {
        // stride-4 [lng,lat,dist,hcap]: group0 = current pos, then aim points, last = finish
        const suggestedTrackPoints = [
            0.4, 1, 0, 0, //   current position
            0.6, 1, 10, 0, //  aim 1
            0.8, 1, 10, 0, //  aim 2
            1.0, 0, 10, 0 //   finish
        ];
        const behind: CompareScore = {suggestedTrackPoints};

        // two legs apart → both aim points, in order
        expect(buildVias(true, legs, behind, 1, 3)).toEqual([[0.6, 1], [0.8, 1]]);
        // one leg apart → capped to the first aim point
        expect(buildVias(true, legs, behind, 1, 2)).toEqual([[0.6, 1]]);
        // missing/short suggested track → no vias
        expect(buildVias(true, legs, {suggestedTrackPoints: [0, 0, 0, 0]}, 1, 3)).toEqual([]);
    });
});

describe('measurement line', () => {
    test('carries the height difference as a 3D riser', () => {
        const m = buildMeasure([0, 0, 1000], [1, 0, 1500], []);
        // 2D is the flat chord; 3D adds a riser up to the higher end
        expect(m.measure2d).toEqual([[0, 0], [1, 0]]);
        expect(m.measure3d.some((p) => p[2] === 1500)).toBe(true);
        expect(m.measure3d.some((p) => p[2] === 1000)).toBe(true);
    });

    test('label midpoint lies on the line', () => {
        const mid = pathMidpoint([[0, 0, 1000], [2, 0, 1000]]);
        expect(mid[0]).toBeCloseTo(1, 6);
        expect(mid[1]).toBeCloseTo(0, 6);
    });
});
