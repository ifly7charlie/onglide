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

// For smoothing altitudes
//import KalmanFilter from 'kalmanjs';

import {makeGetNow, d} from '../now';

import {PositionMessage} from '../types';
interface InterimPositionMessage extends PositionMessage {
    //    aircraft: Aircraft;
    f: FlarmID; // id
    o: string; // sender
    ad: number; // airfield distance
}

import {Epoch, ClassName_Compno, ClassName, AltitudeAgl, makeClassname_Compno, Compno, FlarmID, ChannelName, Bearing, Speed, Datecode} from '../types';
import {APRS_MAX_FILTER_BYTES, Bbox, pointInBbox} from '../flightprocessing/taskBbox';
import {distHaversine} from '../flightprocessing/taskhelper';

// APRS connection
let connection: ISSocket & {aprsc: string; lastPacketTime: number};
const possibleServers = ['glidern1.glidernet.org', 'glidern2.glidernet.org', 'glidern3.glidernet.org', 'glidern5.glidernet.org'];

// Pending filter string, set if setFilter is called before we're connected
// and logged in. Drained in the connect handler after sendLogin().
let pendingFilter: string | null = null;

// Last successfully applied filter — re-sent after reconnects so we don't
// fall back to the login-time r/0/0/1 placeholder.
let currentFilter: string | null = null;

// True from the moment the connect handler has fired and sendLogin() has
// been called. This gates #filter — aprsc only accepts in-band filter
// updates after login.
let loggedIn = false;

// Liveness window: the keepalive tick declares the connection dead if no
// APRS line — flarm packet or aprsc server line — has arrived within this
// many ms. aprsc emits its server line every ~20s when idle, so 61s
// tolerates two missed heartbeats before reconnecting.
const KA_GRACE_MS = 61_000;

// The currently-live keepalive timer. Tracked at module scope so a fresh
// startAprsListener can tear down the prior generation's timer even when
// the restart was triggered by a path that didn't capture a local handle.
let kaInterval: NodeJS.Timeout | null = null;

// Guard against concurrent restarts. The error handler and kaInterval
// can both trip the "too unstable" threshold in the same tick; without
// this guard a deferred close/error event on the old socket would race
// with the new listener and trigger a cascading second restart.
let restarting = false;

import {BroadcastChannel, Worker, parentPort, isMainThread, workerData, SHARE_ENV} from 'node:worker_threads';

import {trackMetric, initialiseInsights} from '../insights';
//import {pathToFileURL} from 'node:url';

import {sortedLastIndexBy} from '../util/binarySearch';

export enum AprsCommandEnum {
    none,
    shutdown,
    track,
    finish,
    untrack,
    setFilter,
    setAirfields,
    updateAirfieldBboxes
}

export type AprsCommand = AprsCommandShutdown | AprsCommandTrack | AprsCommandUntrack | AprsCommandFinish | AprsCommandSetFilter | AprsCommandSetAirfields | AprsCommandUpdateAirfieldBboxes;

// Request a glider to be tracked
export interface AprsCommandTrack {
    action: AprsCommandEnum.track;

    className: ClassName;
    channelName: string;
    compid: string; // resolves the Airfield (with bbox) for prefilter / disambiguation
    compno: Compno;
    datecode: Datecode;
    tzoffset: number; // seconds east of UTC — used to derive competition start time for point backfill
    receiveNewPoints: boolean;
    trackerId: string | string[];
}

export interface AprsCommandUntrack {
    action: AprsCommandEnum.untrack;

    className: ClassName;
    channelName: string;
    compno: Compno;
    trackerId: string | string[];
}

export interface AprsCommandFinish {
    action: AprsCommandEnum.finish;

    className: ClassName;
    channelName: string;
    compno: Compno;
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
    officialDelay?: number; // seconds; per-comp tracking delay (from competition.delayseconds or env fallback). Omitted by test fixtures and treated as 0.
}

export interface AprsCommandSetAirfields {
    action: AprsCommandEnum.setAirfields;
    airfields: AirfieldSpec[];
}

// Bbox upsert spec for updateAirfieldBboxes. The spec is keyed by compid; an
// absent bbox clears any previous bbox for that comp (returning it to
// pre-task / broadcast-fallback semantics). Comps not in the spec list keep
// whatever bbox they had — this command never touches membership.
export interface AirfieldBboxSpec {
    compid: string;
    bbox?: Bbox;
}

export interface AprsCommandUpdateAirfieldBboxes {
    action: AprsCommandEnum.updateAirfieldBboxes;
    airfields: AirfieldBboxSpec[];
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
    compno: Compno;
    className: ClassName;
    trackers: FlarmID[];

    // Direct reference to this aircraft's competition airfield, set once at
    // trackGlider time. The aircraft↔competition relationship is permanent
    // for the aircraft's lifetime, so the bbox prefilter inside processPacket
    // reads aircraft.airfield.bbox without a per-packet lookup. setAirfields
    // mutates Airfield records in place, so bbox updates land here automatically.
    airfield: Airfield;

    datecode: Datecode; // competition day this aircraft belongs to (internal signal for reset-on-change)
    tzoffset: number; // competition timezone offset; drives backfill start time

    receiveNewPoints: boolean;

    lastTime?: number;
    lastSent?: InterimPositionMessage;
    lastMoved: number;
    lastTick: Epoch;

    //    kf?: any; // altitude smoothing
    stationary: number; // consecutive stationary fixes
    // Capped 0-10 ground-state counter. Saturated to 10 while the
    // aircraft looks parked (stationary + low AGL) and decremented once
    // per high-AGL fix. Treated as "on ground" whenever > 0 — debounces
    // single stray GPS points that briefly read high altitude.
    ground: number;

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
export interface Airfield {
    compid: string;
    point: {lat: number; lng: number};
    elevation: AltitudeAgl;
    // Per-comp official delay in seconds and its bound clock.
    // processMessageQueue calls airfield.getNow() to gate its output, so
    // packets sit in aircraft.messages long enough that downstream
    // consumers (main thread → websocket, scoring worker → inordergenerator)
    // see a delayed stream. The closure is rebuilt in-place by setAirfields
    // whenever the delay actually changes, so live edits propagate without
    // restarting any aircraft state.
    officialDelay: Epoch;
    getNow: () => Epoch;
    // Expanded task bbox for the comp. Mutated in place by setAirfields when
    // the main thread ships a new bbox via rebuildAprsFilter.
    bbox?: Bbox;
}
const airfields: Airfield[] = [];

// Per-comp channels for unknown gliders that land near that comp's airfield.
// Lazily created on first dispatch; closed when the airfield goes away.
const unknownChannels: Record<string, BroadcastChannel> = {};

function nearestAirfield(jPoint: {lat: number; lng: number}): {field: Airfield; distance: number} | null {
    let best: Airfield | null = null;
    let bestD = Infinity;
    for (const a of airfields) {
        const d = distHaversine(jPoint, a.point);
        if (d < bestD) {
            bestD = d;
            best = a;
        }
    }
    return best ? {field: best, distance: bestD} : null;
}

function getUnknownChannel(compid: string): BroadcastChannel {
    if (!unknownChannels[compid]) {
        const name = 'Unknown_' + compid;
        unknownChannels[compid] = new BroadcastChannel(name);
    }
    return unknownChannels[compid];
}

// Exported for unit testing — these mutate worker-process state, so production
// callers always go through the parentPort message dispatch.
export function setAirfields(specs: AirfieldSpec[]) {
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

    // Add or update each spec. Bbox is intentionally untouched here —
    // updateAirfieldBboxes is the sole writer for that field, so this
    // canonical-membership sync (driven by reconcileContexts in main) doesn't
    // clobber a bbox that rebuildAprsFilter has already pushed.
    for (const s of specs) {
        const existing = airfields.find((a) => a.compid === s.compid);
        const p = {lat: s.lt, lng: s.lg};
        const delay = (s.officialDelay ?? 0) as Epoch;
        if (existing) {
            existing.point = p;
            // Only rebuild the bound clock when the delay actually changes;
            // the hot path (processMessageQueue) reads airfield.getNow on
            // every iteration so we don't want fresh allocations every tick.
            if (existing.officialDelay !== delay) {
                existing.officialDelay = delay;
                existing.getNow = makeGetNow(delay);
            }
        } else {
            const a: Airfield = {compid: s.compid, point: p, elevation: 0 as AltitudeAgl, officialDelay: delay, getNow: makeGetNow(delay)};
            airfields.push(a);
            getElevationOffset(s.lt, s.lg, (e: any) => (a.elevation = e));
        }
    }
    console.log(`aprs airfields: ${airfields.map((a) => `${a.compid}${a.bbox ? '*' : ''}`).join(',') || 'none'}`);
}

// Bbox-only upsert. Membership is owned by setAirfields; this path looks up
// each compid in the existing airfield list and writes its bbox in place.
// Unknown compids are skipped with a warning — the wiring expectation is
// that setAirfields registers every comp before rebuildAprsFilter ever runs.
// Logs only when at least one bbox actually changed, to keep steady-state
// quiet (rebuildAprsFilter fires on every tick).
export function updateAirfieldBboxes(specs: AirfieldBboxSpec[]) {
    const changed: string[] = [];
    for (const s of specs) {
        const existing = airfields.find((a) => a.compid === s.compid);
        if (!existing) {
            console.log(`aprs updateAirfieldBboxes: skipping unknown compid ${s.compid}`);
            continue;
        }
        if (!bboxesEqual(existing.bbox, s.bbox)) {
            existing.bbox = s.bbox;
            changed.push(s.compid);
        }
    }
    if (changed.length) {
        console.log(`aprs bboxes updated: ${changed.join(',')}`);
    }
}

function bboxesEqual(a: Bbox | undefined, b: Bbox | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// Look up an Airfield by compid. Returns undefined if no setAirfields call
// has registered this comp yet — trackGlider treats that as a hard error.
function airfieldForCompid(compid: string): Airfield | undefined {
    return airfields.find((a) => a.compid === compid);
}

//
// Per-aircraft bbox prefilter / multi-comp disambiguation.
//
// Each Aircraft consults its own permanent airfield reference. Aircraft
// whose comp has no bbox (pre-task) always pass — we can't filter without
// one. Aircraft whose bbox contains the position pass. This drops false
// positives the aprsc filter let through (wide union slop) and routes a
// shared FLARM ID into only the comp(s) whose bbox contain the position
// (both pass when bboxes overlap).
//
// No-match fallback: if every aircraft fails the filter (e.g. the worker
// is briefly stale between a task republish and the next rebuildAprsFilter
// push), broadcast to all rather than silently drop. Exported for testing.
export function selectAircraftForPosition(aircraftList: Aircraft[], lat: number, lng: number): Aircraft[] {
    if (aircraftList.length === 0) return aircraftList;
    const matched = aircraftList.filter((ac) => !ac.airfield.bbox || pointInBbox(ac.airfield.bbox, lat, lng));
    return matched.length > 0 ? matched : aircraftList;
}

// Mapping by class/compno to aircraft record
const allAircraft: Record<ClassName_Compno, Aircraft> = {};

// Mapping by trackerid to aircraft record
const trackers: Record<FlarmID, Tracker> = {};

// And for sending message onwards - all we do here is fetch and enrich
const channels: Record<ChannelName, BroadcastChannel> = {};

// Loads are debounced and scanned in one pass over the pointlog files
// regardless of how many gliders need points loaded. Each glider gets its
// own queue and per-glider since trim; the actual file scan uses min(since)
// across the batch. This collapses (n_gliders × n_files × scan) — which
// pinned the APRS worker thread at 100% on restart while scoring workers
// sat idle — down to (n_files × scan).
interface PendingLoad {
    key: ClassName_Compno;
    glider: Aircraft;
    queue: InterimPositionMessage[];
    flarmIds: string[];
    since: number;
    label: string;
    channelName: string;
    trackerIdForLog: any;
}
let pendingLoads: PendingLoad[] = [];
let loadTimer: NodeJS.Timeout | null = null;

// Our persistence
import {appendPoint, closeLog, loadPointsForIds, openLog} from './pointlog';
import {competitionStartForDatecode} from '../datecode';
import {aprsAdditionalDelay, PENDING_LOAD_DEBOUNCE_MS} from '../constants';

//
// Start a listener
export class AprsController {
    worker: Worker;

    constructor(config: AprsListenerConfig) {
        if (!isMainThread) {
            throw new Error('umm, this is only available in main thread');
        }
        console.log('Starting APRS worker thread');

        this.worker = new Worker(__filename, {env: SHARE_ENV, workerData: config, name: 'aprs'});
    }

    validateGlider(trackerIds: string): boolean {
        if (!trackerIds || trackerIds == 'unknown' || trackerIds == 'blocked') {
            return false;
        }
        const flarmIDs = trackerIds
            .split(/[:,]/)
            .map((i) => i.toUpperCase())
            .filter((i) => i.match(/[0-9A-Fa-f]{6}$/)) as string[];
        return flarmIDs && flarmIDs.length > 0;
    }

    trackGlider(compid: string, compno: Compno, className: ClassName, datecode: Datecode, tzoffset: number, channelName: ChannelName, trackerIds: string, receiveNewPoints: boolean): boolean {
        const flarmIDs = trackerIds
            .split(/[:,]/)
            .map((i) => i.toUpperCase())
            .filter((i) => i.match(/[0-9A-Fa-f]{6}$/)) as string[];

        // Tell APRS to start listening for the flarmid
        console.log(`Starting APRS Listener for glider ${compid}/${className}:${compno} => ${flarmIDs.join(',')} [${channelName}] receive:${receiveNewPoints}`);
        const command: AprsCommandTrack = {
            action: AprsCommandEnum.track,
            compid,
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
    updateAirfieldBboxes(airfields: AirfieldBboxSpec[]) {
        const command: AprsCommandUpdateAirfieldBboxes = {
            action: AprsCommandEnum.updateAirfieldBboxes,
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
            case AprsCommandEnum.updateAirfieldBboxes:
                updateAirfieldBboxes(task.airfields);
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
    if (filter.length > APRS_MAX_FILTER_BYTES) {
        // The builder in taskBbox.ts is supposed to keep us under cap;
        // an over-cap filter here means a regression. Refuse rather than
        // send a line aprsc rejects (which would kick the connection on
        // login or silently truncate in-band).
        console.error(`aprs filter ${filter.length} bytes exceeds cap ${APRS_MAX_FILTER_BYTES}; dropping update: ${filter}`);
        return;
    }
    currentFilter = filter;
    if (loggedIn && connection) {
        try {
            connection.send(`#filter ${filter}\r\n`);
            console.log(`${connection.host}: aprs filter updated: ${filter.length} bytes: ${filter}`);
        } catch (e) {
            // Socket can drop between the loggedIn check and send (e.g.
            // after an error that hasn't yet flipped loggedIn). Stash
            // the filter so the next connect handler re-applies it.
            loggedIn = false;
            pendingFilter = filter;
            console.log(`${connection.host}: aprs filter send failed, deferring until reconnect: ${filter.length} bytes: ${filter}: ${e}`);
        }
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

    // Tear down the prior listener generation: stop its keepalive timer
    // and detach event handlers from its socket. Without removeAllListeners
    // a deferred close/error event on the old socket would race in below
    // (after restarting=false) and trigger a cascading second restart.
    if (kaInterval) {
        clearInterval(kaInterval);
        kaInterval = null;
    }
    if (connection) {
        try {
            connection.removeAllListeners();
        } catch {
            /**/
        }
        try {
            connection.disconnect();
        } catch {
            /**/
        }
    }

    // With the prior generation isolated, this fresh listener can itself
    // trigger a restart later if it becomes unstable.
    restarting = false;

    // Settings for connecting to the APRS server
    const PASSCODE = -1;
    const APRSSERVER = (statistics.server = process.env.APRS_SERVER || possibleServers[Math.trunc(possibleServers.length * Math.random())]);
    const PORTNUMBER = 14580;

    // No airfield seed: airfields[] starts empty at module init and is
    // owned by main via setAirfields/updateAirfieldBboxes IPC. Re-seeding
    // here on a restart (config.airfields is the original `[]` workerData)
    // would evict everything main has already pushed and silently strand
    // every comp until the next reconcileContexts tick — which manifested
    // as boot-time `trackGlider refused` for any comp registered before
    // an early APRS reconnect.

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
    connection = new ISSocket(`onglide ${version}`, APRSSERVER, PORTNUMBER, 'OG', -1, true, 'id', FILTER) as any;
    let parser = new aprsParser();
    // Seed liveness: the first kaInterval fires up to a full grace period
    // after this point. Without seeding, an early tick before any packet
    // arrives would falsely declare the connection dead.
    connection.lastPacketTime = Date.now();

    // Handle a connect
    connection.on('connect', () => {
        // sendLogin can throw "Socket not connected" if the socket was
        // disconnected between net's afterConnect and this handler firing
        // (e.g. an error handler already called disconnect()). Letting it
        // throw crashes the worker via EventEmitter's uncaught path, so
        // swallow it and let the normal retry loop reconnect.
        try {
            connection.sendLogin();
            connection.send(`# www.onglide.com airfields=${airfields?.length ?? 0}`);
        } catch (e) {
            console.log(`${connection.host}: aprs sendLogin failed, will retry: ${e}`);
            return;
        }
        loggedIn = true;
        console.log(`${APRSSERVER}: aprs connected and logged in to ${connection.host}`);
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
        connection.lastPacketTime = Date.now();
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
        loggedIn = false;
        connection.disconnect();
        statistics.server += '!';
        unstableCount += 2;
        if (unstableCount > 5) {
            console.log(`${APRSSERVER} too unstable, restarting APRS listener with different server`);
            restarting = true;
            // Don't clearInterval here — startAprsListener tears down the
            // current kaInterval at its top. Clearing with our local closure
            // ref would race if a newer generation has already taken over.
            startAprsListener(config);
            return;
        }
        setTimeout(() => connection.connect(), unstableCount * 2000);
    });

    // Start the APRS connection
    connection.connect();

    // And every minute we need to confirm the APRS
    // connection has had some traffic. Assign to the module-level handle
    // so a future startAprsListener can tear this generation down even if
    // the trigger came from a path that didn't capture a local reference.
    kaInterval = setInterval(
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
                connection.send(`# www.onglide.com airfields ${airfields?.length ?? 0}`);
            } catch (x) {
                console.log(`${connection.host}: unable to send keepalive : ${x}`);
                // Force the next liveness check to fail so we reconnect.
                connection.lastPacketTime = 0;
                loggedIn = false;
            }

            // Reconnect if we've heard nothing in the grace window. aprsc
            // sends a server line every ~20s when idle, so silence beyond
            // KA_GRACE_MS means at least two missed heartbeats — the
            // connection really is dead.
            if (Date.now() - connection.lastPacketTime > KA_GRACE_MS && !restarting) {
                console.log(`${connection.host}: failed APRS connection to ${APRSSERVER}, retrying usc:${unstableCount} `);
                loggedIn = false;
                connection.disconnect(() => {
                    if (restarting) {
                        return;
                    }
                    unstableCount += 2;
                    if (unstableCount > 5) {
                        console.log(`${APRSSERVER} too unstable, restarting APRS listener with different server`);
                        restarting = true;
                        // startAprsListener tears down the current kaInterval
                        // at its top — don't clear here, see error handler.
                        startAprsListener(config);
                        trackMetric('aprs.restart', 1);
                        return;
                    }
                    connection.connect();
                });
            }
        },
        1 * 60 * 1000
    );
}

// Track a glider: register the tracker(s) and per-glider channel synchronously
// so live processPacket calls start landing in glider.messages immediately,
// then fire-and-forget a per-flarmid SQL load that pushes any historical points
// (since competition start) into the same queue with the same sorted-insert
// path the live writer uses. One write path (live appendPoint), one read path
// (SQL scan on track-glider) — no debounced batch, no interim queue.
function trackGlider(task: AprsCommandTrack) {
    console.log('*** trackGlider ***', task.compno, task.trackerId);

    // Resolve the airfield up front: prefilter / disambiguation can't work
    // without it. Main always pushes setAirfields before trackGlider, so a
    // miss here is a wiring bug — refuse rather than silently routing every
    // packet for this comp through the no-bbox fallback forever.
    const airfield = airfieldForCompid(task.compid);
    if (!airfield) {
        console.error(`APRS: trackGlider refused for ${task.className}/${task.compno}: compid ${task.compid} not in airfields list`);
        return;
    }

    const key = makeClassname_Compno(task);

    const existingTracker = allAircraft[key];
    if (existingTracker) {
        console.log(`${task.compno}: closing existing tracker entry ${existingTracker.trackers.join(',')}`);
        existingTracker.trackers.forEach((t) => {
            const tracker = trackers[t];
            tracker.aircraftList = tracker.aircraftList.filter((a) => a.channel != existingTracker.channel || a.compno != existingTracker.compno);
            if (!tracker.aircraftList.length) {
                delete trackers[t];
            }
        });
        clearInterval(existingTracker.interval);
        // Drop any pending load for the previous glider object so it
        // doesn't dispatch points into an orphaned queue when the next
        // flush fires.
        pendingLoads = pendingLoads.filter((b) => b.key !== key);
    }

    const glider: Aircraft = {
        compno: task.compno,
        className: task.className,
        trackers: task.trackerId as FlarmID[],
        airfield,

        datecode: task.datecode,
        tzoffset: task.tzoffset,

        stationary: 0,
        ground: 0,
        lastTick: 0 as Epoch,
        lastMoved: 0 as Epoch,
        receiveNewPoints: task.receiveNewPoints,

        log:
            process.env.NEXT_PUBLIC_COMPNO && task.compno == process.env.NEXT_PUBLIC_COMPNO
                ? function log() {
                      console.log(task.compno, ...arguments);
                  }
                : function log() {},

        messages: []
    };

    allAircraft[key] = glider;

    const interimQueue: InterimPositionMessage[] = [];
    // Anchor on the datecode being registered, not wall-clock now: at the
    // midnight-UTC rollover competitionStartTs(now) still points at yesterday's
    // 10:00 local, which would backfill yesterday's flight into today's tracker.
    const since = competitionStartForDatecode(task.datecode, task.tzoffset);

    const trackerList = typeof task.trackerId == 'string' ? [task.trackerId] : task.trackerId;
    const dedupedIds = [...new Set(trackerList)];
    let index = 0;
    for (const id of dedupedIds) {
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
    }

    // Wire up the channel and the queue immediately so live packets arriving
    // during the load window land on this glider (the final sort fixes
    // any interleaving). The per-glider interval starts only after the
    // batch flush.
    if (!channels[task.channelName]) {
        channels[task.channelName] = new BroadcastChannel(task.channelName);
    }
    glider.channel = channels[task.channelName];
    glider.messages = interimQueue;

    if (dedupedIds.length === 0) {
        // No load possible (e.g. unknown tracker) — start the interval
        // straight away so live packets, if any ever arrive, get processed.
        startGliderInterval(glider, task.className, task.compno, task.trackerId, task.channelName);
        return;
    }

    pendingLoads.push({
        key,
        glider,
        queue: interimQueue,
        flarmIds: dedupedIds,
        since,
        label: `${task.className}/${task.compno}`,
        channelName: task.channelName,
        trackerIdForLog: task.trackerId
    });
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(flushLoads, PENDING_LOAD_DEBOUNCE_MS);
}

function startGliderInterval(glider: Aircraft, className: ClassName, compno: Compno, trackerId: any, channelName: string) {
    setTimeout(() => {
        console.log(`APRS: tracking ${className}/${compno} with ${trackerId} on channel ${channelName}`);
        glider.interval = setInterval(() => processMessageQueue(glider), 1000);
    }, Math.random() * 1000);
}

interface LoadTarget {
    queue: InterimPositionMessage[];
    compno: Compno;
    since: number;
    // Same prefilter as the live path: drop log points outside this comp's
    // expanded task bbox so multi-comp shared FLARM IDs don't pollute the
    // wrong queue at registration time.
    airfield: Airfield;
}

async function flushLoads() {
    loadTimer = null;
    const batch = pendingLoads;
    pendingLoads = [];
    if (batch.length === 0) return;

    // Build flarmId → [target] map. One flarm ID can map to multiple
    // gliders if two pilots share a tracker (rare but supported by the
    // existing trackers[id].aircraftList structure).
    const idToTargets = new Map<string, LoadTarget[]>();
    let minSince = Infinity;
    for (const b of batch) {
        if (b.since < minSince) minSince = b.since;
        const target: LoadTarget = {queue: b.queue, compno: b.glider.compno, since: b.since, airfield: b.glider.airfield};
        for (const id of b.flarmIds) {
            const existing = idToTargets.get(id);
            if (existing) existing.push(target);
            else idToTargets.set(id, [target]);
        }
    }

    const allIds = new Set(idToTargets.keys());
    const startMs = Date.now();
    let yielded = 0;
    let dispatched = 0;

    try {
        for await (const raw of loadPointsForIds({flarmIds: allIds, since: minSince})) {
            yielded++;
            const targets = idToTargets.get(raw.f);
            if (!targets) continue;
            const baseMessage = raw as InterimPositionMessage & {d?: number};
            if (typeof baseMessage.d === 'number' && baseMessage.d > 1200) continue;

            for (const target of targets) {
                if (raw.t < target.since) continue;
                // Pre-task comps (no bbox) keep current behaviour; for a comp
                // with a bbox, drop points that fall outside it. Independent
                // per target, so multi-comp registrations naturally route
                // each point to whichever comp(s) actually contain it.
                if (target.airfield.bbox && !pointInBbox(target.airfield.bbox, baseMessage.lat, baseMessage.lng)) continue;
                target.queue.push({...baseMessage, c: target.compno, ad: distHaversine(baseMessage, target.airfield.point)});
                dispatched++;
            }
        }
    } catch (err) {
        console.error(`flushLoads: ${err}`);
    }

    // Sort each glider's queue once and start its interval.
    for (const b of batch) {
        b.queue.sort(messageSortKeyCompare);
        if (b.queue.length) {
            console.log(`${b.label}: ${b.queue.length} points sorted ${d(b.queue[0].t)}-${d(b.queue[b.queue.length - 1].t)}`);
        }
        startGliderInterval(b.glider, b.glider.className, b.glider.compno, b.trackerIdForLog, b.channelName);
    }
    console.log(`flushLoads: ${batch.length} gliders, ${allIds.size} flarmIds, ${yielded} read / ${dispatched} dispatched, ${Date.now() - startMs}ms`);
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

function messageSortKey(m: InterimPositionMessage): number {
    return m.t;
}

function messageSortKeyCompare(a: InterimPositionMessage, b: InterimPositionMessage): number {
    return a.t - b.t;
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

    const jPoint = {lat: packet.latitude!, lng: packet.longitude!};

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

    // Per-aircraft bbox prefilter and multi-comp disambiguation. See
    // selectAircraftForPosition for the rules.
    const dispatchTo = selectAircraftForPosition(aircraftList, packet.latitude!, packet.longitude!);

    // Figure out where to insert (sorted by time). Clone per aircraft so
    // each pipeline owns its own message with its own compno — sharing the
    // reference and mutating .c per iteration leaves the last aircraft's
    // compno on every queued copy, which the downstream IOG filter
    // (`message.c != compno`) then drops for everyone except whoever was
    // last in the loop.
    for (let aircraft of dispatchTo) {
        const perAircraftMessage = {...message, c: aircraft.compno as Compno};
        const messageQueue = aircraft.messages;
        if ((messageQueue.at(-1)?.t ?? 0) > perAircraftMessage.t) {
            statistics.outOfOrder++;
            const insertIndex = sortedLastIndexBy(messageQueue, perAircraftMessage, messageSortKey);
            if (insertIndex > 0 && messageQueue[insertIndex - 1].t == perAircraftMessage.t) {
                statistics.duplicates++;
            }
            messageQueue.splice(insertIndex, 0, perAircraftMessage);
        } else {
            messageQueue.push(perAircraftMessage);
        }
    }
}

//

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
    // Per-comp clock: aircraft.airfield.getNow is rebuilt by setAirfields
    // whenever officialDelay changes, so live delay edits propagate to the
    // next call here. makeGetNow honours replay mode.
    const realNow = aircraft.airfield.getNow();
    const to: Epoch = (realNow - aprsAdditionalDelay) as Epoch;
    let position = sortedLastIndexBy(messages, {t: start} as any, messageSortKey);

    if (!log) {
        log = aircraft.log;
    }
    if (log && messages.length > 0 && position < messages.length) {
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
        const sortedPoint = !lastSent
            ? null
            : duplicates
                  .map((point) => {
                      const dH = distHaversine(point, lastSent!);
                      const dV = point.a - lastSent!.a;
                      const dG = point.g - lastSent!.g;
                      const dT = point.t - lastSent!.t;
                      return {
                          ...point,
                          dH: dH * 1000,
                          dV,
                          dG,
                          dT,
                          dSH: (3600 * dH) / dT, //km/s
                          dSV: Math.abs(dV / dT) // m/s
                      };
                  })
                  // Quickly remove faster than 300kph Horizontal or 30m/s Vertical
                  // as they can't possible be correct (point.s is the flarm reported speed)
                  .filter((point) => point.dSH < (point.s || 160) * 2.3 && point.dSV < 30)
                  // Then sort them by amount of change
                  .sort((a, b) => (Math.abs(a.dH - b.dH) > 1 ? a.dH - b.dH : a.dV != b.dV ? a.dV - b.dV : a.o == lastSent!.o ? -1 : 0))
                  .at(0);

        // Take the first one, if we don't have one then we can just do nothing for now
        // don't bypass the filtering for jumps by assuming null sortedPoint means take first point
        const point = lastSent ? sortedPoint : duplicates.at(0);
        if (!point) {
            continue;
        }

        // First packet of the session: seed lastSent so the next packet can produce a
        // dH/dG against it, but don't emit. Combined with the relaxed stationaryTime
        // gate below, this lets the on-ground / >3 km filter engage from packet 2
        // instead of waiting for the ground state machine to arm.
        if (!lastSent) {
            aircraft.lastSent = lastSent = point;
            continue;
        }

        // If it hasn't really moved we treat it as "no movement" so the stationary
        // path below can fire. Raw GPS altitude (a) jitters by a few metres even
        // when parked, so compare g (AGL, rounded to the metre) and allow a small
        // horizontal tolerance for GPS drift.
        const noMovement = sortedPoint ? sortedPoint.dH < 5 && Math.abs(sortedPoint.dG) < 3 : false;

        // We haven't picked one because we have had no movement but we have had packets.
        // Note: aircraft.lastMoved starts at 0 and is only set once the glider actually
        // moves, so leaving it un-gated lets stationaryTime evaluate to a huge epoch
        // value on the first stationary detection. That's intentional — it arms the
        // ground state immediately for gliders that were already parked when the
        // session started.
        const stationaryTime = noMovement && sortedPoint ? sortedPoint.t - aircraft.lastMoved : 0;

        if (stationaryTime > 60) {
            // If we had been stationary for a while and we are low enough to be on the ground
            // then mark it as so.
            if (point.g < 100) {
                if (aircraft.ground === 0) {
                    console.log(`${aircraft.className}:${point.c}: on ground @ ${point.t}`);
                }
                aircraft.ground = 6;
            }
        }

        // If we look like we have 'taken' off, decrement once. A handful of
        // bad GPS fixes won't clear the on-ground state — we need ~10
        // consecutive high-AGL points to fully leave ground.
        if (aircraft.ground > 0) {
            if (point.g > 110) {
                aircraft.ground--;
                if (aircraft.ground === 0) {
                    console.log(`${point.c}: left ground @ ${point.t}`);
                }
            } else if (point.g < 100) {
                aircraft.ground = 6;
            }
        }

        // If we are on the ground and we are more than 3 km from airfield location then we don't
        // want to report it. This doesn't filter initial points as you are not marked as on the ground
        // till several stationary points have happened
        if (aircraft.ground > 0 && (point.ad ?? 0) > 3) {
            continue;
        }

        if (stationaryTime && point.t - (lastSent?.t ?? 0) < 30) {
            continue;
        }

        // If we are not stationary record when we moved so we can track ground or not
        if (!stationaryTime) {
            aircraft.lastMoved = point.t;
        }

        // Check for very late and log it
        aircraft.lastSent = lastSent = point;

        // Send message, if we are sending ALL then by definition this will be 'late' so indicate that
        // all it does is stop it sending to the front end.
        // Don't promote the last point of an initial replay (start == 0) to live just because it's
        // the end of the batch — that lets EPG's tick-based landout fire against the second-to-last
        // point and then get reverted when the "live" final point lands. The heartbeat tick below
        // (always _:true) is what signals the replay/live boundary to iog.
        const live = start != 0 || (position < messages.length && messages[position].t >= to);
        aircraft.channel!.postMessage({...point, aircraft: undefined, _: live});
        log('sent->', point);
    }
    if (!aircraft.lastTick || realNow - aircraft.lastTick > 60) {
        aircraft.channel!.postMessage({
            c: aircraft.compno, //
            t: to,
            _: true,
            tick: true
        } as any);
        aircraft.lastTick = (realNow - (!aircraft.lastTick ? Math.random() * 60 : 0)) as Epoch;
    }

    if (log && count > 0) {
        log(`PMQ: ${aircraft.compno}: processed ${count}, pos: ${position}/${messages.length} @ ${messages[position]?.t}, s:${start} t:${to}`);
    }
}
