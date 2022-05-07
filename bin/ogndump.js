#!/usr/bin/env node

// Copyright 2020 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

// Import the APRS server
import { ISSocket } from 'js-aprs-is';
import { aprsParser } from  'js-aprs-fap';


import {createWriteStream} from 'fs';


// DB access
//const db from '../db')
import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';

import dotenv from 'dotenv';

// Where is the comp based
let location = {};

// Load the current file & Get the parsed version of the configuration
dotenv.config({ path: '.env.local' })
let readOnly = process.env.OGN_READ_ONLY == undefined ? false : (!!(parseInt(process.env.OGN_READ_ONLY)));

// Set up background fetching of the competition
async function main() {

    if (dotenv.error) {
        console.log( "New install: no configuration found, or script not being run in the root directory" );
        process.exit();
    }

	
    let db = mysql( { config:{
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        onError: (e) => { console.log(e); }
    }});

    // Settings for connecting to the APRS server
    const CALLSIGN = 'testdata';
    const PASSCODE = -1;
    const APRSSERVER = 'aprs.glidernet.org';
    const PORTNUMBER = 14580;

    // Location comes from the competition table in the database
    location = (await db.query( 'SELECT lt,lg,tz, datecode FROM competition, compstatus LIMIT 1' ))[0];

    const FILTER = `r/${location.lt}/${location.lg}/260`;

	let output = createWriteStream( location.datecode + ".aprs", { flags: 'a' } );
	
	console.log( 'Onglide OGN Data Dump', location.datecode + ".aprs" );

	let count = 0;
	
    // Connect to the APRS server
    let connection = new ISSocket(APRSSERVER, PORTNUMBER, 'OTest', '', FILTER );
//    let parser = new aprsParser();

    // Handle a connect
    connection.on('connect', () => {
        connection.sendLine( connection.userLogin );
        connection.sendLine(`# onglide ${CALLSIGN} testing`);
    });

    // Handle a data packet
    connection.on('packet', (data) => {
        connection.valid = true;
		output.write( data + "\n");
		if( !(count % 10)) {
			process.stdout.write(`\r ${count} @ ${(data.match(/:\/([0-9]+)h/))?.[1]||''}` );
		}
		count++;
    });

    // Failed to connect
    connection.on('error', (err) => {
        console.log('Error: ' + err);
        connection.disconnect();
        connection.connect();
    });

    // Start the APRS connection
    connection.connect();

    // Every minute we need to do send a keepalive on the APRS link
    setInterval( function() {

        // Send APRS keep alive or we will get dumped
        connection.sendLine(`# alt.${CALLSIGN} testing`);

    }, 60*1000 );

}

main()
    .then("exiting");

