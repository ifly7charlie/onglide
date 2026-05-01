//
// Task bounding box utilities for building aprsc-style area filters.
//
// An aprsc area filter is `a/lat-top/lng-left/lat-bottom/lng-right`,
// i.e. `a/N/W/S/E`. Multiple clauses separated by spaces are OR-ed.
//
// This module is deliberately server-friendly: no runtime deps beyond
// what's already in the repo. @turf/bbox is a client-only dep today,
// so we do the min/max math here by hand.
//

import type {Task} from '../types';

// [minLat, minLng, maxLat, maxLng]
export type Bbox = [number, number, number, number];

const KM_PER_DEG_LAT = 111;

// Convert a km distance into a (dLat, dLng) pair at the given latitude.
// The cos() factor shrinks a degree of longitude as you move away from
// the equator; we clamp it to 0.2 so things don't blow up near the poles
// (not that anyone flies competitions there).
function kmToDegrees(km: number, lat: number): {dLat: number; dLng: number} {
    const dLat = km / KM_PER_DEG_LAT;
    const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const dLng = km / (KM_PER_DEG_LAT * cos);
    return {dLat, dLng};
}

//
// Compute a bounding box for a task that covers every leg's sector
// (so AAT sectors aren't clipped). Returns null for a task with no legs.
//
export function taskBbox(task: Task): Bbox | null {
    if (!task || !task.legs || task.legs.length === 0) {
        return null;
    }

    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;

    for (const leg of task.legs) {
        const lat = leg.nlat;
        const lng = leg.nlng;
        if (typeof lat !== 'number' || typeof lng !== 'number') {
            continue;
        }

        // Pick the biggest radius we know about for this leg so an AAT
        // sector doesn't get clipped. maxR is set by calculateTask for
        // sectors; fall back to r1; otherwise zero km (line-style legs).
        const radiusKm = typeof leg.maxR === 'number' && leg.maxR > 0 ? leg.maxR : typeof leg.r1 === 'number' && leg.r1 > 0 ? leg.r1 : 0;

        const {dLat, dLng} = kmToDegrees(radiusKm, lat);

        if (lat - dLat < minLat) minLat = lat - dLat;
        if (lat + dLat > maxLat) maxLat = lat + dLat;
        if (lng - dLng < minLng) minLng = lng - dLng;
        if (lng + dLng > maxLng) maxLng = lng + dLng;
    }

    if (!isFinite(minLat) || !isFinite(minLng) || !isFinite(maxLat) || !isFinite(maxLng)) {
        return null;
    }

    return [minLat, minLng, maxLat, maxLng];
}

//
// Union a list of bboxes into a single enclosing bbox. Null/empty in -> null out.
//
export function unionBboxes(boxes: Bbox[]): Bbox | null {
    if (!boxes || boxes.length === 0) {
        return null;
    }

    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;

    for (const b of boxes) {
        if (!b) continue;
        if (b[0] < minLat) minLat = b[0];
        if (b[1] < minLng) minLng = b[1];
        if (b[2] > maxLat) maxLat = b[2];
        if (b[3] > maxLng) maxLng = b[3];
    }

    if (!isFinite(minLat) || !isFinite(minLng) || !isFinite(maxLat) || !isFinite(maxLng)) {
        return null;
    }

    return [minLat, minLng, maxLat, maxLng];
}

//
// Expand a bbox by km in all directions. Uses the midpoint latitude
// for the cos() factor, which is good enough at competition scales.
//
export function expandBbox(b: Bbox, km: number): Bbox {
    const [minLat, minLng, maxLat, maxLng] = b;
    const midLat = (minLat + maxLat) / 2;
    const {dLat, dLng} = kmToDegrees(km, midLat);
    return [minLat - dLat, minLng - dLng, maxLat + dLat, maxLng + dLng];
}

//
// Format as an aprsc area filter clause: `a/N/W/S/E`.
// Two decimal places ≈ 1km precision, comfortably below the 10 km
// margin we expand by, and keeps the compound filter string short.
//
export function bboxToAprsArea(b: Bbox): string {
    const [minLat, minLng, maxLat, maxLng] = b;
    const N = maxLat.toFixed(2);
    const W = minLng.toFixed(2);
    const S = minLat.toFixed(2);
    const E = maxLng.toFixed(2);
    return `a/${N}/${W}/${S}/${E}`;
}

//
// Returns true if a circle of `km` radius centred at (lat, lng) lies
// entirely inside the bbox. Used to dedupe airfield radius clauses
// when the airfield is already covered by a task bbox.
//
export function bboxContainsCircle(b: Bbox, lat: number, lng: number, km: number): boolean {
    const [minLat, minLng, maxLat, maxLng] = b;
    const {dLat, dLng} = kmToDegrees(km, lat);
    return lat - dLat >= minLat && lat + dLat <= maxLat && lng - dLng >= minLng && lng + dLng <= maxLng;
}
