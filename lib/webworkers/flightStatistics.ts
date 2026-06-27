/*
 * Per-flight statistics: walks the enriched position stream, classifies it
 * into thermal / straight / gap segments using a small state machine, and
 * estimates wind direction/speed from the in-thermal speed-vs-bearing fan.
 *
 * Logic ported and cleaned up from archive/igcstatistics.js, restructured so
 * it can run incrementally as positions arrive instead of batch on a finished
 * flight.
 *
 * createFlightStatistics() returns an incremental push unit driven by whoever
 * owns the position stream (the APRS worker per aircraft, or the client IGC
 * scorer). It is deliberately decoupled from scoring — it reads only raw fix
 * geometry (t / altitude / lng / lat / bearing / speed):
 *   addPosition(fix) — advance the state machine for one forward fix
 *   getStats()       — the current Stats (closed segments + the open one)
 *   getWind()        — the most recently estimated wind
 *   reset()          — drop all state (a new track / tracker change)
 */

import {Stats, StatSegment, Wind} from '../protobuf/onglide';
import {distHaversineRaw} from '../flightprocessing/taskhelper';

// Minimal per-fix shape the state machine needs — a subset of PositionMessage /
// EnrichedPosition, so any forward position source can drive it.
export interface StatsFix {
    t: number;
    a: number; // altitude AMSL
    lng: number;
    lat: number;
    b?: number; // bearing (deg)
    s?: number; // ground speed (kph)
}

// Soaring thresholds. The original walked three widening tolerance levels in
// a batch coalesce loop; for incremental processing we pick a single fixed
// level (the loosest, which is what the original would have arrived at).
const MIN_CIRCLE_DEGREES = 220;
const MIN_STRAIGHT_DISTANCE_KM = 1.5;
const MIN_STRAIGHT_TIME_S = 22;

// State machine entry/exit thresholds (per-second bearing change, degrees)
const ENTER_THERMAL_DEG_PER_S = 6; // 360/60
const EXIT_THERMAL_DEG_PER_S = 3.75; // 15/4

// Anything bigger than this is treated as a tracking gap, not a flown segment
const MAX_GAP_S = 60;

type Mode = 'start' | 'straight' | 'thermal' | 'gap';

interface Circle {
    minSpeed: number;
    minAngle: number;
    maxSpeed: number;
    maxAngle: number;
    cumulative: number; // signed bearing change accumulated this rotation
    packets: number;
}

interface Segment {
    state: Mode;
    startTime: number;
    endTime: number;
    startLng: number;
    startLat: number;
    endLng: number;
    endLat: number;
    startAlt: number;
    endAlt: number;
    turncount: number; // signed sum of bearing changes
    distance: number; // km
    heightgain: number;
    heightloss: number;
    direction: number; // signed sum of per-fix turn signs (-/0/+)
    packets: number;
    maxDelay: number;
    ws: Circle; // in-progress rotation for wind sampling
    circles: Circle[]; // completed rotations
    wind?: {speed: number; direction: number};
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function bearingRaw(lng1: number, lat1: number, lng2: number, lat2: number): number {
    const φ1 = lat1 * D2R;
    const φ2 = lat2 * D2R;
    const Δλ = (lng2 - lng1) * D2R;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * R2D + 360) % 360;
}

function normalizeAngle(a: number): number {
    a = a % 360;
    return a < 0 ? a + 360 : a;
}

function makeEmptyCircle(): Circle {
    return {minSpeed: Infinity, minAngle: 0, maxSpeed: -Infinity, maxAngle: 0, cumulative: 0, packets: 0};
}

function makeSegment(state: Mode, startTime: number, startLng: number, startLat: number, startAlt: number): Segment {
    return {
        state,
        startTime,
        endTime: startTime,
        startLng,
        startLat,
        endLng: startLng,
        endLat: startLat,
        startAlt,
        endAlt: startAlt,
        turncount: 0,
        distance: 0,
        heightgain: 0,
        heightloss: 0,
        direction: 0,
        packets: 0,
        maxDelay: 0,
        ws: makeEmptyCircle(),
        circles: [],
        wind: undefined
    };
}

export function createFlightStatistics() {
    // === closure state — the only place stats data lives ===
    let segments: Segment[] = [];
    let open: Segment | null = null;
    let mode: Mode = 'start';
    let havePrev = false;
    let prevTime = 0;
    let prevAlt = 0;
    let prevLng = 0;
    let prevLat = 0;
    let prevBearing = 0;
    let smoothedTurnRate = 0;
    let lastWind: {speed: number; direction: number} | undefined;

    function reset(): void {
        segments = [];
        open = null;
        mode = 'start';
        havePrev = false;
        prevTime = 0;
        prevAlt = 0;
        prevLng = 0;
        prevLat = 0;
        prevBearing = 0;
        smoothedTurnRate = 0;
        lastWind = undefined;
    }

    // Decide whether a just-closed segment should be merged into its
    // immediate predecessor. Mirrors the original coalesceStack rules but
    // applied once per close (no triple-tolerance retry loop).
    function shouldMerge(prev: Segment, cur: Segment): boolean {
        if (cur.state === 'gap' || prev.state === 'gap') return false;
        if (prev.state === cur.state) return true;
        if (cur.state === 'straight') {
            const elapsed = cur.endTime - cur.startTime;
            const dist = distHaversineRaw([cur.startLng, cur.startLat], [cur.endLng, cur.endLat]);
            if (elapsed < MIN_STRAIGHT_TIME_S && dist < MIN_STRAIGHT_DISTANCE_KM) return true;
        }
        if (cur.state === 'thermal') {
            if (Math.abs(cur.turncount) < MIN_CIRCLE_DEGREES || cur.endTime - cur.startTime < 6) return true;
        }
        return false;
    }

    function mergeInto(prev: Segment, cur: Segment): void {
        prev.heightgain += cur.heightgain;
        prev.heightloss += cur.heightloss;
        prev.distance += cur.distance;
        prev.endTime = cur.endTime;
        prev.endLng = cur.endLng;
        prev.endLat = cur.endLat;
        prev.endAlt = cur.endAlt;

        // Sum-of-turns reconciliation (same as archive): if a long combined
        // turn comes from opposite directions, that's a "mixed" thermal.
        if (Math.abs(cur.turncount) + Math.abs(prev.turncount) > 360 && Math.sign(prev.turncount) !== 0 && Math.sign(cur.turncount) !== 0 && Math.sign(prev.turncount) !== Math.sign(cur.turncount)) {
            prev.turncount = (Math.abs(prev.turncount) + Math.abs(cur.turncount)) * Math.sign(prev.direction || cur.direction || 1);
        } else {
            prev.turncount += cur.turncount;
        }

        prev.direction += cur.direction;
        prev.packets += cur.packets;
        prev.maxDelay = Math.max(prev.maxDelay, cur.maxDelay);

        // Pull in any in-progress rotation from cur as a complete circle if
        // it had reached enough turn to be useful.
        if (Math.abs(cur.ws.cumulative) >= 270 && cur.ws.packets > 4) {
            cur.circles.push(cur.ws);
        }
        prev.circles.push(...cur.circles);

        // If a thermal participated in the merge, the result is thermal-ish
        // and wind needs a recalculation.
        if (cur.state === 'thermal' || prev.state === 'thermal') {
            prev.state = 'thermal';
            computeWind(prev);
        }
    }

    function pushOpen(): void {
        if (!open) return;
        const seg = open;
        open = null;

        if (seg.state === 'thermal') {
            // Promote the in-progress rotation if it nearly closed
            if (Math.abs(seg.ws.cumulative) >= 270 && seg.ws.packets > 4) {
                seg.circles.push(seg.ws);
                seg.ws = makeEmptyCircle();
            }
            computeWind(seg);
        }

        const prev = segments[segments.length - 1];
        if (prev && shouldMerge(prev, seg)) {
            mergeInto(prev, seg);
        } else {
            segments.push(seg);
        }
    }

    // Wind from circling drift: across each completed rotation the slowest
    // ground-speed fix is heading most into wind, the fastest most downwind.
    // The bisector of those two bearings (180°-flipped) is the wind direction;
    // half their speed difference is the wind speed. Quality gate rejects
    // rotations whose min/max bearings aren't roughly opposite.
    function computeWind(seg: Segment): void {
        if (!seg.circles.length) return;
        let count = 0;
        let sumSpeed = 0;
        let sumX = 0;
        let sumY = 0;
        for (const circle of seg.circles) {
            if (circle.minSpeed === Infinity || circle.maxSpeed <= 0) continue;
            const angleDiff = Math.abs(((circle.maxAngle - circle.minAngle + 180) % 360) - 180);
            const quality = 5 - Math.abs(180 - angleDiff) / 8;
            if (quality < 3.5 || quality > 5) continue;

            const maxAngleInverted = (circle.maxAngle + 180) % 360;
            const absAngleDiff = Math.abs(maxAngleInverted - circle.minAngle);
            const [bisector, base] =
                absAngleDiff > 180 //
                    ? [(360 - absAngleDiff) / 2, circle.minAngle]
                    : [absAngleDiff / 2, maxAngleInverted];
            const windAngle = normalizeAngle(maxAngleInverted <= circle.minAngle ? base + bisector : base - bisector);
            const windSpeed = (circle.maxSpeed - circle.minSpeed) / 2;

            sumSpeed += windSpeed;
            sumX += Math.cos(windAngle * D2R);
            sumY += Math.sin(windAngle * D2R);
            count++;
        }
        if (count > 0) {
            const direction = normalizeAngle(Math.atan2(sumY / count, sumX / count) * R2D);
            const speed = sumSpeed / count;
            seg.wind = {speed, direction};
            lastWind = seg.wind;
        }
    }

    function liftSegment(s: Segment): StatSegment {
        const elapsed = Math.max(s.endTime - s.startTime, 1);
        const achieved = distHaversineRaw([s.startLng, s.startLat], [s.endLng, s.endLat]);
        // Map sign aggregator to proto direction: 0 = mixed/none, 1 = left, 2 = right
        const sgn = Math.sign(s.direction);
        const dirProto = sgn === 0 ? 0 : sgn < 0 ? 1 : 2;
        return {
            start: s.startTime,
            end: s.endTime,
            state: s.state,
            wind: s.wind ? {speed: Math.round(s.wind.speed), direction: Math.round(s.wind.direction)} : undefined,
            turncount: Math.floor(Math.abs(s.turncount)),
            distance: Math.round(s.distance * 10) / 10,
            achievedDistance: Math.round(achieved * 10) / 10,
            delta: Math.round(s.heightgain - s.heightloss),
            avgDelta: Math.round(((s.heightgain - s.heightloss) / elapsed) * 10) / 10,
            direction: dirProto,
            heightgain: Math.round(s.heightgain),
            heightloss: Math.round(s.heightloss)
        };
    }

    function toStatsProto(): Stats | undefined {
        if (!segments.length && !open) return undefined;
        const out: StatSegment[] = [];
        for (const s of segments) out.push(liftSegment(s));
        if (open) out.push(liftSegment(open));
        return {segments: out};
    }

    // === addPosition: advance the state machine for one forward fix ===
    // Caller must feed fixes in ascending time order (out-of-order/duplicate
    // fixes are ignored) and call reset() when the track restarts.
    function addPosition(point: StatsFix): void {
        // First fix: just remember it, no segment yet
        if (!havePrev) {
            havePrev = true;
            prevTime = point.t;
            prevAlt = point.a;
            prevLng = point.lng;
            prevLat = point.lat;
            prevBearing = point.b ?? 0;
            return;
        }

        const timedif = point.t - prevTime;
        if (timedif <= 0) {
            // out-of-order or duplicate timestamp
            return;
        }

        const distance = distHaversineRaw([prevLng, prevLat], [point.lng, point.lat]);
        const bearing = ((point.b ?? bearingRaw(prevLng, prevLat, point.lng, point.lat)) + 360) % 360;
        const speed = point.s ?? (timedif > 0 ? (3600 * distance) / timedif : 0);

        // Signed bearing change in (-180, 180] — preserves turn direction
        // across the 0/360 boundary. The archive lost the sign here.
        let bearingChange = bearing - prevBearing;
        if (bearingChange > 180) bearingChange -= 360;
        else if (bearingChange < -180) bearingChange += 360;
        const rawBearingChange = bearingChange;
        // per-second turn rate (so sparse samples don't trigger thermal mode)
        bearingChange = bearingChange / timedif;

        // While in a thermal, smooth the turn rate. If extrapolation from
        // the previous smoothed rate matches the observed bearing closely,
        // trust the forecast — points were probably dropped.
        if (mode === 'thermal') {
            const forecast = (smoothedTurnRate * timedif + prevBearing) % 360;
            let forecastErr = ((forecast - bearing + 540) % 360) - 180;
            if (forecastErr < -180) forecastErr += 360;
            if (timedif > 5 && timedif < 20 && Math.abs(forecastErr) < 10) {
                bearingChange = smoothedTurnRate;
            } else {
                smoothedTurnRate = (smoothedTurnRate + bearingChange) / 2;
                bearingChange = smoothedTurnRate;
            }
        } else {
            smoothedTurnRate = bearingChange;
        }

        // Per-fix turn sign (for the segment direction aggregator)
        const tdirection = bearingChange > 2 ? 1 : bearingChange < -2 ? -1 : 0;

        // Big tracking gap: emit a synthetic gap segment, then resume
        // classification afresh from this point.
        if (timedif > MAX_GAP_S) {
            pushOpen();
            const gapSeg = makeSegment('gap', prevTime, prevLng, prevLat, prevAlt);
            gapSeg.endTime = point.t;
            gapSeg.endLng = point.lng;
            gapSeg.endLat = point.lat;
            gapSeg.endAlt = point.a;
            segments.push(gapSeg);
            mode = 'start';
            prevTime = point.t;
            prevAlt = point.a;
            prevLng = point.lng;
            prevLat = point.lat;
            prevBearing = bearing;
            smoothedTurnRate = 0;
            return;
        }

        // Decide what mode this fix belongs to
        let nextMode: Mode = mode;
        if (mode === 'start') {
            nextMode = Math.abs(bearingChange) > ENTER_THERMAL_DEG_PER_S ? 'thermal' : 'straight';
        } else if (mode === 'straight') {
            if (Math.abs(bearingChange) > ENTER_THERMAL_DEG_PER_S) nextMode = 'thermal';
        } else if (mode === 'thermal') {
            if (Math.abs(bearingChange) < EXIT_THERMAL_DEG_PER_S) nextMode = 'straight';
        }

        // Mode transition: close current segment and open a new one that
        // begins where the previous fix was so segments abut cleanly.
        if (nextMode !== mode || !open) {
            pushOpen();
            open = makeSegment(nextMode, prevTime, prevLng, prevLat, prevAlt);
            mode = nextMode;
        }

        // Accumulate this fix into the open segment
        open.distance += distance;
        open.endTime = point.t;
        open.endLng = point.lng;
        open.endLat = point.lat;
        open.endAlt = point.a;
        if (point.a > prevAlt) open.heightgain += point.a - prevAlt;
        else open.heightloss += prevAlt - point.a;
        open.turncount += rawBearingChange;
        open.direction += tdirection;
        open.packets++;
        if (timedif > open.maxDelay) open.maxDelay = timedif;

        // Inside a thermal, sample speed-vs-bearing per rotation for wind
        if (open.state === 'thermal') {
            if (speed < open.ws.minSpeed) {
                open.ws.minSpeed = speed;
                open.ws.minAngle = bearing;
            }
            if (speed > open.ws.maxSpeed) {
                open.ws.maxSpeed = speed;
                open.ws.maxAngle = bearing;
            }
            open.ws.cumulative += rawBearingChange;
            open.ws.packets++;
            if (open.ws.cumulative < -361 || open.ws.cumulative > 361) {
                open.circles.push(open.ws);
                open.ws = makeEmptyCircle();
                computeWind(open);
            }
        }

        prevTime = point.t;
        prevAlt = point.a;
        prevLng = point.lng;
        prevLat = point.lat;
        prevBearing = bearing;
    }

    function getWind(): Wind | undefined {
        return lastWind ? {speed: Math.round(lastWind.speed), direction: Math.round(lastWind.direction)} : undefined;
    }

    return {addPosition, getStats: toStatsProto, getWind, reset};
}

export type FlightStatistics = ReturnType<typeof createFlightStatistics>;
