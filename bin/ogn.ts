#!/usr/bin/env node

// Copyright 2020-2024 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {initialiseInsights, trackMetric, trackAggregatedMetric} from '../lib/insights';

import http from 'node:http';
import https from 'node:https';

import {readFileSync, existsSync, createWriteStream} from 'fs';

import SunCalc from 'suncalc';

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
import {calculateTask, taskGeoJSON} from '../lib/flightprocessing/taskhelper';

// Datecode helpers
import {fromDateCode, toDateCode} from '../lib/datecode';

// Message passed from the AprsContest Listener
import {PositionMessage, TasksTableRow, TaskLegsTableRow, ClassesTableRow, ContestDayTableRow} from '../lib/types';
const dev = process.env.NODE_ENV == 'development';
console.log('dev mode', dev);

let db: ReturnType<typeof mysql>;

// lodash
import {forEach, reduce, keyBy, filter as _filter, pick as _pick, map as _map, flatMap as _flatmap, remove as _remove, sortedIndex as _sortedIndex, sortedIndexBy as _sortedIndexBy} from 'lodash';

//import _remove from 'lodash.remove';
//import _groupby from 'lodash.groupby';
import {groupBy as _groupby, cloneDeep as _clonedeep, isEqual as _isEqual} from 'lodash';

// Launch our listener
import {AprsController} from '../lib/webworkers/aprs';

import {webPathBaseTimeDuration, scoreChunkSize} from '../lib/constants';

import {createHash, randomBytes, createHmac} from 'crypto';

// Communication with the workers
import {BroadcastChannel} from 'node:worker_threads';
let unknownChannel: BroadcastChannel | undefined;
let aprsController: AprsController | undefined;

// Data sources

import * as dotenv from 'dotenv';

// Handle fetching elevation and confirming size of the cache for tiles
import {getElevationOffset, getCacheSize} from '../lib/getelevationoffset';

// handle unkownn gliders
import {capturePossibleLaunchLanding} from '../lib/flightprocessing/launchlanding.js';

import {setSiteTz, getSiteTz, timeToText, dateToText} from '../lib/flightprocessing/timehelper.js';

import {Epoch, Datecode, Compno, FlarmID, ClassName, ClassName_Compno, makeClassname_Compno, ChannelName, Task, DeckData, AirfieldLocation} from '../lib/types';
import {ScoringController} from '../lib/webworkers/scoring';

let userLogStream: WriteStream | null = null;

process.setMaxListeners(35);

// Where is the comp based
let location: AirfieldLocation;

interface Statistics {
    periodStart: Epoch;

    outOfOrderPackets: number;
    insertedPackets: number;
    totalPackets: number;
    bytesSent: number;

    positionsSent: number;
    positionsSentCycles: number;
    listenerCycles: number; // trackpoint sent cycles
    statsCycles: number; // statistics reported cycles
    visibleListeners: number; // how many have page visible in browser
    interactingListeners: number; // how many have update options
    activeListeners: number; // how many have received points
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
    lastSentPositions: Epoch; // last time a positio message (empty of contents)n was sent comp time
    clients: OgnWebSocket[]; // all websockets for the channel

    broadcastChannel?: BroadcastChannel;
    scoring?: ScoringController;
    task?: any; // what task are we scoring - we use this to see if anything has changed
    geoTask?: any;
    gliderHash?: string;

    lastKeepAliveMsg?: any;

    statistics: Statistics;

    // Tasks we are working on or have had

    earliestScore: Epoch;
    earliestStart: Epoch;
    latestScore: Epoch;

    allScores: Record<Compno, PilotScore>;

    scoreId: string;
    proposedScoreId: string;
    liveScoreId: string;
    scoreIdUpdateRequired: boolean;
    scoresUpdatedAt: Epoch;
    scoreHistory: Map<string, Map<Compno, PilotScore[]>>;
    scoreDb: AbstractSublevel<ClassicLevel<Compno, string>, string | Buffer | Uint8Array, string, string>;

    // For the web buffer
    webPathBaseTime: Epoch;
    webPathData: Record<string, Buffer>;
    mostRecentPosition: Epoch; // last time we had something to send

    // Sending helpers
    sendBinary: (data: Uint8Array) => void;
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
    scoredFinish: Epoch;
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
    isValid: boolean;
    isAlive: boolean;
    isClosed?: boolean;
    isInteracting: boolean;
    isVisible: boolean;
    connectedAt: Epoch;
    sendBinary: (data: Uint8Array) => void;
}

// Load the current file & Get the parsed version of the configuration
const error = dotenv.config({path: '.env.local'}).error;

import {getNow, getDelay, readOnly, replayBase, d} from '../lib/now';

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

    if (readOnly) {
        console.log('readonly');
    }

    // Allow insights if it's configured.
    // DON'T TRACK DEPENDENCIES as it will pick up SQL statements
    // and we do a LOT of them
    initialiseInsights();

    const checkReady = async (): Promise<boolean> => {
        // Location comes from the competition table in the database
        location = (await db.query('SELECT name, lt as lat,lg as lng,tz,tzoffset, start, end FROM competition LIMIT 1'))?.[0];

        if (!location) {
            console.error('no competition entry in the database, please confirm soaringspot integration is working');
            console.table(await db.query<any[]>('SELECT * FROM competition'));
            return false;
        }

        if (!(await db.query<any[]>('SELECT * FROM compstatus'))?.length || !(await db.query<any[]>('SELECT * FROM classes'))?.length) {
            console.error('no classes configured');
            return false;
        }

        if (!replayBase && !(await db.query('SELECT MAX(datecode) as datecode FROM compstatus LIMIT 1'))?.[0]?.datecode) {
            console.warn('no current date found for competition');

            const currentExpectedDateCode = await getDCode();
            if (toDateCode(new Date(location.start)) > currentExpectedDateCode || toDateCode(new Date(location.end)) < currentExpectedDateCode) {
                console.error(
                    `Today  ${currentExpectedDateCode}/${fromDateCode(currentExpectedDateCode)} is outside of expected range ${toDateCode(location.start)}/${location.start} - ${toDateCode(location.end)}/${
                        location.end
                    } and no task configured - not tracking`
                );
                return false;
            }
            console.info(`Today  ${currentExpectedDateCode}/${fromDateCode(currentExpectedDateCode)} is inside of expected range ${toDateCode(location.start)}/${location.start} - ${toDateCode(location.end)}/${location.end}`);
        }
        return true;
    };

    while (!(await checkReady())) {
        await setTimeoutPromise(60000);
    }

    location.point = point([location.lng, location.lat]);
    location.officialDelay = getDelay();
    location.tzoffset = parseInt(location.tzoffset as unknown as string);

    // Save the tz for use
    setSiteTz(location.tz);

    console.log('Onglide OGN handler', readOnly ? '(read only)' : '', process.env.NEXT_PUBLIC_SITEURL);
    console.log(`db ${process.env.MYSQL_DATABASE} on ${process.env.MYSQL_HOST}`);
    process.title = process.env.MYSQL_DATABASE ?? 'unknown';

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

    aprsController = new AprsController({competition: internalName, location: {lt: location.lat, lg: location.lng}});

    {
        const datecode = await getDCode();
        getSunset(datecode);
        getProposedScoreId();
        userLogStream = createWriteStream(`${process.env.DB_PATH ?? './db/'}user-log.${internalName}-${datecode}.txt`, {flags: 'a'});
        aprsController?.datecode(datecode);
        await updateClasses(internalName, datecode);
        await updateTrackers(datecode);
        await updateTasks();
        await finaliseScoreId();
    }

    if ('PM2_HOME' in process.env || existsSync('.docker')) {
        console.log('PM2/DOCKER: waiting for scoring to be completed...');
        /*        const checkScoringNotReady = () => {
            const notReady = Object.values(channels).filter((c) => !c.liveScoreId);
            if (notReady.length) {
                console.log(`still need ${notReady.map((c) => c.className).join(',')} to finish scoring`);
            }
            return !notReady.length;
        };
        while (checkScoringNotReady()) {
            await setTimeoutPromise(1000);
        } */
        console.log('PM2/DOCKER: starting http(s) listener');
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
    } else {
        console.log(`Not initialising SSL: port: ${process.env.WEBSOCKET_PORT}, url: ${process.env.NEXT_PUBLIC_SITEURL}`);
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
                // We don't need to send empty packets but we should
                // occasionally as it keeps socket alive
                if (!channel.toSend.length) {
                    if (now - channel.lastSentPositions < 15) {
                        continue;
                    }
                } else {
                    // if we sent an actual coordinate then this will ensure
                    // that the webPathData is regenerated
                    channel.mostRecentPosition = now;
                }

                // Metrics are helpful
                channel.statistics.positionsSent += channel.toSend.length;
                channel.statistics.positionSentCycles++;
                // We don't want to send it twice so it can go
                channel.toSend = [];
                channel.lastSentPositions = now;

                // Send to each client and if they don't respond they will be cleaned up next time around
                channel.sendBinary(msg);
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

            channel.statistics.interactingListeners += channel.clients.reduce((count, c) => count + (c.isInteracting ? 1 : 0), 0);
            channel.statistics.visibleListeners += channel.clients.reduce((count, c) => count + (c.isVisible ? 1 : 0), 0);

            // Remove invalid
            const notValid = _remove(channel.clients, (client: OgnWebSocket) => {
                return client.isValid === false;
            });

            const closed = _remove(channel.clients, (client: OgnWebSocket) => {
                return client.isClosed === true;
            });

            // Remove any that are still marked as not alive
            const notAlive = _remove(channel.clients, (client: OgnWebSocket) => {
                return client.isAlive === false;
            });

            if (notAlive.length || notValid.length) {
                let viewTime = 0;
                [...notAlive, ...closed].forEach((client: OgnWebSocket) => {
                    channel.statistics.totalViewingTime += now - client.connectedAt;
                    viewTime += now - client.connectedAt;
                    client.terminate();
                });
                notValid.forEach((client: OgnWebSocket) => {
                    client.terminate();
                });
                console.log(`${channel.className}: ${notAlive.length} inactive, ${closed.length} closed += ${viewTime}s viewing time, ${notAlive.length ? viewTime / notAlive.length : '-'}s avg, ${notValid.length} notValid`);
            }

            // Send keep alive and reset the stats/status
            await sendKeepalive(channel);
        }

        //
        // Aggregate statistics
        for (const channelName in channels) {
            const channel = channels[channelName as ChannelName];

            channel.statistics.statsCycles++;
            channel.statistics.peakListeners = Math.max(channel.statistics.peakListeners, channel.statistics.activeListeners / channel.statistics.listenerCycles);

            // We need to accumulate how much time we have had
            const viewTime = channel.clients.reduce((total, client) => total + (now - client.connectedAt), 0);

            console.log(
                `${channelName}: ${channel.statistics.positionsSent} positions sent, ${channel.statistics.insertedPackets} inserted, ${channel.statistics.outOfOrderPackets} ooo, ${channel.statistics.totalPackets} total`
            );
            console.log(
                `${channelName}: ${(channel.statistics.activeListeners / channel.statistics.listenerCycles).toFixed(1)} avg listeners, interacting: ${(
                    channel.statistics.interactingListeners / channel.statistics.statsCycles
                ).toFixed(1)}, visible: ${(channel.statistics.visibleListeners / channel.statistics.statsCycles).toFixed(1)}, ${Math.round(
                    (channel.statistics.totalViewingTime + viewTime) / 60
                )}m total viewing time, peak avg ${channel.statistics.peakListeners.toFixed(0)}`
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
                channel.statistics.interactingListeners =
                channel.statistics.listenerCycles =
                channel.statistics.outOfOrderPackets =
                channel.statistics.insertedPackets =
                channel.statistics.totalPackets =
                    0;
        }
    }, 60 * 1000);

    //    console.log(getNow() - (getNow() % 60), (getNow() % 60) * (1000 / multiplier), multiplier, getNow());

    //
    // Update competition information
    setInterval(async function () {
        const datecode = await getDCode();
        const oldStream = userLogStream;
        userLogStream = null;
        oldStream?.end(() => {
            userLogStream = createWriteStream(`${process.env.DB_PATH ?? './db/'}user-log.${datecode}.txt`, {flags: 'a'});
        });
        getSunset(datecode);
        getProposedScoreId();
        aprsController?.datecode(datecode);
        await updateClasses(internalName, datecode);
        await updateTrackers(datecode);
        await updateTasks();
        await finaliseScoreId();
    }, 60 * 1000);
}

process.on('SIGINT', handleExit);
process.on('SIGHUP', handleExit);
process.on('SIGQUIT', handleExit);
process.on('SIGTERM', handleExit);

//
// Tidily exit if the user requests it
// we need to stop receiving,
// output the current data, close any databases,
// and then kill of any timers
async function handleExit(signal: string) {
    console.log(`received signal: ${signal}`);
    scoreDb?.close();
    aprsController?.shutdown();
    userLogStream?.end();
    setTimeout(() => process.exit(), 1000);
}
main().then(() => console.log('Started'));

function getSunset(datecode: Datecode) {
    const localMidday = new Date(fromDateCode(datecode)).getTime() - (location.tzoffset - 12 * 3600) * 1000;
    const sunset = Math.round(SunCalc.getTimes(new Date(localMidday), location.lat, location.lng).night.getTime() / 1000) as Epoch;
    if (sunset != location.sunset) {
        console.log(`Site sunset: ${d(sunset)} (site:${dateToText(sunset)}), dc: ${fromDateCode(datecode)}, localMidday: ${d(localMidday / 1000)} (site:${dateToText((localMidday / 1000) as Epoch)})`);
        location.sunset = sunset;
    }
}

// So we have a different channel for each date
function channelName(className: ClassName, datecode: Datecode): ChannelName {
    return (className + datecode).toUpperCase() as ChannelName;
}

//
// Get current date code
async function getDCode(): Promise<Datecode> {
    if (replayBase) {
        return;
        toDateCode(new Date(replayBase * 1000));
    }

    const local9am = Date.now() - (location.tzoffset - 9 * 3600) * 1000;
    return toDateCode(new Date(local9am));
}

import {ClassicLevel} from 'classic-level';
import {AbstractSublevel} from 'abstract-level';
import {WriteStream} from 'node:fs';
let scoreDb: ClassicLevel<Compno, string> | undefined = undefined;

//
// Fetch the trackers from the database
async function updateClasses(internalName: string, datecode: Datecode) {
    console.log(`updateClasses(${internalName}, ${datecode})`);

    if (!scoreDb) {
        const path = `${process.env.DB_PATH ?? './db/'}/scores-${internalName}.db`;
        console.log(`opening scoreDB ${path}`);
        scoreDb = new ClassicLevel(path);
        await scoreDb.open().catch((e) => console.log(e));
    }

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
                toSend: [],
                lastSentPositions: 0 as Epoch,
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
                    statsCycles: 0,
                    activeListeners: 0,
                    interactingListeners: 0,
                    visibleListeners: 0,
                    peakListeners: 0,
                    totalViewingTime: 0,
                    bytesSent: 0
                },
                // Info on what has been sent via https
                webPathBaseTime: 0 as Epoch,
                mostRecentPosition: getNow(),
                webPathData: {},
                scoreHistory: new Map(),
                allScores: {},
                scoreId,
                proposedScoreId: scoreId,
                liveScoreId: '',
                scoreIdUpdateRequired: false,
                scoresUpdatedAt: 0 as Epoch,
                earliestScore: Infinity as Epoch,
                earliestStart: Infinity as Epoch,
                scoreDb: scoreDb?.sublevel(cname),
                latestScore: 0 as Epoch,
                sendBinary(data: Uint8Array) {
                    this.clients.forEach((c: OgnWebSocket) => c.sendBinary(data));
                }
            };
            channel.scoreHistory.set(scoreId, new Map<Compno, PilotScore[]>());

            // Read any old history
            if (channel.scoreDb) {
                for await (const [compno, scoreJSON] of channel.scoreDb?.iterator() ?? []) {
                    const score = JSON.parse(scoreJSON);
                    if (!channel.liveScoreId) {
                        channel.liveScoreId = score.scoreId;
                    }
                    score.scoreId = channel.liveScoreId;
                    channel.allScores[compno] = score;
                }
                console.log(`${c.class}: ${Object.keys(channel.allScores).length} scores loaded on id ${channel.liveScoreId}`);
            } else {
                console.log(`${c.class}: no score db`);
            }
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
            channel.scoring.hookScore(({compno, score, recentStart, t, scoreId, migrateFrom}) => sendScore(channel, compno, score, recentStart, scoreId, t, migrateFrom));
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

    if (!Object.keys(newchannels).length && scoreDb) {
        console.log('closing scoredb, no channels');
        await scoreDb.close();
        scoreDb = undefined;
    }
}

async function updateTasks(): Promise<void> {
    // Get the details for the task
    const getTask = async (className: ClassName, datecode: Datecode) => {
        const taskdetails = ((await db.query<(TasksTableRow & {nostartutc: Epoch; durationsecs: number} & ClassesTableRow & ContestDayTableRow)[]>(escape`
          SELECT tasks.*, time_to_sec(tasks.duration) durationsecs, c.grandprixstart, c.handicapped, c.Dm, cd.calendardate, cd.status, cd.info,
CASE WHEN COALESCE(nostart,'00:00:00') ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(${fromDateCode(datecode)},' ',nostart))-(SELECT tzoffset FROM competition)
               END nostartutc
FROM tasks, classes c, contestday cd
          WHERE tasks.datecode= ${datecode}
             AND tasks.class = c.class AND cd.class = c.class AND cd.datecode = ${datecode}
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

        let task: Task = {
            rules: {
                grandprixstart: taskdetails.type == 'G' || taskdetails.type == 'E' || taskdetails.grandprixstart == 'Y',
                nostartutc: taskdetails.nostartutc,
                aat: taskdetails.type == 'A',
                dh: taskdetails.type == 'D',
                dm: taskdetails.Dm ?? undefined,
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

            // If it had a task, and doesn't any longer then just stop it scoring
            if (channel.task && !updatedTask) {
                console.log(`${channel.className}: ** clear task`);
                channel.scoring?.clearTask();
                channel.scoreHistory.clear();
                channel.allScores = {};
                channel.task = undefined;
                channel.geoTask = undefined;
                sendTask(channel, channel);
            }

            // We have a new task then we can start a new scoring iteration on it without
            // clearing the old one.
            if (updatedTask) {
                channel.task = updatedTask;
                channel.geoTask = taskGeoJSON(updatedTask);
                console.log(`${channel.className}: ** rescore ** ${channel.scoreId} => ${channel.proposedScoreId} (task changed)`);
                channel.scoreHistory.set(channel.proposedScoreId, new Map());
                channel.scoring?.setTask(channel.task, channel.proposedScoreId);
                channel.scoreIdUpdateRequired = true;
                sendTask(channel, channel);
            }
        }
    }
}

function sendTask(sendTo: Channel | OgnWebSocket, channel: Channel) {
    sendTo.sendBinary(
        OnglideWebSocketMessage.encode({
            //
            task: {
                ...(channel.task
                    ? {
                          geoJSON: JSON.stringify(channel.geoTask), //
                          taskJSON: JSON.stringify(channel.task)
                      }
                    : {})
            }
        }).finish()
    );
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
                                             END utcStart,
                                           CASE WHEN ppr.finish ='00:00:00' THEN 0
                                           ELSE UNIX_TIMESTAMP(CONCAT(${fromDateCode(datecode)},' ',ppr.finish))-(SELECT tzoffset FROM competition)
                                            END utcFinish,
                                           COALESCE(ppr.scoredStatus,'S') scoredStatus
                                        FROM pilots p left outer join tracker t on p.class=t.class and p.compno=t.compno left outer join
                                             (select compno,class,start,finish,scoredstatus from pilotresult pr where pr.datecode=${datecode}) as ppr
                                      ON ppr.class=p.class and ppr.compno=p.compno`);

    const initialGliderCount = Object.keys(gliders).length;
    let updatedGliderCount = 0;
    let loadedGliderCount = 0;

    const afterSunset = getNow() > location.sunset;
    console.log(`updateTrackers: ${afterSunset ? 'after sunset' : 'before sunset'} ${d(getNow())} > ${d(location.sunset)}`);

    // Filter out anything that doesn't match the input set, doesn't matter if it matches
    // unknowns as they won't be in the trackers pick
    const keyedDb = keyBy<CTrackerRow>(cTrackers, makeClassname_Compno);
    const removedGliders = _filter(gliders, (g) => {
        const newValue = keyedDb[makeClassname_Compno(g)];
        if (!newValue || newValue.dbTrackerId != g.dbTrackerId) {
            console.log(`${g?.compno} - new: ${newValue?.dbTrackerId} vs old: ${g.dbTrackerId} scoredStatus: ${newValue?.scoredStatus}`);
            return true; // removed or it has changed id
        }
        return g.datecode != datecode;
    });

    // Now unsubsribe from each of them
    removedGliders.forEach((g) => {
        console.log(`${g.className}:${g.compno} terminating scoring & tracking as no flarm ids found [channel ${g.channelName}]`);
        if (g.dbTrackerId && g.dbTrackerId != 'unknown') {
            aprsController?.untrackGlider(g.compno, g.className, g.channelName, g.dbTrackerId);
        }
        const channel = channels[g.channelName];
        if (channel) {
            channel.scoring?.clearGlider(g.compno);
            channel.scoreIdUpdateRequired = true; // ensure we change id even if nothing else changes - this should remove the glider from history
            delete channel.allScores[g.compno]; // remove from old scores as it's not valid any more
        }
    });

    // Timing issue as this is potentially async
    removedGliders.forEach((g) => {
        delete gliders[makeClassname_Compno(g)];
    });

    // Now go through all the desired gliders and make sure we have linked them
    const results = await Promise.allSettled(
        cTrackers
            .filter((t) => t.dbTrackerId)
            .map(async (t) => {
                const gliderKey = makeClassname_Compno(t);

                const startUtcChanged = gliders[gliderKey]?.utcStart != t.utcStart;
                const handicapChanged = gliders[gliderKey]?.handicap != t.handicap;
                const scoredStatusChanged = gliders[gliderKey]?.scoredStatus != t.scoredStatus;
                const hadTracker = !!gliders[gliderKey]?.flarmIdRegex;
                const listening = !afterSunset && t.scoredStatus == 'S';

                // glider key not enough to check for datecode changes (force ignore of
                // typescript types as we don't want the rest set yet because we need
                // to see if it's changed on existing object)
                const glider: Glider = (gliders[gliderKey] = Object.assign(
                    gliders[gliderKey] || {}, //
                    {...t, channelName: channelName(t.className, datecode), greg: t?.greg?.replace(/[^A-Z0-9]/i, ''), datecode} as any as Glider
                ));
                const channel = channels[glider.channelName];

                if (glider.scoringConfigured) {
                    if (scoredStatusChanged && t.scoredStatus != 'S') {
                        //                        console.log(`${glider.compno}: stopping scoring as status is ${t.scoredStatus} [channel ${glider.channelName}]`);
                        //                        channel?.scoring?.clearGlider(glider.compno);
                        console.log(`Finishing APRS Listener for glider ${t.className}:${t.compno} => ${t.dbTrackerId}`);
                        aprsController?.finishGlider(t.compno, t.className, glider.channelName);
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
                        channel.scoring?.setInitialTrack(glider.compno, glider.handicap, glider.utcStart, [], channel.proposedScoreId, channel.task);
                        initialiseDeck(glider.compno, glider, randomBytes(4).readUInt32BE(0));
                        glider.webPathEndPosition = 0;
                        glider.scoringConfigured = true;
                        channel.webPathBaseTime = 0 as Epoch; // new track inbound so reset things
                        channel.scoreIdUpdateRequired = true;
                    } catch (e) {
                        console.error(e);
                    }
                }

                // If we have a tracker for it then we need to link that as well
                if (!hadTracker && t.dbTrackerId && t.dbTrackerId != 'unknown') {
                    aprsController?.trackGlider(t.compno, t.className, datecode, glider.channelName, t.dbTrackerId, listening);
                    glider.flarmIdRegex = new RegExp(
                        `^(${t.dbTrackerId
                            .split(',')
                            .filter((i: string) => i.match(/[0-9A-F]{6}$/i))
                            .join('|')})`,
                        'i'
                    );
                }

                return {compno: t.compno, startUtcChanged, handicapChanged, scoredStatusChanged, hadTracker, scoringConfigured: glider.scoringConfigured, listening};
            })
    );

    try {
        const successfulFilter = <G>(r: PromiseSettledResult<G>): r is PromiseFulfilledResult<G> => r.status == 'fulfilled';
        const success = results.filter(successfulFilter).map((f) => f.value);
        const fr = (f) => {
            const filtered = success.filter(f);
            return filtered.length == success.length ? 'all' : filtered.length == 0 ? 'none' : `${filtered.map((c) => c.compno).join(',')} (${filtered.length}/${results.length})`;
        };

        console.log(
            `${datecode}: startChanged: ${fr((s) => s.startUtcChanged)} handicapChanged: ${fr((s) => s.handicapChanged)} scoreStatusChanged: ${fr((s) => s.scoreStatusChanged)}, hadTracker: ${fr(
                (s) => s.hadTracker
            )} scoring: ${fr((s) => s.scoringConfigured)} listening: ${fr((s) => s.listening)}`
        );

        if (success.length != results.length) {
            console.log('updateTrackers: exceptions thrown');
            console.table(results.filter((r) => r.status != 'fulfilled'));
        }
    } catch (e) {
        console.log(e);
    }

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
            if (gliders[makeClassname_Compno(c as ClassName, d.compno as Compno)]) {
                gliders[makeClassname_Compno(c as ClassName, d.compno as Compno)].duplicate = 1;
            }
        });
    });
}

async function finaliseScoreId() {
    for (const channel of Object.values(channels)) {
        if (channel.scoreIdUpdateRequired) {
            channel.scoring?.updateScoreId(channel.scoreId, channel.proposedScoreId);
            channel.scoreId = channel.proposedScoreId;
            channel.scoreIdUpdateRequired = false;
        }
    }
}
function getProposedScoreId() {
    for (const channel of Object.values(channels)) {
        channel.proposedScoreId = (Math.random() * 10000).toFixed(1);
        channel.scoreIdUpdateRequired = false;
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
            console.log('ddb entries:', Object.keys(ddb).length);
        })
        .catch((e) => {
            console.log('unable to fetch ddb', e);
        });
}

//
// New connection, send it a packet for each glider we are tracking
async function sendCurrentState(client: OgnWebSocket) {
    if (client.readyState !== WebSocket.OPEN) {
        return;
    }
    if (!client.isAlive || !channels[client.ognChannel]) {
        console.log(`unable to send sendCurrentState: ${client.isAlive}, ${client.ognChannel}`);
        return;
    }

    // Ensure they have a full set of scores
    sendAllScores(client);

    const channel = channels[client.ognChannel];
    // Send the current task
    sendTask(client, channel);
    client.sendBinary(await generateRecentPilotTracks(channel));
    if (channel.lastKeepAliveMsg) {
        client.sendBinary(channel.lastKeepAliveMsg);
    }
}

async function generateHistoricalTracks(channel: Channel): Promise<void> {
    // Figure out the block that preceeds us, we do it a little late to allow reconnects to use websocket only
    const now = (channel.mostRecentPosition - 30) as Epoch;
    const base = now - webPathBaseTimeDuration; // determine the last block block
    const firstPointTime = Math.min(channel.earliestStart ?? channel.earliestScore ?? Infinity, now - 120);

    if (now - (channel.webPathBaseTime ?? 0) > webPathBaseTimeDuration) {
        console.log(`generateHistoricalTracks mostRecentPosition: ${d(now)}, base: ${d(base)}, previous: ${d(channel.webPathBaseTime)}`);
        const toStream = reduce(
            gliders,
            (result, glider, compno) => {
                if (glider.className == channel.className) {
                    const p = glider.deck;
                    if (p) {
                        const start = Math.max(Math.min(_sortedIndex(p.t.subarray(0, p.posIndex), firstPointTime), p.posIndex - 3), 0);
                        const end = Math.max(Math.min(_sortedIndex(p.t.subarray(0, p.posIndex), now), p.posIndex - 2), 0);
                        const length = end - start;
                        //                        console.log(`${compno}: ${end} - ${start} = ${length}, ${d(p.t[start])} => ${d(p.t[end])}, posIndex: ${p.posIndex} ,${d(glider.utcStart ?? 0)}`);
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
                    } else {
                        glider.webPathEndPosition = 0;
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
async function generateRecentPilotTracks(channel: Channel) {
    // Make sure they are up to date (does nothing if they are)
    await generateHistoricalTracks(channel);

    const toStream = reduce(
        gliders,
        (result, glider) => {
            if (glider.className == channel.className) {
                const p = glider.deck;
                if (p) {
                    const start = glider.webPathEndPosition;
                    const end = p.posIndex;
                    const length = end - start;
                    if (length > 0) {
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
    return OnglideWebSocketMessage.encode({tracks: {pilots: toStream, baseTime: channel.webPathBaseTime ?? 0}}).finish();
}

function getIdentifiers(channel: Channel) {
    [channel.earliestStart, channel.earliestScore, channel.latestScore] = Object.values(channel.allScores).reduce(
        ([earliestStart, earliestScore, latestScore], score) => [
            Math.min((score.utcStart ?? 0) < 10 ? Infinity : score.utcStart, earliestStart), //
            Math.min((score.t ?? 0) < 10 ? Infinity : score.t, earliestScore),
            Math.max(score.utcFinish || ((score.t ?? 0) < 10 ? 0 : score.t), latestScore)
        ],
        [Infinity, Infinity, 0]
    ) as [Epoch, Epoch, Epoch];

    return {
        className: channel.className,
        datecode: channel.datecode,
        competition: '1', //
        earliestScore: channel.earliestStart < Infinity ? channel.earliestStart - 60 : channel.earliestScore < Infinity ? channel.earliestScore : getNow(),
        latestScore: channel.latestScore,
        scoreId: channel.liveScoreId
    };
}

async function sendAllScores(client: OgnWebSocket) {
    const channel = channels[client.ognChannel];
    if (!channel || client.readyState !== WebSocket.OPEN) {
        return;
    }

    const updatedIdentifiers = OnglideWebSocketMessage.encode(
        {
            identifiers: getIdentifiers(channel),
            scores: {
                scoreId: channel.liveScoreId,
                pilots: channel.allScores
            },
            t: getNow()
        } //
    ).finish();

    // If it's after a join then only send to the one client
    client.sendBinary(updatedIdentifiers);
}

async function sendIdentifiersToAll(channel: Channel, includeScore: boolean = false) {
    const updatedIdentifiers = OnglideWebSocketMessage.encode(
        {
            identifiers: getIdentifiers(channel),
            t: getNow(),
            ...(includeScore
                ? {
                      scores: {
                          scoreId: channel.scoreId,
                          pilots: channel.allScores
                      }
                  }
                : {})
        } //
    ).finish();

    // If it's after a join then only send to the one client
    channel.sendBinary(updatedIdentifiers);
}

// We need to fetch and repeat the scores for each class, enriched with vario information
// This means SWR doesn't need to timed reload which will help with how well the site redisplays
// information
async function sendScore(channel: Channel, compno: Compno, score: PilotScore, recentStart: Epoch | undefined, scoreId: string, t: Epoch | undefined, migrateFrom: string) {
    if (compno == '_live') {
        console.log(`${channel.className}: received _live marker for [${scoreId}], channel scoreIds live:${channel.liveScoreId}, current: ${channel.scoreId} ${d(t)}`);
        if (channel.liveScoreId != scoreId) {
            channel.scoreHistory.delete(channel.liveScoreId);
        }
        channel.liveScoreId = scoreId;
        channel.webPathBaseTime = 0 as Epoch; // we rescored so probably all the tracks have changed
        sendIdentifiersToAll(channel, true);
        console.log(`${channel.className}/${channel.datecode}: updating all tracks`);
        channel.sendBinary(await generateRecentPilotTracks(channel));

        const pendingChannels = Object.values(channels).filter((c) => !c.liveScoreId);
        if (pendingChannels.length) {
            console.log(`Channels not yet scored: ${pendingChannels.map((c) => `${c.className} (${c.datecode})`).join(', ')}`);
        } else {
            console.log('all channels scored');
            if (process?.send) {
                console.log('*** sent process ready');
                process.send('ready');
            }
            try {
                for (const compno in channel.allScores) {
                    await channel.scoreDb?.put(compno, JSON.stringify(channel.allScores[compno]));
                }
            } catch (e) {
                console.log(e);
            }
        }
        return;
    }

    // Check if it's a scoreId that is active, if not we don't do anything with it
    // one is rescore and one is live they may be the same
    if (channel.scoreId == scoreId || channel.liveScoreId == scoreId) {
        // If it's a migration of historical scores then we need to copy all of them because
        // the history is not stored in the scoreCollector
        if (migrateFrom) {
            let shidFrom = channel.scoreHistory.get(migrateFrom);
            let shidTo = channel.scoreHistory.get(scoreId);
            if (!shidTo) {
                channel.scoreHistory.set(scoreId, (shidTo = new Map()));
            }
            let shCompno = shidFrom?.get(compno);
            shidTo.set(compno, shCompno ?? []);
        }

        // Historical scores
        if (t) {
            let shid = channel.scoreHistory.get(scoreId);
            if (!shid) {
                channel.scoreHistory.set(scoreId, (shid = new Map()));
            }
            let sh = shid.get(compno);
            if (!sh) {
                shid.set(compno, (sh = []));
            }
            const index = _sortedIndexBy(sh, {t} as unknown as PilotScore, (x) => x.t);
            if (index < sh.length - 1 && index >= 0) {
                console.log(`***** ${compno} rewind score history from ${d(sh.at(-1)?.t ?? 0)} to ${d(sh[index].t)} sh:[${index}/${sh.length}]`);
            }
            sh.splice(index, Infinity, score);
        }

        // Score from Live packets (either end of rescore or end of current score)
        if (score.live) {
            const msg = OnglideWebSocketMessage.encode({scores: {scoreId, pilots: {[compno]: score}}}).finish();
            channel.statistics.bytesSent += channel.clients.length * msg.byteLength;
            trackMetric(channel.className + '.scoring.bytesSent', msg.byteLength * channel.clients.length);
            channel.sendBinary(msg);

            // We record this as the latest we are aware of - it's possible it will be wrong as
            // we don't differentiate between the two scoreIds but it's not a history so will
            // be fixed after a rescore. It could jump between two scores as the old scoring is terminated
            channel.allScores[compno] = score;
            channel.scoreDb?.put(compno, JSON.stringify(score)).catch((e) => {
                console.log(`error saving score ${compno}, ${e}`);
            });
        }
    }

    const glider = gliders[makeClassname_Compno(channel.className, compno as Compno)];
    if (glider && glider.scoredStart != (score.utcStart as Epoch)) {
        // Reset the glider starting point, but also the channel so we don't use invalid
        // mix of the two
        const oldStart = glider.scoredStart;
        glider.webPathEndPosition = 0;
        channel.webPathBaseTime = 0 as Epoch;
        glider.scoredStart = score.utcStart as Epoch;

        const channelGliders = Object.values(gliders).filter((glider) => glider.className == channel.className && glider.dbTrackerId && glider.dbTrackerId != 'unknown');

        channel.earliestStart = channelGliders.reduce((min, glider) => Math.min(min, glider.scoredStart ?? Infinity) as Epoch, Infinity as Epoch);

        console.log(`${compno}: start time changed from ${d(oldStart)} to ${d(score.utcStart)}, [class earliest start ${d(channel.earliestStart)}] resetting tracks`);

        const mcs = channelGliders.reduce((all, glider) => {
            if (glider.scoredStart) {
                const ti = Math.trunc(glider.scoredStart / 300) * 300;
                all[ti] = (all[ti] ?? 0) + 1;
            }
            return all;
        }, {} as Record<number, number>);

        const likelyA = Object.keys(mcs)
            .sort((a, b) => mcs[a] - mcs[b])
            .filter((a) => mcs[a] > channelGliders.length / 2);
        const likely = Object.keys(mcs)
            .sort((a, b) => mcs[a] - mcs[b])
            .filter((a) => mcs[a] > channelGliders.length / 2)?.[0];

        console.log(`${channel.className} likely GP start ${d(Number(likely))}`);
        console.table(mcs);
    }

    if (glider && glider.scoredFinish != (score.utcFinish as Epoch)) {
        // Reset the glider starting point, but also the channel so we don't use invalid
        // mix of the two
        console.log(`${compno}: finish time changed from ${glider.scoredFinish} to ${score.utcFinish}`);
        glider.scoredFinish = score.utcFinish as Epoch;
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
        identifiers: getIdentifiers(channel),
        t: now,
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
        client.isInteracting = false;
        client.isVisible = false;
        client.ping(function () {});
    });
}

//
// This is a complete message that can be sent to the client,
// it's complete with the vario elevation etc
async function processAprsMessage(className: string, channel: Channel, message: PositionMessage) {
    // Lookup the glider
    const glider = gliders[makeClassname_Compno(channel.className, message.c as Compno)];

    if (!glider) {
        console.log(`${className}/${message.c}: unexpected position ${d(message.t)}`);
        return;
    }

    // If we have a reset message
    if (message.t == (0 as Epoch)) {
        console.log(`${className}/${message.c}: new track start received`);
        initialiseDeck(message.c as Compno, glider, randomBytes(4).readUInt32BE(0));
        return;
    }

    // We have everything therefore we need to reset the available tracks for new connections
    /*    if (message.t == (2 as Epoch)) {
        console.log(`${className}/${message.c}: track up to date, setting a resend`);
        channel.webPathBaseTime = 0 as Epoch;
        channel.resendTracks = async () => {
            console.log(`${channel.className}/${channel.datecode}: updating all tracks`);
            channel.resendTracks = null; // we will shortly have done it so no need to
            // keep this function.
            channel.sendBinary(await generateRecentPilotTracks(channel));
        };
        return;
    } */

    // We ignore ticks
    if ('tick' in message) {
        return;
    }

    // Check if they are a launch
    if (message.g > 100 && !channel.launching) {
        console.log(`Launch detected: ${glider.compno}, class: ${glider.className}`);
        channel.launching = true;
    }

    // Merge into the display data structure
    if (!mergePoint(message, glider)) {
        channel.statistics.outOfOrderPackets++;
    } else {
        // If the packet isn't delayed then we should send it out over our websocket
        if (message._) {
            // Buffer the message they get batched every second
            channel.toSend.push(message);

            // how many gliders are we tracking for this channel
            channel.activeGliders.add(message.c as Compno);
        }
        channel.statistics.totalPackets++;
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
            console.log(unknownTrackers[flarmId].message);
            console.table(gliders);
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
        aprsController?.trackGlider(match.compno, match.className, datecode, channelName(match.className, datecode), flarmId, true);

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
            ws.isValid = false;
            ws.isClosed = false;
            return;
        }

        // Strip leading /
        const channelName = req.url.substring(1, req.url.length) as ChannelName;

        ws.ognChannel = channelName;
        ws.ognPeer = req.headers['x-forwarded-for']?.toString() ?? req.connection.remoteAddress ?? 'unknown';
        //        console.log(`connection received for ${channel} from ${ws.ognPeer} on ${address}`);

        ws.isAlive = true;
        ws.isValid = true;
        ws.isClosed = false;
        ws.isInteracting = false;
        ws.connectedAt = getNow();
        if (channelName in channels) {
            channels[channelName].clients.push(ws);
        } else {
            ws.send('reload');
            ws.isAlive = false;
            ws.isValid = false;
            return;
        }

        ws.on('pong', () => {
            //            console.log('pong');
            ws.isAlive = true;
        });
        ws.on('close', () => {
            ws.isAlive = false;
            ws.isClosed = true;
            //            console.log(`close received from ${ws.ognPeer} ${ws.ognChannel}`);
        });
        ws.on('error', console.error);
        ws.on('message', (cx) => {
            try {
                const msg = JSON.parse(cx.toString());
                if ('v' in msg) {
                    ws.isVisible = !!msg.v;
                } else if ('compno' in msg) {
                    ws.isInteracting = true;
                    userLogStream?.write(new Date().toISOString() + ':' + channelName + ':' + cx.toString() + '\n');
                }
            } catch (e) {
                /**/
            }
        });

        const channel = channels[channelName];
        ws.sendBinary = (data: Uint8Array) => {
            if (ws.readyState == WebSocket.OPEN && ws.isAlive && channel) {
                channel.statistics.bytesSent += data.byteLength;
                return ws.send(data, {binary: true});
            }
            return undefined;
        };

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
        console.log('request for status - ok');
        res.writeHead(200, headers);
        res.end(http.STATUS_CODES[200]);
        return;
    }

    // explict score request
    const [valid, command, channelName, timestampString, pScoreId]: string[] = req?.url?.match(/^\/([a-z]+)\/([a-z0-9_-]+)\.(json|[0-9]+)(\/[0-9.]+|)(\.bin|)$/i) || [false, '', '', '', ''];
    const timestamp = parseInt(timestampString);
    if (valid) {
        console.log(command, channelName);
        if (channelName in channels) {
            const channel = channels[channelName];
            // Only support returning the scores
            switch (command) {
                case 'scores': {
                    console.log('sending scores for ', channelName);
                    res.setHeader('Content-Type', 'application/json');
                    res.writeHead(200, headers);
                    res.end(JSON.stringify({scores: {scoreId: channel.scoreId, pilots: channel.allScores}}));
                    return;
                }
                case 'scorehistory': {
                    // We need to produce a chunk that matches the timestamp provided
                    const chunkStart = timestamp - (timestamp % scoreChunkSize); // 30 minute chunks
                    const chunkEnd = chunkStart + scoreChunkSize; // 30 minute chunks
                    const scoreId = pScoreId.substring(1); // has leading '/' from url regex
                    const d = (d) => new Date(d * 1000).toISOString();

                    const history: Record<Compno, {history: PilotScore[]}> = {};
                    let scoreCount = 0;
                    let glidersWithScores = 0;
                    for (const [compno, scores] of channel.scoreHistory.get(scoreId) ?? []) {
                        const preceeding = scores.findLast((score) => score.t < chunkStart);
                        history[compno] = {
                            history: [
                                ...(preceeding ? [preceeding] : []), // oldest one before the chunk so we have everybody
                                ...scores.filter((score) => score.t >= chunkStart && score.t <= chunkEnd)
                            ]
                        };
                        scoreCount += history[compno].history.length;
                        glidersWithScores += history[compno].history.length ? 1 : 0;
                    }

                    const msg: any = ClassScoreHistory.encode({
                        className: channel.className,
                        datecode: '', // we need to use undefined otherwise it will die
                        pilots: history
                    }).finish();

                    const cacheTtl = chunkEnd == timestamp + 1 ? 24 * 60 * 60 : 60;

                    console.log(
                        `${channelName}: sending scorehistory ${timestamp}: ${scoreCount} scores, ${glidersWithScores} gliders = ${msg.length} bytes covering ${d(chunkStart)} - ${d(
                            chunkEnd
                        )} [${scoreId}] ${cacheTtl}s cache ttl`
                    );
                    headers['Content-Type'] = 'application/octet-stream';
                    headers['Access-Control-Max-Age'] = cacheTtl; // 1 day
                    headers['Cache-Control'] = `public, max-age=${cacheTtl}, immutable, stale-while-revalidate=${cacheTtl}`;
                    res.writeHead(200, headers);
                    res.write(msg, 'binary');
                    res.end(null, 'binary');
                    return;
                }

                case 'tracks': {
                    console.log(`${channelName}: sending historical data ${timestamp} ${new Date(timestamp * 1000).toISOString()} [current: ${channel.webPathBaseTime}]`);
                    if (channel.webPathData[timestamp]) {
                        headers['Content-Type'] = 'application/octet-stream';
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
