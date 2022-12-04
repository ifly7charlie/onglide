import {LayerProps} from 'react-map-gl';

import {lineString, LineString, featureCollection, Feature} from '@turf/helpers';

import {chunk as _chunk} from 'lodash';

//
// Convert a sequence of lng,lat points into a geojson geometry with properties
// including their line length
export function assembleLabeledLine(points: number[]) {
    const chunked: number[][] = _chunk(points, 4);
    const lines: Feature<LineString>[] = [];

    for (let i = 0; i < chunked.length - 1; i++) {
        const distance = Math.round(10 * chunked[i + 1][2]) / 10;
        const handicappedDistance = Math.round(10 * chunked[i + 1][3]) / 10;
        lines.push(lineString([chunked[i].slice(0, 2), chunked[i + 1].slice(0, 2)], {distance: distance + ' km' + (handicappedDistance >= 0.1 ? ' (' + handicappedDistance + ' km h/cap)' : '')}));
    }

    //    console.log(lines);
    return featureCollection(lines);
}

export const distanceLineLabelStyle = (source: LayerProps): LayerProps => {
    return {
        id: source.id + '_label',
        type: 'symbol',
        //        source: source,
        paint: {
            'text-color': '#000',
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
            'text-size': 12
        } as any
    };
};
