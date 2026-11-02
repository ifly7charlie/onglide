/**
 * Synthetic flight position generators for testing.
 *
 * Builds arrays of PositionMessage that simulate glider flights through
 * tasks, including starts, sector transits, outlandings, and finishes.
 */
import {Geodesic} from 'geographiclib-geodesic';
import type {PositionMessage, Epoch, Compno, AltitudeAMSL, Bearing, Speed} from '../../lib/types';

const G = Geodesic.WGS84;

// ── helpers ───────────────────────────────────────────────────────────────

/** Interpolate a single position along a great-circle from A to B. */
function interpGeodesic(
    from: {lat: number; lng: number},
    to: {lat: number; lng: number},
    fraction: number
): {lat: number; lng: number} {
    const inv = G.Inverse(from.lat, from.lng, to.lat, to.lng);
    const d = G.Direct(from.lat, from.lng, inv.azi1!, inv.s12! * fraction);
    return {lat: d.lat2!, lng: d.lon2!};
}

/** Distance in km between two points. */
function distKm(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
    return G.Inverse(a.lat, a.lng, b.lat, b.lng).s12! / 1000;
}

// ── public types ──────────────────────────────────────────────────────────

export interface Waypoint {
    lat: number;
    lng: number;
    /** Altitude AMSL in meters. Default 1000. */
    altitude?: number;
}

export interface FlightOptions {
    /** Competition number. Default 'AA'. */
    compno?: string;
    /** Interval between position fixes in seconds. Default 5. */
    interval?: number;
    /** Altitude AGL in meters (used for all points). Default 500. */
    agl?: number;
}

// ── generators ────────────────────────────────────────────────────────────

/**
 * Generate a straight-line flight from A to B at constant ground speed.
 */
export function makeStraightFlight(
    from: Waypoint,
    to: Waypoint,
    startTime: Epoch,
    speedKph: number,
    opts: FlightOptions = {}
): PositionMessage[] {
    const interval = opts.interval ?? 5;
    const compno = (opts.compno ?? 'AA') as Compno;
    const agl = opts.agl ?? 500;

    const distM = G.Inverse(from.lat, from.lng, to.lat, to.lng).s12!;
    const durationSecs = (distM / 1000 / speedKph) * 3600;
    const numPoints = Math.floor(durationSecs / interval) + 1;

    const points: PositionMessage[] = [];
    for (let i = 0; i < numPoints; i++) {
        const t = (startTime + i * interval) as Epoch;
        const frac = i / Math.max(numPoints - 1, 1);
        const pos = interpGeodesic(from, to, frac);
        const alt = (from.altitude ?? 1000) + frac * ((to.altitude ?? 1000) - (from.altitude ?? 1000));

        points.push({
            t,
            lat: pos.lat,
            lng: pos.lng,
            a: alt as AltitudeAMSL,
            g: agl as any,
            c: compno,
            _: false
        });
    }
    // Mark last point as live
    if (points.length) {
        points[points.length - 1]._ = true;
    }
    return points;
}

/**
 * Generate a multi-leg flight through a series of waypoints at constant speed.
 * Each waypoint is visited in order; the flight is a sequence of straight segments.
 */
export function makeMultiLegFlight(
    waypoints: Waypoint[],
    startTime: Epoch,
    speedKph: number,
    opts: FlightOptions = {}
): PositionMessage[] {
    if (waypoints.length < 2) return [];

    const interval = opts.interval ?? 5;
    const compno = (opts.compno ?? 'AA') as Compno;
    const agl = opts.agl ?? 500;

    const points: PositionMessage[] = [];
    let currentTime = startTime;

    for (let leg = 0; leg < waypoints.length - 1; leg++) {
        const from = waypoints[leg];
        const to = waypoints[leg + 1];
        const distM = G.Inverse(from.lat, from.lng, to.lat, to.lng).s12!;
        const durationSecs = (distM / 1000 / speedKph) * 3600;
        const numPoints = Math.max(Math.floor(durationSecs / interval), 1);

        for (let i = 0; i <= numPoints; i++) {
            // Skip first point of subsequent legs (it duplicates the last point of the previous)
            if (leg > 0 && i === 0) continue;

            const t = Math.round(currentTime + (i / numPoints) * durationSecs) as Epoch;
            const frac = i / numPoints;
            const pos = interpGeodesic(from, to, frac);
            const alt = (from.altitude ?? 1000) + frac * ((to.altitude ?? 1000) - (from.altitude ?? 1000));

            points.push({
                t,
                lat: pos.lat,
                lng: pos.lng,
                a: alt as AltitudeAMSL,
                g: agl as any,
                c: compno,
                _: false
            });
        }
        currentTime = (currentTime + durationSecs) as Epoch;
    }

    if (points.length) {
        points[points.length - 1]._ = true;
    }
    return points;
}

/**
 * Generate a flight that outlands at a given fraction of a leg.
 *
 * Flies through `completedWaypoints`, then flies `outlandFraction` of
 * the way toward `nextWaypoint` and stops (simulates landing).
 */
export function makeOutlandingFlight(
    completedWaypoints: Waypoint[],
    nextWaypoint: Waypoint,
    outlandFraction: number,
    startTime: Epoch,
    speedKph: number,
    opts: FlightOptions = {}
): PositionMessage[] {
    const lastCompleted = completedWaypoints[completedWaypoints.length - 1];
    const outlandPos = interpGeodesic(lastCompleted, nextWaypoint, outlandFraction);

    const allWaypoints = [
        ...completedWaypoints,
        {lat: outlandPos.lat, lng: outlandPos.lng, altitude: 300} // low altitude for landout
    ];

    const points = makeMultiLegFlight(allWaypoints, startTime, speedKph, opts);

    // Add a stationary point after landing (the scoring chain uses this to detect landout)
    if (points.length) {
        const last = points[points.length - 1];
        last._ = false;
        points.push({
            ...last,
            t: (last.t + 120) as Epoch, // 2 minutes later, still at same position
            g: 0 as any, // on the ground
            _: true
        });
    }

    return points;
}

/**
 * Add a few climbing points at the airfield before the en-route positions.
 *
 * The first points have low AGL (on the grid), then altitude ramps up so the
 * enrichedPositionGenerator classifies the pilot as airborne before the
 * en-route positions begin. All en-route positions should use a constant
 * cruise altitude (e.g. 2000 ft / 600 m AGL).
 */
export function addPreStart(
    flightPoints: PositionMessage[],
    airfieldLat: number,
    airfieldLng: number,
    launchTime: Epoch,
    opts: FlightOptions = {}
): PositionMessage[] {
    const compno = (opts.compno ?? flightPoints[0]?.c ?? 'AA') as Compno;
    const preStart: PositionMessage[] = [];
    const airfieldAlt = 400; // AMSL

    // Grid: stationary, on the ground
    for (let i = -60; i <= -10; i += 10) {
        preStart.push({
            t: (launchTime + i) as Epoch,
            lat: airfieldLat,
            lng: airfieldLng,
            a: airfieldAlt as AltitudeAMSL,
            g: 0 as any,
            c: compno,
            _: false
        });
    }

    // Climb: ramp altitude so the pilot is clearly airborne well before
    // the en-route positions start (which is when the start line gets crossed)
    const firstFlight = flightPoints[0];
    if (firstFlight) {
        const climbDuration = firstFlight.t - launchTime;
        const steps = Math.max(Math.floor(climbDuration / 5), 2);
        for (let i = 1; i <= steps; i++) {
            const frac = i / steps;
            const agl = frac * 600; // ramp to 600m AGL
            preStart.push({
                t: Math.round(launchTime + frac * climbDuration) as Epoch,
                lat: airfieldLat - frac * 0.002, // drift slightly away from task so not stationary
                lng: airfieldLng - frac * 0.002,
                a: (airfieldAlt + agl) as AltitudeAMSL,
                g: agl as any,
                c: compno,
                _: false
            });
        }
    }

    return [...preStart, ...flightPoints];
}

/**
 * Flag the first fix at or after t as a PEV press — the same next-fix
 * crediting the IGC parser applies to interleaved E records.
 */
export function markPevAt(points: PositionMessage[], t: number): void {
    const fix = points.find((p) => p.t >= t);
    if (fix) {
        fix.pev = true;
    }
}

/**
 * Helper: point offset from a center at a given bearing and distance.
 * Useful for placing waypoints inside/outside sectors.
 */
export function pointAtBearingDistance(
    center: {lat: number; lng: number},
    bearingDeg: number,
    distanceKm: number
): {lat: number; lng: number} {
    const d = G.Direct(center.lat, center.lng, bearingDeg, distanceKm * 1000);
    return {lat: d.lat2!, lng: d.lon2!};
}

// ── soaring flights (glides + thermal circles) ────────────────────────────

export type SoaringAction =
    | {
          /** Glide straight to this point (optionally to a target altitude). */
          glideTo: Waypoint;
          /** Ground speed for this glide (kph). Default 110. */
          speedKph?: number;
          /** Fly it without emitting fixes (a tracking outage while moving). */
          silent?: boolean;
      }
    | {
          /** Circle at the current position for this many seconds. */
          thermalSecs: number;
          /** Climb rate while circling (m/s). Default 2. */
          climbRate?: number;
      }
    | {
          /** Tracking outage: no fixes for this many seconds (position holds). */
          gapSecs: number;
      };

/**
 * Generate a soaring flight: alternating straight glides and climbing thermal
 * circles, dense enough (4 s fixes, ~15°/s turn) for the flightStatistics
 * classifier to segment reliably. Fixes carry tangent bearing + ground speed
 * like OGN data does.
 */
export function makeSoaringFlight(start: Waypoint, actions: SoaringAction[], startTime: Epoch, opts: FlightOptions = {}): PositionMessage[] {
    const interval = opts.interval ?? 4;
    const compno = (opts.compno ?? 'AA') as Compno;
    const agl = opts.agl ?? 500;

    const points: PositionMessage[] = [];
    let t = startTime as number;
    let lat = start.lat;
    let lng = start.lng;
    let alt = start.altitude ?? 1000;

    const push = (b?: number, s?: number) =>
        points.push({
            t: Math.round(t) as Epoch,
            lat,
            lng,
            a: Math.round(alt) as AltitudeAMSL,
            g: agl as any,
            c: compno,
            ...(b !== undefined ? {b: Math.round(b) as Bearing} : {}),
            ...(s !== undefined ? {s: Math.round(s) as Speed} : {}),
            _: false
        });

    push();

    for (const action of actions) {
        if ('glideTo' in action) {
            const speed = action.speedKph ?? 110;
            const from = {lat, lng};
            const inv = G.Inverse(from.lat, from.lng, action.glideTo.lat, action.glideTo.lng);
            const durationSecs = inv.s12! / 1000 / (speed / 3600);
            const targetAlt = action.glideTo.altitude ?? alt - durationSecs * 0.7; // gentle descent by default
            if (action.silent) {
                lat = action.glideTo.lat;
                lng = action.glideTo.lng;
                alt = targetAlt;
                t += durationSecs;
                continue;
            }
            const steps = Math.max(Math.ceil(durationSecs / interval), 1);
            const fromAlt = alt;
            for (let i = 1; i <= steps; i++) {
                const frac = i / steps;
                const pos = interpGeodesic(from, action.glideTo, frac);
                lat = pos.lat;
                lng = pos.lng;
                alt = fromAlt + frac * (targetAlt - fromAlt);
                t += durationSecs / steps;
                push(inv.azi1! < 0 ? inv.azi1! + 360 : inv.azi1!, speed);
            }
        } else if ('thermalSecs' in action) {
            const climb = action.climbRate ?? 2;
            const radiusKm = 0.15;
            const periodSecs = 24; // ~15°/s — comfortably above the thermal-entry threshold
            const centre = {lat, lng};
            const steps = Math.max(Math.ceil(action.thermalSecs / interval), 1);
            for (let i = 1; i <= steps; i++) {
                const ang = ((i * interval) / periodSecs) * 360;
                const pos = pointAtBearingDistance(centre, ang % 360, radiusKm);
                lat = pos.lat;
                lng = pos.lng;
                alt += climb * interval;
                t += interval;
                push((ang + 90) % 360, (2 * Math.PI * radiusKm * 3600) / periodSecs);
            }
        } else {
            t += action.gapSecs;
        }
    }

    if (points.length) {
        points[points.length - 1]._ = true;
    }
    return points;
}
