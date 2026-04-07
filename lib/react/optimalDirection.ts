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
export function assembleOptimalDirection(optimalGrid: number[], pos: LatLng, baseline: number, sectorPolygon: Feature<Polygon>, hullPolygon: Feature<Polygon> | null, optimalNextSectorPoint?: LatLng): FeatureCollection | null {
    if (!optimalGrid.length || baseline == null) return null;

    const [minLng, minLat, maxLng, maxLat] = bbox(sectorPolygon);
    const dLng = (maxLng - minLng) / GRID_SIZE;
    const dLat = (maxLat - minLat) / GRID_SIZE;

    if (dLng <= 0 || dLat <= 0) return null;

    // Per-cell stride: lng, lat, taskDist, prevLng, prevLat, nextLng, nextLat = 7
    const stride = 7;

    const cells: {index: number; lng: number; lat: number; ratio: number; taskDist: number; transitDist: number; improvement: number; prevLng: number; prevLat: number; nextLng: number; nextLat: number}[] = [];
    let minRatio = Infinity;

    let index = 0;
    let totalCells = 0;
    let hullSkipped = 0;
    for (let k = 0; k + stride - 1 < optimalGrid.length; k += stride) {
        totalCells++;
        const cLng = optimalGrid[k];
        const cLat = optimalGrid[k + 1];
        const taskDist = optimalGrid[k + 2];

        // Skip cells inside the convex hull — already enclosed, no new information
        if (hullPolygon && booleanPointInPolygon([cLng, cLat], hullPolygon)) {
            hullSkipped++;
            continue;
        }

        const transitDist = distKm(pos, {lat: cLat, lng: cLng});
        const improvement = taskDist - baseline;
        // Ratio of extra task distance to transit distance (2:1 = best green)
        const ratio = transitDist > 0.01 ? improvement / transitDist : improvement > 0 ? 2 : 0;

        cells.push({
            index,
            lng: cLng,
            lat: cLat,
            ratio,
            taskDist,
            transitDist,
            improvement,
            prevLng: optimalGrid[k + 3],
            prevLat: optimalGrid[k + 4],
            nextLng: optimalGrid[k + 5],
            nextLat: optimalGrid[k + 6]
        });
        if (ratio < minRatio) minRatio = ratio;
        index++;
    }

    if (!cells.length) return null;

    // Scale: ratio 2 → +1 (green), ratio 1 → 0 (yellow/neutral), ratio 0 → -1 (red)
    // Ratio 1 means break-even: each km of transit gains 1km of task distance
    const features: (Feature<Polygon> | Feature)[] = [];

    for (const cell of cells) {
        // Map ratio to [-1, +1]: 1 is neutral, 2 is full green, 0 or below is full red
        const normalized = Math.max(-1, Math.min(1, cell.ratio - 1));

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
                {
                    index: cell.index,
                    delta: Math.round(normalized * 100) / 100,
                    ratio: Math.round(cell.ratio * 100) / 100,
                    taskDist: Math.round(cell.taskDist * 10) / 10,
                    transitDist: Math.round(cell.transitDist * 10) / 10,
                    improvement: Math.round(cell.improvement * 10) / 10,
                    prevLng: cell.prevLng,
                    prevLat: cell.prevLat,
                    nextLng: cell.nextLng,
                    nextLat: cell.nextLat
                }
            )
        );
    }

    // Add optimal next sector point as a marker feature
    if (optimalNextSectorPoint) {
        features.push(point([optimalNextSectorPoint.lng, optimalNextSectorPoint.lat], {optimalNextPoint: true}));
    }

    return features.length > 0 ? featureCollection(features) : null;
}
