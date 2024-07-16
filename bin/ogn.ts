#!/usr/bin/env node

// Copyright 2020-2023 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {initialiseInsights, trackMetric, trackAggregatedMetric} from '../lib/insights';

import http from 'node:http';
import https from 'node:https';

import {readFileSync} from 'fs';

// Helper function
//import distance from '@turf/distance';
import {point} from '@turf/helpers';

// And the Websocket
import {WebSocket, WebSocketServer} from 'ws';
import type {IncomingMessage} from 'http';

import {OnglideWebSocketMessage, Positions, PilotPosition, ClassScoreHistory, PilotScore} from '../lib/protobuf/onglide';

import {setTimeout as setTimeoutPromise} from 'timers/promises';

// DB access
import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';

// Add points to the deck structures
import {mergePoint, initialiseDeck} from '../lib/flightprocessing/incremental';

// Figure out what the task is and make GeoJSONs of it
import {calculateTask} from '../lib/flightprocessing/taskhelper';

// Datecode helpers
import {fromDateCode, toDateCode} from '../lib/datecode';

// Message passed from the AprsContest Listener
import {PositionMessage, TasksTableRow, TaskLegsTableRow, ClassesTableRow} from '../lib/types';
const dev = process.env.NODE_ENV == 'development';
console.log('dev mode', dev);

let db: ReturnType<typeof mysql>;

// lodash
import {forEach, reduce, keyBy, filter as _filter, pick as _pick, map as _map, flatMap as _flatmap, remove as _remove, sortedIndex as _sortedIndex, sortedIndexBy as _sortedIndexBy} from 'lodash';

//import _remove from 'lodash.remove';
//import _groupby from 'lodash.groupby';
import {groupBy as _groupby, cloneDeep as _clonedeep, isEqual as _isEqual} from 'lodash';

// Launch our listener
import {spawnAprsContestListener, AprsCommandTrack, AprsCommandEnum} from '../lib/webworkers/aprs';
import {ReplayController, ReplayConfig} from '../lib/webworkers/replay';

import {webPathBaseTime, scoreChunkSize} from '../lib/constants';

import {createHash, randomBytes, createHmac} from 'crypto';

// Communication with the workers
import {BroadcastChannel, Worker} from 'node:worker_threads';
let unknownChannel: BroadcastChannel | undefined;
let aprsListener: Worker;

// Data sources

import * as dotenv from 'dotenv';

// Handle fetching elevation and confirming size of the cache for tiles
import {getElevationOffset, getCacheSize} from '../lib/getelevationoffset';

// handle unkownn gliders
import {capturePossibleLaunchLanding} from '../lib/flightprocessing/launchlanding.js';

import {setSiteTz, getSiteTz} from '../lib/flightprocessing/timehelper.js';

import {Epoch, Datecode, Compno, FlarmID, ClassName, ClassName_Compno, makeClassname_Compno, ChannelName, Task, DeckData, AirfieldLocation} from '../lib/types';
import {ScoringController} from '../lib/webworkers/scoring';

const d = (d) => new Date(Math.min(d ?? 0, 2145916800) * 1000).toISOString();

// Where is the comp based
let location: AirfieldLocation;

interface Statistics {
    periodStart: Epoch;

    outOfOrderPackets: number;
    insertedPackets: number;
    totalPackets: number;

    positionsSent: number;
    positionsSentCycles: number;
    listenerCycles: number;
    activeListeners: number;
    peakListeners: number;

    totalViewingTime: number;
}

interface ChannelTask {}

interface Channel {
    //    name: string
    className: ClassName;
    launching: boolean;
    datecode: Datecode;

    toSend: PositionMessage[]; // messages waiting to be sent

    activeGliders: Set<Compno>; // map of active compno
    lastSentPositions: Epoch;
    clients: any[]; // all websockets for the channel

    broadcastChannel?: BroadcastChannel;
    scoring?: ScoringController;
    task?: any; // what task are we scoring - we use this to see if anything has changed
    gliderHash?: string;
    replay?: ReplayController; // are we replaying?

    lastKeepAliveMsg?: any;

    statistics: Statistics;

    // Tasks we are working on or have had

    earliestScore: Epoch;
    earliestStart: Epoch;
    latestScore: Epoch;

    allScores: Record<Compno, PilotScore>;
    allScoresMsg?: Uint8Array;

    scoreId: string;
    proposedScoreId: string;
    scoreIdUpdateRequired: boolean;
    scoresUpdatedAt: Epoch;
    scoreHistory: Map<Compno, PilotScore[]>;

    // For the web buffer
    webPathBaseTime: Epoch;
    webPathData: Record<string, Buffer>;
    mostRecentPosition: Epoch; // last time we had something to send
}

let channels: Record<ChannelName, Channel> = {};
/*EG: { 'PMSRMAM202007I': { className: 'blue', clients: [], launching: false, datecode: '070' },
                    'PMSRMAM202007H': { className: 'red', clients: [], launching: false, datecode: '070' },
                    }; */

interface Glider {
    compno: Compno;
    className: ClassName;
    channelName: ChannelName;

    flarmIdRegex: RegExp;

    greg: string;
    handicap: number;
    dbTrackerId: string;
    datecode: Datecode;
    duplicate: number;
    utcStart: Epoch;
    scoredStart: Epoch;
    scoredStatus: 'S' | 'F' | 'H'; // from scoring
    scoringConfigured?: boolean;

    deck: DeckData;
    webPathEndPosition: number;
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

interface OgnWebSocket extends WebSocket {
    ognChannel: ChannelName;
    ognPeer: string;
    isAlive: boolean;
    connectedAt: Epoch;
}

// Load the current file & Get the parsed version of the configuration
const error = dotenv.config({path: '.env.local'}).error;
let readOnly = process.env.OGN_READ_ONLY == undefined ? false : !!parseInt(process.env.OGN_READ_ONLY);

const start = Math.trunc(Date.now() / 1000);

// Correct timing for the competition
const compDelay = process.env.NEXT_PUBLIC_COMPETITION_DELAY ? parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') : 0;
let getNow = (): Epoch => (Math.trunc(Date.now() / 1000) - compDelay) as Epoch;
const replayBase = parseInt(process.env.REPLAY ?? process.env.REPLAY_DB ?? '0');
let multiplier = replayBase ? parseInt(process.env.REPLAY_MULTIPLIER || '1') : 1;

console.log(JSON.stringify(process.env));

// And the replay
if (replayBase) {
    getNow = (): Epoch => {
        const now = Math.trunc(Date.now() / 1000);
        const elapsed = now - start;
        const effectiveElapsed = elapsed * multiplier;
        return (replayBase + effectiveElapsed) as Epoch;
    };
}

console.log(`Competition delay: ${compDelay} seconds, competition time: ${getNow()} = ${new Date(getNow() * 1000).toISOString()}, replay: ${replayBase > 0}`);

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
        },
        onConnectError: (x) => {
            console.log('mysql connect errror', x);
        },
        onKill: (x) => {
            console.log('mysql killed xx', x);
        },
        onClose: (x) => {
            console.log('mysql connection closed', x);
        },
        onConnect: (x) => {
            console.log(`mysql connection opened ${x.config.host}:${x.config.port} user: ${x.config.user} state: ${x.state}`);
        },
        maxConnsFreq: 15 * 60 * 1000,
        usedConnsFreq: 10 * 60 * 1000,
        maxRetries: 4,
        zombieMaxTimeout: 3600,
        connUtilization: 0.2
    });

    if (process.env.REPLAY_DB) {
        console.log('readonly for database replay');
        readOnly = true;
    }

    // Allow insights if it's configured.
    // DON'T TRACK DEPENDENCIES as it will pick up SQL statements
    // and we do a LOT of them
    initialiseInsights();

    const checkReady = async (): Promise<boolean> => {
        // Location comes from the competition table in the database
        location = (await db.query('SELECT name, lt as lat,lg as lng,tz,tzoffset FROM competition LIMIT 1'))?.[0];

        if (!location) {
            console.error('no competition entry in the database, please confirm soaringspot integration is working');
            return false;
        }

        if (!replayBase && !(await db.query('SELECT MAX(datecode) as datecode FROM compstatus LIMIT 1'))?.[0]?.datecode) {
            console.error('no current date found for competition');
            console.table(await db.query<any[]>('SELECT * FROM compstatus'));
            console.table(await db.query<any[]>('SELECT * FROM competition'));
            console.table(await db.query<any[]>('SELECT * FROM classes'));
            return false;
        }
        return true;
    };

    while (!(await checkReady())) {
        await setTimeoutPromise(30000);
    }

    location.point = point([location.lng, location.lat]);
    location.officialDelay = parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') as Epoch;
    location.tzoffset = parseInt(location.tzoffset as unknown as string);

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
    const internalName = location.name.replace(/[^a-z]/gi, '').substring(0, 10);

    // Start a listener for the location and competition
    if (!process.env.REPLAY_DB) {
        aprsListener = spawnAprsContestListener({competition: internalName, location: {lt: location.lat, lg: location.lng}});
    }

    {
        const datecode = await getDCode();
        await updateClasses(internalName, datecode);
        await updateTrackers(datecode);
        await updateTasks();
    }

    if (process.env.WEBSOCKET_PORT && 'NEXT_PUBLIC_SITEURL' in process.env) {
        try {
            const options = {
                key: readFileSync(`keys/${process.env.NEXT_PUBLIC_SITEURL}.key.pem`),
                cert: readFileSync(`keys/${process.env.NEXT_PUBLIC_SITEURL}.cert.pem`)
            };

            if (options.key && options.cert) {
                console.log('initialising SSL');
                const server = https.createServer(options, setupOgnWebServer);
                server.listen(parseInt(process.env.WEBSOCKET_PORT) + 1000);
                setupWebSocketServer(server);
                console.log(`listening on [SSL] ${parseInt(process.env.WEBSOCKET_PORT) + 1000}`);
            }
        } catch (e) {
            console.log(`Unable to initialise SSL "keys/${process.env.NEXT_PUBLIC_SITEURL}.key.pem"`, e);
        }
    }

    // We always open an non-ssl one
    const server = http.createServer(setupOgnWebServer);
    server.listen(process.env.WEBSOCKET_PORT || 8080);
    server.on('clientError', function (ex, _socket) {
        console.log('****> clientError', ex);
    });

    setupWebSocketServer(server);
    console.log(`listening on ${process.env.WEBSOCKET_PORT || '8080'}`);

    //
    // This function is to send updated flight tracks for the gliders that have reported since the last
    // time we run the callback (every second), as we only update the screen on data it should
    // be sufficient to bundle them even though we are receiving as a stream
    setInterval(function () {
        // For each channel (aka class)
        const now = getNow();

        const positions = Object.values(channels).reduce((a, c: Channel) => {
            a[c.className] = {positions: c.toSend as unknown as PilotPosition[]};
            return a;
        }, {} as Record<string, Positions>);

        const msg = OnglideWebSocketMessage.encode({positions: {class: positions}, t: Math.trunc(now)}).finish();

        for (const channelName in channels) {
            const channel = channels[channelName];

            channel.statistics.activeListeners += channel.clients.length;
            channel.statistics.listenerCycles++;

            if (channel.clients.length) {
                if (!channel.toSend.length) {
                    continue;
                }
                channel.mostRecentPosition = now;

                // Send if we have an update or if it's been 30 seconds since we last sent one
                //                if (channel.toSend.length || (now - channel.lastSentPositions ?? 0) > 30) {
                // Encode all the changes, we only keep latest per glider if multiple received
                // there shouldn't be multiple!
                //
                // Metrics are helpful
                channel.statistics.positionsSent += channel.toSend.length;
                channel.statistics.bytesSent += channel.toSend.length * msg.byteLength;
                channel.statistics.positionSentCycles++;
                // We don't want to send it twice so it can go
                channel.toSend = [];
                channel.lastSentPositions = now;

                // Send to each client and if they don't respond they will be cleaned up next time around
                channel.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(msg, {binary: true});
                    }
                });
                //              }
            } else {
                channel.toSend = [];
            }
        }
    }, 500);

    //
    // Housekeeping
    setInterval(async function () {
        //
        // Make sure our DB connection is good to go!
        db.getClient()?.ping((e) => {
            if (e) {
                console.log('db ping failed', e);
                try {
                    db.quit();
                } catch (e) {
                    /**/
                }
            } else {
                console.log('db pong');
            }
            db.end();
        });

        //
        // We need to purge unused channels
        const now = getNow();
        for (const channelName in channels) {
            const channel = channels[channelName];

            // Remove any that are still marked as not alive
            const toterminate = _remove(channel.clients, (client: any) => {
                return client.isAlive === false;
            });

            toterminate.forEach((client) => {
                console.log(`terminating client ${client.ognChannel} peer ${client.ognPeer}`);
                channel.statistics.totalViewingTime += now - client.connectedAt;
                client.terminate();
            });

            await sendKeepalive(channel);
        }

        //
        // Aggregate statistics
        for (const channelName in channels) {
            const channel = channels[channelName];

            channel.statistics.peakListeners = Math.max(channel.statistics.peakListeners, channel.statistics.activeListeners / channel.statistics.listenerCycles);

            console.log(
                `${channelName}: ${channel.statistics.positionsSent} positions sent, ${channel.statistics.insertedPackets} inserted, ${channel.statistics.outOfOrderPackets} ooo, ${channel.statistics.totalPackets} total`
            );
            console.log(
                `${channelName}: ${(channel.statistics.activeListeners / channel.statistics.listenerCycles).toFixed(1)} avg listeners, ${Math.round(channel.statistics.totalViewingTime / 60)}m total viewing time, peak ${
                    channel.statistics.peakListeners
                }`
            );

            trackAggregatedMetric(channel.className, 'positions.sent', channel.statistics.positionsSent, channel.statistics.positionsSentCycles);
            trackAggregatedMetric(channel.className, 'positions.bytesSent', channel.statistics.bytesSent, channel.statistics.positionsSentCycles);
            trackAggregatedMetric(channel.className, 'activeListeners', channel.statistics.activeListeners / channel.statistics.listenerCycles, channel.statistics.listenerCycles);

            trackAggregatedMetric(channel.className, 'ogn.outOfOrderPackets', channel.statistics.outOfOrderPackets);
            trackAggregatedMetric(channel.className, 'ogn.insertedPackets', channel.statistics.insertedPackets);
            trackAggregatedMetric(channel.className, 'ogn.totalPackets', channel.statistics.totalPackets);

            channel.statistics.positionsSent =
                channel.statistics.positionsSentCycles =
                channel.statistics.bytesSent =
                channel.statistics.activeListeners =
                channel.statistics.listenerCycles =
                channel.statistics.outOfOrderPackets =
                channel.statistics.insertedPackets =
                channel.statistics.totalPackets =
                    0;
        }
    }, 60 * 1000);

    console.log(getNow() - (getNow() % 60), (getNow() % 60) * (1000 / multiplier), multiplier, getNow());

    //
    // Update competition information
    setInterval(async function () {
        const datecode = await getDCode();
        await updateClasses(internalName, datecode);
        await updateTrackers(datecode);
        await updateTasks();
        await finaliseScoreId();
    }, 60 * 1000);
}

main().then(() => console.log('Started'));

// So we have a different channel for each date
function channelName(className: ClassName, datecode: Datecode): ChannelName {
    return (className + datecode).toUpperCase() as ChannelName;
}

//
// Get current date code
async function getDCode(): Promise<Datecode> {
    return replayBase //
        ? toDateCode(new Date(replayBase * 1000))
        : (await db.query<{datecode: Datecode}[]>('SELECT MAX(datecode) as datecode FROM compstatus LIMIT 1'))[0].datecode;
}

//
// Fetch the trackers from the database
async function updateClasses(internalName: string, datecode: Datecode) {
    console.log(`updateClasses(${internalName}, ${datecode})`);

    // Fetch the trackers from the database and the channel they are supposed to be in
    const classes = await db.query<{class: ClassName}[]>('SELECT class FROM compstatus');

    // Make sure the class structure is correct, this won't touch existing connections
    let newchannels: Record<string, Channel> = {};
    for (const c of classes) {
        const cname = channelName(c.class, datecode);
        let channel: Channel = channels[cname];

        // New channel needs setup
        if (!channel) {
            // Update the saved data with the new values
            const scoreId = (Math.random() * 10000).toFixed(1);

            channel = {
                clients: [],
                launching: false,
                activeGliders: new Set(),
                lastSentPositions: 0 as Epoch,
                toSend: [],
                className: c.class,
                datecode: datecode,
                gliderHash: '',
                statistics: {
                    periodStart: Math.trunc(Date.now() / 1000) as Epoch,
                    outOfOrderPackets: 0,
                    insertedPackets: 0,
                    totalPackets: 0,
                    positionsSent: 0,
                    positionsSentCycles: 0,
                    listenerCycles: 0,
                    activeListeners: 0,
                    peakListeners: 0,
                    totalViewingTime: 0
                },
                webPathBaseTime: 0 as Epoch,
                mostRecentPosition: getNow(),
                webPathData: {},
                scoreHistory: new Map(),
                allScores: {},
                scoreId,
                proposedScoreId: scoreId,
                scoreIdUpdateRequired: false,
                scoresUpdatedAt: 0 as Epoch,
                earliestScore: Infinity as Epoch,
                earliestStart: Infinity as Epoch,
                latestScore: 0 as Epoch
            };
        } else {
            // We move it to the new list
            delete channels[cname];
        }
        newchannels[cname] = channel;

        // Make sure we have a broadcast channel for the class
        if (!channel.broadcastChannel) {
            channel.broadcastChannel = new BroadcastChannel(cname);

            // Hook it up to the position messages so we can update our
            // displayed track we wrap the function with the class and
            // channel to simplify things
            channel.broadcastChannel.onmessage = ((ev: MessageEvent<PositionMessage>) => processAprsMessage(c.class, channel, ev.data)) as any;
        }

        // Prep for scoring
        if (!channel.scoring) {
            channel.scoring = new ScoringController({className: channel.className, datecode: channel.datecode, airfield: location});
            channel.scoring.hookScore(({compno, score, recentStart, t, scoreId}) => sendScore(channel, compno, score, recentStart, channel.scoreId, t));
        }
        if (process.env.REPLAY_DB && !channel.replay) {
            getInitialTrackPointsForReplay(channel);
        }
    }

    // Any channels left here are old and can be removed - the current ones are moved from channels
    // and added to newchannels
    if (Object.keys(channels).length) {
        console.log('closing channels: ', Object.keys(channels).join(','));
        Object.values(channels).forEach((channel) => {
            channel.broadcastChannel?.close();
            channel.scoring?.shutdown();
        });
        unknownChannel?.close();
        unknownChannel = undefined;
    }

    // Subscribe to the feed of unknown gliders
    // Any unknown gliders get sent to this for identification
    if (!unknownChannel) {
        unknownChannel = new BroadcastChannel('Unknown_' + internalName);
        unknownChannel.onmessage = ((ev: MessageEvent<PositionMessage>) => identifyUnknownGlider(ev.data, datecode)) as any;
    }

    // replace (do we need to close the old ones?)
    channels = newchannels;
    console.log(`Updated Channels: ${_map(channels, (c) => channelName(c.className, c.datecode)).join(',')}`);
}

async function updateTasks(): Promise<void> {
    // Get the details for the task
    const getTask = async (className: ClassName, datecode: Datecode) => {
        const taskdetails = ((await db.query<(TasksTableRow & {nostartutc: Epoch} & ClassesTableRow)[]>(escape`
         SELECT tasks.*, time_to_sec(tasks.duration) durationsecs, c.grandprixstart, c.handicapped,
               CASE WHEN nostart ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(${fromDateCode(datecode)},' ',nostart))-(SELECT tzoffset FROM competition)
               END nostartutc
          FROM tasks, classes c
          WHERE tasks.datecode= ${datecode}
             AND tasks.class = c.class 
             AND tasks.class= ${className} and tasks.flown='Y'
    `)) || {})[0];

        if (!taskdetails || !taskdetails.type) {
            console.log(`${className}/${datecode}: no active task`, taskdetails);
            return null;
        }

        const taskid = taskdetails.taskid;

        const tasklegs = await db.query<TaskLegsTableRow[]>(escape`
      SELECT taskleg.*, nname name
        FROM taskleg
       WHERE taskleg.taskid = ${taskid}
      ORDER BY legno
    `);

        if (tasklegs.length < 2) {
            console.log(`${className}: task ${taskid} is invalid - too few turnpoints`);
            return null;
        }

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
    };

    // Go through all the channels and check for a change of task
    for (const channel of Object.values(channels)) {
        const updatedTask = await getTask(channel.className, channel.datecode);

        if (!_isEqual(channel.task ?? {}, updatedTask ?? {})) {
            console.log(
                `new task for ${channel.className}: changed from ${channel.task?.details?.taskid || 'none'} to ${updatedTask?.details?.taskid || 'none'} [${channel.datecode}] ${updatedTask?.legs
                    ?.reduce((a, l) => a + l.length, 0)
                    .toFixed(1)}km`
            );
            console.log(`${channel.className}: Startline open: ${updatedTask?.rules.nostartutc}, sgp: ${updatedTask?.rules.grandprixstart}, hcap: ${updatedTask?.rules.handicapped}, aat: ${updatedTask?.rules.aat}`);

            // If it has a task stop it scoring and start the new task
            if (channel.task) {
                channel.scoring?.clearTask();
                channel.scoreHistory = new Map();
                channel.allScores = {};
            }

            // We have a task so we will score what we know
            if (updatedTask) {
                channel.task = updatedTask;
                console.log(`${channel.className}: ** rescore ** ${channel.scoreId} => ${channel.proposedScoreId} (task changed)`);
                channel.scoring?.setTask(channel.task, channel.proposedScoreId);
                channel.scoreIdUpdateRequired = true;
            }
        }
    }
}

interface CTrackerRow {
    compno: Compno;
    greg: string;
    dbTrackerId: string;
    duplicate: number;
    handicap: number;
    className: ClassName;
    utcStart: Epoch;
    scoredStatus: 'H' | 'F' | 'S';
}

async function updateTrackers(datecode: Datecode) {
    // Now get the trackers
    let cTrackers = await db.query<CTrackerRow[]>(escape`SELECT p.compno, p.greg, trackerId as dbTrackerId, 0 duplicate, p.handicap,
                                             p.class className, CASE WHEN ppr.start ='00:00:00' THEN 0
                                           ELSE UNIX_TIMESTAMP(CONCAT(${fromDateCode(datecode)},' ',ppr.start))-(SELECT tzoffset FROM competition)
                                        END utcStart, ppr.scoredStatus
                                        FROM pilots p left outer join tracker t on p.class=t.class and p.compno=t.compno left outer join
                                             (select compno,class,start,scoredstatus from pilotresult pr where pr.datecode=${datecode}) as ppr
                                      ON ppr.class=p.class and ppr.compno=p.compno`);

    const initialGliderCount = Object.keys(gliders).length;
    let updatedGliderCount = 0;
    let loadedGliderCount = 0;

    // Filter out anything that doesn't match the input set, doesn't matter if it matches
    // unknowns as they won't be in the trackers pick
    const keyedDb = keyBy<CTrackerRow>(cTrackers, makeClassname_Compno);
    const removedGliders = _filter(gliders, (g) => {
        const newValue = keyedDb[makeClassname_Compno(g)];
        if (!newValue || newValue.dbTrackerId != g.dbTrackerId) {
            console.log(`${g?.compno} - ${newValue?.dbTrackerId} vs ${g.dbTrackerId} status: ${newValue.scoredStatus}`);
            return true; // removed or it has changed id
        }
        return g.datecode != datecode;
    });

    // Now unsubsribe from each of them
    const keyedRemoved = keyBy(removedGliders, makeClassname_Compno);
    removedGliders.forEach((g) => {
        if (g.dbTrackerId && g.dbTrackerId != 'unknown') {
            const flarmIDs = _filter(g.dbTrackerId.split(','), (i) => i.match(/[0-9A-F]{6}$/i)) as string[];
            if (flarmIDs && flarmIDs.length) {
                // Tell APRS to start listening for the flarmid
                console.log(`Stopping APRS Listener for glider ${g.className}:${g.compno} => ${flarmIDs.join(',')}`);
                const command: AprsCommandTrack = {
                    action: AprsCommandEnum.untrack,
                    compno: g.compno, //
                    className: g.className,
                    channelName: g.channelName,
                    trackerId: flarmIDs
                };
                aprsListener?.postMessage?.(command);
            }
        }
        console.log(`${g.className}:${g.compno} terminating scoring as no flarm ids found`);
        const channel = channels[g.channelName];
        channel?.scoring?.clearGlider(g.compno);
        delete gliders[makeClassname_Compno(g)];
    });

    // Now go through all the desired gliders and make sure we have linked them
    await Promise.allSettled(
        cTrackers.map(async (t) => {
            const gliderKey = makeClassname_Compno(t);

            const startUtcChanged = gliders[gliderKey]?.utcStart != t.utcStart;
            const handicapChanged = gliders[gliderKey]?.handicap != t.handicap;
            const scoredStatusChanged = gliders[gliderKey]?.scoredStatus != t.scoredStatus;
            const hadTracker = !!gliders[gliderKey]?.flarmIdRegex;

            // glider key not enough to check for datecode changes (force ignore of
            // typescript types as we don't want the rest set yet because we need
            // to see if it's changed on existing object)
            const glider: Glider = (gliders[gliderKey] = Object.assign(
                gliders[gliderKey] || {}, //
                {...t, channelName: channelName(t.className, datecode), greg: t?.greg?.replace(/[^A-Z0-9]/i, ''), datecode} as any as Glider
            ));

            // If we have a tracker for it then we need to link that as well
            if (!hadTracker && t.dbTrackerId && t.dbTrackerId != 'unknown') {
                const flarmIDs = t.dbTrackerId.split(',').filter((i: string) => i.match(/[0-9A-F]{6}$/i));

                if (flarmIDs && flarmIDs.length) {
                    // Tell APRS to start listening for the flarmid
                    const command: AprsCommandTrack = {
                        action: AprsCommandEnum.track, //
                        compno: t.compno,
                        className: t.className,
                        trackerId: flarmIDs,
                        channelName: glider.channelName
                    };

                    aprsListener?.postMessage?.(command);
                    glider.flarmIdRegex = new RegExp(`^(${flarmIDs.join('|')})`, 'i');
                }
            }

            if (glider.scoringConfigured) {
                const channel = channels[glider.channelName];
                if (scoredStatusChanged && t.scoredStatus != 'S') {
                    console.log(`${glider.compno}: stopping scoring as status is ${t.scoredStatus}`);
                    channel?.scoring?.clearGlider(glider.compno);
                }
                //
                else if (startUtcChanged || handicapChanged) {
                    console.log(`${glider.className}:${glider.compno}: rescoring [${channel.proposedScoreId}] => startUtcChanged:${startUtcChanged} handicapChanged:${handicapChanged}`);
                    channel?.scoring?.rescoreGlider(glider.compno, glider.handicap, glider.utcStart, channel.proposedScoreId);
                    channel.scoreIdUpdateRequired = true;
                    updatedGliderCount++;
                }
            } else {
                try {
                    loadedGliderCount++; // change to flarm id
                    await loadGliderPoints(glider, !keyedRemoved[makeClassname_Compno(glider)]);
                } catch (e) {
                    console.error(e);
                }
            }
        })
    );

    const newGlidersCount = Object.keys(gliders).length;
    if (removedGliders.length || updatedGliderCount || newGlidersCount != initialGliderCount) {
        console.log(`updatedTrackers: ${removedGliders.length} removed, ${updatedGliderCount} rescored, ${loadedGliderCount} loaded, ${newGlidersCount - initialGliderCount} new`);
        console.log(`${newGlidersCount} trackers loaded: ${Object.keys(gliders).join(',')}`);
    }

    // identify any competition numbers that may be duplicates and mark them.  This
    // will affect how we match from the DDB
    const duplicates = await db.query<{compno: Compno; count: number; classes: string}[]>('SELECT compno,count(*) count,group_concat(class) classes FROM pilots GROUP BY compno HAVING count > 1');
    duplicates.forEach((d: {compno: string; count: number; classes: string}) => {
        d.classes.split(',').forEach((c) => {
            gliders[c + '_' + d.compno].duplicate = 1;
        });
    });
}

async function finaliseScoreId() {
    for (const channel of Object.values(channels)) {
        if (channel.scoreIdUpdateRequired) {
            channel.scoring?.updateScoreId(channel.scoreId, channel.proposedScoreId);
            channel.scoreId = channel.proposedScoreId;
        }
    }
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
async function sendCurrentState(client: OgnWebSocket) {
    if (client.readyState !== WebSocket.OPEN || !client.isAlive || !channels[client.ognChannel]) {
        console.log('unable to sendCurrentState not yet open or ! isAlive');
        return;
    }

    console.log(client.ognChannel);
    const channel = channels[client.ognChannel];

    sendAllScores(channel, getNow());

    // Send them the GeoJSONs, they need to keep this up to date
    sendRecentPilotTracks(channel, client);

    if (channel.lastKeepAliveMsg) {
        console.log('keepalive2');
        client.send(channel.lastKeepAliveMsg, {binary: true});
    }
}

async function generateHistoricalTracks(channel: Channel): Promise<void> {
    // Figure out the block that preceeds us, we do it a little late to allow reconnects to use websocket only
    const now = (channel.mostRecentPosition - 20) as Epoch;
    const base = now - webPathBaseTime; // determine the last block block

    if (now - (channel.webPathBaseTime ?? 0) > webPathBaseTime) {
        console.log(`re-generateHistoricalTracks now: ${d(now)}, base: ${d(base)}, previous: ${d(channel.webPathBaseTime)}`);
        const toStream = reduce(
            gliders,
            (result, glider, compno) => {
                if (glider.className == channel.className) {
                    const p = glider.deck;
                    if (p) {
                        const start = Math.max(_sortedIndex(p.t.subarray(0, p.posIndex), Math.min(glider.scoredStart ?? glider.utcStart ?? 0, now - 120)), 0);
                        const end = Math.max(_sortedIndex(p.t.subarray(0, p.posIndex), now), 0);
                        const length = end - start;
                        console.log(`${compno}: ${end} - ${start} = ${length}, ${d(p.t[start])} => ${d(p.t[end])}, posIndex: ${p.posIndex} ,${d(glider.utcStart ?? 0)}`);
                        if (length) {
                            result[glider.compno] = {
                                compno: glider.compno,
                                positions: new Uint8Array(p.positions.buffer, start * 12, length * 12),
                                t: new Uint8Array(p.t.buffer, start * 4, length * 4),
                                climbRate: new Uint8Array(p.climbRate.buffer, start, length),
                                agl: new Uint8Array(p.agl.buffer, start * 2, length * 2),
                                posIndex: length,
                                trackVersion: p.trackVersion
                            };
                        }
                        glider.webPathEndPosition = end;
                    }
                }
                return result;
            },
            {}
        );
        // Send the client the current version of the tracks
        channel.webPathData[now.toString()] = Buffer.from(OnglideWebSocketMessage.encode({tracks: {pilots: toStream, baseTime: 0}}).finish());
        channel.webPathBaseTime = now;
    }
}

// Send the abbreviated track for all gliders, used when a new client connects
async function sendRecentPilotTracks(channel: Channel, client: WebSocket) {
    // Make sure they are up to date (does nothing if they are)
    await generateHistoricalTracks(channel);

    const toStream = reduce(
        gliders,
        (result, glider) => {
            if (glider.className == channel.className) {
                const p = glider.deck;
                if (p) {
                    const start = Math.max(_sortedIndex(p.t.subarray(0, p.posIndex), glider.scoredStart ?? glider.utcStart ?? 0), 0);
                    const end = p.posIndex;
                    const length = end - start;
                    if (length) {
                        result[glider.compno] = {
                            compno: glider.compno,
                            positions: new Uint8Array(p.positions.buffer, start * 12, length * 12),
                            t: new Uint8Array(p.t.buffer, start * 4, length * 4),
                            climbRate: new Uint8Array(p.climbRate.buffer, start, length),
                            agl: new Uint8Array(p.agl.buffer, start * 2, length * 2),
                            posIndex: length,
                            trackVersion: p.trackVersion
                        };
                    }
                }
            }
            return result;
        },
        {}
    );
    // Send the client the current version of the tracks
    client.send(OnglideWebSocketMessage.encode({tracks: {pilots: toStream, baseTime: channel.webPathBaseTime ?? 0}}).finish(), {binary: true});
}

async function updateGliderTrack(channel: Channel, glider: Glider) {
    // We need to replace the start data as well
    channel.webPathBaseTime = 0 as Epoch;
    // Make sure they are up to date (does nothing if they are)
    await generateHistoricalTracks(channel);

    const toStream = {};
    const p = glider.deck;
    if (p) {
        let start = 0; // glider.webPathEndPosition ?? 0;
        const end = p.posIndex;
        const length = end - start;
        //        if (length) {
        toStream[glider.compno] = {
            compno: glider.compno,
            positions: new Uint8Array(p.positions.buffer, start * 12, length * 12),
            t: new Uint8Array(p.t.buffer, start * 4, length * 4),
            climbRate: new Uint8Array(p.climbRate.buffer, start, length),
            agl: new Uint8Array(p.agl.buffer, start * 2, length * 2),
            posIndex: length,
            trackVersion: p.trackVersion
        };
        //        }
    }

    // Generate the protobuf message for the full track
    const trackMessage = OnglideWebSocketMessage.encode({tracks: {pilots: toStream, baseTime: channel.webPathBaseTime ?? 0}}).finish();

    console.log(
        `${channel.className}/${glider.compno}: sending full track over websocket v${p.trackVersion} ${trackMessage.length} bytes, ${channel.clients.length} clients = ${trackMessage.length * channel.clients.length} bytes`
    );

    // Send the client the current version of the tracks, we don't care how long it takes (don't wait)
    channel.clients.forEach(async (client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(trackMessage, {binary: true});
        }
    });
}

async function sendAllScores(channel: Channel, t: Epoch | undefined) {
    [channel.earliestStart, channel.earliestScore, channel.latestScore] = Object.values(channel.allScores).reduce(
        ([earliestStart, earliestScore, latestScore], score) => [
            Math.min(score.utcStart ?? Infinity, earliestStart), //
            Math.min((score.t ?? 0) < 10 ? Infinity : score.t, earliestScore),
            Math.max((score.t ?? 0) < 10 ? 0 : score.t, latestScore)
        ],
        [Infinity, Infinity, 0]
    ) as [Epoch, Epoch, Epoch];

    console.log(`sending all scores eScore: ${d(channel.earliestScore)}, eStart: ${d(channel.earliestStart)}, lScore: ${d(channel.latestScore)} t: ${d(t ?? 0)}`);

    const updatedIdentifiers = OnglideWebSocketMessage.encode(
        {
            identifiers: {
                className: channel.className,
                datecode: channel.datecode,
                competition: '1', //
                earliestScore: channel.earliestStart < Infinity ? channel.earliestStart : channel.earliestScore < Infinity ? channel.earliestScore : getNow(),
                latestScore: channel.latestScore,
                scoreId: channel.scoreId
            },
            scores: {
                scoreId: channel.scoreId,
                pilots: channel.allScores
            },
            ...(t ? {t} : {})
        } //
    ).finish();
    console.log(`${channel.className}: sending identifiers after rebuild of scoring ${channel.scoreId} allScores length: ${updatedIdentifiers!.length}`);

    channel.clients.forEach((client: any) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(updatedIdentifiers, {binary: true});
        }
    });
}

// We need to fetch and repeat the scores for each class, enriched with vario information
// This means SWR doesn't need to timed reload which will help with how well the site redisplays
// information
async function sendScore(channel: Channel, compno: Compno, score: PilotScore, recentStart: Epoch | undefined, scoreId: string, t: Epoch | undefined) {
    console.log(`${compno}: received ${score.live ? 'live' : 'replay'} score [${scoreId}] ${recentStart ? ', recently started, ' : ''}, ${d(t)}`);

    if (compno == '_live') {
        sendAllScores(channel, t);
        return;
    }

    // We don't know how many scores we have without decoding the protobuf message :(
    if (t && channel.scoreId == scoreId) {
        let sh = channel.scoreHistory.get(compno);
        if (!sh) {
            channel.scoreHistory.set(compno, (sh = []));
        }
        const index = _sortedIndexBy(sh, {t} as unknown as PilotScore, (x) => x.t);
        if (index < sh.length && index >= 0) {
            console.log(`***** ${compno} rewind score history from ${d(sh.at(-1)?.t ?? 0)} to ${d(sh[index].t)} sh:[${index}/${sh.length}]`);
        }
        sh.splice(index, Infinity, score);
    }

    // Send to each client and if they don't respond they will be cleaned up next time around
    if (score.live) {
        const msg = OnglideWebSocketMessage.encode({scores: {scoreId, pilots: {[compno]: score}}}).finish();
        trackMetric(channel.className + '.scoring.bytesSent', msg.byteLength * channel.clients.length);
        channel.clients.forEach((client: any) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg, {binary: true});
            }
        });

        // Finally merge it in to the complete history, and reset the protobuf message
        // we only do this if we are not in a 'rebuild' of the history, the first proper score
        // will trigger the update
        if (channel.scoreId == scoreId) {
            channel.allScores[compno] = score;
            channel.allScoresMsg = undefined;
        }
    }

    if (recentStart) {
        const glider = gliders[makeClassname_Compno(channel.className, compno as Compno)];
        if (glider) {
            const deck = glider.deck;
            // Reset the glider starting point, but also the channel so we don't use invalid
            // mix of the two
            glider.webPathEndPosition = 0;
            channel.webPathBaseTime = 0 as Epoch;
            channel.earliestStart = Math.min(channel.earliestStart, recentStart) as Epoch;
            if (glider.scoredStart && glider.scoredStart > recentStart) {
                console.log(`${compno}: start time moved earlier in time, resending track`);
                glider.scoredStart = recentStart;
                updateGliderTrack(channel, glider);
            }
            glider.scoredStart = recentStart;
        }
    }
}

async function sendKeepalive(channel: Channel) {
    const now = getNow();

    const sumConnectedTime = channel.clients.reduce((a: number, c: any) => a + (now - c.connectedAt), 0);

    // If we have nothing then do nothing...
    if (!channel.clients.length) {
        console.log(`${channel.className}: no clients subscribed`);
    } else {
        console.log(`${channel.className}: ${channel.clients.length} subscribed ${Math.trunc(sumConnectedTime / channel.clients.length / 30) / 2}m avg time, ${channel.activeGliders.size} gliders airborne`);
    }

    // For sending the keepalive
    channel.lastKeepAliveMsg = OnglideWebSocketMessage.encode({
        ka: {
            keepalive: true,
            at: Math.floor(now),
            listeners: channel.clients.length,
            airborne: channel.activeGliders.size
        }
    }).finish();

    // Reset for next iteration
    channel.activeGliders.clear();

    // Send to each client and if they don't respond they will be cleaned up next time around
    channel.clients.forEach((client: any) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(channel.lastKeepAliveMsg, {binary: true});
        }
        client.isAlive = false;
        client.ping(function () {});
    });
}

async function getInitialTrackPointsForReplay(channel: Channel): Promise<void> {
    const now = getNow();
    //
    // Now we will fetch the points for the pilots
    const rawpoints: PositionMessage[] =
        (await db.query<PositionMessage[]>(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s, 0 as l
                                              FROM trackpoints
                                   WHERE datecode=${channel.datecode} AND class=${channel.className} AND t > ${now}
                                             ORDER BY t ASC`)) ?? [];

    // AND compno='LS3'
    console.log(`${channel.className}: fetched ${rawpoints.length} rows of trackpoints (getInitialTrackPointsForReplay)`);

    const groupedPoints: Record<Compno, PositionMessage[]> = _groupby(rawpoints, 'c');

    // Setup replay but only first time
    channel.replay = new ReplayController({className: channel.className});
    for (const compno in groupedPoints) {
        console.log(compno, groupedPoints[compno].length);
        channel.replay.setInitialTrack(compno as Compno, groupedPoints[compno], channelName(channel.className, channel.datecode), channel.datecode);
    }

    // Group them by comp number, this is quicker than multiple sub queries from the DB
    console.log(`replay: ${channel.className} reloaded all points`);

    setTimeout(() => {
        channel.replay?.start({className: channel.className});
    }, 10000);
}

async function loadGliderPoints(glider: Glider, firstTime: boolean): Promise<void> {
    const now = getNow();
    const channel = channels[glider.channelName];
    //
    // Now we will fetch the points for the pilots
    const rawpoints: Array<PositionMessage & {x: string}> =
        (await db.query<Array<PositionMessage & {x: string}>>(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s, 0 as l, station as x
                                              FROM trackpoints
                                              WHERE datecode=${channel.datecode} AND class=${channel.className} AND compno=${glider.compno} AND t < ${now}
                                              ORDER BY t ASC`)) ?? [];

    // Make sure the flarm ID is valid for this data so we can exclude dodgy trackers more easily
    const points = !glider.flarmIdRegex ? rawpoints : rawpoints.filter((row) => glider.flarmIdRegex.test(row.x));

    initialiseDeck(glider.compno as Compno, glider, randomBytes(4).readUInt32BE(0));

    // Merge it into deck datastructures
    for (const point of points) {
        mergePoint(point, glider);
    }

    // And pass the whole set to scoring to be loaded into the glider history
    channel.scoring?.setInitialTrack(glider.compno, glider.handicap, glider.utcStart, points);
    glider.scoringConfigured = true;

    // Group them by comp number, this is quicker than multiple sub queries from the DB
    console.log(
        `${channel.className}  ${firstTime ? 'first load' : 'reload'} all points for ${glider.compno} glider [${rawpoints.length - points.length} removed, ${points.length} loaded] ${glider.flarmIdRegex} ${timeToText(
            points[0]?.t
        )} to ${timeToText(points[points.length - 1]?.t)} @ ${timeToText(now)} - v${glider.deck.trackVersion.toString(16)}`
    );

    // If it's not the first time then we need to update the channel with the track
    if (!firstTime) {
        updateGliderTrack(channel, glider);
    }
}

//
// This is a complete message that can be sent to the client,
// it's complete with the vario elevation etc
async function processAprsMessage(className: string, channel: Channel, message: PositionMessage) {
    // how many gliders are we tracking for this channel
    channel.activeGliders.add(message.c as Compno);

    //    console.log(message.c, message.t);

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
        if (!mergePoint(message, glider)) {
            if (dev) {
                console.log('!merge', glider?.t, JSON.stringify(message));
            }
            channel.statistics.outOfOrderPackets++;
        } else {
            if (dev) {
                //                console.log('ok', JSON.stringify(message));
            }
        }
    } else {
        if (dev) {
            console.log('late', JSON.stringify(message));
        }
        channel.statistics.outOfOrderPackets++;
    }

    // Pop into the database
    if (!readOnly) {
        db.query<{affectedRows: number}>(
            Object.assign(
                escape`INSERT IGNORE INTO trackpoints (class,datecode,compno,lat,lng,altitude,agl,t,bearing,speed,station)
                                                  VALUES ( ${glider.className}, ${channel.datecode}, ${glider.compno},
                                                           ${message.lat}, ${message.lng}, ${message.a}, ${message.g}, ${message.t}, ${message.b}, ${message.s}, ${message.f} )`,
                {timeout: 1000}
            )
        ).then((result) => {
            channel.statistics.insertedPackets += result.affectedRows || 0;
            channel.statistics.totalPackets++;
        });
    }
}

// If we don't know the glider then we need to figure out who it is and make sure we
// process it properly
function identifyUnknownGlider(data: PositionMessage, datecode: Datecode): void {
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
        const command: AprsCommandTrack = {
            action: AprsCommandEnum.track, //
            compno: match.compno,
            className: match.className,
            trackerId: flarmId,
            channelName: channelName(match.className, datecode)
        };
        aprsListener?.postMessage(command);

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
function timeToText(t: Epoch): string {
    if (!t) return '';
    var cT = new Date(t * 1000);
    return cT.toLocaleTimeString('en-GB', {timeZone: location.tz, hour: '2-digit', minute: '2-digit'});
}

//
// Function to create and setup the listener for a websocket server
function setupWebSocketServer(server) {
    const address = server.address()?.port ?? 'unknown';

    // And start our websocket server
    const wss = new WebSocketServer({server});

    // What to do when a client connects
    wss.on('connection', (ws: OgnWebSocket, req: IncomingMessage) => {
        if (!req.url?.length) {
            ws.isAlive = false;
            return;
        }

        // Strip leading /
        const channel = req.url.substring(1, req.url.length) as ChannelName;

        ws.ognChannel = channel;
        ws.ognPeer = req.headers['x-forwarded-for']?.toString() ?? req.connection.remoteAddress ?? 'unknown';
        console.log(`connection received for ${channel} from ${ws.ognPeer} on ${address}`);

        ws.isAlive = true;
        ws.connectedAt = getNow();
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
        ws.on('error', console.error);
        ws.on('message', () => {
            /**/
        });

        // Send vario etc for all gliders we are tracking
        sendCurrentState(ws);
    });
}

function setupOgnWebServer(req, res) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'OPTIONS, GET, UPGRADE',
        'Access-Control-Max-Age': 5 * 60, // 5 minutes
        'Cache-Control': 'public, max-age=300, immutable, stale-while-revalidate=30'
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
    }

    // health check
    if (req?.url == '/status') {
        res.writeHead(200, headers);
        res.end(http.STATUS_CODES[200]);
        return;
    }

    // explict score request
    const [valid, command, channelName, timestampString, scoreId]: string[] = req?.url?.match(/^\/([a-z]+)\/([a-z0-9_-]+)\.(json|[0-9]+)(\/[0-9.]+|)(\.bin|)$/i) || [false, '', '', '', ''];
    const timestamp = parseInt(timestampString);
    if (valid) {
        console.log(command, channelName);
        if (channelName in channels) {
            const channel = channels[channelName];
            // Only support returning the scores
            switch (command) {
                case 'scores': {
                    console.log('sending scores for ', channelName);
                    const msg: any = channel.allScores ? OnglideWebSocketMessage.decode(channel.allScores) : {};
                    res.setHeader('Content-Type', 'application/json');
                    res.writeHead(200, headers);
                    res.end(JSON.stringify(msg));
                    return;
                }
                case 'scorehistory': {
                    // We need to produce a chunk that matches the timestamp provided
                    const chunkStart = timestamp - (timestamp % scoreChunkSize); // 30 minute chunks
                    const chunkEnd = chunkStart + scoreChunkSize; // 30 minute chunks
                    const d = (d) => new Date(d * 1000).toISOString();
                    console.log(`FOS: request for ${d(timestamp)} ${d(chunkStart)}=>${d(chunkEnd)} [${scoreId}]`);

                    const history: Record<Compno, {history: PilotScore[]}> = {};
                    let scoreCount = 0;
                    for (const [compno, scores] of channel.scoreHistory) {
                        const preceeding = scores.findLast((score) => score.t < chunkStart);
                        console.log(compno, 'preceeding score', preceeding?.t, d(preceeding?.t ?? 0));
                        history[compno] = {
                            history: [
                                ...(preceeding ? [preceeding] : []), // oldest one before the chunk so we have everybody
                                ...scores.filter((score) => score.t >= chunkStart && score.t <= chunkEnd)
                            ]
                        };
                        scoreCount += history[compno].history.length;
                    }

                    console.log('filtered history length', scoreCount);
                    const msg: any = ClassScoreHistory.encode({
                        className: channel.className,
                        datecode: '', // we need to use undefined otherwise it will die
                        pilots: history
                    }).finish();

                    console.log(`sending scorehistory ${channelName} ${scoreCount} = ${msg.length} bytes covering ${d(chunkStart)} - ${d(chunkEnd)}`);
                    console.table([...Object.keys(history)].flatMap((compno) => history[compno].history.map((h) => [compno, h.t, d(h.t), h.live])));

                    res.setHeader('Content-Type', 'application/octet-stream');
                    if (chunkEnd == timestamp + 1) {
                        console.log('allowing caching');
                        res.setHeader('Access-Control-Max-Age', 24 * 60 * 60); // 1 day
                    }

                    res.writeHead(200, headers);
                    res.write(msg, 'binary');
                    res.end(null, 'binary');
                    return;
                }

                case 'tracks': {
                    console.log(`sending historical data ${timestamp} ${new Date(timestamp * 1000).toISOString()} [current: ${channel.webPathBaseTime}]`);
                    if (channel.webPathData[timestamp]) {
                        res.setHeader('Content-Type', 'application/octet-stream');
                        res.writeHead(200, headers);
                        res.write(channel.webPathData[timestamp], 'binary');
                        res.end(null, 'binary');
                        return;
                    } else {
                        console.log('no historical data matching', channelName, timestamp);
                    }
                }
            }
        }
    }

    res.writeHead(404);
    res.end(http.STATUS_CODES[404]);
}
