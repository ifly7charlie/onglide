import {polygon, point, featureCollection} from '@turf/helpers';
import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type {Feature, Polygon, FeatureCollection} from 'geojson';

import {distHaversine} from '../flightprocessing/taskhelper';
import {OPTIMAL_GRID_SIZE, GRID} from '../constants';

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
export function assembleOptimalDirection(optimalGrid: number[], pos: {lat: number; lng: number}, baseline: number, sectorPolygon: Feature<Polygon>, hullPolygon: Feature<Polygon> | null, optimalNextSectorPoint?: {lat: number; lng: number}): FeatureCollection | null {
    if (!optimalGrid.length || baseline == null) return null;

    const [minLng, minLat, maxLng, maxLat] = bbox(sectorPolygon);
    const dLng = (maxLng - minLng) / OPTIMAL_GRID_SIZE;
    const dLat = (maxLat - minLat) / OPTIMAL_GRID_SIZE;

    if (dLng <= 0 || dLat <= 0) return null;

    const cells: {index: number; lng: number; lat: number; ratio: number; taskDist: number; transitDist: number; improvement: number; prevLng: number; prevLat: number; nextLng: number; nextLat: number}[] = [];
    let minRatio = Infinity;

    let index = 0;
    let totalCells = 0;
    let hullSkipped = 0;
    for (let k = 0; k + GRID.STRIDE - 1 < optimalGrid.length; k += GRID.STRIDE) {
        totalCells++;
        const cLng = optimalGrid[k + GRID.LNG];
        const cLat = optimalGrid[k + GRID.LAT];
        const taskDist = optimalGrid[k + GRID.TASK_DIST];

        // Skip cells inside the convex hull — already enclosed, no new information
        if (hullPolygon && booleanPointInPolygon([cLng, cLat], hullPolygon)) {
            hullSkipped++;
            continue;
        }

        const transitDist = distHaversine(pos, {lat: cLat, lng: cLng});
        const improvement = taskDist - baseline;
        // Ratio = km of task distance gained per km of transit flown.
        // ratio=1 is break-even (1km transit buys 1km task distance),
        // ratio>1 is net positive (green), ratio<1 is net negative (red).
        const ratio = transitDist > 0.01 ? improvement / transitDist : improvement > 0 ? 2 : 0;

        cells.push({
            index,
            lng: cLng,
            lat: cLat,
            ratio,
            taskDist,
            transitDist,
            improvement,
            prevLng: optimalGrid[k + GRID.PREV_LNG],
            prevLat: optimalGrid[k + GRID.PREV_LAT],
            nextLng: optimalGrid[k + GRID.NEXT_LNG],
            nextLat: optimalGrid[k + GRID.NEXT_LAT]
        });
        if (ratio < minRatio) minRatio = ratio;
        index++;
    }

    if (!cells.length) return null;

    // Map ratio to a normalized [-1, +1] scale for the color ramp:
    //   ratio 0 or below → -1 (red:  transit cost exceeds any gain)
    //   ratio 1           →  0 (yellow: break-even)
    //   ratio 2 or above → +1 (green: each km of transit gains ≥2km task distance)
    const features: (Feature<Polygon> | Feature)[] = [];

    for (const cell of cells) {
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
