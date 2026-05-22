import {describe, test, expect} from 'vitest';
import {scaleForWire, unscaleFromWire, scaleClassScoreHistoryForWire, unscaleClassScoreHistoryFromWire, roundedUint32, clampUint32, clampInt32} from '../lib/protobuf/wireScaling';
import {OnglideWebSocketMessage, ClassScoreHistory, type PilotScore, type SpeedDist, type Task, type CompetitionSummary} from '../lib/protobuf/onglide';

// --- builders -------------------------------------------------------------

const speedDist = (over: Partial<SpeedDist> = {}): SpeedDist => ({
    distance: 10.1,
    taskDistance: 214.9,
    distanceRemaining: 12.3,
    maxPossible: 88.7,
    minPossible: 40.1,
    grRemaining: 37,
    legSpeed: 95.4,
    taskSpeed: 102.6,
    ...over
});

const pilot = (over: Partial<PilotScore> = {}): PilotScore => ({
    live: true,
    t: 1000,
    compno: '42',
    utcStart: 100,
    utcFinish: 0,
    currentLeg: 1,
    actual: speedDist(),
    handicapped: speedDist({taskDistance: 220}),
    home: speedDist({distance: 5.5}),
    legs: {
        0: {legno: 0, time: 1, actual: speedDist({distance: 10.1}), handicapped: speedDist({distance: 11.2}), convexHull: [1.5, 2.5]},
        1: {legno: 1, time: 2, actual: speedDist({distance: 50.4}), handicapped: speedDist({distance: 55.6}), convexHull: []}
    },
    stats: {segments: [{start: 1, end: 2, state: 'climb', wind: undefined, turncount: 3, distance: 12.4, achievedDistance: 8.8, delta: -5, avgDelta: -1.7, direction: 0, heightgain: 100, heightloss: 20}]},
    scoredPoints: [51.5, -1.2, 10, 11],
    minDistancePoints: [],
    maxDistancePoints: [],
    optimalGrid: [],
    optimalGridBaselinePath: [],
    suggestedTrackPoints: [],
    ...over
});

const scoresMessage = (p: PilotScore = pilot()): OnglideWebSocketMessage => ({scores: {scoreId: 'abc', pilots: {[p.compno]: p}}});

const task = (): Task => ({
    legs: [
        {legno: 0, type: 'sector', ntrigraph: 'AAA', name: 'Start', bearing: 0, length: 0, nlat: 51.5, nlng: -1.2, r1: 0.5, r2: 0, a1: 180, a2: 0, a12: 0, direction: 'symmetrical'},
        {legno: 1, type: 'sector', ntrigraph: 'BBB', name: 'TP1', bearing: 123.4, length: 87.6, nlat: 52.1, nlng: -0.8, r1: 30, r2: 0, a1: 45, a2: 0, a12: 200.5, direction: 'symmetrical'}
    ],
    rules: {grandprixstart: false, nostartutc: 0, maxHandicap: 112.5},
    details: {type: 'S', distance: 175.2, duration: '', status: '', nostart: ''}
});

// scale -> encode -> decode -> unscale, the full server->client trip
const roundTrip = (m: OnglideWebSocketMessage): OnglideWebSocketMessage => unscaleFromWire(OnglideWebSocketMessage.decode(OnglideWebSocketMessage.encode(scaleForWire(m)).finish()));

// --- round-trip fidelity --------------------------------------------------

describe('round-trip', () => {
    test('SpeedDist fields survive scale/encode/decode/unscale', () => {
        const p = roundTrip(scoresMessage()).scores!.pilots['42'];
        expect(p.actual!.distance).toBeCloseTo(10.1, 5);
        expect(p.actual!.taskDistance).toBeCloseTo(214.9, 5);
        expect(p.actual!.distanceRemaining).toBeCloseTo(12.3, 5);
        expect(p.actual!.maxPossible).toBeCloseTo(88.7, 5);
        expect(p.actual!.minPossible).toBeCloseTo(40.1, 5);
        expect(p.actual!.legSpeed).toBeCloseTo(95.4, 5);
        expect(p.actual!.taskSpeed).toBeCloseTo(102.6, 5);
        expect(p.handicapped!.taskDistance).toBeCloseTo(220, 5);
        expect(p.legs[1].actual!.distance).toBeCloseTo(50.4, 5);
    });

    test('StatSegment distance/achievedDistance/avgDelta survive (avgDelta signed)', () => {
        const seg = roundTrip(scoresMessage()).scores!.pilots['42'].stats!.segments[0];
        expect(seg.distance).toBeCloseTo(12.4, 5);
        expect(seg.achievedDistance).toBeCloseTo(8.8, 5);
        expect(seg.avgDelta).toBeCloseTo(-1.7, 5);
    });

    test('TaskLeg / TaskRules / TaskDetails fields survive', () => {
        const t = roundTrip({task: task()}).task!;
        expect(t.legs[1].bearing).toBeCloseTo(123.4, 5);
        expect(t.legs[1].length).toBeCloseTo(87.6, 5);
        expect(t.legs[1].r1).toBeCloseTo(30, 5);
        expect(t.legs[1].a1).toBeCloseTo(45, 5);
        expect(t.legs[1].a12).toBeCloseTo(200.5, 5);
        expect(t.rules!.maxHandicap).toBeCloseTo(112.5, 5);
        expect(t.details!.distance).toBeCloseTo(175.2, 5);
    });

    test('ClassWinner / CompetitionClassStatus fields survive via /all message', () => {
        const summary: CompetitionSummary = {
            compid: 'c1', name: 'Comp', lat: 0, lng: 0, start: '', end: '', countrycode: '', tz: '', tzoffset: 0, classCount: 1, classStatusesDiffer: false, displayStatus: 'home',
            classes: [
                {
                    class: 'A', classname: 'A', status: '', pilotCount: 1, displayStatus: 'home',
                    taskRules: {grandprixstart: false, nostartutc: 0, maxHandicap: 108.5},
                    taskDetails: {type: 'S', distance: 312.7, duration: '', status: '', nostart: ''},
                    winner: {compno: '99', taskSpeed: 118.3, taskDistance: 305.1}
                }
            ]
        };
        const c = roundTrip({competitions: {competitions: [summary], generatedAt: 0, full: true, removed: []}}).competitions!.competitions[0].classes[0];
        expect(c.taskRules!.maxHandicap).toBeCloseTo(108.5, 5);
        expect(c.taskDetails!.distance).toBeCloseTo(312.7, 5);
        expect(c.winner!.taskSpeed).toBeCloseTo(118.3, 5);
        expect(c.winner!.taskDistance).toBeCloseTo(305.1, 5);
    });

    test('ClassScoreHistory pilots survive', () => {
        const csh: ClassScoreHistory = {className: 'C', datecode: 'A', pilots: {42: {history: [pilot()]}}};
        const back = unscaleClassScoreHistoryFromWire(ClassScoreHistory.decode(ClassScoreHistory.encode(scaleClassScoreHistoryForWire(csh)).finish()));
        expect(back.pilots[42].history[0].actual!.taskDistance).toBeCloseTo(214.9, 5);
    });
});

// --- the wire actually carries ×10 integers -------------------------------

describe('wire form', () => {
    test('scaleForWire produces ×10 integers', () => {
        const scaled = scaleForWire(scoresMessage());
        expect(scaled.scores!.pilots['42'].actual!.distance).toBe(101);
        expect(scaled.scores!.pilots['42'].actual!.taskDistance).toBe(2149);
        expect(scaled.scores!.pilots['42'].stats!.segments[0].avgDelta).toBe(-17);
    });

    test('grRemaining is not scaled (already a uint32)', () => {
        expect(scaleForWire(scoresMessage()).scores!.pilots['42'].actual!.grRemaining).toBe(37);
        expect(roundTrip(scoresMessage()).scores!.pilots['42'].actual!.grRemaining).toBe(37);
    });

    test('coordinates and float arrays are left untouched', () => {
        const scaled = scaleForWire(scoresMessage());
        expect(scaled.scores!.pilots['42'].scoredPoints).toEqual([51.5, -1.2, 10, 11]);
        const t = scaleForWire({task: task()}).task!;
        expect(t.legs[1].nlat).toBe(52.1);
        expect(t.legs[1].nlng).toBe(-0.8);
    });
});

// --- the input is never mutated ------------------------------------------

describe('no mutation', () => {
    test('scaleForWire does not mutate the input message', () => {
        const m = scoresMessage();
        const original = m.scores!.pilots['42'];
        const scaled = scaleForWire(m);
        expect(original.actual!.distance).toBe(10.1);
        expect(original.actual!.taskDistance).toBe(214.9);
        expect(original.stats!.segments[0].avgDelta).toBe(-1.7);
        expect(scaled.scores!.pilots['42']).not.toBe(original);
        expect(scaled.scores!.pilots['42'].actual).not.toBe(original.actual);
    });

    test('frames without scaled fields are returned unchanged (same ref)', () => {
        const m: OnglideWebSocketMessage = {ka: {keepalive: true, at: 1, listeners: 0, airborne: 0}, t: 5};
        expect(scaleForWire(m)).toBe(m);
        expect(unscaleFromWire(m)).toBe(m);
    });
});

// --- defensive handling ---------------------------------------------------

describe('defensive handling', () => {
    test('NaN / Infinity sanitise to 0 instead of crashing the encoder', () => {
        const m = scoresMessage(pilot({actual: speedDist({distance: NaN, taskDistance: NaN, distanceRemaining: Infinity, legSpeed: -Infinity})}));
        let back: OnglideWebSocketMessage | undefined;
        expect(() => {
            back = roundTrip(m);
        }).not.toThrow();
        const a = back!.scores!.pilots['42'].actual!;
        expect(a.distance).toBe(0);
        expect(a.taskDistance).toBe(0);
        expect(a.distanceRemaining).toBe(0);
        expect(a.legSpeed).toBe(0);
    });

    test('negative value in a uint32 field clamps to 0', () => {
        const m = scoresMessage(pilot({actual: speedDist({distanceRemaining: -3})}));
        expect(roundTrip(m).scores!.pilots['42'].actual!.distanceRemaining).toBe(0);
    });

    test('negative avgDelta is preserved (signed sint32 field)', () => {
        const m = scoresMessage(pilot({stats: {segments: [{start: 0, end: 1, state: 'x', wind: undefined, turncount: 0, distance: 1, achievedDistance: 1, delta: 0, avgDelta: -9.9, direction: 0, heightgain: 0, heightloss: 0}]}}));
        expect(roundTrip(m).scores!.pilots['42'].stats!.segments[0].avgDelta).toBeCloseTo(-9.9, 5);
    });

    test('absent optional fields stay undefined', () => {
        const m = scoresMessage(pilot({home: undefined}));
        const scaled = scaleForWire(m);
        expect(scaled.scores!.pilots['42'].home).toBeUndefined();
        expect(scaled.scores!.pilots['42'].actual!.distance).toBeDefined();
    });
});

// --- clamp helpers --------------------------------------------------------

describe('clamp helpers', () => {
    test('roundedUint32 rounds finite non-negative, rejects the rest', () => {
        expect(roundedUint32(12.6)).toBe(13);
        expect(roundedUint32(0)).toBe(0);
        expect(roundedUint32(-1)).toBeUndefined();
        expect(roundedUint32(NaN)).toBeUndefined();
        expect(roundedUint32(Infinity)).toBeUndefined();
        expect(roundedUint32(undefined)).toBeUndefined();
        expect(roundedUint32(null)).toBeUndefined();
    });

    test('clampUint32 falls back to 0', () => {
        expect(clampUint32(12.6)).toBe(13);
        expect(clampUint32(-5)).toBe(0);
        expect(clampUint32(NaN)).toBe(0);
        expect(clampUint32(undefined)).toBe(0);
    });

    test('clampInt32 keeps sign, falls back to 0', () => {
        expect(clampInt32(-7.4)).toBe(-7);
        expect(clampInt32(7.6)).toBe(8);
        expect(clampInt32(NaN)).toBe(0);
        expect(clampInt32(undefined)).toBe(0);
    });
});
