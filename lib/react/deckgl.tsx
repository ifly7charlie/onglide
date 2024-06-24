'use client';

import {useCallback, useMemo, useRef, useEffect} from 'react';
import {MapboxOverlay, MapboxOverlayProps} from '@deck.gl/mapbox';
import {TextLayer} from '@deck.gl/layers';

import Map, {Source, Layer, LayerProps, useControl, NavigationControl, ScaleControl} from 'react-map-gl';

import {deckTooltip} from './decktooltip';

import {useTaskGeoJSON} from './loaders';

import {offlineTime, recentTrackLength} from '../constants';

import type {Epoch, ClassName, Compno, TrackData, ScoreData, SelectedPilotDetails, OtherPilotData, PilotScore} from '../types';

import {distanceLineLabelStyle} from './distanceLine';

function DeckGLOverlay(
    props: MapboxOverlayProps & {
        interleaved?: boolean;
    }
) {
    const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
    overlay.setProps(props);
    return null;
}

// Figure out where the sun should be
import SunCalc from 'suncalc';

// For displaying rain radar
import {AttributionControl} from 'react-map-gl';
import {RadarOverlay} from './rainradar';

import {UseMeasure, measureClick, isMeasuring, MeasureLayers} from './measure';

import bearing from '@turf/bearing';
import bbox from '@turf/bbox';

import {SortKey} from './pilot-sorting';

import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep} from 'lodash';

import {OgnTripsLayer} from './ogntripslayer';
import {otherPilotsLayer} from './otherpilotslayer';
import {turnpointLayer} from './turnpointlayer';

// Figure out the baseline date
const oneHalfYearIsh = 3600 * 24 * 180;
const referenceDate =
    (process.env.NEXT_PUBLIC_REPLAY //
        ? parseInt(process.env.NEXT_PUBLIC_REPLAY) - (parseInt(process.env.NEXT_PUBLIC_REPLAY) % oneHalfYearIsh)
        : new Date(Date.now() - (Date.now() % (oneHalfYearIsh * 1000))).getTime() / 1000) - oneHalfYearIsh;

// Import our layer override so we can distinguish which point on a
// line has been clicked or hovered
//import {StopFollowController} from './deckglcontroller';
// helps with touch scroll on laptops (undocumented)
//const controller: {type: any; setFollow?: Function; inertia: true; transitionDuration: 0} = {type: StopFollowController, inertia: true, transitionDuration: 0};

import {colourise} from './colourise';

const colours: Record<string, (mapLight: boolean, selected: boolean) => ((d: any) => number[]) | number[]> = {
    auto: (mapLight: boolean, selected: boolean) => (selected ? [255, 0, 255, 192] : mapLight ? [0, 0, 0, 127] : [224, 224, 224, 224]),
    climb:
        (_mapLight: boolean, _selected: boolean) =>
        (d): number[] =>
            colourise(Math.min(255, Math.max(0, d.v * -12.5 + 128))),
    height: (_mapLight: boolean, _selected: boolean) => (d) => colourise(Math.min(255, Math.log2(d.p[1][2] >> 5) * 35)),
    aheight: (_mapLight: boolean, _selected: boolean) => (d) => colourise(Math.min(255, Math.log2(d.g >> 5) * 35))
};
//
// Responsible for generating the deckGL layers
//
function makeLayers(
    props: {trackData: TrackData; selectedCompno: Compno; setSelectedCompno: Function; t: Epoch},
    sortKey: SortKey,
    map2d: boolean,
    mapLight: boolean,
    fullPaths: boolean
) {
    if (!props.trackData) {
        console.log('missing layers');
        return [];
    }

    // Add a layer for the recent points for each pilot
    let layers = _reduce(
        props.trackData,
        (result, track, compno) => {
            // Don't include current pilot in list of all
            const selected = compno == props.selectedCompno;

            const p = track.deck;
            if (!p) {
                console.log(`deck missing from ${compno}`, track);
                return result;
            }

            // For all but selected gliders just show most recent track
            const tripsFiltering = {
                currentTime: props.t - referenceDate,
                fadeTrail: !fullPaths && !selected,
                trailLength: recentTrackLength
            };

            const sortKeyColour = colours[sortKey] ? sortKey : 'auto';
            const colour = colours[!props.selectedCompno || selected ? sortKeyColour : 'auto'](mapLight, selected);

            result.push(
                new OgnTripsLayer({
                    id: compno + p.trackVersion,
                    compno: compno,
                    data: {
                        length: p.segmentIndex, // note this is not -1 (segmentIndex is one we are in, there should be a terminator one after)
                        numberOfPoints: p.posIndex,
                        startIndices: p.indices,
                        t: p.t,
                        v: p.climbRate,
                        g: p.agl,
                        attributes: {
                            getPath: {value: p.positions, size: 3}, // , size: map2d ? 2 : 3, stride: map2d ? 4 * 3 : 0},
                            getTimestamps: {value: p.tr, size: 1}
                        }
                    },
                    _pathType: 'open',
                    getWidth: selected ? 8 : 5,
                    positionFormat: 'XYZ',
                    getColor: colour as any,
                    jointRounded: true,
                    fp64: false,
                    billboard: map2d ? false : true,
                    widthMinPixels: selected ? 3 : 2,
                    onClick: (i) => {
                        props.setSelectedCompno(compno);
                    },
                    updateTriggers: {
                        getPath: p.posIndex,
                        getColor: sortKeyColour + mapLight + (selected ? 's' : '') + (props.selectedCompno ? 'y' : '')
                    },
                    pickable: true,
                    tt: true,
                    ...tripsFiltering
                })
            );
            return result;
        },
        []
    );

    //
    // Generate the labels data, this is fairly simple and is extracted from the positions
    // data set rather than pilots so that the marker always aligns with the tracking points
    // we are adding more data so we get a nice tool tip, text colour is determined by how old
    // the point is
    const data = _map(props.trackData, (track) => {
        const p = track.deck;
        if (!p) {
            return {};
        }
        return {
            name: track.compno,
            compno: track.compno,
            v: p.climbRate[p.posIndex - 1], //
            g: p?.agl[p.posIndex - 1],
            a: p.positions[(p.posIndex - 1) * 3 + 2],
            t: p.t[p.posIndex - 1],
            coordinates: [...p.positions.subarray((p.posIndex - 1) * 3, p.posIndex * 3)]
        };
    });

    if (data.length) {
        layers.push(
            new TextLayer({
                id: 'labels', //+ (map2d ? '2d' : '3d'),
                data: data,
                getPosition: (d) => d.coordinates, // map2d ? (d) => [...d.coordinates.slice(0, 2), props.selectedCompno == d.name ? 200 : d.alt / 50] : (d) => d.coordinates,
                getText: (d) => d.name,
                getColor: (d) => (props.t - d.t > offlineTime ? [100, 80, 80, 96] : [0, 100, 0, 255]),
                getTextAnchor: 'middle',
                getAlignmentBaseline: 'bottom',
                getSize: (d) => (d.name == props.selectedCompno ? 20 : 16),
                pickage: true,
                background: true,
                fontSettings: {sdf: true},
                backgroundPadding: [2, 1, 2, 0],
                onClick: (i) => {
                    props.setSelectedCompno(i.object?.name || '');
                },
                outlineWidth: 2,
                outlineColor: [255, 255, 255, 255],
                getBackgroundColor: [255, 255, 255, 255],
                getBorderColor: (d) => (d.name === props.selectedCompno ? [255, 0, 255, 192] : [40, 40, 40, 255]),
                getBorderWidth: 1,
                pickable: true
            })
        );
    }

    return layers;
}

export default function MApp(props: {
    options: any;
    setOptions: Function; //
    pilotScores: ScoreData;
    selectedPilotData: SelectedPilotDetails | null;
    follow: boolean;
    setFollow: Function;
    vc: ClassName;
    selectedCompno: Compno;
    setSelectedCompno: Function;
    tz: string;
    viewport: any;
    setViewport: Function;
    trackData: TrackData;
    otherPilots: OtherPilotData;
    measureFeatures: UseMeasure;
    status: string; // status line
    t: Epoch;
}) {
    // For remote updating of the map
    const mapRef = useRef(null);

    // So we get some type info
    const {options, setOptions, pilotScores, selectedPilotData, follow, setFollow, vc, selectedCompno, tz, viewport, setViewport} = props;

    const isMoving = mapRef?.current?.isMoving() ?? true;

    // Map display style
    const map2d = options.map2d;
    const mapStreet = !options.mapType;
    const mapLight = !mapStreet;

    // Track and Task Overlays
    const {taskGeoJSON, isTLoading, isTError}: {taskGeoJSON: any; isTError: boolean; isTLoading: boolean} = useTaskGeoJSON(vc);
    const layers = makeLayers(props, options.sortKey as SortKey, map2d, mapLight, options.fullPaths);

    // Rain Radar
    const lang = useMemo(() => (navigator.languages != undefined ? navigator.languages[0] : navigator.language), []);
    const radarOverlay = RadarOverlay({options, setOptions, tz});

    // What task are we using on display
    const taskGeoJSONtp = selectedPilotData?.score?.taskGeoJSON || taskGeoJSON?.tp;

    // Get coordinates on the screen for center point of view
    const screenPoint = useMemo(
        () => mapRef?.current?.getMap().project([props.viewport.longitude, props.viewport.latitude]) ?? {x: 0, y: 0},
        [props.viewport]
    );

    const nextTp = selectedPilotData?.score?.utcFinish
        ? 99
        : selectedPilotData?.score?.currentLeg + (selectedPilotData?.score?.inSector ? 1 : 0) || 0;

    const npol = !taskGeoJSON?.track?.features?.[0]
        ? null
        : !selectedPilotData?.score?.utcStart || !(selectedPilotData.score.minDistancePoints.length > 6) // still start
        ? taskGeoJSON.track.features[0]?.geometry?.coordinates?.[0]
        : selectedPilotData.score.utcFinish // if we are done then take last one
        ? taskGeoJSON.track.features[taskGeoJSON.track.features.length - 1]?.geometry?.coordinates?.[1]
        : selectedPilotData.score.minDistancePoints.slice(nextTp * 4, nextTp * 4 + 2);

    // =========== FOLLOW EFFECT ===============
    //
    // We will calculate the nearest point every 60 seconds or when the TP changes or selected pilot changes
    useEffect(
        () => {
            const map = mapRef?.current?.getMap();

            if (
                map &&
                !map?.isMoving() &&
                props.options.follow &&
                follow &&
                selectedPilotData?.track?.vario?.lat && //
                taskGeoJSON?.track?.features
            ) {
                // If we are in track up mode then we will point it towards the next turnpoint
                const lat = Math.round(selectedPilotData.track.vario.lat * 100000) / 100000;
                const lng = Math.round(selectedPilotData.track.vario.lng * 100000) / 100000;

                // Next point - if we haven't started or we have finished use the startline

                // If we are user selected or we don't have a valid next point don't change anything
                const fbearing =
                    props.options.taskUp == 2 || !npol
                        ? props.viewport.bearing
                        : props.options.taskUp == 1
                        ? bearing([lng, lat], npol, {final: false})
                        : 0;

                const newScreenPoint = mapRef?.current?.getMap().project([lng, lat]);

                // In 2d we need more movement before we adjust the map
                const pointCheck = (a: number, b: number, s: number): boolean => {
                    return Math.abs(a - b) / s > (map2d ? 0.25 /*25% of screen in either direction*/ : 0.1); /*10% of screen in either direction*/
                };

                const screenSizeX = mapRef?.current?.getMap()?._containerWidth ?? 1300,
                    screenSizeY = mapRef?.current?.getMap()?._containerHeight ?? 500;

                if (
                    pointCheck(newScreenPoint.x, screenPoint.x, screenSizeX) ||
                    pointCheck(newScreenPoint.y, screenPoint.y, screenSizeY) || //
                    Math.round(fbearing) >> 2 != Math.round(props.viewport.bearing) >> 2
                ) {
                    mapRef?.current?.flyTo({
                        center: [lng, lat],
                        bearing: Math.round(fbearing)
                    });
                }
            }
        },
        follow && props.options.follow //
            ? [selectedCompno, props.t >> 2, npol, props.options, isMoving]
            : [null, null, null, null, null]
    );

    // ====== PITCH RESTRICTION FOR 2D/3D =======
    useEffect(() => {
        const map = mapRef?.current;
        if (!isMoving && map) {
            // If we are 3d and not locked pitch then correct
            if (!map2d && map.getMap().getMaxPitch() != 80) {
                map.getMap().setMaxPitch(80);
                map.easeTo({
                    pitch: 75
                });
            }
            // Likewise for 2d
            if (map2d && map.getMap()?.getMaxPitch() != 0) {
                map.easeTo({
                    pitch: 0
                }).once('moveend', () => map.getMap().setMaxPitch(0));
            }
        }
    }, [map2d, mapRef.current, props.viewport.pitch, isMoving]);

    // ======= ZOOM TO TASK EFFECT =========
    // If we are supposed to zoom then do this and turn off the flag
    useEffect(() => {
        if (options.zoomTask && taskGeoJSONtp && viewport) {
            console.log('zoom to task', viewport);
            try {
                const [minLng, minLat, maxLng, maxLat] = bbox(taskGeoJSONtp);
                setOptions({...options, zoomTask: false});
                mapRef?.current?.fitBounds(
                    [
                        [minLng, minLat],
                        [maxLng, maxLat]
                    ],
                    {
                        pitch: map2d ? 0 : 70,
                        padding: 20,
                        offset: [(mapRef.current?.getContainer()?.clientWidth ?? 0) < 992 ? 0 : -140, 0],
                        bearing: 0
                    }
                );
            } catch (e) {
                console.error(e);
            }
        }
    }, [options.zoomTask, taskGeoJSONtp, viewport, mapRef.current]);

    // ====== LOCK NORTH UP ===========
    // If we are north up then reset north on bearing change
    // NOOP for others
    useEffect(() => {
        if (!isMoving && options.taskUp === 0 && Math.trunc(viewport.bearing / 2) != 0) {
            mapRef?.current?.resetNorth({duration: 250});
        }
    }, [options.taskUp === 0 ? viewport.bearing : 0, isMoving]);

    //
    // Colour and style the task based on the selected pilot and their destination
    const [trackLineStyle, turnpointStyleFlat, turnpointStyle] = useMemo(() => {
        return map2d ? turnpointStyle2d(selectedPilotData?.score, mapLight) : turnpointStyle3d(selectedPilotData?.score, mapLight);
    }, [selectedCompno, selectedPilotData?.score?.currentLeg, selectedPilotData?.score?.utcFinish, mapLight, map2d]);

    // Do we have a loaded set of details?
    const valid = !(isTLoading || isTError) && taskGeoJSON?.tp && taskGeoJSON?.track;

    const skyLayer: any = {
        id: 'sky',
        type: 'sky',
        paint: {
            'sky-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0, 5, 0.3, 8, 1],
            // set up the sky layer for atmospheric scattering
            'sky-type': 'atmosphere',
            // explicitly set the position of the sun rather than allowing the sun to be attached to the main light source
            'sky-atmosphere-sun': getSunPosition(mapRef),
            // set the intensity of the sun as a light source (0-100 with higher values corresponding to brighter skies)
            'sky-atmosphere-sun-intensity': 5,
            'sky-atmosphere-color': 'rgba(135, 206, 235, 1.0)'
        }
    };

    //
    // Link up to a tooltip
    const toolTip = useCallback(
        (input) => deckTooltip({...input, map: mapRef?.current, pilotScores, lang, tz: props?.tz, units: props?.options?.units}), //
        [vc, props.options.units, props.tz, mapRef?.current]
    );

    const attribution = useMemo(
        () => (
            <AttributionControl //
                key={radarOverlay.key + (props.status?.replaceAll(/[^0-9]/g, '') || 'no')}
                customAttribution={[radarOverlay.attribution, props.status].join(' | ')}
                style={attributionStyle}
            />
        ),
        [radarOverlay.key, props.status]
    );

    // Initial options depending on if we are on 2d or 3d
    const viewOptions = map2d ? {minPitch: 0, maxPitch: 80, pitch: 0} : {minPitch: 0, maxPitch: 80, pitch: 70};

    // We keep our saved viewstate up to date in case of re-render
    const onViewStateChange = useCallback(({viewState}) => {
        props.setViewport(viewState);
    }, []);

    const onClick = useCallback(() => measureClick(props.measureFeatures), [props.measureFeatures]);
    const getCursor = useCallback(() => 'crosshair', []);

    // If we are displaying other pilots
    const otherPilotLayer = props.options.showOthers ? otherPilotsLayer(props.otherPilots, mapLight, map2d, props.t) : null;

    // And the turnpoints
    const tpLayer = turnpointLayer(taskGeoJSONtp, map2d, mapLight, nextTp);

    // Adjust to satellite or not, style has all layers in it so we just need to change the visibility which is
    // much quicker than changing the style.
    const fixupMap = useCallback(() => {
        try {
            mapRef?.current?.getMap()?.setLayoutProperty('satellite', 'visibility', !mapStreet ? 'none' : 'visible');
            mapRef?.current?.getMap()?.setLayoutProperty('background', 'visibility', !mapStreet ? 'none' : 'visible');
        } catch (e) {}
    }, [mapStreet]);
    useEffect(fixupMap, [mapStreet, mapRef?.current]);

    // Cancel any follow
    const onDragStart = useCallback(() => {
        if (follow) {
            setFollow(false);
        }
    }, [setFollow, follow]);

    return (
        <Map //
            initialViewState={{...props.viewport, ...viewOptions}}
            onMove={onViewStateChange}
            onStyleData={fixupMap}
            mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN}
            mapStyle={'mapbox://styles/ifly7charlie/clmbzpceq01au01r7abhp42mm'}
            reuseMaps={true}
            ref={mapRef}
            attributionControl={false}
        >
            <DeckGLOverlay
                getTooltip={toolTip}
                {...(isMeasuring(props.measureFeatures) ? {getCursor: getCursor} : {})}
                onClick={onClick}
                onDragStart={onDragStart}
                layers={[...layers, otherPilotLayer, tpLayer]} //
                interleaved={!map2d}
            />
            {options.constructionLines && taskGeoJSON?.Dm ? (
                <Source type="geojson" data={taskGeoJSON.Dm} key="y">
                    <Layer {...DmPointStyle} />
                </Source>
            ) : null}
            {valid ? (
                <Source type="geojson" data={taskGeoJSON.track}>
                    <Layer {...trackLineStyle} key="tls" />
                </Source>
            ) : null}
            {selectedPilotData && options.constructionLines && selectedPilotData.score?.minGeoJSON ? (
                <Source type="geojson" data={selectedPilotData.score?.minGeoJSON} key={'min_'}>
                    <Layer {...minLineStyle} />
                    <Layer {...distanceLineLabelStyle(minLineStyle)} />
                </Source>
            ) : null}
            {selectedPilotData && options.constructionLines && selectedPilotData.score?.maxGeoJSON ? (
                <Source type="geojson" data={selectedPilotData.score?.maxGeoJSON} key={'max_'}>
                    <Layer {...maxLineStyle} />
                    <Layer {...distanceLineLabelStyle(maxLineStyle)} />
                </Source>
            ) : null}
            {selectedPilotData && selectedPilotData?.score?.scoredGeoJSON ? (
                <Source type="geojson" data={selectedPilotData.score.scoredGeoJSON} key={'scored_'}>
                    <Layer key="scoredLine" {...scoredLineStyle} />
                    <Layer key="distanceLabels" {...distanceLineLabelStyle(scoredLineStyle)} />
                </Source>
            ) : null}
            <MeasureLayers useMeasure={props.measureFeatures} key="measure" />
            <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} />
            {!map2d && <Layer key="skylayer" {...skyLayer} />}
            {attribution}
            {radarOverlay.layer}
            <ScaleControl position="bottom-left" />
            <NavigationControl showCompass showZoom visualizePitch position="bottom-left" />
        </Map>
    );
}

// scored track for selected pilot
const scoredLineStyle: LayerProps = {
    id: 'scored',
    type: 'line',
    paint: {
        'line-color': '#0f0',
        'line-width': 5,
        'line-opacity': 1
    }
};

const minLineStyle: LayerProps = {
    id: 'minpossible',
    type: 'line',
    paint: {
        'line-color': '#f00',
        'line-width': 4,
        'line-opacity': 0.7,
        'line-dasharray': [1, 1]
    }
};

const maxLineStyle: LayerProps = {
    id: 'maxpossible',
    type: 'line',
    paint: {
        'line-color': '#0f0',
        'line-width': 4,
        'line-opacity': 0.7,
        'line-dasharray': [2, 1]
    }
};

const DmPointStyle: LayerProps = {
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
        'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            // zoom is 5 (or less) -> circle radius will be 1px
            8,
            0.4,
            // zoom is 10 (or greater) -> circle radius will be 5px
            11,
            1.5
        ],
        'text-allow-overlap': true,
        'symbol-sort-key': 999999999,
        'text-font': ['Open Sans Regular'],
        'text-field': 'Dm',
        'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            // zoom is 5 (or less) -> circle radius will be 1px
            8,
            3,
            // zoom is 10 (or greater) -> circle radius will be 5px
            11,
            10
        ],
        'text-max-width': 1
    }
};

function getSunPosition(mapRef, date?) {
    const map = mapRef?.current; //?.getMap();
    if (map) {
        const center = map.getCenter();
        const sunPos = SunCalc.getPosition(date || Date.now(), center.lat, center.lng);
        const sunAzimuth = 180 + (sunPos.azimuth * 180) / Math.PI;
        const sunAltitude = 90 - (sunPos.altitude * 180) / Math.PI;
        return [Math.round(sunAzimuth * 10) / 10, Math.round(sunAltitude * 10) / 10];
    } else {
        return [0, 0];
    }
}

const attributionStyle = {
    right: 0,
    bottom: 0,
    fontSize: '13px'
};

function turnpointStyle3d(selectedPilot: PilotScore | null, mapLight: boolean): LayerProps[] {
    return [
        {
            // Track line
            id: 'track',
            type: 'line',
            paint: {
                'line-color': mapLight ? 'darkgrey' : 'white',
                'line-width': ['case', ['==', !selectedPilot, true], 15, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], 15, 6],
                'line-opacity': 1,
                'line-pattern': mapLight ? 'oneway-large' : 'oneway-white-large'
            }
        },
        {
            // Turnpoints
            id: 'tp',
            type: 'fill',
            filter: ['case', ['==', !selectedPilot, true], false, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], false, true],
            paint: {
                //                'line-color': 'grey',
                //                'line-width': 1,
                'fill-opacity': 0.5,
                'fill-color': [
                    'case',
                    ['==', !selectedPilot, true],
                    mapLight ? 'darkgrey' : 'white',
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0], //
                    mapLight ? 'green' : '#7cfc00',
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    'orange',
                    mapLight ? 'darkgrey' : 'white'
                ]
            }
        },
        {
            // Turnpoints
            id: 'tpe',
            type: 'fill-extrusion',
            filter: ['case', ['==', !selectedPilot, true], true, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], true, false],
            paint: {
                //                'line-color': 'grey',
                //                'line-width': 1,
                'fill-extrusion-color': [
                    'case',
                    ['==', !selectedPilot, true],
                    mapLight ? 'darkgrey' : 'white',
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0], //
                    mapLight ? 'green' : '#7cfc00',
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    'orange',
                    mapLight ? 'darkgrey' : 'white'
                ],
                'fill-extrusion-opacity': 0.5,
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
                    100,
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0],
                    9,
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    5000,
                    2
                ]
            }
        }
    ];
}

function turnpointStyle2d(selectedPilot: PilotScore | null, mapLight: boolean): LayerProps[] {
    return [
        {
            // Track line
            id: 'track',
            type: 'line',
            paint: {
                'line-color': mapLight ? 'darkgrey' : 'white',
                'line-width': ['case', ['==', !selectedPilot, true], 20, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], 20, 10],
                'line-opacity': 1,
                'line-pattern': mapLight ? 'oneway-large' : 'oneway-white-large'
            }
        },
        {
            // Turnpoints flat
            id: 'tp',
            type: 'fill',
            paint: {
                'fill-opacity': 0.5,
                'fill-color': [
                    'case',
                    ['==', !selectedPilot, true],
                    mapLight ? 'darkgrey' : 'white',
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0], //
                    mapLight ? 'green' : 'lawngreen',
                    ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0],
                    'orange',
                    mapLight ? 'darkgrey' : 'white'
                ]
            }
        },
        {
            // Turnpoints not flat
            id: 'tpe',
            layout: {
                visibility: 'none'
            },
            paint: {},
            type: 'fill-extrusion'
        }
    ];
}
