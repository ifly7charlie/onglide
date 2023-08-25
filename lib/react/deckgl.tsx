import {useCallback, useMemo, useEffect} from 'react';
import DeckGL from '@deck.gl/react';
import {TextLayer} from '@deck.gl/layers';
import {TripsLayer} from '@deck.gl/geo-layers';
import {FlyToInterpolator, TRANSITION_EVENTS, WebMercatorViewport} from '@deck.gl/core';
import {StaticMap, Source, Layer, LayerProps} from 'react-map-gl';

import {useTaskGeoJSON} from './loaders';

import {offlineTime, recentTrackLength} from '../constants';

// Height/Climb helpers
import {displayHeight, displayClimb} from './displayunits';

import {Epoch, ClassName, Compno, TrackData, ScoreData, SelectedPilotDetails, PilotScore} from '../types';

import {distanceLineLabelStyle} from './distanceLine';

// Figure out where the sun should be
import SunCalc from 'suncalc';

// For displaying rain radar
import {AttributionControl} from 'react-map-gl';
import {RadarOverlay} from './rainradar';

import {UseMeasure, measureClick, isMeasuring, MeasureLayers} from './measure';

import {point} from '@turf/helpers';
import bearing from '@turf/bearing';
import bbox from '@turf/bbox';
import distance from '@turf/distance';

import {map as _map, reduce as _reduce, find as _find, cloneDeep as _cloneDeep} from 'lodash';

// Figure out the baseline date
const oneYearIsh = 1000 * 3600 * 24 * 365;
const referenceDate = new Date(Date.now() - (Date.now() % oneYearIsh)).getTime() / 1000;
console.log(referenceDate);

// Import our layer override so we can distinguish which point on a
// line has been clicked or hovered
import {StopFollowController} from './deckglcontroller';
// helps with touch scroll on laptops (undocumented)
const controller: {type: any; setFollow?: Function; inertia: true; transitionDuration: 0} = {type: StopFollowController, inertia: true, transitionDuration: 0};
//
// Responsible for generating the deckGL layers
//
function makeLayers(props: {trackData: TrackData; selectedCompno: Compno; setSelectedCompno: Function; t: Epoch}, taskGeoJSON, map2d, mapLight: boolean, fullPaths: boolean) {
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
            if (!p || !p.getData) {
                console.log(`deck missing from ${compno}`, track);
                return result;
            }

            // For all but selected gliders just show most recent track
            const tripsFiltering = {
                currentTime: props.t - referenceDate,
                fadeTrail: !fullPaths && !selected,
                trailLength: recentTrackLength
            };

            const color = selected ? [255, 0, 255, 192] : mapLight ? [0, 0, 0, 127] : [224, 224, 224, 224];

            result.push(
                new TripsLayer({
                    id: compno, //  + (map2d ? '2d' : '3d'),
                    compno: compno,
                    data: p.getData,
                    getWidth: 5,
                    getPath: (d) => d.p,
                    getTimestamps: (d) => d.t - referenceDate,
                    positionFormat: 'XYZ', //map2d ? 'XY' : 'XYZ',
                    getColor: color,
                    jointRounded: true,
                    fp64: false,
                    widthMinPixels: 2,
                    billboard: map2d ? false : true,
                    onClick: (i) => {
                        props.setSelectedCompno(compno);
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
            coordinates: p.positions.subarray((p.posIndex - 1) * 3, p.posIndex * 3)
        };
    });

    if (data.length) {
        layers.push(
            new TextLayer({
                id: 'labels' + (map2d ? '2d' : '3d'),
                data: data,
                getPosition: (d) => d.coordinates, // map2d ? (d) => [...d.coordinates.slice(0, 2), props.selectedCompno == d.name ? 200 : d.alt / 50] : (d) => d.coordinates,
                getText: (d) => d.name,
                getColor: (d) => (props.t - d.t > offlineTime ? [100, 80, 80, 96] : [0, 100, 0, 255]),
                getTextAnchor: 'middle',
                getSize: (d) => (d.name == props.selectedCompno ? 20 : 16),
                pickage: true,
                background: true,
                fontSettings: {sdf: true},
                backgroundPadding: [2, 1, 2, 0],
                onClick: (i) => {
                    props.setSelectedCompno(i.object?.name || '');
                },
                transitions: {
                    //                    getPosition: 2000
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
    pilots: any;
    pilotScores: ScoreData;
    selectedPilotData: SelectedPilotDetails | null;
    follow: boolean;
    setFollow: Function;
    vc: ClassName;
    selectedCompno: Compno;
    setSelectedCompno: Function;
    mapRef: any;
    tz: string;
    viewport: any;
    setViewport: Function;
    trackData: TrackData;
    measureFeatures: UseMeasure;
    status: string; // status line
    t: Epoch;
}) {
    // So we get some type info
    const {options, setOptions, pilots, pilotScores, selectedPilotData, follow, setFollow, vc, selectedCompno, mapRef, tz, viewport, setViewport} = props;

    // Map display style
    const map2d = options.mapType > 1;
    const mapStreet = !!(options.mapType % 2);
    const mapLight = !!mapStreet;

    // Track and Task Overlays
    const {taskGeoJSON, isTLoading, isTError}: {taskGeoJSON: any; isTError: boolean; isTLoading: boolean} = useTaskGeoJSON(vc);
    const layers = makeLayers(props, taskGeoJSON, map2d, mapStreet, options.fullPaths);

    // Rain Radar
    const lang = useMemo(() => (navigator.languages != undefined ? navigator.languages[0] : navigator.language), []);
    const radarOverlay = RadarOverlay({options, setOptions, tz});

    // What task are we using on display
    const taskGeoJSONtp = selectedPilotData?.score?.taskGeoJSON || taskGeoJSON?.tp;

    // We will calculate the nearest point every 60 seconds or when the TP changes or selected pilot changes
    useEffect(
        () => {
            if (
                props.options.follow &&
                follow &&
                selectedPilotData &&
                selectedPilotData.track?.vario?.lat && //
                selectedPilotData.score?.currentLeg !== undefined &&
                taskGeoJSON?.tp?.features
            ) {
                // If we are in track up mode then we will point it towards the next turnpoint
                const lat = Math.round(selectedPilotData.track.vario.lat * 100) / 100;
                const lng = Math.round(selectedPilotData.track.vario.lng * 100) / 100;

                let fbearing = props.options.taskUp == 2 ? props.viewport.bearing : 0;
                const npol =
                    selectedPilotData.score.minDistancePoints.length > 6 // make sure we have next point or use first tp
                        ? selectedPilotData.score.minDistancePoints.slice(4, 6)
                        : taskGeoJSON?.track?.features?.[0]?.geometry?.coordinates?.[1];
                let position = props.viewport?.position;
                if (props.options.taskUp == 1) {
                    fbearing = bearing([lng, lat], npol);
                }

                if (!map2d) {
                    if (
                        (Math.abs(fbearing - props.viewport.bearing) < 10 && //
                            distance([lng, lat], [props.viewport.lng, props.viewport.lat]) < 0.4) ||
                        distance([lng, lat], npol) < 0.75
                    ) {
                        return undefined;
                    }
                    const map = mapRef?.current?.getMap();
                    if (map && map.transform && map.transform.elevation) {
                        const mapbox_elevation = map.queryTerrainElevation(map.getCenter(), {exaggerated: true});
                        position = [0, 0, mapbox_elevation];
                    }
                }

                props.setViewport({
                    ...props.viewport,
                    latitude: lat,
                    longitude: lng,
                    bearing: fbearing,
                    position
                });
                return fbearing;
            }
            return undefined;
        },
        follow && props.options.follow ? [selectedCompno, selectedPilotData?.track?.vario?.lat, selectedPilotData?.score?.currentLeg, props.options.taskp] : [null, null, null, null]
    );

    useMemo(() => {
        if (props.viewport.pitch == 0 && !map2d) {
            props.setViewport(
                {
                    ...props.viewport,
                    pitch: 70
                },
                map2d ? {} : {transitionInterruption: TRANSITION_EVENTS.SNAP_TO_END, transitionDuration: 300, transitionInterpolator: new FlyToInterpolator()}
            );
        } else if (props.viewport.pitch != 0 && map2d) {
            props.setViewport(
                {
                    ...props.viewport,
                    pitch: 0
                },
                map2d ? {} : {transitionInterruption: TRANSITION_EVENTS.SNAP_TO_END, transitionDuration: 500, transitionInterpolator: new FlyToInterpolator()}
            );
        }
    }, [map2d]);

    useMemo(() => {
        if (options.zoomTask) {
            const [minLng, minLat, maxLng, maxLat] = bbox(taskGeoJSONtp);

            const viewportWebMercator = new WebMercatorViewport(viewport);
            const {
                longitude,
                latitude,
                zoom
            } = //
                viewportWebMercator.fitBounds(
                    [
                        [minLng, minLat],
                        [maxLng, maxLat]
                    ],
                    {
                        padding: 20
                    }
                );
            setViewport({...props.viewport, longitude, latitude, zoom, transitionInterpolator: new FlyToInterpolator(), transitionDuration: 500});
        }

        setTimeout(() => setOptions({...options, zoomTask: false}), 100);
    }, [vc, selectedCompno, options.zoomTask]);

    //
    // Colour and style the task based on the selected pilot and their destination
    const [trackLineStyle, turnpointStyleFlat, turnpointStyle] = useMemo(() => {
        return map2d ? turnpointStyle2d(selectedPilotData?.score, mapLight) : turnpointStyle3d(selectedPilotData?.score, mapLight);
    }, [selectedCompno, selectedPilotData?.score?.currentLeg, selectedPilotData?.score?.utcFinish, mapLight, map2d]);

    //
    // Two different ways to make sure we have terrain loaded
    // on map load (in case it's default for user and on change of map type)
    const onMapLoad = useCallback(
        (evt) => {
            if (!map2d) {
                console.log('terrain callback');
                const map = evt.target;
                map.setTerrain({source: 'mapbox-dem'});
                map.setFog({color: 'rgba(135, 206, 235, .5)', range: [0.5, 1.5], 'horizon-blend': 0.1});
            }
        },
        [map2d]
    );
    useEffect(() => {
        const map = mapRef?.current?.getMap();
        if (map) {
            const hasTerrain = !!map.getTerrain();
            if (hasTerrain && map2d) {
                console.log('disabling terrain');
                map.setTerrain(null);
                map.setFog(null);
            }
            if (!hasTerrain && !map2d) {
                console.log('enabling terrain');
                if (!map.getSource('mapbox-dem')) {
                    map.addSource('mapbox-dem', {
                        type: 'raster-dem',
                        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                        tileSize: 512,
                        maxzoom: 14
                    });
                }
                setTimeout(() => {
                    map.setTerrain({source: 'mapbox-dem'});
                    map.setFog({color: 'rgba(135, 206, 235, .5)', range: [0.5, 1.5], 'horizon-blend': 0.1});
                }, 1000);
            }
        } else {
            console.log('no mapref');
        }
    }, [map2d, mapRef]);

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

    const toolTip = useCallback(({object, picked, layer, coordinate}) => {
        if (!picked) {
            if (process.env.NODE_ENV == 'development' && coordinate) {
                return `[${coordinate.map((x) => x.toFixed(4))}]`;
            }
            return null;
        }
        if (object) {
            let response = '';
            const compno = layer.props.compno ?? object.compno;
            const time = object.t;

            if (time) {
                if (compno && pilotScores[compno]?.stats) {
                    const segment = _find(props.pilots[compno].stats, (c) => c.start <= time && time <= c.end);
                    if (segment) {
                        object.stats = segment;
                    }
                }

                // Figure out what the local language is for international date strings
                const dt = new Date(time * 1000);
                response += `${compno}: ✈️ ${dt.toLocaleTimeString(lang, {timeZone: props.tz, hour: '2-digit', minute: '2-digit', second: '2-digit'})}<br/>`;
            }

            if (process.env.NODE_ENV == 'development') {
                response += `[${time}]<br/>`;
            }

            const a = object.a ?? object.p[1][2] ?? NaN;
            if (!isNaN(a)) {
                response += `${displayHeight(a, props.options.units)} QNH `;
            }
            if (object.g && !isNaN(object.g)) {
                response += `(${displayHeight(object.g, props.options.units)} AGL) `;
            }
            if (object.v) {
                response += ` ↕️  ${displayClimb(object.v, props.options.units)}`;
            }
            if (object.stats) {
                const stats = object.stats;
                const elapsed = stats.end - stats.start;

                if (elapsed > 30) {
                    response += `<br/> ${stats.state} for ${elapsed} seconds<br/>`;

                    if (stats.state == 'thermal') {
                        response += `average: ${displayClimb(stats.avgDelta, props.options.units)}`;
                    } else if (stats.state == 'straight') {
                        response += `distance: ${stats.distance} km at a speed of ${(stats.distance / (elapsed / 3600)).toFixed(0)} kph<br/>` + `L/D ${((stats.distance * 1000) / -stats.delta).toFixed(1)}`;
                    }
                    if (stats.wind.direction) {
                        response += `<br/>wind speed: ${stats.wind.speed.toFixed(0)} kph @ ${stats.wind.direction.toFixed(0)}°`;
                    }
                }
            }
            return {html: response};
        } else if (layer && layer.props.tt == true) {
            return layer.id;
        } else {
            return null;
        }
    }, []);

    const attribution = <AttributionControl key={radarOverlay.key + (props.status?.replaceAll(/[^0-9]/g, '') || 'no')} customAttribution={[radarOverlay.attribution, props.status].join(' | ')} style={attributionStyle} />;

    // Update the view and synchronise with mapbox
    const onViewStateChange = useCallback(
        ({viewState}) => {
            //
            //            console.log(map2d, props.options.mapType);
            if (props.options.taskUp == 0) {
                viewState.bearing = 0;
            }
            if (map2d) {
                viewState.minPitch = 0;
                viewState.maxPitch = 0;
                setViewport(viewState);
                return;
            } else {
                viewState.minPitch = 0;
                viewState.maxPitch = 85;
                viewState.pitch = Math.max(Math.min(viewState.pitch, 85), 0);
            }

            const map = mapRef?.current?.getMap();
            if (map && map.transform && map.transform.elevation && !viewState.position) {
                //&& map.queryTerrainElevation) {
                //            const mapbox_elevation = map.transform.elevation.getAtPoint(MercatorCoordinate.fromLngLat(map.getCenter()));
                const mapbox_elevation = map.queryTerrainElevation(map.getCenter(), {exaggerated: true});
                //			console.log( "3d transform, elevation", mapbox_elevation );
                //const mapbox_elevation = -40000;
                setViewport({
                    ...viewState,
                    ...{position: [0, 0, mapbox_elevation]}
                });
            } else {
                setViewport(viewState);
            }
        },
        [map2d, props.options.taskUp, mapRef]
    );

    const onClick = useCallback(() => measureClick(props.measureFeatures), [props.measureFeatures]);
    const getCursor = useCallback(() => 'crosshair', []);

    controller.setFollow = setFollow;
    return (
        <DeckGL
            viewState={viewport}
            onViewStateChange={onViewStateChange}
            //            controller={{type: StopFollowController, setFollow, inertia: true, transitionDuration: 0}} // helps with touch scroll on laptops (undocumented)
            controller={controller} // helps with touch scroll on laptops (undocumented)
            getTooltip={toolTip}
            {...(isMeasuring(props.measureFeatures) ? {getCursor: getCursor} : {})}
            layers={layers} //
            onClick={onClick}
        >
            <StaticMap mapboxApiAccessToken={process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN} mapStyle={mapStreet ? 'mapbox://styles/mapbox/cjaudgl840gn32rnrepcb9b9g' /*"mapbox://styles/ifly7charlie/ckck9441m0fg21jp3ti62umjk"*/ : 'mapbox://styles/ifly7charlie/cksj3g4jgdefa17peted8w05m'} onLoad={onMapLoad} ref={mapRef} attributionControl={false}>
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
                {valid ? (
                    <Source type="geojson" data={taskGeoJSONtp}>
                        <Layer {...turnpointStyleFlat} key="tps" />
                        <Layer {...turnpointStyle} key="tgjp" />
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
                {!map2d && <Layer {...skyLayer} />}
                {attribution}
                {radarOverlay.layer}
            </StaticMap>
        </DeckGL>
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
    const map = mapRef?.current?.getMap();
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
                'fill-extrusion-base': ['case', ['==', !selectedPilot, true], 10, ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0], 5, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], 10, 0],
                'fill-extrusion-height': ['case', ['==', !selectedPilot, true], 5000, ['<', ['get', 'leg'], selectedPilot?.utcFinish || selectedPilot?.currentLeg || 0], 9, ['==', ['get', 'leg'], selectedPilot?.currentLeg || 0], 5000, 2]
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
