#!/usr/bin/env node

// Copyright 2020 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

// Import the APRS server
import {ISSocket} from 'js-aprs-is';
import {aprsParser} from 'js-aprs-fap';

// Helper function
import distance from '@turf/distance';
import {point} from '@turf/helpers';
import LatLong from '../lib/flightprocessing/LatLong.js';

// And the Websocket
import {WebSocket, WebSocketServer} from 'ws';

// And status display
import * as http from 'node:http';
import tx2 from 'tx2';

import * as protobuf from 'protobufjs/light.js';
import {OnglideWebSocketMessage} from '../lib/onglide-protobuf.js';

// Helper
import fetch from 'node-fetch';
const fetcher = (url) => fetch(url).then((res) => res.json());

// DB access
//const db from '../db')
import escape from 'sql-template-strings';
import * as mysql from 'serverless-mysql';

import {mergePoint, DeckData} from '../lib/flightprocessing/incremental';

// Message passed from the AprsContest Listener
import {PositionMessage} from '../lib/webworkers/positionmessage';

// Launch our listener
import {spawnAprsContestListener, AprsCommandTrack, AprsCommandEnum} from '../lib/webworkers/aprs';

let db = undefined;

// lodash

import {forEach, reduce, keyBy, filter as _filter, pick as _pick, map as _map, flatMap as _flatmap} from 'lodash';

//import _remove from 'lodash.remove';
//import _groupby from 'lodash.groupby';
import {groupBy as _groupby, cloneDeep as _clonedeep} from 'lodash';

// Score a single pilot
import {scorePilot, fetchTaskAndPilots} from '../lib/flightprocessing/scorepilot.js';
import {generatePilotTracks} from '../lib/flightprocessing/tracks.js';

import {BroadcastChannel, Worker} from 'node:worker_threads';
let unknownChannel: BroadcastChannel;
let aprsListener: Worker;

// Data sources

import * as dotenv from 'dotenv';

// Handle fetching elevation and confirming size of the cache for tiles
import {getElevationOffset, getCacheSize} from '../lib/getelevationoffset';

// handle unkownn gliders
import {capturePossibleLaunchLanding} from '../lib/flightprocessing/launchlanding.js';

import {setSiteTz} from '../lib/flightprocessing/timehelper.js';

import {Epoch, Datecode, Compno, FlarmID, ClassName, ClassName_Compno, makeClassname_Compno} from '../lib/types';
import {ScoringController} from '../lib/webworkers/scoring';

// Where is the comp based
let location;

interface Channel {
    //    name: string
    className: ClassName;
    launching: boolean;
    datecode: Datecode;

    toSend: PositionMessage[]; // messages waiting to be sent

    activeGliders: Record<Compno, boolean>; // map of active compno
    clients: any[]; // all websockets for the channel

    broadcastChannel: BroadcastChannel;
    scoring: ScoringController;

    lastKeepAliveMsg: any;
    lastScores: any;
}

let channels: Record<ClassName, Channel> = {};
/*EG: { 'PMSRMAM202007I': { className: 'blue', clients: [], launching: false, datecode: '070' },
                    'PMSRMAM202007H': { className: 'red', clients: [], launching: false, datecode: '070' },
                    }; */

interface Glider {
    compno: Compno;
    className: ClassName;
    //    flarmid?: FlarmID;

    greg: string;
    dbTrackerId: string;
    duplicate: number;

    deck: DeckData;
}

// Associative array of all the trackers
let gliders: Record<ClassName_Compno, Glider> = {}; /*EG: { 'T': { compno: 'T', className: 'blue', channel: channels['PMSRMAM202007I'] },
                    'P': { compno: 'P', className: 'blue', channel: channels['PMSRMAM202007I'] },
                    };*/

// Store in the unknown list for status display
interface UnknownTracker {
    firstTime: Epoch;
    lastTime: Epoch;
    flarmid: FlarmID;
    message?: string;
    matched?: any;
}

let unknownTrackers: Record<FlarmID, UnknownTracker> = {}; // All the ones we have seen in launch area but matched or not matched

// {"devices":[{"device_type":"F","device_id":"000000","aircraft_model":"HPH 304CZ-17","registration":"OK-7777","cn":"KN","tracked":"Y","identified":"Y"},
interface DDBEntry {
    device_type: string;
    device_id: string;
    aircraft_model: string;
    registration: string;
    cn: string;
    tracked: string;
    identified: string;
}
let ddb: Record<string, DDBEntry> = {};

// For encoding protocol buffer messages to be sent to clients...
let pbRoot = protobuf.Root.fromJSON(OnglideWebSocketMessage);
let pbOnglideWebsocketMessage = pbRoot.lookupType('OnglideWebSocketMessage');
function encodePb(msg: any) {
    let message = pbOnglideWebsocketMessage.create(msg);
    return pbOnglideWebsocketMessage.encode(message).finish();
}

// Load the current file & Get the parsed version of the configuration
const error = dotenv.config({path: '.env.local'}).error;
let readOnly = process.env.OGN_READ_ONLY == undefined ? false : !!parseInt(process.env.OGN_READ_ONLY);

async function main() {
    if (error) {
        console.log('New install: no configuration found, or script not being run in the root directory');
        process.exit();
    }

    db = mysql({
        config: {
            host: process.env.MYSQL_HOST,
            database: process.env.MYSQL_DATABASE,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD
        },
        onError: (e) => {
            console.log(e);
        }
    });

    // Location comes from the competition table in the database
    location = (await db.query('SELECT name, lt,lg,tz FROM competition LIMIT 1'))[0];
    location.point = point([location.lt, location.lg]);

    // Save the tz for use
    setSiteTz(location.tz);

    console.log('Onglide OGN handler', readOnly ? '(read only)' : '', process.env.NEXT_PUBLIC_SITEURL);
    console.log(`db ${process.env.MYSQL_DATABASE} on ${process.env.MYSQL_HOST}`);

    // Set the altitude offset for launching, this will take time to return
    // so there is a period when location altitude will be wrong for launches
    getElevationOffset(location.lt, location.lg, (agl) => {
        location.altitude = agl;
        console.log('SITE:' + agl);
    });

    // Download the list of trackers so we know who to look for
    await updateDDB();

    // Generate a short internal name
    const internalName = location.name.replace(/[^a-z]/g, '').substring(0, 10);

    // Start a listener for the location and competition
    aprsListener = spawnAprsContestListener({competition: internalName, location: {lt: location.lt, lg: location.lg}});

    //
    // Subscribe to the feed of unknown gliders
    // Any unknown gliders get sent to this for identification
    unknownChannel = new BroadcastChannel('Unknown_' + internalName);
    unknownChannel.onmessage = (ev: MessageEvent<PositionMessage>) => identifyUnknownGlider(ev.data);

    await updateClasses();
    await updateTrackers();
    //    await sendScores();

    // And start our websocket server
    const wss = new WebSocketServer({
        port: process.env.WEBSOCKET_PORT || 8080
    });

    // What to do when a client connects
    wss.on('connection', (ws, req) => {
        // Strip leading /
        const channel = req.url.substring(1, req.url.length);

        ws.ognChannel = channel;
        ws.ognPeer = req.headers['x-forwarded-for'];
        console.log(`connection received for ${channel} from ${ws.ognPeer}`);

        ws.isAlive = true;
        if (channel in channels) {
            channels[channel].clients.push(ws);
        } else {
            console.log('Unknown channel ' + channel);
            ws.isAlive = false;
        }

        ws.on('pong', () => {
            ws.isAlive = true;
        });
        ws.on('close', () => {
            ws.isAlive = false;
            console.log(`close received from ${ws.ognPeer} ${ws.ognChannel}`);
        });
        ws.on('message', (m) => {
            sendPilotTrack(ws, ('' + m) as Compno);
        });

        // Send vario etc for all gliders we are tracking
        sendCurrentState(ws);
    });

    //
    // This function is to send updated flight tracks for the gliders that have reported since the last
    // time we run the callback (every second), as we only update the screen once a second it should
    // be sufficient to bundle them even though we are receiving as a stream
    setInterval(function () {
        // For each channel (aka class)
        for (const channelName in channels) {
            const channel = channels[channelName];

            if (channel.clients.length) {
                // Encode all the changes, we only keep latest per glider if multiple received
                // there shouldn't be multiple!
                const msg = encodePb({
                    positions: {positions: channel.toSend},
                    t: Math.trunc(Date.now() / 1000)
                });
                channel.toSend = [];

                // Send to each client and if they don't respond they will be cleaned up next time around
                channel.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(msg, {binary: true});
                    }
                });
            }
        }
    }, 1000);

    // And every 4-6 minutes rescore and update everything - the random is to make sure
    // multiple processes don't intersect
    setInterval(function () {
        try {
            console.log('sending scores');
            //            sendScores();
        } catch (e) {
            console.log(e);
        }
    }, 1 * 20 * 1000 + 10000 * Math.random());
}

main().then(() => console.log('exiting'));

//
// Fetch the trackers from the database
async function updateClasses() {
    console.log('updateClasses()');

    // Fetch the trackers from the database and the channel they are supposed to be in
    const classes = await db.query('SELECT class, datecode FROM compstatus');

    // Now convert that into the main structure
    function channelName(className, datecode) {
        return (className + datecode).toUpperCase();
    }

    // Make sure the class structure is correct, this won't touch existing connections
    let newchannels: Record<string, Channel> = {};
    for (const c of classes) {
        const cname = channelName(c.class, c.datecode);
        let channel = channels[cname];

        // Update the saved data with the new values
        newchannels[cname] = channel = {
            clients: [],
            launching: false,
            activeGliders: {},
            toSend: [],
            ...channel, // keep old data
            className: c.class,
            datecode: c.datecode
        };

        // Make sure we have a broadcast channel for the class
        if (!channel.broadcastChannel) {
            channel.broadcastChannel = new BroadcastChannel(c.class);

            // Hook it up to the position messages so we can update our
            // displayed track we wrap the function with the class and
            // channel to simplify things
            channel.broadcastChannel.onmessage = (ev: MessageEvent<PositionMessage>) => processAprsMessage(c.class, channel, ev.data);
        }
    }

    // replace (do we need to close the old ones?)
    channels = newchannels;
}

async function updateTasks() {
    /*
        // make sure the task is cached properly
        const [task] = await fetchTaskAndPilots(c.class, false);

        // Make sure we have an entry for the scoring and do a dummy
        // fetch to get the task prepped and merge the scoring data into the
        // trackers array
        if (!scoring[cname]) {
            scoring[cname] = {
                trackers: {},
                state: {},
                points: {},
                geoJSON: {tracks: {}, fulltracks: {}, locations: {}}
            };

            // merge pilots into the tracker array, won't score as no pilot selected
            await scorePilot(c.class, undefined, scoring[cname]);

            if (!Object.keys(scoring[cname].trackers).length) {
                console.log('No valid task');
                continue;
            }

            // Now we will fetch the points for the pilots
            const rawpoints = await db.query(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s
                  FROM trackpoints
                 WHERE datecode=${c.datecode} AND (${tBase} = 0 OR t < ${tBase}) AND class=${c.class}
                 ORDER BY t DESC`);

            // Group them by comp number, this is quicker than multiple sub queries from the DB
            scoring[cname].points = _groupby(rawpoints, 'c');
            console.log(`${cname} reloaded all points`); 
        }

        if (!Object.keys(scoring[cname].trackers).length) {
            console.log('No valid task', cname);
            continue;
        }

        const cscores = scoring[cname];

        // Score them so we have some data to pass back over websocket
        // This also forces a full rescore by removing state and resetting
        // firstOldPoint to the end of the points. We don't need to fetch the points as
        // we have been maintinig a full list in order
        for (const compno of Object.keys(cscores.points)) {
            cscores.state[compno] = {};
            if (!cscores.trackers[compno]) {
                cscores.trackers[compno] = {};
            }
            cscores.trackers[compno].firstOldPoint = cscores.points[compno]?.length;
            try {
                if (task) {
                    await scorePilot(c.class, compno, cscores);
                }
            } catch (e) {
                console.log(`unable to scorePilot ${c.class}: ${compno}, ${e}`);
            }
        }

        // And fully regenerate the GeoJSONs so they include any late points
        await generatePilotTracks(cscores, tOffset);
        sendPilotTracks(cname, cscores.deck); */
}

async function updateTrackers() {
    // Now get the trackers
    const cTrackers = await db.query(
        'select p.compno, p.greg, trackerId as dbTrackerId, 0 duplicate, ' +
            ' p.class className ' +
            ' from pilots p left outer join tracker t on p.class=t.class and p.compno=t.compno left outer join compstatus c on c.class=p.class ' +
            '   where p.class = c.class'
    );

    // Now go through all the gliders and make sure we have linked them
    cTrackers.forEach((t) => {
        // Spread, this will define/overwrite as needed
        const gliderKey = makeClassname_Compno(t);

        // If we have changed channel then we have changed datecode as channel is class+datecode
        // and glider is simply keyed on class+compno
        //        if (gliders[gliderKey] && gliders[gliderKey].channel != t.channel) {
        //            console.log(`glider channel changed to ${t.channel} so resetting vario`);
        //            gliders[gliderKey] = {};
        //        }

        gliders[gliderKey] = {
            ...gliders[gliderKey],
            ...t,
            greg: t?.greg?.replace(/[^A-Z0-9]/i, '')
        };

        // If we have a tracker for it then we need to link that as well
        if (t.dbTrackerId && t.dbTrackerId != 'unknown') {
            forEach(t.dbTrackerId.split(','), (tid: string, i: number) => {
                let flarmId = tid.match(/[0-9A-F]{6}$/i);

                // Tell APRS to start listening for the flarmid
                const command: AprsCommandTrack = {action: AprsCommandEnum.track, compno: t.compno, className: t.className, trackerId: flarmId};
                aprsListener.postMessage(command);
            });
        }
    });

    // Filter out anything that doesn't match the input set, doesn't matter if it matches
    // unknowns as they won't be in the trackers pick
    const keyedDb = keyBy(cTrackers, makeClassname_Compno);

    // All the ones that are gone
    const removedGliders = _filter(gliders, (g) => !keyedDb[makeClassname_Compno(g)]);

    // And all the ones that remain
    forEach(gliders, (_g, k) => {
        if (!keyedDb[k]) {
            delete gliders[k];
        }
    });

    // Now unsubsribe from each of them
    removedGliders.forEach((g) => {
        if (g.dbTrackerId && g.dbTrackerId != 'unknown') {
            forEach(g.dbTrackerId.split(','), (tid: string, i: number) => {
                let flarmId = tid.match(/[0-9A-F]{6}$/i);
                // Tell APRS to start listening for the flarmid
                const command: AprsCommandTrack = {action: AprsCommandEnum.untrack, compno: g.compno, className: g.className, trackerId: flarmId};
                aprsListener.postMessage(command);
            });
        }
    });

    // identify any competition numbers that may be duplicates and mark them.  This
    // will affect how we match from the DDB
    const duplicates = await db.query('SELECT compno,count(*) count,group_concat(class) classes FROM pilots GROUP BY compno HAVING count > 1');
    duplicates.forEach((d: {compno: string; count: number; classes: string}) => {
        d.classes.split(',').forEach((c) => {
            gliders[c + '_' + d.compno].duplicate = 1;
        });
    });
}

//
// Update the DDB cache
async function updateDDB() {
    console.log('updating ddb');

    return fetch('http://ddb.glidernet.org/download/?j=1')
        .then((res) => res.json())
        .then((ddbraw) => {
            // {"devices":[{"device_type":"F","device_id":"000000","aircraft_model":"HPH 304CZ-17","registration":"OK-7777","cn":"KN","tracked":"Y","identified":"Y"},
            if (!ddbraw.devices) {
                console.log('no devices in ddb');
                return;
            }

            // Update the cache with the ids by device_id
            ddb = keyBy(ddbraw.devices, 'device_id');

            // remove the unknown characters from the registration
            forEach(ddb, function (entry) {
                entry.registration = entry?.registration?.replace(/[^A-Z0-9]/i, '');
            });
        })
        .catch((e) => {
            console.log('unable to fetch ddb', e);
        });
}

//
// New connection, send it a packet for each glider we are tracking
async function sendCurrentState(client: WebSocket) {
    if (client.readyState !== WebSocket.OPEN || !client.isAlive || !channels[client.ognChannel]) {
        console.log('unable to sendCurrentState not yet open or ! isAlive');
        return;
    }

    // Make sure we send the pilots ASAP
    if (channels[client.ognChannel]?.lastScores) {
        client.send(channels[client.ognChannel].lastScores, {binary: true});
    } else {
        console.log('no current scores', client.ognChannel);
    }

    // Send them the GeoJSONs, they need to keep this up to date
    sendRecentPilotTracks(channels[client.ognChannel].className, client);

    // If there has already been a keepalive then we will resend it to the client
    const lastKeepAliveMsg = channels[client.ognChannel].lastKeepAliveMsg;
    if (lastKeepAliveMsg) {
        client.send(lastKeepAliveMsg, {binary: true});
    }
}

async function sendPilotTrack(client: WebSocket, compno: Compno) {
    const p = gliders[compno].deck;
    const toStream = {};
    toStream[compno] = {
        compno: compno,
        positions: new Uint8Array(p.positions.buffer, 0, p.posIndex * 3 * 4),
        indices: new Uint8Array(p.indices.buffer, 0, p.segmentIndex * 4),
        t: new Uint8Array(p.t.buffer, 0, p.posIndex * 4),
        climbRate: new Uint8Array(p.climbRate.buffer, 0, p.posIndex),
        recentIndices: new Uint8Array(p.recentIndices.buffer),
        agl: new Uint8Array(p.agl.buffer, 0, p.posIndex * 2),
        posIndex: p.posIndex,
        partial: false,
        segmentIndex: p.segmentIndex
    };

    // Send the client the current version of the tracks
    const message = encodePb({tracks: {pilots: toStream}});
    if (client.readyState === WebSocket.OPEN) {
        client.send(message, {binary: true});
    }
}

// Send the abbreviated track for all gliders, used when a new client connects
async function sendRecentPilotTracks(className: ClassName, client: WebSocket) {
    const toStream = reduce(
        gliders,
        (result, glider, compno) => {
            if (glider.className == className) {
                const p = glider.deck;
                const start = p.recentIndices[0];
                const end = p.recentIndices[1];
                const length = end - start;
                const segments = new Uint32Array([0, length]);
                if (length) {
                    result[compno] = {
                        compno: compno,
                        positions: new Uint8Array(p.positions.buffer, start * 12, length * 12),
                        indices: new Uint8Array(segments.buffer),
                        t: new Uint8Array(p.t.buffer, start * 4, length * 4),
                        climbRate: new Uint8Array(p.climbRate.buffer, start, length),
                        recentIndices: new Uint8Array(segments.buffer),
                        agl: new Uint8Array(p.agl.buffer, start * 2, length * 2),
                        posIndex: length,
                        partial: true,
                        segmentIndex: 1
                    };
                }
            }
            return result;
        },
        {}
    );

    // Send the client the current version of the tracks
    client.send(encodePb({tracks: {pilots: toStream}}), {binary: true});
}

// We need to fetch and repeat the scores for each class, enriched with vario information
// This means SWR doesn't need to timed reload which will help with how well the site redisplays
// information
async function sendScores() {
    const now = Date.now() / 1000;
    /*
    // For each channel (aka class)
    for( const channel of channels ) {
        // Remove any that are still marked as not alive
        const toterminate = _remove(channel.clients, (client) => {
            return client.isAlive === false;
        });

        toterminate.forEach((client) => {
            console.log(`terminating client ${client.ognChannel} peer ${client.ognPeer}`);
            client.terminate();
        });

        const airborne = Object.keys(channel.activeGliders)?.length || 0;

        // If we have nothing then do nothing...
        if (!channel.clients.length) {
            console.log(`${channel.className}: no clients subscribed`);
        } else {
            console.log(`${channel.className}: ${channel.clients.length} subscribed, ${airborne} gliders airborne`);
        }

        // For sending the keepalive
        channel.lastKeepAliveMsg = encodePb({
            ka: {
                keepalive: 1,
                t: timeToText(now),
                at: Math.floor(now),
                listeners: channel.clients.length,
                airborne: airborne
            }
        });

        // Send to each client and if they don't respond they will be cleaned up next time around
        channel.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(channel.lastKeepAliveMsg, {binary: true});
            }
            client.isAlive = false;
            client.ping(function () {});
        });

        const className = channel.className;
        const scores = scoring[channel.name];
        if (!scores || !Object.keys(scores.trackers).length) {
            console.log(`no pilots scored for ${channel.className} ${channel.datecode}`);
            return;
        }

        // We only need to mix in the gliders that are active
        if (Object.keys(channel.activeGliders).length == 0 && channel.lastScores) {
            console.log(`${channel.className}: no activity since last scoring so do nothing`);
            return;
        }

        // Reset for next iteration
        channel.activeGliders = {};

        Promise.allSettled(
            _map(
                scores.trackers,
                (tracker) =>
                    new Promise((resolve) => {
                        try {
                            scorePilot(className, tracker.compno, scores, tracker.outOfOrder > 5).then(() => resolve());
                        } catch (e) {
                            console.log(`exception scoring ${className}, ${tracker.compno} [FULL:${tracker.outOfOrder > 5}]`);
                            console.warn(className, tracker.compno, 'Unable to score', e);
                            resolve();
                        }
                    })
            )
        )
            .then(() => {
                // Make a copy that we can tweak
                const pilots = _clonedeep(scores.trackers);

                // Get gliders for the class;
                //              const gliders = _pickby( gliders, (f) => f.className == channel.className );
                function mergedName(t) {
                    return t.class + '_' + t.compno;
                }

                forEach(pilots, (p, k) => {
                    const glider = gliders[mergedName(p)];
                    if (!glider) {
                        console.log(`unable to find glider ${p.compno} in ${p.class}`);
                        return;
                    }

                    // Mix in the last real time information
                    p.altitude = glider.altitude;
                    p.agl = glider.agl;

                    // And check to see if it has moved in the last 5 minutes, if we don't know omit the key
                    if (glider.lastTime) {
                        p.stationary = (glider.lastTime - glider.lastMoved ?? glider.lastTime) > 5 * 60;
                    }

                    // If it is recent then we will also include vario
                    if (now - glider.lastTime < 60 && 'lastvario' in glider) {
                        [p.lossXsecond, p.gainXsecond, p.total, p.average, p.Xperiod, p.min, p.max] = glider.lastvario;
                    }

                    p.at = glider.lastTime;

                    // Flatten the scored points so we can serialise them with protobuf
                    p.scoredpoints = p?.scoredpoints?.flat();
                });

                // Protobuf encode the scores message
                channel.lastScores = encodePb({scores: {pilots: pilots}});

                // Send to each client
                channel.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(channel.lastScores, {binary: true});
                    }
                });
            })
            .catch((err) => {
                console.warn(err);
            });
} */
}

//
// Get the intitial track points from the database and make sure everything has been
// setup properly
//
async function getInitialTrackPoints(channel: Channel): Promise<void> {
    //
    // Now we will fetch the points for the pilots
    const rawpoints: PositionMessage[] =
        await db.query(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s, 0 as l
                                              FROM trackpoints
                                             WHERE datecode=${channel.datecode} AND class=${channel.className}
                                             ORDER BY t ASC`);

    const groupedPoints: Record<Compno, PositionMessage[]> = _groupby(rawpoints, 'c');

    for (const compno in groupedPoints) {
        // Find the glider
        const glider = gliders[makeClassname_Compno(channel.className, compno as Compno)];

        // Merge it into deck datastructures
        for (const point of groupedPoints[compno]) {
            mergePoint(point, glider);
        }

        // And pass the whole set to scoring to be loaded into the glider history
        channel.scoring.setInitialTrack(compno as Compno, groupedPoints[compno]);
    }

    // Group them by comp number, this is quicker than multiple sub queries from the DB
    console.log(`${channel.className} reloaded all points`);
}

//
// This is a complete message that can be sent to the client,
// it's complete with the vario elevation etc
function processAprsMessage(className: string, channel: Channel, message: PositionMessage) {
    // how many gliders are we tracking for this channel
    if (!('activeGliders' in channel)) {
        channel.activeGliders = {};
    }
    channel.activeGliders[message.c] = true;

    // Lookup the glider
    const glider = gliders[className + '_' + message.c];

    // Check if they are a launch
    if (message.g > 100 && !channel.launching) {
        console.log(`Launch detected: ${glider.compno}, class: ${glider.className}`);
        channel.launching = true;
    }

    // If the packet isn't delayed then we should send it out over our websocket
    if (!message.l) {
        // Buffer the message they get batched every second
        channel.toSend.push(message);

        // Merge into the display data structure
        mergePoint(message, glider);
    }

    // Pop into the database
    if (!readOnly) {
        db.query(escape`INSERT IGNORE INTO trackpoints (class,datecode,compno,lat,lng,altitude,agl,t,bearing,speed,station)
                                                  VALUES ( ${glider.className}, ${channel.datecode}, ${glider.compno},
                                                           ${message.lat}, ${message.lng}, ${message.a}, ${message.g}, ${message.t}, ${message.b}, ${message.s}, ${message.f} )`);
    }
}

// If we don't know the glider then we need to figure out who it is and make sure we
// process it properly
function identifyUnknownGlider(data: PositionMessage): void {
    //
    // We will get the flarm id in 'c' as there is no known compno
    const flarmId = data.c;

    // Check if it's a possible launch
    capturePossibleLaunchLanding(flarmId, data.t, [data.lng, data.lat], data.g, readOnly ? undefined : db, 'flarm');

    // Store in the unknown list for status display
    unknownTrackers[flarmId] = {
        firstTime: data.t,
        ...unknownTrackers[flarmId],
        lastTime: data.t,
        flarmid: flarmId
    };

    // Do we have it in the DDB?
    const ddbf = ddb[flarmId];

    // If we have matched before then don't do it again
    if (unknownTrackers[flarmId].message) {
        return;
    }

    // This works by checking what is configured in the ddb
    if (ddbf && (ddbf.cn != '' || ddbf.registration != '')) {
        // Find all our gliders that could match, may be 0, 1 or possibly 2
        const matches = _filter(gliders, (x) => {
            return (!x.duplicate && ddbf.cn == x.compno) || (ddbf.registration == x.greg && (x.greg || '') != '');
        });

        if (!Object.keys(matches).length) {
            unknownTrackers[flarmId].message = `No DDB match in competition ${ddbf.cn} (${ddbf.registration}) - ${ddbf.aircraft_model}`;
            return;
        }

        if (matches.length > 1) {
            console.log(flarmId + ': warning more than one candidate matched from ddb (' + matches.toString() + ')');
            unknownTrackers[flarmId].message = 'Multiple DDB matches ' + matches.toString();
        }

        // And we will use the first one
        const match = matches[0];

        unknownTrackers[flarmId].matched = `${match.compno} ${match.className} (${ddbf.registration}/${ddbf.cn})`;

        // If it's another match for somebody we have matched then ignore it
        if (match.dbTrackerId != flarmId && match.dbTrackerId != 'unknown') {
            unknownTrackers[
                flarmId
            ].message = `${flarmId} matches ${match.compno} from DDB but ${match.compno} has already got ID ${match.dbTrackerId}`;
            console.log(unknownTrackers[flarmId].message);
            match.duplicate = 1;
            return;
        }

        unknownTrackers[flarmId].message = `${flarmId}:  found in ddb, matched to ${match.compno} (${match.className})`;
        console.log(unknownTrackers[flarmId].message);

        // Link the two together (same as the db update)
        match.dbTrackerId = flarmId;

        // And we should ask the flarm handler to listen for them properly
        const command: AprsCommandTrack = {action: AprsCommandEnum.track, compno: match.compno, className: match.className, trackerId: flarmId};
        aprsListener.postMessage(command);

        // Save in the database so we will reuse them later ;)
        if (!readOnly) {
            db.transaction()
                .query(
                    escape`UPDATE tracker SET trackerid = ${flarmId} WHERE
                                      compno = ${match.compno} AND class = ${match.className} AND trackerid="unknown" limit 1`
                )
                .query(
                    escape`INSERT INTO trackerhistory (compno,changed,flarmid,launchtime,method) VALUES ( ${match.compno}, now(), ${flarmId}, now(), "ognddb" )`
                )
                .commit();
        }
    }
}

// Display a time as competition time, use 24hr clock (en-GB)
function timeToText(t) {
    if (!t) return '';
    var cT = new Date(t * 1000);
    return cT.toLocaleTimeString('en-GB', {timeZone: location.tz, hour: '2-digit', minute: '2-digit'});
}