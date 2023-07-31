#!/usr/bin/env node

// Copyright 2020 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

// Import the APRS server
import {ISSocket} from 'js-aprs-is';
import {aprsParser} from 'js-aprs-fap';

import {createWriteStream} from 'fs';

// DB access
//const db from '../db')
import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';

import dotenv from 'dotenv';

// Where is the comp based
let location = {};

import {altitudeOffsetAdjust} from '../lib/offsets.js';

const Timestamps = new Map();

// Load the current file & Get the parsed version of the configuration
dotenv.config({path: '.env.local'});
let readOnly = process.env.OGN_READ_ONLY == undefined ? false : !!parseInt(process.env.OGN_READ_ONLY);

// Set up background fetching of the competition
async function main() {
    if (dotenv.error) {
        console.log('New install: no configuration found, or script not being run in the root directory');
        process.exit();
    }

    let db = mysql({
        config: {
            host: process.env.MYSQL_HOST,
            database: process.env.MYSQL_DATABASE,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            onError: (e) => {
                console.log(e);
            }
        }
    });

    // Settings for connecting to the APRS server
    const CALLSIGN = 'offsetcalc';
    const PASSCODE = -1;
    const APRSSERVER = 'aprs.glidernet.org';
    const PORTNUMBER = 14580;

    // Location comes from the competition table in the database
    location = (await db.query('SELECT lt,lg,tz, datecode FROM competition, compstatus LIMIT 1'))[0];

    const FILTER = `r/${location.lt}/${location.lg}/300`;

    console.log('Onglide OGN Offset Calc', location.datecode + '.ts', location);

    let count = 0;
    let processed = 0;

    // Connect to the APRS server
    let connection = new ISSocket(APRSSERVER, PORTNUMBER, 'ofc', '', FILTER);
    let parser = new aprsParser();

    // Handle a connect
    connection.on('connect', () => {
        connection.sendLine(connection.userLogin);
        connection.sendLine(`# onglide ${CALLSIGN} offsetcalc`);
    });

    // Handle a data packet
    connection.on('packet', (data) => {
        connection.valid = true;
        if (data.charAt(0) != '#' && !data.startsWith('user')) {
            const packet = parser.parseaprs(data);
            if ('latitude' in packet && 'longitude' in packet && 'comment' in packet && packet.comment?.startsWith('id')) {
                processPacket(packet);
                processed++;
            }
        }
        if (!(count % 10)) {
            process.stdout.write(`\r ${processed}/${count} @ ${data.match(/:\/([0-9]+)h/)?.[1] || ''} [#${Timestamps.size}]              `);
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
    setInterval(function () {
        // Send APRS keep alive or we will get dumped
        connection.sendLine(`# alt.${CALLSIGN} testing`);
        lookForOffsets();
    }, 60 * 1000);
}

function lookForOffsets() {
    const cutoff = Math.floor(Date.now() / 1000) - 30;

    const pairOffsets = new Map();

    console.log('offsets ----------');
    for (const item of Timestamps) {
        if (item[0] < cutoff) {
            const ts = item[1];

            for (const aircraft of ts) {
                const ac = aircraft[1];
                if (Object.keys(ac).length > 4) {
                    const alts = {};
                    delete ac.lat;
                    delete ac.lng;
                    delete ac.t;
                    for (const k of Object.keys(ac)) {
                        alts[ac[k] >> 1] = (alts[ac[k] >> 1] ?? 0) + 1; // round to div2 as 1/2 of metre is ok - alts are in feet
                    }
                    if (Object.keys(alts).length > 1) {
                        console.log(ac);
                    }
                }
            }
            Timestamps.delete(item[0]);
        }
    }
}

function processPacket(packet) {
    // Flarm ID we use is last 6 characters, check if OGN tracker or regular flarm
    const flarmId = packet.sourceCallsign.slice(packet.sourceCallsign.length - 6);
    const ognTracker = packet.sourceCallsign.slice(0, 3) == 'OGN';

    // Lookup the altitude adjustment for the
    let sender = packet.digipeaters?.pop()?.callsign || 'unknown';
    if (sender == 'DLY2APRS' || ognTracker) {
        return;
    }

    // For each timestamp
    let ts = Timestamps.get(packet.timestamp);
    if (!ts) {
        Timestamps.set(packet.timestamp, (ts = new Map()));
    }

    // we also have an aircraft
    let ac = ts.get(flarmId);
    if (!ac) {
        ac = {lat: packet.latitude.toFixed(5), lng: packet.longitude.toFixed(5), t: packet.timestamp};
        ts.set(flarmId, ac);
    }

    if (ac.lat != packet.latitude.toFixed(5) || ac.lng != packet.longitude.toFixed(5)) {
        //        console.log(`\npacket for ${flarmId}/${sender} at ${packet.timestamp} has different coordinates`, packet.latitude.toFixed(5), packet.longitude.toFixed(5), ac);
        return;
    }
    let aoa = altitudeOffsetAdjust[sender] ?? 0;
    ac[sender] = Math.round(packet.altitude + aoa);
}

main().then('exiting');
