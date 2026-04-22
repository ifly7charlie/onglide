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

import {getNow, d} from '../now';

import {PositionMessage} from '../types';
interface InterimPositionMessage extends PositionMessage {
    //    aircraft: Aircraft;
    j?: Coord;
    f: FlarmID; // id
    o: string; // sender
    ad: number; // airfield distance
}

import {Epoch, ClassName_Compno, ClassName, AltitudeAgl, makeClassname_Compno, Compno, FlarmID, ChannelName, Bearing, Speed, Datecode} from '../types';

// APRS connection
let connection: ISSocket & {valid: boolean; aprsc: string};
const possibleServers = ['glidern1.glidernet.org', 'glidern2.glidernet.org', 'glidern3.glidernet.org', 'glidern5.glidernet.org'];

// Pending filter string, set if setFilter is called before we're connected
// and logged in. Drained in the connect handler after sendLogin().
let pendingFilter: string | null = null;

// Last successfully applied filter — re-sent after reconnects so we don't
// fall back to the login-time r/0/0/1 placeholder.
let currentFilter: string | null = null;

// True from the moment the connect handler has fired and sendLogin() has
// been called. This gates #filter — aprsc only accepts in-band filter
// updates after login. Note: connection.valid is set in the packet
// handler on first received line, so we can't use it here — with a
// minimal initial filter (r/0/0/1) no packets arrive until the filter
// is updated, so valid stays false and applyFilter would loop deferring
// itself forever.
let loggedIn = false;

// Guard against concurrent restarts. The error handler and kaInterval
// can both trip the "too unstable" threshold in the same tick; without
// this guard they'd each spin up a fresh listener (with its own
// interval/socket), leaking the previous one's kaInterval since each
// closure clears only the interval it captured.
let restarting = false;

import {BroadcastChannel, Worker, parentPort, isMainThread, workerData, SHARE_ENV} from 'node:worker_threads';

import {trackMetric, initialiseInsights} from '../insights';
//import {pathToFileURL} from 'node:url';

import {sortedLastIndexBy as _sortedLastIndexBy, sortedIndexBy as _sortedIndexBy} from 'lodash';

export enum AprsCommandEnum {
    none,
    shutdown,
    track,
    finish,
    untrack,
    setFilter,
    setAirfields
}

export type AprsCommand = AprsCommandShutdown | AprsCommandTrack | AprsCommandUntrack | AprsCommandFinish | AprsCommandSetFilter | AprsCommandSetAirfields;

// Request a glider to be tracked
export interface AprsCommandTrack {
    action: AprsCommandEnum.track;

    className: ClassName;
    channelName: string;
    compno: string | Compno;
    datecode: Datecode;
    tzoffset: number; // seconds east of UTC — used to derive competition start time for point backfill
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

export interface AprsCommandSetFilter {
    action: AprsCommandEnum.setFilter;
    filter: string;
}

export interface AirfieldSpec {
    compid: string;
    lt: number;
    lg: number;
}

export interface AprsCommandSetAirfields {
    action: AprsCommandEnum.setAirfields;
    airfields: AirfieldSpec[];
}

export interface AprsListenerConfig {
    airfields: AirfieldSpec[];
}

// Keep track of some basic statistics
const statistics = {
    msgsReceived: 0,
    knownReceived: 0,
    unknownReceived: 0,
    aprsDelay: 0,
    normalPackets: 0,
    aprsDelayForDelayed: 0,
    aprsMaxDelayForDelayed: 0,
    aprsMinDelayForDelayed: Infinity,
    delayedPackets: 0,
    periodStart: 0,
    outOfOrder: 0,
    duplicates: 0,
    invalidPacket: 0,
    encryptedPacket: 0,
    jumps: 0,
    finishPoints: 0,
    server: '-not connected-'
};

// Keep track of the aircraft requested
export interface Aircraft {
    compno: string;
    className: string;
    trackers: FlarmID[];

    datecode: Datecode; // competition day this aircraft belongs to (internal signal for reset-on-change)
    tzoffset: number; // competition timezone offset; drives backfill start time

    receiveNewPoints: boolean;

    lastTime?: number;
    lastSent?: InterimPositionMessage;
    lastMoved?: number;
    lastTick: Epoch;

    //    kf?: any; // altitude smoothing
    stationary: number; // consecutive stationary fixes
    ground: boolean;

    channel?: BroadcastChannel; // where to send packets

    messages: InterimPositionMessage[]; // sorted array of all packets received for the glider

    // Logging for aircraft
    log: (...x) => void;

    // Interval handler
    interval?: NodeJS.Timeout;
}

export interface Tracker {
    id: FlarmID;
    index: number;
    aircraftList: Aircraft[];
    receiveNewPoints: boolean;
}

// All active airfields with their elevation. Populated from the initial
// config and updated at runtime via AprsCommandEnum.setAirfields.
interface Airfield {
    compid: string;
    point: Coord;
    elevation: AltitudeAgl;
}
const airfields: Airfield[] = [];

// Per-comp channels for unknown gliders that land near that comp's airfield.
// Lazily created on first dispatch; closed when the airfield goes away.
const unknownChannels: Record<string, BroadcastChannel> = {};

function nearestAirfield(jPoint: Coord): {field: Airfield; distance: number} | null {
    let best: Airfield | null = null;
    let bestD = Infinity;
    for (const a of airfields) {
        const d = distance(jPoint, a.point);
        if (d < bestD) {
            bestD = d;
            best = a;
        }
    }
    return best ? {field: best, distance: bestD} : null;
}

function getUnknownChannel(compid: string): BroadcastChannel {
    return (unknownChannels[compid] ??= new BroadcastChannel('Unknown_' + compid));
}

function setAirfields(specs: AirfieldSpec[]) {
    const keep = new Set(specs.map((s) => s.compid));

    // Drop airfields that are no longer configured, closing their unknown channel
    for (let i = airfields.length - 1; i >= 0; i--) {
        if (!keep.has(airfields[i].compid)) {
            const compid = airfields[i].compid;
            airfields.splice(i, 1);
            unknownChannels[compid]?.close();
            delete unknownChannels[compid];
        }
    }

    // Add or update each spec
    for (const s of specs) {
        const existing = airfields.find((a) => a.compid === s.compid);
        const p = point([s.lt, s.lg]);
        if (existing) {
            existing.point = p;
        } else {
            const a: Airfield = {compid: s.compid, point: p, elevation: 0 as AltitudeAgl};
            airfields.push(a);
            getElevationOffset(s.lt, s.lg, (e: any) => (a.elevation = e));
        }
    }
    console.log(`aprs airfields: ${airfields.map((a) => a.compid).join(',') || 'none'}`);
}

// Mapping by class/compno to aircraft record
const allAircraft: Record<ClassName_Compno, Aircraft> = {};

// Mapping by trackerid to aircraft record
const trackers: Record<FlarmID, Tracker> = {};

// ID for each receiver
let highestReceiverId: number = 0;
const receivers: Record<string, number> = {};

// And for sending message onwards - all we do here is fetch and enrich
const channels: Record<ChannelName, BroadcastChannel> = {};

// Our persistence
import {appendPoint, closeLog, loadPoints, openLog} from './pointlog';
import {competitionStartTs} from '../datecode';
import {inorderAdditionalDelay} from '../constants';

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

    validateGlider(trackerIds: string): boolean {
        if (!trackerIds || trackerIds == 'unknown') {
            return false;
        }
        const flarmIDs = trackerIds
            .split(/[:,]/)
            .map((i) => i.toUpperCase())
            .filter((i) => i.match(/[0-9A-Fa-f]{6}$/)) as string[];
        return flarmIDs && flarmIDs.length > 0;
    }

    trackGlider(compno: Compno, className: ClassName, datecode: Datecode, tzoffset: number, channelName: ChannelName, trackerIds: string, receiveNewPoints: boolean): boolean {
        const flarmIDs = trackerIds
            .split(/[:,]/)
            .map((i) => i.toUpperCase())
            .filter((i) => i.match(/[0-9A-Fa-f]{6}$/)) as string[];

        // Tell APRS to start listening for the flarmid
        console.log(`Starting APRS Listener for glider ${className}:${compno} => ${flarmIDs.join(',')} [${channelName}] receive:${receiveNewPoints}`);
        const command: AprsCommandTrack = {
            action: AprsCommandEnum.track,
            compno: compno, //
            className: className,
            channelName,
            datecode,
            tzoffset,
            receiveNewPoints,
            trackerId: flarmIDs
        };
        this.worker.postMessage?.(command);
        return true;
    }

    untrackGlider(compno: Compno, className: ClassName, channelName: string, trackerIds: string) {
        const flarmIDs = trackerIds
            .split(/[:,]/)
            .map((i) => i.toUpperCase())
            .filter((i) => i.match(/[0-9A-Fa-f]{6}$/)) as string[];

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
    setFilter(filter: string) {
        const command: AprsCommandSetFilter = {
            action: AprsCommandEnum.setFilter,
            filter
        };
        this.worker.postMessage?.(command);
    }
    setAirfields(airfields: AirfieldSpec[]) {
        const command: AprsCommandSetAirfields = {
            action: AprsCommandEnum.setAirfields,
            airfields
        };
        this.worker.postMessage?.(command);
    }
    // Send the shutdown command to the worker and return a promise that
    // resolves when the worker process has actually exited, or after a
    // 5-second timeout (so teardown doesn't hang if the worker is stuck).
    shutdown(): Promise<void> {
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };
            this.worker.once('exit', finish);
            const command: AprsCommandShutdown = {
                action: AprsCommandEnum.shutdown
            };
            this.worker.postMessage?.(command);
            setTimeout(finish, 5000);
        });
    }
}

if (!isMainThread && parentPort) {
    console.log('Started APRS worker thread');

    //    initialiseInsights();

    // The parent can post a few different messages to us

    //
    // action: shutdown
    // action: track
    parentPort.on('message', async (task: AprsCommand) => {
        // If we have been asked to exit then do so
        if (task.action == AprsCommandEnum.shutdown) {
            console.log('closing worker');
            await closeLog();
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
            case AprsCommandEnum.setFilter:
                applyFilter(task.filter);
                break;
            case AprsCommandEnum.setAirfields:
                setAirfields(task.airfields);
                break;
        }
    });

    openLog().then(() => startAprsListener(<AprsListenerConfig>workerData));
}


//
// Apply a new aprsc filter string in-band. aprsc supports `#filter <string>`
// on an authenticated connection with no reconnect required.
//
// If we're not yet connected (or the connection hasn't been authenticated
// and marked valid), we stash the filter and the connect handler will
// re-emit it once sendLogin() completes.
//
function applyFilter(filter: string) {
    if (filter.length > 900) {
        console.log(`aprs filter length warning: ${filter.length} bytes (aprsc practical cap ~1KB)`);
    }
    currentFilter = filter;
    if (loggedIn && connection) {
        connection.send(`#filter ${filter}\r\n`);
        console.log(`aprs filter updated: ${filter.length} bytes: ${filter}`);
    } else {
        pendingFilter = filter;
        console.log(`aprs filter deferred until login: ${filter}`);
    }
}

//
// Connect to the APRS Server
function startAprsListener(config: AprsListenerConfig) {
    if (process.env.REPLAY_DB || process.env.NEXT_PUBLIC_REPLAY) {
        return;
    }

    // Clear the restart guard so this fresh listener can itself trigger
    // a restart later if it becomes unstable.
    restarting = false;

    // Settings for connecting to the APRS server
    const PASSCODE = -1;
    const APRSSERVER = (statistics.server = process.env.APRS_SERVER || possibleServers[Math.trunc(possibleServers.length * Math.random())]);
    const PORTNUMBER = 14580;

    // Seed the airfield list. The main thread follows up with setAirfields
    // whenever the set of active competitions changes.
    setAirfields(config.airfields);

    // Initial FILTER: minimise bandwidth until the main thread pushes the
    // real filter after updateTasks. aprsc requires a filter in the login
    // for -1 passcode clients, so we can't omit it — use a 1km radius
    // around (0,0) which matches effectively nothing and lets the worker
    // sit idle until #filter comes in. Once the main thread knows which
    // comps are active it calls setFilter() with the union of task
    // bboxes + 10km margin + 30km airfield fallback.
    const FILTER = 'r/0/0/1';

    let unstableCount = 0;

    // Connect to the APRS server
    connection = new ISSocket(`onglide/${version}`, APRSSERVER, PORTNUMBER, 'OG', -1, true, 'id', FILTER) as any;
    let parser = new aprsParser();

    // Handle a connect
    connection.on('connect', () => {
        // sendLogin can throw "Socket not connected" if the socket was
        // disconnected between net's afterConnect and this handler firing
        // (e.g. an error handler already called disconnect()). Letting it
        // throw crashes the worker via EventEmitter's uncaught path, so
        // swallow it and let the normal retry loop reconnect.
        try {
            connection.sendLogin();
            connection.send(`# onglide airfields=${airfields.map((a) => a.compid).join(',') || 'none'}`);
        } catch (e) {
            console.log(`aprs sendLogin failed on ${APRSSERVER}, will retry: ${e}`);
            return;
        }
        loggedIn = true;
        console.log(`aprs connected and logged in to ${APRSSERVER}`);
        // Re-apply the active filter: either a pending one (set while
        // disconnected) or the last applied filter (on reconnect).
        const filterToApply = pendingFilter ?? currentFilter;
        pendingFilter = null;
        if (filterToApply) {
            applyFilter(filterToApply);
        }
    });

    // Handle a data packet
    connection.on('packet', (data: string) => {
        connection.valid = true;
        if (data.charAt(0) != '#' && !data.startsWith('user')) {
            const packet = parser.parseaprs(data);
            if (packet && 'latitude' in packet && 'longitude' in packet && 'comment' in packet && packet.comment?.startsWith('id')) {
                processPacket(packet).catch((e) => console.error(e));
            } else {
                const ognTracker = packet?.destCallsign || 'unknown';
                const sender = packet?.digipeaters?.pop()?.callsign || 'unknown';
                if (ognTracker == 'OGNTRK' && sender != 'DLY2APRS') {
                    statistics.encryptedPacket++;
                } else {
                    //                    console.log(ognTracker, sender, packet?.digipeaters, packet);
                    statistics.invalidPacket++;
                }
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
        if (restarting) {
            return;
        }
        connection.disconnect();
        statistics.server += '!';
        unstableCount += 2;
        if (unstableCount > 5) {
            console.log(`${APRSSERVER} too unstable, restarting APRS listener with different server`);
            restarting = true;
            clearInterval(kaInterval);
            startAprsListener(config);
            return;
        }
        setTimeout(() => connection.connect(), unstableCount * 2000);
    });

    // Start the APRS connection
    connection.connect();

    // And every minute we need to confirm the APRS
    // connection has had some traffic
    const kaInterval = setInterval(
        function () {
            // Log and reset statistics
            const period = (Date.now() - statistics.periodStart) / 1000;

            // Into insights
            if (statistics.periodStart) {
                console.log(
                    `APRS: ${statistics.knownReceived} known/${statistics.msgsReceived} msgs (${statistics.unknownReceived} unknown), ${(statistics.msgsReceived / period).toFixed(1)} msg/s,  ooo ${statistics.outOfOrder}, dup: ${
                        statistics.duplicates
                    }, invalid: ${statistics.invalidPacket}, encrypted: ${statistics.encryptedPacket} finished: ${statistics.finishPoints}, aprs server unstableCount: ${unstableCount}`
                );
                console.log(`APRS: ${statistics.normalPackets} NORMAL average delay: ${(statistics.aprsDelay / statistics.normalPackets).toFixed(1)}s`);
                if (statistics.delayedPackets) {
                    console.log(
                        `APRS: ${statistics.delayedPackets} DELAYED average delay: ${(statistics.aprsDelayForDelayed / statistics.delayedPackets).toFixed(1)}, range ${statistics.aprsMinDelayForDelayed} - ${
                            statistics.aprsMaxDelayForDelayed
                        }, ${((100 * statistics.delayedPackets) / statistics.msgsReceived).toFixed(0)}% packets delayed`
                    );
                }
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
                statistics.normalPackets =
                statistics.knownReceived =
                statistics.unknownReceived =
                statistics.invalidPacket =
                statistics.encryptedPacket =
                statistics.finishPoints =
                statistics.outOfOrder =
                statistics.duplicates =
                statistics.jumps =
                    0;

            statistics.aprsMaxDelayForDelayed = 0;
            statistics.aprsMinDelayForDelayed = Infinity;

            statistics.periodStart = Date.now();
            if (unstableCount > 0) {
                unstableCount--;
            }
            trackMetric('aprs.unstableCount', unstableCount);

            // send a keepalive

            try {
                // Send APRS keep alive or we will get dumped
                connection.send(`# onglide airfields=${airfields.map((a) => a.compid).join(',') || 'none'}`);
            } catch (x) {
                console.log('unable to send keepalive', x);
                connection.valid = false;
            }

            // Re-establish the APRS connection if we haven't had anything in
            if (!connection.valid && !restarting) {
                console.log(`failed APRS connection to ${APRSSERVER}, retrying usc:${unstableCount} `);
                connection.disconnect(() => {
                    if (restarting) {
                        return;
                    }
                    unstableCount += 2;
                    if (unstableCount > 5) {
                        console.log(`${APRSSERVER} too unstable, restarting APRS listener with different server`);
                        restarting = true;
                        clearInterval(kaInterval);
                        startAprsListener(config);
                        trackMetric('aprs.restart', 1);
                        return;
                    }
                    connection.connect();
                });
            }
            connection.valid = false;
        },
        1 * 60 * 1000
    );
}

async function trackGlider(task: AprsCommandTrack) {
    console.log('*** trackGlider ***', task.compno, task.trackerId);

    // Check if already tracking...
    const existingTracker = allAircraft[makeClassname_Compno(task)];
    if (existingTracker) {
        console.log(`${task.compno}: closing existing tracker entry ${existingTracker.trackers.join(',')}`);
        // remove the trackers
        existingTracker.trackers.forEach((t) => {
            const tracker = trackers[t];
            tracker.aircraftList = tracker.aircraftList.filter((a) => a.channel != existingTracker.channel || a.compno != existingTracker.compno);
            if (!tracker.aircraftList.length) {
                delete trackers[t];
            }
        });
        clearInterval(existingTracker.interval);
    }

    const glider: Aircraft = {
        compno: task.compno,
        className: task.className,
        trackers: task.trackerId as FlarmID[],

        datecode: task.datecode,
        tzoffset: task.tzoffset,

        // Not had a message
        stationary: 0,
        ground: false,
        lastTick: (getNow() - inorderAdditionalDelay) as Epoch,
        receiveNewPoints: task.receiveNewPoints,

        // Setup logging
        log:
            task.compno == (process.env.NEXT_PUBLIC_COMPNO || 'I')
                ? function log() {
                      console.log(task.compno, ...arguments);
                  }
                : function log() {},

        messages: []
    };

    // Link the glider in
    allAircraft[makeClassname_Compno(task)] = glider;

    const interimQueue: InterimPositionMessage[] = [];
    const since = competitionStartTs(task.tzoffset);

    // Link the tracker(s) in
    const trackerList = typeof task.trackerId == 'string' ? [task.trackerId] : task.trackerId;
    let index = 0;
    for (const id of [...new Set(trackerList)]) {
        console.log('load tracker', glider.compno, id);
        if (trackers[id]) {
            trackers[id].aircraftList.push(glider);
            trackers[id].receiveNewPoints = trackers[id].receiveNewPoints || task.receiveNewPoints;
        } else {
            trackers[id] = {
                id: id as FlarmID,
                index: index++,
                aircraftList: [glider],
                receiveNewPoints: task.receiveNewPoints
            };
        }
        await loadPointsForGlider(glider, id as FlarmID, since, interimQueue);
    }

    // And make sure we have a channel for it
    if (!channels[task.channelName]) {
        channels[task.channelName] = new BroadcastChannel(task.channelName);
    }

    // And link the broadcast channel to it
    glider.channel = channels[task.channelName];
    glider.messages = interimQueue;
    setTimeout(() => {
        console.log(`APRS: tracking ${task.className}/${task.compno} with ${task.trackerId} on channel ${task.channelName}`);
        glider.channel!.postMessage({c: glider.compno, t: 0, _: false, tick: true} as any);
        glider.interval = setInterval(() => processMessageQueue(glider), 1000);
    }, Math.random() * 1000);
}

function finishGlider(task: AprsCommandFinish) {
    console.log(`APRS: stopping point reception ${task.className}/${task.compno}`);

    // What are we removing
    const toFinish = allAircraft[makeClassname_Compno(task)];
    if (!toFinish) {
        console.log(`APRS: finishGlider can't find ${task.className}/${task.compno} in ${Object.keys(allAircraft).join(',')}`);
        return;
    }

    toFinish.receiveNewPoints = false;

    toFinish.trackers.forEach((t) => {
        const tracker = trackers[t];
        // If all are marked as done receving then we can stop it
        const exclusive = tracker.aircraftList.every((a) => a.receiveNewPoints);
        if (exclusive) {
            console.log(`APRS: finish ${task.className}/${task.compno} stop new points for ${tracker.id}`);
            tracker.receiveNewPoints = false;
        }
    });
}

function untrackGlider(task: AprsCommandUntrack) {
    // What are we removing
    const toRemove = allAircraft[makeClassname_Compno(task)];
    if (!toRemove) {
        console.log(`APRS: untrackGlider can't find ${task.className}/${task.compno} in ${Object.keys(allAircraft).join(',')}`);
        return;
    }

    // remove the trackers
    toRemove.trackers.forEach((t) => {
        const tracker = trackers[t];
        tracker.aircraftList = tracker.aircraftList.filter((a) => a.channel != toRemove.channel || a.compno != toRemove.compno);
        if (!tracker.aircraftList.length) {
            delete trackers[t];
        }
    });

    clearInterval(toRemove.interval);

    // Remove the glider details
    delete allAircraft[makeClassname_Compno(task)];
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
export async function processPacket(packet: aprsPacket) {
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
        statistics.aprsMaxDelayForDelayed = Math.max(statistics.aprsMaxDelayForDelayed, td);
        statistics.aprsMinDelayForDelayed = Math.min(statistics.aprsMinDelayForDelayed, td);
        statistics.delayedPackets++;
    } else {
        // Ignore ones that are too old and that are not explicitly delayed
        // I believe these are corrupted
        if (td > 20 * 60) {
            statistics.delayedPackets++;
            return;
        }
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
            receiveNewPoints: true
        });
    const aircraftList = tracker?.aircraftList;
    const nearest = nearestAirfield(jPoint);
    const airfieldDistance = nearest?.distance ?? Infinity;
    const agl = await getElevationOffset(packet.latitude, packet.longitude).then((e) => Math.round(Math.max(altitude - e, 0)));

    if (altitude > 7500) {
        return;
    }

    if (!tracker.receiveNewPoints) {
        statistics.finishPoints++;
    }

    const message: InterimPositionMessage & {d: number} = {
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
        l: null,
        d: td,
        ad: airfieldDistance
    };

    // Persist every packet, known or unknown. Downstream trackers for any
    // competition can later backfill from the log regardless of whether
    // someone was tracking this flarmid at the time it arrived.
    appendPoint(message);

    // If it is undefined then we will enrich and send to the
    // airfield channel if it's close enough. Dispatch goes to the
    // Unknown_<compid> channel of the nearest airfield.
    if (!aircraftList.length) {
        if (nearest && airfieldDistance < 20 && packet.altitude < nearest.field.elevation + 750) {
            statistics.unknownReceived++;
            getUnknownChannel(nearest.field.compid).postMessage(message);
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
// Backfill an aircraft's in-memory message queue from the point log, for a
// single tracker flarmid, starting at the competition day anchor (10am local).
//
async function loadPointsForGlider(aircraft: Aircraft, flarmId: FlarmID, since: number, messageQueue: InterimPositionMessage[]) {
    try {
        let loaded = 0;
        for await (const raw of loadPoints({flarmId, since})) {
            const message = raw as InterimPositionMessage & {d?: number};
            loaded++;
            if (typeof message.d === 'number' && message.d > 1200) continue;
            message.c = aircraft.compno as Compno;
            const insertIndex = _sortedLastIndexBy(messageQueue, message as InterimPositionMessage, messageSortKey);
            message.j = point([message.lat, message.lng]);
            messageQueue.splice(insertIndex, 0, message as InterimPositionMessage);
        }
        console.log(`${aircraft.className}/${flarmId}/${aircraft.compno}: ${messageQueue.length}/${loaded} points loaded ${d(messageQueue.at(0)?.t || 0)}-${d(messageQueue.at(-1)?.t || 0)}`);
    } catch (err) {
        console.error(`${aircraft.className}/${aircraft.compno}/${flarmId}: ${err}...`);
    }
}

//
// This iterates through the queue on a regular basis and deals with each point
// it also ensures time order and is where you can perform filtering for positioning
// jumps or to prefer specific receivers.
//
// Note that we do not consume the message queue - it is used for scoring restarts etc
// so all messages are kept.
export async function processMessageQueue(aircraft: Aircraft, log?: Function) {
    //
    let lastSent = aircraft.lastSent;
    let messages = aircraft.messages;
    const start = (aircraft.lastTime ? aircraft.lastTime + 1 : 0) as Epoch;
    const realNow = getNow();
    const to: Epoch = (realNow - inorderAdditionalDelay) as Epoch;
    let position = _sortedLastIndexBy(messages, {t: start} as any, messageSortKey);

    if (!log) {
        log = aircraft.log;
    }
    if (log) {
        log(`PMQ: ${aircraft.compno}: m: ${messages.length}, s:${start}/${d(start)}, to:${to}/${d(to)}, p: ${position}`);
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
                  // as they can't possible be correct (point.s is the flarm reported speed)
                  .filter((point) => point.dSH < (point.s || 160) * 2.3 && point.dSV < 30)
                  // Then sort them by amount of change
                  .sort((a, b) => (a.dH - a.dH > 1 ? a.dH - b.dH : a.dV != b.dV ? a.dV - b.dV : a.o == lastSent!.o ? -1 : 0))
            : duplicates;

        // If it hasn't changed then we will ignore it - this should prevent us getting stuck on the previous
        // one
        const filtered = lastSent ? sorted.filter((a) => a.lat != lastSent!.lat || a.lng != lastSent!.lng || a.a != lastSent!.a) : sorted;

        // We haven't picked one because we have had no movement but we have had packets
        const stationary = lastSent && !filtered.length && sorted.length && realNow - lastSent.t > 30;

        // Take the first one, if we don't have one then we can just do nothing for now
        const point = filtered.at(0) ?? (stationary ? sorted[0] : undefined);
        if (!point) {
            continue;
        }

        if (stationary) {
            aircraft.stationary++;

            // If we had been stationary for a while and we are low enough to be on the ground
            // then mark it as so
            if (aircraft.stationary > 5 && point.g < 100 && !aircraft.ground) {
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
        if (aircraft.ground && (point.ad ?? 0) > 3) {
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
        const live = start != 0 || position == messages.length || (messages[position]?.t ?? Infinity) >= to;
        aircraft.channel!.postMessage({...point, aircraft: undefined, j: undefined, _: live});
        log('sent->', point);
    }
    if (!aircraft.lastTick || realNow - aircraft.lastTick > 60) {
        aircraft.channel!.postMessage({
            c: aircraft.compno, //
            t: (messages.length && position > 0 ? messages[Math.min(position, messages.length) - 1]?.t : undefined) || (2 as Epoch),
            _: true,
            tick: true
        } as any);
        aircraft.lastTick = (realNow - (!aircraft.lastTick ? Math.random() * 60 : 0)) as Epoch;
    }

    if (log) {
        log(`PMQ: ${aircraft.compno}: processed ${count}, pos: ${position}/${messages.length} @ ${messages[position]?.t}, s:${start} t:${to}`);
    }
}
