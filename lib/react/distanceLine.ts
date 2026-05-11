import {LayerProps} from 'react-map-gl/maplibre';

import type {LineString, Point, Feature} from 'geojson';
import {lineString, point, featureCollection} from '@turf/helpers';

//
// Convert a sequence of lng,lat points into a geojson geometry with properties
// including their line length. Optionally includes a scoring closest point marker.
export function assembleLabeledLine(points: number[], scoringClosestPoint?: {lat: number; lng: number} | null) {
    const features: Feature<LineString | Point>[] = [];

    // points laid out as flat groups of 4 (lng, lat, distance, handicappedDistance);
    // connect each consecutive pair, labelling with the second pair's distances.
    for (let i = 0; i + 7 < points.length; i += 4) {
        const distance = Math.round(10 * points[i + 6]) / 10;
        const handicappedDistance = Math.round(10 * points[i + 7]) / 10;
        features.push(lineString([[points[i], points[i + 1]], [points[i + 4], points[i + 5]]], {distance: distance + ' km' + (handicappedDistance >= 0.1 ? ' (' + handicappedDistance + ' km h/cap)' : '')}));
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
            'text-font': ['Atkinson Hyperlegible Next Regular'],
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
