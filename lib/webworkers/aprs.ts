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
import {altitudeOffsetAdjust} from '../offsets.js';
import {getElevationOffset} from '../getelevationoffset';
//import { getOffset } from '../egm96.mjs';

// Helper function for geometry
import distance from '@turf/distance';
import {Coord, point} from '@turf/helpers';

// For smoothing altitudes
import KalmanFilter from 'kalmanjs';

import {PositionMessage} from './positionmessage';
import {Epoch, ClassName_Compno, ClassName, AltitudeAgl, makeClassname_Compno, Compno, FlarmID, Bearing, Speed} from '../types';

// APRS connection
let connection;
const possibleServers = ['glidern1.glidernet.org', 'glidern2.glidernet.org', 'glidern3.glidernet.org', 'glidern4.glidernet.org'];

import {BroadcastChannel, Worker, parentPort, isMainThread, workerData, SHARE_ENV} from 'node:worker_threads';

import {trackMetric, initialiseInsights} from '../insights';

export enum AprsCommandEnum {
    none,
    shutdown,
    track,
    untrack
}

export type AprsCommand = AprsCommandShutdown | AprsCommandTrack | any;

// Request a glider to be tracked
export interface AprsCommandTrack {
    action: AprsCommandEnum; //= AprsCommandEnum.track

    className: string | ClassName;
    channelName: string;
    compno: string | Compno;
    trackerId: string | string[];
}

// Exit
export interface AprsCommandShutdown {
    action: AprsCommandEnum; //= AprsCommandEnum.shutdown
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
    periodStart: 0,
    jumps: 0
};

// Keep track of the aircraft requested
interface Aircraft {
    compno: string;
    className: string;
    trackers: string | string[];

    lastMessage?: number;
    lastTime?: number;
    lastPoint?: Coord;
    lastMoved?: number;

    kf?: any; // altitude smoothing
    stationary?: number; // consecutive stationary fixes

    channel?: BroadcastChannel; // where to send packets

    // Logging for aircraft
    log: (...x) => void;
}

// Where is the airfield?
let airfieldLocation: Coord;
let airfieldElevation: AltitudeAgl;

// And where to send unknown gliders close to the airfield
let unknownChannel: BroadcastChannel;

// Mapping by class/compno to aircraft record
const aircraft: Record<ClassName_Compno, Aircraft> = {};

// Mapping by trackerid to aircraft record
const trackers: Record<string, Aircraft> = {};

// And for sending message onwards - all we don here is fetch and enrich
const channels: Record<string, BroadcastChannel> = {};

//
// Start a listener
export function spawnAprsContestListener(config: AprsListenerConfig): Worker {
    if (!isMainThread) {
        throw new Error('umm, this is only available in main thread');
    }
    console.log('Starting APRS worker thread');

    return new Worker(__filename, {env: SHARE_ENV, workerData: config});
}

if (!isMainThread) {
    console.log('Started APRS worker thread');

    initialiseInsights();

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
        if (task.action == AprsCommandEnum.track) {
            const trackerObject: Aircraft = {
                compno: task.compno,
                className: task.className,
                trackers: task.trackerId,

                // Not had a message
                lastMessage: 0,

                // Setup logging
                log:
                    task.compno == (process.env.NEXT_PUBLIC_COMPNO || '')
                        ? function log() {
                              console.log(task.compno, ...arguments);
                          }
                        : function log() {}
            };

            // Link the glider in
            aircraft[task.className + '/' + task.compno] = trackerObject;

            // Link the tracker(s) in
            (typeof task.trackerId == 'string' ? [task.trackerId] : task.trackerId)?.forEach((t) => (trackers[t] = trackerObject));

            // And make sure we have a channel for it
            if (!channels[task.channelName]) {
                channels[task.channelName] = new BroadcastChannel(task.channelName);
            }

            // And link the broadcast channel to it
            aircraft[task.className + '/' + task.compno].channel = channels[task.channelName];
            console.log(`APRS: tracking ${task.className}/${task.compno} with ${task.trackerId} on channel ${task.channelName}`);
        }

        if (task.action == AprsCommandEnum.untrack) {
            // What are we removing
            const toRemove = aircraft[makeClassname_Compno(task)];
            if (!toRemove) {
                return;
            }

            // remove the trackers
            (typeof toRemove.trackers == 'string' ? [toRemove.trackers] : toRemove.trackers).forEach((t) => delete trackers[t]);

            // Remove the glider details
            delete aircraft[makeClassname_Compno(task)];
            console.log(`APRS: stop tracking ${task.className}/${task.compno} ids: ${toRemove.trackers}`);
        }
    });

    // Any unknown gliders get sent to this for identification
    unknownChannel = new BroadcastChannel('Unknown_' + workerData.competition);

    // Let's listen
    startAprsListener(<AprsListenerConfig>workerData);
}

//
// Connect to the APRS Server
function startAprsListener(config: AprsListenerConfig) {
    // Settings for connecting to the APRS server
    const PASSCODE = -1;
    const APRSSERVER = process.env.APRS_SERVER || possibleServers[Math.trunc(possibleServers.length * Math.random())];
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
                processPacket(packet);
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
        unstableCount += 2;
        if (unstableCount > 5) {
            console.log(`${APRSSERVER} too unstable, restarting APRS listener with different server`);
            clearInterval(kaInterval);
            startAprsListener(config);
        }
        connection.connect();
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
                `APRS: ${statistics.knownReceived}/${statistics.msgsReceived} msgs, ${(statistics.msgsReceived / period).toFixed(1)} msg/s, average aprs delay: ${(statistics.aprsDelay / statistics.msgsReceived).toFixed(
                    1
                )}s, ignored ${statistics.jumps} jumps, unstableCount: ${unstableCount}`
            );
            trackMetric('aprs.msgsReceived', statistics.msgsReceived);
            trackMetric('aprs.msgsSec', statistics.msgsReceived / period);
            trackMetric('aprs.avgDelay', statistics.aprsDelay / statistics.msgsReceived);
            trackMetric('aprs.server', parseInt(APRSSERVER.match(/([0-9])/)?.[0] || '99'));
            trackMetric('aprs.jumps', statistics.jumps);
        }

        statistics.msgsReceived = statistics.aprsDelay = statistics.knownReceived = statistics.jumps = 0;
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

//
// collect points, emit to competition db every 30 seconds
function processPacket(packet: aprsPacket) {
    // Flarm ID we use is last 6 characters, check if OGN tracker or regular flarm
    const flarmId = packet.sourceCallsign?.slice(packet.sourceCallsign?.length - 6);
    const ognTracker = packet.sourceCallsign?.slice(0, 3) == 'OGN';

    // Lookup the altitude adjustment for the
    let sender = packet.digipeaters?.pop()?.callsign || 'unknown';
    if (sender == 'DLY2APRS') {
        sender = packet.digipeaters?.[0]?.callsign || 'unknown';
    }

    let aoa = ognTracker ? 0 : altitudeOffsetAdjust[sender] || 0;
    if (aoa == null) {
        //        console.log(`ignoring packet from ${sender} as blocked`);
        return;
    }

    if (!packet.latitude || !packet.longitude || !flarmId || !packet.timestamp || !packet.altitude) {
        return;
    }

    // Apply the correction
    let altitude = Math.floor(packet.altitude + aoa);

    // geojson for helper function slater
    const jPoint = point([packet.latitude, packet.longitude]);

    // Check if the packet is late, based on previous packets for the glider
    const now = new Date().getTime() / 1000;
    const td = Math.floor(now - packet.timestamp);
    let islate: boolean | null = null;

    statistics.msgsReceived++;
    statistics.aprsDelay += td;

    // Helper function with some closures so we can report it properly
    const withElevation = async (gl: number) => {
        let message: PositionMessage = {
            c: aircraft ? (aircraft.compno as Compno) : (flarmId as FlarmID),
            lat: Math.round(packet!.latitude * 1000000) / 1000000,
            lng: Math.round(packet!.longitude * 1000000) / 1000000,
            a: altitude,
            g: Math.round(Math.max(altitude - gl, 0)),
            t: packet.timestamp as Epoch,
            b: packet.course as Bearing,
            s: (Math.round((packet.speed ?? 0) * 10) / 10) as Speed,
            f: flarmId + ',' + sender,
            l: islate
        };

        // Send the message to the correct place - if we don't know it
        // (and it's low enough for a launch) then let somebody
        // identify it for us, otherwise we'll send it for tracking
        if (aircraft) {
            aircraft.channel!.postMessage(message);
        } else if (message.g < 750 /*m*/) {
            unknownChannel.postMessage(message);
        }
    };

    // Look it up, have we had packets for this before?
    const aircraft = trackers[flarmId];

    // If it is undefined then we will enrich and send to the
    // airfield channel if it's close enough
    if (!aircraft) {
        if (distance(jPoint, airfieldLocation) < 20 && packet.altitude < airfieldElevation + 750) {
            getElevationOffset(packet.latitude, packet.longitude, withElevation);
        }
        return;
    }

    // Generate log function as it's quite slow to read environment all the time
    if (!aircraft.log) {
    }

    if (!packet.altitude) {
        console.log('unknown altitude in decoded packet', aircraft.compno, packet);
        return;
    }

    statistics.knownReceived++;

    // Ignore duplicates
    if ((aircraft.lastTime ?? 0) >= packet.timestamp) {
        return;
    }

    // Check to make sure they have moved or that it's been about 10 seconds since the last update
    // this reduces load from stationary aircrafts on the ground and allows us to track stationary aircrafts
    // better. the 1 ensures that first packet gets picked up after restart
    // Also make sure the speed between points is < 330kph - ignoring ordering
    const distanceFromLast = aircraft.lastPoint ? distance(jPoint, aircraft.lastPoint) : 1;
    const speedBetweenKph = distanceFromLast / (Math.abs(packet.timestamp - (aircraft.lastMoved ?? 0)) / 3600);
    if (distanceFromLast < 0.01) {
        if (packet.timestamp - aircraft.lastTime < 10) {
            aircraft.stationary++;
            return;
        }
    }
    if (speedBetweenKph > 450 /*kph*/) {
        console.log(
            `IGNORING JUMP ${packet.timestamp} ${altitude}\t${aircraft.compno} ** ${ognTracker} ${td} from ${sender}/${flarmId}: ${packet.altitude?.toFixed(0)} + ${aoa} adjust :: ${
                packet.speed
            }, ${distanceFromLast}km ${speedBetweenKph.toFixed(1)}kph ${packet.timestamp - aircraft.lastMoved}s`
        );
        statistics.jumps++;
        return;
    }

    aircraft.stationary = 0;
    aircraft.lastMoved = packet.timestamp;

    if (altitude > 10000) {
        console.log(
            `IGNORING ALTITUDE JUMP ${packet.timestamp} ${altitude}\t${aircraft.compno} ** ${ognTracker} ${td} from ${sender}/${flarmId}: ${packet.altitude?.toFixed(0)} + ${aoa} adjust :: ${
                packet.speed
            }, ${distanceFromLast}km ${speedBetweenKph}kph`
        );
        statistics.jumps++;
        return;
    }

    if (td > 600) {
        console.log(`${aircraft.compno}/${sender} : VERY delayed flarm packet received, ${(td / 60).toFixed(1)}  minutes old, ignoring`);
        return;
    }

    const betweenPacketGap = packet.timestamp - aircraft.lastTime;

    // Kalman smoothing - reset if more than 30 seconds since last packet
    if (!aircraft.kf || betweenPacketGap > 30) {
        aircraft.kf = new KalmanFilter();
        // add it to the filter but don't use the result
        aircraft.kf.filter(altitude);
    } else {
        // And now use the kalman filtered altitude for everything else
        altitude = Math.floor(aircraft.kf.filter(altitude));
    }

    // Check for very late and log it
    aircraft.lastPoint = jPoint;
    aircraft.lastTime = packet.timestamp;

    // Logging if requested
    aircraft.log(packet.origpacket);
    aircraft.log(`${altitude}\t${aircraft.compno} -> ${ognTracker} ${td}/${islate} from ${sender}: ${packet.altitude?.toFixed(0)} + ${aoa} adjust :: ${packet.speed}`);

    // Enrich with elevation and send to everybody, this is async
    getElevationOffset(packet.latitude, packet.longitude, withElevation);
}
