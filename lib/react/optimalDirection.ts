import {lineString, featureCollection} from '@turf/helpers';
import turfDistance from '@turf/distance';
import turfBearing from '@turf/bearing';
import type {Feature, LineString, FeatureCollection} from 'geojson';

interface LatLng {
    lat: number;
    lng: number;
}

const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;

/** Project a point along a bearing by a distance (km). Flat-earth approximation, adequate at AAT scales. */
function destination(from: LatLng, distanceKm: number, bearingDeg: number): [number, number] {
    const brRad = deg2rad(bearingDeg);
    const lat = from.lat + (distanceKm * Math.cos(brRad)) / 111.32;
    const lng = from.lng + (distanceKm * Math.sin(brRad)) / (111.32 * Math.cos(deg2rad(from.lat)));
    return [lng, lat];
}

/**
 * Generate an ellipse as a closed LineString with the given foci and distance sum.
 * Returns null if the ellipse is degenerate (sum <= focal distance).
 */
function generateEllipse(A: LatLng, C: LatLng, distanceSum: number, focalDistance: number, rotation: number, steps: number = 72): Feature<LineString> | null {
    const a = distanceSum / 2; // semi-major axis
    const c = focalDistance / 2; // half focal distance

    if (a <= c) {
        return null; // degenerate
    }

    const b = Math.sqrt(a * a - c * c); // semi-minor axis
    const center: LatLng = {
        lat: (A.lat + C.lat) / 2,
        lng: (A.lng + C.lng) / 2
    };

    const coords: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
        const theta = (i * 360) / steps;
        const thetaRad = deg2rad(theta);

        // Ellipse in local coordinates (aligned with A-C axis)
        const localAlong = a * Math.cos(thetaRad); // along A-C direction
        const localAcross = b * Math.sin(thetaRad); // perpendicular

        // Convert to distance and bearing from center
        const dist = Math.sqrt(localAlong * localAlong + localAcross * localAcross);
        const localAngle = rad2deg(Math.atan2(localAcross, localAlong));
        const bearing = rotation + localAngle;

        coords.push(destination(center, dist, bearing));
    }

    return lineString(coords);
}

/**
 * Assemble iso-distance ellipses showing contours of equal total distance
 * through the current sector. The base ellipse passes through the current
 * scored point S, showing the achieved distance. Additional ellipses at
 * +5km and +10km show where the pilot would need to fly to improve.
 *
 * Foci are A (scored point in previous sector) and C (optimal point in
 * next sector). Every point on a given ellipse yields the same d(A,P)+d(P,C).
 *
 * @param S - Current scored point in this sector (from distance optimiser)
 * @param A - Scored point in the previous sector
 * @param C - Optimal point in the next sector
 */
export function assembleOptimalDirection(S: LatLng, A: LatLng, C: LatLng): FeatureCollection | null {
    const features: Feature<LineString>[] = [];

    const distAS = turfDistance([A.lng, A.lat], [S.lng, S.lat]);
    const distSC = turfDistance([S.lng, S.lat], [C.lng, C.lat]);
    const scoredSum = distAS + distSC;
    const focalDistance = turfDistance([A.lng, A.lat], [C.lng, C.lat]);
    const rotation = turfBearing([A.lng, A.lat], [C.lng, C.lat]);

    for (const delta of [0, 5, 10]) {
        const ellipse = generateEllipse(A, C, scoredSum + delta, focalDistance, rotation);
        if (ellipse) {
            ellipse.properties = {type: 'isoDistance', deltaFromCurrent: delta};
            features.push(ellipse);
        }
    }

    if (features.length === 0) {
        return null;
    }

    return featureCollection(features);
}
