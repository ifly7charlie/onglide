
//
// Connect to APRS server and handle all the processing of the OGN APRS traffic
// including altitude normalization and filtering, duplicate removal and
// detection of stationary devices



// Import the APRS server
import { ISSocket } from 'js-aprs-is';
import { aprsParser } from  'js-aprs-fap';

// use the normal APRS handler to process the packet
import { processPacket } from './aprs.js';

import { createInterface } from 'readline';
import { createReadStream } from 'fs';

// APRS connection
let connection = {};

// pm2
let metrics = undefined;

//
// Connect to the APRS Server
export async function startFileReplay( file, options, location, getAssociation, packetCallback, m = undefined ) {

	metrics = m;

	console.log( "filereplay", file );

	const rl = createInterface({
		input: createReadStream( file ),
		output: process.stdout,
		terminal: false
	});

	let t = 0;

	let parser = new aprsParser();

	rl.on('line', (data) => {
        if(data.charAt(0) != '#' && !data.startsWith('user')) {
            const packet = parser.parseaprs(data);
            if( packet &&
				"latitude" in packet && "longitude" in packet &&
                "comment" in packet && packet.comment?.substr(0,2) == 'id' )
			{
				processPacket( packet, getAssociation, packetCallback );

				if( t && t != packet.timestamp ) {
					rl.pause();
				}
				t = packet.timestamp;
            }
        } else {
            // Server keepalive
            console.log(data);
            if( data.match(/aprsc/) ) {
                connection.aprsc = data;
            }
        }
	});

	setInterval( () => { rl.resume() }, 1000 );
}

