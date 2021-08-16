
//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import { useState, useMemo, useRef } from 'react';

import { useTaskGeoJSON, usePilotsGeoJSON, usePilotFullGeoJSON, Spinner, Error } from './loaders.js';
import { Nbsp, Icon } from './htmlhelper.js';

import useWebSocket, { ReadyState } from 'react-use-websocket';

import _find  from 'lodash.find'
import _clonedeep from 'lodash.clonedeep';
import _foreach from 'lodash.foreach';
import _reduce from 'lodash.reduce';
import _map from 'lodash.map';

const { mergePoint, checkGrey }  = require('../incremental.js');

import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'

import { PilotList, Details } from './pilotlist.js';
import { TaskDetails } from './taskdetails.js';

import protobuf from 'protobufjs/light.js';
import { PilotTracks } from '../onglide-protobuf.js';

import MApp from './deckgl.js'

// Dynamically load the map as it's big and slow
import dynamic from 'next/dynamic'
const TaskMap  = dynamic(() => import( './taskmap.js' ),
						 { loading: () => <Spinner/>});


let mutateTimer = 0;
const httpsTest = new RegExp(/^https/i,'i');

function proposedUrl(vc,datecode) {
    const hn = '';//(process.env.NEXT_PUBLIC_SITEURL).split('.')[0].toUpperCase();
    return ((httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_HOST))
		  ? 'wss://' : 'ws://')+process.env.NEXT_PUBLIC_WEBSOCKET_HOST+'/'+(hn+vc+datecode).toUpperCase();
}

let scoresAF = undefined;
let pointAF = undefined;

let mutateScoresTimer = 0;
export function OgnFeed( {vc,datecode,tz,
						  selectedCompno,setSelectedCompno,
						  viewport,setViewport,
						  options,setOptions} )
{
	const [ trackData, setTrackData ] = useState({});
	const [ pilots, setPilots ] = useState({});
    const [ socketUrl, setSocketUrl ] = useState(proposedUrl(vc,datecode)); //url for the socket
    const [ wsStatus, setWsStatus ] = useState({'c':1,'p':0,'lm':null});
    const [ attempt, setAttempt ] = useState(0);
	
    // For remote updating of the map
    const mapRef = useRef(null);

	// Keep track of online/offline status of the page
	const [ online, isOnline ] = useState(navigator.onLine);
	// useEffect( () => {
	// 	function offline() => { isOnline(false); }
	// 	function online() => { isOnline(true); setSocketUrl(''); };
	// 	window.addEventListener('offline', offline);
	// 	window.addEventListener('online', online);
	// 	return () => {
	// 		window.removeEventListener('offline', offline);
	// 		window.removeEventListener('online', online);
	// 	}
	// });
		
    // We are using a webSocket to update our data here
    const { getWebSocket, lastMessage, readyState } = useWebSocket(socketUrl, {
        reconnectAttempts: 3,
        reconnectInterval: 30000,
        shouldReconnect: (closeEvent) => {
            console.log(closeEvent);
            return online;
        },
        onOpen: () => { setAttempt( attempt+1 ); }
    } );

    // Do we have a loaded set of details?
    const valid = Object.keys(pilots).length > 0 && mapRef && mapRef.current && mapRef.current.getMap();

    // Have we had a websocket message, if it hasn't changed then ignore it!
    let updateMessage = null;
    if( lastMessage ) {
        if( wsStatus.lm != lastMessage.data ) {
			if( ! lastMessage?.data?.size )  {
				updateMessage = JSON.parse(lastMessage.data);	
				wsStatus.lm = lastMessage.data;
				wsStatus.at = updateMessage.at;
				setWsStatus( wsStatus );
			}
			else {
				let root = protobuf.Root.fromJSON(PilotTracks);
				let PT = root.lookupType( "PilotTracks" );

				new Response(lastMessage.data).arrayBuffer()
								  .then((ab) => {
									  let buffer = PT.decode(new Uint8Array(ab));
									  console.log( "binary!", PT.toObject(buffer))
									  
									  setTrackData(
										  _reduce( buffer.pilots, (result,p,compno) =>
											  {
												  result[compno] = {
													  compno: compno,
													  indices: new Uint32Array(p.indices.slice().buffer),
													  positions: new Float64Array(p.positions.slice().buffer),
													  t: new Uint32Array(p.t.slice().buffer),
													  climbRate: new Int8Array(p.climbRate.slice().buffer),
													  recentIndices: new Uint32Array(p.recentIndices.slice().buffer),
													  posIndex: p.posIndex,
													  segmentIndex: p.segmentIndex };
												  result[compno].colors = new Uint8Array(_map(result[compno].t,_ => [Math.floor(Math.random()*255),128,128]).flat());
												  return result;
											  }, {}));
								  });

				
			}
		}
    }

    const connectionStatus = {
        [ReadyState.CONNECTING]:     "<span style=\"color:'orange'\">Connecting</span>",
        [ReadyState.OPEN]:           "Connected <Icon type='time'/>",
        [ReadyState.CLOSING]:        "<span style=\"color:'red'\">Closed</span>",
        [ReadyState.CLOSED]:         "<span style=\"color:'red'\">Closed</span>",
        [ReadyState.UNINSTANTIATED]: "<span style=\"color:'orange'\">Preparing</span>",
    }[readyState];

    if( socketUrl != proposedUrl(vc,datecode)) {
		setPilots({});
		setTrackData({});
        setSocketUrl(proposedUrl(vc,datecode));
    }

    // Merge it into the displayed information
    if( updateMessage ) {

        // Keep alive - updates listeners and active planes
        if( 'keepalive' in updateMessage ) {
            wsStatus.c = updateMessage.listeners;
            wsStatus.p = updateMessage.airborne;
			setWsStatus( wsStatus );

//			if( Object.keys(pilotsGeoJSON).length > 0 ) {
//				checkGrey( pilotsGeoJSON, updateMessage.at );
//				setPilotsGeoJSON( pilotsGeoJSON );
//			}
        }

        // Scores so we are always displaying the right one
        if( 'pilots' in updateMessage ) {

			if( scoresAF ) {
				cancelAnimationFrame(scoresAF);
			}
            scoresAF = requestAnimationFrame( () => {
				if( selectedPilot ) {
					updateMessage.pilots[selectedPilot.compno].follow = selectedPilot.follow;
				}
                console.log( "updating scores from websocket" );
                setPilots(updateMessage.pilots);
				scoresAF = undefined;
            });
        }

		if( 'tracks' in updateMessage ) {
//			setPilotsGeoJSON( updateMessage );
		}

		if( 'fulltracks' in updateMessage ) {
//			setPilotsFullGeoJSON( updateMessage.fulltracks );
		}

        // Track point
        if( 'c' in updateMessage ) {
			if( pointAF ) {
				cancelAnimationFrame(pointAF);
			}
            pointAF = requestAnimationFrame( () => {
				mergePointToPilots( updateMessage, mapRef, selectedPilot,
									{ pilots:pilots, setPilots:setPilots,
									  trackData:trackData, setTrackData:setTrackData},
									viewport, setViewport );
				pointAF = undefined;
            });
        }
    }

	
	function setCompno(cn) {
		setSelectedCompno(cn);
/*		if(cn&&pilots[cn]) {
			let pilot = pilots[cn];
			pilot.follow = true;
			if( pilot.lat && pilot.lng ) {
				console.log( pilot.lat, pilot.lng, viewport.latitude, viewport.longitude );
				setViewport( {...viewport, latitude:pilot.lat, longitude:pilot.lng} );
			}

			// Bring it to the top
			_foreach( pilotsGeoJSON.locations.features, (f) => { f.properties.s = Math.max(0,f.properties.s-1,f.properties.c==cn?100:0)});
			setPilotsGeoJSON(  pilotsGeoJSON );
		} */
	}
    // And the pilot object
    const selectedPilot = pilots ? pilots[selectedCompno] : undefined;

	// Cache the calculated times and only refresh every 60 seconds
	const status= useMemo( () => `${connectionStatus} @ ${wsStatus && wsStatus.at ? formatTimes(wsStatus.at,tz) : '' }` +
   ` | <a href='#' title='number of viewers'>${wsStatus.c} 👥</a> | <a href='#' title='number of planes currently tracked'>${wsStatus.p} ✈️  </a>`, [connectionStatus,Math.round(wsStatus.at/60),wsStatus.p,wsStatus.c] );

	return (
		<>
		<div className={'resizingMap'}>
			<MApp vc={vc}
				  datecode={datecode}
				  selectedPilot={selectedPilot} setSelectedCompno={(x)=>setCompno(x)}
				  mapRef={mapRef}
				  pilots={pilots}
				  options={options} setOptions={setOptions}
				  tz={tz}
				  t={wsStatus.at}
				  viewport={viewport} setViewport={setViewport}
				  trackData={trackData}
				  selectedCompno={selectedCompno}
				  status={status}/>
		</div>
			<div className="resultsOverlay">
				<TaskDetails vc={vc} position={'top'}/>
				<PilotList vc={vc} pilots={pilots}
						   selectedPilot={selectedPilot}
						   setSelectedCompno={(x)=>setCompno(x)}
						   options={options} setViewport={setViewport}/>
			</div>
			<Details pilot={selectedPilot} units={options.units}/>
		</>
	);

/*		<TaskMap vc={vc}
					 datecode={datecode}
					 selectedPilot={selectedPilot} setSelectedCompno={(x)=>setCompno(x)}
					 mapRef={mapRef}
					 pilots={pilots}
					 options={options} setOptions={setOptions}
					 tz={tz}
					 viewport={viewport} setViewport={setViewport}
					 pilotsGeoJSON={pilotsGeoJSON}
					 pilotFullGeoJSON={selectedPilot?pilotsFullGeoJSON[selectedCompno]:null}
					 status={status}/> */

}
	
function formatTimes(t,tz) {
	// Figure out what the local language is for international date strings
	const lang = (navigator.languages != undefined) ? navigator.languages[0] :  navigator.language;
	
	// And then produce a string to display it locally
	const dt = new Date(t*1000);
	return `<a href='#' title='competition time'>${dt.toLocaleTimeString( lang, {timeZone: tz, hour: "2-digit", minute: "2-digit"})} ✈️ </a>` +
		   `<a href='#' title='your time'>${dt.toLocaleTimeString(lang,{hour: "2-digit", minute: "2-digit"})} ⌚️</a>`
}

function mergePointToPilots( point, mapRef, selectedPilot,
							 data,
							 viewport, setViewport ) {

    if( ! data.pilots ) {
        return;
    }

    // We need to do a deep clone for the change detection to work
    const compno = point.c;
    const p = data.pilots; //_clonedeep(data.pilots);
    const cp = p[compno];

    // If the pilot isn't here noop
    if( ! cp ) {
        return;
    }

    // If we are getting the same update twice - this happens because
    // of the mutation forcing a rebuild of the map, which results in the whole
    // thing being redrawn.
    if( cp.lastUpdated == point.t ) {
        return;
    }
    cp.lastUpdated = point.t;

	// Merge into the geoJSON objects as needed
	if( mergePoint( point, data ) ) {
	}
	
	
    // If we are selected update the full track as well
    if( selectedPilot && selectedPilot.compno == compno && selectedPilot.follow ) {
//		setViewport( {...viewport, latitude:point.lat, longitude:point.lng });
    }

    // Force a re-render
    // cancel the scheduled update & trigger synchronous redraw
    // see https://github.com/mapbox/mapbox-gl-js/issues/7893#issue-408992184
    // NOTE: THIS MIGHT BREAK WHEN UPDATING MAPBOX
//    if (map._frame) {
//        map._frame.cancel();
//        map._frame = null;
//    }


		// Update the pilot information, this will cause a redraw but we can't do that inside
		// a redraw as it barfs. So schedule a timeout in 1ms which is basically immediately
		// that tells the screen it needs to be redrawn. false means don't reload data from
		// server
		data.setPilots(data.pilots);
		data.setTrackData( data.trackData );
}

export function AlertDisconnected({mutatePilots,attempt}) {
    const [show, setShow] = useState(attempt);
    const [pending, setPending] = useState(attempt);

    if (show == attempt) {
        return (
            <Alert variant="danger" onClose={() => setShow(attempt+1)} dismissible>
                <Alert.Heading>Disconnected</Alert.Heading>
                <p>
                    Your streaming connection has been disconnected, you can reconnect or
                    just look at the results without live tracking
                </p>
                <hr/>
                <Button variant="success" onClick={() => {mutatePilots();setPending(attempt+1);}}>Reconnect{(pending==(attempt+1))?<Spinner/>:null}</Button>
            </Alert>
        );
    }
    return null;
}

