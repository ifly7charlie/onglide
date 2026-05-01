import type {LayerProps} from 'react-map-gl/maplibre';
import type {PilotScore} from '../types';

// Scored track for the selected pilot
export const scoredLineStyle: LayerProps = {
    id: 'scored_line',
    type: 'line',
    paint: {
        'line-color': '#0f0',
        'line-width': 5,
        'line-opacity': 1
    }
};

export const scoringPointStyle: LayerProps = {
    id: 'scoring_point',
    type: 'circle',
    filter: ['==', ['get', 'scoringPoint'], true],
    paint: {
        'circle-radius': 5,
        'circle-color': '#0f0',
        'circle-stroke-color': '#000',
        'circle-stroke-width': 1,
        'circle-opacity': 1
    }
};

export const minLineStyle: LayerProps = {
    id: 'minpossible',
    type: 'line',
    paint: {
        'line-color': '#f00',
        'line-width': 4,
        'line-opacity': 0.7,
        'line-dasharray': [1, 1]
    }
};

export const maxLineStyle: LayerProps = {
    id: 'maxpossible',
    type: 'line',
    paint: {
        'line-color': '#f00',
        'line-width': 4,
        'line-opacity': 0.7,
        'line-dasharray': [1, 1]
    }
};

export const minSignStyle: LayerProps = {
    id: 'min_sign',
    type: 'symbol',
    layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 200,
        'icon-image': 'signpost-min',
        'icon-size': 1,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map'
    }
};

export const maxSignStyle: LayerProps = {
    id: 'max_sign',
    type: 'symbol',
    layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 200,
        'icon-image': 'signpost-max',
        'icon-size': 1,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map'
    }
};

export const suggestedLineStyle: LayerProps = {
    id: 'suggested_track',
    type: 'line',
    paint: {
        'line-color': '#0f0',
        'line-width': 4,
        'line-opacity': 0.7,
        'line-dasharray': [2, 1]
    }
};

export const hullPointStyle: LayerProps = {
    id: 'hullPoint',
    type: 'circle',
    paint: {
        'circle-color': '#00f',
        'circle-radius': 4,
        'circle-opacity': 0.3
    }
};

export const hullLineStyle: LayerProps = {
    id: 'hullLine',
    type: 'line',
    paint: {
        'line-color': '#00f',
        'line-width': 2,
        'line-opacity': 0.6,
        'line-dasharray': [4, 1]
    }
};

export const DmPointStyle: LayerProps = {
    id: 'y-points',
    type: 'symbol',
    minzoom: 8,
    paint: {
        'text-color': '#000',
        'text-halo-blur': 0.5,
        'text-halo-width': 3,
        'text-halo-color': '#fff'
    },
    layout: {
        'symbol-placement': 'point',
        'icon-image': 'za-provincial-2',
        'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 11, 1.5],
        'text-allow-overlap': true,
        'symbol-sort-key': 999999999,
        'text-font': ['Atkinson Hyperlegible Next Regular'],
        'text-field': 'Dm',
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 3, 11, 10],
        'text-max-width': 1
    }
};

// Returns [trackLineStyle, turnpointStyleFlat, turnpointStyleExtrusion].
// 3D variant: flat turnpoint fills for non-current legs, 3D extrusion cylinders
// for the current/upcoming turnpoint.
export function turnpointStyle3d(selectedPilot: PilotScore | null, mapLight: boolean, startOpen: boolean): LayerProps[] {
    return [
        {
            id: 'track',
            type: 'symbol',
            layout: {
                'symbol-placement': 'line',
                'symbol-spacing': 1,
                'icon-image': mapLight ? 'arrowdark' : 'arrowlight',
                'icon-size': 1,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-rotation-alignment': 'map'
            }
        },
        {
            id: 'tp',
            type: 'fill',
            filter: ['case', ['==', !selectedPilot, true], false, ['==', ['get', 'leg'], selectedPilot?.utcStart ? selectedPilot?.currentLeg || 0 : 0], false, true],
            paint: {
                'fill-opacity': 0.5,
                'fill-color': [
                    'case',
                    ['==', !selectedPilot, true],
                    mapLight ? 'darkgrey' : 'white',
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0],
                    mapLight ? 'green' : '#7cfc00',
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    'orange',
                    mapLight ? 'darkgrey' : 'white'
                ]
            }
        },
        {
            id: 'tpe',
            type: 'fill-extrusion',
            filter: ['case', ['==', !selectedPilot, true], true, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], true, false],
            paint: {
                'fill-extrusion-color': [
                    'case',
                    ['==', startOpen, false],
                    'red',
                    ['==', !selectedPilot, true],
                    mapLight ? 'darkgrey' : 'white',
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0],
                    mapLight ? 'green' : '#7cfc00',
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    'orange',
                    mapLight ? 'darkgrey' : 'white'
                ],
                'fill-extrusion-opacity': 0.6,
                'fill-extrusion-base': [
                    'case',
                    ['==', !selectedPilot, true],
                    10,
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0],
                    5,
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    10,
                    0
                ],
                'fill-extrusion-height': [
                    'case',
                    ['==', !selectedPilot, true],
                    5000,
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0],
                    900,
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    5000,
                    2
                ]
            }
        }
    ];
}

// 2D variant: all turnpoints as flat fills; the 'tpe' extrusion layer is
// present but hidden so the visibility-toggle / beforeId stacking stays consistent.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function turnpointStyle2d(selectedPilot: PilotScore | null, mapLight: boolean, _startOpen: boolean): LayerProps[] {
    return [
        {
            id: 'track',
            type: 'symbol',
            layout: {
                'symbol-placement': 'line',
                'symbol-spacing': 4,
                'icon-image': mapLight ? 'arrowdark' : 'arrowlight',
                'icon-size': 1,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-rotation-alignment': 'map'
            }
        },
        {
            id: 'tp',
            type: 'fill',
            paint: {
                'fill-opacity': 0.5,
                'fill-color': [
                    'case',
                    ['==', !selectedPilot, true],
                    mapLight ? 'black' : 'white',
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0],
                    mapLight ? 'green' : 'lawngreen',
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    'orange',
                    mapLight ? 'darkgrey' : 'white'
                ]
            }
        },
        {
            id: 'tpe',
            layout: {visibility: 'none'},
            paint: {},
            type: 'fill-extrusion'
        }
    ];
}
