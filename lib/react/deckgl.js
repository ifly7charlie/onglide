import React, {useState, useRef, useCallback, useMemo} from 'react';
import DeckGL from '@deck.gl/react';
import {MapView, GeoJsonLayer,PathLayer,TextLayer,IconLayer} from '@deck.gl/layers';
import {StaticMap,Source,Layer} from 'react-map-gl';
import { MercatorCoordinate } from 'mapbox-gl';
import {MapboxLayer} from '@deck.gl/mapbox'
import { Matrix4 } from "@math.gl/core";

import { useTaskGeoJSON, Spinner, Error } from './loaders.js';

import { gapLength } from '../constants.js';

// Height/Climb helpers
import { displayHeight, displayClimb } from './displayunits.js';

// Figure out where the sun should be
import SunCalc from 'suncalc';

// For displaying rain radar
import {AttributionControl} from 'react-map-gl';
import { RadarOverlay } from './rainradar';


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
function makeLayers( props ) {
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
											attributes: { getPath: { value: p.positions.subarray(p.recentIndices[0]*3,p.recentIndices[1]*3), size: 3 }}
										  },
									_pathType: 'open',
									getWidth: 5,
									getColor: [220,220,220,128],
									jointRounded: true,
									widthMinPixels: 2,
									billboard: true,
									onClick: (i) => { props.setSelectedCompno(compno); },
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
					  climbRate:p.climbRate,
					  attributes: { getPath: { value: p.positions, size: 3}}},
			  _pathType: 'open',
			  getWidth: () => 5,
			  billboard: true,
			  getColor: [255,0,255,192],
			  jointRounded: true,
			  widthMinPixels: 3,
			  pickable: true,
			  tt: true,
			}));
	}

	return layers;
}

export default function MApp(props) {
    const { taskGeoJSON, isTLoading, Terror } = useTaskGeoJSON(props.vc);
	const layers = useMemo( _ => makeLayers(props, taskGeoJSON),
							[ props.t, props.pilots, props.selectedCompno, taskGeoJSON ]);
	const lang = useMemo( _ => (navigator.languages != undefined) ? navigator.languages[0] :  navigator.language, []);
	const radarOverlay = RadarOverlay({options:props.options,setOptions:props.setOptions,tz:props.tz});


	const onMapLoad = useCallback(evt => {
		const map = evt.target;
		map.setTerrain({source: 'mapbox-dem', exaggeration: 1});
	}, []);
	

    // Do we have a loaded set of details?
    const valid = !( isTLoading || Terror ) && (taskGeoJSON?.tp && taskGeoJSON?.track);

	if( ! valid || ! props.pilots ) {
		return <></>;
	}

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
			'sky-atmosphere-sun-intensity': 40
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
				response += `${object.compno}: ${displayHeight(object.alt,props.options.units)} ✈️ ${dt.toLocaleTimeString( lang, {timeZone: props.tz, hour: "2-digit", minute: "2-digit", second:"2-digit"})}`
					 + (object.climbRate ? ` ↕️  ${displayClimb(object.climbRate,props.options.units)}` : '');
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


	const onViewStateChange = ({ viewState }) => {
		if( viewState.latitude < taskGeoJSON.tp.bbox[1] ) viewState.latitude = taskGeoJSON.tp.bbox[1];
		if( viewState.latitude > taskGeoJSON.tp.bbox[3] ) viewState.latitude = taskGeoJSON.tp.bbox[3];
		if( viewState.longitude < taskGeoJSON.tp.bbox[0] ) viewState.longitude = taskGeoJSON.tp.bbox[0];
		if( viewState.longitude > taskGeoJSON.tp.bbox[2] ) viewState.longitude = taskGeoJSON.tp.bbox[2];

        const map = props.mapRef?.current?.getMap()
        if (map && map.transform.elevation) {
            const mapbox_elevation = map.transform.elevation.getAtPoint(MercatorCoordinate.fromLngLat(map.getCenter()));
            props.setViewport({
                ...viewState,
                ...{ position: [0, 0, mapbox_elevation] }
            });
        } else {
            props.setViewport(viewState);
        }
    };
	
	return (
		<DeckGL
			viewState={props.viewport}
			controller={{doubleClickZoom:false, touchRotate:true}}
			onViewStateChange={ e => onViewStateChange(e) }
			getTooltip={toolTip}
			layers={layers}>
			
				<StaticMap          mapboxApiAccessToken={process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN}
									mapStyle="mapbox://styles/ifly7charlie/cksj3g4jgdefa17peted8w05m" 
									onLoad={onMapLoad}
									ref={props.mapRef}
									attributionControl={false}>
					{valid?<>
							   <Source type="geojson" data={taskGeoJSON.tp}>
								   <Layer {...turnpointStyle}/>
							   </Source>
                               <Source type="geojson" data={taskGeoJSON.track}>
                                   <Layer {...trackLineStyle}/>
                               </Source>
						   </>:null
					}
					{props.selectedPilot&&props.selectedPilot.scoredGeoJSON?
					 <Source type="geojson" data={props.selectedPilot.scoredGeoJSON} key={props.selectedPilot.compno}>
						 <Layer {...scoredLineStyle}/>
					 </Source>:null}
					<Source
						id="mapbox-dem"
						type="raster-dem"
						url="mapbox://mapbox.mapbox-terrain-dem-v1"
						tileSize={512}
						maxzoom={14}
					/>
					<Layer {...skyLayer} />
					
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



// turnpoint
const turnpointStyle = {
    id: 'tp',
    type: 'fill-extrusion',
    line: {
        'line-color': 'grey',
        'line-width': 1,
    },
    paint: {
        'fill-extrusion-color': 'white',
        'fill-extrusion-opacity': 0.5,
		'fill-extrusion-height': 2000,
		'fill-extrusion-base': 0,
    },
}

//
// Tasks - trackline
const trackLineStyle = {
    id: 'track',
    type: 'line',
    paint: {
        'line-color': 'white',
        'line-width': 15,
        'line-opacity': 0.8,
		'line-pattern': 'oneway-white-large',
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
