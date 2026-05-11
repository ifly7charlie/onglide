import type {LineString, Feature} from 'geojson';
import {lineString, featureCollection} from '@turf/helpers';

//
// Convert a sequence of lng,lat points into a geojson geometry with properties
// including their line length
export function assembleHullLine(legs: Record<number, {convexHull: number[]}>) {
    const lines: Feature<LineString>[] = [];

    Object.values(legs).forEach((l) => {
        const ch = l.convexHull;
        // chunk into pairs of [lng, lat], then connect consecutive pairs
        for (let i = 0; i + 3 < ch.length; i += 2) {
            lines.push(lineString([[ch[i], ch[i + 1]], [ch[i + 2], ch[i + 3]]]));
        }
    });

    return featureCollection(lines);
}
