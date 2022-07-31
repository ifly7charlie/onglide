#!/usr/bin/env node

// Copyright 2020 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

// Import the APRS server
import { ISSocket } from 'js-aprs-is';
import { aprsParser } from  'js-aprs-fap';

// Helper function
import distance from '@turf/distance';
import { point } from '@turf/helpers';
import LatLong from '../lib/flightprocessing/LatLong.js';

// And the Websocket
import { WebSocket, WebSocketServer } from 'ws';

// And status display
import http from 'http';
import tx2 from 'tx2';

import protobuf from 'protobufjs/light.js';
import { OnglideWebSocketMessage } from '../lib/onglide-protobuf.mjs';

// Helper
import fetch from 'node-fetch';
const fetcher = url => fetch(url).then(res => res.json());

// DB access
//const db from '../db')
import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';

import { mergePoint } from '../lib/flightprocessing/incremental.mjs';

let db = undefined;

// lodash
import _filter from 'lodash.filter';
import _pick from 'lodash.pick';
import _map from 'lodash.map';
import _flatmap from 'lodash.flatmap';
import _reduce from 'lodash.reduce';
import _keyby from 'lodash.keyby';
import _foreach from 'lodash.foreach';
import _sortby from 'lodash.sortby';
import _remove from 'lodash.remove';
import _groupby from 'lodash.groupby';
import _sortedIndexBy from 'lodash.sortedindexby';
import _clonedeep from 'lodash.clonedeep';

// Score a single pilot
import { scorePilot, fetchTaskAndPilots } from  '../lib/flightprocessing/scorepilot.js';
import { generatePilotTracks } from '../lib/flightprocessing/tracks.js';

// Data sources
import { startAprsListener, connection } from '../lib/ws/aprs.js';
import { startDBReplay, establishOffset } from '../lib/ws/dbreplay.js';
import { startFileReplay } from '../lib/ws/filereplay.js';

import dotenv from 'dotenv';

// Handle fetching elevation and confirming size of the cache for tiles
import geo from '../lib/getelevationoffset.js';
const { getElevationOffset, getCacheSize } = geo;

// handle unkownn gliders
import { capturePossibleLaunchLanding } from '../lib/flightprocessing/launchlanding.js';

import { setSiteTz } from '../lib/flightprocessing/timehelper.js';

// Where is the comp based
let location = {};

let channels = {} /*EG: { 'PMSRMAM202007I': { className: 'blue', clients: [], launching: false, datecode: '070' },
                    'PMSRMAM202007H': { className: 'red', clients: [], launching: false, datecode: '070' },
                    }; */

// Associative array of all the trackers
let gliders = {}; /*EG: { 'T': { compno: 'T', className: 'blue', channel: channels['PMSRMAM202007I'] },
                    'P': { compno: 'P', className: 'blue', channel: channels['PMSRMAM202007I'] },
                    };*/
let trackers = {} /*EG: { 'F9C918': gliders['T'],
                    'D004F4': gliders['P'],
                    'ADD287': gliders['T']}; */

let activeGliders = {}


let unknownTrackers = {}; // All the ones we have seen in launch area but matched or not matched
let ddb = {}; // device_id: { ddb object }

let scoring = {}; // detail for scoring, keyed by channelname (class+datecode), includes trackers, state and deck

let pbRoot = protobuf.Root.fromJSON(OnglideWebSocketMessage);
let pbOnglideWebsocketMessage = pbRoot.lookupType( "OnglideWebSocketMessage" );
function encodePb( msg ) {
	let message = pbOnglideWebsocketMessage.create( msg );
	return pbOnglideWebsocketMessage.encode(message).finish();
}

//
// Replay may offset time
let tOffset = 0;
let tBase = 0;

// Performance counter
let metrics = { 
    terrainCache: tx2.metric( { name: 'terrain cache', value: () => getCacheSize()}),
    knownGliders: tx2.metric( { name: 'gliders (known,total)', value: () =>  [Object.keys(trackers).length, Object.keys(gliders).length] }),
    unknownGliders: tx2.metric( { name: 'unknown gliders in area', value: () => Object.keys(unknownTrackers).length }),
    ognPerSecond: tx2.meter( { name: "ogn msgs/sec", samples: 1, timeframe: 60 }),
    activeGliders: tx2.metric( { name: 'tracked gliders', value: () => _map(channels,(v)=>Object.keys(v?.activeGliders).length) }),
    viewers: tx2.metric( { name: 'viewers', value: () => _map(channels,(v)=>v?.clients?.length) }),
};

// Load the current file & Get the parsed version of the configuration
dotenv.config({ path: '.env.local' })
let readOnly = process.env.OGN_READ_ONLY == undefined ? false : (!!(parseInt(process.env.OGN_READ_ONLY)));

async function main() {

    if (dotenv.error) {
        console.log( "New install: no configuration found, or script not being run in the root directory" );
        process.exit();
    }

    db = mysql( { config:{
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        onError: (e) => { console.log(e); }
    }});

    // Location comes from the competition table in the database
    location = (await db.query( 'SELECT lt,lg,tz FROM competition LIMIT 1' ))[0];
    location.point = point( [location.lt, location.lg] );

	// Save the tz for use
	setSiteTz( location.tz );
	
	console.log( 'Onglide OGN handler', readOnly ? '(read only)' : '', process.env.NEXT_PUBLIC_SITEURL );
	console.log( `db ${process.env.MYSQL_DATABASE} on ${process.env.MYSQL_HOST}` );
	
    // Set the altitude offset for launching, this will take time to return
    // so there is a period when location altitude will be wrong for launches
    getElevationOffset( location.lt, location.lg,
                        (agl) => { location.altitude = agl;console.log('SITE:'+agl) });

	// Check if an offset should be used
	[ tOffset, tBase ] = establishOffset();
	console.log( tOffset, ',', tBase );
    // Download the list of trackers so we know who to look for
    await updateTrackers();
    await updateDDB();
	await sendScores();

    startStatusServer();

	// We want to start listening to the APRS feed as well
	if( process.env.REPLAY_FILE ) {
		startFileReplay( process.env.REPLAY_FILE, {}, location, getAssociation, processAPRSPacket, metrics );
	}
	else if( process.env.NEXT_PUBLIC_TOFFSET ) {
		readOnly = true;
		startDBReplay( db, {}, location, getAssociation, processAPRSPacket, gliders, metrics );
	}
	else {
		startAprsListener( location, getAssociation, processAPRSPacket, metrics );
	}
	
    // And start our websocket server
    const wss = new WebSocketServer({
		port: (process.env.WEBSOCKET_PORT||8080),
/*		perMessageDeflate: { ***** NOT REALLY SO USEFUL NOW PROTOBUF, only 20% reduction
			zlibDeflateOptions: {
				// See zlib defaults.
				chunkSize: 1024,
				memLevel: 7,
				level: 3
			},
			zlibInflateOptions: {
				chunkSize: 10 * 1024
			},
			// Other options settable:
			clientNoContextTakeover: true, // Defaults to negotiated value.
			serverNoContextTakeover: true, // Defaults to negotiated value.
			serverMaxWindowBits: 10, // Defaults to negotiated value.
			// Below options specified as default values.
			concurrencyLimit: 10, // Limits zlib concurrency for perf.
			threshold: 16384 // Size (in bytes) below which messages
			// should not be compressed.
		}*/});
	
    // What to do when a client connects
    wss.on( 'connection', (ws,req) => {

        // Strip leading /
        const channel = req.url.substring(1,req.url.length);

        ws.ognChannel = channel;
        ws.ognPeer = req.headers['x-forwarded-for'];
        console.log( `connection received for ${channel} from ${ws.ognPeer}` );

        ws.isAlive = true;
        if( channel in channels ) {
            channels[channel].clients.push( ws );
        }
        else {
            console.log( 'Unknown channel ' + channel );
            ws.isAlive = false;
        }

        ws.on('pong', () => { ws.isAlive = true });
        ws.on('close', () => { ws.isAlive = false; console.log( `close received from ${ws.ognPeer} ${ws.ognChannel}`); });
		ws.on('message', (m) => {
			sendPilotTrack( ws, ''+m, scoring[channels[channel].name]?.deck );
		});

        // Send vario etc for all gliders we are tracking
        sendCurrentState(ws);
    });

	//
	// This function is to send updated flight tracks for the gliders that have reported since the last
	// time we run the callback (every second), as we only update the screen once a second it should
	// be sufficient to bundle them even though we are receiving as a stream
	setInterval( function() {
		// For each channel (aka class)
		Object.values(channels).forEach( async function (channel) {

			// Encode all the changes, we only keep latest per glider if multiple received
			// there shouldn't be multiple!
			const msg = encodePb( { positions: { positions: channel.toSend }, t: (Math.trunc(Date.now()/1000)+tOffset) } );
			channel.toSend = [];
			
			// Send to each client and if they don't respond they will be cleaned up next time around
			channel.clients.forEach( (client) => {
				if (client.readyState === WebSocket.OPEN) {
					client.send( msg, { binary: true } );
				}
			});
		});
	}, 1000 );
			

	// And every 4-6 minutes rescore and update everything - the random is to make sure
	// multiple processes don't intersect
	setInterval( function() {
		try { 
			if( ! tOffset ) {
				updateTrackers();
			}
		} catch(e) {
			console.log(e);
		}
    }, (10*60*1000+(2*60000*Math.random())) );

	// And every 4-6 minutes rescore and update everything - the random is to make sure
	// multiple processes don't intersect
	setInterval( function() {
		try {
			console.log( 'sending scores' );
			sendScores();
		} catch(e) {
			console.log(e);
		}
    }, (1*20*1000+(10000*Math.random())) );
}

main()
    .then("exiting");



//
// Fetch the trackers from the database
async function updateTrackers() {

	console.log( "updateTrackers()" );

    // Fetch the trackers from the database and the channel they are supposed to be in
    const classes = await db.query( 'SELECT class, datecode FROM compstatus' );

    // Now convert that into the main structure
    function channelName(className,datecode) {
        return (className+datecode).toUpperCase();
    }

    // Make sure the class structure is correct, this won't touch existing connections
    let newchannels = [];
	for( const c of classes ) {
		const cname = channelName(c.class,c.datecode);
        const channel = channels[ cname ];

        // Update the saved data with the new values
        channels[ cname ] = { clients: [], launching: false, activeGliders: {},
                              ...channel,
                              className: c.class, datecode: c.datecode,
							  name: cname,
							  toSend: [],
                            };

        newchannels.push(cname);

        // make sure the task is cached properly
		const [ task ] = await fetchTaskAndPilots( c.class, false );

		// Make sure we have an entry for the scoring and do a dummy
		// fetch to get the task prepped and merge the scoring data into the
		// trackers array
		if( ! scoring[cname] ) {
			scoring[cname] = { trackers: {}, state: {}, points: {}, geoJSON:{ tracks: {}, fulltracks: {}, locations: {}} };
			
			// merge pilots into the tracker array, won't score as no pilot selected
			await scorePilot( c.class, undefined, scoring[cname] );

			if( ! Object.keys(scoring[cname].trackers).length ) {
				console.log( "No valid task" );
				continue;
			}

			// Now we will fetch the points for the pilots
			const rawpoints = await db.query(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s
                  FROM trackpoints
                 WHERE datecode=${c.datecode} AND (${tBase} = 0 OR t < ${tBase}) AND class=${c.class}
                 ORDER BY t DESC`);

	
			// Group them by comp number, this is quicker than multiple sub queries from the DB
			scoring[cname].points = _groupby( rawpoints, 'c' );
            console.log( `${cname} reloaded all points` );
		}
            
		if( ! Object.keys(scoring[cname].trackers).length ) {
			console.log( "No valid task", cname );
			continue;
		}

		const cscores = scoring[cname];

		// Score them so we have some data to pass back over websocket
		// This also forces a full rescore by removing state and resetting
		// firstOldPoint to the end of the points. We don't need to fetch the points as
		// we have been maintinig a full list in order
		for( const compno of Object.keys(cscores.points) ) {
			cscores.state[compno] = {};
            if( ! cscores.trackers[compno] ) {
                cscores.trackers[compno]={};
            }
			cscores.trackers[compno].firstOldPoint = cscores.points[compno]?.length;
            try {
				if( task ) {
					await scorePilot( c.class, compno, cscores );
				}
            } catch(e) {
                console.log( `unable to scorePilot ${c.class}: ${compno}, ${e}` );
            }
		}

		// And fully regenerate the GeoJSONs so they include any late points
		await generatePilotTracks( cscores, tOffset );
        sendPilotTracks( cname, cscores.deck );
    }

    // How the trackers are indexed into the array, it must include className as compno may not be unique
    function mergedName(t) { return t.className+'_'+t.compno; }

    // Now get the trackers
    const cTrackers = await db.query( 'select p.compno, p.greg, trackerid, UPPER(concat(t.class,c.datecode)) channel, 0 duplicate, ' +
                                         ' p.class className ' +
                                         ' from pilots p left outer join tracker t on p.class=t.class and p.compno=t.compno left outer join compstatus c on c.class=p.class ' +
                                         '   where p.class = c.class' );

    // Now go through all the gliders and make sure we have linked them
    cTrackers.forEach( (t) => {

        // Spread, this will define/overwrite as needed
        const gliderKey = mergedName(t);

		// If we have changed channel then we have changed datecode as channel is class+datecode
		// and glider is simply keyed on class+compno
		if( gliders[gliderKey] && gliders[gliderKey].channel != t.channel ) {
			console.log( `glider channel changed to ${t.channel} so resetting vario` );
			gliders[gliderKey] = {};
		}
		
        gliders[gliderKey] = { ...gliders[gliderKey], ...t, greg: t?.greg?.replace(/[^A-Z0-9]/i,'') };

		// If we have a point but there wasn't one on the glider then we will store this away
        var lp = scoring[t.channel]?.points[t.compno];
        if( lp && lp.length > 0 && (gliders[gliderKey].lastTime??0) < lp[0].t ) {
//            console.log(`using db altitudes for ${gliderKey}, ${gliders[gliderKey].lastTime??0} < ${lp[0].t}`);
            gliders[gliderKey] = { ...gliders[gliderKey],
                                   altitude: lp[0].a,
                                   agl: lp[0].g,
                                   lastTime: lp[0].t };
        };

        // If we have a tracker for it then we need to link that as well
        if( t.trackerid && t.trackerid != 'unknown' ) {
			_foreach( t.trackerid.split(','), (tid,i) => {
				let t = tid.match(/[0-9A-F]{6}$/i);
				let g = trackers[ t ] = gliders[ gliderKey ];
				(g.trackers||(g.trackers={}))[t] = { order: i,
								  pressure: !!tid.match(/OGN/i) };
			});
        }

    });

    // Filter out anything that doesn't match the input set, doesn't matter if it matches
    // unknowns as they won't be in the trackers pick
    gliders = _pick( gliders, _map( cTrackers, (c) => mergedName(c) ));
	trackers = _pick( trackers, _flatmap( cTrackers, (t) => _map(t.trackerid.split(','),(x) => x.match(/[0-9A-F]{6}$/i)) ));
	
    // identify any competition numbers that may be duplicates and mark them.  This
    // will affect how we match from the DDB
    const duplicates = await db.query( 'SELECT compno,count(*) count,group_concat(class) classes FROM pilots GROUP BY compno HAVING count > 1' );
    duplicates.forEach( (d) => {
        d.classes.split(',').forEach( (c) => {
            gliders[ c+'_'+d.compno ].duplicate = true;
        });
    });

}

//
// Update the DDB cache
async function updateDDB() {

    console.log( "updating ddb" );

    return fetch( "http://ddb.glidernet.org/download/?j=1")
        .then( res => res.json() )
        .then( (ddbraw) => {

            // {"devices":[{"device_type":"F","device_id":"000000","aircraft_model":"HPH 304CZ-17","registration":"OK-7777","cn":"KN","tracked":"Y","identified":"Y"},
            if( ! ddbraw.devices ) {
                console.log( "no devices in ddb" );
                return;
            }

            // Update the cache with the ids by device_id
            ddb = _keyby( ddbraw.devices, 'device_id' );

            // remove the unknown characters from the registration
            _foreach( ddb, function(entry) { entry.registration = entry?.registration?.replace(/[^A-Z0-9]/i,'') });
        })
		.catch((e)=>{console.log("unable to fetch ddb", e )});
}

//
// New connection, send it a packet for each glider we are tracking
async function sendCurrentState(client) {
    if (client.readyState !== WebSocket.OPEN || !client.isAlive || !channels[client.ognChannel]) {
        console.log("unable to sendCurrentState not yet open or ! isAlive" );
        return;
    }

	// Make sure we send the pilots ASAP
	if( channels[client.ognChannel]?.lastScores ) {
        client.send( channels[client.ognChannel].lastScores, { binary: true } );
	}
	else {
		console.log( "no current scores", client.ognChannel );
	}

	// Send them the GeoJSONs, they need to keep this up to date
	sendRecentPilotTracks( channels[client.ognChannel].name, client );

    // If there has already been a keepalive then we will resend it to the client
    const lastKeepAliveMsg = channels[client.ognChannel].lastKeepAliveMsg;
    if( lastKeepAliveMsg ) {
        client.send( lastKeepAliveMsg, { binary: true } );
    }
}

//
// Send the GeoJSON for all the gliders, used when a new client connects to make
// sure they have all the tracks. Client keeps it up to datw
async function sendPilotTracks( channelName, deck ) {
	let PT = pbRoot.lookupType( "PilotTracks" );

	const toStream = _reduce( deck, (result,p,compno) =>
		{
			result[compno] = {
				compno: compno,
				positions: new Uint8Array(p.positions.buffer,0,p.posIndex*3*4),
				indices: new Uint8Array(p.indices.buffer,0,p.segmentIndex*4),
				t: new Uint8Array(p.t.buffer,0,p.posIndex*4),
				climbRate: new Uint8Array(p.climbRate.buffer,0,p.posIndex),
				recentIndices: new Uint8Array(p.recentIndices.buffer),
				agl: new Uint8Array(p.agl.buffer,0,p.posIndex*2),
				posIndex: p.posIndex,
				partial: false,
				segmentIndex: p.segmentIndex };
			return result;
		}, {} );

	// Send the client the current version of the tracks
	const message = encodePb( {tracks: { pilots:toStream }});
    channels[ channelName ]?.clients?.forEach( (client) => {
        if (client.readyState === WebSocket.OPEN) {
			client.send( message, { binary: true } );
        }
	});
}

async function sendPilotTrack( client, compno, deck ) {
	let PT = pbRoot.lookupType( "PilotTracks" );

	const p = deck[compno];
	const toStream = {};
	toStream[compno] = {
				compno: compno,
				positions: new Uint8Array(p.positions.buffer,0,p.posIndex*3*4),
				indices: new Uint8Array(p.indices.buffer,0,p.segmentIndex*4),
				t: new Uint8Array(p.t.buffer,0,p.posIndex*4),
				climbRate: new Uint8Array(p.climbRate.buffer,0,p.posIndex),
				recentIndices: new Uint8Array(p.recentIndices.buffer),
				agl: new Uint8Array(p.agl.buffer,0,p.posIndex*2),
				posIndex: p.posIndex,
				partial: false,
				segmentIndex: p.segmentIndex };

	// Send the client the current version of the tracks
	const message = encodePb( {tracks: { pilots:toStream }});
    if (client.readyState === WebSocket.OPEN) {
		client.send( message, { binary: true } );
	}
}


// Send the abbreviated track for all gliders, used when a new client connects
async function sendRecentPilotTracks( channelName, client ) {
	let PT = pbRoot.lookupType( "PilotTracks" );

	const toStream = _reduce( scoring[channelName]?.deck, (result,p,compno) =>
		{
			const start = p.recentIndices[0];
			const end = p.recentIndices[1];
			const length = end - start;
			const segments = new Uint32Array( [ 0, length ] );
			if( length ) {
				result[compno] = {
					compno: compno,
					positions: new Uint8Array(p.positions.buffer,start*12,length*12),
					indices: new Uint8Array(segments.buffer),
					t: new Uint8Array(p.t.buffer,start*4,length*4),
					climbRate: new Uint8Array(p.climbRate.buffer,start,length),
					recentIndices: new Uint8Array(segments.buffer),
					agl: new Uint8Array(p.agl.buffer,start*2,length*2),
					posIndex: length,
					partial: true,
					segmentIndex: 1 };
			}
			return result;
		}, {} );

	// Send the client the current version of the tracks
	client.send(  encodePb( {tracks:{ pilots: toStream }} ), { binary: true } );
}

// We need to fetch and repeat the scores for each class, enriched with vario information
// This means SWR doesn't need to timed reload which will help with how well the site redisplays
// information
async function sendScores() {

    const now = (Date.now()/1000)+tOffset;

    // For each channel (aka class)
    Object.values(channels).forEach( async function (channel) {

        // Remove any that are still marked as not alive
        const toterminate = _remove( channel.clients, (client) => {
            return (client.isAlive === false);
        });

        toterminate.forEach( (client) => {
            console.log( `terminating client ${client.ognChannel} peer ${client.ognPeer}` );
            client.terminate();
        });

		const airborne = Object.keys(channel.activeGliders)?.length||0;
		
        // If we have nothing then do nothing...
        if( ! channel.clients.length ) {
            console.log( `${channel.className}: no clients subscribed` );
        }
		else {
			console.log( `${channel.className}: ${channel.clients.length} subscribed, ${airborne} gliders airborne` );
		}

        // For sending the keepalive
        channel.lastKeepAliveMsg = encodePb( { ka: {
            "keepalive":1,
            "t":timeToText(now),
            "at":Math.floor(now),
            "listeners":channel.clients.length,
            "airborne":airborne,
        }});

        // Send to each client and if they don't respond they will be cleaned up next time around
        channel.clients.forEach( (client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send( channel.lastKeepAliveMsg, { binary: true } );
            }
            client.isAlive = false;
            client.ping(function(){});
        });
		
		const className = channel.className;
		const scores = scoring[channel.name];
        if( ! scores || ! Object.keys(scores.trackers).length ) {
            console.log( `no pilots scored for ${channel.className} ${channel.datecode}` );
            return;
        }

        // We only need to mix in the gliders that are active
        if( Object.keys(channel.activeGliders).length == 0 && channel.lastScores ) {
            console.log( `${channel.className}: no activity since last scoring so do nothing` );
            return;
        }

        // Reset for next iteration
        channel.activeGliders = {};

		Promise.allSettled( _map( scores.trackers, (tracker) =>
			new Promise((resolve) => {
				try {
					scorePilot( className, tracker.compno, scores, tracker.outOfOrder > 5 ).then( () => resolve() )
				} catch(e) {
                    console.log( `exception scoring ${className}, ${tracker.compno} [FULL:${tracker.outOfOrder > 5}]` );
					console.warn( className, tracker.compno, 'Unable to score', e);
					resolve(); 
				}
			})
		)).then( () => {
						   
			// Make a copy that we can tweak
			const pilots = _clonedeep( scores.trackers );
			
			// Get gliders for the class;
			//              const gliders = _pickby( gliders, (f) => f.className == channel.className );
			function mergedName(t) { return t.class+'_'+t.compno; }
			
			_foreach( pilots, (p,k) => {
				const glider = gliders[mergedName(p)];
				if( ! glider ) {
					console.log( `unable to find glider ${p.compno} in ${p.class}` );
					return;
				}
				
				// Mix in the last real time information
				p.altitude = glider.altitude;
				p.agl = glider.agl;
				
				// And check to see if it has moved in the last 5 minutes, if we don't know omit the key
				if( glider.lastTime ) {
					p.stationary = (glider.lastTime - glider.lastMoved??glider.lastTime) > 5*60;
				}
				
				// If it is recent then we will also include vario
				if( (now - glider.lastTime) < 60 && 'lastvario' in glider ) {
					[ p.lossXsecond,
					  p.gainXsecond,
					  p.total,
					  p.average,
					  p.Xperiod,
					  p.min,
					  p.max ] = glider.lastvario;
				}
				
				p.at = glider.lastTime;

				// Flatten the scored points so we can serialise them with protobuf
				p.scoredpoints = p?.scoredpoints?.flat();
			});
			
			// Protobuf encode the scores message
			channel.lastScores = encodePb( { scores: { pilots: pilots }} );
		
			// Send to each client
			channel.clients.forEach( (client) => {
				if (client.readyState === WebSocket.OPEN) {
					client.send( channel.lastScores, { binary: true } );
				}
			});
		})
		.catch( (err) => {
			console.warn( err );
		})
    });
}

function processAPRSPacket( glider, message, islate ) {

	// Update the vario
	message.v = ! islate ? calculateVario( glider, message.a, message.t ).join(',') : '';

	// Keep track of how many gliders this channel is receiving data for
    let channel = channels[glider.channel];
    if( ! channel ) {
        console.log( `don't know ${glider.compno}/${flarmId}`);
        return;
    }
	
    // how many gliders are we tracking for this channel
    if( !'activeGliders' in channel ) {
        channel.activeGliders = {};
    }
    channel.activeGliders[glider.compno]=1;

	// Check if they are a launch
    if( message.g > 100 && ! channel.launching ) {
        console.log( `Launch detected: ${glider.compno}, class: ${glider.className}`);
        channel.launching = true;
    }
	
	// Now get the data structures
	let sc = scoring[glider.channel];
	if( ! sc ) {
		return;
	}
	
	// Slice it into the points array	
	if( ! sc.points[glider.compno] ) {
		sc.points[glider.compno] = [];
	}
	if( ! sc.trackers[glider.compno] ) {
		sc.trackers[glider.compno] = [];
	}					   
	const insertIndex = _sortedIndexBy(sc.points[glider.compno], message, (o) => -o.t);
	
	// In dense coverage it's not uncommon to get a duplicate packet. We always take the first one we
	// have received. The packets may be very different and ideally we would identify problem receivers
	// and then choose when to accept their messages or not
	if( sc.points[glider.compno][insertIndex]?.t ==  message.t ) {
		return;
	}
	
    // If the packet isn't delayed then we should send it out over our websocket
    if( ! islate ) {
		
		// Buffer the message they get batched every second
		channel.toSend.push( message );
		
		// Merge into the display data structure
		mergePoint( message, sc );
	}

    // Make sure we have geo objects
	message.ll = new LatLong( message.lat, message.lng );
    message.geoJSON = point([message.lng,message.lat]);
    
	// Actually insert the point into the array
	sc.points[glider.compno].splice(insertIndex, 0, message);
	
	// Now update the indexes for this
	const tracker = sc.trackers[glider.compno];
	if( insertIndex <= (sc.trackers[glider.compno]?.firstOldPoint||0) ) {
		//						   console.log( glider.compno, islate ? "late" : "not-late", `inserting at ${insertIndex}` );
		tracker.firstOldPoint = (tracker?.firstOldPoint||0)+1;
	}
	else {
		console.log( glider.compno, islate ? "late" : "not-late", `inserting at ${insertIndex}, but older than firstOldPoint` );
		tracker.outOfOrder = (tracker?.outOfOrder||0)+1;
	}
	
	if( tracker.oldestMerge && tracker.oldestMerge >= insertIndex ) {
		tracker.oldestMerge ++;
	}
	else {
		tracker.oldestMerge = insertIndex+1;
	}
	
    // Pop into the database
	if( ! readOnly ) {
		db.query( escape`INSERT IGNORE INTO trackpoints (class,datecode,compno,lat,lng,altitude,agl,t,bearing,speed,station)
                                                  VALUES ( ${glider.className}, ${channel.datecode}, ${glider.compno},
                                                           ${message.lat}, ${message.lng}, ${message.a}, ${message.g}, ${message.t}, ${message.b}, ${message.s}, ${message.f} )` );
	}
}


function calculateVario( glider, altitude, timestamp ) {

    altitude = Math.floor(altitude);

    // First point we just initialise it with what we had
    if( ! ("vario" in glider) ) {
        glider.vario = [ { t: timestamp, a: altitude } ];
        glider.minmax = { m: altitude, x: altitude };
        return glider.lastvario = [0,0,0,0,0,0,0];
    }

    // Helpers
    let varray = glider.vario;
    let minmax = glider.minmax;

	if( Math.abs(altitude - varray[0].a) / (timestamp - varray[0].timestamp) > 40 ) {
		console.log( glider.compno, "ignoring vario point as change > 40m/s" );
	}

    // add the new point, we need history to calculate a moving
    // average
    varray.push( { t: timestamp, a: altitude } );

    if( altitude < minmax.m ) minmax.m = altitude;
    if( altitude > minmax.x ) minmax.x = altitude;

    // if the period is longer than 40 seconds or 40 points then drop the beginning one
	while( varray.length > 41 || (varray.length > 1 && varray[0].t < timestamp - 40)) {
        varray.shift();
    }

    if( varray.length < 2 ) {
        return glider.lastvario = [0,0,0,0,0,minmax.m,minmax.x]; // this ensures we always have two points
    }

    // Figure out the gain and loss components over the time
    let loss = 0;
    let gain = 0;
    let previousAlt = varray[0].a;
    for( const p of varray ) {
        let diff = p.a - previousAlt;
        if( diff > 0 ) gain += diff;
        if( diff < 0 ) loss -= diff;
        previousAlt = p.a;
    }

    // And the overall amounts
    let total = altitude - varray[0].a;
    let elapsed = timestamp - varray[0].t;

    return glider.lastvario = [ loss, gain, total, Math.floor(total*10/elapsed)/10, elapsed, minmax.m, minmax.x ];
}



//
// Determine if it is close enough to the launch point to be considered launched from this site
//
function getAssociation( flarmId, packet, jPoint ) {

	// Look it up, do we have a match?
    const glider = trackers[flarmId];
	
    // How far from/high above the airfield are we?
    const distanceFromHome = distance( jPoint, location.point );
    const agl = Math.max(packet.altitude-(location.altitude??0),0);

    // capture launches close to the airfield (vertically and horizontally)
    if( distanceFromHome < 15 && agl < 1000 ) {

		// Check if it's a possible launch
		capturePossibleLaunchLanding( flarmId, packet.timestamp, jPoint, agl, (readOnly ? undefined : db), 'flarm' );
		
        // Store in the unknown list for status display
        unknownTrackers[flarmId] = { firstTime: packet.timestamp, ...unknownTrackers[flarmId], lastTime: packet.timestamp, flarmid: flarmId };

        // Do we have it in the DDB?
        const ddbf = ddb[flarmId];

		// If we have matched before then don't do it again
		if( unknownTrackers[flarmId].message ) {
			return glider;
		}

        // This works by checking what is configured in the ddb
        if( ddbf && (ddbf.cn != "" || ddbf.greg != "")) {

            // Find all our gliders that could match, may be 0, 1 or possibly 2
            const matches = _filter( gliders, (x) => { return ((!x.duplicate) && ddbf.cn == x.compno) || (ddbf.registration == x.greg && (x.greg||'') != '')} );

            if( ! Object.keys(matches).length ) {
                unknownTrackers[flarmId].message = glider ? `No DDB match, tracker already associated with ${glider.compno}`
					: `Not in competition ${ddbf.cn} (${ddbf.registration}) - ${ddbf.aircraft_model}`;
				return glider;
            }

            if( matches.length > 1 ) {
                console.log( flarmId + ": warning more than one candidate matched from ddb (" + matches.toString() + ")");
                unknownTrackers[flarmId].message = 'Multiple DDB matches '+matches.toString();
            }

            // And we will use the first one
            const match = matches[0];

            unknownTrackers[flarmId].matched = `${match.compno} ${match.className} (${ddbf.registration}/${ddbf.cn})`;

			// Check to see if it's a swap between gliders, if it is then we will remove the link to the old one
			if( glider !== undefined ) {

				// Same glider then ignore
				if( match.compno == glider.compno && match.className == glider.className ) {
					unknownTrackers[flarmId].message = `${flarmId}:  flarm already matched to ${glider.compno} (${glider.className})`;
					return glider;
				}

				// New compno then we need to break old association
				else {
					unknownTrackers[flarmId].message = `${flarmId}:  flarm mismatch, previously matched to ${glider.compno} (${glider.className})`;
					console.log( unknownTrackers[flarmId].message );
					return glider;
					// unknownTrackers[flarmId].matched = `flarm change: ${match.compno} ${match.className} (${match.registration}) previously ${glider.compno}`;
					// glider.trackerid = 'unknown';
					
					// if( ! readOnly ) {
					// 	db.transaction()
					// 		.query( escape`UPDATE tracker SET trackerid = 'unknown' WHERE
                    //                       compno = ${glider.compno} AND class = ${glider.className} limit 1` )
					// 		.query( escape`INSERT INTO trackerhistory (compno,changed,flarmid,launchtime,method) VALUES ( ${match.compno}, now(), 'chgreg', now(), "ognddb" )`)
					// 		.commit();
					// }
				}
			}

			// If it's another match for somebody we have matched then ignore it
			if( match.trackerid != flarmId && match.trackerid != 'unknown' ) {
				unknownTrackers[flarmId].message = `${flarmId} matches ${match.compno} from DDB but ${match.compno} has already got ID ${match.trackerid}`;
				console.log( unknownTrackers[flarmId].message );
				match.duplicate = true;
				return glider;
			}
							 
			unknownTrackers[flarmId].message = `${flarmId}:  found in ddb, matched to ${match.compno} (${match.className})`;
			console.log( unknownTrackers[flarmId].message );
			
			// Link the two together
			match.trackerid = flarmId;
			trackers[flarmId] = match;
			
			// Save in the database so we will reuse them later ;)
			if( ! readOnly ) {
				db.transaction()
					.query( escape`UPDATE tracker SET trackerid = ${flarmId} WHERE
                                      compno = ${match.compno} AND class = ${match.className} AND trackerid="unknown" limit 1` )
					.query( escape`INSERT INTO trackerhistory (compno,changed,flarmid,launchtime,method) VALUES ( ${match.compno}, now(), ${flarmId}, now(), "ognddb" )`)
					.commit();
			}
        }
    }
	return glider;
}


//
// Simple webserver to display the status
//
async function startStatusServer() {
    // status display, very simple
    function displayGlider(v) {
        return v.lastTime?`<tr><td>${v.compno}</td><td>${v.className}</td><td>${timeToText(v?.lastTime)}</td><td>${v?.lastAlt}</td><td>${v.lastvario?.[3]}</td></tr>`:'';
    }
    function displayUnknownTrackers(v) {
        return `<tr><td>${v.flarmid}</td><td>${v?.message??''}</td><td>${v?.matched??''}</td><td>${[timeToText(v?.firstTime),timeToText(v?.lastTime)].join(' - ')}</td>`;
    }
    function displayChannel(v) {
        return `<tr><td>${v.className}</td><td>${v?.clients?.length}</td><td>${v.launching}</td></tr>`;
    }
    function displayCache() {
        return `Terrain Cache Entries: ${getCacheSize()}<br/>DDB Entries: ${Object.keys(ddb).length}<br/>`;
    }
    http.createServer(function (req, res) {
        res.write( `<html><head><meta http-equiv="refresh" content="30"/></head><body>
                       <h1>Trackers</h1>
                         <table width="100%">
                            <thead><td>Compno</td><td>Class</td><td>Last Message</td><td>Altitude</td><td>Vario</td></thead>
                            ${_map(_sortby(gliders,'lastTime'),displayGlider).join('')}
                         </table>
                       <h2>Websockets</h2>
                         <table width="100%">
                            <thead><td>Class</td><td>Number of Clients</td><td>Launching</td></thead>
                            ${_map(channels,displayChannel).join('')}
                         </table>
                       <h2>Unkown Trackers (${Object.keys(unknownTrackers).length})</h2>
                         <table width="100%">
                            <thead><td>FlarmID</td><td>Message</td><td>Match</td><td>Time</td></thead>
                            ${_map(_sortby(unknownTrackers,'lastTime').slice(0,150),displayUnknownTrackers).join('')}
                         </table>
                      <h2>Other</h2>
                          ${displayCache()}
                          ${connection?.aprsc??'unknown'}
                     </body></html>`);
        res.end(); //end the response
    }).listen(process.env.STATUS_SERVER_PORT||8081);
}

// Display a time as competition time, use 24hr clock (en-GB)
function timeToText( t ) {
    if( ! t ) return '';
    var cT = new Date(t*1000);
	return cT.toLocaleTimeString( 'en-GB', {timeZone: location.tz, hour: "2-digit", minute: "2-digit"});
}
