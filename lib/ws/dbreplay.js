
//
// Connect to APRS server and handle all the processing of the OGN APRS traffic
// including altitude normalization and filtering, duplicate removal and
// detection of stationary devices



// Import the APRS server
import { ISSocket } from 'js-aprs-is';
import { aprsParser } from  'js-aprs-fap';

// use the normal APRS handler to process the packet
import { processPacket } from './aprs.js';


// APRS connection
let connection = {};

// pm2
let metrics = undefined;


// Are we offsetting time for replay
let tOffset = 0;
let tBase = 0;
let stepSize = 1;

//
// Connect to the APRS Server
export async function startDBReplay( db, options, location, getAssociation, packetcallback, m = undefined ) {

	metrics = m;

	console.log( "offset", tOffset, Date.now()/1000 );

	tOffset = parseInt(process.env.NEXT_PUBLIC_TOFFSET)||0;
	if( tOffset > 0 ) { tOffset = Math.floor(tOffset - (Date.now()/1000)) };
	if( tOffset ) {
		stepSize = parseInt(process.env.NEXT_PUBLIC_STEPSIZE)||1;
		tBase = Math.floor(tOffset + (Date.now()/1000));
	}

	let lastPoint = Math.floor((Date.now()/1000) + tOffset);
	const datecode = (await db.query( 'SELECT datecode FROM compstatus LIMIT 1' ))[0].datecode;

	//
	// Iterate through the database reading a chunk at a time and sending through the same APRS parsePacket
	// routine as it would have been from APRS
	setInterval( async function() {
		const rawpoints = await db.query(escape`
                SELECT compno, class, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s
                  FROM trackpoints
                 WHERE datecode=${datecode} AND t >= ${lastPoint} AND t < ${lastPoint+stepSize}
                 ORDER BY t DESC`);
		
		lastPoint+=stepSize;

		console.log( "poll, ", lastPoint, tOffset, rawpoints.length, _map( rawpoints, (p) => p.compno ).join(',') );
		for( const point of rawpoints ) {
			// How the trackers are indexed into the array, it must include className as compno may not be unique
			const mergedName = point.class+'_'+point.compno;
			const aprsPacket = {
				altitude: point.a,
				sourceCallsign: `id00${gliders[mergedName]?.trackerid||'000000'}`,
				//					comment: `id00${gliders[mergedName]?.trackerid||'000000'} -000fpm +0.0rot 0.0dB -0,0kHz gps1x1 +0.0dBm`,
				course: point.b,
				latitude: point.lat,
				longitude: point.lng,
				posresolution: 1.852,
				speed: point.s,
				timestamp: point.t,
			};
            processPacket( aprsPacket );
		}
	},1000);

	// So UIs display correctly
	return [ tOffset, tBase ];
}
