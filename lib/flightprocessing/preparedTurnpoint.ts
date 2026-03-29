// PreparedTurnpoint.ts
import {Geodesic} from 'geographiclib-geodesic';
import type {TaskLeg, BasePositionMessage, DistanceKM, Epoch} from '../types';
import type {Feature, LineString, Polygon} from 'geojson';

const G = Geodesic.WGS84;

/** Angle helpers (standalone) */
function norm360(x: number) {
    let y = x % 360;
    if (y < 0) y += 360;
    return y;
}
function norm180(x: number) {
    let y = (x + 180) % 360;
    if (y < 0) y += 360;
    return y - 180;
}
function deg2rad(x: number) {
    return (x * Math.PI) / 180;
}
function rad2deg(x: number) {
    return (x * 180) / Math.PI;
}

type KM = number;
type M = number;

export interface Crossing {
    /** True if this event crosses into the region / correct-side; false if leaving */
    entered: boolean;
    /** True if this event crosses out of the region / correct-side; false if entering */
    left: boolean;
    /** Crossing position with interpolated t and a */
    at: BasePositionMessage;
}

export interface HasCrossedResult {
    crossings: Crossing[];
    finalInside: boolean;
    /** True if the segment was inside at any time after prev, i.e. if we either crossed
    into the sector at some point or ended inside. */
    everInside: boolean;
    /** Nearest distance from POS to the boundary (0 if crossing into correct side/inside). */
    distanceKm?: DistanceKM;
    /** Boundary point corresponding to distanceKm; carries t/a from POS when synthesized. */
    onBoundary?: BasePositionMessage;
    /** When the infinite line was crossed but outside the finite extent,
     *  how far beyond the nearest line endpoint (meters, positive). */
    nearMissBeyondM?: number;
    /** Crossing positioned at the nearest line endpoint (not on the extension).
     *  Time is interpolated from the infinite-line crossing fraction. */
    nearMissCrossing?: Crossing;
}

type AccNearest = {
    az: number; // azimuth reference
    s: number; // point location on azimuth (distance m)
    d2: number; // distance squared
};
type Acc = {intersections: number[]; nearest: AccNearest[]};

/**
 * PreparedTurnpoint precomputes bearings, radial edges, and line endpoints for a TaskLeg.
 * All geometry is WGS84 via geographiclib. Intersections are solved analytically in a
 * local tangent plane at the center and mapped back using geodesics.
 *
 * IMPORTANT:
 * - a1/a2 are HALF-ANGLES (±a around the sector’s centerline), so total span is 2*a.
 * - r1/a1 = DEPARTURE lobe (centered on approachMid+180°).
 * - r2/a2 = APPROACH lobe (centered on approachMid).
 */
export class PreparedTurnpoint {
    readonly leg: TaskLeg;
    readonly legs: TaskLeg[];

    // Sector centerlines
    readonly approachMid: number; // direction the task approaches from
    readonly departureMid: number; // approachMid + 180

    readonly brPP: number | undefined;
    readonly brNP: number | undefined; // bearing to next turnpoint

    // Sector (precomputed)
    readonly hasDep: boolean; // r1/a1 present (DEPARTURE)
    readonly hasDepWedge: boolean; // r1+a1 but not a circle
    readonly hasApp: boolean; // r2/a2 present (APPROACH)
    readonly hasAppWedge: boolean; // r2+a2 but not a circle
    readonly r1m: M;
    readonly r2m: M;
    readonly depLeft: number; // departure edges (±a1 about departureMid)
    readonly depRight: number;
    readonly appLeft: number; // approach edges (±a2 about approachMid)
    readonly appRight: number;

    // Line (precomputed)
    readonly lineBearing: number; // oriented + a1 (for lines, a1 is relative angle)
    readonly lineNormalSign: number;
    readonly lineHalfLenM: M;
    readonly lineEndA?: {lat: number; lng: number};
    readonly lineEndB?: {lat: number; lng: number};

    constructor(legs: TaskLeg[], legno: number) {
        this.legs = legs;
        this.leg = legs[legno];

        // Distances in meters
        this.r1m = (this.leg.r1 ?? 0) * 1000;
        this.r2m = (this.leg.r2 ?? 0) * 1000;

        // Resolve sector centerline per direction policy (this is the APPROACH centerline)
        const center = {lat: this.leg.nlat, lon: this.leg.nlng};
        const prev = legs[legno - 1];
        const next = legs[legno + 1];

        // pp: bearing FROM this turnpoint TO previous; np: FROM this turnpoint TO next
        this.brPP = prev ? norm360(G.Inverse(center.lat, center.lon, prev.nlat, prev.nlng).azi1!) : undefined;
        this.brNP = next ? norm360(G.Inverse(center.lat, center.lon, next.nlat, next.nlng).azi1!) : undefined;

        let approach = norm360(this.leg.a12);
        switch (this.leg.direction) {
            case 'fixed':
                approach = norm360(this.leg.a12);
                break;
            case 'pp':
                approach = this.brPP ?? norm360(this.leg.a12);
                break;
            case 'np':
                approach = this.brNP ?? norm360(this.leg.a12);
                break;
            case 'symmetrical':
                if (this.brPP !== undefined && this.brNP !== undefined) {
                    const aR = deg2rad(this.brPP),
                        bR = deg2rad(this.brNP);
                    const x = Math.cos(aR) + Math.cos(bR);
                    const y = Math.sin(aR) + Math.sin(bR);
                    approach = norm360(rad2deg(Math.atan2(y, x)));
                } else {
                    approach = norm360(this.leg.a12);
                }
                break;
        }
        this.approachMid = approach;
        this.departureMid = norm360(approach + 180);

        // Sector precompute (a1/a2 are half-angles)
        this.hasDep = this.leg.type === 'sector' && (this.leg.a1 ?? 0) > 0 && this.r1m > 0; // r1/a1
        this.hasApp = this.leg.type === 'sector' && (this.leg.a2 ?? 0) > 0 && this.r2m > 0; // r2/a2
        this.hasDepWedge = this.hasDep && this.leg.a1 < 180;
        this.hasAppWedge = this.hasApp && this.leg.a2 < 180;

        this.depLeft = norm360(this.departureMid - (this.leg.a1 ?? 0));
        this.depRight = norm360(this.departureMid + (this.leg.a1 ?? 0));
        this.appLeft = norm360(this.approachMid - (this.leg.a2 ?? 0));
        this.appRight = norm360(this.approachMid + (this.leg.a2 ?? 0));

        // Line precompute (unchanged)
        this.lineBearing = norm360(this.departureMid + (this.leg.a1 ?? 0)); // keep "a1 relative to direction" semantics
        this.lineHalfLenM = this.r1m;

        if (this.leg.type === 'line') {
            const A = G.Direct(center.lat, center.lon, this.lineBearing, +this.lineHalfLenM);
            const B = G.Direct(center.lat, center.lon, this.lineBearing, -this.lineHalfLenM);
            this.lineEndA = {lat: A.lat2!, lng: A.lon2!};
            this.lineEndB = {lat: B.lat2!, lng: B.lon2!};
            this.lineNormalSign = this._lineNormalSign();
        }
    }

    /** Detect boundary crossings along prev->pos. */
    hasCrossed(prev: BasePositionMessage, pos: BasePositionMessage): HasCrossedResult {
        return this.leg.type === 'line' ? this._hasCrossedLine(prev, pos) : this._hasCrossedSector(prev, pos);
    }

    /** Just check if a point is in a sector, always -1e for lines, distance to center! */
    fromSector(pos: BasePositionMessage): DistanceKM | undefined {
        return this.hasCrossed(pos, pos).distanceKm;
    }

    /** calculate an approximate distance between the two points */
    interpointDistance(prev: BasePositionMessage, pos: BasePositionMessage): DistanceKM {
        if (this._isCached(pos) && this._isCached(prev)) {
            const invPos = this._cacheInPoint(pos).inv;
            const invPrev = this._cacheInPoint(prev).inv;
            // Local frame at the line bearing
            const {u: u0, v: v0} = this._uvInv(this.departureMid, invPrev);
            const {u: u1, v: v1} = this._uvInv(this.departureMid, invPos); //left-positive cross-track to the line
            return (Math.sqrt((u0 - u1) * (u0 - u1) + (v0 - v1) * (v0 - v1)) / 1000) as DistanceKM;
        } else {
            return (G.Inverse(prev.lat, prev.lng, pos.lat, pos.lng, Geodesic.DISTANCE).s12! / 1000) as DistanceKM;
        }
    }

    /** Geodesic distance between two points in km. */
    static geodesicDistance(from: BasePositionMessage, to: BasePositionMessage): DistanceKM {
        return (G.Inverse(from.lat, from.lng, to.lat, to.lng, Geodesic.DISTANCE).s12! / 1000) as DistanceKM;
    }

    /** Interpolate a point along the geodesic from `from` to `to` at `distance` km from `from`. */
    static interpolatePoint(from: BasePositionMessage, to: BasePositionMessage, distance: DistanceKM): BasePositionMessage {
        const inv = G.Inverse(from.lat, from.lng, to.lat, to.lng, Geodesic.AZIMUTH);
        const result = G.Direct(from.lat, from.lng, inv.azi1!, distance * 1000, Geodesic.LATITUDE | Geodesic.LONGITUDE);
        return {t: to.t, a: to.a, lat: result.lat2!, lng: result.lon2!};
    }

    scoredPointRemaining(remaining: DistanceKM): BasePositionMessage | undefined {
        if (!this.brPP) {
            return undefined;
        }
        const result = G.Direct(this.leg.nlat, this.leg.nlng, this.brPP, remaining * 1000, Geodesic.LATITUDE | Geodesic.LONGITUDE);
        return {t: 0 as BasePositionMessage['t'], a: 0, lat: result.lat2!, lng: result.lon2!};
    }

    public toGeoJSON(): Feature<Polygon | LineString, {}> {
        const centerLat = this.leg.nlat;
        const centerLng = this.leg.nlng;

        const deg2rad = (d: number) => (d * Math.PI) / 180;
        const rad2deg = (r: number) => (r * 180) / Math.PI;
        const norm2pi = (r: number) => {
            const t = r % (2 * Math.PI);
            return t < 0 ? t + 2 * Math.PI : t;
        };

        // Geodesic alias
        const direct = (azDeg: number, distM: number) => G.Direct(centerLat, centerLng, azDeg, distM);

        // --- LINE ---
        if (this.leg.type === 'line') {
            const A =
                this.lineEndA ??
                (() => {
                    const d = direct(this.lineBearing, +this.lineHalfLenM);
                    return {lat: d.lat2!, lng: d.lon2!};
                })();
            const B =
                this.lineEndB ??
                (() => {
                    const d = direct(this.lineBearing, -this.lineHalfLenM);
                    return {lat: d.lat2!, lng: d.lon2!};
                })();

            return {
                type: 'Feature',
                properties: {legno: this.leg.legno},
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [A.lng, A.lat],
                        [B.lng, B.lat]
                    ]
                }
            };
        }

        // --- SECTOR ---
        const polypoints: [number, number][] = [];

        // Center and half-angles in radians (PreparedTurnpoint already computed approachMid)
        const centerRad = deg2rad(this.departureMid);
        const a1 = this.leg.a1 ?? 0; // degrees (half-angle)
        const a2 = this.leg.a2 ?? 0; // degrees (half-angle)
        const a1rad = deg2rad(a1);
        const a2rad = deg2rad(a2);

        // Radii in meters
        const r1 = this.r1m;
        const r2 = this.r2m;

        // From/To exactly like sectorGeoJSON
        const from = norm2pi(centerRad - a1rad);
        const to = norm2pi(centerRad + a1rad);

        const steps = 25;

        // addArc using WGS84, with the same termination behavior as taskhelper (fixed step count, no while-loops)
        const addArc = (
            startRad: number,
            endRad: number,
            radiusM: number,
            _backwards: boolean // kept for parity with taskhelper signature; intentionally unused
        ): [number, number][] => {
            const pts: [number, number][] = [];
            const startQ = Math.round(norm2pi(startRad) * steps);
            const endQ = Math.round(norm2pi(endRad) * steps);

            if (startQ === endQ) {
                // Full circle: iterate 2π → 0 with adj = π/steps, then add closing point at 2π
                const adj = Math.PI / steps;
                for (let ang = 2 * Math.PI; ang >= 0; ang -= adj) {
                    const d = direct(rad2deg(ang % (2 * Math.PI)), radiusM);
                    pts.push([d.lon2!, d.lat2!]);
                }
                const d0 = direct(0, radiusM);
                pts.push([d0.lon2!, d0.lat2!]);
                return pts;
            }

            const s = norm2pi(startRad);
            const e = norm2pi(endRad);
            const sweep = s <= e ? e - s : 2 * Math.PI - (s - e); // CCW sweep from s to e
            const adj = sweep / steps;
            for (let k = 0; k <= steps; k++) {
                const ang = norm2pi(s + k * adj);
                const d = direct(rad2deg(ang), radiusM);
                pts.push([d.lon2!, d.lat2!]);
            }
            return pts;
        };

        // Start point inclusion matches taskhelper semantics
        if (a1 !== 180 && r2 === 0) {
            polypoints.push([centerLng, centerLat]);
        }

        // Outer arc at r1 (the helper passes a 'backwards' boolean here but its addArc ignores it)
        polypoints.push(...addArc(from, to, r1, !!r2));

        // Inner/second arc combinations
        if (a2 !== 0 && !Number.isNaN(a2) && !Number.isNaN(r2) && Math.round(Math.abs(a2)) === Math.round(Math.abs(a1)) && r1 !== r2 && r2 !== 0) {
            // Equal half-angles, different radii => annular wedge; inner arc reversed (order only)
            polypoints.push(...addArc(centerRad + a1rad, centerRad - a1rad, r2, true));
            polypoints.push(polypoints[0]);
        } else if (a2 !== 0 && !Number.isNaN(a2) && !Number.isNaN(r2) && a1 !== a2 && r1 !== r2) {
            // Different half-angles: two inner arcs with center point between
            polypoints.push(...addArc(centerRad + a1rad, centerRad + a2rad, r2, false));
            if (a2 !== 180) polypoints.push([centerLng, centerLat]);
            polypoints.push(...addArc(centerRad - a2rad, centerRad - a1rad, r2, false));
            polypoints.push(polypoints[0]);
        } else if (a2 === 0 && r1 !== r2 && r2 !== 0) {
            // a2 configured as 0 but r2 present: inner arc from +a1 to −a1 CCW
            polypoints.push(...addArc(centerRad + a1rad, centerRad - a1rad, r2, false));
        } else if (a1 !== 180) {
            // Simple wedge: add center again at end
            polypoints.push([centerLng, centerLat]);
        }

        // Precision reduction to match taskhelper visual output
        for (let i = 0; i < polypoints.length; i++) {
            polypoints[i][0] = Math.fround(100000 * polypoints[i][0]) / 100000;
            polypoints[i][1] = Math.fround(100000 * polypoints[i][1]) / 100000;
        }

        const coerced: [number, number][] = [];
        for (let i = 0; i < polypoints.length; i++) {
            const c = polypoints[i];
            const x = Number(c?.[0]);
            const y = Number(c?.[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            // 2) Drop consecutive duplicates (including exact closure repeats injected by generators)
            const last = coerced[coerced.length - 1];
            if (last && Math.abs(last[0] - x) < 1e-12 && Math.abs(last[1] - y) < 1e-12) continue;
            coerced.push([x, y]);
        }

        return {
            type: 'Feature',
            properties: {legno: this.leg.legno},
            geometry: {
                type: 'Polygon',
                coordinates: [coerced]
            }
        };
    }

    // ---------------- Crossing: line ----------------

    /** +1 if left-normal (lineBearing+90) is closer to the task direction through this line;
     *  -1 if right-normal is closer.
     *
     *  The task direction is: toward brNP for the start (leg 0, no previous),
     *  from brPP for the finish (last leg, no next), or brNP for middle legs.
     *  This is independent of the `direction` field which controls line orientation. */
    private _lineNormalSign(): number {
        // Task direction through the line: for start use brNP, for finish use
        // opposite of brPP (= direction pilot is heading after crossing),
        // for middle legs brNP
        const taskDirection = this.brNP ?? norm360((this.brPP ?? 0) + 180);
        const left = norm360(this.lineBearing + 90);
        const right = norm360(this.lineBearing - 90);
        const dl = Math.abs(norm180(taskDirection - left));
        const dr = Math.abs(norm180(taskDirection - right));
        return dl <= dr ? +1 : -1;
    }

    /** Debug flag: set to true to enable logging in _hasCrossedLine */
    static debugLine = false;

    /** Analytic crossing with the infinite line; then check finite extent and direction. */
    private _hasCrossedLine(prev: BasePositionMessage, pos: BasePositionMessage): HasCrossedResult {
        const invPos = (this._cacheInPoint(pos).inv ??= G.Inverse(this.leg.nlat, this.leg.nlng, pos.lat, pos.lng, Geodesic.DISTANCE | Geodesic.AZIMUTH));
        const invPrev = (this._cacheInPoint(prev).inv ??= G.Inverse(this.leg.nlat, this.leg.nlng, prev.lat, prev.lng, Geodesic.DISTANCE | Geodesic.AZIMUTH));

        // Local frame at the line bearing
        const {u: u0, v: v0} = this._uvInv(this.lineBearing, invPrev);
        const {u: u1, v: v1} = this._uvInv(this.lineBearing, invPos); //left-positive cross-track to the line

        const dv = v1 - v0;
        let finalInside = v1 * this.lineNormalSign >= 0; // based on forward-normal side

        if (Math.abs(dv) > 1e-9) {
            const t = -v0 / dv; // v(t)=0 -> intersection with infinite line
            if (t > 0 && t < 1) {
                const u = u0 + t * (u1 - u0);
                if (PreparedTurnpoint.debugLine) {
                    const beyond = Math.max(0, Math.abs(u) - this.lineHalfLenM);
                    console.log(`  LINE-DBG leg${this.leg.legno} t=${pos.t}: v0=${v0.toFixed(0)} v1=${v1.toFixed(0)} u@cross=${u.toFixed(0)} halfLen=${this.lineHalfLenM} beyond=${beyond.toFixed(0)} finalInside=${finalInside}`);
                }
                if (Math.abs(u) <= this.lineHalfLenM + 1e-6) {
                    const at = this._interpOnGeodesic(prev, pos, t);
                    // Correct direction iff dv has same sign as the chosen forward normal
                    const dirOk = dv * this.lineNormalSign > 0;
                    finalInside = v1 * this.lineNormalSign >= 0; // left-positive cross-track to the line

                    if (finalInside) {
                        // only a crossing if we go the right way
                        return {
                            crossings: [{entered: dirOk, left: !dirOk, at}],
                            finalInside: false,
                            everInside: finalInside
                        };
                    }
                } else if (finalInside) {
                    // Near-miss: crossed infinite line beyond finite extent, correct direction.
                    // Record crossing positioned at the nearest line ENDPOINT for scoring.
                    const beyondM = Math.abs(u) - this.lineHalfLenM;
                    const dirOk = dv * this.lineNormalSign > 0;
                    const uEnd = u < 0 ? -this.lineHalfLenM : this.lineHalfLenM;
                    const endPt = G.Direct(this.leg.nlat, this.leg.nlng, this.lineBearing, uEnd, Geodesic.LATITUDE | Geodesic.LONGITUDE);
                    const ts = Math.round(prev.t + t * (pos.t - prev.t)) as BasePositionMessage['t'];
                    const a = prev.a + t * (pos.a - prev.a);

                    const uClamped = Math.max(-this.lineHalfLenM, Math.min(this.lineHalfLenM, u1));
                    const on = G.Direct(this.leg.nlat, this.leg.nlng, this.lineBearing, uClamped, Geodesic.LATITUDE | Geodesic.LONGITUDE);
                    return {
                        finalInside: false,
                        everInside: false,
                        crossings: [],
                        distanceKm: (Math.abs(v1) / 1000) as DistanceKM,
                        onBoundary: {lat: on.lat2!, lng: on.lon2!, t: pos.t, a: pos.a},
                        nearMissBeyondM: beyondM,
                        nearMissCrossing: {entered: dirOk, left: !dirOk, at: {lat: endPt.lat2!, lng: endPt.lon2!, t: ts, a}}
                    };
                }
            }
        }

        // If we didn't cross then we need to find the closest point
        // on the line
        // Orthogonal foot to the infinite line in the local frame, then clamp to finite segment [−L..+L]
        const uClamped = Math.max(-this.lineHalfLenM, Math.min(this.lineHalfLenM, u1));
        const on = G.Direct(this.leg.nlat, this.leg.nlng, this.lineBearing, uClamped, Geodesic.LATITUDE | Geodesic.LONGITUDE);

        return {
            finalInside: false,
            everInside: false,
            crossings: [],
            distanceKm: (Math.abs(v1) / 1000) as DistanceKM,
            onBoundary: {lat: on.lat2!, lng: on.lon2!, t: pos.t, a: pos.a}
        };
    }

    // ---------------- Crossing: sector ----------------

    /** Collect analytic intersections with arcs (circles) and radial edges, then classify. */
    private _hasCrossedSector(prev: BasePositionMessage, pos: BasePositionMessage): HasCrossedResult {
        const invPos = (this._cacheInPoint(pos).inv ??= G.Inverse(this.leg.nlat, this.leg.nlng, pos.lat, pos.lng, Geodesic.DISTANCE | Geodesic.AZIMUTH));
        const invPrev = (this._cacheInPoint(prev).inv ??= G.Inverse(this.leg.nlat, this.leg.nlng, prev.lat, prev.lng, Geodesic.DISTANCE | Geodesic.AZIMUTH));

        const finalInside = this._insideSectorInv(invPos);
        let wasIn = this._insideSectorInv(invPrev);

        // Use departureMid as tangent basis (any fixed rotation works)
        //        const gamma = this.departureMid;
        let acc: Acc = {intersections: [], nearest: []};

        // Intersections with the two arcs (outer radii)
        if (this.hasDep) acc = this._circleIntersectionsReduce(acc, this.departureMid, invPrev, invPos, this.r1m, this.leg.a1);
        if (this.hasApp) acc = this._circleIntersectionsReduce(acc, this.departureMid, invPrev, invPos, this.r2m, this.leg.a2);

        // Intersections with radial edges - they only exist if it's not a circle
        if (this.hasDepWedge) {
            acc = this._radialIntersectionsReduce(acc, this.depLeft, invPrev, invPos, this.r1m);
            acc = this._radialIntersectionsReduce(acc, this.depRight, invPrev, invPos, this.r1m);
        }
        if (this.hasAppWedge) {
            acc = this._radialIntersectionsReduce(acc, this.appLeft, invPrev, invPos, this.r2m);
            acc = this._radialIntersectionsReduce(acc, this.appRight, invPrev, invPos, this.r2m);
        }

        const candidatesT = acc.intersections.sort((a, b) => a - b);
        const ts: number[] = [];
        for (const t of candidatesT) {
            if (t >= 0 && t <= 1) {
                if (ts.length === 0 || Math.abs(t - ts[ts.length - 1]) > 1e-6) {
                    ts.push(t);
                }
            }
        }

        const crossings: Crossing[] = [];
        // If we have candidates then figure them out
        if (ts.length) {
            const line = G.InverseLine(prev.lat, prev.lng, pos.lat, pos.lng);
            const pointPointDistance = line.s13!;

            const eps = 1e-2;
            for (const t of ts) {
                const P1 = line.Position(Math.min(1, t + eps) * pointPointDistance, Geodesic.LATITUDE | Geodesic.LONGITUDE);
                const nowIn = this._insideSector(P1.lat2, P1.lon2);

                if (wasIn !== nowIn) {
                    const ts = Math.round(prev.t + t * (pos.t - prev.t)) as BasePositionMessage['t'];
                    const a = prev.a + t * (pos.a - prev.a);
                    const P = line.Position(t * pointPointDistance, Geodesic.LATITUDE | Geodesic.LONGITUDE);

                    crossings.push({
                        entered: !wasIn && nowIn,
                        left: wasIn && !nowIn,
                        at: {lat: P.lat2!, lng: P.lon2!, t: ts, a}
                    });
                    wasIn = nowIn;
                }
            }
        }

        // prev is never inside by assumption
        const everInside = finalInside || crossings.length > 0;

        // If there were no crossings, provide proximity for POS
        if (!finalInside) {
            // Choose nearest candidate geodesically
            let best = acc.nearest[0];
            let bestSquared = Number.POSITIVE_INFINITY;

            for (const c of acc.nearest) {
                if (c.d2 < bestSquared) {
                    bestSquared = c.d2;
                    best = c;
                }
            }

            const {lat2, lon2} = G.Direct(this.leg.nlat, this.leg.nlng, best.az, best.s, Geodesic.LATITUDE | Geodesic.LONGITUDE);
            return {
                crossings,
                finalInside: false,
                everInside,
                distanceKm: (Math.sqrt(bestSquared) / 1000) as DistanceKM,
                onBoundary: {lat: lat2!, lng: lon2!, t: -pos.t as Epoch, a: 0}
            };
        }

        // Save the turnpoint
        this._cacheInPoint(pos).tp = this.leg.legno;
        //        console.log('%%', this.leg.legno, ':', [prev.lat, prev.lng, prev.t], '->', [pos.lat, pos.lng, pos.t], everInside, finalInside, crossings.length);

        return {
            crossings,
            finalInside,
            everInside
        };
    }

    /** Membership in DEPARTURE (r1/a1) or APPROACH (r2/a2) lobes (union). */
    private _insideSector(lat: number, lng: number): boolean {
        const inv = G.Inverse(this.leg.nlat, this.leg.nlng, lat, lng, Geodesic.DISTANCE | Geodesic.AZIMUTH);
        const d = inv.s12!;

        if (this.hasDep) {
            const az = norm180(inv.azi1! - this.departureMid);
            if (Math.abs(az) <= (this.leg.a1 ?? 0) && d <= this.r1m + 1e-6) return true;
        }
        if (this.hasApp) {
            const az = norm180(inv.azi1! - this.approachMid);
            if (Math.abs(az) <= (this.leg.a2 ?? 0) && d <= this.r2m + 1e-6) return true;
        }
        return false;
    }

    private _insideSectorDistance(lat: number, lng: number): DistanceKM {
        const inv = G.Inverse(this.leg.nlat, this.leg.nlng, lat, lng, Geodesic.DISTANCE | Geodesic.AZIMUTH);
        const d = inv.s12!;

        if (this.hasDep) {
            const az = norm180(inv.azi1! - this.departureMid);
            if (Math.abs(az) <= (this.leg.a1 ?? 0) && d <= this.r1m + 1e-6) return 0 as DistanceKM;
        }
        if (this.hasApp) {
            const az = norm180(inv.azi1! - this.approachMid);
            if (Math.abs(az) <= (this.leg.a2 ?? 0) && d <= this.r2m + 1e-6) return 0 as DistanceKM;
        }
        return d as DistanceKM;
    }

    private _insideSectorInv(inv: ReturnType<typeof G.Inverse>): boolean {
        const d = inv.s12!;

        if (this.hasDep) {
            const az = norm180(inv.azi1! - this.departureMid);
            if (Math.abs(az) <= (this.leg.a1 ?? 0) && d <= this.r1m + 1e-6) return true;
        }
        if (this.hasApp) {
            const az = norm180(inv.azi1! - this.approachMid);
            if (Math.abs(az) <= (this.leg.a2 ?? 0) && d <= this.r2m + 1e-6) return true;
        }
        return false;
    }

    /** Local tangent coordinates of (lat,lng) relative to center with x-axis at `bearing`. */
    private _uv(bearing: number, lat: number, lng: number) {
        const inv = G.Inverse(this.leg.nlat, this.leg.nlng, lat, lng, Geodesic.DISTANCE | Geodesic.AZIMUTH);
        const d = inv.s12!;
        const azRel = deg2rad(norm180(inv.azi1! - bearing));
        const u = d * Math.cos(azRel);
        const v = d * Math.sin(azRel);
        return {u, v};
    }
    private _uvInv(bearing: number, inv: ReturnType<typeof G.Inverse>) {
        const d = inv.s12!;
        const azRel = deg2rad(norm180(inv.azi1! - bearing));
        const u = d * Math.cos(azRel);
        const v = d * Math.sin(azRel);
        return {u, v};
    }

    /** Interpolate along the geodesic from p0 to p1 by fraction t (0..1). */
    private _interpOnGeodesic(p0: BasePositionMessage, p1: BasePositionMessage, t: number): BasePositionMessage {
        const inv01 = G.Inverse(p0.lat, p0.lng, p1.lat, p1.lng, Geodesic.DISTANCE | Geodesic.AZIMUTH);
        const s = inv01.s12! * Math.max(0, Math.min(1, t));
        const d = G.Direct(p0.lat, p0.lng, inv01.azi1!, s, Geodesic.LATITUDE | Geodesic.LONGITUDE);
        const ts = Math.round(p0.t + t * (p1.t - p0.t)) as BasePositionMessage['t'];
        const a = p0.a + t * (p1.a - p0.a);
        return {lat: d.lat2!, lng: d.lon2!, t: ts, a};
    }

    private _interpOnGeodesicInv(invP0P1: ReturnType<typeof G.Inverse>, p0: BasePositionMessage, p1: BasePositionMessage, t: number): BasePositionMessage {
        const s = invP0P1.s12! * Math.max(0, Math.min(1, t));
        const d = G.Direct(p0.lat, p0.lng, invP0P1.azi1!, s, Geodesic.LATITUDE | Geodesic.LONGITUDE);
        const ts = Math.round(p0.t + t * (p1.t - p0.t)) as BasePositionMessage['t'];
        const a = p0.a + t * (p1.a - p0.a);
        return {lat: d.lat2!, lng: d.lon2!, t: ts, a};
    }

    /** Solve u(t)^2+v(t)^2=r^2 for t in [0,1], using basis bearing `gamma`. */
    private _circleIntersectionsReduce(acc: Acc, departureMid: number, invPrev: ReturnType<typeof G.Inverse>, invPos: ReturnType<typeof G.Inverse>, r: number, a: number): Acc {
        const {u: u0, v: v0} = this._uvInv(departureMid, invPrev);
        const {u: u1, v: v1} = this._uvInv(departureMid, invPos);

        const du = u1 - u0,
            dv = v1 - v0;
        const A = du * du + dv * dv;
        if (A >= 1e-12) {
            const B = 2 * (u0 * du + v0 * dv);
            const C = u0 * u0 + v0 * v0 - r * r;
            const D = B * B - 4 * A * C;
            if (D >= 0) {
                const sD = Math.sqrt(D);
                const inv2A = 1 / (2 * A);
                const t1 = (-B - sD) * inv2A;
                const t2 = (-B + sD) * inv2A;
                if (t1 >= 0 && t1 <= 1) acc.intersections.push(t1);
                if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > 1e-8) acc.intersections.push(t2);
            }
        }

        // Closest point to p1 on the circle (deferred geodesic: s=r, az = gamma + angle(u1,v1))
        function uvFromAzimuthRel(relDeg: number, s: number) {
            const d = deg2rad(relDeg);
            return {u: s * Math.cos(d), v: s * Math.sin(d)};
        }

        // Clamp it correctly
        const rel = norm180(invPos.azi1! - departureMid);
        const relClamped = Math.max(-a, Math.min(a, rel));
        const uvI = uvFromAzimuthRel(relClamped, r);

        // Figure out the distance
        const duI = uvI.u - u1;
        const dvI = uvI.v - v1;
        acc.nearest.push({
            az: norm360(relClamped + departureMid),
            s: r,
            d2: duI * duI + dvI * dvI
        } as AccNearest);

        return acc;
    }

    /** Intersections with a radial edge (bearing `edgeBr` from center, clamped to [0,rMax]). */
    private _radialIntersectionsReduce(acc: Acc, edgeBr: number, invp0: ReturnType<typeof G.Inverse>, invp1: ReturnType<typeof G.Inverse>, rMax: number): Acc {
        const {u: u0, v: v0} = this._uvInv(edgeBr, invp0); // edge is +u, v=0
        const {u: u1, v: v1} = this._uvInv(edgeBr, invp1);

        const dv = v1 - v0;
        if (Math.abs(dv) >= 1e-12) {
            const t = -v0 / dv; // solve v(t)=0
            if (t >= 0 && t <= 1) {
                const u = u0 + t * (u1 - u0);
                if (u >= -1e-6 && u <= rMax + 1e-6) acc.intersections.push(t);
            }
        }

        // Closest point on the clamped radial [0, rMax] to p1 (in uv), deferred geodesic
        const uNearest = Math.max(0, Math.min(rMax, u1));
        const d2 = (u1 - uNearest) * (u1 - uNearest) + v1 * v1; // The difference
        acc.nearest.push({/*u: uNearest, v: 0,*/ az: edgeBr, s: uNearest, d2});
        return acc;
    }

    /** we cache the G.Inverse to a turnpoint in the BPM to speed up iteration */
    private _cacheInPoint(p: BasePositionMessage) {
        const px: any = p;
        if (px.c != this.leg.legno) {
            px.inv = undefined;
        }
        px.c = this.leg.legno;
        return px;
    }
    private _isCached(p: BasePositionMessage) {
        const px: any = p;
        return px.c == this.leg.legno;
    }
}
