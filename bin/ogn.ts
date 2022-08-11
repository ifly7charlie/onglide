#!/usr/bin/env node

// Copyright 2020 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

// Import the APRS server
import {ISSocket} from 'js-aprs-is';
import {aprsParser} from 'js-aprs-fap';

// Helper function
//import distance from '@turf/distance';
import {point} from '@turf/helpers';

// And the Websocket
import {WebSocket, WebSocketServer} from 'ws';

import {OnglideWebSocketMessage} from '../lib/protobuf/onglide';

// Helper
const fetcher = (url) => fetch(url).then((res) => res.json());

//import {setTimeout} from 'timers/promises';

// DB access
//const db from '../db')
import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';

// Add points to the deck structures
import {mergePoint, initialiseDeck} from '../lib/flightprocessing/incremental';

// Figure out what the task is and make GeoJSONs of it
import {calculateTask} from '../lib/flightprocessing/taskhelper';

// Message passed from the AprsContest Listener
import {PositionMessage} from '../lib/types';

let db = undefined;

// lodash
import {forEach, reduce, keyBy, filter as _filter, pick as _pick, map as _map, flatMap as _flatmap, remove as _remove} from 'lodash';

//import _remove from 'lodash.remove';
//import _groupby from 'lodash.groupby';
import {groupBy as _groupby, cloneDeep as _clonedeep} from 'lodash';

// Launch our listener
import {spawnAprsContestListener, AprsCommandTrack, AprsCommandEnum} from '../lib/webworkers/aprs';
import {ReplayController, ReplayConfig} from '../lib/webworkers/replay';

// Communication with the workers
import {BroadcastChannel, Worker} from 'node:worker_threads';
let unknownChannel: BroadcastChannel;
let aprsListener: Worker;

// Data sources

import * as dotenv from 'dotenv';

// Handle fetching elevation and confirming size of the cache for tiles
import {getElevationOffset, getCacheSize} from '../lib/getelevationoffset';

// handle unkownn gliders
import {capturePossibleLaunchLanding} from '../lib/flightprocessing/launchlanding.js';

import {setSiteTz, getSiteTz} from '../lib/flightprocessing/timehelper.js';

import {Epoch, Datecode, Compno, FlarmID, ClassName, ClassName_Compno, makeClassname_Compno, Task, DeckData, AirfieldLocation} from '../lib/types';
import {ScoringController} from '../lib/webworkers/scoring';

// Where is the comp based
let location: AirfieldLocation;

interface Channel {
    //    name: string
    className: ClassName;
    launching: boolean;
    datecode: Datecode;

    toSend: PositionMessage[]; // messages waiting to be sent

    activeGliders: Record<Compno, boolean>; // map of active compno
    lastSentPositions: Epoch;
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
    scoringConfigured?: boolean;

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

// Load the current file & Get the parsed version of the configuration
const error = dotenv.config({path: '.env.local'}).error;
let readOnly = process.env.OGN_READ_ONLY == undefined ? false : !!parseInt(process.env.OGN_READ_ONLY);

const replayBase = process.env.REPLAY ? parseInt(process.env.REPLAY) : 0;
const start = Math.trunc(Date.now() / 1000);

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
    location = (await db.query('SELECT name, lt as lat,lg as lng,tz FROM competition LIMIT 1'))[0];
    location.point = point([location.lng, location.lat]);
    location.officialDelay = parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') as Epoch;

    // Save the tz for use
    setSiteTz(location.tz);

    console.log('Onglide OGN handler', readOnly ? '(read only)' : '', process.env.NEXT_PUBLIC_SITEURL);
    console.log(`db ${process.env.MYSQL_DATABASE} on ${process.env.MYSQL_HOST}`);

    // Set the altitude offset for launching, this will take time to return
    // so there is a period when location altitude will be wrong for launches
    getElevationOffset(location.lat, location.lng, (agl) => {
        location.altitude = agl;
        console.log('SITE:' + agl);
    });

    // Download the list of trackers so we know who to look for
    await updateDDB();

    // Generate a short internal name
    const internalName = location.name.replace(/[^a-z]/g, '').substring(0, 10);

    // Start a listener for the location and competition
    if (!process.env.REPLAY) {
        aprsListener = spawnAprsContestListener({competition: internalName, location: {lt: location.lat, lg: location.lng}});
    }

    //
    // Subscribe to the feed of unknown gliders
    // Any unknown gliders get sent to this for identification
    unknownChannel = new BroadcastChannel('Unknown_' + internalName);
    unknownChannel.onmessage = (ev: MessageEvent<PositionMessage>) => identifyUnknownGlider(ev.data);

    await updateTrackers();
    await updateClasses();

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
            if (ws.isAlive) {
                console.log('requested pilot track', '' + m);
                sendPilotTrack(ws, ('' + m) as Compno);
            }
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
        const now = Math.trunc(Date.now() / 1000) - (start - replayBase);
        //        const now = Date.now() / 1000;

        for (const channelName in channels) {
            const channel = channels[channelName];

            //            console.log(`interval ${channelName}: ${channel.clients.length} (${channel.toSend.length} updates to send)`);
            if (channel.clients.length) {
                // && (channel.toSend.length > 0 || channel.lastSentPositions < now - 60)) {
                // Encode all the changes, we only keep latest per glider if multiple received
                // there shouldn't be multiple!

                //                console.log(channel.className, JSON.stringify(channel.toSend));
                const msg = OnglideWebSocketMessage.encode({positions: {positions: channel.toSend}, t: Math.trunc(now - location.officialDelay)}).finish();
                channel.toSend = [];
                channel.lastSentPositions = now;

                // Send to each client and if they don't respond they will be cleaned up next time around
                channel.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(msg, {binary: true});
                    }
                });
            } else {
                channel.toSend = [];
            }
        }
    }, 1000);

    setInterval(async function () {
        await updateTrackers();
        await updateClasses();
    }, 300 * 1000);

    //    await setTimeout(10000000);
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
            lastSentPositions: 0,
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

        // And configure scoring for it as well
        if (!channel.scoring) {
            channel.scoring = new ScoringController({className: c.class, airfield: location});
            channel.scoring.hookScores((a) => sendScores(channel, a));
            // Get tracks and configure pilots to score

            const updateTaskPromise = updateTasks(c.class);

            if (process.env.REPLAY) {
                await getInitialTrackPointsForReplay(channel);
            } else {
                await getInitialTrackPoints(channel);
            }
            // Actually start scoring the tasks
            const task = await updateTaskPromise;
            if (task) {
                channel.scoring.setTask(task);
            }
        }
    }
    // replace (do we need to close the old ones?)
    channels = newchannels;
    console.log(`Updated Channels: ${_map(channels, (c) => c.className + '_' + c.datecode).join(',')}`);
}

async function updateTasks(className: ClassName): Promise<Task | void> {
    // Get the details for the task
    const taskdetails = ((await db.query(escape`
         SELECT tasks.*, time_to_sec(tasks.duration) durationsecs, c.grandprixstart, c.handicapped,
               CASE WHEN nostart ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(fdcode(cs.datecode),' ',nostart))-(SELECT tzoffset FROM competition)
               END nostartutc
          FROM tasks, compstatus cs, classes c
          WHERE tasks.datecode= cs.datecode and tasks.class = cs.class AND c.class = cs.class
             AND tasks.class= ${className} and tasks.flown='Y'
    `)) || {})[0];

    if (!taskdetails || !taskdetails.type) {
        console.log(`${className}: no active task`, taskdetails);
        return;
    }

    const taskid = taskdetails.taskid;

    const tasklegs = await db.query(escape`
      SELECT taskleg.*, nname name
        FROM taskleg
       WHERE taskleg.taskid = ${taskid}
      ORDER BY legno
    `);

    if (tasklegs.length < 2) {
        console.log(`${className}: task ${taskid} is invalid - too few turnpoints`);
        return null;
    }

    // These are invalid
    delete taskdetails.hdistance;
    delete taskdetails.distance;
    delete taskdetails.maxmarkingdistance;

    let task = {
        rules: {
            grandprixstart: taskdetails.type == 'G' || taskdetails.type == 'E' || taskdetails.grandprixstart == 'Y',
            nostartutc: taskdetails.nostartutc,
            aat: taskdetails.type == 'A',
            dh: taskdetails.type == 'D',
            handicapped: taskdetails.handicapped == 'Y'
        },
        details: taskdetails,
        legs: tasklegs
    };

    calculateTask(task);
    return task;
}

async function updateTrackers() {
    // Now get the trackers
    const cTrackers = await db.query(`SELECT p.compno, p.greg, trackerId as dbTrackerId, 0 duplicate,
                                             p.class className
                                        FROM pilots p left outer join tracker t on p.class=t.class and p.compno=t.compno left outer join compstatus c on c.class=p.class
                                      WHERE p.class = c.class`);

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
            if (!process.env.REPLAY) {
                forEach(t.dbTrackerId.split(','), (tid: string, i: number) => {
                    let flarmId = tid.match(/[0-9A-F]{6}$/i);

                    // Tell APRS to start listening for the flarmid
                    const command: AprsCommandTrack = {action: AprsCommandEnum.track, compno: t.compno, className: t.className, trackerId: flarmId};
                    aprsListener.postMessage(command);
                });
            }
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
    const p = gliders[makeClassname_Compno(channels[client.ognChannel].className, compno)]?.deck;
    const toStream = {};
    if (p) {
        console.log('sendPilotTrack', client.ognChannel, compno, ', points=', p.posIndex, ', segments=', p.segmentIndex);
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
    }

    // Send the client the current version of the tracks
    const message = OnglideWebSocketMessage.encode({tracks: {pilots: toStream}}).finish();
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
                if (p) {
                    const start = p.recentIndices[0];
                    const end = p.recentIndices[1];
                    const length = end - start;
                    const segments = new Uint32Array([0, length]);
                    if (length) {
                        result[glider.compno] = {
                            compno: glider.compno,
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
            }
            return result;
        },
        {}
    );
    // Send the client the current version of the tracks
    client.send(OnglideWebSocketMessage.encode({tracks: {pilots: toStream}}).finish(), {binary: true});
}

// We need to fetch and repeat the scores for each class, enriched with vario information
// This means SWR doesn't need to timed reload which will help with how well the site redisplays
// information
async function sendScores(channel: any, scores: Buffer) {
    //    const now = Date.now() / 1000;
    const now = Math.trunc(Date.now() / 1000) - (start - replayBase);
    // For each channel (aka class)

    console.log('Sending Scores', scores.length);

    // Remove any that are still marked as not alive
    const toterminate = _remove(channel.clients, (client: any) => {
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
    channel.lastKeepAliveMsg = OnglideWebSocketMessage.encode({
        ka: {
            keepalive: true,
            at: Math.floor(now - location.officialDelay),
            listeners: channel.clients.length,
            airborne: airborne
        }
    }).finish();

    // Protobuf encode the scores message
    channel.lastScores = scores;

    // Send to each client and if they don't respond they will be cleaned up next time around
    channel.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(channel.lastKeepAliveMsg, {binary: true});
            client.send(channel.lastScores, {binary: true});
        }
        client.isAlive = false;
        client.ping(function () {});
    });

    // Reset for next iteration
    channel.activeGliders = {};
}

//
// Get the intitial track points from the database and make sure everything has been
// setup properly
//
async function getInitialTrackPoints(channel: Channel): Promise<void> {
    //
    // Now we will fetch the points for the pilots
    const rawpoints: PositionMessage[] = await db.query(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s, 0 as l
                                              FROM trackpoints
                                             WHERE datecode=${channel.datecode} AND class=${channel.className} 
                                             ORDER BY t ASC`);

    // AND compno='LS3'

    const groupedPoints: Record<Compno, PositionMessage[]> = _groupby(rawpoints, 'c');

    for (const compno in groupedPoints) {
        console.log(compno, groupedPoints[compno].length);
        // Find the glider
        const glider = gliders[makeClassname_Compno(channel.className, compno as Compno)];

        initialiseDeck(compno as Compno, glider);

        // Merge it into deck datastructures
        for (const point of groupedPoints[compno]) {
            mergePoint(point, glider);
        }

        // And pass the whole set to scoring to be loaded into the glider history
        channel.scoring.setInitialTrack(compno as Compno, groupedPoints[compno]);
        glider.scoringConfigured = true;
    }

    // Group them by comp number, this is quicker than multiple sub queries from the DB
    console.log(`${channel.className} reloaded all points`);
}

async function getInitialTrackPointsForReplay(channel: Channel): Promise<void> {
    //
    // Now we will fetch the points for the pilots
    const rawpoints: PositionMessage[] = await db.query(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s, 0 as l
                                              FROM trackpoints
                                             WHERE datecode=${channel.datecode} AND class=${channel.className} 
                                             ORDER BY t ASC`);

    // AND compno='LS3'

    const groupedPoints: Record<Compno, PositionMessage[]> = _groupby(rawpoints, 'c');

    const replay = new ReplayController({className: channel.className});

    for (const compno in groupedPoints) {
        console.log(compno, groupedPoints[compno].length);
        replay.setInitialTrack(compno as Compno, groupedPoints[compno]);
    }

    // Merge it into deck datastructures
    for (const compno in groupedPoints) {
        const glider = gliders[makeClassname_Compno(channel.className, compno as Compno)];
        initialiseDeck(compno as Compno, glider);
        for (const point of groupedPoints[compno]) {
            mergePoint(point, glider);
            channel.scoring.setInitialTrack(compno as Compno, [point]);
            break;
        }
        // And pass the whole set to scoring to be loaded into the glider history
        glider.scoringConfigured = true;
    }

    // We also need to go through all the gliders that don't have track points and set them up as well.
    for (const gn in gliders) {
        if (!gliders[gn].scoringConfigured) {
            channel.scoring.setInitialTrack(gliders[gn].compno as Compno, []);
            initialiseDeck(gliders[gn].compno as Compno, gliders[gn]);
        }
    }

    // Group them by comp number, this is quicker than multiple sub queries from the DB
    console.log(`${channel.className} reloaded all points`);

    setTimeout(() => {
        replay.start({className: channel.className});
    }, 20000);
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
        //        console.log(`${message.c}: ${message.t}`);

        // Merge into the display data structure
        mergePoint(message, glider);
    } else {
        //        console.log(`${message.c}: ${message.t} !!!`);
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
            unknownTrackers[flarmId].message = `${flarmId} matches ${match.compno} from DDB but ${match.compno} has already got ID ${match.dbTrackerId}`;
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
                .query(escape`INSERT INTO trackerhistory (compno,changed,flarmid,launchtime,method) VALUES ( ${match.compno}, now(), ${flarmId}, now(), "ognddb" )`)
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
