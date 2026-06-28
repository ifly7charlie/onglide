import {describe, test, expect} from 'vitest';

import {computeGaggles, projectToGround, coLocatedMembers, GAGGLE_RADIUS_KM, GAGGLE_CORE_RADIUS_KM, type PilotPositionLite} from '../lib/react/gaggleLayer';
import {distHaversineRaw} from '../lib/flightprocessing/taskhelper';
import type {Compno, Epoch} from '../lib/types';
import type {StatSegment, Wind} from '../lib/protobuf/onglide';

// Minimal StatSegment fixtures — only the fields computeGaggles reads.
function thermal(start: number, end: number, avgDelta: number, wind?: Wind): StatSegment {
    return {state: 'thermal', start, end, avgDelta, heightgain: 0, heightloss: 0, delta: 0, turncount: 0, distance: 0, achievedDistance: 0, direction: 0, wind} as unknown as StatSegment;
}
function straight(start: number, end: number): StatSegment {
    return {state: 'straight', start, end, avgDelta: 0, heightgain: 0, heightloss: 0, delta: 0, turncount: 0, distance: 0, achievedDistance: 0, direction: 0, wind: undefined} as unknown as StatSegment;
}

const c = (s: string) => s as Compno;
const pos = (compno: string, lng: number, lat: number, agl?: number): PilotPositionLite => ({compno: c(compno), position: [lng, lat, 1000], agl});
const wind = (direction: number, speed: number): Wind => ({direction, speed});

const T = 1000 as Epoch;

describe('computeGaggles', () => {
    test('two gliders circling within range form a gaggle of 2, climb from the live vario', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.003)]; // ~333 m apart
        const stats = {AA: [thermal(900, 1100, 1.0)], BB: [thermal(950, 1100, 1.0)]}; // segment averages
        const vario = {AA: 2.0, BB: 3.0}; // live 40s vario — the headline number
        const {gaggles, members} = computeGaggles(positions, stats, vario, T);
        expect(gaggles).toHaveLength(1);
        expect(gaggles[0].count).toBe(2);
        // varioAvg/bestClimb come from the live vario map, NOT the segment avgDelta (1.0).
        expect(gaggles[0].bestClimb).toBe(3.0);
        expect(gaggles[0].varioAvg).toBeCloseTo(2.5);
        // members sorted strongest first (by live vario)
        expect(gaggles[0].members.map((m) => m.compno)).toEqual(['BB', 'AA']);
        expect(members.has(c('AA'))).toBe(true);
        expect(members.has(c('BB'))).toBe(true);
    });

    test('gliders further apart than the threshold are not a gaggle', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.05)]; // ~5.5 km apart
        const stats = {AA: [thermal(900, 1100, 2.0)], BB: [thermal(950, 1100, 3.0)]};
        const {gaggles, members} = computeGaggles(positions, stats, {}, T);
        expect(gaggles).toHaveLength(0);
        expect(members.size).toBe(0);
    });

    test('a glider not circling at the cursor is excluded', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.003)];
        // BB is in a straight glide at T, so only AA is circling — no gaggle.
        const stats = {AA: [thermal(900, 1100, 2.0)], BB: [straight(950, 1100)]};
        const {gaggles, members} = computeGaggles(positions, stats, {}, T);
        expect(gaggles).toHaveLength(0);
        expect(members.size).toBe(0);
    });

    test('thermal segments not straddling the cursor do not count', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.003)];
        // Both thermals ended before the cursor.
        const stats = {AA: [thermal(100, 500, 2.0)], BB: [thermal(100, 500, 3.0)]};
        const {gaggles} = computeGaggles(positions, stats, {}, T);
        expect(gaggles).toHaveLength(0);
    });

    test('a distant third glider is left out of the cluster', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.003), pos('CC', 10.0, 51.05)];
        const stats = {AA: [thermal(900, 1100, 2.0)], BB: [thermal(900, 1100, 4.0)], CC: [thermal(900, 1100, 5.0)]};
        const {gaggles, members} = computeGaggles(positions, stats, {}, T);
        expect(gaggles).toHaveLength(1);
        expect(gaggles[0].count).toBe(2);
        expect(members.has(c('CC'))).toBe(false);
    });

    test('centroid is the mean of member positions', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.002, 51.002)];
        const stats = {AA: [thermal(900, 1100, 2.0)], BB: [thermal(900, 1100, 2.0)]};
        const {gaggles} = computeGaggles(positions, stats, {}, T);
        expect(gaggles[0].position[0]).toBeCloseTo(10.001);
        expect(gaggles[0].position[1]).toBeCloseTo(51.001);
    });

    test('returns empty when no cursor time is given', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.003)];
        const stats = {AA: [thermal(900, 1100, 2.0)], BB: [thermal(900, 1100, 3.0)]};
        const {gaggles, members} = computeGaggles(positions, stats, {}, undefined);
        expect(gaggles).toHaveLength(0);
        expect(members.size).toBe(0);
    });

    test('the clustering threshold constant accounts for wind-drift stacking (~800 m)', () => {
        expect(GAGGLE_RADIUS_KM).toBeCloseTo(0.8);
        expect(GAGGLE_CORE_RADIUS_KM).toBeCloseTo(0.3);
    });

    test('a lone circling glider is a solo, not a gaggle — climb from the live vario', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.05)]; // ~5.5 km apart
        const stats = {AA: [thermal(900, 1100, 1.0)], BB: [straight(950, 1100)]};
        const {gaggles, members, solos} = computeGaggles(positions, stats, {AA: 2.5}, T);
        expect(gaggles).toHaveLength(0);
        expect(members.size).toBe(0);
        expect(solos.map((s) => s.compno)).toEqual([c('AA')]);
        expect(solos[0].climb).toBe(2.5); // live vario, not segment avgDelta (1.0)
    });

    test('a solo with no live vario falls back to the segment average', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.05)];
        const stats = {AA: [thermal(900, 1100, 1.8)], BB: [straight(950, 1100)]};
        const {solos} = computeGaggles(positions, stats, {}, T); // empty vario map → null per pilot
        expect(solos[0].climb).toBe(1.8);
    });

    test('a NaN live vario falls back to the segment average — never NaN in the output', () => {
        // calculateAverage returns NaN on a deck with a NaN altitude; `??` would let it through.
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.003), pos('CC', 10.0, 51.05)];
        const stats = {AA: [thermal(900, 1100, 2.0)], BB: [thermal(900, 1100, 3.0)], CC: [thermal(900, 1100, 1.7)]};
        const {gaggles, solos} = computeGaggles(positions, stats, {AA: NaN, BB: 3.0, CC: NaN} as Record<string, number | null>, T);
        // AA+BB gaggle: AA falls back to avgDelta 2.0, BB uses vario 3.0 → (2+3)/2 = 2.5, not NaN.
        expect(Number.isNaN(gaggles[0].varioAvg)).toBe(false);
        expect(gaggles[0].varioAvg).toBeCloseTo(2.5);
        // CC solo: NaN vario → segment avgDelta 1.7.
        expect(solos.map((s) => s.compno)).toEqual([c('CC')]);
        expect(solos[0].climb).toBe(1.7);
    });

    test('the open thermal is still current shortly past its reported end (stats delivery lag)', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.05)];
        // AA's open thermal end (990) trails the cursor (1000) — within tolerance,
        // because the open thermal's end only reaches the client periodically.
        const stats = {AA: [thermal(900, 990, 2.5)], BB: [straight(950, 1100)]};
        const {solos} = computeGaggles(positions, stats, {AA: 2.5}, T);
        expect(solos.map((s) => s.compno)).toEqual([c('AA')]);
    });

    test('a thermal that ended well before the cursor is not resurrected', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.05)];
        const stats = {AA: [thermal(700, 900, 2.5)], BB: [straight(950, 1100)]}; // ended 100s ago, beyond tolerance
        const {solos, gaggles} = computeGaggles(positions, stats, {AA: 2.5}, T);
        expect(solos).toHaveLength(0);
        expect(gaggles).toHaveLength(0);
    });

    test('a finished thermal with a later segment is never treated as current', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.05)];
        // The last segment is straight, so the thermal before it is genuinely over.
        const stats = {AA: [thermal(900, 990, 2.5), straight(990, 1100)], BB: [straight(950, 1100)]};
        const {solos} = computeGaggles(positions, stats, {AA: 2.5}, T);
        expect(solos).toHaveLength(0);
    });

    test('gaggle members are not also reported as solos', () => {
        const positions = [pos('AA', 10.0, 51.0), pos('BB', 10.0, 51.003), pos('CC', 10.0, 51.05)];
        const stats = {AA: [thermal(900, 1100, 2.0)], BB: [thermal(900, 1100, 4.0)], CC: [thermal(900, 1100, 5.0)]};
        const {gaggles, solos} = computeGaggles(positions, stats, {}, T);
        expect(gaggles).toHaveLength(1); // AA+BB
        // CC circles alone, so it is the only solo; AA/BB are in the gaggle.
        expect(solos.map((s) => s.compno)).toEqual([c('CC')]);
    });

    test('a member in a different thermal nearby is counted in the disc but excluded from the average', () => {
        const w = wind(270, 36); // from the west, 10 m/s
        // All three within GAGGLE_RADIUS, so one on-screen cluster of 3.
        const positions = [pos('AA', 10.0, 51.0, 1000), pos('BB', 10.0, 51.0009, 1000), pos('CC', 10.0, 51.0018, 100)];
        const stats = {AA: [thermal(900, 1100, 2.0, w)], BB: [thermal(900, 1100, 2.0, w)], CC: [thermal(900, 1100, 6.0, w)]};
        // AA/BB project ~5 km upwind (high, slow climb); CC projects only ~170 m (low) → different ground core.
        const vario = {AA: 2.0, BB: 2.0, CC: 6.0};
        const {gaggles} = computeGaggles(positions, stats, vario, T);
        expect(gaggles).toHaveLength(1);
        expect(gaggles[0].count).toBe(3); // CC still counted in the cluster/disc
        expect(gaggles[0].varioAvg).toBeCloseTo(2.0); // averaged over the co-located AA+BB only (not 3.33)
    });
});

describe('projectToGround', () => {
    test('no wind leaves the position unchanged', () => {
        expect(projectToGround([10, 51, 1000], 1000, 2, wind(270, 0))).toEqual([10, 51]);
    });

    test('a high, slowly-climbing glider in a strong crosswind projects its core well upwind', () => {
        const core = projectToGround([10, 51, 1000], 1000, 2, wind(270, 36)); // 10 m/s, 500 s of rise → ~5 km
        expect(core[0]).toBeLessThan(10); // wind from the west → source lies to the west
        expect(core[1]).toBeCloseTo(51, 4); // ~due-west, latitude essentially unchanged
        expect(distHaversineRaw([10, 51], core)).toBeCloseTo(5, 0); // ~5 km upwind
    });

    test('on the deck (no AGL) or not climbing → no projection', () => {
        expect(projectToGround([10, 51, 0], 0, 2, wind(270, 36))).toEqual([10, 51]);
        expect(projectToGround([10, 51, 1000], 1000, 0, wind(270, 36))).toEqual([10, 51]);
    });
});

describe('coLocatedMembers', () => {
    const circler = (compno: string, lng: number, lat: number, agl: number, seg: StatSegment) => ({compno: c(compno), position: [lng, lat, 1000] as [number, number, number], agl, seg});

    test('with no wind data anywhere it keeps the whole cluster (degrades gracefully)', () => {
        const group = [circler('AA', 10, 51, 1000, thermal(900, 1100, 2)), circler('BB', 10, 51.0009, 1000, thermal(900, 1100, 2))];
        const out = coLocatedMembers(group, {AA: 2, BB: 2});
        expect(out.map((m) => m.compno).sort()).toEqual(['AA', 'BB']);
    });

    test('excludes a diverging member even when its own climb/wind are missing (resolved from neighbours)', () => {
        const w = wind(270, 36);
        const A = circler('AA', 10, 51.0, 1000, thermal(900, 1100, 2, w));
        const B = circler('BB', 10, 51.0009, 1000, thermal(900, 1100, 2, w));
        // CC has no own wind and a null live vario — both must come from its neighbours
        // for its core to be computed; low AGL puts that core ~4.5 km from AA/BB's.
        const C = circler('CC', 10, 51.0018, 100, thermal(900, 1100, 1));
        const out = coLocatedMembers([A, B, C], {AA: 2, BB: 2, CC: null});
        expect(out.map((m) => m.compno).sort()).toEqual(['AA', 'BB']); // CC excluded → fallback computed its core
    });
});
