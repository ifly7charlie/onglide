import {point, lineString, featureCollection, Feature, Geometry, FeatureCollection} from '@turf/helpers';
import length from '@turf/length';

import {cloneDeep as _cloneDeep} from 'lodash';

import {useState, Dispatch, SetStateAction, MouseEventHandler} from 'react';

import {Source, Layer, LayerProps} from 'react-map-gl';

export interface MeasureOptions {
    features: Feature[];
    enabled: boolean;
}

export type UseMeasure = [MeasureOptions, Dispatch<SetStateAction<MeasureOptions>>];

export function useMeasure(): UseMeasure {
    return useState<MeasureOptions>({features: [], enabled: false});
}

export function measureClick(useMeasure: UseMeasure): Function {
    const [measureFeatures, setMeasureFeatures] = useMeasure;
    if (!measureFeatures?.enabled) {
        return () => {
            /**/
        };
    }
    return (info, event) => {
        if (measureFeatures.features.length > 1) {
            measureFeatures.features.pop();
        }
        measureFeatures.features.push(point(info.coordinate));
        if (measureFeatures.features.length > 1) {
            const line = lineString(measureFeatures.features.map((point: any) => point?.geometry?.coordinates));

            line.properties['distance'] = Math.round(length(line) * 10) / 10 + ' km';
            measureFeatures.features.push(line);
        }
        setMeasureFeatures(_cloneDeep(measureFeatures));
    };
}

export function isMeasuring(useMeasure: UseMeasure): boolean {
    return useMeasure?.[0]?.enabled || false;
}

export function toggleMeasure(useMeasure: UseMeasure): MouseEventHandler<HTMLButtonElement> {
    return () => {
        const [measureFeatures, setMeasureFeatures] = useMeasure;
        measureFeatures.enabled = !measureFeatures.enabled;
        measureFeatures.features = [];
        setMeasureFeatures(_cloneDeep(measureFeatures));
    };
}

export function MeasureLayers(props: {useMeasure: UseMeasure}) {
    const [measureFeatures] = props.useMeasure;
    return isMeasuring(props.useMeasure) && measureFeatures?.features?.length ? (
        <Source type="geojson" data={featureCollection(measureFeatures.features) as any} key={'measure' + measureFeatures.features.length} id={'measure'}>
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
            'text-font': ['Open Sans Regular'],
            'text-field': ['get', 'distance'],
            'text-allow-overlap': false,
            'text-size': 15
        } as any
    };
};
