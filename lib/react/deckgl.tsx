'use client';

import {useCallback, useMemo, useRef, useEffect, useState} from 'react';
import {useRouter} from 'next/router';
import {useTranslation} from 'next-i18next/pages';
import {MapboxOverlay, MapboxOverlayProps} from '@deck.gl/mapbox';

import Map, {Source, Layer, useControl, NavigationControl, ScaleControl, MapRef} from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import {Protocol as PMTilesProtocol} from 'pmtiles';

import {buildMapStyle, prefersDarkMode} from './mapStyle';

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
import {selectPilotScore, selectOptimalGrid, selectAllTimes} from '../redux/scoresSlice';
import type {StatSegment} from '../protobuf/onglide';
import {selectPilotPosition, selectLatestUpdate, selectAllPositions} from '../redux/tracksSlice';
import {useSelector} from '../redux';
import {useStore} from 'react-redux';
import type {RootState} from '../redux/store';
import {ErrorBoundary} from 'react-error-boundary';

import {assembleHullLine} from './hullLine';
import {useOptimalGridLayers, OptimalGridSources} from './optimalGridLayers';

function DeckGLOverlay(
    props: MapboxOverlayProps & {
        interleaved?: boolean;
        overlayRef?: React.MutableRefObject<MapboxOverlay | null>;
    }
) {
    const {overlayRef, ...overlayProps} = props;
    const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(overlayProps));
    overlay.setProps(overlayProps);
    // Expose the overlay to the parent so the RAF cursor loop can call
    // overlay.setProps imperatively without going through React render.
    if (overlayRef) overlayRef.current = overlay;
    return null;
}

// For displaying rain radar
import {RadarOverlay} from './rainradar';
import {AttributionInfo} from './attributionInfo';

import {MeasureLayers, useMeasure} from './measure';

import bearing from '@turf/bearing';
import bbox from '@turf/bbox';
import buffer from '@turf/buffer';

import {otherPilotsLayer} from './otherpilotslayer';
import {pilotsLayer} from './pilotslayer';
import {thermalLayer} from './thermalLayer';
import {pilotsTrackLayer, computeTripsFiltering} from './pilotstracklayer';
import {OgnTripsLayer} from './ogntripslayer';
import {homeLocationLayer} from './homeLocationLayer';

import {DISPLAY_CURSOR_LAG_S, DISPLAY_CURSOR_TICK_HZ, DISPLAY_CURSOR_MAX_CATCHUP_S} from '../constants';

const TICK_INTERVAL_MS = 1000 / DISPLAY_CURSOR_TICK_HZ;

// Walks the overlay's current layer array, clones the time-sensitive layers
// with new currentTime / data, leaves the rest as same-reference (deck.gl
// reconciliation early-outs on identical refs). Called from a RAF callback —
// no React reconciliation happens.
function applyCursorAnimation(overlay: MapboxOverlay, state: RootState, liveNow: Epoch, fullPaths: any, selectedCompno: Compno, hoveredCompno: Compno | null) {
    const props = (overlay as any).props;
    const layers = props?.layers;
    if (!Array.isArray(layers) || layers.length === 0) return;

    // selectAllTimes returns an empty object for live mode (t = undefined);
    // pass undefined here for the same reason.
    const startTimes = selectAllTimes(state, undefined);
    let positionsForLabels: any = null;

    const updated = layers.map((layer: any) => {
        if (!layer) return layer;
        if (layer instanceof OgnTripsLayer) {
            const compno = (layer.props as any).compno as Compno;
            const showFull = compno === selectedCompno || compno === hoveredCompno;
            const clipStartAt = (startTimes[compno]?.startUtc ?? Infinity) - 30;
            return layer.clone(computeTripsFiltering(liveNow, clipStartAt, fullPaths, showFull));
        }
        if (layer.id === 'labels') {
            if (!positionsForLabels) positionsForLabels = selectAllPositions(state, liveNow);
            return layer.clone({data: positionsForLabels});
        }
        return layer;
    });
    overlay.setProps({layers: updated});
}
//import {turnpointLayer} from './turnpointlayer';

import {registerMapIcons} from './mapIcons';
import {DmPointStyle, hullLineStyle, hullPointStyle, maxLineStyle, maxSignStyle, minLineStyle, minSignStyle, scoredLineStyle, scoringPointStyle, suggestedLineStyle, turnpointStyle2d, turnpointStyle3d} from './mapLayerStyles';

export default function MApp(props: {
    options: Options;
    setOptions: Function; //
    follow: boolean;
    setFollow: Function;
    vc: ClassName;
    selectedCompno: Compno;
    hoveredCompno?: Compno | null;
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
    const allPilotStats = useSelector((state: RootState) => state.scores.pilotStats as Record<string, StatSegment[]>);
    const latestUpdate = useSelector(selectLatestUpdate);
    const selectedPosition = useSelector((state) => (selectedCompno ? selectPilotPosition(state, selectedCompno, props.replayTime) : undefined));

    const isMoving = mapRef?.current?.isMoving() ?? true;

    // Map display style. MapType.street=0, MapType.satellite=1, so the road
    // basemap is active when options.mapType is falsy. mapLight tracks whether
    // the basemap is light-coloured — true only on the road basemap in light
    // mode, false on satellite and on the dark-mode road basemap — and is
    // consumed by layer style helpers to pick dark-on-light vs light-on-dark
    // variants.
    const map2d = options.map2d;
    const mapStreet = !options.mapType;
    const mapLight = mapStreet && !prefersDarkMode();

    // Rules & legs etc
    const task = useSelector((state) => selectTask(state, vc));

    // Track and Task Overlays
    const taskGeoJSON = useSelector((state) => selectTaskGeoJSON(state, vc, props.selectedHandicap));
    const startOpen = useSelector((state) => selectStartOpen(state, vc));

    // Imperative cursor state. Updated by the RAF effect below (no React
    // re-render); read here at render time so any layer rebuild caused by
    // real data changes starts from the current cursor position.
    const overlayRef = useRef<MapboxOverlay | null>(null);
    const store = useStore<RootState>();
    const liveStateRef = useRef<{display: number; lastWallMs: number; target: number}>({display: 0, lastWallMs: 0, target: 0});

    // Hover changes frequently; read it via a ref so the RAF loop below
    // doesn't restart on every mouseenter/leave.
    const hoveredRef = useRef<Compno | null>(null);
    hoveredRef.current = props.hoveredCompno ?? null;

    // Brief size pulse on first hover. Two React renders (grow → shrink),
    // deck.gl's getSize transition tweens the rendered size smoothly between
    // them. Cleared on hover end.
    const [hoverFlash, setHoverFlash] = useState<{compno: Compno; phase: 'grow' | 'shrink'} | null>(null);
    useEffect(() => {
        const compno = props.hoveredCompno;
        if (!compno) {
            setHoverFlash(null);
            return;
        }
        setHoverFlash({compno, phase: 'grow'});
        const t1 = setTimeout(() => setHoverFlash({compno, phase: 'shrink'}), 220);
        const t2 = setTimeout(() => setHoverFlash(null), 480);
        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
        };
    }, [props.hoveredCompno]);

    // Track latestUpdate (integer-second WebSocket cadence) → shift the
    // RAF target without restarting the loop. First-time bootstrap seeds
    // the display value too so the cursor doesn't jump on the first tick.
    useEffect(() => {
        if (!latestUpdate) return;
        const state = liveStateRef.current;
        state.target = latestUpdate - DISPLAY_CURSOR_LAG_S;
        if (state.display === 0) {
            state.display = state.target;
            state.lastWallMs = performance.now();
        }
    }, [latestUpdate]);

    // Imperative RAF loop. Throttled to TICK_INTERVAL_MS, advances the cursor
    // at wall-clock rate (capped to target), then clones only the time-sensitive
    // layers and calls overlay.setProps directly — no React render, no full
    // layer-array diff.
    useEffect(() => {
        if (props.replayTime) return; // replay drives currentTime exactly; no RAF needed
        let raf = 0;
        let lastTickMs = 0;
        const loop = () => {
            if (!document.hidden && overlayRef.current) {
                const wallNow = performance.now();
                if (wallNow - lastTickMs >= TICK_INTERVAL_MS) {
                    lastTickMs = wallNow;
                    const state = liveStateRef.current;
                    if (state.target) {
                        const dt = (wallNow - state.lastWallMs) / 1000;
                        state.lastWallMs = wallNow;
                        let next = state.display + dt;
                        if (next > state.target) next = state.target;
                        if (state.target - next > DISPLAY_CURSOR_MAX_CATCHUP_S) next = state.target;
                        state.display = next;
                        applyCursorAnimation(overlayRef.current, store.getState(), next as Epoch, options.fullPaths, selectedCompno, hoveredRef.current);
                    }
                }
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);

        const onVisibility = () => {
            if (!document.hidden) liveStateRef.current.lastWallMs = performance.now();
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            cancelAnimationFrame(raf);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [props.replayTime, options.fullPaths, selectedCompno, store]);

    // Initial cursor value for React-driven layer creation. The RAF loop
    // overrides this within ~100ms; this just avoids a one-frame stale flash.
    const liveNow = (liveStateRef.current.display || latestUpdate - DISPLAY_CURSOR_LAG_S) as Epoch;

    const pilotTrackLayer = pilotsTrackLayer(props, liveNow, options.sortKey, map2d, mapLight, options.fullPaths, props.hoveredCompno ?? null);

    // Rain Radar
    const router = useRouter();
    const {t, i18n} = useTranslation('common');

    // Unmount the deck overlay around any route change. The deck.gl
    // MapboxOverlay/MapLibre teardown is racy: when the route changes (e.g.
    // back to the globe landing page) MapLibre can finalize a frame after
    // the deck instance has been disposed, dereferencing a null viewport
    // (`TypeError: null is not an object (evaluating 'viewport.id')`).
    // Flipping this flag on `routeChangeStart` lets React commit the overlay
    // unmount — which calls `MapboxOverlay.onRemove` and deregisters the
    // deck custom layer from the painter — before MapLibre itself is torn
    // down by the page unmount.
    //
    // For routes that keep this component mounted (e.g. switching class
    // within the same competition) we reset the flag on routeChangeComplete
    // so the overlay re-mounts with the new data.
    const [unmounting, setUnmounting] = useState(false);
    useEffect(() => {
        const onStart = () => setUnmounting(true);
        const onSettled = () => setUnmounting(false);
        router.events.on('routeChangeStart', onStart);
        router.events.on('routeChangeComplete', onSettled);
        router.events.on('routeChangeError', onSettled);
        return () => {
            router.events.off('routeChangeStart', onStart);
            router.events.off('routeChangeComplete', onSettled);
            router.events.off('routeChangeError', onSettled);
        };
    }, [router]);

    const lang = i18n.language;
    const radarOverlay = RadarOverlay({options, tz});

    // What task are we using on display
    const taskGeoJSONtp = taskGeoJSON?.tp;

    // Get coordinates on the screen for center point of view
    const screenPoint = useMemo(() => mapRef?.current?.getMap().project([props.viewport.longitude, props.viewport.latitude]) ?? {x: 0, y: 0}, [props.viewport]);

    const legAdvance = task && task.rules.aat && selectedScore?.inSector && selectedScore.legs[selectedScore.currentLeg + 1]?.actual.distance > 10;

    const nextPoint = (() => {
        if (!task || !selectedScore) return null;
        const leg = !selectedScore?.utcStart ? task.legs[0] : selectedScore?.utcFinish || selectedScore.minDistancePoints.length < 6 ? task.legs.at(-1) : task.legs.at(selectedScore?.currentLeg + (legAdvance ? 1 : 0));
        return leg ? ([leg.nlng, leg.nlat] as [number, number]) : undefined;
    })();

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

    // ====== DIAGNOSTIC: catch the FIRST throw on the render path ======
    // The "Attempting to run(), but is already running." error we keep seeing
    // is a cascade — it fires when MapLibre's _renderTaskQueue.run() finds
    // _currentlyRunning still truthy from a previous run where a queued
    // callback threw and skipped the cleanup. The thrown error usually gets
    // logged inside an rAF boundary and is easy to miss.
    //
    // This wraps run() to log the offending callback explicitly, reset the
    // queue state so the cascade stops, and re-throw. It also wraps map.fire
    // to surface listener throws that corrupt the parallel _inRender flag via
    // react-map-gl's _onBeforeRepaint deferred-event fan-out. Remove once the
    // root cause is identified.
    useEffect(() => {
        const map = mapRef?.current?.getMap() as any;
        if (!map) return;
        const queue = map._renderTaskQueue;
        if (queue && !queue.__onglideDiagInstalled) {
            queue.__onglideDiagInstalled = true;
            const origRun = queue.run.bind(queue);
            queue.run = function patchedRun(e: number) {
                try {
                    return origRun(e);
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('[maplibre-diag] _renderTaskQueue.run threw — a queued callback failed before the queue reset', {
                        err,
                        message: (err as Error)?.message,
                        stack: (err as Error)?.stack,
                        currentlyRunning: this._currentlyRunning,
                        cleared: this._cleared
                    });
                    this._currentlyRunning = false;
                    this._cleared = false;
                    throw err;
                }
            };
        }
        if (!map.__onglideFireDiagInstalled) {
            map.__onglideFireDiagInstalled = true;
            const origFire = map.fire.bind(map);
            map.fire = function patchedFire(eventOrName: any, ...rest: any[]) {
                try {
                    return origFire(eventOrName, ...rest);
                } catch (err) {
                    const name = typeof eventOrName === 'string' ? eventOrName : eventOrName?.type;
                    // eslint-disable-next-line no-console
                    console.error('[maplibre-diag] map.fire listener threw', {
                        event: name,
                        err,
                        message: (err as Error)?.message,
                        stack: (err as Error)?.stack
                    });
                    throw err;
                }
            };
        }
    }, [mapRef.current]);

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

    // Disable the 3D terrain drape pass while in 2D mode. The style keeps the
    // `terrain` source defined so the `hillshade` layer can still sample it,
    // but `setTerrain(null)` removes the draped-layer render path — which
    // otherwise runs `_renderTileClippingMasks` twice per paint and keeps
    // MapLibre re-arming its own RAF as DEM tiles arrive into the drape FBO.
    useEffect(() => {
        const map = mapRef?.current?.getMap();
        if (!map) return;
        const apply = () => {
            if (map2d) {
                if (map.getTerrain()) map.setTerrain(null);
            } else {
                if (!map.getTerrain()) map.setTerrain({source: 'terrain', exaggeration: 1});
            }
        };
        if (map.isStyleLoaded()) apply();
        else map.once('style.load', apply);
    }, [map2d, mapRef?.current]);

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

    // ===== ZOOM TO TURNPOINT EFFECT =====
    // Triggered when the user clicks a row in the task leg list. We build a
    // bbox around the sector (radius in km converted to degrees, accounting
    // for latitude on the longitude axis) and let cameraForBounds pick a
    // zoom — that way a 20km AAT area frames just like a 0.5km cylinder.
    useEffect(() => {
        if (!options.zoomTurnpoint || !mapRef?.current) return;
        const {lat, lng, radius} = options.zoomTurnpoint;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            setOptions({...options, zoomTurnpoint: null});
            return;
        }
        try {
            const map = mapRef.current.getMap();
            const r = Math.max(0.3, radius || 0.3); // km — minimum so a tiny line still has a frame
            const dLat = r / 111;
            const dLng = r / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
            const padding = {top: 40, bottom: 40, left: 40, right: 40};
            const camera = map.cameraForBounds(
                [
                    [lng - dLng, lat - dLat],
                    [lng + dLng, lat + dLat]
                ],
                {padding, bearing: 0}
            );
            if (follow) setFollow(false);
            setOptions({...options, zoomTurnpoint: null});
            if (camera) {
                map.easeTo({
                    center: camera.center,
                    zoom: camera.zoom,
                    pitch: map2d ? 0 : 60,
                    bearing: 0,
                    duration: 800
                });
            }
        } catch (e) {
            console.error(e);
            setOptions({...options, zoomTurnpoint: null});
        }
    }, [options.zoomTurnpoint, mapRef.current]);

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
    // airports). Registered via the Map's onLoad below — running it via a
    // post-paint useEffect was too late and produced "Image 'airport' could
    // not be loaded" warnings as the airport symbol layer painted first.
    const onMapLoad = useCallback((e: any) => {
        const map = e.target;
        if (!map) return;
        registerMapIcons(map);
    }, []);

    // MapLibre fires a bare `error` event for tile/sprite/glyph/image
    // failures — react-map-gl's default handler just console.errors the
    // Error, so "Failed to Decode Data." arrives with no clue which
    // resource failed. Pull the source/tile context off the ErrorEvent so
    // the failing URL is identifiable.
    const onMapError = useCallback((e: any) => {
        const err: Error | undefined = e?.error;
        const tileID = e?.tile?.tileID?.canonical;
        const source = e?.source ?? (e?.sourceId && mapRef?.current?.getMap?.()?.getSource?.(e.sourceId));
        // eslint-disable-next-line no-console
        console.error('[maplibre-error]', err?.message ?? 'unknown map error', {
            message: err?.message,
            sourceId: e?.sourceId,
            sourceType: source?.type,
            // raster/image sources expose `url`/`tiles`; the failing image
            // resource is usually one of these.
            url: (err as any)?.url ?? source?.url,
            tiles: source?.tiles,
            tile: tileID ? `${tileID.z}/${tileID.x}/${tileID.y}` : undefined,
            status: (err as any)?.status,
            error: err
        });
    }, []);

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
        (input) => deckTooltip({...input, map: mapRef?.current, pilotStats: allPilotStats, lang, tz: props?.tz, units: props?.options?.units, modifierHeld: modifierRef.current, t}), //
        [vc, props.options.units, props.tz, mapRef?.current, allPilotStats, t, lang]
    );

    const attribution = useMemo(() => <AttributionInfo customParts={[radarOverlay.attribution, props.status]} />, [radarOverlay.key, radarOverlay.attribution, props.status]);

    // Initial options depending on if we are on 2d or 3d
    const viewOptions = map2d ? {minPitch: 0, maxPitch: 80, pitch: 0} : {minPitch: 0, maxPitch: 80, pitch: 70};

    // We keep our saved viewstate up to date in case of re-render
    const onViewStateChange = useCallback(({viewState}) => {
        props.setViewport(viewState);
    }, []);

    const onClick = useCallback((a, _b) => measure.click(a), [measure.enabled]);

    const pilotLayer = pilotsLayer(selectedCompno, props.hoveredCompno ?? null, hoverFlash, props.setSelectedCompno, props.replayTime ?? liveNow);

    // Thermal-strength spirals for the selected/hovered glider (incl. the
    // in-progress thermal). Driven by the same time-indexed pilotStats store
    // as the tooltip, so it follows the replay cursor for free.
    const thermals = thermalLayer(selectedCompno, props.hoveredCompno ?? null, props.replayTime ?? liveNow, props.replayTime);

    // And the turnpoints
    //    const tpLayer = turnpointLayer(taskGeoJSONtp, map2d, mapLight, nextTp);

    // Adjust to satellite or not. Style has all layers in it; we just toggle visibility
    // (much quicker than swapping styles). Vector base layers (fills/lines from the
    // openmaptiles source) are hidden on satellite to prevent a flicker where streets
    // briefly render before the raster arrives. Symbol layers (labels) stay visible
    // in both modes. contour-line is the exception — it's an overlay shown only on
    // satellite, hidden in street mode.
    useEffect(() => {
        try {
            const map = mapRef?.current?.getMap();
            if (!map) return;
            const style = map.getStyle();
            if (!style?.layers) return;
            for (const layer of style.layers) {
                if (layer.id === 'contour-line') {
                    map.setLayoutProperty(layer.id, 'visibility', mapStreet ? 'none' : 'visible');
                } else if (layer.id.startsWith('landmark-power-line')) {
                    // Power lines clutter satellite imagery — street basemap only.
                    map.setLayoutProperty(layer.id, 'visibility', mapStreet ? 'visible' : 'none');
                } else if ((layer as any).source === 'openmaptiles' && layer.type !== 'symbol') {
                    map.setLayoutProperty(layer.id, 'visibility', mapStreet ? 'visible' : 'none');
                }
            }
            map.setLayoutProperty('satellite', 'visibility', mapStreet ? 'none' : 'visible');
        } catch (e) {}
    }, [mapStreet, mapRef?.current]);

    // Record if this is a new load or a reload
    useEffect(() => {
        props.setOptions({...props.options, loadId: (props.options.loadId ?? 0) + 1});
    }, []);

    // Cancel any follow
    const onDragStart = useCallback(() => {
        if (follow) {
            setFollow(false);
        }
    }, [setFollow, follow]);

    // Competition site coordinates for the X marker. CompetitionSummary
    // exposes lat/lng at the top level (see summaryToCompetition / protobuf),
    // not nested under .competition. (0,0) is the protobuf default for
    // unset, so treat that as no-location too.
    const homeLat = props.comp?.lat;
    const homeLng = props.comp?.lng;
    const hasHome = typeof homeLat === 'number' && typeof homeLng === 'number' && Number.isFinite(homeLat) && Number.isFinite(homeLng) && (homeLat !== 0 || homeLng !== 0);
    useEffect(() => {
        if (props.comp && !hasHome) {
            console.warn('[homeLocation] competition has no usable lat/lng — X marker hidden', {
                name: props.comp?.name,
                compid: props.comp?.compid,
                lat: homeLat,
                lng: homeLng
            });
        }
    }, [props.comp, hasHome, homeLat, homeLng]);

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
    const classnameByClass = useMemo(() => {
        const m: Record<string, string> = {};
        for (const c of props.comp?.classes ?? []) m[c.class] = c.classname;
        return m as Record<ClassName, string>;
    }, [props.comp]);
    const otherPilotLayer = otherPilotsLayer(vc, mapLight, map2d, props.options.showOthers ? props.replayTime : (Infinity as Epoch), classnameByClass);

    // X-marker at the competition's site (competition.lt/lg). Hidden when
    // zoomed out so it doesn't clutter the regional view — by zoom 8 the
    // airfield itself is visible on the basemap, so the marker only adds
    // value when the user has zoomed in to look at the site.
    const HOME_MARKER_MIN_ZOOM = 8;
    const homeMarker = (props.viewport?.zoom ?? 0) >= HOME_MARKER_MIN_ZOOM && hasHome ? homeLocationLayer(homeLat, homeLng) : null;

    return (
        <ErrorBoundary fallback={<p style={{marginTop: 100}}>Please reload me!</p>}>
            <Map //
                initialViewState={{...props.viewport, ...viewOptions}}
                onMove={onViewStateChange}
                onLoad={onMapLoad}
                onError={onMapError}
                cursor={measure.enabled ? 'crosshair' : 'auto'}
                mapStyle={ONGLIDE_MAP_STYLE}
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
                <DeckGLOverlay
                    getTooltip={toolTip}
                    onClick={onClick}
                    onDragStart={onDragStart}
                    layers={valid && !unmounting ? ([...pilotTrackLayer, thermals, pilotLayer, otherPilotLayer, homeMarker].filter(Boolean) as any[]) : []} //
                    interleaved={false}
                    overlayRef={overlayRef}
                />
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
