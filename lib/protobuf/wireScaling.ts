// Wire-boundary numeric helpers for the onglide protobuf.
//
// A set of speed/distance/handicap/angle/radius fields are declared as integers
// in onglide.proto but represent values with one decimal place (km, km/h,
// degrees, handicap index). They are sent as `value ×10` so the wire carries a
// short varint instead of a fixed 4-byte float, and `integer / 10` round-trips
// the one-decimal value exactly.
//
// Scaling happens ONLY at the wire boundary: `scaleForWire` is applied inside
// `safeEncode` just before `.encode()`, `unscaleFromWire` immediately after
// `.decode()`. Internal server objects (`channel.allScores`, `channel.task`)
// and the client's Redux store always hold real numbers — so the converters
// below never mutate their input; each returns a fresh spread copy of every
// object whose fields change, sharing everything else by reference.

import {
    OnglideWebSocketMessage,
    ClassScoreHistory,
    ScoreHistory,
    Scores,
    PilotScore,
    PilotScoreLeg,
    SpeedDist,
    StatSegment,
    ClassStats,
    Task,
    TaskLeg,
    ClassWinner,
    CompetitionsList,
    CompetitionClassStatus,
} from './onglide';

const WIRE_SCALE = 10;

// A Codec carries one direction of the conversion. The whole message tree is
// walked once with whichever Codec applies; each leaf calls the method named
// for the proto wire type of that field, so signedness is chosen by calling
// the right function — there is no mode flag to thread around.
type Field = (v: number | undefined) => number | undefined;
interface Codec {
    uint: Field; // a ×10 field declared uint32 — clamped >=0 on encode
    sint: Field; // a ×10 field declared sint32 — sign preserved
}

// `undefined` (an absent optional field) passes through untouched; a non-finite
// number (NaN / Infinity, e.g. a divide-by-zero in a speed calc) is sanitised
// to 0 so the integer encoder can't reject it and drop the whole frame.
const guarded = (fn: (v: number) => number): Field => (v) => {
    if (v === undefined) return undefined;
    return isFinite(v) ? fn(v) : 0;
};
const unscale = guarded((v) => v / WIRE_SCALE);

// real units -> ×10 integer wire form. `uint` clamps to >=0 so a stray negative
// can't be rejected by the uint32 encoder (which would drop the whole frame).
const ENCODE: Codec = {
    uint: guarded((v) => Math.max(0, Math.round(v * WIRE_SCALE))),
    sint: guarded((v) => Math.round(v * WIRE_SCALE)),
};
// ×10 integer wire form -> real units. Decoded sign is already correct.
const DECODE: Codec = {uint: unscale, sint: unscale};

// --- converters: each returns a new object, never mutates ---

function convSpeedDist(sd: SpeedDist | undefined, c: Codec): SpeedDist | undefined {
    if (!sd) return sd;
    return {
        ...sd, // grRemaining is already a uint32 and is not scaled
        distance: c.uint(sd.distance),
        taskDistance: c.uint(sd.taskDistance) as number,
        distanceRemaining: c.uint(sd.distanceRemaining),
        maxPossible: c.uint(sd.maxPossible),
        minPossible: c.uint(sd.minPossible),
        legSpeed: c.uint(sd.legSpeed),
        taskSpeed: c.uint(sd.taskSpeed),
    };
}

function convTaskLeg(leg: TaskLeg, c: Codec): TaskLeg {
    return {
        ...leg, // nlat / nlng / altitude stay float, unchanged
        bearing: c.uint(leg.bearing) as number,
        length: c.uint(leg.length) as number,
        r1: c.uint(leg.r1) as number,
        r2: c.uint(leg.r2) as number,
        a1: c.uint(leg.a1) as number,
        a2: c.uint(leg.a2) as number,
        a12: c.uint(leg.a12) as number,
    };
}

function convStatSegment(seg: StatSegment, c: Codec): StatSegment {
    return {
        ...seg,
        distance: c.uint(seg.distance) as number,
        achievedDistance: c.uint(seg.achievedDistance) as number,
        avgDelta: c.sint(seg.avgDelta) as number, // signed: climb or sink
    };
}

// Top-level ClassStats data plane: map<className, {baseTime, map<compno, {trackVersion, segments}>}>.
// Only the StatSegment fields are ×10-scaled; trackVersion/baseTime pass through.
function convClassStats(cs: ClassStats, c: Codec): ClassStats {
    const klass: ClassStats['class'] = {};
    for (const cn in cs.class) {
        const update = cs.class[cn];
        const pilots: (typeof update)['pilots'] = {};
        for (const compno in update.pilots) {
            const p = update.pilots[compno];
            pilots[compno] = {...p, segments: p.segments.map((s) => convStatSegment(s, c))};
        }
        klass[cn] = {...update, pilots};
    }
    return {...cs, class: klass};
}

function convPilotScoreLeg(leg: PilotScoreLeg, c: Codec): PilotScoreLeg {
    return {...leg, handicapped: convSpeedDist(leg.handicapped, c), actual: convSpeedDist(leg.actual, c)};
}

function convPilotScore(p: PilotScore, c: Codec): PilotScore {
    const legs: {[key: number]: PilotScoreLeg} = {};
    for (const k in p.legs) legs[k] = convPilotScoreLeg(p.legs[k], c);
    return {
        ...p,
        actual: convSpeedDist(p.actual, c),
        handicapped: convSpeedDist(p.handicapped, c),
        home: convSpeedDist(p.home, c),
        legs,
    };
}

function convScores(scores: Scores, c: Codec): Scores {
    const pilots: {[key: string]: PilotScore} = {};
    for (const k in scores.pilots) pilots[k] = convPilotScore(scores.pilots[k], c);
    return {...scores, pilots};
}

function convTask(task: Task, c: Codec): Task {
    return {
        ...task,
        legs: task.legs.map((l) => convTaskLeg(l, c)),
        rules: task.rules ? {...task.rules, maxHandicap: c.uint(task.rules.maxHandicap) as number} : task.rules,
        details: task.details ? {...task.details, distance: c.uint(task.details.distance) as number} : task.details,
    };
}

function convClassWinner(w: ClassWinner | undefined, c: Codec): ClassWinner | undefined {
    if (!w) return w;
    return {...w, taskSpeed: c.uint(w.taskSpeed), taskDistance: c.uint(w.taskDistance)};
}

function convClassStatus(s: CompetitionClassStatus, c: Codec): CompetitionClassStatus {
    return {
        ...s,
        taskRules: s.taskRules ? {...s.taskRules, maxHandicap: c.uint(s.taskRules.maxHandicap) as number} : s.taskRules,
        taskDetails: s.taskDetails ? {...s.taskDetails, distance: c.uint(s.taskDetails.distance) as number} : s.taskDetails,
        winner: convClassWinner(s.winner, c),
    };
}

function convCompetitions(list: CompetitionsList, c: Codec): CompetitionsList {
    return {...list, competitions: list.competitions.map((comp) => ({...comp, classes: comp.classes.map((s) => convClassStatus(s, c))}))};
}

function convMessage(m: OnglideWebSocketMessage, c: Codec): OnglideWebSocketMessage {
    // tracks / positions / keepalive frames carry no scaled fields — but a
    // position frame may now also carry the stats data plane (×10 StatSegment
    // fields), so it must not be early-outed.
    if (!m.scores && !m.task && !m.competitions && !m.stats) return m;
    return {
        ...m,
        scores: m.scores ? convScores(m.scores, c) : m.scores,
        task: m.task ? convTask(m.task, c) : m.task,
        competitions: m.competitions ? convCompetitions(m.competitions, c) : m.competitions,
        stats: m.stats ? convClassStats(m.stats, c) : m.stats,
    };
}

function convClassScoreHistory(m: ClassScoreHistory, c: Codec): ClassScoreHistory {
    const pilots: {[key: string]: ScoreHistory} = {};
    for (const k in m.pilots) pilots[k] = {...m.pilots[k], history: m.pilots[k].history.map((p) => convPilotScore(p, c))};
    return {...m, pilots};
}

// --- public API: encode side scales, decode side unscales ---

export function scaleForWire(m: OnglideWebSocketMessage): OnglideWebSocketMessage {
    return convMessage(m, ENCODE);
}
export function unscaleFromWire(m: OnglideWebSocketMessage): OnglideWebSocketMessage {
    return convMessage(m, DECODE);
}
export function scaleClassScoreHistoryForWire(m: ClassScoreHistory): ClassScoreHistory {
    return convClassScoreHistory(m, ENCODE);
}
export function unscaleClassScoreHistoryFromWire(m: ClassScoreHistory): ClassScoreHistory {
    return convClassScoreHistory(m, DECODE);
}

// --- clamp helpers (relocated here: only used at the protobuf encode boundary) ---

// Round a numeric stat to a non-negative uint32 suitable for the protobuf wire
// format. Returns undefined when the value isn't a finite non-negative number
// (e.g. stats-incremental returns -Number.MAX_VALUE for .max before any sample).
export function roundedUint32(v: number | undefined | null): number | undefined {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return undefined;
    return Math.round(v);
}

// As roundedUint32 but always yields a number (0 fallback) — for required uint32 slots.
export function clampUint32(v: number | undefined | null): number {
    return roundedUint32(v) ?? 0;
}

// As clampUint32 but for a signed int32 slot (tzoffset is legitimately negative
// for west-of-UTC sites, which roundedUint32 would reject).
export function clampInt32(v: number | undefined | null): number {
    return typeof v === 'number' && isFinite(v) ? Math.round(v) : 0;
}
