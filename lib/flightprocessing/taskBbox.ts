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
// Merge one comp's bbox into a per-compid accumulator. A competition runs
// several classes — each its own task — that share a single compid and one
// prefilter box in the APRS worker. Each class's bbox must be unioned in, not
// overwritten, or a class flying a larger task gets clipped to a smaller
// class's area. Mutates and returns the map.
//
export function accumulateCompBbox(map: Map<string, Bbox>, compid: string, bbox: Bbox): Map<string, Bbox> {
    const existing = map.get(compid);
    map.set(compid, existing ? unionBboxes([existing, bbox])! : bbox);
    return map;
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

// aprsc enforces a 500-byte limit on each protocol line. The login line
// is `user OG pass -1 vers onglide/<version> filter <filter>\r\n`, ~44
// bytes of fixed overhead at the current config. 450 leaves ~6 bytes of
// headroom for version bumps without re-tuning the cap.
export const APRS_MAX_FILTER_BYTES = 450;

export interface AirfieldFilterInput {
    lt: number;
    lg: number;
    radiusKm: number;
}

// Bbox containing a single airfield's coverage circle.
function circleBbox(lt: number, lg: number, radiusKm: number): Bbox {
    const {dLat, dLng} = kmToDegrees(radiusKm, lt);
    return [lt - dLat, lg - dLng, lt + dLat, lg + dLng];
}

function bboxArea(b: Bbox): number {
    return (b[2] - b[0]) * (b[3] - b[1]);
}

function assembleFilter(taskClause: string | null, otherClauses: string[]): string {
    const clauses = taskClause ? [taskClause, ...otherClauses] : [...otherClauses];
    clauses.sort();
    return clauses.join(' ');
}

//
// Build an aprsc filter string covering the supplied (already-expanded)
// task bbox and per-airfield coverage circles, never exceeding
// APRS_MAX_FILTER_BYTES. Phase 1 emits a `r/lat/lng/km` clause per
// airfield (current behaviour). If that overflows, Phase 2 agglomerates
// nearby airfields into `a/N/W/S/E` cluster boxes — broader than ideal,
// but coverage is never dropped.
//
export function buildAprsFilter(expandedTaskBbox: Bbox | null, airfields: AirfieldFilterInput[]): string {
    // Phase 1: natural construction, matches the pre-cap behaviour.
    const taskClause = expandedTaskBbox ? bboxToAprsArea(expandedTaskBbox) : null;
    // Dedupe airfields by clause-equivalent identity. Multiple comps sharing
    // a site (or rounding to the same coords) produce identical r/lat/lng/km
    // clauses, wasting bytes against the 450-cap and forcing premature
    // clustering.
    const seenAirfield = new Set<string>();
    const surviving: AirfieldFilterInput[] = [];
    for (const af of airfields) {
        if (expandedTaskBbox && bboxContainsCircle(expandedTaskBbox, af.lt, af.lg, af.radiusKm)) continue;
        const key = `${af.lt}|${af.lg}|${af.radiusKm}`;
        if (seenAirfield.has(key)) continue;
        seenAirfield.add(key);
        surviving.push(af);
    }

    if (!taskClause && surviving.length === 0) {
        return 'r/0/0/1';
    }

    const naturalRadiusClauses = surviving.map((a) => `r/${a.lt}/${a.lg}/${a.radiusKm}`);
    const naturalFilter = assembleFilter(taskClause, naturalRadiusClauses);
    if (naturalFilter.length <= APRS_MAX_FILTER_BYTES) {
        return naturalFilter;
    }

    // Phase 2: agglomerative clustering. Each surviving airfield starts as
    // its own circle-bbox; greedily merge the pair with the smallest union
    // area until the joined filter fits or we collapse to one cluster.
    let clusters: Bbox[] = surviving.map((a) => circleBbox(a.lt, a.lg, a.radiusKm));

    while (clusters.length > 1) {
        const candidate = assembleFilter(taskClause, clusters.map(bboxToAprsArea));
        if (candidate.length <= APRS_MAX_FILTER_BYTES) {
            return candidate;
        }

        let bestI = 0;
        let bestJ = 1;
        let bestArea = Infinity;
        for (let i = 0; i < clusters.length; i++) {
            for (let j = i + 1; j < clusters.length; j++) {
                const merged = unionBboxes([clusters[i], clusters[j]])!;
                const area = bboxArea(merged);
                if (area < bestArea) {
                    bestArea = area;
                    bestI = i;
                    bestJ = j;
                }
            }
        }
        const merged = unionBboxes([clusters[bestI], clusters[bestJ]])!;
        // Splice out j first (higher index) to keep i valid.
        const next = clusters.slice();
        next.splice(bestJ, 1);
        next.splice(bestI, 1);
        next.push(merged);
        clusters = next;
    }

    // Final fallback: union task bbox + remaining cluster into one bbox.
    const all: Bbox[] = [];
    if (expandedTaskBbox) all.push(expandedTaskBbox);
    all.push(...clusters);
    const union = unionBboxes(all)!;
    return bboxToAprsArea(union);
}

//
// Point-in-bbox membership test, using the [minLat, minLng, maxLat, maxLng]
// convention. Used by the worker prefilter to decide which competition(s)
// a packet position belongs to.
//
export function pointInBbox(b: Bbox, lat: number, lng: number): boolean {
    return lat >= b[0] && lat <= b[2] && lng >= b[1] && lng <= b[3];
}
