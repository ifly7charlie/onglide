//
// Pure geometry for the "compare pilots" visualisation — no deck.gl or redux
// imports, so it stays unit-testable (see test/comparePilots.test.ts). The layer
// module (comparePilotsLayer.ts) consumes these to build the deck.gl layers.
//
// Each glider is drawn as an arc of equal *scored* progress centred on its current
// turnpoint, swept from the bearing to the glider in to an anchor on the task; the
// two anchors are then joined by a measurement line whose length is the scored gap.
//   - Racing/speed: pivot FORWARD on the next turnpoint, radius = scored distance
//     still to round it, anchor = scored position on the leg centreline.
//   - AAT: pivot BACKWARD on the previous area's turnpoint, with the pilot's
//     current scored point ON the arc (radius = its distance to that turnpoint) —
//     the dual of racing (next turnpoint, glider on the arc).
//

import {Geodesic} from 'geographiclib-geodesic';

const G = Geodesic.WGS84;

export type LngLat = [number, number];
export type LngLatAlt = [number, number, number];

// Points per arc — enough to read as a curve at any zoom without flooding the path.
export const ARC_STEPS = 16;

// Turnpoint centres + per-leg lengths route/measure the connector, and the AAT
// flag picks the arc anchoring. Kept structural so a redux WritableDraft<Task> is
// accepted as-is.
export interface CompareTask {
    rules?: {aat?: boolean};
    legs?: {nlng: number; nlat: number; length?: number}[];
}

// Minimal structural view of a score, so the geometry stays free of the heavy
// protobuf type and is unit-testable.
export interface CompareScore {
    currentLeg?: number;
    actual?: {distanceRemaining?: number; minPossible?: number; taskSpeed?: number};
    scoringClosestPoint?: {lat: number; lng: number};
    scoredPoints?: number[];
    suggestedTrackPoints?: number[];
    utcStart?: number;
}

// distanceRemaining (racing) or minPossible (AAT) — same precedence the
// leaderboard's "remaining" column uses (selectPilotResult).
export const remaining = (a: {distanceRemaining?: number; minPossible?: number} | undefined): number => (a ? a.distanceRemaining || a.minPossible || 0 : 0);

// --- Geodesic primitives (WGS84, via geographiclib like preparedTurnpoint) -----

// Bearing (deg) from a to b.
export function bearing(a: LngLat, b: LngLat): number {
    return G.Inverse(a[1], a[0], b[1], b[0], Geodesic.AZIMUTH).azi1 ?? 0;
}
// Geodesic distance (km) from a to b.
export function distKm(a: LngLat, b: LngLat): number {
    return (G.Inverse(a[1], a[0], b[1], b[0], Geodesic.DISTANCE).s12 ?? 0) / 1000;
}
// Point reached by travelling `km` from origin along `azimuthDeg`.
export function destination(origin: LngLat, azimuthDeg: number, km: number): LngLat {
    const r = G.Direct(origin[1], origin[0], azimuthDeg, km * 1000, Geodesic.LATITUDE | Geodesic.LONGITUDE);
    return [r.lon2 ?? origin[0], r.lat2 ?? origin[1]];
}
// Shortest signed angular delta from->to in (-180, 180].
function angDelta(from: number, to: number): number {
    return ((to - from + 540) % 360) - 180;
}

// --- Arc geometry --------------------------------------------------------------

export interface ArcSpec {
    center: LngLat;
    radius: number; // km
    fromBearing: number; // deg, toward the glider
    toBearing: number; // deg, toward the anchor
    anchor: LngLat; // where the measurement line attaches (the toBearing end of the arc)
    alt: number; // glider amsl
}

// The arc polyline, 2D and 3D (at the glider's altitude). Sweeps the short way
// from the glider bearing to the anchor bearing. radius<=0 collapses to the anchor.
export function buildArc(spec: ArcSpec): {arc2d: LngLat[]; arc3d: LngLatAlt[]} {
    const arc2d: LngLat[] = [];
    if (spec.radius <= 0) {
        arc2d.push(spec.anchor);
    } else {
        const delta = angDelta(spec.fromBearing, spec.toBearing);
        for (let i = 0; i <= ARC_STEPS; i++) {
            arc2d.push(destination(spec.center, spec.fromBearing + (delta * i) / ARC_STEPS, spec.radius));
        }
    }
    return {arc2d, arc3d: arc2d.map((p): LngLatAlt => [p[0], p[1], spec.alt])};
}

// The measurement line between the two anchors, routed through `vias`. The whole
// horizontal run sits at the lower anchor's altitude with a single riser up to the
// higher one — decomposing the gap into along-task distance + height (reads cleanly
// pitched into 3D). 2D drops the altitude axis.
export function buildMeasure(behind: LngLatAlt, ahead: LngLatAlt, vias: LngLat[]): {measure2d: LngLat[]; measure3d: LngLatAlt[]} {
    const lowAlt = Math.min(behind[2], ahead[2]);
    const flat: LngLatAlt[] = [[behind[0], behind[1], lowAlt], ...vias.map((v): LngLatAlt => [v[0], v[1], lowAlt]), [ahead[0], ahead[1], lowAlt]];
    const measure3d: LngLatAlt[] = [];
    if (behind[2] > lowAlt) measure3d.push([behind[0], behind[1], behind[2]]);
    measure3d.push(...flat);
    if (ahead[2] > lowAlt) measure3d.push([ahead[0], ahead[1], ahead[2]]);
    const measure2d: LngLat[] = [[behind[0], behind[1]], ...vias, [ahead[0], ahead[1]]];
    return {measure2d, measure3d};
}

// Midpoint by length along a polyline — keeps the label on the (possibly routed)
// measurement line rather than on the straight chord between its ends.
export function pathMidpoint(path: LngLatAlt[]): LngLatAlt {
    if (path.length <= 1) return path[0];
    const segLen: number[] = [];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
        const l = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
        segLen.push(l);
        total += l;
    }
    let half = total / 2;
    for (let i = 0; i < segLen.length; i++) {
        if (half <= segLen[i] || i === segLen.length - 1) {
            const t = segLen[i] > 0 ? half / segLen[i] : 0;
            const a = path[i];
            const b = path[i + 1];
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        }
        half -= segLen[i];
    }
    return path[Math.floor(path.length / 2)];
}

// Build the per-glider arc spec, or null when the geometry needed isn't available
// (caller then falls back to a direct connector). Racing pivots forward on the
// next turnpoint; AAT pivots backward on the previous area's turnpoint.
export function buildArcSpec(aat: boolean, legs: CompareTask['legs'] | undefined, score: CompareScore | undefined, glider: LngLatAlt): ArcSpec | null {
    if (!score || !legs || legs.length < 2) return null;
    const gliderLL: LngLat = [glider[0], glider[1]];
    const alt = glider[2];
    const leg = score.currentLeg ?? 0;

    if (aat) {
        // Pivot on the previous area's turnpoint, with the pilot's current scored
        // point (last vertex of scoredPoints, ≈ where the pilot is) ON the arc, so
        // the arc curves around the area already rounded. The arc sweeps from the
        // glider's bearing in to that scored point, which the measurement attaches to.
        const sp = score.scoredPoints;
        if (leg < 1 || leg >= legs.length || !sp || sp.length < 4) return null;
        const scored: LngLat = [sp[sp.length - 4], sp[sp.length - 3]];
        const center: LngLat = [legs[leg - 1].nlng, legs[leg - 1].nlat];
        const radius = distKm(center, scored);
        return {center, radius, fromBearing: bearing(center, gliderLL), toBearing: bearing(center, scored), anchor: scored, alt};
    }

    // Racing: centre = next turnpoint; radius = the glider's distance to it, so the
    // arc passes through the glider. (Scored distanceRemaining adds the downstream
    // legs and turnpoint-radius corrections; those are common to two same-leg
    // gliders so they cancel in the gap, but they shift each arc a couple of km off
    // its glider — the geodesic distance to the centre keeps the arc on the glider
    // while the radial gap between two arcs is still the along-leg difference.)
    if (leg < 1 || leg >= legs.length) return null;
    const center: LngLat = [legs[leg].nlng, legs[leg].nlat];
    const radius = distKm(center, gliderLL);
    const toBearing = bearing(center, [legs[leg - 1].nlng, legs[leg - 1].nlat]);
    return {center, radius, fromBearing: bearing(center, gliderLL), toBearing, anchor: destination(center, toBearing, radius), alt};
}

// Intermediate points for the measurement line, from the behind glider's anchor to
// the ahead glider's. Racing routes through the turnpoint centres still to round;
// AAT routes through the behind pilot's suggested aim points (stride-4
// [lng,lat,...] starting at its own position and ending at the finish — drop both
// ends and cap the count so it doesn't overshoot past the ahead glider).
export function buildVias(aat: boolean, legs: CompareTask['legs'] | undefined, behindScore: CompareScore | undefined, behindLeg: number, aheadLeg: number): LngLat[] {
    if (!legs || aheadLeg <= behindLeg) return [];
    if (aat) {
        const stp = behindScore?.suggestedTrackPoints;
        if (!stp || stp.length < 12) return []; // need ≥1 aim point between current pos and finish
        const aims: LngLat[] = [];
        // stride-4 groups; skip group 0 (the pilot's current position) and the
        // last group (the finish), leaving the remaining-sector aim points.
        for (let base = 4; base <= stp.length - 8; base += 4) aims.push([stp[base], stp[base + 1]]);
        return aims.slice(0, aheadLeg - behindLeg);
    }
    const vias: LngLat[] = [];
    for (let i = behindLeg; i < Math.min(aheadLeg, legs.length); i++) vias.push([legs[i].nlng, legs[i].nlat]);
    return vias;
}
