'use client';

import {useCallback, useMemo, useRef, useEffect, useState} from 'react';
import {MapboxOverlay, MapboxOverlayProps} from '@deck.gl/mapbox';

import Map, {Source, Layer, useControl, NavigationControl, ScaleControl, MapRef} from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import {Protocol as PMTilesProtocol} from 'pmtiles';

import {buildMapStyle} from './mapStyle';

// Register the pmtiles:// protocol once, client-side only
if (typeof window !== 'undefined' && !(maplibregl as any).__onglidePmtilesRegistered) {
    maplibregl.addProtocol('pmtiles', new PMTilesProtocol().tile);
    (maplibregl as any).__onglidePmtilesRegistered = true;
}

const ONGLIDE_MAP_STYLE = buildMapStyle();

import {deckTooltip} from './decktooltip';

import type {Epoch, ClassName, Compno, Options, TZ} from '../types';
import {TaskUp} from '../types';

import {distanceLineLabelStyle} from './distanceLine';

import {selectTaskGeoJSON, selectTask, selectStartOpen} from '../redux/taskSlice';
import {selectPilotScore, selectAllScores, selectOptimalGrid} from '../redux/scoresSlice';
import {selectPilotPosition, selectLatestUpdate} from '../redux/tracksSlice';
import {useSelector} from '../redux';
import {ErrorBoundary} from 'react-error-boundary';

import {assembleHullLine} from './hullLine';
import {useOptimalGridLayers, OptimalGridSources} from './optimalGridLayers';

function DeckGLOverlay(
    props: MapboxOverlayProps & {
        interleaved?: boolean;
    }
) {
    const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
    overlay.setProps(props);
    return null;
}

// For displaying rain radar
import {AttributionControl} from 'react-map-gl/maplibre';
import {RadarOverlay} from './rainradar';

import {MeasureLayers, useMeasure} from './measure';

import bearing from '@turf/bearing';
import bbox from '@turf/bbox';
import buffer from '@turf/buffer';

import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep} from 'lodash';

import {otherPilotsLayer} from './otherpilotslayer';
import {pilotsLayer} from './pilotslayer';
import {pilotsTrackLayer} from './pilotstracklayer';
import {homeLocationLayer} from './homeLocationLayer';
//import {turnpointLayer} from './turnpointlayer';

import {registerMapIcons} from './mapIcons';
import {
    DmPointStyle,
    hullLineStyle,
    hullPointStyle,
    maxLineStyle,
    maxSignStyle,
    minLineStyle,
    minSignStyle,
    scoredLineStyle,
    scoringPointStyle,
    suggestedLineStyle,
    turnpointStyle2d,
    turnpointStyle3d
} from './mapLayerStyles';

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
    comp?: any;
}) {
    // For remote updating of the map
    const mapRef = useRef<MapRef | null>(null);
    const measure = useMeasure();

    // So we get some type info
    const {options, setOptions, follow, setFollow, vc, selectedCompno, tz, viewport} = props;

    // Score details for selected pilot
    const selectedScore = useSelector((state) => selectPilotScore(state, selectedCompno, props.replayTime));
    const optimalGrid = useSelector((state) => selectOptimalGrid(state, selectedCompno, props.replayTime));
    const pilotScores = useSelector((state) => selectAllScores(state, props.replayTime));
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
                    mapRef?.current?.easeTo({
                        center: [lng, lat],
                        bearing: fbearing,
                        duration: 600
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

    // Kill pan inertia — MapLibre's glide after drag release reprojects against
    // the terrain mesh each frame, producing a visible "jump back and forwards"
    // shift when terrain is enabled. `maxSpeed: 0` is how maplibre-gl v4 disables
    // the inertia glide (the boolean `inertia` option from mapbox-gl was removed).
    useEffect(() => {
        const map = mapRef?.current?.getMap();
        if (!map) return;
        map.dragPan.enable({maxSpeed: 0});
    }, [mapRef?.current]);

    // ======= ZOOM TO TASK EFFECT =========
    // If we are supposed to zoom then do this and turn off the flag
    useEffect(() => {
        if (options.zoomTask && taskGeoJSONtp && mapRef?.current) {
            try {
                const map = mapRef.current.getMap();
                // The sidebar UI is rendered outside the map container via CSS
                // (.resizingMap { right: 390px }) — fitBounds should only pad for
                // visual breathing room, not account for the sidebar again.
                const padding = {top: 20, bottom: 20, left: 20, right: 20};

                const [minLng, minLat, maxLng, maxLat] = bbox(buffer(taskGeoJSONtp, 5));
                setOptions({...options, zoomTask: false});

                const camera = map.cameraForBounds(
                    [
                        [minLng, minLat],
                        [maxLng, maxLat]
                    ],
                    {padding, bearing: 0}
                );
                if (camera) {
                    map.easeTo({
                        center: camera.center,
                        zoom: camera.zoom,
                        pitch: map2d ? 0 : 70,
                        bearing: 0,
                        duration: 1000
                    });
                }
            } catch (e) {
                console.error(e);
            }
        }
    }, [options.zoomTask, taskGeoJSONtp, vc, mapRef.current]);

    // ====== LOCK NORTH UP ===========
    // If we are north up then reset north on bearing change.
    // Debounced + larger dead-zone so MapLibre's 3D terrain-aware pan, which can
    // introduce sub-degree bearing drift, doesn't repeatedly trigger a 250ms
    // resetNorth animation that shows up as a pan-release stutter.
    useEffect(() => {
        if (options.taskUp !== 0) return;
        const timer = setTimeout(() => {
            const map = mapRef?.current;
            if (!map || map.isMoving()) return;
            const bearing = map.getBearing();
            if (Math.abs(bearing) > 5) {
                map.resetNorth({duration: 250});
            }
        }, 150);
        return () => clearTimeout(timer);
    }, [options.taskUp === 0 ? viewport.bearing : 0, isMoving]);

    // Runtime-generated icon images for map symbols (track arrows, peaks,
    // airports). Registered once per map instance; MapLibre preserves them
    // across style mutations unless you call setStyle, which we don't.
    useEffect(() => {
        const map = mapRef?.current?.getMap();
        if (!map) return;
        registerMapIcons(map);
    }, [mapRef.current]);

    //
    // Colour and style the task based on the selected pilot and their destination
    const [trackLineStyle, turnpointStyleFlat, turnpointStyle] = useMemo(() => {
        return map2d ? turnpointStyle2d(selectedScore, mapLight, startOpen) : turnpointStyle3d(selectedScore, mapLight, startOpen);
    }, [selectedCompno, selectedScore?.currentLeg, selectedScore?.utcFinish, mapLight, map2d]);

    // Do we have a loaded set of details?
    const valid = taskGeoJSON?.tp && taskGeoJSON?.track;

    //
    // Track modifier keys for dev tooltip
    const modifierRef = useRef(false);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            modifierRef.current = e.shiftKey || e.ctrlKey || e.metaKey;
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('keyup', onKey);
        };
    }, []);

    // Link up to a tooltip
    const toolTip = useCallback(
        (input) => deckTooltip({...input, map: mapRef?.current, pilotScores, lang, tz: props?.tz, units: props?.options?.units, modifierHeld: modifierRef.current}), //
        [vc, props.options.units, props.tz, mapRef?.current, pilotScores]
    );

    const attribution = useMemo(
        () => (
            <AttributionControl //
                key={radarOverlay.key + (props.status?.replaceAll(/[^0-9]/g, '') || 'no')}
                customAttribution={[radarOverlay.attribution, props.status].filter(Boolean).join(' | ')}
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

    // Adjust to satellite or not. Style has all layers in it; we just toggle visibility
    // (much quicker than swapping styles). Vector base layers (fills/lines from the
    // openmaptiles source) are hidden on satellite to prevent a flicker where streets
    // briefly render before the raster arrives. Symbol layers (labels) stay visible
    // in both modes. contour-line is the exception — it's an overlay shown only on
    // satellite, hidden in street mode.
    const fixupMap = useCallback(() => {
        try {
            const map = mapRef?.current?.getMap();
            if (!map) return;
            const style = map.getStyle();
            if (!style?.layers) return;
            for (const layer of style.layers) {
                if (layer.id === 'contour-line') {
                    map.setLayoutProperty(layer.id, 'visibility', mapStreet ? 'none' : 'visible');
                } else if ((layer as any).source === 'openmaptiles' && layer.type !== 'symbol') {
                    map.setLayoutProperty(layer.id, 'visibility', mapStreet ? 'visible' : 'none');
                }
            }
            map.setLayoutProperty('satellite', 'visibility', mapStreet ? 'none' : 'visible');
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

    // Debounce the selected score for Mapbox source updates to avoid worker queue buildup
    // when scrubbing the replay slider. Position/scores update instantly via Redux; only
    // the GeoJSON line layers are debounced.
    const [debouncedScore, setDebouncedScore] = useState(selectedScore);
    const debounceTimer = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => setDebouncedScore(selectedScore), 60);
        return () => clearTimeout(debounceTimer.current);
    }, [selectedScore?.t, selectedScore?.currentLeg]);

    // If we are on last leg of AAT then we stop showing construction lines
    const lastLeg = task?.rules?.aat && debouncedScore?.currentLeg == task?.legs?.length - 1;

    const {optimalDirectionGeoJSON, baselineGeoJSON, hoverGeoJSON, onGridHover, onGridLeave, gridHoverEnabled} = useOptimalGridLayers({
        optimalGrid,
        debouncedScore,
        selectedPosition,
        taskGeoJSONtp,
        lastLeg,
        constructionLines: options.constructionLines,
        aat: task?.rules?.aat
    });

    // Stable array ref for interactiveLayerIds — otherwise a new literal each render
    // makes react-map-gl re-register hit testing on the Map every render.
    const gridInteractiveLayerIds = useMemo(() => (gridHoverEnabled ? ['optimal_heatmap'] : undefined), [gridHoverEnabled]);

    // If we are displaying other pilots
    const otherPilotLayer = otherPilotsLayer(vc, mapLight, map2d, props.options.showOthers ? props.replayTime : (Infinity as Epoch));

    // X-marker at the competition's site (competition.lt/lg). Hidden when
    // zoomed out so it doesn't clutter the regional view — by zoom 8 the
    // airfield itself is visible on the basemap, so the marker only adds
    // value when the user has zoomed in to look at the site.
    const HOME_MARKER_MIN_ZOOM = 8;
    const homeMarker = (props.viewport?.zoom ?? 0) >= HOME_MARKER_MIN_ZOOM ? homeLocationLayer(props.comp?.competition?.lt, props.comp?.competition?.lg) : null;

    return (
        <ErrorBoundary fallback={<p style={{marginTop: 100}}>Please reload me!</p>}>
            <Map //
                initialViewState={{...props.viewport, ...viewOptions}}
                onMove={onViewStateChange}
                onStyleData={fixupMap}
                cursor={measure.enabled ? 'crosshair' : 'auto'}
                mapStyle={ONGLIDE_MAP_STYLE}
                reuseMaps={true}
                ref={mapRef}
                attributionControl={false}
                interactiveLayerIds={gridInteractiveLayerIds}
                onMouseMove={gridHoverEnabled ? onGridHover : undefined}
                onMouseLeave={gridHoverEnabled ? onGridLeave : undefined}
            >
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
                {debouncedScore?.scoredGeoJSON ? (
                    <Source type="geojson" data={debouncedScore.scoredGeoJSON} key={'scored_'} id={'scored'}>
                        <Layer key="scoredLine" {...{...scoredLineStyle, layout: {visibility: 'visible'}}} />
                        <Layer key="distanceLabels" {...distanceLineLabelStyle(scoredLineStyle, true)} />
                        <Layer key="scoringPoint" {...scoringPointStyle} />
                    </Source>
                ) : null}
                {valid ? (
                    <DeckGLOverlay
                        getTooltip={toolTip}
                        onClick={onClick}
                        onDragStart={onDragStart}
                        layers={[...pilotTrackLayer, pilotLayer, otherPilotLayer, homeMarker].filter(Boolean) as any[]} //
                        interleaved={true}
                    />
                ) : null}
                {debouncedScore && options.constructionLines && debouncedScore.scoredGeoJSON ? (
                    <>
                        {debouncedScore.minGeoJSON && !lastLeg ? (
                            <Source type="geojson" data={debouncedScore.minGeoJSON} key={'min_'} id={'min'}>
                                <Layer {...distanceLineLabelStyle(minLineStyle)} beforeId={'scored_line'} />
                                <Layer {...minSignStyle} beforeId={'minpossible_label'} />
                                <Layer {...minLineStyle} beforeId={'min_sign'} />
                            </Source>
                        ) : null}
                        {debouncedScore.maxGeoJSON && !lastLeg ? (
                            <Source type="geojson" data={debouncedScore.maxGeoJSON} key={'max_'} id={'max'}>
                                <Layer {...distanceLineLabelStyle(maxLineStyle)} beforeId={'scored_line'} />
                                <Layer {...maxSignStyle} beforeId={'maxpossible_label'} />
                                <Layer {...maxLineStyle} beforeId={'max_sign'} />
                            </Source>
                        ) : null}
                        {debouncedScore.legs && task?.rules?.aat ? (
                            <Source type="geojson" data={assembleHullLine(debouncedScore.legs)} key={'hull_'}>
                                <Layer {...hullLineStyle} />
                                <Layer {...hullPointStyle} />
                            </Source>
                        ) : null}
                        {debouncedScore.suggestedGeoJSON && !lastLeg ? (
                            <Source type="geojson" data={debouncedScore.suggestedGeoJSON} key={'suggested_'} id={'suggested'}>
                                <Layer {...suggestedLineStyle} />
                                <Layer {...distanceLineLabelStyle(suggestedLineStyle)} />
                            </Source>
                        ) : null}
                        <OptimalGridSources optimalDirectionGeoJSON={optimalDirectionGeoJSON} baselineGeoJSON={baselineGeoJSON} hoverGeoJSON={hoverGeoJSON} />
                    </>
                ) : null}
                <MeasureLayers key="measure" />
                {attribution}
                {!props.replayTime ? radarOverlay.layer : null}
                <ScaleControl position="bottom-left" />
                <NavigationControl showCompass showZoom visualizePitch position="bottom-left" />
            </Map>
        </ErrorBoundary>
    );
}

const attributionStyle = {
    right: 0,
    bottom: 0,
    fontSize: '13px'
};
