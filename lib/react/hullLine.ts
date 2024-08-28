import {LayerProps} from 'react-map-gl';

import type {LineString, Feature} from 'geojson';
import {lineString, featureCollection} from '@turf/helpers';

import {chunk as _chunk} from 'lodash';

//
// Convert a sequence of lng,lat points into a geojson geometry with properties
// including their line length
export function assembleHullLine(legs: Record<number, {convexHull: number[]}>) {
    const lines: Feature<LineString>[] = [];

    Object.values(legs).forEach((l) => {
        const chunked: number[][] = _chunk(l.convexHull, 2);

        for (let i = 0; i < chunked.length - 1; i++) {
            lines.push(lineString([chunked[i].slice(0, 2), chunked[i + 1].slice(0, 2)]));
        }
    });

    return featureCollection(lines);
}
