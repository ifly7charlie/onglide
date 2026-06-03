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

import {makeGetNow, d, readOnly} from '../now';

import {PositionMessage, StreamId} from '../types';
interface InterimPositionMessage extends PositionMessage {
    //    aircraft: Aircraft;
    // Combined StreamId: low 24 bits = flarmid hex, high 8 bits =
    // protocol enum (OGFLR=1, OGNAVI=2, OGNTRK=3, …) — the OGN APRS
    // destCallsign, identifying the uploader / processing pipeline the
    // packet travelled through. Two streams with the same 6-hex but
    // different protocol arrived via different paths (e.g. the same
    // FLARM relayed via Naviter cloud vs. heard directly by an OGN
    // radio gateway) and land in their own stickyPrimary bucket.
    f: StreamId;
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
// Per-flarmid offset sample buffer used by the stickyPrimary picker in
// processMessageQueue. Each time both primary and a secondary flarmid
// produce a record in the same t-bucket we push one sample; the median
// over the last STICKY_OFFSET_WINDOW samples is the offset applied to
// secondary records during primary-gap fill. Median is robust against
// the single-sample GPS noise that wrecks a simple running mean.
export interface FlarmOffsetState {
    dLats: number[];
    dLngs: number[];
    dAlts: number[];
    cursor: number; // next write index modulo window
    count: number; // total samples ever taken (capped at window for median)
    // Latch for discrepancy logging — true while the running-median offset
    // exceeds the threshold (lat/lng > ~150 m, or alt > 50 m). One log line
    // emitted per transition; reset when median drops back below.
    loggedOver?: boolean;
    // Sticky-session latch for the correlation gate: true once MAD of
    // recent samples shows the secondary's offset isn't stationary against
    // primary (e.g. Naviter left at the airfield while FLR flies the
    // task). Untrusted streams are excluded from gap-fill entirely and a
    // 'uncorrelated' row is written to trackerhistory. No reset path —
    // cleared only when the aircraft entry is rebuilt (new datecode).
    untrusted?: boolean;
}

export interface Aircraft {
    compno: Compno;
    className: ClassName;
    // Stream identifiers for this aircraft. At configure time the high
    // byte is 0 (we only know the 6-hex device) — that's effectively
    // "primary, protocol TBD". pickStickyPrimary upgrades the entry to
    // the first observed combined value on first match, so subsequent
    // bucket comparisons are direct equality.
    trackers: StreamId[];

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

    // stickyPrimary picker state — see processMessageQueue. lastPrimaryTime
    // is the t of the most recent accepted primary record; bucket processing
    // skips secondary-only buckets unless (t - lastPrimaryTime) exceeds
    // STICKY_GAP_FILL_S, which keeps secondary GPS noise out of dense
    // primary regions. flarmOffsets accumulates per-secondary-flarmid offset
    // samples (collected whenever primary and secondary co-occur in the same
    // bucket) used to subtract the static GPS-unit-to-GPS-unit bias when a
    // secondary record fills a primary gap.
    lastPrimaryTime?: Epoch;
    flarmOffsets?: Map<StreamId, FlarmOffsetState>;

    // Per-StreamId tally maintained as packets land in this aircraft's
    // queue (in processPacket / flushLoads dispatch). Drives the
    // /status/trackers operator page so the snapshot picker doesn't have
    // to re-scan `messages` every tick. Counts packets received (not
    // emitted) — a high count for an untrusted stream is the signal that
    // a real device is broadcasting but its positions don't track the
    // primary.
    streamsSeen?: Map<StreamId, {count: number; lastT: Epoch}>;

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

// Worker → main thread event. Fired once per (aircraft, secondary stream)
// when stickyPrimary's MAD gate decides the secondary isn't tracking the
// primary (e.g. Naviter device left at the airfield). Consumed by
// bin/ogn.ts to write a 'uncorrelated' row into trackerhistory.
export interface UncorrelatedTrackerEvent {
    type: 'uncorrelated';
    compno: Compno;
    className: ClassName;
    datecode: Datecode;
    primary: StreamId;
    secondary: StreamId;
    madLatM: number;
    madLngM: number;
    madAltM: number;
    sampleCount: number;
}

// Snapshot of per-pilot tracker state for the operator status page.
// Pushed from the worker every TRACKER_STATUS_SNAPSHOT_MS so the main
// thread cache stays fresh without a request/response round-trip.
export interface TrackerSnapshotEntry {
    compno: Compno;
    className: ClassName;
    datecode: Datecode;
    // aircraft.trackers — combined StreamIds. High byte 0 means the
    // configured-but-not-yet-promoted placeholder; primaryUpgraded
    // signals whether the first packet has bumped it to the actual src.
    configured: StreamId[];
    // Every (src, fid) we've actually seen for this aircraft, with
    // received packet count and last-seen epoch.
    observed: Array<{
        f: StreamId;
        count: number;
        lastT: Epoch;
        sampleCount: number; // offset pair samples against primary (0 if no overlap yet)
        untrusted: boolean;
        isPrimary: boolean;
    }>;
    lastEmittedT?: Epoch; // aircraft.lastTime — most recent emitted fix
}
export interface TrackerStatusEvent {
    type: 'trackerStatus';
    snapshotT: Epoch; // worker wall-clock when this snapshot was built
    pilots: TrackerSnapshotEntry[];
}

export type AprsWorkerEvent = UncorrelatedTrackerEvent | TrackerStatusEvent;

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
import {appendPoint, closeLog, fidFromFlarm, fidLabel, loadPointsForIds, openLog, packFlarmId, protoCodeFor} from './pointlog';

// 24-bit fid (low 24 bits of a combined StreamId) as a 6-hex uppercase
// string. Used when crossing from the combined StreamId
// (aircraft.trackers) back to the device-identity key for the global
// `trackers` map.
function combinedToHex6(combined: StreamId): string {
    return (combined & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
}
import {competitionStartForDatecode} from '../datecode';
import {aprsAdditionalDelay, PENDING_LOAD_DEBOUNCE_MS} from '../constants';

//
// Start a listener
export class AprsController {
    worker: Worker;

    // Set by the host (bin/ogn.ts) to receive structured events from the
    // worker thread — currently just the `uncorrelated` notification when
    // pickStickyPrimary drops a secondary. Worker has no DB handle, so the
    // host is responsible for persistence.
    onWorkerEvent: (e: AprsWorkerEvent) => void = () => {};

    constructor(config: AprsListenerConfig) {
        if (!isMainThread) {
            throw new Error('umm, this is only available in main thread');
        }
        console.log('Starting APRS worker thread');

        this.worker = new Worker(__filename, {env: SHARE_ENV, workerData: config, name: 'aprs'});
        this.worker.on('message', (e: AprsWorkerEvent) => {
            try {
                this.onWorkerEvent(e);
            } catch (err: any) {
                console.log(`AprsController: onWorkerEvent threw on ${e?.type}: ${err?.message ?? err}`);
            }
        });
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

// Snapshot cadence drives the staleness of /status/trackers, which uses
// a 30 s auto-refresh meta tag — keep them aligned.
const TRACKER_STATUS_SNAPSHOT_MS = 30_000;

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

    // readOnly (REPLAY_DB / OGN_READ_ONLY) must not mutate the point log —
    // skip opening the write stream entirely so no file is created and the
    // per-packet appendPoint below short-circuits.
    (readOnly ? Promise.resolve() : openLog()).then(() => startAprsListener(<AprsListenerConfig>workerData));

    // Push a snapshot of per-pilot tracker state to the main thread every
    // TRACKER_STATUS_SNAPSHOT_MS for the /status/trackers operator page.
    // Cheap to build (O(aircraft) × O(streams per aircraft)) and only
    // includes pilots that have been registered for tracking.
    setInterval(emitTrackerStatusSnapshot, TRACKER_STATUS_SNAPSHOT_MS);
}

function emitTrackerStatusSnapshot(): void {
    if (!parentPort) return;
    const now = Math.floor(Date.now() / 1000) as Epoch;
    const pilots: TrackerSnapshotEntry[] = [];
    for (const key in allAircraft) {
        const ac = allAircraft[key as ClassName_Compno];
        const primary = ac.trackers[0];
        const observed: TrackerSnapshotEntry['observed'] = [];
        if (ac.streamsSeen) {
            for (const [f, info] of ac.streamsSeen) {
                const off = ac.flarmOffsets?.get(f);
                observed.push({
                    f,
                    count: info.count,
                    lastT: info.lastT,
                    sampleCount: off?.count ?? 0,
                    untrusted: !!off?.untrusted,
                    isPrimary: f === primary
                });
            }
            observed.sort((a, b) => b.lastT - a.lastT);
        }
        pilots.push({
            compno: ac.compno,
            className: ac.className,
            datecode: ac.datecode,
            configured: ac.trackers.slice(),
            observed,
            lastEmittedT: ac.lastTime as Epoch | undefined
        });
    }
    parentPort.postMessage({type: 'trackerStatus', snapshotT: now, pilots} satisfies TrackerStatusEvent);
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
        console.log(`${task.compno}: closing existing tracker entry ${existingTracker.trackers.map(fidLabel).join(',')}`);
        existingTracker.trackers.forEach((t) => {
            const key = combinedToHex6(t) as FlarmID;
            const tracker = trackers[key];
            if (!tracker) return;
            tracker.aircraftList = tracker.aircraftList.filter((a) => a.channel != existingTracker.channel || a.compno != existingTracker.compno);
            if (!tracker.aircraftList.length) {
                delete trackers[key];
            }
        });
        clearInterval(existingTracker.interval);
        // Drop any pending load for the previous glider object so it
        // doesn't dispatch points into an orphaned queue when the next
        // flush fires.
        pendingLoads = pendingLoads.filter((b) => b.key !== key);
    }

    // task.trackerId can be a single string or an array — normalise, then
    // map each 6-hex device id to a combined uint32 with src code 0
    // (placeholder; upgraded on first matching packet in pickStickyPrimary).
    const configuredIds: FlarmID[] = typeof task.trackerId === 'string' ? [task.trackerId as FlarmID] : ((task.trackerId ?? []) as FlarmID[]);
    const glider: Aircraft = {
        compno: task.compno,
        className: task.className,
        trackers: configuredIds.map((id) => packFlarmId(fidFromFlarm(id), 0)),
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
    const dedupedIds = [...new Set(trackerList)] as FlarmID[];
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
    const channelName = task.channelName as ChannelName;
    if (!channels[channelName]) {
        channels[channelName] = new BroadcastChannel(channelName);
    }
    glider.channel = channels[channelName];
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
    // Aircraft reference so flushLoads can bump streamsSeen for the
    // backfilled records — the per-aircraft tally that drives
    // /status/trackers should reflect history loaded from pointlog as
    // well as live packets.
    aircraft: Aircraft;
}

async function flushLoads() {
    loadTimer = null;
    const batch = pendingLoads;
    pendingLoads = [];
    if (batch.length === 0) return;

    // Build 24-bit-fid → [target] map. One flarm ID can map to multiple
    // gliders if two pilots share a tracker (rare but supported by the
    // existing trackers[id].aircraftList structure). Pointlog yields a
    // combined StreamId; we look up by 24-bit device identity (src is for
    // downstream stream-disambiguation, not for the routing decision).
    const idToTargets = new Map<number, LoadTarget[]>();
    const allIds = new Set<string>();
    let minSince = Infinity;
    for (const b of batch) {
        if (b.since < minSince) minSince = b.since;
        const target: LoadTarget = {queue: b.queue, compno: b.glider.compno, since: b.since, airfield: b.glider.airfield, aircraft: b.glider};
        for (const id of b.flarmIds) {
            allIds.add(id);
            const fid24 = fidFromFlarm(id);
            const existing = idToTargets.get(fid24);
            if (existing) existing.push(target);
            else idToTargets.set(fid24, [target]);
        }
    }

    const startMs = Date.now();
    let yielded = 0;
    let dispatched = 0;

    try {
        for await (const raw of loadPointsForIds({flarmIds: allIds, since: minSince})) {
            yielded++;
            const targets = idToTargets.get((raw.f & 0xffffff) >>> 0);
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
                bumpStreamSeen(target.aircraft, raw.f, raw.t as Epoch);
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
        const tracker = trackers[combinedToHex6(t) as FlarmID];
        if (!tracker) return;
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
        const key = combinedToHex6(t) as FlarmID;
        const tracker = trackers[key];
        if (!tracker) return;
        tracker.aircraftList = tracker.aircraftList.filter((a) => a.channel != toRemove.channel || a.compno != toRemove.compno);
        if (!tracker.aircraftList.length) {
            delete trackers[key];
        }
    });

    clearInterval(toRemove.interval);

    // Remove the glider details
    delete allAircraft[makeClassname_Compno(task)];
    console.log(`APRS: stop tracking ${task.className}/${task.compno} ids: ${toRemove.trackers.map(fidLabel).join(',')}`);
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
    // The trackers[] map is still keyed by 6-hex device identity (same
    // FLARM device through any relay path is the same configured tracker
    // for a pilot). The stream identifier we hand to the fusion pipeline
    // is the combined uint32 — same 6-hex but a different protocol
    // (OGFLR vs OGNAVI vs OGNTRK …) means a different upload pipeline
    // (e.g. radio gateway vs. Naviter cloud relay), with different
    // latency and accuracy characteristics, so it lands in its own
    // stickyPrimary bucket. The 3-char SRC prefix (FLR/ICA/OGN/…) is
    // just the device's address-type namespace and is deliberately NOT
    // used here.
    const sourceCallsign = packet.sourceCallsign ?? '';
    const flarmId = sourceCallsign.slice(-6) as FlarmID;
    // OGN-Delay pipeline keeps the original dstcall (e.g. OGNTRK) but
    // stamps OGNDELAY* into the digipeater path and gates the q-construct
    // via DLY2APRS. Same physical device but a very different upload
    // pipeline — synthesise the OGNDLY proto code so direct and delayed
    // streams land in their own stickyPrimary buckets.
    const isDelayed = packet.digipeaters?.some((d) => d.callsign === 'OGNDELAY' || d.callsign === 'DLY2APRS') ?? false;
    const protoCode = isDelayed ? protoCodeFor('OGNDLY') : protoCodeFor(packet.destCallsign);
    const fCombined = packFlarmId(fidFromFlarm(flarmId), protoCode);

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
        f: fCombined,
        o: sender,
        l: null,
        d: td,
        ad: airfieldDistance
    };

    // Persist every packet, known or unknown. Downstream trackers for any
    // competition can later backfill from the log regardless of whether
    // someone was tracking this flarmid at the time it arrived. Suppressed in
    // readOnly mode (REPLAY_DB / OGN_READ_ONLY) — no write stream is open.
    if (!readOnly) appendPoint(message);

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
        bumpStreamSeen(aircraft, fCombined, perAircraftMessage.t);
    }
}

// Maintain the per-aircraft (StreamId → count + lastT) tally that backs
// the /status/trackers snapshot. Updated as packets land in the
// aircraft's queue — captures every stream that has produced at least
// one fix for this pilot, independent of whether it's currently trusted
// or used by pickStickyPrimary.
function bumpStreamSeen(aircraft: Aircraft, f: StreamId, t: Epoch): void {
    if (!aircraft.streamsSeen) aircraft.streamsSeen = new Map();
    const cur = aircraft.streamsSeen.get(f);
    if (cur) {
        cur.count++;
        if (t > cur.lastT) cur.lastT = t;
    } else {
        aircraft.streamsSeen.set(f, {count: 1, lastT: t});
    }
}

//

// stickyPrimary picker constants. STICKY_GAP_FILL_S mirrors the
// GAP_FILL_THRESHOLD_S in lib/fusion/stickyPrimary.ts (the offline
// reference). STICKY_OFFSET_WINDOW is the running-median window for
// per-secondary-flarmid offset estimation; the bake-off used 1:1 matched
// pairwise samples and median over all available pairs, but in the
// streaming path we don't keep the full history, so a 64-sample circular
// buffer is the memory-bounded equivalent. STICKY_MIN_PAIRS gates
// whether to apply offset correction at all — below this we emit
// secondary records uncorrected (preferring "raw secondary" to
// "ill-estimated offset").
const STICKY_GAP_FILL_S = 15;
const STICKY_OFFSET_WINDOW = 64;
const STICKY_MIN_PAIRS = 5;

function speedSanityOk(point: InterimPositionMessage, lastSent: InterimPositionMessage): boolean {
    const dT = point.t - lastSent.t;
    if (dT <= 0) return false;
    const dH_km = distHaversine(point, lastSent);
    const dV = point.a - lastSent.a;
    const dSH = (3600 * dH_km) / dT;
    const dSV = Math.abs(dV / dT);
    return dSH < (point.s || 160) * 2.3 && dSV < 30;
}

export function medianOf(xs: number[]): number {
    if (xs.length === 0) return 0;
    const sorted = xs.slice().sort((a, b) => a - b);
    const m = sorted.length;
    return m % 2 === 0 ? (sorted[m / 2 - 1] + sorted[m / 2]) / 2 : sorted[(m - 1) / 2];
}

// Median absolute deviation — robust scale estimate. MAD ≈ 0.67 × stdev
// for normal data, but one bad sample doesn't move it (whereas it
// dominates max-min spread for the full window length). Used to decide
// whether a secondary's offset against primary is stationary (low MAD,
// keep) or drifting (high MAD, untrust the secondary for the session).
export function madOf(xs: number[]): number {
    if (xs.length === 0) return 0;
    const med = medianOf(xs);
    const dev = xs.map((x) => Math.abs(x - med));
    return medianOf(dev);
}

export function pushOffsetSample(state: FlarmOffsetState, dLat: number, dLng: number, dAlt: number): void {
    const i = state.cursor;
    if (state.count < STICKY_OFFSET_WINDOW) {
        state.dLats.push(dLat);
        state.dLngs.push(dLng);
        state.dAlts.push(dAlt);
        state.count++;
    } else {
        state.dLats[i] = dLat;
        state.dLngs[i] = dLng;
        state.dAlts[i] = dAlt;
    }
    state.cursor = (i + 1) % STICKY_OFFSET_WINDOW;
}

function getOrInitOffset(aircraft: Aircraft, f: StreamId): FlarmOffsetState {
    if (!aircraft.flarmOffsets) aircraft.flarmOffsets = new Map();
    let s = aircraft.flarmOffsets.get(f);
    if (!s) {
        s = {dLats: [], dLngs: [], dAlts: [], cursor: 0, count: 0};
        aircraft.flarmOffsets.set(f, s);
    }
    return s;
}

// Per-secondary discrepancy log. We track which secondary streams are
// currently *over* a position-offset threshold against the primary —
// flipping into / out of that state emits one log line per transition.
// Reason for the latch: the offset is recomputed every primary co-occurrence
// (every few seconds), so without it a sustained mis-registered secondary
// would spam every bucket.
const STICKY_OFFSET_LOG_LAT_M = 150;
const STICKY_OFFSET_LOG_ALT_M = 50;
const METERS_PER_DEG_LAT = 111_111;

// Correlation-quality gate. MAD threshold above which a secondary is
// presumed not to be tracking the primary at all (e.g. a Naviter device
// left at the airfield while the FLR flies the task — offsets grow with
// every co-occurrence, producing a large MAD). Tighter than the
// discrepancy-log threshold because the elimination is sticky for the
// session; once latched the secondary is excluded from gap-fill until
// the aircraft entry is rebuilt (new datecode).
const STICKY_TRUST_MIN_SAMPLES = 20;
const STICKY_TRUST_REJECT_LAT_M = 50;
const STICKY_TRUST_REJECT_LNG_M = 50;
const STICKY_TRUST_REJECT_ALT_M = 30;

export function checkSecondaryOffset(aircraft: Aircraft, secF: StreamId, state: FlarmOffsetState, primaryF: StreamId, lat: number): void {
    if (state.count < STICKY_MIN_PAIRS) return;
    const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
    const mLat = medianOf(state.dLats);
    const mLng = medianOf(state.dLngs);
    const mAlt = medianOf(state.dAlts);
    const dLat_m = Math.abs(mLat * METERS_PER_DEG_LAT);
    const dLng_m = Math.abs(mLng * METERS_PER_DEG_LAT * cosLat);
    const dAlt_m = Math.abs(mAlt);
    const over = dLat_m > STICKY_OFFSET_LOG_LAT_M || dLng_m > STICKY_OFFSET_LOG_LAT_M || dAlt_m > STICKY_OFFSET_LOG_ALT_M;
    if (over && !state.loggedOver) {
        state.loggedOver = true;
        console.log(
            `aprs: stream offset ${aircraft.className}/${aircraft.compno} primary=${fidLabel(primaryF)} secondary=${fidLabel(secF)} dLat=${dLat_m.toFixed(0)}m dLng=${dLng_m.toFixed(0)}m dAlt=${dAlt_m.toFixed(0)}m (n=${state.count})`
        );
    } else if (!over && state.loggedOver) {
        state.loggedOver = false;
        console.log(`aprs: stream offset cleared ${aircraft.className}/${aircraft.compno} primary=${fidLabel(primaryF)} secondary=${fidLabel(secF)} (n=${state.count})`);
    }
    if (state.untrusted) return;
    if (state.count < STICKY_TRUST_MIN_SAMPLES) return;
    const madLat_m = madOf(state.dLats) * METERS_PER_DEG_LAT;
    const madLng_m = madOf(state.dLngs) * METERS_PER_DEG_LAT * cosLat;
    const madAlt_m = madOf(state.dAlts);
    if (madLat_m > STICKY_TRUST_REJECT_LAT_M || madLng_m > STICKY_TRUST_REJECT_LNG_M || madAlt_m > STICKY_TRUST_REJECT_ALT_M) {
        state.untrusted = true;
        recordUncorrelatedTracker(aircraft, primaryF, secF, madLat_m, madLng_m, madAlt_m, state.count);
    }
}

// Emit one log line + a parent-thread message so bin/ogn.ts can record
// the rejection in trackerhistory. We don't write to the DB from the
// worker — it doesn't hold a mysql handle.
function recordUncorrelatedTracker(aircraft: Aircraft, primaryF: StreamId, secF: StreamId, madLatM: number, madLngM: number, madAltM: number, sampleCount: number): void {
    console.log(
        `aprs: tracker uncorrelated ${aircraft.className}/${aircraft.compno} primary=${fidLabel(primaryF)} secondary=${fidLabel(secF)} madLat=${madLatM.toFixed(0)}m madLng=${madLngM.toFixed(0)}m madAlt=${madAltM.toFixed(0)}m (n=${sampleCount})`
    );
    if (parentPort) {
        parentPort.postMessage({
            type: 'uncorrelated',
            compno: aircraft.compno,
            className: aircraft.className,
            datecode: aircraft.datecode,
            primary: primaryF,
            secondary: secF,
            madLatM,
            madLngM,
            madAltM,
            sampleCount
        } satisfies UncorrelatedTrackerEvent);
    }
}

// Within one flarmid's bucket, dedup receiver duplicates. Two stations
// hearing the same FLARM transmission produce byte-identical records;
// the speed sanity filter doesn't differentiate them. Pick deterministically
// (prefer same `o` as lastSent for stability, else first by `o` sort).
function pickWithinFlarmid(bucket: InterimPositionMessage[], lastSent: InterimPositionMessage | undefined): InterimPositionMessage | undefined {
    if (bucket.length === 0) return undefined;
    if (bucket.length === 1) return bucket[0];
    const lastO = lastSent?.o;
    if (lastO) {
        const match = bucket.find((b) => b.o === lastO);
        if (match) return match;
    }
    return bucket.slice().sort((a, b) => (a.o ?? '').localeCompare(b.o ?? ''))[0];
}

function pickStickyPrimary(
    aircraft: Aircraft, //
    duplicates: InterimPositionMessage[],
    lastSent: InterimPositionMessage | undefined,
    t: Epoch
): InterimPositionMessage | undefined {
    // Group by combined stream id. In the single-stream case the byFlarm
    // map has one entry and we fall through to "pick from primary bucket"
    // trivially. Different src prefixes for the same 6-hex are different
    // streams here (different GPS chip, different bucket).
    const byFlarm = new Map<StreamId, InterimPositionMessage[]>();
    for (const p of duplicates) {
        let g = byFlarm.get(p.f);
        if (!g) {
            g = [];
            byFlarm.set(p.f, g);
        }
        g.push(p);
    }

    let primaryFlarmid: StreamId | undefined = aircraft.trackers[0];
    // Configured trackers start with high byte 0 (we knew the 6-hex but
    // not the src that would actually report). On first match, upgrade
    // the placeholder to the actual combined value so subsequent equality
    // tests against bucket keys are direct.
    if (primaryFlarmid !== undefined && primaryFlarmid >>> 24 === 0) {
        const fid24 = primaryFlarmid & 0xffffff;
        for (const f of byFlarm.keys()) {
            if ((f & 0xffffff) === fid24) {
                primaryFlarmid = f;
                aircraft.trackers[0] = f;
                break;
            }
        }
    }
    const primaryBucket = primaryFlarmid !== undefined ? byFlarm.get(primaryFlarmid) : undefined;

    // If primary is present in this bucket: pick from it, opportunistically
    // collect offset samples from any secondaries co-occurring at the same t.
    if (primaryBucket && primaryBucket.length > 0) {
        const picked = pickWithinFlarmid(primaryBucket, lastSent);
        if (!picked) return undefined;
        if (lastSent && !speedSanityOk(picked, lastSent)) return undefined;
        aircraft.lastPrimaryTime = t;
        // Update per-secondary offset estimates: each secondary record at
        // the same t against the just-picked primary record is one sample.
        for (const [f, bucket] of byFlarm) {
            if (f === primaryFlarmid) continue;
            const sec = pickWithinFlarmid(bucket, lastSent);
            if (!sec) continue;
            const state = getOrInitOffset(aircraft, f);
            pushOffsetSample(state, sec.lat - picked.lat, sec.lng - picked.lng, sec.a - picked.a);
            checkSecondaryOffset(aircraft, f, state, primaryFlarmid!, picked.lat);
        }
        return picked;
    }

    // Primary absent from this bucket. Only emit a secondary if the
    // primary has been silent long enough that we're really in a gap.
    const sincePrimary = aircraft.lastPrimaryTime != null ? t - aircraft.lastPrimaryTime : Infinity;
    if (sincePrimary <= STICKY_GAP_FILL_S) {
        // Still inside the primary's coverage — don't pollute with secondary GPS noise.
        // BUT if we have never seen primary at all (lastPrimaryTime undefined → Infinity
        // → skip this branch), we DO fall through to picking a secondary so the session
        // can bootstrap. That handles cases where the primary is silent for the day
        // (operator switched to backup device).
        return undefined;
    }

    // Gap-fill: pick the densest secondary bucket. Skip any stream whose
    // MAD gate has latched it as untrusted (offset against primary isn't
    // stationary — e.g. a Naviter device left at the airfield). Once
    // latched, the stream stays out for the aircraft's session.
    let bestF: StreamId | undefined;
    let bestBucket: InterimPositionMessage[] | undefined;
    for (const [f, bucket] of byFlarm) {
        if (f === primaryFlarmid) continue; // primary already handled (absent here)
        if (aircraft.flarmOffsets?.get(f)?.untrusted) continue;
        if (!bestBucket || bucket.length > bestBucket.length) {
            bestF = f;
            bestBucket = bucket;
        }
    }
    if (bestF === undefined || !bestBucket) return undefined;
    const picked = pickWithinFlarmid(bestBucket, lastSent);
    if (!picked) return undefined;
    // Apply offset correction if we have enough samples for this secondary.
    const offsetState = aircraft.flarmOffsets?.get(bestF);
    let emitted = picked;
    if (offsetState && offsetState.count >= STICKY_MIN_PAIRS) {
        emitted = {
            ...picked,
            lat: picked.lat - medianOf(offsetState.dLats),
            lng: picked.lng - medianOf(offsetState.dLngs),
            a: picked.a - medianOf(offsetState.dAlts)
        };
    }
    if (lastSent && !speedSanityOk(emitted, lastSent)) return undefined;
    return emitted;
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

        // stickyPrimary picker. For pilots with one flarmid this collapses
        // to exact (f, t) dedup. For pilots with multiple flarmids it picks
        // the canonical primary (aircraft.trackers[0]) when present and only
        // falls back to a secondary when the primary has been silent for
        // longer than STICKY_GAP_FILL_S. Secondaries are offset-corrected
        // against the primary using a running per-flarmid median. Reference:
        // lib/fusion/stickyPrimary.ts (batch variant, validated by the
        // offline bake-off; this is the streaming-per-bucket equivalent).
        //
        // Speed sanity filter (>300 kph horizontal or >30 m/s vertical jump
        // from lastSent) is retained — it catches GPS glitches independent
        // of the dedup decision.
        const point = pickStickyPrimary(aircraft, duplicates, lastSent, t as Epoch);
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
        const pickedDH_m = distHaversine(point, lastSent) * 1000;
        const pickedDG = point.g - lastSent.g;
        const noMovement = pickedDH_m < 5 && Math.abs(pickedDG) < 3;

        // We haven't picked one because we have had no movement but we have had packets.
        // Note: aircraft.lastMoved starts at 0 and is only set once the glider actually
        // moves, so leaving it un-gated lets stationaryTime evaluate to a huge epoch
        // value on the first stationary detection. That's intentional — it arms the
        // ground state immediately for gliders that were already parked when the
        // session started.
        const stationaryTime = noMovement ? point.t - aircraft.lastMoved : 0;

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
