'use client';

import {useCallback, useMemo, useRef, useEffect} from 'react';
import {MapboxOverlay, MapboxOverlayProps} from '@deck.gl/mapbox';

import Map, {Source, Layer, LayerProps, useControl, NavigationControl, ScaleControl, MapRef} from 'react-map-gl';

import {deckTooltip} from './decktooltip';

import type {Epoch, ClassName, Compno, Options, PilotScore, TZ} from '../types';
import {TaskUp} from '../types';

import {distanceLineLabelStyle} from './distanceLine';

import {selectTaskGeoJSON, selectTask, selectStartOpen} from '../redux/taskSlice';
import {selectPilotScore} from '../redux/scoresSlice';
import {selectPilotPosition, selectLatestUpdate} from '../redux/tracksSlice';
import {useSelector} from '../redux';
import {ErrorBoundary} from 'react-error-boundary';

import {assembleHullLine} from './hullLine';

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

import {MeasureLayers, useMeasure} from './measure';

import bearing from '@turf/bearing';
import bbox from '@turf/bbox';
import buffer from '@turf/buffer';

import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep} from 'lodash';

import {otherPilotsLayer} from './otherpilotslayer';
import {pilotsLayer} from './pilotslayer';
import {pilotsTrackLayer} from './pilotstracklayer';
//import {turnpointLayer} from './turnpointlayer';

export default function MApp(props: {
    options: Options;
    setOptions: Function; //
    follow: boolean;
    setFollow: Function;
    vc: ClassName;
    selectedCompno: Compno;
    selectedHandicap: number;
    setSelectedCompno: (compno: Compno) => void;
    tz: TZ;
    viewport: any;
    setViewport: Function;
    status: string; // status line
    replayTime: Epoch;
    setReplayTime: (t: Epoch | undefined) => void;
}) {
    // For remote updating of the map
    const mapRef = useRef<MapRef | null>(null);
    const measure = useMeasure();

    // So we get some type info
    const {options, setOptions, follow, setFollow, vc, selectedCompno, tz, viewport} = props;

    // Score details for selected pilot
    const selectedScore = useSelector((state) => selectPilotScore(state, selectedCompno, props.replayTime));
    const latestUpdate = useSelector(selectLatestUpdate);
    const selectedPosition = useSelector((state) => (selectedCompno ? selectPilotPosition(state, selectedCompno, props.replayTime) : undefined));

    const isMoving = mapRef?.current?.isMoving() ?? true;

    // Map display style
    const map2d = options.map2d;
    const mapStreet = !!options.mapType;
    const mapLight = mapStreet;

    // Rules & legs etc
    const task = useSelector((state) => selectTask(state, vc));

    // Track and Task Overlays
    const taskGeoJSON = useSelector((state) => selectTaskGeoJSON(state, vc, props.selectedHandicap));
    const startOpen = useSelector((state) => selectStartOpen(state, vc));

    const pilotTrackLayer = pilotsTrackLayer(props, latestUpdate, options.sortKey, map2d, mapLight, options.fullPaths);

    // Rain Radar
    const lang = useMemo(() => (navigator.languages != undefined ? navigator.languages[0] : navigator.language), []);
    const radarOverlay = RadarOverlay({options, tz});

    // What task are we using on display
    const taskGeoJSONtp = taskGeoJSON?.tp;

    // Get coordinates on the screen for center point of view
    const screenPoint = useMemo(() => mapRef?.current?.getMap().project([props.viewport.longitude, props.viewport.latitude]) ?? {x: 0, y: 0}, [props.viewport]);

    const legAdvance = task && task.rules.aat && selectedScore?.inSector && selectedScore.legs[selectedScore.currentLeg + 1]?.actual.distance > 10;

    const nextPoint =
        !task || !selectedScore
            ? null //
            : !selectedScore?.utcStart
              ? task.legs[0].point // if we are before start
              : selectedScore?.utcFinish || selectedScore.minDistancePoints.length < 6
                ? task.legs.at(-1)?.point // or at finish or only finish left
                : task.legs.at(selectedScore?.currentLeg + (legAdvance ? 1 : 0))?.point; // mindistance is from us so this is the next point

    const handleKeyPress = useCallback(
        (e) => {
            switch (e.key) {
                /*                case 'ArrowLeft':
                    if (props.replayTime) {
                        props.setReplayTime((props.replayTime - 60) as Epoch);
                        e.preventDefault();
                    }
                    break;
                case 'ArrowRight':
                    if (props.replayTime) {
                        props.setReplayTime((props.replayTime + 60) as Epoch);
                        e.preventDefault();
                    }
                    break; */
                case 'Escape':
                    if (measure && measure.enabled) {
                        measure.toggle?.();
                    }
                    break;
            }
        },
        [measure, props.replayTime]
    );

    useEffect(() => {
        document.addEventListener('keydown', handleKeyPress);
        return () => {
            document.removeEventListener('keydown', handleKeyPress);
        };
    }, [handleKeyPress]);

    // =========== FOLLOW EFFECT ===============
    //
    // We will calculate the nearest point every 60 seconds or when the TP changes or selected pilot changes
    useEffect(
        () => {
            const map = mapRef?.current?.getMap();

            if (
                !map?.isMoving() &&
                !measure.enabled &&
                props.options.follow &&
                follow &&
                selectedPosition && //
                taskGeoJSON?.track?.features
            ) {
                // If we are in track up mode then we will point it towards the next turnpoint
                const lat = Math.round(selectedPosition.lat * 100000) / 100000;
                const lng = Math.round(selectedPosition.lng * 100000) / 100000;

                // Next point - if we haven't started or we have finished use the startline

                // If we are user selected or we don't have a valid next point don't change anything

                const newScreenPoint = mapRef?.current?.getMap().project([lng, lat]);

                // In 2d we need more movement before we adjust the map
                const pointCheck = (a: number, b: number, s: number): boolean => {
                    return Math.abs(a - b) / s > (map2d ? 0.25 : 0.1); //magic numbers are % of screen in either direction
                };

                const screenSizeX = mapRef?.current?.getMap()?.getContainer().offsetWidth ?? 1300;
                const screenSizeY = mapRef?.current?.getMap()?.getContainer().offsetHeight ?? 500;

                const getBearing = (): number => {
                    if (props.options.taskUp == TaskUp.north) {
                        return 0;
                    }
                    if (props.options.taskUp == TaskUp.track) {
                        if (
                            !selectedScore?.inSector && // don't jump around in sector
                            (selectedScore?.legs[selectedScore.currentLeg]?.actual?.distanceRemaining ?? 0) > 3 && // or if we are close &&
                            nextPoint?.length
                        ) {
                            return bearing([lng, lat], nextPoint, {final: false});
                        }
                    } // fall through to no change
                    return props.viewport.bearing;
                };

                const fbearing = Math.round(getBearing());

                if (
                    newScreenPoint &&
                    (pointCheck(newScreenPoint.x, screenPoint.x, screenSizeX) ||
                        pointCheck(newScreenPoint.y, screenPoint.y, screenSizeY) || //
                        fbearing >> 3 != Math.round(props.viewport.bearing) >> 3)
                ) {
                    mapRef?.current?.flyTo({
                        center: [lng, lat],
                        bearing: fbearing
                    });
                }
            }
        },
        follow && props.options.follow //
            ? [selectedCompno, selectedPosition, nextPoint, props.options, isMoving, follow]
            : [null, null, null, null, null, null]
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
        if (options.zoomTask && taskGeoJSONtp && mapRef?.current) {
            try {
                const canvas = mapRef?.current?.getCanvasContainer();
                const rect = canvas?.getBoundingClientRect?.() ?? {width: 0};

                const overlayWidth = Math.max(Math.trunc(rect.width * 0.3), 275);
                const offset = rect.width >= 992 ? {padding: {right: overlayWidth, left: 10, top: 10, bottom: 10}} : {};

                const [minLng, minLat, maxLng, maxLat] = bbox(buffer(taskGeoJSONtp, 15));
                setOptions({...options, zoomTask: false});
                mapRef?.current?.fitBounds(
                    [
                        [minLng, minLat],
                        [maxLng, maxLat]
                    ],
                    {
                        ...offset,
                        pitch: map2d ? 0 : 70,
                        bearing: 0 // north up
                    }
                );
            } catch (e) {
                console.error(e);
            }
        }
    }, [options.zoomTask, taskGeoJSONtp, vc, mapRef.current]);

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
        return map2d ? turnpointStyle2d(selectedScore, mapLight, startOpen) : turnpointStyle3d(selectedScore, mapLight, startOpen);
    }, [selectedCompno, selectedScore?.currentLeg, selectedScore?.utcFinish, mapLight, map2d]);

    // Do we have a loaded set of details?
    const valid = taskGeoJSON?.tp && taskGeoJSON?.track;

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
        (input) => deckTooltip({...input, map: mapRef?.current, lang, tz: props?.tz, units: props?.options?.units}), //
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

    const onClick = useCallback((a, _b) => measure.click(a), [measure.enabled]);

    const pilotLayer = pilotsLayer(selectedCompno, props.setSelectedCompno, props.replayTime ?? latestUpdate);

    // And the turnpoints
    //    const tpLayer = turnpointLayer(taskGeoJSONtp, map2d, mapLight, nextTp);

    // Adjust to satellite or not, style has all layers in it so we just need to change the visibility which is
    // much quicker than changing the style.
    const fixupMap = useCallback(() => {
        try {
            const map = mapRef?.current?.getMap();
            if (map) {
                map.setLayoutProperty('satellite', 'visibility', mapStreet ? 'none' : 'visible');
                map.setLayoutProperty('background', 'visibility', mapStreet ? 'none' : 'visible');
                map.setLayoutProperty('contour-line', 'visibility', mapStreet ? 'none' : 'visible');
            }
        } catch (e) {}
    }, [mapStreet, mapRef?.current]);
    useEffect(fixupMap, [mapStreet, mapRef?.current]);

    // Record if this is a new load or a reload
    useEffect(() => props.setOptions({...props.options, loadId: (props.options.loadId ?? 0) + 1}), []);

    // Cancel any follow
    const onDragStart = useCallback(() => {
        if (follow) {
            setFollow(false);
        }
    }, [setFollow, follow]);

    // If we are on last leg of AAT then we stop showing construction lines
    const lastLeg = task?.rules?.aat && selectedScore?.currentLeg == task?.legs?.length - 1;

    // If we are displaying other pilots
    const otherPilotLayer = otherPilotsLayer(vc, mapLight, map2d, props.options.showOthers ? props.replayTime : (Infinity as Epoch));

    return (
        <ErrorBoundary fallback={<p style={{marginTop: 100}}>Please reload me!</p>}>
            <Map //
                initialViewState={{...props.viewport, ...viewOptions}}
                onMove={onViewStateChange}
                onStyleData={fixupMap}
                mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN}
                cursor={measure.enabled ? 'crosshair' : 'auto'}
                mapStyle={'mapbox://styles/ifly7charlie/clmbzpceq01au01r7abhp42mm'}
                reuseMaps={true}
                ref={mapRef}
                attributionControl={false}
            >
                <DeckGLOverlay
                    getTooltip={toolTip}
                    onClick={onClick}
                    onDragStart={onDragStart}
                    layers={[...pilotTrackLayer, pilotLayer, otherPilotLayer]} //
                    interleaved={true}
                />
                {options.constructionLines && taskGeoJSON?.Dm ? (
                    <Source type="geojson" data={taskGeoJSON.Dm} key="y">
                        <Layer {...DmPointStyle} />
                    </Source>
                ) : null}
                {valid ? (
                    <Source type="geojson" id="task" key="task" data={taskGeoJSONtp}>
                        <Layer {...turnpointStyleFlat} key="tps" />
                        <Layer {...turnpointStyle} key="tgjp" />
                    </Source>
                ) : null}
                {valid ? (
                    <Source type="geojson" data={taskGeoJSON.track}>
                        <Layer {...trackLineStyle} key="tls" />
                    </Source>
                ) : null}
                {selectedScore && options.constructionLines ? (
                    <>
                        {selectedScore.minGeoJSON && !lastLeg ? (
                            <Source type="geojson" data={selectedScore.minGeoJSON} key={'min_'} id={'min'}>
                                <Layer {...distanceLineLabelStyle(minLineStyle)} beforeId={'scored_line'} />
                                <Layer {...minLineStyle} beforeId={'minpossible_label'} />
                            </Source>
                        ) : null}
                        {selectedScore.maxGeoJSON && !lastLeg ? (
                            <Source type="geojson" data={selectedScore.maxGeoJSON} key={'max_'} id={'max'}>
                                <Layer {...distanceLineLabelStyle(maxLineStyle)} beforeId={'scored_line'} />
                                <Layer {...maxLineStyle} beforeId={'maxpossible_label'} />
                            </Source>
                        ) : null}
                        {selectedScore.legs && task?.rules?.aat ? (
                            <Source type="geojson" data={assembleHullLine(selectedScore.legs)} key={'hull_'}>
                                <Layer {...hullLineStyle} />
                                <Layer {...hullPointStyle} />
                            </Source>
                        ) : null}
                    </>
                ) : null}
                {selectedScore?.scoredGeoJSON ? (
                    <Source type="geojson" data={selectedScore.scoredGeoJSON} key={'scored_'} id={'scored'}>
                        <Layer key="scoredLine" {...{...scoredLineStyle, layout: {visibility: 'visible'}}} />
                        <Layer key="distanceLabels" {...distanceLineLabelStyle(scoredLineStyle, true)} />
                    </Source>
                ) : null}
                <MeasureLayers key="measure" />
                <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} />
                {!map2d && <Layer key="skylayer" {...skyLayer} />}
                {attribution}
                {!props.replayTime ? radarOverlay.layer : null}
                <ScaleControl position="bottom-left" />
                <NavigationControl showCompass showZoom visualizePitch position="bottom-left" />
            </Map>
        </ErrorBoundary>
    );
}

// scored track for selected pilot
const scoredLineStyle: LayerProps = {
    id: 'scored_line',
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
const hullPointStyle: LayerProps = {
    id: 'hullPoint',
    type: 'circle',
    paint: {
        'circle-color': '#00f',
        'circle-radius': 4,
        'circle-opacity': 0.3
    }
};
const hullLineStyle: LayerProps = {
    id: 'hullLine',
    type: 'line',
    paint: {
        'line-color': '#00f',
        'line-width': 2,
        'line-opacity': 0.6,
        'line-dasharray': [4, 1]
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

function turnpointStyle3d(selectedPilot: PilotScore | null, mapLight: boolean, startOpen: boolean): LayerProps[] {
    return [
        {
            // Track line
            id: 'track',
            type: 'line',
            paint: {
                'line-color': mapLight ? 'darkgrey' : 'white',
                'line-width': ['case', ['==', !selectedPilot, true], 15, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], 15, 6],
                'line-opacity': 1,
                'line-pattern': !mapLight ? 'oneway-large' : 'oneway-white-large' //the white one is actually orange
            }
        },
        {
            // Turnpoints
            id: 'tp',
            type: 'fill',
            filter: ['case', ['==', !selectedPilot, true], false, ['==', ['get', 'leg'], selectedPilot?.utcStart ? selectedPilot?.currentLeg || 0 : 0], false, true],
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
                    ['==', startOpen, false],
                    'red',
                    ['==', !selectedPilot, true],
                    mapLight ? 'darkgrey' : 'white',
                    ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0], //
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

function turnpointStyle2d(selectedPilot: PilotScore | null, mapLight: boolean, startOpen: boolean): LayerProps[] {
    console.log('tps2d', mapLight);
    return [
        {
            // Track line
            id: 'track',
            type: 'line',
            paint: {
                'line-color': mapLight ? 'black' : 'pink',
                'line-width': ['case', ['==', !selectedPilot, true], 20, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], 20, 10],
                'line-opacity': 1,
                'line-pattern': !mapLight ? 'oneway-large' : 'oneway-white-large' //the white one is actually orange
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
                    mapLight ? 'black' : 'white',
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
