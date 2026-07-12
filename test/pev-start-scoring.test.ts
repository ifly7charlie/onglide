/**
 * End-to-end scoring-chain tests for the IGC Cylinder (PEV) start.
 *
 * The start cylinder is r=10km centred at C=(47,19); TP1 is 40km due east.
 * Flights are synthesised with makeSoaringFlight (dense 4s fixes, thermal
 * circles the flightStatistics classifier segments reliably), so "top of
 * climb" times are known to within a few fixes.
 */
import {describe, test, expect} from 'vitest';
import {makeRacingTask, makeAATTask} from './lib/taskFixtures';
import {makeSoaringFlight, pointAtBearingDistance, markPevAt, SoaringAction} from './lib/flightFixtures';
import {runScoringChain} from './lib/scoringChainRunner';
import {distHaversine} from '../lib/flightprocessing/taskhelper';
import type {Epoch} from '../lib/types';

const C = {lat: 47, lng: 19};
const GATE = 100000 as Epoch;
const E = (km: number, alt?: number) => ({...pointAtBearingDistance(C, 90, km), ...(alt !== undefined ? {altitude: alt} : {})});
const W = (km: number, alt?: number) => ({...pointAtBearingDistance(C, 270, km), ...(alt !== undefined ? {altitude: alt} : {})});
const TP1 = E(40);

const cylRacingTask = (pevStart = true) =>
    makeRacingTask({
        startLat: C.lat,
        startLng: C.lng,
        sectors: [{lat: TP1.lat, lng: TP1.lng, r1: 0.5}],
        startTime: GATE,
        startRadius: 10,
        startType: 'cylinder',
        pevStart
    });

const fly = (start: {lat: number; lng: number; altitude?: number}, actions: SoaringAction[], startTime: Epoch) => makeSoaringFlight(start, actions, startTime);

describe('PEV cylinder start — racing chain', () => {
    test('task length is measured from the start point (no r1 subtraction)', () => {
        expect(cylRacingTask(true).details.distance).toBeCloseTo(80.0, 0);
        expect(cylRacingTask(false).details.distance).toBeCloseTo(70.0, 0);
    });

    test('climb inside then glide to TP1: start is the top of the climb', async () => {
        // Reposition westward pre-gate, climb through gate-open, commit east.
        const task = cylRacingTask();
        const flight = fly(
            {...W(3), altitude: 1200},
            [
                {glideTo: W(5, 1100)}, // away from TP1 — never a candidate
                {thermalSecs: 300, climbRate: 2.5}, // top ≈ GATE+165 at ~1850m
                {glideTo: {...TP1, altitude: 900}}, // committed glide, 45km
                {glideTo: W(2, 550)} // home, through the finish line
            ],
            (GATE - 200) as Epoch
        );
        const {final} = await runScoringChain(task, flight);

        const topOfClimb = GATE + 165;
        expect(final.utcStart).toBeGreaterThan(topOfClimb - 45);
        expect(final.utcStart).toBeLessThan(topOfClimb + 45);
        expect(final.legs[1].estimatedStart).toBe(true);
        // Start altitude ≈ 1100 + 300s × 2.5m/s
        expect(final.legs[1].alt).toBeGreaterThan(1800);
        expect(final.legs[1].alt).toBeLessThan(1900);
        // Leg 1 measured from the credited fix (~45km), not the centre (40)
        // or the ring (30)
        expect(final.utcFinish).toBeTruthy();
        expect(final.legs[1].actual!.distance).toBeGreaterThan(44);
        expect(final.legs[1].actual!.distance).toBeLessThan(46);
    });

    test('a second climb inside the cylinder wins (latest qualifying glide)', async () => {
        const task = cylRacingTask();
        const flight = fly(
            {...W(8), altitude: 1200},
            [
                {thermalSecs: 240, climbRate: 2}, // climb A, top ≈ GATE+140
                {glideTo: W(3, 1500)}, // qualifying glide toward TP1 (5km)
                {thermalSecs: 240, climbRate: 2}, // climb B, top ≈ GATE+544
                {glideTo: {...TP1, altitude: 900}},
                {glideTo: {...C, altitude: 600}}
            ],
            (GATE - 100) as Epoch
        );
        const {final} = await runScoringChain(task, flight);

        const topOfB = GATE + 544;
        expect(final.utcStart).toBeGreaterThan(topOfB - 50);
        expect(final.utcStart).toBeLessThan(topOfB + 50);
        expect(final.legs[1].estimatedStart).toBe(true);
    });

    test('retro pass bridges a tracking outage back to the top of the climb', async () => {
        // Climb inside, a short (sub-commit) glide, then an outage that
        // resumes OUTSIDE the cylinder: live detection can only see the exit
        // fallback, the retro pass at TP1 must credit the top of the climb.
        const task = cylRacingTask();
        const flight = fly(
            {...E(4), altitude: 1200},
            [
                {thermalSecs: 240, climbRate: 2}, // top ≈ GATE+140 at E4
                {glideTo: E(5.5, 1450)}, // 1.5km — below commit threshold
                {glideTo: E(14, 1300), silent: true}, // outage across the boundary
                {glideTo: {...TP1, altitude: 900}},
                {glideTo: {...C, altitude: 600}}
            ],
            (GATE - 100) as Epoch
        );
        const {final} = await runScoringChain(task, flight);

        const topOfClimb = GATE + 140;
        expect(final.utcStart).toBeGreaterThan(topOfClimb - 45);
        // Critically: earlier than the boundary crossing inside the outage
        // (~GATE+330), which is what the live fallback had settled on.
        expect(final.utcStart).toBeLessThan(topOfClimb + 60);
        expect(final.legs[1].estimatedStart).toBe(true);
    });

    test('straight transit with no circling falls back to the exit crossing', async () => {
        const task = cylRacingTask();
        const flight = fly(
            {...W(15), altitude: 2000}, // starts OUTSIDE the cylinder
            [
                {glideTo: {...TP1, altitude: 900}}, // straight through
                {glideTo: {...C, altitude: 600}}
            ],
            (GATE + 50) as Epoch
        );
        const {final} = await runScoringChain(task, flight);

        // Exit at the eastern boundary, 25km from the start of the glide
        const exitTime = GATE + 50 + (25 / 110) * 3600;
        expect(Math.abs(final.utcStart! - exitTime)).toBeLessThan(30);
        expect(final.legs[1].estimatedStart).toBeFalsy();
    });

    test('exit + re-enter + re-climb replaces the start; excursions alone do not', async () => {
        const task = cylRacingTask();
        // Part 1: pev start from climb A, then the pilot leaves, comes back,
        // climbs again inside and goes — climb B wins.
        const withReclimb = fly(
            {...W(5), altitude: 1200},
            [
                {thermalSecs: 240, climbRate: 2}, // climb A (pev start applied on the glide out)
                {glideTo: E(12, 1400)}, // exits the cylinder — ignored, pev stands
                {glideTo: E(6, 1300)}, // re-enters
                {thermalSecs: 240, climbRate: 2}, // climb B inside
                {glideTo: {...TP1, altitude: 900}},
                {glideTo: {...C, altitude: 600}}
            ],
            (GATE - 100) as Epoch
        );
        // climb A tops ≈ GATE+140; 17km + 6km of glides ≈ 753s; climb B tops ≈ +240
        const topOfB = GATE + 140 + 753 + 240;
        const {final: finalReclimb} = await runScoringChain(task, withReclimb);
        expect(finalReclimb.utcStart).toBeGreaterThan(topOfB - 60);
        expect(finalReclimb.utcStart).toBeLessThan(topOfB + 60);
        expect(finalReclimb.legs[1].estimatedStart).toBe(true);

        // Part 2: same excursion but NO re-climb — the original pev start stands.
        const withoutReclimb = fly(
            {...W(5), altitude: 1500},
            [
                {thermalSecs: 240, climbRate: 2}, // climb A, top ≈ GATE+140
                {glideTo: E(12, 1700)},
                {glideTo: E(8, 1650)}, // wanders back in without climbing
                {glideTo: {...TP1, altitude: 900}},
                {glideTo: {...C, altitude: 600}}
            ],
            (GATE - 100) as Epoch
        );
        const topOfA = GATE + 140;
        const {final: finalExcursion} = await runScoringChain(task, withoutReclimb);
        expect(finalExcursion.utcStart).toBeGreaterThan(topOfA - 45);
        expect(finalExcursion.utcStart).toBeLessThan(topOfA + 45);
        expect(finalExcursion.legs[1].estimatedStart).toBe(true);
    });

    test('landout inside the cylinder keeps the provisional start without confirming', async () => {
        const task = cylRacingTask();
        const flight = fly(
            {...W(5), altitude: 1200},
            [
                {thermalSecs: 240, climbRate: 2}, // top ≈ GATE+140
                {glideTo: E(5, 450)} // sinks out heading for TP1, lands inside
            ],
            (GATE - 100) as Epoch
        );
        // Grounded fix (same spot, AGL 0) so the chain detects the landout
        const last = flight[flight.length - 1];
        last._ = false;
        flight.push({...last, t: (last.t + 120) as Epoch, g: 0 as any, _: true});

        const {final} = await runScoringChain(task, flight);
        const topOfClimb = GATE + 140;
        expect(final.utcStart).toBeGreaterThan(topOfClimb - 45);
        expect(final.utcStart).toBeLessThan(topOfClimb + 45);
        expect(final.utcFinish).toBeFalsy();
    });

    test('grandprix and official starts override the estimator', async () => {
        const flight = fly(
            {...W(3), altitude: 1200},
            [{thermalSecs: 300, climbRate: 2.5}, {glideTo: {...TP1, altitude: 900}}, {glideTo: {...C, altitude: 600}}],
            (GATE - 200) as Epoch
        );

        const gpTask = cylRacingTask();
        gpTask.rules.grandprixstart = true;
        const {final: gpFinal} = await runScoringChain(gpTask, flight);
        expect(gpFinal.utcStart).toBe(GATE);
        expect(gpFinal.legs[1].estimatedStart).toBeFalsy();

        const officialTask = cylRacingTask();
        const official = (GATE + 500) as Epoch;
        const {final: officialFinal} = await runScoringChain(officialTask, flight, {utcStart: official});
        expect(officialFinal.utcStart).toBe(official);
    });
});

describe('PEV cylinder start — recorded presses on the position stream', () => {
    // Same flight as the estimator tests: climb inside the cylinder topping
    // out ≈ GATE+165, then a committed glide to TP1 and home.
    const flightWithPresses = (pressTimes: number[]) => {
        const flight = fly(
            {...W(3), altitude: 1200},
            [
                {glideTo: W(5, 1100)},
                {thermalSecs: 300, climbRate: 2.5},
                {glideTo: {...TP1, altitude: 900}},
                {glideTo: W(2, 550)}
            ],
            (GATE - 200) as Epoch
        );
        for (const t of pressTimes) {
            markPevAt(flight, t);
        }
        return flight;
    };

    test('a recorded press beats the estimate and is not marked estimated', async () => {
        // Pressed mid-climb: the start is the press fix, not the ~GATE+165
        // top-of-climb the estimator would pick.
        const {final} = await runScoringChain(cylRacingTask(), flightWithPresses([GATE + 60]));
        expect(final.utcStart).toBeGreaterThanOrEqual(GATE + 60);
        expect(final.utcStart).toBeLessThan(GATE + 70);
        expect(final.legs[1].estimatedStart).toBeFalsy();
        // Leg 1 still measured from the credited fix (~W5, 45km to TP1)
        expect(final.legs[1].actual!.distance).toBeGreaterThan(44);
        expect(final.legs[1].actual!.distance).toBeLessThan(46);
    });

    test('the latest press inside the cylinder wins', async () => {
        // Second press during the glide out, still inside the cylinder
        const {final} = await runScoringChain(cylRacingTask(), flightWithPresses([GATE + 60, GATE + 300]));
        expect(final.utcStart).toBeGreaterThanOrEqual(GATE + 300);
        expect(final.utcStart).toBeLessThan(GATE + 310);
    });

    test('presses within 30s are one cluster — the first wins', async () => {
        const {final} = await runScoringChain(cylRacingTask(), flightWithPresses([GATE + 60, GATE + 80]));
        expect(final.utcStart).toBeGreaterThanOrEqual(GATE + 60);
        expect(final.utcStart).toBeLessThan(GATE + 70);
    });

    test('a press outside the cylinder is ignored — the estimator still runs', async () => {
        // The glide passes the 10km ring ≈ GATE+656; a press at GATE+700 is
        // outside and must not become the start.
        const {final} = await runScoringChain(cylRacingTask(), flightWithPresses([GATE + 700]));
        const topOfClimb = GATE + 165;
        expect(final.utcStart).toBeGreaterThan(topOfClimb - 45);
        expect(final.utcStart).toBeLessThan(topOfClimb + 45);
        expect(final.legs[1].estimatedStart).toBe(true);
    });

    test('a press just before the gate is ignored — even inside the 10s pre-gate scoring window', async () => {
        // Points from nostartutc-10 onward are already processed for start
        // detection; a press riding one of them must still not start before
        // the gate — the estimator's top-of-climb start applies instead.
        const {final} = await runScoringChain(cylRacingTask(), flightWithPresses([GATE - 5]));
        const topOfClimb = GATE + 165;
        expect(final.utcStart).toBeGreaterThanOrEqual(GATE);
        expect(final.utcStart).toBeGreaterThan(topOfClimb - 45);
        expect(final.utcStart).toBeLessThan(topOfClimb + 45);
        expect(final.legs[1].estimatedStart).toBe(true);
    });
});

describe('PEV cylinder start — AAT chain', () => {
    test('AAT distances are measured from the credited start fix', async () => {
        // One 20km assigned area centred on TP1; pilot climbs at W5, glides
        // 30km to 5km inside the area, turns home and finishes.
        const task = makeAATTask({
            startLat: C.lat,
            startLng: C.lng,
            sectors: [{lat: TP1.lat, lng: TP1.lng, r1: 20}],
            minTimeSecs: 3600,
            startTime: GATE,
            startRadius: 10,
            startType: 'cylinder',
            pevStart: true
        });
        const deepest = E(25, 1200);
        const flight = fly(
            {...W(5), altitude: 1200},
            [
                {thermalSecs: 300, climbRate: 2.5}, // top ≈ GATE+200
                {glideTo: deepest},
                {glideTo: W(2, 550)} // home, through the finish line
            ],
            (GATE - 100) as Epoch
        );
        const {final} = await runScoringChain(task, flight);

        const topOfClimb = GATE + 200;
        expect(final.utcStart).toBeGreaterThan(topOfClimb - 50);
        expect(final.utcStart).toBeLessThan(topOfClimb + 50);
        expect(final.legs[1].estimatedStart).toBe(true);
        expect(final.utcFinish).toBeTruthy();

        // Leg 1 from the credited fix (~W5 → E25 = 30km), not the start
        // centre (25km) — the graph group-0 reseed is what's under test.
        const creditedToDeepest = distHaversine(W(5), deepest);
        expect(final.legs[1].actual!.distance).toBeGreaterThan(creditedToDeepest - 1.5);
        expect(final.legs[1].actual!.distance).toBeLessThan(creditedToDeepest + 1.5);
    });
});
