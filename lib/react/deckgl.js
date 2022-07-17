import React, {useState, useCallback, useMemo} from 'react';
import DeckGL from '@deck.gl/react';
import {MapView, GeoJsonLayer,PathLayer,TextLayer,IconLayer} from '@deck.gl/layers';
import {FlyToInterpolator} from '@deck.gl/core'
import {StaticMap,Source,Layer} from 'react-map-gl';
import { MercatorCoordinate } from 'mapbox-gl';

import { useTaskGeoJSON, Spinner, Error } from './loaders.js';

import { gapLength } from '../constants.js';

// Height/Climb helpers
import { displayHeight, displayClimb } from './displayunits.js';

// Figure out where the sun should be
import SunCalc from 'suncalc';

// For displaying rain radar
import {AttributionControl} from 'react-map-gl';
import { RadarOverlay } from './rainradar';

import { point } from '@turf/helpers';
import bearing from '@turf/bearing';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import polygonToLine from '@turf/polygon-to-line';

import _map from 'lodash/map'
import _reduce from 'lodash/reduce'
import _find from 'lodash/find';

// Create an async iterable
/*async function* getData() {
  for (let i = 0; i < 10; i++) {
    await const chunk = fetchChunk(...);
    yield chunk;
  }
}*/


// Import our layer override so we can distinguish which point on a
// line has been clicked or hovered
import OgnPathLayer from './ognpathlayer.js';

//
// Responsible for generating the deckGL layers
//
function makeLayers( props, taskGeoJSON, map2d ) {
	if( ! props.trackData ) {
		return [];
	}

	// Add a layer for the recent points for each pilot
	let layers = _reduce( props.trackData,
						  (result,p,compno) => {
							  if( compno == props.selectedCompno ) {
								  return result;
							  }
							  result.push( new OgnPathLayer(
								  { id: compno,
									compno: compno,
									data: { length: 1,
											startIndices: new Uint32Array([0,p.recentIndices[1]-p.recentIndices[0]]),
											timing:p.t.subarray(p.recentIndices[0],p.recentIndices[1]),
											climbRate:p.climbRate.subarray(p.recentIndices[0],p.recentIndices[1]),
											agl: p.agl.subarray(p.recentIndices[0],p.recentIndices[1]),
											attributes: {
												getPath: { value: p.positions.subarray(p.recentIndices[0]*3,p.recentIndices[1]*3),
														   size: map2d ? 2 : 3,
														   stride: map2d ? 4*3 : 0}
											}
									},
									_pathType: 'open',
									positionFormat: map2d ? 'XY' : 'XYZ',
									getWidth: 5,
									getColor: [220,220,220,128],
									jointRounded: true,
									fp64: false,
									widthMinPixels: 2,
									billboard: true,
									onClick: (i) => { props.setSelectedCompno(compno); },
									updateTriggers: {
										getPath: p.posIndex
									},
									pickable: true,
									tt: true
								  }));
							  return result;
						  }, []);

	//
	// Generate the labels data, this is fairly simple and is extracted from the positions
	// data set rather than pilots so that the marker always aligns with the tracking points
	// we are adding more data so we get a nice tool tip, text colour is determined by how old
	// the point is
	const data = _map( props.trackData, (p) => {
		return { name: p.compno,
				 compno: p.compno,
				 climbRate: p.climbRate[p.posIndex-1],
				 agl: p.agl[p.posIndex-1],
				 alt: p.positions[(p.posIndex-1)*3+2],
				 time: p.t[p.posIndex-1],
				 coordinates: p.positions.subarray((p.posIndex-1)*3,(p.posIndex)*3) }
	});
	layers.push( new TextLayer({ id: 'labels',
								 data: data,
								 getPosition: d => d.coordinates,
								 getText: d => d.name,
								 getTextColor: d => props.t - d.time > gapLength ? [ 192, 192, 192 ] : [ 0, 0, 0 ],
								 getTextAnchor: 'middle',
								 getSize: d => d.name == props.selectedCompno ? 20 : 16,
								 pickage: true,
								 background: true,
								 backgroundPadding: [ 3, 3, 3, 0 ],
								 onClick: (i) => { props.setSelectedCompno(i.object?.name||''); },
								 pickable: true
							   }));

	//
	// If there is a selected pilot then we need to add the full track for that pilot
	// 
	if( props.selectedCompno && props.trackData[ props.selectedCompno ] ) {
		const p = props.trackData[ props.selectedCompno ];
		layers.push( new OgnPathLayer(
			{ id: 'selected',
			  compno: props.selectedCompno,
			  data: { length: p.segmentIndex, startIndices:p.indices, timing:p.t,
					  climbRate:p.climbRate, agl: p.agl,
					  attributes: {
						  getPath: { value: p.positions,
									 size: map2d ? 2 : 3,
									 stride: map2d ? 4*3 : 0}
					  },
			  },
			  _pathType: 'open',
			  positionFormat: map2d ? 'XY' : 'XYZ',
			  getWidth: () => 5,
			  billboard: true,
			  getColor: [255,0,255,192],
			  jointRounded: true,
			  widthMinPixels: 3,
			  fp64: false,
			  pickable: true,
			  tt: true,
			  updateTriggers: {
				  getPath: p.posIndex
			  }
			}));
	}

	return layers;
}

export default function MApp(props) {

	// Map display style
	const map2d = props.options.mapType > 1;
	const mapStreet = props.options.mapType % 2;

	// Track and Task Overlays
    const { taskGeoJSON, isTLoading, Terror } = useTaskGeoJSON(props.vc);
	const layers = useMemo( _ => makeLayers(props, taskGeoJSON, map2d),
							[ props.t, props.pilots, props.selectedCompno, taskGeoJSON, map2d ]);

	// Rain Radar
	const lang = useMemo( _ => (navigator.languages != undefined) ? navigator.languages[0] :  navigator.language, []);
	const radarOverlay = RadarOverlay({options:props.options,setOptions:props.setOptions,tz:props.tz});

	// We will calculate the nearest point every 30 seconds or when the TP changes or selected pilot changes
	useMemo( _ => {
		if( props.selectedPilot && props.selectedPilot.lat && 'lasttp' in props.selectedPilot && props.selectedPilot.follow && taskGeoJSON?.tp?.features ) {

			// If we are in track up mode then we will point it towards the next turnpoint
			let fbearing = props.options.taskUp == 2 ? props.viewport.bearing : 0;
			if( props.options.taskUp == 1 ) {
				const tp = taskGeoJSON.tp.features[ props.selectedPilot.lasttp ] || taskGeoJSON.tp.features[ props.selectedPilot.lasttp -1 ];
				const npol = nearestPointOnLine( polygonToLine( tp ),
												 point([props.selectedPilot.lng, props.selectedPilot.lat]));
				fbearing = bearing( point([props.selectedPilot.lng, props.selectedPilot.lat]), npol );
			}
		
			props.setViewport({
				...props.viewport,
				latitude: props.selectedPilot.lat,
				longitude: props.selectedPilot.lng,
				bearing: fbearing,
				transitionDuration: 1000,
				transitionInterpolator: new FlyToInterpolator()
			});
			return fbearing;
		}
		return undefined;
	}, [ props.selectedPilot, props.selectedPilot?.lasttp, props.selectedPilot?.follow, Math.trunc(props.t/60) ]);

	//
	// Colour and style the task based on the selected pilot and their destination
	const [trackLineStyle,turnpointStyleFlat,turnpointStyle] = useMemo( _ => {
		return map2d ? turnpointStyle2d( props ) : turnpointStyle3d( props );
	}, [ props.selectedPilot, props.selectedPilot?.lasttp ]);
	
	const onMapLoad = useCallback(evt => {
		if( ! map2d ) {
			const map = evt.target;
			map.setTerrain({source: 'mapbox-dem'});
			map.setFog({ 'color': 'rgba(135, 206, 235, .5)', range: [ 0.5, 1.5 ], 'horizon-blend': 0.1 });
//			map.once('idle', () => {
//				console.log( 'map idle' );
//				props.setViewport(props.viewport);
//			});
			}
	}, [map2d]);
	

    // Do we have a loaded set of details?
    const valid = !( isTLoading || Terror ) && (taskGeoJSON?.tp && taskGeoJSON?.track);

	const skyLayer = {
		'id': 'sky',
		'type': 'sky',
		'paint': {
			'sky-opacity': [
				'interpolate',
				['linear'],
				['zoom'],
				0,
				0,
				5,
				0.3,
				8,
				1
			],
			// set up the sky layer for atmospheric scattering
			'sky-type': 'atmosphere',
			// explicitly set the position of the sun rather than allowing the sun to be attached to the main light source
			'sky-atmosphere-sun': getSunPosition(props.mapRef),
			// set the intensity of the sun as a light source (0-100 with higher values corresponding to brighter skies)
			'sky-atmosphere-sun-intensity': 5,
			'sky-atmosphere-color': 'rgba(135, 206, 235, 1.0)'
		}
	};

	function toolTip({object,picked,layer}) {
		if( ! picked ) {
			return null;
		}
		if( object ) {
			let response = '';

			if( object.compno && object.time && props?.pilots[object.compno]?.stats ) {
				const segment = _find( props.pilots[object.compno].stats, (c) => c.start <= object.time && object.time <= c.end );
				if( segment ) {
					object.stats = segment;
				}
			}
			if( object.time ) {
				// Figure out what the local language is for international date strings
				const dt = new Date(object.time*1000);
				response += `${object.compno}: ✈️ ${dt.toLocaleTimeString( lang, {timeZone: props.tz, hour: "2-digit", minute: "2-digit", second:"2-digit"})}<br/>`;
			}

			if( object.alt && ! isNaN(object.alt) ) {
				response += `${displayHeight(object.alt,props.options.units)} QNH `;
			}
			if( object.agl && ! isNaN(object.agl) ) {
				response += `(${displayHeight(object.agl,props.options.units)} AGL) `;
			}
			if( object.climbRate ) {
				response += ` ↕️  ${displayClimb(object.climbRate,props.options.units)}`;
			}
			if( object.stats ) {
				const stats = object.stats;
				const elapsed = stats.end - stats.start;

				if( elapsed > 30 ) {
					response += `<br/> ${stats.state} for ${elapsed} seconds<br/>`;
					
					if( stats.state == 'thermal' ) {
						response += `average: ${displayClimb(stats.avgDelta,props.options.units)}`;
					}
					else if ( stats.state == 'straight' ) {
						response += `distance: ${stats.distance} km at a speed of ${(stats.distance/(elapsed/3600)).toFixed(0)} kph<br/>`
							+ `L/D ${((stats.distance*1000)/-stats.delta).toFixed(1)}`;
					}
					if( stats.wind.direction ) {
						response += `<br/>wind speed: ${stats.wind.speed.toFixed(0)} kph @ ${stats.wind.direction.toFixed(0)}°`;
					}
				}
			}
			return { html: response };
		}
		else if( layer && layer.props.tt == true ) {
			return layer.id;
		}
		else {
			return null;
		}
	}
	
	const attribution = <AttributionControl key={radarOverlay.key + (status?.substring(0,2)||'no') }
											customAttribution={[radarOverlay.attribution, status].join(' | ')} style={attributionStyle}/>;


	// Update the view and synchronise with mapbox
	const onViewStateChange = ({ viewState }) => {
		if( props.selectedPilot?.follow ) {
			props.selectedPilot.follow = false;
			props.setPilots( props.pilots );
		}
		if( map2d ) {
			viewState.minPitch = 0;
			viewState.maxPitch = 0;
		}
		else {
			viewState.minPitch = 0;
			viewState.maxPitch = 85;
		}
		
        const map = props.mapRef?.current?.getMap()
        if (map && ! map2d && map.transform && map.transform.elevation) { // && map.queryTerrainElevation) {
			const mapbox_elevation = map.transform.elevation.getAtPoint(MercatorCoordinate.fromLngLat(map.getCenter()));
//L			const mapbox_elevation = map.queryTerrainElevation(map.getCenter(),{ exaggerated: true });
//			console.log( "3d transform, elevation", mapbox_elevation );
//			const mapbox_elevation = -40000;
            props.setViewport({
                ...viewState,
                ...{ position: [0, 0, mapbox_elevation] }
            });
        } else {
            props.setViewport(viewState);
        }
    };

	const taskGeoJSONtp = props?.selectedPilot?.task || taskGeoJSON?.tp;

return (
		<DeckGL
			viewState={props.viewport}
            controller={true}
			getTooltip={toolTip}
			onViewStateChange={ e => onViewStateChange(e) }	
			layers={layers}>
			
		<StaticMap          mapboxApiAccessToken={process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN}
									mapStyle={mapStreet ? "mapbox://styles/mapbox/cjaudgl840gn32rnrepcb9b9g" /*"mapbox://styles/ifly7charlie/ckck9441m0fg21jp3ti62umjk"*/ : "mapbox://styles/ifly7charlie/cksj3g4jgdefa17peted8w05m" }
									onLoad={onMapLoad}
		ref={props.mapRef}
									attributionControl={false}>
					{valid?<>
                               <Source type="geojson" data={taskGeoJSON.track}>
                                   <Layer {...trackLineStyle}/>
                               </Source>
                               <Source type="geojson" data={taskGeoJSONtp}>
                                   <Layer {...turnpointStyleFlat}/>
                               </Source>
							   <Source type="geojson" data={taskGeoJSONtp}>
								   <Layer {...turnpointStyle}/>
							   </Source>
						   </>:null
					}
					{props.selectedPilot&&props.selectedPilot.scoredGeoJSON?
					 <Source type="geojson" data={props.selectedPilot.scoredGeoJSON} key={props.selectedPilot.compno}>
						 <Layer {...scoredLineStyle}/>
					 </Source>:null}
					{! map2d &&
					 <>
						 <Source
							 id="mapbox-dem"
							 type="raster-dem"
							 url="mapbox://mapbox.mapbox-terrain-dem-v1"
							 tileSize={512}
							 maxzoom={14}
						 />
						 <Layer {...skyLayer} />
					 </>
					}
					
					{attribution}
					{radarOverlay.layer}
				</StaticMap>
		</DeckGL>
  );
}


// scored track for selected pilot
const scoredLineStyle = {
    id: 'scored',
    type: 'line',
    paint: {
        'line-color': '#0f0',
        'line-width': 5,
        'line-opacity': 1,
    }
};

function getSunPosition(mapRef,date) {
	const map = mapRef?.current?.getMap();
	if ( map ) {
		const center = map.getCenter();
		const sunPos = SunCalc.getPosition(
			date || Date.now(),
			center.lat,
			center.lng
		);
		const sunAzimuth = 180 + (sunPos.azimuth * 180) / Math.PI;
		const sunAltitude = 90 - (sunPos.altitude * 180) / Math.PI;
		return [sunAzimuth, sunAltitude];
	}
	else {
		return [ 0, 0 ]
	}
}

const attributionStyle= {
	right: 0,
	bottom: 0,
	fontSize: '13px'
};


function turnpointStyle3d( props ) {
	return [
			{ // Track line
				id: 'track',
				type: 'line',
				paint: {
					'line-color': 'white',
					'line-width': [
						'case',
						['==', (props.selectedPilot == undefined), true], 15,
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], 15,
						6
					],
					'line-opacity': 1,
					'line-pattern': 'oneway-white-large',

				},
			},  { // Turnpoints
				id: 'tp',
				type: 'fill',
				filter: [
					'case',
						['==', (props.selectedPilot == undefined), true], false,
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], false,
						true
				], 
				 line: {
					 'line-color': 'grey',
					 'line-width': 1,
				 },
				  paint: {
					 'fill-opacity': 0.5,
					 'fill-color': [
						'case',
						['==', (props.selectedPilot == undefined), true], 'white',
						['<', ['get', 'leg'], (props.selectedPilot?.utcfinish||props.selectedPilot?.lasttp||0)], 'green',
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], 'orange',
						'white'
					 ],
				  },
			},  { // Turnpoints
				id: 'tpe',
				type: 'fill-extrusion',
				filter: [
					'case',
						['==', (props.selectedPilot == undefined), true], true,
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], true,
						false
				], 
				 line: {
					 'line-color': 'grey',
					 'line-width': 1,
				 },
				  paint: {
					 'fill-extrusion-color': [
						'case',
						['==', (props.selectedPilot == undefined), true], 'white',
						['<', ['get', 'leg'], (props.selectedPilot?.utcfinish||props.selectedPilot?.lasttp||0)], 'green',
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], 'orange',
						'white'
					 ],
					 'fill-extrusion-opacity': 0.5,
					 'fill-extrusion-base': [
						'case',
						['==', (props.selectedPilot == undefined), true], 10,
						['<', ['get', 'leg'], (props.selectedPilot?.utcfinish||props.selectedPilot?.lasttp||0)], 5,
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], 10,
						0
					 ],
					 'fill-extrusion-height': [
						'case',
						['==', (props.selectedPilot == undefined), true], 5000,
						['<', ['get', 'leg'], (props.selectedPilot?.utcfinish||props.selectedPilot?.lasttp||0)], 9,
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], 5000,
						2
					 ],
				 },
			}
		];
}

function turnpointStyle2d( props ) {
	return [
			{ // Track line
				id: 'track',
				type: 'line',
				paint: {
					'line-color': 'white',
					'line-width': [
						'case',
						['==', (props.selectedPilot == undefined), true], 15,
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], 15,
						6
					],
					'line-opacity': 1,
					'line-pattern': 'oneway-white-large',

				},
			},	{ // Turnpoints flat
				id: 'tp',
				 type: 'fill',
				 line: {
					 'line-color': 'grey',
					 'line-width': 1,
				 },
				  paint: {
					 'fill-opacity': 0.5,
					 'fill-color': [
						'case',
						['==', (props.selectedPilot == undefined), true], 'white',
						['<', ['get', 'leg'], (props.selectedPilot?.utcfinish||props.selectedPilot?.lasttp||0)], 'green',
						['==', ['get', 'leg'], (props.selectedPilot?.lasttp||0)], 'orange',
						'white'
					 ],
				  },
			},	{ // Turnpoints not flat
				id: 'tpe',
				  layout: {
					  visibility: 'none',
				  },
				  type: 'fill'
			}
		];
}
