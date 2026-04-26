/**
 * Sector geometry tests for PreparedTurnpoint.
 *
 * Tests both membership checking (scoring) and GeoJSON rendering for
 * all sector types: cylinder, wedge, sector+cylinder, and annular wedge.
 */
import {describe, test, expect} from 'vitest';
import {booleanPointInPolygon} from '@turf/boolean-point-in-polygon';
import {point as turfPoint} from '@turf/helpers';

import type {Epoch} from '../lib/types';
import {PreparedTurnpoint} from '../lib/flightprocessing/preparedTurnpoint';
import {makeAATTask} from './lib/taskFixtures';
import {pointAtBearingDistance} from './lib/flightFixtures';

// Task center point (Bicester-ish)
const CENTER = {lat: 52.0, lng: -1.0};

// Build a simple 3-leg task (start → TP → finish) where TP has the sector under test
function makeSectorTask(sectorDef: {
    r1: number;
    a1?: number;
    r2?: number;
    a2?: number;
    a12?: number;
    direction?: 'symmetrical' | 'np' | 'pp' | 'fixed';
}) {
    // Place TP 30km north of start so the task has a clear direction
    const tp = pointAtBearingDistance(CENTER, 0, 30);
    return makeAATTask({
        startLat: CENTER.lat,
        startLng: CENTER.lng,
        sectors: [{lat: tp.lat, lng: tp.lng, ...sectorDef}],
        minTimeSecs: 7200,
        startTime: 43200 as Epoch,
        startRadius: 5,
        finishRadius: 3
    });
}

// Get the PreparedTurnpoint for leg 1 (the test sector)
function getSectorTP(task: ReturnType<typeof makeSectorTask>): PreparedTurnpoint {
    return task.preparedLegs![1];
}

// Check if a point is inside the sector using the scoring membership check
function isInSector(pt: PreparedTurnpoint, lat: number, lng: number): boolean {
    // Use the public hasCrossedSector with a point at the same location
    // to test membership. Instead, access the private method via casting.
    return (pt as any)._insideSector(lat, lng);
}

// Check if a GeoJSON polygon contains a point
function geoJSONContains(pt: PreparedTurnpoint, lat: number, lng: number): boolean {
    const feature = pt.toGeoJSON();
    if (feature.geometry.type !== 'Polygon') return false;
    return booleanPointInPolygon(turfPoint([lng, lat]), feature.geometry);
}

// ── Simple cylinder ─────────────────────────────────────────────────────

describe('Simple cylinder (a1=180, r1=20km)', () => {
    const task = makeSectorTask({r1: 20, a1: 180});
    const tp = getSectorTP(task);
    const tpCenter = {lat: task.legs[1].nlat, lng: task.legs[1].nlng};

    test('point inside at various bearings', () => {
        for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
            const p = pointAtBearingDistance(tpCenter, bearing, 10);
            expect(isInSector(tp, p.lat, p.lng)).toBe(true);
        }
    });

    test('point outside beyond radius', () => {
        const p = pointAtBearingDistance(tpCenter, 0, 25);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
    });

    test('GeoJSON contains interior points', () => {
        const p = pointAtBearingDistance(tpCenter, 90, 10);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON excludes exterior points', () => {
        const p = pointAtBearingDistance(tpCenter, 90, 25);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });
});

// ── Simple wedge ────────────────────────────────────────────────────────

describe('Simple wedge (a1=45, r1=20km, symmetrical)', () => {
    const task = makeSectorTask({r1: 20, a1: 45, direction: 'symmetrical'});
    const tp = getSectorTP(task);
    const tpCenter = {lat: task.legs[1].nlat, lng: task.legs[1].nlng};

    test('point inside departure sector', () => {
        // Departure direction is away from start (approx north since TP is north of start)
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 10);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('point behind sector is outside', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 10);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
    });

    test('point beyond r1 is outside', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 25);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
    });

    test('point at edge of angular range', () => {
        // Just inside the 45° half-angle
        const p = pointAtBearingDistance(tpCenter, tp.departureMid + 40, 10);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
        // Just outside
        const p2 = pointAtBearingDistance(tpCenter, tp.departureMid + 50, 10);
        expect(isInSector(tp, p2.lat, p2.lng)).toBe(false);
    });

    test('GeoJSON matches scoring for interior', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 10);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON matches scoring for exterior', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 10);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });
});

// ── Sector + cylinder (Bicester pattern) ────────────────────────────────
//
// r1=20km departure ±90° + r2=0.5km approach ±90° (= full 360° coverage)
// This is the Calvert Rail Junction pattern where a2=90 in LSEEYOU.

describe('Sector + cylinder (a1=90, r1=20km, a2=90, r2=0.5km)', () => {
    const task = makeSectorTask({r1: 20, a1: 90, r2: 0.5, a2: 90, direction: 'symmetrical'});
    const tp = getSectorTP(task);
    const tpCenter = {lat: task.legs[1].nlat, lng: task.legs[1].nlng};

    test('point in departure lobe (10km forward)', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 10);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('point in approach lobe (0.3km behind)', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 0.3);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('point beyond r2 in approach direction is outside', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 5);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
    });

    test('point at 90° from departure within r2 is in sector (edge of both lobes)', () => {
        // At exactly the departure edge angle, within r2 distance
        const p = pointAtBearingDistance(tpCenter, tp.departureMid + 90, 0.3);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON contains point in approach direction within r2', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 0.3);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON excludes point beyond r2 in approach direction', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 5);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });

    test('GeoJSON contains point in departure direction', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 10);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });
});

// ── Sector + full cylinder (a2=180) ─────────────────────────────────────
//
// Same as above but a2=180 — approach is a full circle at r2.
// Should produce the same shaped polygon as a2=90 when a1=90.

describe('Sector + full cylinder (a1=90, r1=20km, a2=180, r2=0.5km)', () => {
    const task = makeSectorTask({r1: 20, a1: 90, r2: 0.5, a2: 180, direction: 'symmetrical'});
    const tp = getSectorTP(task);
    const tpCenter = {lat: task.legs[1].nlat, lng: task.legs[1].nlng};

    test('point in approach direction within r2 is in sector', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 0.3);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON contains approach-direction point within r2', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 0.3);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON excludes point beyond r2 in approach direction', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 5);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });
});

// ── AAT key-hole: narrow outer wedge + full inner cylinder ─────────────
//
// SoaringSpot/SeeYou AAT pattern: outer 90° pie (a1=45 half-angle) plus a
// full inner cylinder (a2=180 half-angle marker). a1=90 cases above can
// hide bugs because the half-discs combine into a full circle by symmetry;
// here a1≠90 means a half-disc rendering would leave the departure-side
// inside-r2 area uncovered.

describe('AAT key-hole (a1=45, r1=10km, a2=180, r2=0.5km)', () => {
    const task = makeSectorTask({r1: 10, a1: 45, r2: 0.5, a2: 180, direction: 'symmetrical'});
    const tp = getSectorTP(task);
    const tpCenter = {lat: task.legs[1].nlat, lng: task.legs[1].nlng};

    test('point inside r2 on the departure side is inside (full inner cylinder)', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 0.3);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('point inside r2 perpendicular to bisector is inside', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid + 90, 0.3);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('point inside r2 on the approach side is inside', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 0.3);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('point in outer wedge beyond r2 is inside', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 8);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('point beyond r2 outside the outer wedge is outside', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 5);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });
});

// ── Annular wedge (Bozeat pattern) ──────────────────────────────────────
//
// r1=80km, a1=20°, r2=10km, a12=50°, direction=fixed
// In the code, a12 is the APPROACH direction. The sector (departure lobe)
// points at departureMid = a12 + 180° = 230°. Sector edges at 230° ± 20° = 210°..250°.
// Scoring membership does NOT exclude r2 when a2=0 (r2 is a rendering-only boundary).

describe('Annular wedge (r1=80km, a1=20, r2=10km, a12=50, fixed)', () => {
    const task = makeSectorTask({r1: 80, a1: 20, r2: 10, a2: 0, a12: 50, direction: 'fixed'});
    const tp = getSectorTP(task);
    const tpCenter = {lat: task.legs[1].nlat, lng: task.legs[1].nlng};
    // departureMid should be a12 + 180 = 230°
    const sectorBearing = tp.departureMid;

    test('departure direction is a12 + 180', () => {
        expect(Math.abs(tp.departureMid - 230)).toBeLessThan(1);
    });

    test('point 50km in sector direction is inside', () => {
        const p = pointAtBearingDistance(tpCenter, sectorBearing, 50);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('point 5km in sector direction is inside (scoring ignores r2 when a2=0)', () => {
        const p = pointAtBearingDistance(tpCenter, sectorBearing, 5);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('point 50km perpendicular is outside (beyond angular range)', () => {
        const p = pointAtBearingDistance(tpCenter, sectorBearing + 90, 50);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
    });

    test('point just outside outer boundary is outside', () => {
        const p = pointAtBearingDistance(tpCenter, sectorBearing, 85);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
    });

    test('GeoJSON contains point in annular region (between r2 and r1)', () => {
        const p = pointAtBearingDistance(tpCenter, sectorBearing, 50);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON excludes point within inner radius', () => {
        const p = pointAtBearingDistance(tpCenter, sectorBearing, 5);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });

    test('GeoJSON excludes point outside angular range', () => {
        const p = pointAtBearingDistance(tpCenter, sectorBearing + 90, 50);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });
});

// ── Sector + small approach (a1+a2 < 180 gap case) ──────────────────────
//
// a1=45°, a2=45°, so a1+a2=90 < 180 — gap between departure and approach.
// This tests the center-point bridging path in the renderer.

describe('Sector with gap (a1=45, r1=20km, a2=45, r2=0.5km)', () => {
    const task = makeSectorTask({r1: 20, a1: 45, r2: 0.5, a2: 45, direction: 'symmetrical'});
    const tp = getSectorTP(task);
    const tpCenter = {lat: task.legs[1].nlat, lng: task.legs[1].nlng};

    test('point in departure lobe', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 10);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('point in approach lobe within r2', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 0.3);
        expect(isInSector(tp, p.lat, p.lng)).toBe(true);
    });

    test('point in gap between lobes is outside', () => {
        // 90° from departure — outside both lobes
        const p = pointAtBearingDistance(tpCenter, tp.departureMid + 90, 5);
        expect(isInSector(tp, p.lat, p.lng)).toBe(false);
    });

    test('GeoJSON contains departure lobe point', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid, 10);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON contains approach lobe point', () => {
        const p = pointAtBearingDistance(tpCenter, tp.approachMid, 0.3);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(true);
    });

    test('GeoJSON excludes point in gap', () => {
        const p = pointAtBearingDistance(tpCenter, tp.departureMid + 90, 5);
        expect(geoJSONContains(tp, p.lat, p.lng)).toBe(false);
    });
});
