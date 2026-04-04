import {polygon, point, featureCollection} from '@turf/helpers';
import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type {Feature, Polygon, FeatureCollection} from 'geojson';

interface LatLng {
    lat: number;
    lng: number;
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

/** Haversine distance in km — inline to avoid turf overhead */
function distKm(a: LatLng, b: LatLng): number {
    const R = 6371;
    const dLat = deg2rad(b.lat - a.lat);
    const dLng = deg2rad(b.lng - a.lng);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat + Math.cos(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * sinLng * sinLng;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const GRID_SIZE = 25;

/**
 * Generate a filled heatmap over the current sector showing the net efficiency
 * of each grid cell:
 *
 *   delta(P) = (gridTaskDist(P) - minPossible) - d(pos, P)
 *
 * - gridTaskDist(P) = total task distance (start→finish) if P were the scored
 *   point in this sector, precomputed in the worker via prefix/suffix DP
 * - minPossible      = minimum possible task distance (current scored line baseline)
 * - d(pos, P)        = transit distance from pilot's current position to cell P
 *
 * Positive (green) = flying to P improves task distance beyond transit cost
 * Negative (red)   = transit cost exceeds any improvement over current scored line
 *
 * @param optimalGrid       - Flat [lng, lat, taskDist, ...] from worker
 * @param pos               - Pilot's current GPS position
 * @param minPossible       - Minimum possible task distance (baseline)
 * @param sectorPolygon     - Sector geometry (for computing grid cell size)
 * @param hullPolygon       - Convex hull — cells inside are skipped
 * @param optimalNextSectorPoint - Optimal point in next sector (rendered as marker)
 */
export function assembleOptimalDirection(
    optimalGrid: number[],
    pos: LatLng,
    minPossible: number,
    sectorPolygon: Feature<Polygon>,
    hullPolygon: Feature<Polygon> | null,
    optimalNextSectorPoint?: LatLng
): FeatureCollection | null {
    if (!optimalGrid.length) return null;

    const [minLng, minLat, maxLng, maxLat] = bbox(sectorPolygon);
    const dLng = (maxLng - minLng) / GRID_SIZE;
    const dLat = (maxLat - minLat) / GRID_SIZE;

    if (dLng <= 0 || dLat <= 0) return null;

    // First pass: compute raw deltas and find the range
    const cells: {lng: number; lat: number; delta: number}[] = [];
    let minDelta = Infinity;
    let maxDelta = -Infinity;

    for (let k = 0; k + 2 < optimalGrid.length; k += 3) {
        const cLng = optimalGrid[k];
        const cLat = optimalGrid[k + 1];
        const taskDist = optimalGrid[k + 2];

        // Skip cells inside the convex hull — already enclosed, no new information
        if (hullPolygon && booleanPointInPolygon([cLng, cLat], hullPolygon)) {
            continue;
        }

        const delta = (taskDist - minPossible) - distKm(pos, {lat: cLat, lng: cLng});

        cells.push({lng: cLng, lat: cLat, delta});
        if (delta < minDelta) minDelta = delta;
        if (delta > maxDelta) maxDelta = delta;
    }

    if (!cells.length) return null;

    // Normalize to [-1, +1] range using the actual min/max
    // Map: minDelta → -1, maxDelta → +1
    const range = maxDelta - minDelta;
    const features: (Feature<Polygon> | Feature)[] = [];

    for (const cell of cells) {
        const normalized = range > 0 ? ((cell.delta - minDelta) / range) * 2 - 1 : 0;

        const l = cell.lng - dLng / 2;
        const r = cell.lng + dLng / 2;
        const b = cell.lat - dLat / 2;
        const t = cell.lat + dLat / 2;

        features.push(
            polygon(
                [
                    [
                        [l, b],
                        [r, b],
                        [r, t],
                        [l, t],
                        [l, b]
                    ]
                ],
                {delta: Math.round(normalized * 100) / 100}
            )
        );
    }

    // Add optimal next sector point as a marker feature
    if (optimalNextSectorPoint) {
        features.push(point([optimalNextSectorPoint.lng, optimalNextSectorPoint.lat], {optimalNextPoint: true}));
    }

    return features.length > 0 ? featureCollection(features) : null;
}
