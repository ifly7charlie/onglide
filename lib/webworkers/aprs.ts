//
// This webworker will parse inbound APRS messages and package them to be passed to
// both scoring and the front end using messages
//

//
// Subscribe to APRS and then broadcast to
// -> `Unknown_${competitionName}` for close to airfield but unknown
// -> `${className}` for known gliders
//
// Control channel allows adding new trackers and stopping the
// worker

// Import the APRS server
import {ISSocket} from 'js-aprs-is';
import {aprsParser, aprsPacket} from 'js-aprs-fap';

import {version} from '../../package.json';

// Correction factors
//import {altitudeOffsetAdjust} from '../offsets.js';
import {getElevationOffset} from '../getelevationoffset';
//import { getOffset } from '../egm96.mjs';

// Helper function for geometry
import distance from '@turf/distance';
import {Coord, point} from '@turf/helpers';

// For smoothing altitudes
//import KalmanFilter from 'kalmanjs';

import {getNow} from '../now';
import {getCurrentDateCode} from '../datecode';

import {PositionMessage} from '../types';
interface InterimPositionMessage extends PositionMessage {
    //    aircraft: Aircraft;
    j?: Coord;
    f: FlarmID; // id
    o: string; // sender
}

import {Epoch, ClassName_Compno, ClassName, AltitudeAgl, makeClassname_Compno, Compno, FlarmID, ChannelName, Bearing, Speed, Datecode} from '../types';

// APRS connection
let connection;
const possibleServers = ['glidern1.glidernet.org', 'glidern2.glidernet.org', 'glidern3.glidernet.org', 'glidern4.glidernet.org'];

import {BroadcastChannel, Worker, parentPort, isMainThread, workerData, SHARE_ENV} from 'node:worker_threads';

import {trackMetric, initialiseInsights} from '../insights';
//import {pathToFileURL} from 'node:url';

import {sortedLastIndexBy as _sortedLastIndexBy, sortedIndexBy as _sortedIndexBy} from 'lodash';

export enum AprsCommandEnum {
    none,
    shutdown,
    track,
    finish,
    untrack
}

export type AprsCommand = AprsCommandShutdown | AprsCommandTrack | AprsCommandUntrack | AprsCommandFinish;

// Request a glider to be tracked
export interface AprsCommandTrack {
    action: AprsCommandEnum.track;

    className: ClassName;
    channelName: string;
    compno: string | Compno;
    datecode: Datecode;
    receiveNewPoints: boolean;
    trackerId: string | string[];
}

export interface AprsCommandUntrack {
    action: AprsCommandEnum.untrack;

    className: string | ClassName;
    channelName: string;
    compno: string | Compno;
    trackerId: string | string[];
}

export interface AprsCommandFinish {
    action: AprsCommandEnum.finish;

    className: string | ClassName;
    channelName: string;
    compno: string | Compno;
}

// Exit
export interface AprsCommandShutdown {
    action: AprsCommandEnum.shutdown;
}

export interface AprsListenerConfig {
    competition: string;
    location: {
        lt: number;
        lg: number;
    };
}

// Keep track of some basic statistics
const statistics = {
    msgsReceived: 0,
    knownReceived: 0,
    aprsDelay: 0,
    normalPackets: 0,
    aprsDelayForDelayed: 0,
    delayedPackets: 0,
    periodStart: 0,
    outOfOrder: 0,
    duplicates: 0,
    invalidPacket: 0,
    jumps: 0,
    finishPoints: 0,
    server: '-not connected-'
};

// Keep track of the aircraft requested
interface Aircraft {
    compno: string;
    className: string;
    trackers: FlarmID[];

    receiveNewPoints: boolean;

    lastTime?: number;
    lastSent?: InterimPositionMessage;
    lastMoved?: number;
    lastTick: Epoch;

    kf?: any; // altitude smoothing
    stationary: number; // consecutive stationary fixes
    ground: boolean;

    channel?: BroadcastChannel; // where to send packets

    messages: InterimPositionMessage[]; // sorted array of all packets received for the glider

    // Logging for aircraft
    log: (...x) => void;

    // Interval handler
    interval?: NodeJS.Timeout;
}

interface Tracker {
    id: FlarmID;
    index: number;
    aircraftList: Aircraft[];
    receiveNewPoints: boolean;
    db: AbstractSublevel<DB, string | Uint8Array | Buffer, string, string> | undefined;
}

// Where is the airfield?
let airfieldLocation: Coord;
let airfieldElevation: AltitudeAgl;

// And where to send unknown gliders close to the airfield
let unknownChannel: BroadcastChannel;

// Mapping by class/compno to aircraft record
const aircraft: Record<ClassName_Compno, Aircraft> = {};

// Mapping by trackerid to aircraft record
const trackers: Record<FlarmID, Tracker> = {};

// ID for each receiver
let highestReceiverId: number = 0;
const receivers: Record<string, number> = {};

// And for sending message onwards - all we do here is fetch and enrich
const channels: Record<ChannelName, BroadcastChannel> = {};

// Our persistence
import {ClassicLevel} from 'classic-level';
import type {AbstractSublevel} from 'abstract-level';
class DB extends ClassicLevel<string, string> {}
let db: DB | undefined;
let datecode: Datecode = '000' as Datecode;

//
// Start a listener
export class AprsController {
    worker: Worker;

    constructor(config: AprsListenerConfig) {
        if (!isMainThread) {
            throw new Error('umm, this is only available in main thread');
        }
        console.log('Starting APRS worker thread');

        this.worker = new Worker(__filename, {env: SHARE_ENV, workerData: config});
    }

    trackGlider(compno: Compno, className: ClassName, datecode: Datecode, channelName: ChannelName, trackerIds: string, receiveNewPoints: boolean) {
        const flarmIDs = trackerIds
            .split(/[:,]/)
            .map((i) => i.toUpperCase())
            .filter((i) => i.match(/[0-9A-Fa-f]{6}$/)) as string[];
        console.log('TRACKGLIDER', compno, flarmIDs);
        if (flarmIDs && flarmIDs.length) {
            // Tell APRS to start listening for the flarmid
            console.log(`Starting APRS Listener for glider ${className}:${compno} => ${flarmIDs.join(',')} [${channelName}]`);
            const command: AprsCommandTrack = {
                action: AprsCommandEnum.track,
                compno: compno, //
                className: className,
                channelName,
                datecode,
                receiveNewPoints,
                trackerId: flarmIDs
            };
            this.worker.postMessage?.(command);
        } else {
            console.log(`not tracking ${className}:${compno} => ${flarmIDs}`);
        }
    }
    untrackGlider(compno: Compno, className: ClassName, channelName: string, trackerIds: string) {
        const flarmIDs = trackerIds
            .split(/[:,]/)
            .map((i) => i.toUpperCase())
            .filter((i) => i.match(/[0-9A-Fa-f]{6}$/)) as string[];
        if (flarmIDs && flarmIDs.length) {
            // Tell APRS to start listening for the flarmid
            console.log(`Stopping APRS Listener for glider ${className}:${compno} => ${flarmIDs.join(',')} [${channelName}]`);
            const command: AprsCommandUntrack = {
                action: AprsCommandEnum.untrack,
                compno: compno, //
                className: className,
                channelName: channelName,
                trackerId: flarmIDs
            };
            this.worker.postMessage?.(command);
        }
    }
    finishGlider(compno: Compno, className: ClassName, channelName: string) {
        console.log(`Finishing APRS Listener for glider ${className}/${compno}: [${channelName}]`);
        const command: AprsCommandFinish = {
            action: AprsCommandEnum.finish,
            compno: compno, //
            className: className,
            channelName: channelName
        };
        this.worker.postMessage?.(command);
    }
}

if (!isMainThread && parentPort) {
    console.log('Started APRS worker thread');

    //    initialiseInsights();

    // The parent can post a few different messages to us

    //
    // action: shutdown
    // action: track
    parentPort.on('message', (task: AprsCommand) => {
        // If we have been asked to exit then do so
        if (task.action == AprsCommandEnum.shutdown) {
            console.log('closing worker');
            process.exit();
        }

        // Track a specific glider - this effectively associates the
        // tracker ID with the glider
        switch (task.action) {
            case AprsCommandEnum.track:
                trackGlider(task);
                break;
            case AprsCommandEnum.untrack:
                untrackGlider(task);
                break;
            case AprsCommandEnum.finish:
                finishGlider(task);
                break;
        }
    });

    // Any unknown gliders get sent to this for identification
    unknownChannel = new BroadcastChannel('Unknown_' + workerData.competition);

    startAprsListener(<AprsListenerConfig>workerData);
}

async function initDB(datecode: Datecode) {
    if (db) {
        return db;
    }

    const path = `${process.env.DB_PATH ?? './db/'}/aprs-${datecode}.db`;
    console.log('opening points database', path);
    const openedDb = (db = new DB(path));
    await openedDb.open().catch((e: any) => {
        console.log(`${path}: Failed to open: ${e.cause?.code || e.code}`);
        return undefined;
    });

    if (!(openedDb?.status == 'open' || openedDb?.status == 'opening')) {
        console.log(path, openedDb?.status, new Error('db status invalid'));
        db = undefined;
        return undefined;
    }
    return openedDb;
}

//
// Connect to the APRS Server
function startAprsListener(config: AprsListenerConfig) {
    if (process.env.REPLAY_DB) {
        return;
    }

    // Settings for connecting to the APRS server
    const PASSCODE = -1;
    const APRSSERVER = (statistics.server = process.env.APRS_SERVER || possibleServers[Math.trunc(possibleServers.length * Math.random())]);
    const PORTNUMBER = 14580;
    const FILTER = `r/${config.location.lt}/${config.location.lg}/250`;

    let unstableCount = 0;

    // Save away where we are
    airfieldLocation = point([config.location.lt, config.location.lg]);
    getElevationOffset(config.location.lt, config.location.lg, (e) => (airfieldElevation = e));

    // Connect to the APRS server
    connection = new ISSocket(`onglide ${version}`, APRSSERVER, PORTNUMBER, 'OG', -1, true, 'id', FILTER);
    let parser = new aprsParser();

    // Handle a connect
    connection.on('connect', () => {
        connection.sendLogin();
        connection.sendLine(`# onglide ${config.competition}`);
    });

    // Handle a data packet
    connection.on('packet', (data: string) => {
        connection.valid = true;
        if (data.charAt(0) != '#' && !data.startsWith('user')) {
            const packet = parser.parseaprs(data);
            if (packet && 'latitude' in packet && 'longitude' in packet && 'comment' in packet && packet.comment?.startsWith('id')) {
                processPacket(packet).catch((e) => console.error(e));
            } else {
                statistics.invalidPacket++;
            }
        } else {
            // Server keepalive
            console.log(data);
            if (data.match(/aprsc/)) {
                connection.aprsc = data;
            }
        }
    });

    // Failed to connect
    connection.on('error', (err) => {
        console.log('Error: ' + err);
        connection.disconnect();
        statistics.server += '!';
        unstableCount += 2;
        if (unstableCount > 5) {
            console.log(`${APRSSERVER} too unstable, restarting APRS listener with different server`);
            clearInterval(kaInterval);
            startAprsListener(config);
        }
        setTimeout(() => connection.connect(), unstableCount * 2000);
    });

    // Start the APRS connection
    connection.connect();

    // And every minute we need to confirm the APRS
    // connection has had some traffic
    const kaInterval = setInterval(function () {
        // Log and reset statistics
        const period = (Date.now() - statistics.periodStart) / 1000;

        // Into insights
        if (statistics.periodStart) {
            console.log(period);
            console.log(
                `APRS: ${statistics.knownReceived}/${statistics.msgsReceived} msgs, ${(statistics.msgsReceived / period).toFixed(1)} msg/s,  ooo ${statistics.outOfOrder}, dup: ${statistics.duplicates}, invalid: ${
                    statistics.invalidPacket
                }, finished: ${statistics.finishPoints}, aprs server unstableCount: ${unstableCount}`
            );
            console.log(`APRS: NORMAL average delay: ${(statistics.aprsDelay / statistics.normalPackets).toFixed(1)}s`);
            console.log(
                statistics.delayedPackets
                    ? `APRS: DELAYED average delay: ${(statistics.aprsDelayForDelayed / statistics.delayedPackets).toFixed(1)}, ${((100 * statistics.delayedPackets) / statistics.msgsReceived).toFixed(0)}% packets delayed`
                    : ''
            );
            trackMetric('aprs.msgsReceived', statistics.msgsReceived);
            trackMetric('aprs.msgsSec', statistics.msgsReceived / period);
            trackMetric('aprs.avgDelay', statistics.aprsDelay / statistics.msgsReceived);
            trackMetric('aprs.server', parseInt(APRSSERVER.match(/([0-9])/)?.[0] || '99'));
            trackMetric('aprs.jumps', statistics.jumps);
        }

        statistics.msgsReceived =
            statistics.aprsDelay =
            statistics.aprsDelayForDelayed =
            statistics.delayedPackets = //
            statistics.knownReceived =
            statistics.invalidPacket =
            statistics.finishPoints =
            statistics.jumps =
                0;

        statistics.periodStart = Date.now();
        if (unstableCount > 0) {
            unstableCount--;
        }
        trackMetric('aprs.unstableCount', unstableCount);

        // send a keepalive
        console.log('sending keepalive', `# ${config.competition}`);
        try {
            // Send APRS keep alive or we will get dumped
            connection.sendLine(`# ${config.competition}`);
        } catch (x) {
            console.log('unable to send keepalive', x);
            connection.valid = false;
        }

        // Re-establish the APRS connection if we haven't had anything in
        if (!connection.valid) {
            console.log(`failed APRS connection to ${APRSSERVER}, retrying usc:${unstableCount} `);
            connection.disconnect(() => {
                unstableCount += 2;
                if (unstableCount > 5) {
                    console.log(`${APRSSERVER} too unstable, restarting APRS listener with different server`);
                    clearInterval(kaInterval);
                    startAprsListener(config);
                    trackMetric('aprs.restart', 1);
                }
                connection.connect();
            });
        }
        connection.valid = false;
    }, 1 * 60 * 1000);
}

async function trackGlider(task: AprsCommandTrack) {
    console.log('*** trackGlider ***', task.compno, task.trackerId);
    const aircraft: Aircraft = {
        compno: task.compno,
        className: task.className,
        trackers: task.trackerId as FlarmID[],

        // Not had a message
        stationary: 0,
        ground: true,
        lastTick: getNow(),
        receiveNewPoints: task.receiveNewPoints,

        // Setup logging
        log:
            task.compno == (process.env.NEXT_PUBLIC_COMPNO || '')
                ? function log() {
                      console.log(task.compno, ...arguments);
                  }
                : function log() {},

        messages: []
    };

    // Link the glider in
    aircraft[task.className + '/' + task.compno] = aircraft;

    // Make sure we have the latest datecode for the database
    if (task.datecode > datecode || !db) {
        db = await initDB(task.datecode);
        datecode = task.datecode;
    }

    const interimQueue = [];

    // Link the tracker(s) in
    const trackerList = typeof task.trackerId == 'string' ? [task.trackerId] : task.trackerId;
    let index = 0;
    for (const id of [...new Set(trackerList)]) {
        console.log('load tracker', aircraft.compno, id);
        if (trackers[id]) {
            trackers[id].aircraftList.push(aircraft);
            trackers[id].receiveNewPoints = trackers[id].receiveNewPoints || task.receiveNewPoints;
        } else {
            trackers[id] = {
                id: id as FlarmID,
                index: index++,
                aircraftList: [aircraft],
                receiveNewPoints: task.receiveNewPoints,
                db: db?.sublevel(id, {})
            };
        }
        await loadPointsForTracker(aircraft, trackers[id], interimQueue);
    }

    // And make sure we have a channel for it
    if (!channels[task.channelName]) {
        channels[task.channelName] = new BroadcastChannel(task.channelName);
    }

    // And link the broadcast channel to it
    aircraft[task.className + '/' + task.compno].channel = channels[task.channelName];
    aircraft.messages = interimQueue;
    setTimeout(() => {
        console.log(`APRS: tracking ${task.className}/${task.compno} with ${task.trackerId} on channel ${task.channelName}`);
        aircraft.interval = setInterval(() => processMessageQueue(aircraft), 1000);
    }, Math.random() * 1000);
}

function finishGlider(task: AprsCommandFinish) {
    console.log(`APRS: stopping point reception ${task.className}/${task.compno}`);

    // What are we removing
    const toFinish = aircraft[makeClassname_Compno(task)];
    if (!toFinish) {
        return;
    }

    toFinish.receiveNewPoints = false;

    toFinish.trackers.forEach((t) => {
        const tracker = trackers[t];
        // If all are marked as done receving then we can stop it
        const exclusive = tracker.aircraftList.every((a) => a.receiveNewPoints);
        if (exclusive) {
            tracker.receiveNewPoints = false;
        }
    });
}

function untrackGlider(task: AprsCommandUntrack) {
    // What are we removing
    const toRemove = aircraft[makeClassname_Compno(task)];
    if (!toRemove) {
        return;
    }

    // remove the trackers
    toRemove.trackers.forEach((t) => {
        const tracker = trackers[t];
        tracker.aircraftList = tracker.aircraftList.filter((a) => a.channel != toRemove.channel || a.compno != toRemove.compno);
        if (!tracker.aircraftList.length) {
            tracker.db?.close();
            delete trackers[t];
        }
    });

    clearInterval(toRemove.interval);

    // Remove the glider details
    delete aircraft[makeClassname_Compno(task)];
    console.log(`APRS: stop tracking ${task.className}/${task.compno} ids: ${toRemove.trackers}`);
}

function sortKey(sender: string, tracker: Tracker | undefined): number {
    const rid = (receivers[sender] ??= highestReceiverId++);
    return (tracker?.index ?? 0) << (16 + (rid & 0xffff));
}

function messageSortKey(m: InterimPositionMessage): number {
    return m.t; //sortKey(m.o, trackers[m.f]);
}

//
// collect points, emit to competition db every 30 seconds
async function processPacket(packet: aprsPacket) {
    // Flarm ID we use is last 6 characters, check if OGN tracker or regular flarm
    const flarmId = packet.sourceCallsign?.slice(packet.sourceCallsign?.length - 6) as FlarmID;
    const ognTracker = packet.sourceCallsign?.slice(0, 3) == 'OGN';

    if (!packet.latitude || !packet.longitude || !flarmId || !packet.timestamp || !packet.altitude) {
        statistics.invalidPacket++;
        return;
    }

    // Get the ACTUAL delay (note this doesn't work for replay)
    const now = new Date().getTime() / 1000;
    const td = Math.floor(now - packet.timestamp);

    // Lookup the altitude adjustment for the
    let sender = packet.digipeaters?.pop()?.callsign || 'unknown';
    if (sender == 'DLY2APRS') {
        sender = packet.digipeaters?.[0]?.callsign || 'unknown';
        statistics.aprsDelayForDelayed += td;
        statistics.delayedPackets++;
    } else {
        statistics.aprsDelay += td;
        statistics.normalPackets++;
    }

    let aoa = 0; // ognTracker ? 0 : altitudeOffsetAdjust[sender] || 0;
    //    if (aoa == null) {
    //        console.log(`ignoring packet from ${sender} as blocked`);
    //        return;
    //    }

    // Apply the correction
    let altitude = Math.floor(packet.altitude + aoa);

    // geojson for helper function slater
    const jPoint = point([packet.latitude, packet.longitude]);

    statistics.msgsReceived++;

    // Look it up, have we had packets for this before?
    const tracker =
        trackers[flarmId] ??
        (trackers[flarmId] = {
            id: flarmId,
            index: -1,
            aircraftList: [],
            receiveNewPoints: true,
            db: db ? db.sublevel(flarmId, {}) : undefined
        });
    const aircraftList = tracker?.aircraftList;
    const airfieldDistance = distance(jPoint, airfieldLocation);
    const agl = await getElevationOffset(packet.latitude, packet.longitude).then((e) => Math.round(Math.max(altitude - e, 0)));

    if (altitude > 7500) {
        return;
    }

    if (!tracker.receiveNewPoints) {
        statistics.finishPoints++;
    }

    const message: InterimPositionMessage = {
        c: flarmId as FlarmID,
        lat: Math.round(packet!.latitude * 1000000) / 1000000,
        lng: Math.round(packet!.longitude * 1000000) / 1000000,
        a: altitude,
        g: agl,
        t: packet.timestamp as Epoch,
        b: packet.course as Bearing,
        s: (Math.round((packet.speed ?? 0) * 10) / 10) as Speed,
        f: flarmId,
        o: sender,
        l: null
    };

    if (tracker.db) {
        tracker.db.put([message.t, sender].join('/'), JSON.stringify(message));
    }

    // If it is undefined then we will enrich and send to the
    // airfield channel if it's close enough
    if (!aircraftList) {
        if (airfieldDistance < 20 && packet.altitude < airfieldElevation + 750) {
            unknownChannel.postMessage(message);
        }
        return;
    }

    statistics.knownReceived++;

    message.j = jPoint;

    // Figure out where to insert (sorted by time)
    for (let aircraft of aircraftList) {
        message.c = aircraft.compno as Compno;
        const messageQueue = aircraft.messages;
        if ((messageQueue.at(-1)?.t ?? 0) > message.t) {
            statistics.outOfOrder++;
            const insertIndex = _sortedLastIndexBy(messageQueue, message, messageSortKey);
            if (insertIndex != messageQueue.length) {
            }
            if (insertIndex > 0 && messageQueue[insertIndex - 1].t == message.t) {
                statistics.duplicates++;
            }
            messageQueue.splice(insertIndex, 0, message);
        } else {
            messageQueue.push(message);
        }
    }
}

//
// Read the database for all points for a specific aircraft tracker
//
async function loadPointsForTracker(aircraft: Aircraft, tracker: Tracker, messageQueue: InterimPositionMessage[]) {
    if (!tracker.db) {
        console.log('no database available for loading trackpoints');
        return;
    }
    try {
        let loaded = 0;
        for await (const [key, messageJson] of tracker.db.iterator()) {
            const message = JSON.parse(messageJson);
            message.c = aircraft.compno; // correct competition number as it may be wrong in the db
            const insertIndex = _sortedLastIndexBy(messageQueue, message, messageSortKey);
            message.j = point([message.lat, message.lng]);
            messageQueue.splice(insertIndex, 0, message);
            loaded++;
        }
        console.log(`${aircraft.className}/${tracker.id}/${aircraft.compno}: ${loaded}/${messageQueue.length} points loaded`);
    } catch (err) {
        console.error(`${aircraft.className}/${aircraft.compno}/${tracker.id}: ${err}...`);
    }
}

async function restartMessageQueue(aircraft: Aircraft) {
    processMessageQueue(aircraft, 0 as Epoch, getNow());
}

//
// This iterates through the queue on a regular basis and deals with each point
// it also ensures time order and is where you can perform filtering for positioning
// jumps or to prefer specific receivers.
//
// Note that we do not consume the message queue - it is used for scoring restarts etc
// so all messages are kept.
async function processMessageQueue(aircraft: Aircraft, from: Epoch | undefined = undefined, to: Epoch = getNow()) {
    //
    let lastSent = aircraft.lastSent;
    let messages = aircraft.messages;
    const start = from ?? ((aircraft.lastTime ? aircraft.lastTime + 1 : 0) as Epoch);
    const realNow = getNow();
    let position = _sortedLastIndexBy(messages, {t: start} as any, messageSortKey);

    /*    if (position < messages.length) {
        console.log(
            `processMessageQueue ${aircraft.compno}: t: ${lastSent?.t} < [${start}-${to}...rn:${realNow}], p: ${position} < ${messages.length}, m: ${messages.at(position)?.t ?? 'no message'}, lm: ${messages.at(-1)?.t}`
        );
        } */

    // If we have been asked to resent all points then we shall do so
    if (start === 0 && aircraft.lastTime !== 0) {
        console.log(`processMessageQueue: resending all points for ${aircraft.compno}`);
        aircraft.channel!.postMessage({c: aircraft.compno, t: 1, _: false, tick: true} as any);
        aircraft.lastTime = 0;
        aircraft.lastTick = 0 as Epoch;
    }

    let count = 0;
    while (position < messages.length && messages[position].t < to) {
        const t = messages[position].t;
        aircraft.lastTime = t;
        count++;

        // Get all the messages that are for the same time (we may have several for each time)
        let duplicatePosition = position + 1;
        while (duplicatePosition < messages.length && messages[duplicatePosition].t == t) duplicatePosition++;

        // Get list and then advance past it
        const duplicates = messages.slice(position, duplicatePosition);
        position = duplicatePosition;

        if (!duplicates.length) {
            console.log('no duplicates for ', position, duplicatePosition);
        }

        // If we have many we need to reduce this to one
        // we take smallest difference in position, or if the same the smallest vertical difference from
        // previously selected point. If point is the same then don't prefer it.
        const sorted = lastSent
            ? duplicates
                  .map((point) => {
                      const dH = distance(point.j!, lastSent!.j!);
                      const dV = point.a - lastSent!.a;
                      const dT = point.t - lastSent!.t;
                      return {
                          ...point,
                          dH: dH * 1000,
                          dV,
                          dT,
                          dSH: (3600 * dH) / dT, //km/s
                          dSV: Math.abs(dV / dT) // m/s
                      };
                  })
                  // Quickly remove faster than 300kph Horizontal or 30m/s Vertical
                  // as they can't possible be correct
                  .filter((point) => point.dSH < (point.s || 160) * 2 && point.dSV < 30)
                  // Then sort them by amount of change
                  .sort((a, b) => (a.dH - a.dH > 1 ? a.dH - b.dH : a.dV != b.dV ? a.dV - b.dV : a.o == lastSent!.o ? -1 : 0))
            : duplicates;

        // If it hasn't changed then we will ignore it - this should prevent us getting stuck on the previous
        // one
        const filtered = lastSent ? sorted.filter((a) => a.lat != lastSent!.lat || a.lng != lastSent!.lng || a.a != lastSent!.a) : sorted;

        // We haven't picked one because we have had no movement but we have had packets
        const stationary = lastSent && !filtered.length && sorted.length && realNow - lastSent.t > 30;

        // Take the first one, if we don't
        const point = filtered.at(0) ?? (stationary ? sorted[0] : undefined);

        //        if (duplicates.length > 1) {
        //            console.log(t, t - realNow, aircraft.compno, stationary ? 'stationary' : '', 'multiple packets', duplicates.length, duplicates.map((m: InterimPositionMessage) => m.o).join(','), 'picked', point?.o);
        //        }

        //            if (duplicates.length || a) {
        if (aircraft.compno == '!95') {
            // duplicates.length > 1 && lastSent) {
            console.log(aircraft.compno, 'no point found ===========');
            console.table([lastSent]);
            console.table(
                lastSent
                    ? duplicates.map((point) => {
                          const dH = lastSent ? distance(point.j!, lastSent!.j!) : 0;
                          const dV = point.a - lastSent!.a;
                          const dT = point.t - lastSent!.t;
                          return {
                              ...point,
                              dH: Math.round(1000 * dH),
                              dV,
                              dT,
                              dSH: Math.round((3600 * dH) / dT), //km/s
                              dSV: Math.round(10 * Math.abs(dV / dT)) / 10 // m/s
                          };
                      })
                    : duplicates
            );
            console.log('----sorted-----');
            console.table(sorted.map((f) => [f.o, f.lat, f.lng, f.a]));
            console.log('----filtered-----');
            console.table(filtered.map((f) => [f.o, f.lat, f.lng, f.a]));
        }
        if (!point) {
            continue;
        }

        if (stationary) {
            aircraft.stationary++;

            // If we had been stationary for a while and we are low enough to be on the ground
            // then mark it as so
            if (aircraft.stationary > 5 && point.g < 100) {
                console.log(`${point.c}: on ground @ ${point.t}`);
                aircraft.ground = true;
            }
        }

        // If we have 'taken' off
        if (aircraft.ground && point.g > 110) {
            console.log(`${point.c}: left ground @ ${point.t}`);
            aircraft.ground = false;
        }

        // If we are on the ground and we are more than 3 km from airfield location then we don't
        // want to report it. This doesn't filter initial points as you are not marked as on the ground
        // till several stationary points have happened
        if (aircraft.ground) {
            continue;
        }

        // If we are stationary we don't need to report the points
        if (!stationary) {
            aircraft.stationary = 0;
            aircraft.lastMoved = point.t;
        }

        // Check for very late and log it
        aircraft.lastSent = lastSent = point;

        // Send message, if we are sending ALL then by definition this will be 'late' so indicate that
        // all it does is stop it sending to the front end
        if (aircraft.compno == 'RP') {
            console.log('RP =>', point.c, point.t);
        }

        const live = start != 0 || position == messages.length;
        aircraft.channel!.postMessage({...point, aircraft: undefined, j: undefined, _: live});
    }
    if (!aircraft.lastTick || realNow - aircraft.lastTick > 60) {
        aircraft.channel!.postMessage({
            c: aircraft.compno, //
            t: (messages.length ? messages[Math.min(position, messages.length - 1)]?.t : undefined) || (2 as Epoch),
            _: true,
            tick: true
        } as any);
        aircraft.lastTick = (realNow - (!aircraft.lastTick ? Math.random() * 60 : 0)) as Epoch;

        if (!aircraft.lastTick) {
            console.log(`${aircraft.compno}: tick at end of loop ${realNow}, pos: ${position}/${messages.length} f:${from} s:${start} t:${to}`);
        }
    }

    if (count > 1) {
        console.log(`${aircraft.compno}: processed ${count}, pos: ${position}/${messages.length} @ ${messages[position]?.t}, f:${from} s:${start} t:${to}`);
    }
}
