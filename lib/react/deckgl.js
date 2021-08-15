import React, {useState, useRef, useCallback, useMemo} from 'react';
import DeckGL from '@deck.gl/react';
import {MapView, GeoJsonLayer,PathLayer,TextLayer,IconLayer} from '@deck.gl/layers';
import {StaticMap,Source,Layer} from 'react-map-gl';
import { MercatorCoordinate } from 'mapbox-gl';
import {MapboxLayer} from '@deck.gl/mapbox'
import { Matrix4 } from "@math.gl/core";

import TaskMap from './taskmap.js'
import { useTaskGeoJSON, Spinner, Error } from './loaders.js';

import SunCalc from 'suncalc';

import _map from 'lodash/map'
import _reduce from 'lodash/reduce'

// Create an async iterable
/*async function* getData() {
  for (let i = 0; i < 10; i++) {
    await const chunk = fetchChunk(...);
    yield chunk;
  }
}*/

import GL from '@luma.gl/constants';

const color = new Uint8Array([64,64,64]);


class OgnPathLayer extends PathLayer {
	initializeState() {
		super.initializeState();
		
		this.getAttributeManager().addInstanced({
			instancePickingColors: {
				size: 3,
				type: GL.UNSIGNED_BYTE,
				update: this.calculatePickingColors,
//				accessor: calculatePickingColors//(object,{index,target:value}) => 
			}
		})
	};

	calculatePickingColors(attribute) {
		const {data} = this.props;
		const {value} = attribute;
		
		let i = 0;
		for (const object of data.timing) {
			const pickingColor = this.encodePickingColor(i);
			value[i * 3] = pickingColor[0];
			value[i * 3 + 1] = pickingColor[1];
			value[i * 3 + 2] = pickingColor[2];
			i++;
		}
	}

	getPickingInfo(pickParams) {
		const info = super.getPickingInfo(pickParams);
		const props = pickParams?.info?.layer?.props;
		if( props && props.data ) {
			const coordinate = props.data.attributes.positions.value.subarray(pickParams.info.index*3,(pickParams.info.index+1)*3);
			info.object = { compno: props.compno,
							lat: coordinate[0],
							lng: coordinate[1],
							alt: Math.floor(coordinate[2]),
							time: props.data.timing[pickParams.info.index],
						  };
		}
		return info;
	}
}
OgnPathLayer.layerName = 'OgnPathLayer';

//
// Responsible for generating the deckGL layers
//
function makeLayers( props ) {
	if( ! props.trackData ) {
		return [];
	}

	function findPointOnHover( lat, lng, data ) {
		for ( const x of data ) {
			if( x == lat ) {
				console.log( "!");
			}
		}
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
											attributes: { getPath: { value: p.positions.subarray(p.recentIndices[0]*3,p.recentIndices[1]*3), size: 3 }}
										  },
									_pathType: 'open',
									getWidth: 5,
									getColor: [192,192,192,128],
									jointRounded: true,
									widthMinPixels: 2,
									billboard: true,
									onClick: (i) => { props.setSelectedCompno(compno); },
									pickable: true,
									tt: true
								  }));
							  return result;
						  }, []);

	const data = _map( props.trackData, (p) => {
									 return { name: p.compno,
											  coordinates: p.positions.subarray((p.posIndex-1)*3,(p.posIndex)*3) }
	});
	layers.push( new TextLayer({ id: 'labels',
								 data: data,
								 getPosition: d => d.coordinates,
								 getText: d => d.name,
								 getTextAnchor: 'middle',
								 getSize: d => d.name == props.selectedCompno ? 20 : 16,
								 pickage: true,
								 background: true,
								 backgroundPadding: [ 3, 3, 3, 0 ],
								 onClick: (i) => { props.setSelectedCompno(i.object?.name||''); },
								 pickable: true
							   }));

	// If there is a selected pilot then we need to add that
	if( props.selectedCompno && props.trackData[ props.selectedCompno ] ) {
		const p = props.trackData[ props.selectedCompno ];
		layers.push( new OgnPathLayer(
			{ id: 'selected',
			  compno: props.selectedCompno,
			  data: { length: p.segmentIndex, startIndices:p.indices, timing:p.t,
					  attributes: { getPath: { value: p.positions, size: 3}}},
			  _pathType: 'open',
			  getWidth: () => 5,
			  billboard: true,
			  getColor: [64,64,255,192],
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
	const layers = useMemo( _ => makeLayers(props), [ props.trackData, props.pilots, props.selectedCompno ]);
	const lang = useMemo( _ => (navigator.languages != undefined) ? navigator.languages[0] :  navigator.language, []);


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
			if( object.time ) {
				// Figure out what the local language is for international date strings
				const dt = new Date(object.time*1000);
				return `${object.compno}: ${object.alt}m ✈️ ${dt.toLocaleTimeString( lang, {timeZone: props.tz, hour: "2-digit", minute: "2-digit", second:"2-digit"})}`;
			}
		}
		else if( layer && layer.props.tt == true ) {
			return layer.id;
		}
		else {
			return null;
		}
	}
	
	return (
		<DeckGL
			initialViewState={props.viewport}
			controller={true}
			onViewStateChange={ e=>props.setViewport(e.viewState) }
			getTooltip={toolTip}
			layers={layers}>
			
				<StaticMap          mapboxApiAccessToken={process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN}
									mapStyle="mapbox://styles/mapbox/satellite-v9"
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
					<Source
						id="mapbox-dem"
						type="raster-dem"
						url="mapbox://mapbox.mapbox-terrain-dem-v1"
						tileSize={512}
						maxzoom={14}
					/>
					<Layer {...skyLayer} />					
				</StaticMap>
		</DeckGL>
  );
	//		<TaskMap {...props}/>
}
//									onHover={e=>hoverHandler(e)}
//									onClick={e=>clickHandler(e)}
//									clickRadius={4}




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
		'fill-extrusion-height': 4000,
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
        'line-width': 4,
        'line-opacity': 0.8,
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
