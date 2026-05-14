import {point, lineString, featureCollection} from '@turf/helpers';
import type {Feature} from 'geojson';
import length from '@turf/length';

import {useState, createContext, useContext} from 'react';

import {Source, Layer, LayerProps} from 'react-map-gl/maplibre';

export interface MeasureOptions {
    features: Feature[];
    enabled: boolean;
    click?: React.MouseEventHandler<HTMLButtonElement>;
    toggle?: () => void;
    reset?: () => void;
}

const measureContext = createContext<MeasureOptions>({enabled: false, features: []});

export function MeasureContext({children}) {
    const [enabled, setEnabled] = useState(false);
    const [features, setFeatures] = useState<Feature[]>([]);

    const click = (info) => {
        if (!enabled) {
            return;
        }
        if (features.length > 1) {
            features.pop();
        }
        features.push(point(info.coordinate));
        if (features.length > 1) {
            const line = lineString(features.map((point: any) => point?.geometry?.coordinates));
            line.properties['distance'] = Math.round(length(line) * 10) / 10 + ' km';
            features.push(line);
        }
        setFeatures(structuredClone(features));
    };

    const toggle = () => {
        setEnabled(!enabled);
        setFeatures([]);
    };

    const reset = () => {
        if (!features.length) {
            setEnabled(false);
        }
        setFeatures([]);
    };

    return <measureContext.Provider value={{enabled, features, click, toggle, reset}}>{children}</measureContext.Provider>;
}

export function useMeasure() {
    return useContext(measureContext);
}

export function MeasureLayers() {
    const {enabled, features} = useMeasure();
    return enabled && features?.length ? (
        <Source type="geojson" data={featureCollection(features) as any} key={'measure' + features.length} id={'measure'}>
            <Layer {...measurePointsStyle} />
            <Layer {...measureLineStyle} />
            <Layer {...measureLineLabelStyle(measureLineStyle)} />
        </Source>
    ) : null;
}

const measureLineStyle: LayerProps = {
    id: 'measure',
    type: 'line',
    paint: {
        'line-color': '#000',
        'line-width': 2,
        'line-opacity': 0.7
    },
    filter: ['in', '$type', 'LineString']
};

const measurePointsStyle: LayerProps = {
    id: 'measure-points',
    type: 'circle',
    paint: {
        'circle-radius': 5,
        'circle-color': '#000'
    },
    filter: ['in', '$type', 'Point']
};

export const measureLineLabelStyle = (source: LayerProps): LayerProps => {
    return {
        id: source.id + '_label',
        type: 'symbol',
        paint: {
            'text-color': '#000',
            'text-halo-blur': 1,
            'text-halo-width': 2,
            'text-halo-color': '#fff'
        },
        layout: {
            'symbol-placement': 'line',
            'text-font': ['Atkinson Hyperlegible Next Regular'],
            'text-field': ['get', 'distance'],
            'text-allow-overlap': false,
            'text-size': 15
        } as any,
        filter: ['in', '$type', 'LineString']
    };
};
