// Import the APRS server
import { ISSocket } from 'js-aprs-is';
import { aprsParser } from  'js-aprs-fap';

// Correction factors
import { altitudeOffsetAdjust } from '../offsets.js';
import { getElevationOffset } from '../getelevationoffset.js'
//import { getOffset } from '../egm96.mjs';

// Helper function for geometry
import distance from '@turf/distance';
import { point } from '@turf/helpers';


// For smoothing altitudes
import KalmanFilter from 'kalmanjs';
import Stats from 'stats-incremental';

// APRS connection
export let connection = {};

// PM2 Metrics
let metrics = undefined;

let statistics = {
    msgsReceived: 0,
    aprsDelay: 0,
    periodStart: 0,
};
    

//
// Connect to the APRS Server
export function startAprsListener( location, getAssociation, packetCallback, m = undefined ) {

	// In case we are using pm2 metrics
	metrics = m;

    // Settings for connecting to the APRS server
    const CALLSIGN = process.env.NEXT_PUBLIC_SITEURL;
    const PASSCODE = -1;
    const APRSSERVER = 'glidern4.glidernet.org';
    const PORTNUMBER = 14580;
    const FILTER = `r/${location.lt}/${location.lg}/250`;
	
    // Connect to the APRS server
    connection = new ISSocket(APRSSERVER, PORTNUMBER, 'OG', '', FILTER );
    let parser = new aprsParser();

    // Handle a connect
    connection.on('connect', () => {
        connection.sendLine( connection.userLogin );
        connection.sendLine(`# onglide ${CALLSIGN} ${process.env.NEXT_PUBLIC_WEBSOCKET_HOST}`);
    });

    // Handle a data packet
    connection.on('packet', (data) => {
        connection.valid = true;
        if(data.charAt(0) != '#' && !data.startsWith('user')) {
            const packet = parser.parseaprs(data);
            if( "latitude" in packet && "longitude" in packet &&
                "comment" in packet && packet.comment?.substr(0,2) == 'id' ) {
				processPacket( packet, getAssociation, packetCallback );
            }
        } else {
            // Server keepalive
            console.log(data);
            if( data.match(/aprsc/) ) {
                connection.aprsc = data;
            }
        }
    });

    // Failed to connect
    connection.on('error', (err) => {
        console.log('Error: ' + err);
        connection.disconnect();
        connection.connect();
    });

    // Start the APRS connection
    connection.connect();

	// And every 2 minutes we need to confirm the APRS
	// connection has had some traffic
	setInterval( function() {

        // Log and reset statistics
        const period = (Date.now() - statistics.periodStart)/1000;
        console.log(period);
        console.log( `APRS: ${statistics.msgsReceived} msgs, ${(statistics.msgsReceived/period).toFixed(1)} msg/s, average aprs delay: ${(statistics.aprsDelay/statistics.msgsReceived).toFixed(1)}s` );
        statistics.msgsReceived = statistics.aprsDelay = 0; statistics.periodStart = Date.now(); 
            
        // send a keepalive
        console.log( 'sending keepalive', `# ${CALLSIGN} ${process.env.NEXT_PUBLIC_WEBSOCKET_HOST}`);
		try {
		    // Send APRS keep alive or we will get dumped
            connection.sendLine(`# ${CALLSIGN} ${process.env.NEXT_PUBLIC_WEBSOCKET_HOST}`);

        } catch(x) {
            console.log( 'unable to send keepalive', x );
            connection.valid = false;
        }

        // Re-establish the APRS connection if we haven't had anything in
        if( ! connection.valid ) {
            console.log( "failed APRS connection, retrying" );
            connection.disconnect( () => { connection.connect() } );
        }
        connection.valid = false;
	}, 1*60*1000);
	
}

//
// collect points, emit to competition db every 30 seconds
export function processPacket( packet, getAssociation, packetCallback, log ) {

    // Count this packet into pm2
    metrics?.ognPerSecond?.mark();

    // Flarm ID we use is last 6 characters, check if OGN tracker or regular flarm
    const flarmId = packet.sourceCallsign.slice( packet.sourceCallsign.length - 6 );
	const ognTracker = (packet.sourceCallsign.slice( 0, 3 ) == 'OGN');

	// Lookup the altitude adjustment for the 
    const sender = packet.digipeaters?.pop()?.callsign||'unknown';
	let   aoa = ognTracker ? 0 : (altitudeOffsetAdjust[ sender ]||0);
    if( aoa == null ) {
        console.log( `ignoring packet from ${sender} as blocked` );
        return;
    }

	// If we had a static correction then we need to recorrect with the correct offset
	// this should make it match other stations better
//	if( aoa ) {
//		aoa += getOffset( packet.latitude, packet.latitude );
//	}

	// Apply the correction
    let altitude = Math.floor(packet.altitude + aoa);

	// geojson for helper function slater
	const jPoint = point( [packet.latitude, packet.longitude] );

    // Check if the packet is late, based on previous packets for the glider
    const now = (new Date()).getTime()/1000;
    const td = Math.floor(now - packet.timestamp);

    statistics.msgsReceived ++;
    statistics.aprsDelay += td;

    // Look it up, have we had packets for this before?
    const glider = getAssociation(flarmId, packet, jPoint);

	// If it is undefined then we drop everything from here on
	if( ! glider ) {
		return;
	}

	// Our state for new gliders
	if( ! glider.aprs ) {
		glider.aprs = {};
	}

	// Generate log function as it's quite slow to read environment all the time
	if( ! glider.aprs.log ) {
		glider.aprs.log = (glider.compno == (process.env.NEXT_PUBLIC_COMPNO||'')) ?
						  function log() { console.log(glider.compno, ...arguments ); } :
						  function log() {};
	}

	if( ognTracker ) {
		const [,paltS] = (packet.comment.match(/FL([0-9]+\.[0-9]+) /)||[undefined,undefined])
		const [,altS] = (packet.body.match(/A=([0-9]+) /)||[undefined,undefined])
		const [,gps] = (packet.body.match(/gps([0-9]+x[0-9]+)/)||[undefined,undefined])
		let palt = 0, alt = 0;
		if( paltS ) {
			palt = parseFloat(paltS)*100;
		}
		if( altS ) {
			alt = parseFloat(altS);
		}
		if( palt && alt) {
			if( ! glider.aprs.palt ) {
				glider.aprs.palt = Stats(10);
			}
			glider.aprs.palt.update( palt - alt );
			console.log(  "sd:", glider.aprs.palt.standard_deviation.toFixed(1), "palt", palt, "alt", alt, "diff", palt-alt, packet.speed, gps );
		}
	}
		
		
	//
	if( ! glider.aprs.kf ) {
		glider.aprs.kf = new KalmanFilter();
	}
	const kfalt = Math.floor(glider.aprs.kf.filter( altitude ));
	
    // Check to make sure they have moved or that it's been about 10 seconds since the last update
    // this reduces load from stationary gliders on the ground and allows us to track stationary gliders
    // better. the 1 ensures that first packet gets picked up after restart
    const distanceFromLast = glider.lastPoint ? distance( jPoint, glider.lastPoint ) : 1;
    if( distanceFromLast < 0.01 ) {
        if( (packet.timestamp - glider.lastTime) < 10 ) {
			glider.aprs.stationary++;
            return;
        }
    } else {
        glider.aprs.lastMoved = packet.timestamp;
    }
	
	if( glider.lastTime == packet.timestamp ) {
		glider.aprs.log( packet );
		glider.aprs.log( `${packet.timestamp} ${kfalt}/${altitude}\t${glider.compno} ** ${ognTracker} ${td}/***** from ${sender}: ${packet.altitude.toFixed(0)} + ${aoa} adjust :: ${packet.speed}` );
	}

    const islate = ( glider.lastTime > packet.timestamp );
    if( ! islate ) {        
		glider.lastPoint = jPoint;
		glider.lastAlt = altitude;
 
		if( glider.lastTime - packet.timestamp > 1800 ) {
			glider.aprs.log( `${glider.compno} : VERY late flarm packet received, ${(glider.lastTime - packet.timestamp)/60}  minutes earlier than latest packet received for the glider, ignoring` );
			console.log( packet );
			glider.lastTime = packet.timestamp;
			return;
		}
		
        glider.lastTime = packet.timestamp;
    }

//		console.log( `${kfalt}/${altitude}\t${glider.compno} -> ${ognTracker} ${td}/${islate} from ${sender}: ${packet.altitude.toFixed(0)} + ${aoa} adjust :: ${packet.speed}` );
	
    // Enrich with elevation and send to everybody, this is async
    getElevationOffset( packet.latitude, packet.longitude,
                   async (gl) => {
					   glider.agl = Math.round(Math.max(altitude-gl,0));
					   glider.altitude = altitude;

					   let message = {
						   c: glider.compno,
						   lat: Math.round(packet.latitude*1000000)/1000000,
						   lng: Math.round(packet.longitude*1000000)/1000000,
						   a: altitude,
						   g: glider.agl,
						   t: packet.timestamp,
						   b: packet.course,
						   s: packet.speed,
						   f: sender + ',' + flarmId,
					   };

					   packetCallback( glider, message, islate );
	});
}
