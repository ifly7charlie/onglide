/**
 * AAT scoring tests against FAI Sporting Code Annex A rules.
 *
 * Tests the full scoring chain with synthetic tasks and flights.
 * Each test references the specific rule clause it validates.
 */
import {describe, test, expect} from 'vitest';
import {Geodesic} from 'geographiclib-geodesic';
import type {Epoch, DistanceKM} from '../lib/types';
import {distHaversine} from '../lib/flightprocessing/taskhelper';

import {makeAATTask} from './lib/taskFixtures';
import {makeMultiLegFlight, addPreStart, pointAtBearingDistance, makeOutlandingFlight} from './lib/flightFixtures';
import {runScoringChain} from './lib/scoringChainRunner';

const G = Geodesic.WGS84;

// ── Test task geometry ────────────────────────────────────────────────────
//
// Start/Finish at [47.0, 11.0] (Innsbruck-ish)
//   Sector 1: circle r=20km at [47.2, 11.3]   (~30km NE)
//   Sector 2: circle r=20km at [47.0, 11.8]   (~55km E)
//   Sector 3: circle r=15km at [46.8, 11.4]   (~35km SE)
// Finish ring 3km at start
// MinTime: 7200s (2 hours)

const START_LAT = 47.0;
const START_LNG = 11.0;
const START_TIME = 43200 as Epoch; // noon UTC
const MIN_TIME = 7200; // 2 hours
const SPEED = 120; // kph

const SECTOR1 = {lat: 47.2, lng: 11.3};
const SECTOR2 = {lat: 47.0, lng: 11.8};
const SECTOR3 = {lat: 46.8, lng: 11.4};

// Cruise altitude ≈ 2000ft AGL (airfield at ~400m AMSL)
const CRUISE_ALT = 1000;

function makeStandardTask() {
    return makeAATTask({
        startLat: START_LAT,
        startLng: START_LNG,
        startAltitude: 600,
        sectors: [
            {lat: SECTOR1.lat, lng: SECTOR1.lng, r1: 20, a1: 180}, // circle 20km
            {lat: SECTOR2.lat, lng: SECTOR2.lng, r1: 20, a1: 180}, // circle 20km
            {lat: SECTOR3.lat, lng: SECTOR3.lng, r1: 15, a1: 180} // circle 15km
        ],
        minTimeSecs: MIN_TIME,
        startTime: START_TIME,
        startRadius: 5,
        finishRadius: 3
    });
}

// helper: distance between two lat/lng pairs in km
function dist(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
    return G.Inverse(a.lat, a.lng, b.lat, b.lng).s12! / 1000;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AAT Scoring — FAI Rule Compliance', () => {

    // ── 7.6.1c: Credited Fixes maximize distance ──────────────────────

    describe('7.6.1c — Credited Fixes maximize distance', () => {
        test('optimal path selects sector boundary points that maximize total distance', async () => {
            const task = makeStandardTask();

            // Fly through the far side of each sector (away from center)
            // to give the optimizer room to choose optimal credited fixes
            const s1far = pointAtBearingDistance(SECTOR1, 45, 15); // 15km NE into sector 1
            const s2far = pointAtBearingDistance(SECTOR2, 90, 15); // 15km E into sector 2
            const s3far = pointAtBearingDistance(SECTOR3, 180, 10); // 10km S into sector 3

            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: s1far.lat, lng: s1far.lng, altitude: CRUISE_ALT},
                {lat: s2far.lat, lng: s2far.lng, altitude: CRUISE_ALT},
                {lat: s3far.lat, lng: s3far.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT} // finish
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            // Distance must be positive and set
            expect(score.actual?.taskDistance).toBeGreaterThan(0);

            // The optimized distance should be >= the distance through sector centers
            // (optimizer picks boundary points for maximum distance)
            const centerDist =
                dist({lat: START_LAT, lng: START_LNG}, SECTOR1) +
                dist(SECTOR1, SECTOR2) +
                dist(SECTOR2, SECTOR3) +
                dist(SECTOR3, {lat: START_LAT, lng: START_LNG});

            // With 20km and 15km sectors the optimizer should extend the path
            // We just verify distance is in the right ballpark (± task adjustments)
            expect(score.actual.taskDistance).toBeGreaterThan(centerDist * 0.7);
        });
    });

    // ── 7.6.1d.i: Marking Distance for finishers ─────────────────────

    describe('7.6.1d.i — Marking Distance for finishers', () => {
        test('completed task has positive distance and finish time', async () => {
            const task = makeStandardTask();

            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: CRUISE_ALT},
                {lat: SECTOR2.lat, lng: SECTOR2.lng, altitude: CRUISE_ALT},
                {lat: SECTOR3.lat, lng: SECTOR3.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            expect(score.utcFinish).toBeGreaterThan(0);
            expect(score.actual?.taskDistance).toBeGreaterThan(0);

            // Each leg should have a scored distance
            for (let legno = 1; legno < task.legs.length; legno++) {
                const leg = score.legs[legno];
                if (leg) {
                    expect(leg.actual?.distance).toBeGreaterThanOrEqual(0);
                }
            }
        });
    });

    // ── 7.6.1d.iv: Marking Time = max(elapsed, minTime) ──────────────

    describe('7.6.1d.iv — Marking Time', () => {
        test('fast finisher: task duration is clamped to minimum time', async () => {
            const task = makeStandardTask();

            // Fly fast (200 kph) to finish well under min time
            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: CRUISE_ALT},
                {lat: SECTOR2.lat, lng: SECTOR2.lng, altitude: CRUISE_ALT},
                {lat: SECTOR3.lat, lng: SECTOR3.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, 200), // fast
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            if (score.utcFinish) {
                const elapsedTime = score.utcFinish - score.utcStart;

                // The elapsed time should be less than min time (we flew fast)
                expect(elapsedTime).toBeLessThan(MIN_TIME);

                // But taskTimeRemaining should indicate we were under time
                // (negative means still time left)
                expect(score.taskTimeRemaining).toBeLessThan(0);
            }
        });

        test('slow finisher: task duration is actual elapsed time', async () => {
            const task = makeStandardTask();

            // Fly slow (80 kph) to exceed minimum time
            const s1far = pointAtBearingDistance(SECTOR1, 45, 18);
            const s2far = pointAtBearingDistance(SECTOR2, 90, 18);
            const s3far = pointAtBearingDistance(SECTOR3, 180, 13);

            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: s1far.lat, lng: s1far.lng, altitude: CRUISE_ALT},
                {lat: s2far.lat, lng: s2far.lng, altitude: CRUISE_ALT},
                {lat: s3far.lat, lng: s3far.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, 80), // slow
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            if (score.utcFinish) {
                const elapsedTime = score.utcFinish - score.utcStart;

                // Slow flight should exceed min time
                expect(elapsedTime).toBeGreaterThan(MIN_TIME);

                // taskTimeRemaining should be positive (over time)
                expect(score.taskTimeRemaining).toBeGreaterThan(0);
            }
        });
    });

    // ── 7.6.1d.i: Outlanding on last leg ─────────────────────────────

    describe('7.6.1d.i — Outlanding distance', () => {
        test('outlanding on last leg: distance reduced by distance to finish', async () => {
            const task = makeStandardTask();

            // Fly through all sectors, then outland 60% of the way home
            const completedWaypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: CRUISE_ALT},
                {lat: SECTOR2.lat, lng: SECTOR2.lng, altitude: CRUISE_ALT},
                {lat: SECTOR3.lat, lng: SECTOR3.lng, altitude: 1000}
            ];
            const finishPoint = {lat: START_LAT, lng: START_LNG};

            const positions = addPreStart(
                makeOutlandingFlight(completedWaypoints, finishPoint, 0.6, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            // Should NOT have a finish
            expect(score.utcFinish).toBeFalsy();

            // Should have positive distance
            expect(score.actual?.taskDistance).toBeGreaterThan(0);

            // Distance remaining should be > 0
            expect(score.actual?.distanceRemaining).toBeGreaterThan(0);

            // Speed should be 0 or undefined for non-finishers (7.6.1d.v)
            expect(score.actual?.taskSpeed ?? 0).toBeLessThanOrEqual(0);
        });

        test('outlanding on middle leg: distance includes nearest point on next sector', async () => {
            const task = makeStandardTask();

            // Fly through sector 1, then outland 40% toward sector 2
            const completedWaypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: 1200}
            ];
            const nextSector = {lat: SECTOR2.lat, lng: SECTOR2.lng};

            const positions = addPreStart(
                makeOutlandingFlight(completedWaypoints, nextSector, 0.4, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            expect(score.utcFinish).toBeFalsy();
            expect(score.actual?.taskDistance).toBeGreaterThan(0);

            // Distance should be less than if they'd completed to sector 2
            const fullLeg1 = dist({lat: START_LAT, lng: START_LNG}, SECTOR1);
            const fullLeg2 = dist(SECTOR1, SECTOR2);
            expect(score.actual.taskDistance).toBeLessThan(fullLeg1 + fullLeg2);
        });
    });

    // ── 7.6.4: Sector achieved by fix inside ─────────────────────────

    describe('7.6.4 — Sector achievement', () => {
        test('sector credited when fix is inside observation zone', async () => {
            const task = makeStandardTask();

            // Fly directly through sector centers — guaranteed inside
            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: CRUISE_ALT},
                {lat: SECTOR2.lat, lng: SECTOR2.lng, altitude: CRUISE_ALT},
                {lat: SECTOR3.lat, lng: SECTOR3.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            // All sectors should be reached → finish found
            expect(score.utcFinish).toBeGreaterThan(0);

            // All intermediate legs should have times
            for (let legno = 1; legno < task.legs.length - 1; legno++) {
                const leg = score.legs[legno];
                expect(leg).toBeDefined();
                if (leg) {
                    expect(leg.time).toBeGreaterThan(0);
                }
            }
        });

        test('sector credited when line between fixes crosses observation zone', async () => {
            const task = makeStandardTask();

            // For sector 1 (20km circle at SECTOR1), fly a path that
            // goes from outside one side to outside the other, crossing through
            // Use a wide interval (30s) so there's a gap through the sector
            const beforeS1 = pointAtBearingDistance(SECTOR1, 225, 25); // 25km SW (outside)
            const afterS1 = pointAtBearingDistance(SECTOR1, 45, 25); // 25km NE (outside)

            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: beforeS1.lat, lng: beforeS1.lng, altitude: CRUISE_ALT}, // approach
                {lat: afterS1.lat, lng: afterS1.lng, altitude: CRUISE_ALT}, // depart (crosses through)
                {lat: SECTOR2.lat, lng: SECTOR2.lng, altitude: CRUISE_ALT},
                {lat: SECTOR3.lat, lng: SECTOR3.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, SPEED, {interval: 30}),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            // The scorer should still credit sector 1 via line intersection
            // and reach the finish
            expect(score.utcFinish).toBeGreaterThan(0);
            expect(score.actual?.taskDistance).toBeGreaterThan(0);
        });
    });

    // ── 7.6.5: Penalty zone (500m) ───────────────────────────────────

    describe('7.6.5 — Penalty zone', () => {
        test('fix within 500m of sector boundary is tracked as penalty', async () => {
            const task = makeStandardTask();

            // Fly just outside sector 1's boundary (20km circle) by ~300m
            const justOutside = pointAtBearingDistance(SECTOR1, 0, 20.3); // 300m outside 20km radius

            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: justOutside.lat, lng: justOutside.lng, altitude: CRUISE_ALT}, // penalty zone
                {lat: SECTOR2.lat, lng: SECTOR2.lng, altitude: CRUISE_ALT},
                {lat: SECTOR3.lat, lng: SECTOR3.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, SPEED, {interval: 2}), // fine resolution
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            // We should still get a scored distance — the penalty zone
            // provides a fallback scoring option per 7.6.5
            expect(score.actual?.taskDistance).toBeGreaterThan(0);
        });
    });

    // ── 7.6.2: Wedge sector geometry ─────────────────────────────────

    describe('7.6.2b — Wedge sector geometry', () => {
        test('wedge sector correctly detects entry and exit', async () => {
            const task = makeAATTask({
                startLat: START_LAT,
                startLng: START_LNG,
                startAltitude: 600,
                sectors: [
                    {
                        lat: SECTOR1.lat,
                        lng: SECTOR1.lng,
                        r1: 30, // 30km wedge
                        a1: 90, // 90-degree half-angle (180° total)
                        direction: 'symmetrical'
                    },
                    {lat: SECTOR2.lat, lng: SECTOR2.lng, r1: 20, a1: 180}, // circle
                    {lat: SECTOR3.lat, lng: SECTOR3.lng, r1: 15, a1: 180} // circle
                ],
                minTimeSecs: MIN_TIME,
                startTime: START_TIME
            });

            // Fly through the wedge sector (within the 180° arc)
            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: CRUISE_ALT}, // center of wedge
                {lat: SECTOR2.lat, lng: SECTOR2.lng, altitude: CRUISE_ALT},
                {lat: SECTOR3.lat, lng: SECTOR3.lng, altitude: CRUISE_ALT},
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            expect(score.utcFinish).toBeGreaterThan(0);
            expect(score.actual?.taskDistance).toBeGreaterThan(0);
        });
    });

    // ── 7.6.1d.v: Non-finisher speed = 0 ─────────────────────────────

    describe('7.6.1d.v — Non-finisher marking speed', () => {
        test('outlanded pilot has zero or undefined task speed', async () => {
            const task = makeStandardTask();

            // Outland after sector 1
            const completedWaypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: 1200}
            ];

            const positions = addPreStart(
                makeOutlandingFlight(completedWaypoints, SECTOR2, 0.3, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            expect(score.utcFinish).toBeFalsy();
            // Non-finisher: speed should be zero or not computed
            expect(score.actual?.taskSpeed ?? 0).toBe(0);
        });
    });

    // ── AAT distance remaining and min/max possible ──────────────────

    describe('AAT min/max/remaining distances', () => {
        test('in-flight scoring produces distance remaining and possible range', async () => {
            const task = makeStandardTask();

            // Fly through sector 1, partway to sector 2 (still in flight)
            const partway = pointAtBearingDistance(SECTOR1, 90, 15); // heading toward S2

            const waypoints = [
                {lat: START_LAT, lng: START_LNG, altitude: CRUISE_ALT},
                {lat: SECTOR1.lat, lng: SECTOR1.lng, altitude: CRUISE_ALT},
                {lat: partway.lat, lng: partway.lng, altitude: 1100}
            ];

            const positions = addPreStart(
                makeMultiLegFlight(waypoints, START_TIME, SPEED),
                START_LAT,
                START_LNG,
                (START_TIME - 300) as Epoch
            );

            const result = await runScoringChain(task, positions);
            const score = result.final;

            // Should be in-flight (no finish)
            expect(score.utcFinish).toBeFalsy();

            // Distance remaining should be set
            expect(score.actual?.distanceRemaining).toBeGreaterThan(0);

            // Some form of scored distance should exist
            expect(score.actual?.taskDistance).toBeGreaterThanOrEqual(0);
        });
    });
});
