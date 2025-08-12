import {GeoJsonLayer} from '@deck.gl/layers';

export function turnpointLayer(taskGeoJSONtp: any, map2d: boolean, mapLight: boolean, nextTp: number | undefined) {
    return new GeoJsonLayer({
        id: 'turnpoints' + map2d ? '2d' : '3d',
        data: taskGeoJSONtp,
        stroked: true,
        filled: true,
        extruded: !map2d,
        material: false,
        getLineColor: (i) => [255, 255, 0, 255],
        getFillColor: (i) => {
            return nextTp
                ? i.properties.leg < nextTp
                    ? mapLight
                        ? [0, 128, 0, 96] // green
                        : [0x7c, 0xff, 0, 128]
                    : //
                      i.properties.leg >= nextTp
                      ? [255, 165, 0, mapLight ? 64 : 96]
                      : mapLight
                        ? [128, 128, 128, 64]
                        : [255, 255, 255, 96]
                : mapLight
                  ? [128, 128, 128, 64]
                  : [192, 192, 192, 96];
        },
        getElevation: (i) => (!nextTp || i.properties.leg == nextTp ? 10000 : 0),
        updateTriggers: {
            getElevation: nextTp,
            getFillColor: nextTp + (mapLight ? 100 : 0)
        },
        pickable: true
    });
}
