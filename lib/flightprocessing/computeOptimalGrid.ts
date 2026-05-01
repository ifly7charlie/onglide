import {OPTIMAL_GRID_SIZE} from '../constants';
import {sumPath} from './taskhelper';

import type {Epoch, BasePositionMessage} from '../types';
import type {DistanceOptimiser} from './distanceOptimiser';
import type {PreparedTurnpoint} from './preparedTurnpoint';

/**
 * Compute a grid of optimal task distances over the current sector.
 *
 * For each cell center inside the sector polygon, evaluates what the total
 * task distance (start→finish) would be if that cell were the scored point
 * in the current sector. The result is a flat array with stride 7:
 *   [lng, lat, taskDist, prevLng, prevLat, nextLng, nextLat, ...]
 *
 * Uses ray-casting point-in-polygon (no turf dependency in worker).
 */
export function computeOptimalGrid(
    sectorCoords: [number, number][],
    currentLeg: number,
    maxGraph: DistanceOptimiser<BasePositionMessage>,
    preparedLegs: PreparedTurnpoint[],
    log: Function
): number[] | null {
    if (!sectorCoords || sectorCoords.length < 3) return null;

    // Bbox of the sector
    let minLng = Infinity,
        maxLng = -Infinity,
        minLat = Infinity,
        maxLat = -Infinity;
    for (const [lng, lat] of sectorCoords) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }
    const dLng = (maxLng - minLng) / OPTIMAL_GRID_SIZE;
    const dLat = (maxLat - minLat) / OPTIMAL_GRID_SIZE;

    if (dLng <= 0 || dLat <= 0) return null;

    // Ray-casting point-in-polygon
    const inPoly = (x: number, y: number): boolean => {
        let inside = false;
        for (let i = 0, j = sectorCoords.length - 1; i < sectorCoords.length; j = i++) {
            const xi = sectorCoords[i][0],
                yi = sectorCoords[i][1];
            const xj = sectorCoords[j][0],
                yj = sectorCoords[j][1];
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    };

    // Build grid cells inside the sector
    const gridPoints: BasePositionMessage[] = [];
    const gridCoords: {lng: number; lat: number}[] = [];
    for (let i = 0; i < OPTIMAL_GRID_SIZE; i++) {
        for (let j = 0; j < OPTIMAL_GRID_SIZE; j++) {
            const cLng = minLng + (i + 0.5) * dLng;
            const cLat = minLat + (j + 0.5) * dLat;
            if (inPoly(cLng, cLat)) {
                gridPoints.push({t: 0 as Epoch, lat: cLat, lng: cLng, a: 0} as BasePositionMessage);
                gridCoords.push({lng: cLng, lat: cLat});
            }
        }
    }

    if (gridPoints.length === 0) return null;

    // Use maxGraph to match the baseline (both maximize task distance)
    // maxGraph has flown convex hull points for previous sectors
    const results = maxGraph.evaluatePointsInGroupWithPaths(currentLeg, gridPoints);
    // Grid format: per cell [lng, lat, taskDist, prevLng, prevLat, nextLng, nextLat] (stride = 7)
    const grid: number[] = [];
    let minTaskDist = Infinity,
        maxTaskDist = -Infinity;
    for (let k = 0; k < results.length; k++) {
        // Use sumPath for consistent distance calc with baseline (geodesic + leg adjustments)
        const taskDist = sumPath(results[k].path, 0, preparedLegs, true);
        const prev = results[k].path[currentLeg - 1];
        const next = results[k].path[currentLeg + 1];
        grid.push(gridCoords[k].lng, gridCoords[k].lat, taskDist, prev?.lng ?? 0, prev?.lat ?? 0, next?.lng ?? 0, next?.lat ?? 0);
        if (taskDist < minTaskDist) minTaskDist = taskDist;
        if (taskDist > maxTaskDist) maxTaskDist = taskDist;
    }
    log(`optimalGrid: ${gridPoints.length} cells for leg ${currentLeg}, taskDist range [${minTaskDist.toFixed(1)}, ${maxTaskDist.toFixed(1)}]km`);
    return grid;
}
