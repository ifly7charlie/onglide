
//
// This is responsible for creating and displaying the task map on the screen
//
// It loads GeoJSON from the next.js server API and renders it on the screen
//
// It will also expose the helper functions required to update the screen
//

import { useState, useMemo, useRef } from 'react';

import { useTaskGeoJSON, Spinner, Error } from './loaders.js';
import { Nbsp, Icon } from './htmlhelper.js';

import useWebSocket, { ReadyState } from 'react-use-websocket';

import _find  from 'lodash.find'
import _clonedeep from 'lodash.clonedeep';
import _foreach from 'lodash.foreach';
import _reduce from 'lodash.reduce';
import _map from 'lodash.map';
import _chunk from 'lodash.chunk';

const { mergePoint, checkGrey }  = require('../incremental.js');

import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'

import { PilotList, Details } from './pilotlist.js';
import { TaskDetails } from './taskdetails.js';

import protobuf from 'protobufjs/light.js';
import { OnglideWebSocketMessage } from '../onglide-protobuf.js';
import { point,lineString } from  '@turf/helpers';

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

let pbRoot = protobuf.Root.fromJSON(OnglideWebSocketMessage);
let pbOnglideWebsocketMessage = pbRoot.lookupType( "OnglideWebSocketMessage" );
function decodePB( msg ) {
	return pbOnglideWebsocketMessage.decode(new Uint8Array(msg));
}
function plainObjectFromPB( msg ) {
	return msg; // pbOnglideWebsocketMessage.(msg);
}

export function OgnFeed( {vc,datecode,tz,
						  selectedCompno,setSelectedCompno,
						  viewport,setViewport,
						  options,setOptions} )
{
	const [ trackData, setTrackData ] = useState({});
	const [ pilots, setPilots ] = useState({});
    const [ socketUrl, setSocketUrl ] = useState(proposedUrl(vc,datecode)); //url for the socket
    const [ wsStatus, setWsStatus ] = useState({'c':1,'p':0,'timeStamp':0});
    const [ attempt, setAttempt ] = useState(0);
	
    // For remote updating of the map
    const mapRef = useRef(null);

	// Keep track of online/offline status of the page
	const [ online, isOnline ] = useState(navigator.onLine);
		
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
        if( wsStatus.timeStamp != lastMessage.timeStamp ) {
			wsStatus.timeStamp = lastMessage.timeStamp;
			decodeWebsocketMessage( lastMessage.data, trackData, setTrackData, pilots, setPilots, wsStatus, setWsStatus, selectedCompno );
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

	function setCompno(cn) {
		setSelectedCompno(cn);
		if(cn&&pilots[cn]) {
			let pilot = pilots[cn];
			pilot.follow = true;
		} 
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
				  pilots={pilots} setPilots={setPilots}
				  options={options} setOptions={setOptions}
				  tz={tz}
				  t={wsStatus.at}
				  viewport={viewport} setViewport={setViewport}
				  trackData={trackData}
				  selectedCompno={selectedCompno}
				  status={status}/>
		</div>
			<div className="resultsOverlay">
			<div className='resultsUnderlay'>
				<TaskDetails vc={vc} position={'top'}/>
				<PilotList vc={vc} pilots={pilots}
						   selectedPilot={selectedPilot}
						   setSelectedCompno={(x)=>setCompno(x)}
						   now={wsStatus.at}
						   options={options} setViewport={setViewport}/>
			</div>
			</div>
			<Details pilot={selectedPilot} units={options.units}/>
		</>
	);
}
	
function formatTimes(t,tz) {
	// Figure out what the local language is for international date strings
	const lang = (navigator.languages != undefined) ? navigator.languages[0] :  navigator.language;
	
	// And then produce a string to display it locally
	const dt = new Date(t*1000);
	return `<a href='#' title='competition time'>${dt.toLocaleTimeString( lang, {timeZone: tz, hour: "2-digit", minute: "2-digit"})} ✈️ </a>` +
		   `<a href='#' title='your time'>${dt.toLocaleTimeString(lang,{hour: "2-digit", minute: "2-digit"})} ⌚️</a>`
}

function mergePointToPilots( point, data )
{
    // We need to do a deep clone for the change detection to work
    const compno = point.c;
    const cp = data.pilots?.[compno];

    // If the pilot isn't here or this is a duplicate update then noop
    if( cp?.lastUpdated == point.t ) {
		return;
	}

	// Merge into the geoJSON objects as needed
	mergePoint( point, data );
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


function decodeWebsocketMessage( data, trackData, setTrackData, pilots, setPilots, wsStatus, setWsStatus, selectedCompno )
{
	new Response(data).arrayBuffer()
					  .then((ab) => {
						  let buffer = decodePB(new Uint8Array(ab));

						  // Merge in changed tracks
						  if( buffer.tracks ) {
							  setTrackData(
								  _reduce( buffer.tracks.pilots, (result,p,compno) =>
									  {
										  result[compno] = {
											  compno: compno,
											  indices: new Uint32Array(p.indices.slice().buffer),
											  positions: new Float32Array(p.positions.slice().buffer),
											  t: new Uint32Array(p.t.slice().buffer),
											  climbRate: new Int8Array(p.climbRate.slice().buffer),
											  recentIndices: new Uint32Array(p.recentIndices.slice().buffer),
											  agl: new Int16Array(p.agl.slice().buffer),
											  posIndex: p.posIndex,
											  segmentIndex: p.segmentIndex };
										  result[compno].colors = new Uint8Array(_map(result[compno].t,_ => [Math.floor(Math.random()*255),128,128]).flat());
										  return result;
									  }, trackData ));
						  }

						  // If we have been sent scores then merge them in,
						  // this will update what has changed so no need to send scores if they are unchanged since previous
						  // message
						  if( buffer.scores ) {
							  setPilots(
								  _reduce( plainObjectFromPB(buffer).scores.pilots, (result,p,compno) =>
									  {
										  // If this pilot being followed?
										  p.follow = (compno == selectedCompno ) && pilots[compno]?.follow;
										  
										  // Update the geoJSON with the scored trackline so we can easily display
										  // what the pilot has been scored for
										  if( p.scoredpoints && p.scoredpoints.length>1 ) {
											  p.scoredGeoJSON = lineString(_chunk(p.scoredpoints,2),{})
										  }

										  // Save into the pilot structure
										  result[compno] = p;
										  return result;
									  }, pilots ));
						  }

						  // Merge in any new position reports, one update for all
						  if( buffer.positions ) {
							  _foreach( buffer.positions.positions, (p) => {
								  mergePointToPilots( p, { pilots:pilots, trackData:trackData });
							  });
							  setPilots( pilots );
							  setTrackData( trackData );
						  }

						  if( buffer.ka ) {
							  wsStatus = { ...wsStatus,
										   ...buffer.ka };
							  setWsStatus( wsStatus );
						  }

						  if( buffer.t ) { 
							  wsStatus = { ...wsStatus, at: buffer.t };
							  setWsStatus( wsStatus );
						  }
					  });

}
