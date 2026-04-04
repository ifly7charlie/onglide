import {polygon, point, featureCollection} from '@turf/helpers';
import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type {Feature, Polygon, FeatureCollection} from 'geojson';

interface LatLng {
    lat: number;
    lng: number;
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

/** Haversine distance in km — inline to avoid turf overhead for ~1250 calls */
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
 * Generate a filled heatmap over the current sector showing the net value
 * of each point: d(A,P) - d(P,C).
 *
 * - d(A,P) = scored distance on this leg (what you gain)
 * - d(P,C) = distance to reach the next sector (the transit cost)
 *
 * The delta is relative to the current scored point S, so:
 * - delta > 0 (green) = improvement over current score
 * - delta = 0 (yellow) = same as current score
 * - delta < 0 (red) = worse than current score
 *
 * Points inside the existing convex hull are already enclosed and
 * cannot improve the score, so they are clamped to delta = 0.
 *
 * @param A - Scored point in the previous sector
 * @param C - Optimal point in the next sector
 * @param S - Current scored point in this sector
 * @param sectorPolygon - Sector geometry for clipping
 * @param hullPolygon - Convex hull of points flown in this sector (null if not yet available)
 */
export function assembleOptimalDirection(
    A: LatLng,
    C: LatLng,
    S: LatLng,
    sectorPolygon: Feature<Polygon>,
    hullPolygon: Feature<Polygon> | null
): FeatureCollection | null {
    const [minLng, minLat, maxLng, maxLat] = bbox(sectorPolygon);
    const dLng = (maxLng - minLng) / GRID_SIZE;
    const dLat = (maxLat - minLat) / GRID_SIZE;

    if (dLng <= 0 || dLat <= 0) return null;

    const scoredValue = distKm(A, S) - distKm(S, C);
    const features: (Feature<Polygon> | Feature)[] = [];

    for (let i = 0; i < GRID_SIZE; i++) {
        for (let j = 0; j < GRID_SIZE; j++) {
            const cLng = minLng + (i + 0.5) * dLng;
            const cLat = minLat + (j + 0.5) * dLat;

            if (!booleanPointInPolygon([cLng, cLat], sectorPolygon)) {
                continue;
            }

            let delta: number;
            if (hullPolygon && booleanPointInPolygon([cLng, cLat], hullPolygon)) {
                // Inside the convex hull — already enclosed, no improvement possible
                delta = 0;
            } else {
                const P: LatLng = {lat: cLat, lng: cLng};
                const value = distKm(A, P) - distKm(P, C);
                delta = Math.round((value - scoredValue) * 10) / 10;
            }

            const l = cLng - dLng / 2;
            const r = cLng + dLng / 2;
            const b = cLat - dLat / 2;
            const t = cLat + dLat / 2;

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
                    {delta}
                )
            );
        }
    }

    // Add C as a point feature for rendering as a marker
    features.push(point([C.lng, C.lat], {optimalNextPoint: true}));

    return features.length > 0 ? featureCollection(features) : null;
}
