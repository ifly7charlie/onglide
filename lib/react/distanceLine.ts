import {LayerProps} from 'react-map-gl';

import type {LineString, Point, Feature} from 'geojson';
import {lineString, point, featureCollection} from '@turf/helpers';

import {chunk as _chunk} from 'lodash';

//
// Convert a sequence of lng,lat points into a geojson geometry with properties
// including their line length. Optionally includes a scoring closest point marker.
export function assembleLabeledLine(points: number[], scoringClosestPoint?: {lat: number; lng: number} | null) {
    const chunked: number[][] = _chunk(points, 4);
    const features: Feature<LineString | Point>[] = [];

    for (let i = 0; i < chunked.length - 1; i++) {
        const distance = Math.round(10 * chunked[i + 1][2]) / 10;
        const handicappedDistance = Math.round(10 * chunked[i + 1][3]) / 10;
        features.push(lineString([chunked[i].slice(0, 2), chunked[i + 1].slice(0, 2)], {distance: distance + ' km' + (handicappedDistance >= 0.1 ? ' (' + handicappedDistance + ' km h/cap)' : '')}));
    }

    if (scoringClosestPoint) {
        features.push(point([scoringClosestPoint.lng, scoringClosestPoint.lat], {scoringPoint: true}));
    }

    return featureCollection(features);
}

export const distanceLineLabelStyle = (source: LayerProps, visible?: boolean | undefined): LayerProps => {
    return <LayerProps>{
        id: source.id + '_label',
        type: 'symbol',
        //        source: source,
        paint: {
            'text-color': visible === undefined ? '#222' : '#000',
            'text-halo-blur': 1,
            'text-halo-width': 2,
            'text-halo-color': '#fff'
        },
        layout: {
            'symbol-placement': 'line-center',
            'text-font': ['Open Sans Regular'],
            'text-field': ['get', 'distance'],
            //            'text-field': 'hello!',
            //            'text-color': '#0ff',
            //            'text-halo-blur': 2,
            //            'text-halo-width': 3,
            //'text-halo-color': '#fff',
            'text-size': visible === undefined ? 12 : 15,
            visibility: visible == false ? 'none' : 'visible'
        }
    };
};
