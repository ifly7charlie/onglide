
//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import { useState, useMemo, useRef, Profiler } from 'react';
import { useRouter } from 'next/router';

import { useTaskGeoJSON, usePilotsGeoJSON, usePilotFullGeoJSON, Spinner, Error } from './loaders.js';
import { Nbsp, Icon } from './htmlhelper.js';

import InteractiveMap, { Source, Layer } from 'react-map-gl';
import {AttributionControl} from 'react-map-gl';
import { RadarOverlay } from './rainradar';

import mapboxtoken from './mapbox-token';



export default function TaskMap( {vc,datecode,
								  selectedPilot,setSelectedCompno,
								  mapRef,
								  options,setOptions,tz,
								  viewport,setViewport,
								  status,
								  pilotsGeoJSON, pilotFullGeoJSON } ) {

    const { taskGeoJSON, isTLoading, Terror } = useTaskGeoJSON(vc);

    // Do we have a loaded set of details?
    const valid = !( isTLoading || Terror ) && (taskGeoJSON.tp && taskGeoJSON.track);

	// Figure out what to do if we hover over a feature
	function hoverHandler(e) {
		// we get called even if nothing we care about is under it, so ignore these
		if( ! e.features?.length ) {
			return;
		}
	}
	
	// or click on it!
	function clickHandler(e) {
		// we get called even if nothing we care about is under it, so ignore these
		if( ! e.features?.length ) {
			return;
		}


		// If it is a competition number then
		const compno = e.features[0]?.properties?.c;
		console.log( "click", compno, e );
		if( compno ) {
			setSelectedCompno(compno == selectedPilot?.compno ? undefined : compno );
		}
	}

	function checkIS(is) { return is.isDragging || is.isZooming; }


	const radarOverlay = RadarOverlay({options:options,setOptions:setOptions,tz:tz});

	const attribution = <AttributionControl key={radarOverlay.key + (status?.substring(0,2)||'no') }
											customAttribution={[radarOverlay.attribution, status].join(' | ')} style={attributionStyle}/>;
	
    // Render the map component
    return (<>
					<div className={'resizingMap'}>
                    <InteractiveMap
                        {...viewport}
                        width="100%"
                        height="100%"
                        ref={mapRef}
                        mapStyle="mapbox://styles/ifly7charlie/ckck9441m0fg21jp3ti62umjk"
						onViewportChange={(nextViewport,is) => {if(checkIS(is)&&selectedPilot) { selectedPilot.follow = false; } setViewport(nextViewport); }}
						interactiveLayerIds={valid?['markers','flights']:[]}
						onHover={e=>hoverHandler(e)}
						onClick={e=>clickHandler(e)}
						clickRadius={4}
                        mapboxApiAccessToken={process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN}
						attributionControl={false}
					>
						{attribution}
						{radarOverlay.layer}
						
                        {valid?<>
                                   <Source type="geojson" data={taskGeoJSON.tp}>
                                       <Layer {...turnpointStyle}/>
                                   </Source>
                                   <Source type="geojson" data={taskGeoJSON.track}>
                                       <Layer {...trackLineStyle}/>
                                   </Source>
								   {pilotsGeoJSON ?
									<>
										<Source type="geojson" data={pilotsGeoJSON.tracks}>
											<Layer {...pilotsLineStyle}/>
										</Source>
										<Source type="geojson" data={pilotsGeoJSON.locations}>
											<Layer {...markerStyle}/>
										</Source>
									</>: null}
                                   {selectedPilot&&selectedPilot.scoredGeoJSON?
                                    <Source type="geojson" data={selectedPilot.scoredGeoJSON} key={selectedPilot.compno}>
                                        <Layer {...scoredLineStyle}/>
                                    </Source>:null}
								   {pilotFullGeoJSON?
									<>
										<Source type="geojson" data={pilotFullGeoJSON}>
											<Layer {...pilotsFullLineStyle}/>
										</Source>
									</>
										:null}

                               </>:null}
                    </InteractiveMap>
                </div>
            </>
           );
}

//										<Source type="geojson" data={pilotFullGeoJSON.marker.features}>
//											<Layer {...pilotSelectedStyle}/>
//										</Source>

//
// Styling information for the map
//

// Pilots (recent track)
const pilotsLineStyle = {
    id: 'flights',
    type: 'line',
    paint: {
        'line-color': 'grey',
        'line-width': 1,
        'line-opacity': 0.6,
    }
};

// full track for selected pilot
const pilotsFullLineStyle = {
    id: 'fullflight',
    type: 'line',
    paint: {
        'line-color': 'black',
        'line-width': 2,
        'line-opacity': 0.6,
    }
};

// scored track for selected pilot
const scoredLineStyle = {
    id: 'scored',
    type: 'line',
    paint: {
        'line-color': 'green',
        'line-width': 5,
        'line-opacity': 0.8,
    }
};

// Current position of each pilot
const markerStyle =  {
    'id': 'markers',
    'type': 'symbol',
    'source': 'points',
    'layout': {
        // get the icon name from the source's "icon" property
        // concatenate the name to get an icon from the style's sprite sheet
        'icon-image': ['concat', ['get', 'i'], '-11'],
        // get the title name from the source's "title" property
        'text-field': [
            'format',
            ['get', 'c'],
        ],
        'text-offset': [0, 0.3],
        'text-anchor': 'top',
        'icon-allow-overlap': true,
        'text-ignore-placement': true,
        'text-allow-overlap': true,
    },
    paint: {
        'text-color': ['get', 'v'],
        'icon-color': ['get', 'v']
    },
}

//
// Tasks - trackline
const trackLineStyle = {
    id: 'track',
    type: 'line',
    paint: {
        'line-color': 'black',
        'line-width': 3,
        'line-opacity': 0.8,
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
		'fill-extrusion-height': 4000,
		'fill-extrusion-base': 0,
    },
}

const attributionStyle= {
	right: 0,
	bottom: 0,
	fontSize: '13px'
};
