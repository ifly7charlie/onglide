#!/usr/bin/env node

// Copyright 2020-2024 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {initialiseInsights, trackMetric, trackAggregatedMetric} from '../lib/insights';

import http from 'node:http';
import https from 'node:https';

import {readFileSync, existsSync, createWriteStream} from 'fs';

import {computeSunset} from '../lib/util/sunset';
import {gitVersion} from '../lib/util/gitVersion';

// Helper function
//import distance from '@turf/distance';
import {point} from '@turf/helpers';

// And the Websocket
import {WebSocket, WebSocketServer} from 'ws';
import type {IncomingMessage} from 'http';

import {OnglideWebSocketMessage, Positions, PilotPosition, ClassScoreHistory, PilotScore, CompetitionSummary, CompetitionClassStatus, ClassWinner} from '../lib/protobuf/onglide';

import {setTimeout as setTimeoutPromise} from 'timers/promises';

// DB access
import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';

// Add points to the deck structures
import {mergePoint, initialiseDeck} from '../lib/flightprocessing/incremental';

// Figure out what the task is and make GeoJSONs of it
import {calculateTask, taskGeoJSON} from '../lib/flightprocessing/taskhelper';
import {taskBbox, unionBboxes, expandBbox, buildAprsFilter, Bbox} from '../lib/flightprocessing/taskBbox';

// Datecode helpers
import {fromDateCode, toDateCode, competitionStartTs} from '../lib/datecode';

// Display-status derivation shared with the front-end (JSX-free entry point).
import {classDisplayStatus, type CompetitionDisplayStatus} from '../lib/competition-display-status';

// Web Push notifications for competition status changes (daemon-only module).
import {initPushNotifications, notifyCompetitionDelta, sweepDeferredStarts, sweepExpiredSubscriptions} from './lib/pushNotifications';

// Reserved channel name for the global "all competitions" feed used by the
// landing page. Lowercase so it cannot collide with a real `{className}{datecode}`
// channel (those are upper-cased alphanumeric — see channelName()).
const COMPETITIONS_CHANNEL = 'all';

// Shared device-database loader (OGN + FlarmNet)
import {loadMergedDDB, isBlocked, blockedMethod, gliderEquivalent, DDBEntry as SharedDDBEntry} from '../lib/ddb';

// Message passed from the AprsContest Listener
import {PositionMessage, TasksTableRow, TaskLegsTableRow, ClassesTableRow, ContestDayTableRow, DistanceKM, FLEW_STATES, CompStatus} from '../lib/types';
const dev = process.env.NODE_ENV == 'development';
console.log('dev mode', dev);

let db: ReturnType<typeof mysql>;

import {sortedIndexBy, sortedIndexNumber} from '../lib/util/binarySearch';
import {safeEncode} from '../lib/util/proto';
import {roundedUint32, clampUint32, clampInt32} from '../lib/protobuf/wireScaling';
import {computeCompStatus} from '../lib/util/computeCompStatus';
import {scoreChanged} from '../lib/flightprocessing/scoreChanged';
import equal from 'fast-deep-equal';

// Mutate arr in place by removing all elements matching pred, returning the removed elements
// in their original order. Iterates back-to-front so splices don't shift unvisited indices.
function removeInPlace<T>(arr: T[], pred: (x: T) => boolean): T[] {
    const removed: T[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
        if (pred(arr[i])) {
            removed.unshift(arr[i]);
            arr.splice(i, 1);
        }
    }
    return removed;
}

// Launch our listener
import {AprsController, AirfieldSpec} from '../lib/webworkers/aprs';

import {webPathBaseTimeDuration, scoreChunkSize, FINISHING_ETA_MINUTES, LAUNCHING_TRACKED_FRACTION, LAUNCHING_TOTAL_FRACTION, HOME_OGN_COVERAGE} from '../lib/constants';

import {createHash, randomBytes, createHmac} from 'crypto';

// Communication with the workers
import {BroadcastChannel} from 'node:worker_threads';
let aprsController: AprsController | undefined;

// The authoritative list of airfields known to the APRS worker. The filter
// rebuild walks this to add per-airfield radius fallbacks so pre-task
// ground traffic is still heard, and it's kept in lockstep with the
// worker via setAirfields(). PR 5 extends this to multi-comp.
let currentAirfields: AirfieldSpec[] = [];
function setAirfields(airfields: AirfieldSpec[]) {
    currentAirfields = airfields;
    aprsController?.setAirfields(airfields);
}

// Data sources

import * as dotenv from 'dotenv';

// Handle fetching elevation and confirming size of the cache for tiles
import {getElevationOffset, getCacheSize, shutdownElevationCache} from '../lib/getelevationoffset';

// handle unkownn gliders
import {capturePossibleLaunchLanding} from '../lib/flightprocessing/launchlanding';

import {dateToText} from '../lib/flightprocessing/timehelper';

import {Epoch, Datecode, Compno, FlarmID, ClassName, ClassName_Compno, makeClassname_Compno, ChannelName, Task, DeckData, AirfieldLocation, PositionStatus} from '../lib/types';
import {ScoringController} from '../lib/webworkers/scoring';

import Stats from 'stats-incremental';

let userLogStream: WriteStream | null = null;

let scoreFrequency = 60;

process.setMaxListeners(35);

// Per-competition state. Channels, gliders, and the APRS worker
// remain process-wide, but everything that varies across comps — location,
// timezone, internal name, the set of channel keys this comp owns — lives
// in a CompetitionContext. PR 4 restructures but stays single-comp; PR 5
// walks this map to support multiple concurrent comps.
interface CompetitionMetadata {
    name: string;
    sitename: string | null;
    countrycode: string;
    mainwebsite: string | null;
    urllogo: string | null;
    lat: number;
    lng: number;
    start: string; // YYYY-MM-DD
    end: string; // YYYY-MM-DD
    tz: string;
    tzoffset: number;
    officialDelay: number; // seconds; resolved from competition.delayseconds or env-var fallback
    compgroup: string | null; // optional group key; restricts visibility on the /all/<group> feed
}

interface CompetitionContext {
    compid: string;
    internalName: string;
    location: AirfieldLocation;
    // Per-comp clock bound to location.officialDelay. Used for anything
    // emitted on a per-comp websocket (keepalive `at`, positions broadcast
    // `t`, etc.) so the frontend's notion of "now" tracks the delayed data
    // stream. Lives on the context (not on location) because location is
    // shipped to scoring workers via structured clone, which can't carry
    // function values. Rebuilt by reconcileContexts when delay changes.
    getNow: () => Epoch;
    ownedChannels: Set<ChannelName>;
    unknownChannel?: BroadcastChannel;
    lastDatecode?: Datecode;
    state: 'starting' | 'running' | 'stopping' | 'stopped';
    // 'Y' if the comp has obtained explicit livetracking consent from
    // pilots; bypasses the DDB Permit-Livetracking block.
    trackingconsent?: string;
    summary: CompetitionMetadata;
}

const contexts: Record<string, CompetitionContext> = {};

// Compids whose context couldn't be built on a previous reconcile tick —
// either the coords were missing/bogus, or createCompetitionContext threw.
// Tracked here so the 60s tick doesn't spam the same failure line over
// and over; cleared the moment the comp successfully gets a context.
const failedCompsLogged = new Set<string>();

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
    compid: string;
    classname: string; // human-readable class name (e.g. "Open", "Standard")
    datecode: Datecode;

    // Mirror of compstatus row + pilot count — fed into the /all
    // CompetitionsList feed without re-querying the DB.
    compStatus: string; // raw compstatus.status (L/S/H/F/B/P/G/'')
    statusDatecode: Datecode | null; // compstatus.datecode
    classHandicapped: string; // raw classes.handicapped column ('Y'/'N'/'D'/'') — used pre-task to populate /all TaskRules.handicapped
    pilotCount: number;

    toSend: PositionMessage[]; // messages waiting to be sent

    activeGliders: Set<Compno>; // map of active compno
    lastSentPositions: Epoch; // last time a positio message (empty of contents)n was sent comp time
    clients: OgnWebSocket[]; // all websockets for the channel

    broadcastChannel?: BroadcastChannel;
    scoring?: ScoringController;
    task?: Task; // what task are we scoring - we use this to see if anything has changed
    geoTask?: any;
    gliderHash?: string;

    lastKeepAliveMsg?: any;

    statistics: Statistics;
    heightStatistics: any;

    // Sticky once true — sunset only happens once per channel lifetime (new datecode = new channel)
    afterSunset: boolean;

    // True while we are actively listening to APRS for at least one glider on
    // this channel (not after sunset, day still being scored). Recomputed each
    // updateTrackers tick and shipped to the frontend via getIdentifiers.
    live: boolean;

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

    // For the web buffer
    webPathBaseTime: Epoch;
    webPathData: Record<string, Buffer>;
    mostRecentPosition: Epoch; // last time we had something to send
    tracksBroadcastRequired: boolean;

    // Sending helpers
    sendBinary: (data: Uint8Array) => void;
}

let channels: Record<ChannelName, Channel> = {};

// Last-emitted channels-summary string per compid so updateClasses only logs
// the inventory line when it actually changes.
const lastChannelsLog = new Map<string, string>();

// Last-emitted "Channels not yet scored" string so we only log when the pending
// set changes, instead of on every score arrival.
let lastPendingChannelsLog: string | null = null;

// Filter for channels the scoring worker will eventually emit a `_live` for —
// the wait gate and pendingChannels check must exclude channels that have no
// task or no configured pilots, otherwise they'd never clear and the gate
// would spin forever.
const channelNeedsScoring = (c: Channel) => !!c.task && c.pilotCount > 0;

// Clients connected to the reserved /all channel — landing-page globe.
// Kept separate from the per-class channels[] so iteration over per-class
// state (position broadcasts, keepalive, stats) stays untouched.
let competitionsListeners: OgnWebSocket[] = [];

// Flipped by handleExit before the per-comp teardown fan-out, suppresses
// the `removed` /all broadcast in destroyCompetitionContext. Without this
// a graceful shutdown wipes every comp from connected clients before the
// socket actually closes — the user reconnects to the new daemon already
// staring at an empty "can't find competition" overlay.
let shuttingDown = false;

// Maintained set of current per-comp CompetitionSummary objects, keyed by
// compid. broadcastCompetitionsDelta rebuilds an entry whenever a comp
// changes; the /all snapshot sent to a joining client is built straight from
// this map (see encodeCompetitionsSnapshot) instead of re-walking contexts on
// every connect. It also drives no-op suppression — an identical rebuilt
// summary never reaches the wire.
const competitionSummaries = new Map<string, CompetitionSummary>();

// Encoded /all snapshot, keyed by listener group ('' = bare /all). Built on
// first connect for a group, then rebuilt in place by broadcastCompetitionsDelta
// on every comp change — so a joining client always reads a ready, current
// frame and a burst of connects right after a delta never each re-encode.
const competitionsSnapshotCache = new Map<string, Uint8Array | null>();

// Comps that exist in the DB but haven't started yet (and have no task wired
// up). They get no scoring/tracker infrastructure, but the landing-page
// globe still shows them with displayStatus='upcoming'. Refreshed on every
// reconcile tick — see refreshUpcomingCompetitions().
const upcomingComps: Record<string, CompetitionMetadata & {classnames: string[]}> = {};
/*EG: { 'PMSRMAM202007I': { className: 'blue', clients: [], datecode: '070' },
                    'PMSRMAM202007H': { className: 'red', clients: [], datecode: '070' },
                    }; */

interface Glider {
    compno: Compno;
    className: ClassName;
    compid: string;
    channelName: ChannelName;

    flarmIdRegex: RegExp;

    greg: string;
    glidertype: string;
    handicap: number;
    dbTrackerId: string;
    datecode: Datecode;
    utcStart: Epoch;
    scoredStart: Epoch;
    scoredFinish: Epoch;
    scoredStatus: 'S' | 'F' | 'H'; // from scoring
    scoringConfigured?: boolean;
    // True if dbTrackerId === 'blocked' on the last tick. We never send blocked
    // pilots to the scoring worker, so flipping back to unblocked has to reset
    // scoringConfigured so setInitialTrack runs on the next tick.
    blocked?: boolean;

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

// DDB entry shape — see lib/ddb for the merged (OGN + FlarmNet) loader.
type DDBEntry = SharedDDBEntry;
let ddb: Record<string, DDBEntry> = {};

interface OgnWebSocket extends WebSocket {
    ognChannel: ChannelName;
    ognPeer: string;
    // Group filter for /all/<group> listeners; null = bare /all (sees every comp).
    ognGroup?: string | null;
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

import {getNow, getDelay, makeGetNow, readOnly, replayBase, d, getReplayDatecode} from '../lib/now';

// Per-channel "now" — lags real time by the comp's officialDelay so the
// keepalive's `at`, the positions message `t`, and per-channel score
// timestamps all match the delayed data stream. Falls back to the global
// clock for channels whose comp context has gone (cleanup paths) or for
// pre-context emission. See CompetitionContext.getNow for the bound closure.
function channelNow(channel: Channel): Epoch {
    return contexts[channel.compid]?.getNow?.() ?? getNow();
}

// Bind a server to its port, retrying on EADDRINUSE so a freshly-started
// daemon can sit waiting for an outgoing one to release the port. Any
// other listen error (EACCES, etc.) is fatal — those are config problems,
// not deploy races. Resolves once `listening` fires.
async function listenWithRetry(server: http.Server | https.Server, port: number, label: string) {
    while (true) {
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (e: NodeJS.ErrnoException) => {
                    server.off('listening', onListening);
                    reject(e);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port);
            });
            return;
        } catch (e: any) {
            if (e?.code !== 'EADDRINUSE') throw e;
            console.log(`${label}: port ${port} in use, waiting for previous process to release it…`);
            await setTimeoutPromise(5000);
        }
    }
}

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
            password: process.env.MYSQL_PASSWORD,
            decimalNumbers: true,
            // Return DATE / DATETIME / TIMESTAMP columns as strings so they
            // match our `: string` type declarations and survive proto
            // encoding (the encoder rejects Date instances).
            dateStrings: true,
            // Disable CLIENT_FOUND_ROWS so UPDATE.affectedRows counts
            // rows actually changed, not rows matched. Several callers
            // depend on that (e.g. updateTracker, pilotresult upserts).
            flags: ['-FOUND_ROWS']
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

    scoreFrequency = Number(process.env.OGN_SCORE_FREQUENCY ?? 60);

    // Allow insights if it's configured.
    // DON'T TRACK DEPENDENCIES as it will pick up SQL statements
    // and we do a LOT of them
    initialiseInsights();

    // Arm Web Push (no-op if VAPID keys are not configured).
    initPushNotifications();
    if (readOnly) console.log('pushNotifications: readOnly mode (REPLAY_DB / OGN_READ_ONLY) — status notifications are suppressed');

    console.log('Onglide OGN handler', readOnly ? '(read only)' : '', process.env.NEXT_PUBLIC_SITEURL);
    console.log(`db ${process.env.MYSQL_DATABASE} on ${process.env.MYSQL_HOST}`);

    // Download the list of trackers so we know who to look for. The DDB is
    // global across comps.
    await updateDDB();

    // One APRS worker for the whole process. Airfields are added by
    // createCompetitionContext as each competition starts.
    aprsController = new AprsController({airfields: []});

    // Wait until we can see at least one competition before we start the
    // web server. After that the discovery loop runs on the 60s tick and
    // adds or removes comps as the DB changes.
    while (Object.keys(contexts).length === 0) {
        await reconcileContexts();
        if (Object.keys(contexts).length === 0) {
            console.log('waiting for an eligible competition to appear in the database');
            await setTimeoutPromise(60000);
        }
    }
    // Phase 1: load classes + cached scores per comp. updateClasses is
    // fast — it opens leveldb, iterates cached PilotScore records into
    // channel.allScores, and spawns the (idle) scoring worker. Then
    // rebuildAprsFilter() emits an airfield-only filter (no channel has a
    // task yet) so the APRS listener starts receiving packets in the
    // airfield radii immediately, instead of waiting for the slower
    // tracker/task DB work in Phase 3.
    const phase1: {ctx: CompetitionContext; datecode: Datecode}[] = [];
    for (const c of Object.values(contexts)) {
        const datecode = await tickCompetitionClasses(c);
        if (datecode !== null) phase1.push({ctx: c, datecode});
    }
    rebuildAprsFilter();

    // Open an append-mode log shared across all comps for the lifetime of
    // the process. Filename uses the first active comp's datecode for
    // continuity with the old single-comp layout.
    {
        const first = Object.values(contexts)[0];
        const datecode = await getDCode(first);
        userLogStream = createWriteStream(`${process.env.DB_PATH ?? './db/'}user-log.${first.internalName}-${datecode}.txt`, {flags: 'a'});
    }

    // Phase 3: load trackers + tasks per comp, then rebuild the APRS
    // filter so it picks up task bboxes. The rebuild's lastAprsFilter
    // memo no-ops if the filter string is unchanged. Runs before the
    // listener opens so a client's first /all snapshot is built from a
    // fully-populated `contexts` — without this guarantee a reconnect
    // mid-Phase-3 would deliver a partial snapshot and the client's
    // wipe-and-rebuild would drop comps the user is actively viewing.
    for (const {ctx, datecode} of phase1) {
        await tickCompetitionTrackersAndTasks(ctx, datecode);
    }
    rebuildAprsFilter();

    // Optional rescore gate: don't open the listener until every channel
    // that actually has something to score has a `liveScoreId`. Scoring
    // workers populate this asynchronously after Phase 3 fires their initial
    // task/tracker IPC, so without this wait a /all snapshot taken right
    // after Phase 3 can advertise comps that have no scores yet. Channels
    // without a task or with no configured pilots never receive a `_live`
    // marker, so they must be excluded from the gate.
    if (process.env.WAIT_FOR_RESCORE) {
        const checkScoringNotReady = () => {
            const notReady = Object.values(channels)
                .filter(channelNeedsScoring)
                .filter((c) => !c.liveScoreId);
            if (notReady.length) {
                console.log(`still need ${notReady.map((c) => c.className).join(',')} to finish scoring`);
            }
            return notReady.length > 0;
        };
        while (checkScoringNotReady()) {
            await setTimeoutPromise(1000);
        }

        // Pre-build the per-channel webPathData snapshot so the first client's
        // sendCurrentState doesn't pay the encode cost on the connect await.
        // generateHistoricalTracks is a no-op when mostRecentPosition is 0 or
        // when the snapshot is still fresh.
        for (const channel of Object.values(channels)) {
            await generateHistoricalTracks(channel);
        }
    }

    // Rename the process now that startup is complete — `ps`/`htop` show
    // the renamed entry only for ready instances, which is handy during a
    // rolling deploy where the outgoing and incoming processes coexist.
    process.title = `onglide ${process.env.MYSQL_DATABASE ?? 'unknown'}`;

    // Phase 2: start the websocket/HTTP server. Deferred to here so the
    // port-open signal doubles as a readiness flag — a load balancer (or a
    // second daemon process spun up for a rolling deploy) sees the port as
    // unbound until everything above has finished.
    if ('PM2_HOME' in process.env || existsSync('.docker')) {
        console.log('PM2/DOCKER: starting http(s) listener');
    }

    const hasSSL = (
        await Promise.all(
            [process.env.NEXT_PUBLIC_WEBSOCKET_HOST, process.env.NEXT_PUBLIC_SITEURL].map(async (host) => {
                if (!host) return false;
                let options;
                try {
                    options = {
                        key: readFileSync(`keys/${host}.key.pem`),
                        cert: readFileSync(`keys/${host}.cert.pem`)
                    };
                } catch (e) {
                    console.log(`Unable to initialise SSL "keys/${host}.key.pem"`, e);
                    return false;
                }
                if (!options.key || !options.cert) return false;
                console.log('initialising SSL');
                const sslPort = parseInt(process.env.WEBSOCKET_PORT!) + 1000;
                const server = https.createServer(options, setupOgnWebServer);
                await listenWithRetry(server, sslPort, `SSL ${host}`);
                setupWebSocketServer(server);
                console.log(`listening on [SSL] ${sslPort} ssh key for ${host}`);
                return true;
            })
        )
    ).some(Boolean);

    if (!hasSSL) {
        console.log(`SSL not initialised`);
    }

    // We always open an non-ssl one
    const port = parseInt(process.env.WEBSOCKET_PORT || '8080');
    const server = http.createServer(setupOgnWebServer);
    server.on('clientError', function (ex, _socket) {
        console.log('****> clientError', ex);
    });
    await listenWithRetry(server, port, 'HTTP');
    setupWebSocketServer(server);
    console.log(`Onglide startup ${gitVersion()} listening on ${port}`);

    //
    // This function is to send updated flight tracks for the gliders that have reported since the last
    // time we run the callback (every second), as we only update the screen on data it should
    // be sufficient to bundle them even though we are receiving as a stream.
    //
    // Channels are grouped by compid before encoding so the ClassPositions
    // message sent to each per-class socket only contains sibling classes
    // from its own competition. Without this, comp A's positions would
    // leak to comp B's clients (and vice versa) whenever both are active.
    setInterval(function () {
        const now = getNow();

        const byComp: Record<string, Channel[]> = {};
        for (const ch of Object.values(channels)) {
            (byComp[ch.compid] ??= []).push(ch);
        }

        for (const compChannels of Object.values(byComp)) {
            const positions = compChannels.reduce(
                (a, c: Channel) => {
                    if (c.toSend.length) {
                        a[c.className] = {
                            positions: c.toSend.map(
                                (p): PilotPosition => ({
                                    c: p.c,
                                    lat: p.lat,
                                    lng: p.lng,
                                    a: Math.trunc(p.a),
                                    g: Math.trunc(p.g),
                                    t: Math.max(0, Math.trunc(p.t)),
                                    b: Math.max(0, Math.trunc(p.b ?? 0)),
                                    s: Math.max(0, Math.trunc(p.s ?? 0))
                                })
                            )
                        };
                    }
                    return a;
                },
                {} as Record<string, Positions>
            );

            const compid = compChannels[0]?.compid;
            // Per-comp "now" so the message timestamp matches the delayed
            // position stream — frontend reads this as its current-time
            // reference for staleness / uptodate detection.
            const compNow = contexts[compid]?.getNow?.() ?? now;
            const msg = safeEncode(OnglideWebSocketMessage, {positions: {class: positions}, t: Math.trunc(compNow)}, `positions ${compid}`);

            for (const channel of compChannels) {
                channel.statistics.activeListeners += channel.clients.length;
                channel.statistics.listenerCycles++;

                if (channel.clients.length) {
                    // Throttle sibling-only updates: a channel with no
                    // positions of its own only forwards the comp's
                    // multi-class broadcast every 15s.
                    if (!channel.toSend.length) {
                        if (now - channel.lastSentPositions < 15) continue;
                    } else {
                        // if we sent an actual coordinate then this will ensure
                        // that the webPathData is regenerated
                        channel.mostRecentPosition = now;
                    }

                    // Metrics are helpful
                    channel.statistics.positionsSent += channel.toSend.length;
                    channel.statistics.positionsSentCycles++;
                    // We don't want to send it twice so it can go
                    channel.toSend = [];
                    channel.lastSentPositions = now;

                    // Send to each client and if they don't respond they will be cleaned up next time around
                    if (msg) channel.sendBinary(msg);
                } else {
                    channel.toSend = [];
                }
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
            const notValid = removeInPlace(channel.clients, (client: OgnWebSocket) => {
                return client.isValid === false;
            });

            const closed = removeInPlace(channel.clients, (client: OgnWebSocket) => {
                return client.isClosed === true;
            });

            // Remove any that are still marked as not alive
            const notAlive = removeInPlace(channel.clients, (client: OgnWebSocket) => {
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
                console.log(
                    `${channel.className}: ${notAlive.length} inactive, ${closed.length} closed += ${viewTime}s viewing time, ${notAlive.length ? viewTime / notAlive.length : '-'}s avg, ${notValid.length} notValid`
                );
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

            const activeGliderCount = channel.activeGliders.size;
            const hasPackets = channel.statistics.totalPackets > 0;
            const hasListenerActivity = channel.statistics.activeListeners > 0 || channel.statistics.peakListeners > 0 || channel.statistics.totalViewingTime > 0 || viewTime > 0;
            if (activeGliderCount > 0 || hasPackets || hasListenerActivity) {
                const parts: string[] = [`${activeGliderCount} active gliders`, `${channel.statistics.positionsSent}/${channel.statistics.totalPackets} positions sent`];
                if (channel.statistics.outOfOrderPackets) {
                    parts.push(`${channel.statistics.outOfOrderPackets} ooo`);
                }
                if (hasListenerActivity) {
                    parts.push(
                        `${(channel.statistics.activeListeners / channel.statistics.listenerCycles).toFixed(1)} avg listeners (peak ${channel.statistics.peakListeners.toFixed(0)}, interacting ${(
                            channel.statistics.interactingListeners / channel.statistics.statsCycles
                        ).toFixed(1)}, visible ${(channel.statistics.visibleListeners / channel.statistics.statsCycles).toFixed(1)}, ${Math.round((channel.statistics.totalViewingTime + viewTime) / 60)}m viewing)`
                    );
                }
                console.log(`${channelName}: ${parts.join(', ')}`);
            }

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

    // /all listeners get their own 15s keepalive. Per-class channels
    // already piggyback on the housekeeping tick above; the /all feed
    // is otherwise idle between deltas, so without this the client
    // can't distinguish "no comps changed" from "connection is dead".
    setInterval(broadcastCompetitionsKeepalive, 15 * 1000);

    // Release deferred "started" push notifications whose start-open time has
    // now passed — reuses the 15s cadence rather than a bespoke timer.
    setInterval(() => {
        if (!readOnly) sweepDeferredStarts(getNow, db).catch((e) => console.log('sweepDeferredStarts failed', e));
    }, 15 * 1000);

    //
    // Update competition information - runs discovery to pick up new
    // or finished comps, then ticks every running context, then rebuilds
    // the APRS filter once across all comps.
    setInterval(async function () {
        await reconcileContexts();
        for (const competition of Object.values(contexts)) {
            try {
                await tickCompetition(competition);
            } catch (e) {
                console.error(`tickCompetition(${competition.compid}) failed:`, e);
            }
        }
        rebuildAprsFilter();
        // Safety net: drop push subscriptions for comps that have expired.
        if (!readOnly) await sweepExpiredSubscriptions(db).catch((e) => console.log('sweepExpiredSubscriptions failed', e));
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
    shuttingDown = true;

    // Fan out over every active context so each one gets its full
    // destroy path — reload clients, close broadcast channels, wait
    // for scoring workers to exit, drop channels and gliders from
    // the global maps. destroyCompetitionContext internally awaits
    // the scoring workers with a 5s timeout so a stuck one can't
    // hang the whole shutdown.
    const teardowns = Object.values(contexts).map((c) => destroyCompetitionContext(c).catch((e) => console.error(`destroy(${c.compid}) during exit:`, e)));
    await Promise.allSettled(teardowns);

    // Close the shared resources once no context is holding them open.
    try {
        await aprsController?.shutdown();
    } catch (e) {
        console.error('aprsController shutdown during exit:', e);
    }
    try {
        userLogStream?.end();
    } catch (e) {
        /**/
    }
    try {
        shutdownElevationCache();
    } catch (e) {
        console.error('elevation cache shutdown during exit:', e);
    }
    // Give any flushing I/O a last beat then go.
    setTimeout(() => process.exit(0), 200);
}
main().then(() => console.log('Started'));

// Discover every eligible competition in the database. COMP_ID, if set,
// acts as an optional filter rather than a hard constraint — existing
// single-comp deployments keep their .env.local unchanged and behave
// identically. Multi-comp deployments just omit it. The date window
// opens the day before start and closes two days after end to give
// grace for overnight replay / scoring jobs.
async function discoverCompetitions(): Promise<{active: any[]; upcoming: any[]}> {
    const envCompId = process.env.COMP_ID;

    // Fetch every competition that has at least one class, plus a flag
    // that says whether any class already has a task wired up for its
    // current scoring datecode (the "pre-comp practice day" escape hatch
    // on the start side). Date window filtering is done in TypeScript
    // below so replay mode can bypass it.
    const base = `SELECT c.compid, c.compgroup, c.name, c.sitename, c.countrycode, c.mainwebsite, c.urllogo,
                         c.lt as lat, c.lg as lng, c.tz, c.tzoffset, c.start, c.end, c.flightstats, c.trackingconsent, c.delayseconds,
                         (SELECT COUNT(*)
                          FROM tasks t
                          JOIN compstatus cs ON cs.class = t.class AND cs.datecode = t.datecode
                          JOIN classes cl2 ON cl2.class = t.class
                          WHERE cl2.compid = c.compid AND t.flown = 'Y') AS currentTaskCount
                  FROM competition c
                  WHERE EXISTS (SELECT 1 FROM classes cl WHERE cl.compid = c.compid)`;
    const rows: any[] = envCompId //
        ? await db.query<any[]>(base + ' AND c.compid = ?', [envCompId])
        : await db.query<any[]>(base);

    // Replay mode: wall-clock dates are meaningless (the operator has
    // explicitly set REPLAY to a historical moment), let every comp
    // through. Used to test FE changes and benchmark scoring when no
    // live competition is running.
    if (replayBase > 0) {
        return {active: rows, upcoming: []};
    }

    // Live mode: each comp's date window is evaluated in its own local
    // time (tzoffset is seconds east of UTC, same convention as getDCode).
    // Without this, an evening flight on the last day of a westbound comp
    // could be dropped when DB-server-UTC rolls over, and a morning flight
    // on day 1 of an eastbound comp could be delayed.
    //
    // End is strict: once the last local day is past, the comp is done.
    // Start is strict too, except when the currentTaskCount escape hatch
    // fires (a task is already wired up for today's scoring datecode), in
    // which case it counts as active. Future comps with no task are kept
    // separately so the /all feed can advertise them as 'upcoming' on the
    // landing page without spinning up scoring/tracker infrastructure.
    const ymd = (v: any): string => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'string') return v.slice(0, 10);
        return '';
    };
    const nowUtcMs = Date.now();
    const active: any[] = [];
    const upcoming: any[] = [];
    for (const row of rows) {
        const tzoffset = parseInt(row.tzoffset as unknown as string) || 0;
        const localToday = new Date(nowUtcMs + tzoffset * 1000).toISOString().slice(0, 10);
        const start = ymd(row.start);
        const end = ymd(row.end);
        if (end && end < localToday) continue; // past the end, done
        if (start && start > localToday && (Number(row.currentTaskCount) || 0) === 0) {
            upcoming.push(row);
            continue;
        }
        active.push(row);
    }
    return {active, upcoming};
}

// Walk the discovery result against the current contexts map and start
// or stop contexts to match. Called at startup and from the 60s tick.
async function reconcileContexts() {
    let active: any[];
    let upcoming: any[];
    try {
        const result = await discoverCompetitions();
        active = result.active;
        upcoming = result.upcoming;
    } catch (e) {
        console.error('discoverCompetitions failed:', e);
        return;
    }

    refreshUpcomingCompetitions(upcoming);

    const seen = new Set<string>();
    for (const row of active) {
        const compid = row.compid as string;
        // Skip comps with no usable site coordinates — turf.point() in
        // createCompetitionContext rejects null/undefined, and 0/0 is the
        // geocoder's "I gave up" fallback. We still add the compid to
        // `seen` so an existing context (if somehow already running)
        // isn't torn down just because the coords went transiently bad.
        if (row.lat == null || row.lng == null || (row.lat === 0 && row.lng === 0)) {
            seen.add(compid);
            if (!failedCompsLogged.has(compid)) {
                console.log(`${compid}: skipping — no valid site coordinates (lt=${row.lat} lg=${row.lng})`);
                failedCompsLogged.add(compid);
            }
            continue;
        }
        seen.add(compid);
        if (contexts[compid]) {
            failedCompsLogged.delete(compid);
            const ctx = contexts[compid];
            // Keep summary fields in sync — these are read by buildCompetitionSummary().
            ctx.summary.name = row.name;
            ctx.summary.compgroup = row.compgroup ?? null;
            ctx.summary.sitename = row.sitename ?? null;
            ctx.summary.countrycode = row.countrycode || '';
            ctx.summary.mainwebsite = row.mainwebsite ?? null;
            ctx.summary.urllogo = row.urllogo ?? null;
            ctx.summary.tz = row.tz || ctx.summary.tz;
            ctx.summary.tzoffset = parseInt(row.tzoffset as unknown as string) || ctx.summary.tzoffset;
            const newStart = row.start instanceof Date ? row.start.toISOString().slice(0, 10) : typeof row.start === 'string' ? row.start.slice(0, 10) : ctx.summary.start;
            const newEnd = row.end instanceof Date ? row.end.toISOString().slice(0, 10) : typeof row.end === 'string' ? row.end.slice(0, 10) : ctx.summary.end;
            ctx.summary.start = newStart;
            ctx.summary.end = newEnd;
            const newDelay = (row.delayseconds != null ? Number(row.delayseconds) : (getDelay() as number)) as Epoch;
            const delayChanged = newDelay !== ctx.location.officialDelay;
            const siteMoved = row.lat !== ctx.location.lat || row.lng !== ctx.location.lng;
            if (delayChanged) {
                console.log(`${compShort(compid)}: official delay ${ctx.location.officialDelay}s -> ${newDelay}s`);
                ctx.location.officialDelay = newDelay;
                ctx.getNow = makeGetNow(newDelay);
                ctx.summary.officialDelay = newDelay;
            }
            if (siteMoved) {
                console.log(`${compShort(compid)}: site moved (${ctx.location.lat},${ctx.location.lng}) -> (${row.lat},${row.lng})`);
                ctx.location.lat = row.lat;
                ctx.location.lng = row.lng;
                ctx.summary.lat = Number(row.lat) || 0;
                ctx.summary.lng = Number(row.lng) || 0;
                ctx.location.point = point([row.lng, row.lat]);
                getElevationOffset(row.lat, row.lng, (agl: any) => {
                    ctx.location.altitude = agl;
                });
            }
            if (siteMoved || delayChanged) {
                // Push the airfield into every scoring worker for this comp
                // so sticky landing classifications (Home / Landed / Grid)
                // recompute against the corrected coordinates AND so the
                // worker rebuilds its per-comp getNow from the new delay.
                for (const cname of ctx.ownedChannels) {
                    channels[cname]?.scoring?.setAirfield(ctx.location);
                }
            }
            const newTrackingconsent = row.trackingconsent || 'N';
            if (newTrackingconsent !== ctx.trackingconsent) {
                console.log(`${compShort(compid)}: trackingconsent ${ctx.trackingconsent} -> ${newTrackingconsent}`);
                ctx.trackingconsent = newTrackingconsent;
                // The runtime DDB block (glider.blocked) is sticky across ticks
                // to avoid re-inserting trackerhistory rows; the next updateTrackers
                // tick honours competition.trackingconsent in its blocked-branch
                // gate, so a flip to 'Y' lifts the runtime block on its own.
                // Persisted 'blocked' sentinels in tracker.trackerid (written by
                // matchtrackers) are NOT cleared — re-run matchtrackers to recover.
            }
            continue;
        }
        try {
            await createCompetitionContext(row);
            failedCompsLogged.delete(compid);
        } catch (e) {
            if (!failedCompsLogged.has(compid)) {
                console.error(`createCompetitionContext(${compid}) failed:`, e);
                failedCompsLogged.add(compid);
            }
        }
    }

    for (const compid of Object.keys(contexts)) {
        if (!seen.has(compid)) {
            try {
                await destroyCompetitionContext(contexts[compid]);
            } catch (e) {
                console.error(`destroyCompetitionContext(${compid}) failed:`, e);
            }
        }
    }

    // Push the combined airfield list to the APRS worker in one shot.
    const af: AirfieldSpec[] = Object.values(contexts).map((c) => ({compid: c.compid, lt: c.location.lat, lg: c.location.lng, officialDelay: c.location.officialDelay}));
    setAirfields(af);
    // Rebuild now so airfield-radius fallback clauses pick up any moved
    // sites on this tick instead of waiting for the next minute boundary.
    rebuildAprsFilter();
}

async function createCompetitionContext(row: any): Promise<CompetitionContext> {
    const location: AirfieldLocation = {...row};
    location.point = point([location.lng, location.lat]);
    location.officialDelay = (row.delayseconds != null ? Number(row.delayseconds) : getDelay()) as Epoch;
    location.tzoffset = parseInt(location.tzoffset as unknown as string);

    const ymd = (v: any): string => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'string') return v.slice(0, 10);
        return '';
    };
    const competition: CompetitionContext = {
        compid: row.compid,
        internalName: location.name.replace(/[^a-z]/gi, '').substring(0, 10),
        location,
        getNow: makeGetNow(location.officialDelay),
        ownedChannels: new Set(),
        state: 'starting',
        trackingconsent: row.trackingconsent || 'N',
        summary: {
            name: row.name,
            sitename: row.sitename ?? null,
            countrycode: row.countrycode || '',
            mainwebsite: row.mainwebsite ?? null,
            urllogo: row.urllogo ?? null,
            lat: Number(row.lat) || 0,
            lng: Number(row.lng) || 0,
            start: ymd(row.start),
            end: ymd(row.end),
            tz: row.tz || '',
            tzoffset: parseInt(row.tzoffset as unknown as string) || 0,
            officialDelay: location.officialDelay,
            compgroup: row.compgroup ?? null
        }
    };

    console.log(`${compShort(competition.compid)}: creating competition context (internalName=${competition.internalName})`);

    // Elevation is fetched async; it lands on the context whenever the
    // getElevationOffset callback fires.
    getElevationOffset(location.lat, location.lng, (agl: any) => {
        competition.location.altitude = agl;
        console.log(`${compShort(competition.compid)} site altitude: ${agl}`);
    });

    contexts[competition.compid] = competition;
    return competition;
}

async function destroyCompetitionContext(competition: CompetitionContext) {
    if (competition.state === 'stopped' || competition.state === 'stopping') return;
    const tag = compShort(competition.compid);
    console.log(`${tag}: stopping competition context (${competition.ownedChannels.size} channels)`);
    competition.state = 'stopping';

    // Step 1: notify every client on this comp's channels and drop them
    // so the next position flush doesn't pick them up.
    const ownedCnames = Array.from(competition.ownedChannels);
    for (const cname of ownedCnames) {
        const channel = channels[cname];
        if (!channel) continue;
        console.log(`${tag}/${channel.className}: closing ${channel.clients.length} clients`);
        const clients = channel.clients; // adopt so nothing else tries to deal with them
        channel.clients = [];
        for (const client of clients) {
            try {
                (client as any).close?.();
            } catch (e) {
                /**/
            }
        }
    }

    // Step 2: close each broadcast channel so no more APRS packets land
    // on the scoring workers, then fire the shutdown command at every
    // scoring worker in parallel and wait for them to actually exit.
    // If a worker is stuck the 5-second timeout in ScoringController
    // .shutdown() unblocks us.
    const shutdowns: Promise<void>[] = [];
    for (const cname of ownedCnames) {
        const channel = channels[cname];
        if (!channel) continue;
        try {
            channel.broadcastChannel?.close();
        } catch (e) {
            /**/
        }
        if (channel.scoring) {
            shutdowns.push(channel.scoring.shutdown());
        }
    }
    if (shutdowns.length) {
        console.log(`${tag}: awaiting ${shutdowns.length} scoring worker(s) to exit`);
        await Promise.allSettled(shutdowns);
    }

    // Step 3: drop the channels and the owned gliders from the global
    // maps. Nothing downstream references them any more.
    for (const cname of ownedCnames) {
        delete channels[cname];
    }
    competition.ownedChannels.clear();

    let droppedGliders = 0;
    for (const key of Object.keys(gliders)) {
        if (gliders[key as ClassName_Compno].compid === competition.compid) {
            delete gliders[key as ClassName_Compno];
            droppedGliders++;
        }
    }
    if (droppedGliders) {
        console.log(`${tag}: dropped ${droppedGliders} glider(s) from global map`);
    }

    // Step 4: close the unknown-glider channel, mark stopped, remove
    // from the contexts map. reconcileContexts() follows up with a
    // setAirfields() push and rebuildAprsFilter() rewrites the APRS
    // filter without this comp's clauses.
    try {
        competition.unknownChannel?.close();
    } catch (e) {
        /**/
    }
    competition.unknownChannel = undefined;
    competition.state = 'stopped';
    delete contexts[competition.compid];
    console.log(`${tag}: competition context stopped`);
    // Tell /all listeners the comp is gone so the globe drops its marker.
    // Skipped during process shutdown — the socket is going down anyway,
    // and broadcasting `removed` would leave clients on a "can't find
    // competition" overlay until they reconnect to the new daemon.
    if (!shuttingDown) broadcastCompetitionsDelta([], [competition.compid]);
}

async function tickCompetition(competition: CompetitionContext) {
    const datecode = await tickCompetitionClasses(competition);
    if (datecode === null) return;
    await tickCompetitionTrackersAndTasks(competition, datecode);
}

// Phase 1 of a tick: resolve datecode/sunset/proposed scoreId and run
// updateClasses so channels exist with cached scores loaded. Returns the
// datecode for the caller to pass into Phase 2, or null if the comp is
// stopping/stopped (caller should skip Phase 2).
async function tickCompetitionClasses(competition: CompetitionContext): Promise<Datecode | null> {
    if (competition.state === 'stopping' || competition.state === 'stopped') return null;
    const datecode = await getDCode(competition);
    getSunset(competition, datecode);
    getProposedScoreId(competition);
    await updateClasses(competition, datecode);
    return datecode;
}

// Phase 2 of a tick: load trackers, load tasks, finalise score IDs and
// transition state. Splitting this out lets startup serve cached scores
// over the websocket and let APRS receive (with the airfield-only filter)
// before the slow tracker/task DB work runs.
async function tickCompetitionTrackersAndTasks(competition: CompetitionContext, datecode: Datecode) {
    if (competition.state === 'stopping' || competition.state === 'stopped') return;
    // Phase A: pull the pilot list, reconcile the gliders dict (no
    // scoring/APRS IPC). updateTasks then sees fully-populated gliders and
    // reads the correct maxHandicap; rebuildAprsFilter narrows the APRS
    // filter to 30km + task bbox immediately. Phase C issues the per-glider
    // setInitialTrack / trackGlider IPC, so loadHistorical fires AFTER the
    // task is set on the scoring worker and the filter has narrowed.
    const pilotData = await updatePilots(competition, datecode);
    await updateTasks(competition);
    rebuildAprsFilter();
    await updateTrackers(competition, datecode, pilotData);
    await finaliseScoreId(competition);
    await finaliseTracksBroadcast(competition);
    if (competition.state === 'starting') competition.state = 'running';
    // Push any change picked up by this tick (new class, new pilot count,
    // task wired up, etc.) to /all listeners. broadcastCompetitionsDelta
    // suppresses the wire write if nothing changed since last broadcast.
    broadcastCompetitionsDelta([competition.compid], []);
}

function getSunset(competition: CompetitionContext, datecode: Datecode) {
    const loc = competition.location;
    const {sunset, localMidday} = computeSunset(datecode, loc.lat, loc.lng, loc.tzoffset);
    if (sunset != loc.sunset) {
        console.log(`${compShort(competition.compid)} sunset: ${d(sunset)} (site:${dateToText(sunset, loc.tz)}), dc: ${fromDateCode(datecode)}, localMidday: ${d(localMidday)} (site:${dateToText(localMidday, loc.tz)})`);
        loc.sunset = sunset;
    }
}

// So we have a different channel for each date
function channelName(className: ClassName, datecode: Datecode): ChannelName {
    return (className + datecode).toUpperCase() as ChannelName;
}

// Shorten a compid for log prefixes by taking the leading alphabetic
// "word" (e.g. "bristol2024" -> "bristol", "2024-junior" -> "junior").
// Falls back to a 6-char truncation when no alphabetic run is present.
function compShort(compid: string): string {
    const m = compid.match(/[a-z]+/i);
    const base = m ? m[0] : compid;
    // Never shorter than 8 chars (when the compid has enough material) so log
    // identifiers stay unambiguous — a short letter run like "az" gets padded
    // out from the raw compid (e.g. "az23region" -> "az23regi").
    return (base.length >= 8 ? base : compid.substring(0, 8)).toLowerCase();
}

//
// Get current date code
async function getDCode(competition: CompetitionContext): Promise<Datecode> {
    if (replayBase) {
        return getReplayDatecode();
    }

    // competitionStartTs resolves the most recent 10:00 competition-local time
    // purely from UTC + tzoffset, so the datecode is independent of the
    // timezone the OGN process itself happens to run in.
    return toDateCode(new Date(competitionStartTs(competition.location.tzoffset) * 1000));
}

import {WriteStream} from 'node:fs';

//
// Fetch the trackers from the database
async function updateClasses(competition: CompetitionContext, datecode: Datecode) {
    const location = competition.location;

    // Fetch the trackers from the database and the channel they are supposed to be in.
    // Scoped to this OGN process's compid so we don't pick up other competitions sharing
    // the same database.
    const classes = await db.query<{class: ClassName; datecode: Datecode; compid: string; classname: string; status: string; handicapped: string}[]>(
        `SELECT cs.class, cs.datecode, cl.compid, cl.classname, COALESCE(cs.status, '') AS status,
                COALESCE(cl.handicapped, '') AS handicapped
         FROM classes cl
         LEFT JOIN compstatus cs ON cs.class = cl.class
         WHERE cl.compid = ?`,
        [competition.compid]
    );

    const afterSunset = getNow() > location.sunset;
    const secsFromSunset = Math.abs(getNow() - location.sunset);
    if (secsFromSunset <= 5 * 60) {
        console.log(`${compShort(competition.compid)} updateClasses: ${afterSunset ? 'after sunset' : 'before sunset'} ${d(getNow())} > ${d(location.sunset)}`);
    }

    // Make sure the class structure is correct, this won't touch existing connections
    let newchannels: Record<string, Channel> = {};
    for (const c of classes) {
        // Check if we are not same as configured in db (ie from scoring)
        if (datecode !== c.datecode) {
            // Before competition start
            if (!c.datecode) {
                if (toDateCode(new Date(location.start)) > datecode) {
                    console.error(
                        `${compShort(c.compid)}/${c.classname}: today  ${datecode}/${fromDateCode(datecode)} is outside of expected range ${toDateCode(location.start)}/${location.start} - ${toDateCode(location.end)}/${
                            location.end
                        } and no task configured - not tracking`
                    );
                    continue;
                }
            }
            // after competition end
            else {
                if (toDateCode(new Date(location.end)) < datecode) {
                    console.error(
                        `${compShort(c.compid)}/${c.classname}: today  ${datecode}/${fromDateCode(datecode)} is outside of expected range ${toDateCode(location.start)}/${location.start} - ${toDateCode(location.end)}/${
                            location.end
                        } and no task configured - not tracking`
                    );
                    continue;
                }
            }
        }

        const cname = channelName(c.class, datecode);
        let channel: Channel = channels[cname];

        // New channel needs setup
        if (!channel) {
            // Update the saved data with the new values
            const scoreId = (Math.random() * 10000).toFixed(1);

            channel = {
                clients: [],
                activeGliders: new Set(),
                toSend: [],
                lastSentPositions: 0 as Epoch,
                className: c.class,
                compid: c.compid,
                classname: c.classname,
                datecode: datecode,
                compStatus: c.status || '',
                statusDatecode: (c.datecode as Datecode | null) ?? null,
                classHandicapped: c.handicapped || '',
                pilotCount: 0, // populated by updateTrackers from configured gliders
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
                heightStatistics: new Stats(),
                afterSunset: false,
                live: false,
                // Info on what has been sent via https
                webPathBaseTime: 0 as Epoch,
                mostRecentPosition: getNow(),
                webPathData: {},
                tracksBroadcastRequired: false,
                scoreHistory: new Map(),
                allScores: {},
                scoreId,
                proposedScoreId: scoreId,
                liveScoreId: '',
                scoreIdUpdateRequired: false,
                scoresUpdatedAt: 0 as Epoch,
                earliestScore: Infinity as Epoch,
                earliestStart: Infinity as Epoch,
                latestScore: 0 as Epoch,
                sendBinary(data: Uint8Array) {
                    this.clients.forEach((c: OgnWebSocket) => c.sendBinary(data));
                }
            };
            channel.scoreHistory.set(scoreId, new Map<Compno, PilotScore[]>());
        } else {
            // We move it to the new list
            delete channels[cname];
        }

        // Refresh status mirror fields from the latest compstatus row so the
        // /all CompetitionsList feed reflects the DB on every tick. pilotCount
        // is populated by updateTrackers from the configured glider set.
        channel.compStatus = c.status || '';
        channel.statusDatecode = (c.datecode as Datecode | null) ?? null;
        channel.classHandicapped = c.handicapped || '';
        channel.classname = c.classname;

        // Sticky once true — once the day has crossed sunset stay there even if replay rewinds time
        channel.afterSunset = channel.afterSunset || getNow() > location.sunset;

        newchannels[cname] = channel;

        // Sticky once true — once the day has crossed sunset stay there even if replay rewinds time
        channel.afterSunset = channel.afterSunset || afterSunset;

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
            channel.scoring = new ScoringController({className: channel.className, datecode: channel.datecode, airfield: location, flightstats: (location as any)?.flightstats === 'Y'});
            competition.ownedChannels.add(cname as ChannelName);
            channel.scoring.hookScore(({compno, score, recentStart, t, scoreId, migrateFrom}) => sendScore(channel, compno, score, recentStart, scoreId, t, migrateFrom));
        }
    }

    // Any channels left here are old and can be removed - the current ones are moved from channels
    // and added to newchannels. Only touch channels belonging to this competition.
    const stale = Object.values(channels).filter((c) => c.compid === competition.compid && !newchannels[channelName(c.className, c.datecode)]);
    if (stale.length) {
        console.log(`${compShort(competition.compid)} closing channels: ${stale.map((c) => c.className).join(',')}`);
        stale.forEach((channel) => {
            channel.broadcastChannel?.close();
            channel.scoring?.shutdown();
            delete channels[channelName(channel.className, channel.datecode)];
            competition.ownedChannels.delete(channelName(channel.className, channel.datecode));
        });
        competition.unknownChannel?.close();
        competition.unknownChannel = undefined;
    }

    // Subscribe to the feed of unknown gliders for this competition. The
    // APRS worker dispatches unknowns to Unknown_<compid> based on the
    // nearest airfield, so we listen on the per-compid channel.
    if (!competition.unknownChannel) {
        const unknownChannelName = 'Unknown_' + competition.compid;
        competition.unknownChannel = new BroadcastChannel(unknownChannelName);
        competition.unknownChannel.onmessage = ((ev: MessageEvent<PositionMessage>) => identifyUnknownGlider(competition, ev.data, datecode)) as any;
    }

    // Merge the new channels for this competition into the global map. Channels
    // from other competitions (if any) are left alone.
    for (const [cname, channel] of Object.entries(newchannels)) {
        channels[cname as ChannelName] = channel;
    }
    const channelsLine = Object.values(newchannels)
        .map((c) => `${c.className}${c.datecode}`)
        .join(',');
    if (lastChannelsLog.get(competition.compid) !== channelsLine) {
        console.log(`${compShort(competition.compid)} channels: ${channelsLine}`);
        lastChannelsLog.set(competition.compid, channelsLine);
    }
}

async function updateTasks(competition: CompetitionContext): Promise<void> {
    // Get the details for the task
    const getTask = async (channel: Channel, maxHandicap: number) => {
        const className = channel.className;
        const datecode = channel.datecode;
        const taskdetails = ((await db.query<(TasksTableRow & {nostartutc: Epoch; durationsecs: number; distance: DistanceKM} & ClassesTableRow & ContestDayTableRow)[]>(escape`
            SELECT
                tasks.*,
                time_to_sec (tasks.duration) durationsecs,
                c.grandprixstart,
                c.handicapped,
                c.Dm,
                cd.calendardate,
                cd.status,
                cd.info,
                0 AS distance,
                CASE
                    WHEN COALESCE(nostart, '00:00:00') = '00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP (
                        CONCAT(${fromDateCode(datecode)}, ' ', nostart)
                    ) - comp.tzoffset
                END nostartutc
            FROM
                tasks,
                classes c,
                contestday cd,
                competition comp
            WHERE
                tasks.datecode = ${datecode}
                AND tasks.class = c.class
                AND cd.class = c.class
                AND cd.datecode = ${datecode}
                AND tasks.class = ${className}
                AND tasks.flown = 'Y'
                AND comp.compid = c.compid
        `)) || {})[0];

        if (!taskdetails || !taskdetails.type) {
            console.log(`${className}/${datecode}: no active task`, taskdetails);
            return null;
        }

        const taskid = taskdetails.taskid;

        const tasklegs = await db.query<TaskLegsTableRow[]>(escape`
            SELECT
                taskleg.*,
                nname name
            FROM
                taskleg
            WHERE
                taskleg.taskid = ${taskid}
            ORDER BY
                legno
        `);

        if (tasklegs.length < 2) {
            console.log(`${className}: task ${taskid} is invalid - too few turnpoints`);
            return null;
        }

        let task: Task = {
            rules: {
                grandprixstart: taskdetails.grandprixstart == 'Y',
                nostartutc: taskdetails.nostartutc,
                aat: taskdetails.type == 'A',
                dh: taskdetails.type == 'D' || taskdetails.handicapped == 'D',
                dm: taskdetails.Dm ?? undefined,
                handicapped: taskdetails.handicapped == 'Y' || taskdetails.type == 'D' || taskdetails.handicapped == 'D',
                maxHandicap
            },
            details: taskdetails,
            legs: tasklegs
        };
        calculateTask(task);
        return task;
    };

    // Go through this competition's channels and check for a change of task
    for (const channel of Object.values(channels)) {
        if (channel.compid !== competition.compid) continue;
        //
        // Determine max handicap (dh)
        const maxHandicap = Object.values(gliders)
            .filter((g) => g.className == channel.className)
            .reduce((highest, g) => Math.max(highest, g.handicap), 0);

        // Update the task from the db
        const updatedTask = await getTask(channel, maxHandicap);

        if (!equal(channel.task ?? {}, updatedTask ?? {})) {
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

            // The /all CompetitionClassStatus.taskRules just changed for this
            // class — push a delta now so the per-comp page picks up the new
            // rules without waiting for the next 60s tick.
            broadcastCompetitionsDelta([competition.compid], []);
        }
    }
}

// Walks the active channels for task bboxes and the currentAirfields list
// for airfield-radius fallbacks so pre-task ground traffic is still heard.
// Per-airfield radius: 30 km once the comp has at least one channel with a
// task (the task bbox covers the air work), 250 km otherwise (so we capture
// regional traffic during startup / before the task is published).
// Airfields whose radius is already fully inside the (10km-expanded) task
// bbox are dropped as redundant. When there is neither task nor airfield we
// emit r/0/0/1 — a 1km null-island placeholder that matches nothing.
const AIRFIELD_RADIUS_PRETASK_KM = 250;
const AIRFIELD_RADIUS_INTASK_KM = 30;
let lastAprsFilter: string | null = null;
function rebuildAprsFilter() {
    // A channel is "live" for APRS purposes if it can still produce traffic
    // worth filtering for: not past sunset for the day. compStatus isn't
    // consulted — APRS-derived "home" verdicts have proven unreliable, and
    // late arrivals / unknown traffic around the airfield are still worth
    // catching after the live loop calls the day done.
    const isLive = (c: Channel) => !c.afterSunset;
    const liveChannels = Object.values(channels).filter(isLive);

    const withTasks = liveChannels.filter((c) => c.task);
    const compsWithTask = new Set(withTasks.map((c) => c.compid));
    const liveComps = new Set(liveChannels.map((c) => c.compid));

    // Per-comp expanded bbox map. Same 10km expansion as the union below —
    // matches the aprsc filter's slop margin. Bbox is stable for the life
    // of a task (taskBbox reads leg.maxR = max(r1,r2), set in
    // preprocessSector from the published task geometry), so the worker
    // only needs a refresh when a task is republished — which already
    // routes through here.
    const perCompExpanded = new Map<string, Bbox>();
    for (const c of withTasks) {
        const b = taskBbox(c.task!);
        if (b) perCompExpanded.set(c.compid, expandBbox(b, 10));
    }

    const boxes = Array.from(perCompExpanded.values());
    const union = unionBboxes(boxes);
    const expanded = union; // already pre-expanded per-comp
    const airfields = currentAirfields
        .filter((af) => liveComps.has(af.compid))
        .map((af) => ({
            lt: af.lt,
            lg: af.lg,
            radiusKm: compsWithTask.has(af.compid) ? AIRFIELD_RADIUS_INTASK_KM : AIRFIELD_RADIUS_PRETASK_KM
        }));
    const filter = buildAprsFilter(expanded, airfields);

    // Push per-comp bboxes to the worker so processPacket can prefilter and
    // disambiguate multi-comp shared FLARM IDs. updateAirfieldBboxes only
    // touches the bbox field on existing airfield records — membership is
    // owned by setAirfields (called from reconcileContexts). Sending only
    // the live subset is fine: non-live comps keep whatever bbox they had,
    // and the aprsc filter at line 1521 already narrows packet reception to
    // the live set.
    aprsController?.updateAirfieldBboxes(currentAirfields.filter((af) => liveComps.has(af.compid)).map((af) => ({compid: af.compid, bbox: perCompExpanded.get(af.compid)})));

    if (filter === lastAprsFilter) return;
    lastAprsFilter = filter;
    console.log(`aprs filter (${filter.length} bytes) [${withTasks.map((c) => c.className).join(',') || 'no-tasks'}]: ${filter}`);
    aprsController?.setFilter(filter);
}

function sendTask(sendTo: Channel | OgnWebSocket, channel: Channel) {
    const msg = safeEncode(
        OnglideWebSocketMessage,
        {
            task: channel.task
                ? {
                      geoJSON: JSON.stringify(channel.geoTask),
                      rules: channel.task.rules,
                      details: channel.task.details,
                      legs: channel.task.legs as any
                  }
                : {legs: []}
        },
        `task ${channel.className}`
    );
    if (msg) sendTo.sendBinary(msg);
}

interface CTrackerRow {
    compno: Compno;
    greg: string;
    glidertype: string;
    dbTrackerId: string;
    handicap: number;
    className: ClassName;
    compid: string;
    classname: string;
    utcStart: Epoch;
    scoredStatus: 'H' | 'F' | 'S';
}

// Drop a pilot from every in-memory score store on a channel: current and
// historical scores.
function forgetCompno(channel: Channel, compno: Compno) {
    delete channel.allScores[compno];
    for (const shid of channel.scoreHistory.values()) {
        shid.delete(compno);
    }
}

interface PilotData {
    cTrackers: CTrackerRow[];
    keyedDb: Record<string, CTrackerRow>;
    // Snapshot of each glider's pre-update state, keyed by ClassName_Compno.
    // updateTrackers consults this for change detection (startUtcChanged etc)
    // since the live `gliders` dict has already been overwritten by updatePilots.
    prevGliders: Map<string, {utcStart?: Epoch; handicap?: number; scoredStatus?: string; flarmIdRegex?: RegExp}>;
    initialGliderCount: number;
    // Same snapshot as initialGliderCount but scoped to this competition's
    // own gliders — so updateTrackers can report a per-comp "new" delta and
    // tracked total rather than the global figure.
    initialCompGliderCount: number;
    removedGlidersCount: number;
}

// Phase A: load pilots from the DB, reconcile the in-memory `gliders` dict.
// No scoring/APRS IPC happens here so the gliders dict is fully populated by
// the time updateTasks reads handicaps for its maxHandicap calc.
async function updatePilots(competition: CompetitionContext, datecode: Datecode): Promise<PilotData> {
    const {compid} = competition;
    // Scoped to this OGN process's compid so we don't pick up pilots from
    // other competitions sharing the same database. updateClasses applies
    // the same filter when building channels, so without this join the
    // tracker query returned pilots whose classes we never allocated
    // channels for — resulting in "no channel" exceptions in updateTrackers.
    // Competition.tzoffset also needs to be pinned to this compid, otherwise
    // the scalar subquery would error on a multi-competition DB.
    const cTrackers = await db.query<CTrackerRow[]>(escape`
        SELECT
            p.compno,
            p.greg,
            COALESCE(p.glidertype, '') AS glidertype,
            trackerId AS dbTrackerId,
            p.handicap,
            p.class className,
            cl.compid,
            cl.classname,
            CASE
                WHEN ppr.start = '00:00:00' THEN 0
                ELSE UNIX_TIMESTAMP (
                    CONCAT(
                        ${fromDateCode(datecode)},
                        ' ',
                        ppr.start
                    )
                ) - (
                    SELECT
                        tzoffset
                    FROM
                        competition
                    WHERE
                        compid = ${compid}
                )
            END utcStart,
            CASE
                WHEN ppr.finish = '00:00:00' THEN 0
                ELSE UNIX_TIMESTAMP (
                    CONCAT(
                        ${fromDateCode(datecode)},
                        ' ',
                        ppr.finish
                    )
                ) - (
                    SELECT
                        tzoffset
                    FROM
                        competition
                    WHERE
                        compid = ${compid}
                )
            END utcFinish,
            COALESCE(ppr.scoredStatus, 'S') scoredStatus
        FROM
            pilots p
            JOIN classes cl ON cl.class = p.class
            LEFT OUTER JOIN tracker t ON p.class = t.class
            AND p.compno = t.compno
            LEFT OUTER JOIN (
                SELECT
                    compno,
                    class,
                    start,
                    finish,
                    scoredstatus
                FROM
                    pilotresult pr
                WHERE
                    pr.datecode = ${datecode}
            ) AS ppr ON ppr.class = p.class
            AND ppr.compno = p.compno
        WHERE
            cl.compid = ${compid}
    `);

    const initialGliderCount = Object.keys(gliders).length;
    const initialCompGliderCount = Object.values(gliders).filter((g) => g.compid === compid).length;

    // Reconcile removals. Scope to this comp's own gliders — cTrackers only
    // contains rows for this compid, so without the compid guard we'd treat
    // every other comp's gliders as "removed" and wipe them from the global
    // map, leaving the APRS worker still ticking for compnos main-thread no
    // longer knows about.
    const keyedDb: Record<string, CTrackerRow> = Object.fromEntries(cTrackers.map((c) => [makeClassname_Compno(c), c]));
    const removedGliders = Object.values(gliders).filter((g) => {
        if (g.compid !== compid) return false;
        const newValue = keyedDb[makeClassname_Compno(g)];
        if (!newValue || newValue.dbTrackerId != g.dbTrackerId) {
            console.log(`${g.className}:${g?.compno} - new: ${newValue?.dbTrackerId} vs old: ${g.dbTrackerId} scoredStatus: ${newValue?.scoredStatus}`);
            return true; // removed or it has changed id
        }
        return g.datecode != datecode;
    });

    removedGliders.forEach((g) => {
        console.log(`${g.className}:${g.compno} terminating scoring & tracking as no flarm ids found [channel ${g.channelName}]`);
        if (g.dbTrackerId && g.dbTrackerId != 'unknown' && g.dbTrackerId != 'blocked') {
            aprsController?.untrackGlider(g.compno, g.className, g.channelName, g.dbTrackerId);
        }
        const channel = channels[g.channelName];
        if (channel) {
            channel.scoring?.clearGlider(g.compno);
            channel.scoreIdUpdateRequired = true; // ensure we change id even if nothing else changes
            forgetCompno(channel, g.compno);
        }
    });

    // Timing issue as untrackGlider is async
    removedGliders.forEach((g) => {
        delete gliders[makeClassname_Compno(g)];
    });

    // Catch scores left over from pilots removed while ogn.ts wasn't running:
    // they load from leveldb into allScores at startup but were never in
    // `gliders`, so the removedGliders filter above doesn't see them.
    for (const channel of Object.values(channels)) {
        if (channel.compid !== compid || channel.datecode !== datecode) continue;
        for (const compno of Object.keys(channel.allScores) as Compno[]) {
            if (!keyedDb[makeClassname_Compno(channel.className, compno)]) {
                console.log(`${channel.className}:${compno} clearing orphan score (not in current pilot list)`);
                channel.scoring?.clearGlider(compno);
                channel.scoreIdUpdateRequired = true;
                forgetCompno(channel, compno);
            }
        }
        for (const shid of channel.scoreHistory.values()) {
            for (const compno of shid.keys()) {
                if (!keyedDb[makeClassname_Compno(channel.className, compno)]) {
                    shid.delete(compno);
                }
            }
        }
    }

    // Snapshot the previous state of each tracked glider, then overwrite the
    // dict with fresh DB values. updateTrackers consults the snapshot for
    // change detection (start/handicap/status/hadTracker) since the dict has
    // moved on.
    const prevGliders = new Map<string, {utcStart?: Epoch; handicap?: number; scoredStatus?: string; flarmIdRegex?: RegExp}>();
    for (const t of cTrackers) {
        if (!t.dbTrackerId) continue;
        const gliderKey = makeClassname_Compno(t);
        const existing = gliders[gliderKey];
        prevGliders.set(gliderKey, {
            utcStart: existing?.utcStart,
            handicap: existing?.handicap,
            scoredStatus: existing?.scoredStatus,
            flarmIdRegex: existing?.flarmIdRegex
        });
        gliders[gliderKey] = Object.assign(existing || {}, {
            ...t,
            compid: t.compid,
            channelName: channelName(t.className, datecode),
            greg: t?.greg?.replace(/[^A-Z0-9]/i, ''),
            datecode
        } as any as Glider);
    }

    return {cTrackers, keyedDb, prevGliders, initialGliderCount, initialCompGliderCount, removedGlidersCount: removedGliders.length};
}

// First-load DDB block gate. Runs once per process for trackerids loaded
// from the DB (whether set by processFlarmIdMatch's blocked branch, manual
// entry, or matchtrackers.ts). If any comma-separated device_id in
// `trackerRow.dbTrackerId` has tracked!=Y in the merged DDB and the comp
// hasn't opted into trackingconsent, mutates trackerRow.dbTrackerId to
// 'blocked' so the caller's 'blocked' branch handles worker-side cleanup.
// The DB row keeps the real flarmId — block state is a runtime decision
// re-derived each restart from DDB+consent, so consent flips don't need
// a DB rewrite to take effect. Inserts a trackerhistory audit row noting
// the blocked device_id and source. Skips silently when ddb is empty
// (no fetch yet) — picked up on the next datecode rollover.
function applyDDBFirstLoadBlock(trackerRow: CTrackerRow, className: string, trackingconsent: string | undefined | null): void {
    if (!trackerRow.dbTrackerId || trackerRow.dbTrackerId === 'unknown' || trackerRow.dbTrackerId === 'blocked') return;
    if (Object.keys(ddb).length === 0) return;
    let blockedEntry: SharedDDBEntry | undefined;
    for (const raw of trackerRow.dbTrackerId.split(',')) {
        const id = raw.trim();
        if (!id) continue;
        const entry = ddb[id];
        if (isBlocked(entry, trackingconsent)) {
            blockedEntry = entry;
            break;
        }
    }
    if (!blockedEntry) return;
    const sources = blockedEntry.sources?.join('+') ?? '?';
    const method = blockedMethod(blockedEntry);
    console.log(`${className}:${trackerRow.compno} first-load blocked via DDB (${blockedEntry.device_id}, sources: ${sources}, method: ${method})`);
    trackerRow.dbTrackerId = 'blocked';
    if (!readOnly) {
        db.transaction()
            .query(
                escape`
                INSERT INTO trackerhistory (compno, class, changed, flarmid, greg, method)
                VALUES (${trackerRow.compno}, ${trackerRow.className}, now(), ${blockedEntry.device_id}, ${blockedEntry.registration || null}, ${method})
            `
            )
            .commit();
    }
}

// Phase C: issue per-glider IPC (setInitialTrack/rescoreGlider/finishGlider/
// trackGlider). Runs after updateTasks + rebuildAprsFilter so that
// setInitialTrack carries channel.task, the scoring worker has already
// received setTask, and the APRS filter has narrowed to 30km + task bbox
// before any trackGlider commands fire.
async function updateTrackers(competition: CompetitionContext, datecode: Datecode, pilotData: PilotData) {
    const location = competition.location;
    const {cTrackers, prevGliders, initialCompGliderCount, removedGlidersCount} = pilotData;

    let updatedGliderCount = 0;
    let loadedGliderCount = 0;

    const results = await Promise.allSettled(
        cTrackers
            .filter((t) => t.dbTrackerId)
            .map(async (t) => {
                const gliderKey = makeClassname_Compno(t);
                const prev = prevGliders.get(gliderKey);

                const startUtcChanged = prev?.utcStart != t.utcStart;
                const handicapChanged = prev?.handicap != t.handicap;
                const scoredStatusChanged = prev?.scoredStatus != t.scoredStatus;
                const hadTracker = !!prev?.flarmIdRegex;

                const glider = gliders[gliderKey];
                const channel = channels[glider.channelName];
                if (!channel) {
                    throw new Error('no channel' + glider.channelName);
                }
                const listening = !channel.afterSunset && t.scoredStatus == 'S';

                // Re-derive the runtime block from DDB once per process per
                // pilot. glider.blocked stays set across ticks within a
                // process, so we skip after the first hit — otherwise every
                // tick would re-insert a trackerhistory audit row (the DB
                // row keeps the real flarmId, so the function can't
                // self-gate the way it did when it overwrote trackerid).
                // applyDDBFirstLoadBlock mutates t.dbTrackerId='blocked' on
                // hit, which feeds the OR below; glider.blocked covers
                // subsequent ticks where t.dbTrackerId is fresh from the DB.
                if (!hadTracker && !glider.blocked) {
                    applyDDBFirstLoadBlock(t, channel.className, competition.trackingconsent);
                }

                // Blocked pilots: aprs.ts validateGlider rejects 'blocked', so
                // they have no track points. We synthesize a Blocked PilotScore
                // for the frontend and keep them out of the scoring worker
                // entirely — otherwise the worker emits empty (flightStatus=0)
                // scores that overwrite the synth, causing scoreId churn.
                //
                // competition.trackingconsent='Y' overrides the runtime DDB
                // block (sticky glider.blocked set by applyDDBFirstLoadBlock
                // or processFlarmIdMatch): falling through lets the "no longer
                // blocked" branch below restore scoring. A literal 'blocked'
                // sentinel persisted in tracker.trackerid by matchtrackers is
                // honoured regardless — we have no real flarmid to track with,
                // so re-run matchtrackers to recover.
                if (t.dbTrackerId === 'blocked' || (glider.blocked && competition.trackingconsent !== 'Y')) {
                    // Pilot just transitioned from tracked to blocked: drop them
                    // from the worker so it stops scoring them.
                    if (glider.scoringConfigured && !glider.blocked) {
                        console.log(`${channel.className}:${t.compno} now blocked, clearing from worker`);
                        channel.scoring?.clearGlider(t.compno);
                    }
                    glider.blocked = true;
                    glider.scoringConfigured = true; // skip setInitialTrack on subsequent ticks

                    if (channel.allScores[t.compno]?.flightStatus !== PositionStatus.Blocked) {
                        channel.allScores[t.compno] = PilotScore.fromPartial({
                            compno: t.compno,
                            flightStatus: PositionStatus.Blocked,
                            t: channelNow(channel)
                        });
                        channel.scoreIdUpdateRequired = true;
                    }
                    return {compno: t.compno, channelName: glider.channelName, startUtcChanged, handicapChanged, scoredStatusChanged, hadTracker, scoringConfigured: true, listening: false};
                }

                // Pilot transitioned from blocked back to tracked: force
                // setInitialTrack to run by clearing scoringConfigured, and
                // drop the synthesised Blocked score so the sendScore guard
                // doesn't keep refusing to overwrite it.
                if (glider.blocked) {
                    console.log(`${channel.className}:${t.compno} no longer blocked, restoring scoring`);
                    glider.blocked = false;
                    glider.scoringConfigured = false;
                    delete channel.allScores[t.compno];
                }

                if (glider.scoringConfigured) {
                    if (scoredStatusChanged && t.scoredStatus != 'S') {
                        console.log(`Finishing APRS Listener for glider ${t.className}:${t.compno} => ${t.dbTrackerId}`);
                        aprsController?.finishGlider(t.compno, t.className, glider.channelName);
                    } else if (startUtcChanged || handicapChanged) {
                        console.log(`${glider.className}:${glider.compno}: rescoring [${channel.proposedScoreId}] => startUtcChanged:${startUtcChanged} handicapChanged:${handicapChanged}`);
                        channel?.scoring?.rescoreGlider(glider.compno, glider.handicap, glider.utcStart, channel.proposedScoreId);
                        channel.scoreIdUpdateRequired = true;
                        updatedGliderCount++;
                    }
                } else {
                    try {
                        loadedGliderCount++;
                        channel.scoring?.setInitialTrack(glider.compno, glider.handicap, glider.utcStart, [], channel.proposedScoreId, channel.task);
                        initialiseDeck(glider.compno, glider, randomBytes(4).readUInt32BE(0));
                        glider.webPathEndPosition = 0;
                        glider.scoringConfigured = true;
                        channel.webPathBaseTime = 0 as Epoch;
                        channel.scoreIdUpdateRequired = true;
                        channel.tracksBroadcastRequired = true;
                    } catch (e) {
                        console.error(e);
                    }
                }

                if (!hadTracker) {
                    aprsController?.trackGlider(competition.compid, t.compno, t.className, datecode, location.tzoffset, glider.channelName, t.dbTrackerId, listening);
                    glider.flarmIdRegex = new RegExp(
                        `^(${t.dbTrackerId
                            .split(',')
                            .filter((i: string) => i.match(/[0-9A-F]{6}$/i))
                            .join('|')})`,
                        'i'
                    );
                }

                return {compno: t.compno, channelName: glider.channelName, startUtcChanged, handicapChanged, scoredStatusChanged, hadTracker, scoringConfigured: glider.scoringConfigured, listening};
            })
    );

    try {
        const successfulFilter = <G>(r: PromiseSettledResult<G>): r is PromiseFulfilledResult<G> => r.status == 'fulfilled';
        const success = results.filter(successfulFilter).map((f) => f.value);

        // Per-channel live flag: true while at least one glider on the channel
        // is being listened to — same `s.listening` predicate as the log line
        // below. Reset across all owned channels first so a channel that lost
        // its last listening glider drops back to false. Shipped to the
        // frontend via getIdentifiers.
        for (const cname of competition.ownedChannels) {
            const ch = channels[cname];
            if (ch) ch.live = false;
        }
        for (const s of success) {
            if (s.listening) {
                const ch = channels[s.channelName];
                if (ch) ch.live = true;
            }
        }

        const fr = (f) => {
            const filtered = success.filter(f);
            return filtered.length == success.length ? 'all' : filtered.length == 0 ? 'none' : `${filtered.map((c) => c.compno).join(',')} (${filtered.length}/${results.length})`;
        };

        const anyChanged = success.some((s) => s.startUtcChanged || s.handicapChanged || s.scoredStatusChanged);
        if (anyChanged) {
            console.log(
                `${compShort(competition.compid)}/${datecode}: startChanged: ${fr((s) => s.startUtcChanged)} handicapChanged: ${fr((s) => s.handicapChanged)} scoredStatusChanged: ${fr((s) => s.scoredStatusChanged)}, hadTracker: ${fr(
                    (s) => s.hadTracker
                )} scoring: ${fr((s) => s.scoringConfigured)} listening: ${fr((s) => s.listening)}`
            );
        }

        if (success.length != results.length) {
            console.log(`${compShort(competition.compid)}/${datecode}: updateTrackers: exceptions thrown`);
            console.table(results.filter((r) => r.status != 'fulfilled'));
        }
    } catch (e) {
        console.log(e);
    }

    // Count only this competition's own gliders so the delta and total
    // match the class(es) this updateTrackers call actually touched —
    // the global `gliders` dict spans every comp this process runs.
    const compGliderCount = Object.values(gliders).filter((g) => g.compid === competition.compid).length;
    if (removedGlidersCount || updatedGliderCount || loadedGliderCount || compGliderCount != initialCompGliderCount) {
        const classList = Array.from(competition.ownedChannels)
            .map((cn) => channels[cn]?.className)
            .filter(Boolean)
            .join(',');
        const tag = `${compShort(competition.compid)}/${classList || '?'}/${datecode}`;
        console.log(`${tag}: updatedTrackers: ${removedGlidersCount} removed, ${updatedGliderCount} rescored, ${loadedGliderCount} loaded, ${compGliderCount - initialCompGliderCount} new — ${compGliderCount} tracked`);
    }

    // Refresh per-class pilotCount from the configured glider set. This is
    // what the /all CompetitionsList feed surfaces to the landing page —
    // "pilots configured for tracking" rather than the raw pilots-table count.
    for (const cname of competition.ownedChannels) {
        const ch = channels[cname];
        if (!ch) continue;
        let count = 0;
        for (const g of Object.values(gliders)) {
            if (g.compid === competition.compid && g.className === ch.className && g.datecode === ch.datecode && g.scoringConfigured) {
                count++;
            }
        }
        ch.pilotCount = count;
    }
}

// Re-derive a class's compstatus from live scoring state and push any forward
// transition to the DB. Driven by live scoring events — invoked from sendScore
// on the _live marker and on steady-state live per-pilot scores (never during a
// rescore/replay). The state-machine logic lives in lib/util/computeCompStatus;
// this wrapper assembles the inputs and owns the DB write + channel mirror.
function updateCompStatus(channel: Channel) {
    if (readOnly) return;

    const ctx = contexts[channel.compid];

    // This class's pilots from the global gliders dict. Blocked pilots are
    // excluded outright — they can never produce OGN data (consent/DDB block),
    // so counting them in totalScored would permanently cap trackerCoverage and
    // stop a class stuck at B/G ever reaching H/F on OGN evidence alone.
    // totalScored is then the trackable field; the scored subset is pilots
    // actually loaded into the scoring worker. Excludes dbTrackerId 'unknown'
    // (no FLARM match -> no points, would never read as home and so would wedge
    // the class out of 'H').
    const classGliders = Object.values(gliders).filter((g) => g.compid === channel.compid && g.className === channel.className && g.datecode === channel.datecode && !g.blocked);
    const totalScored = classGliders.length;
    const scored = classGliders
        .filter((g) => g.scoringConfigured && g.dbTrackerId !== 'unknown')
        .map((g) => {
            const score = channel.allScores[g.compno];
            return {
                compno: g.compno,
                scoredStatus: g.scoredStatus,
                flightStatus: score?.flightStatus,
                started: (score?.utcStart ?? 0) !== 0,
                distanceRemaining: score?.actual?.distanceRemaining ?? 0,
                taskDistance: score?.actual?.taskDistance ?? 0,
                taskSpeed: score?.actual?.taskSpeed ?? 0,
                t: score?.t as Epoch
            };
        });
    if (scored.length === 0) return;

    const result = computeCompStatus(scored, totalScored, channel.className, ctx.getNow());
    if (!result) return;

    db.query(
        escape`UPDATE compstatus SET status = ${result.status}
          WHERE class = ${channel.className} AND status IN (${result.allowFrom}) AND datecode = ${channel.datecode}`
    )
        .then((r: any) => {
            if (r?.affectedRows) {
                console.log(`compstatus -> ${result.status} for ${channel.className}/${channel.datecode}: ${result.reason}`);
                // Mirror the live status onto the channel so the
                // /all feed reflects the change without a tick.
                channel.compStatus = result.status;
                channel.statusDatecode = channel.datecode;
                broadcastCompetitionsDelta([channel.compid], []);
            }
        })
        .catch((e: any) => console.log(`compstatus ${result.status}/${channel.datecode} update failed:`, e));
}

async function finaliseScoreId(competition: CompetitionContext) {
    for (const channel of Object.values(channels)) {
        if (channel.compid !== competition.compid) continue;
        if (channel.scoreIdUpdateRequired) {
            channel.scoring?.updateScoreId(channel.scoreId, channel.proposedScoreId);
            channel.scoreId = channel.proposedScoreId;
            channel.scoreIdUpdateRequired = false;
        }
    }
}

async function finaliseTracksBroadcast(competition: CompetitionContext) {
    for (const channel of Object.values(channels)) {
        if (channel.compid !== competition.compid) continue;
        if (channel.tracksBroadcastRequired) {
            channel.tracksBroadcastRequired = false;
            await primeAndBroadcast(channel, `updateTrackers ${channel.className}`);
        }
    }
}
function getProposedScoreId(competition: CompetitionContext) {
    for (const channel of Object.values(channels)) {
        if (channel.compid !== competition.compid) continue;
        channel.proposedScoreId = (Math.random() * 10000).toFixed(1);
        channel.scoreIdUpdateRequired = false;
    }
}

//
// Refresh the in-memory DDB by fetching both upstream sources and
// merging. lib/ddb handles disk-cache fallbacks per-source so a single
// upstream outage doesn't take matching down. We retry on a randomised
// 2-4min interval only if the merge produced nothing usable AND the
// in-memory map is still empty.
async function updateDDB() {
    console.log('updating ddb');
    const merged = await loadMergedDDB();
    if (merged) {
        ddb = merged;
        return;
    }
    console.error('ddb update produced no entries from any source');
    if (Object.keys(ddb).length === 0) {
        setTimeout(updateDDB, 120_000 * Math.random() + 120_000);
    }
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
        console.log(`${channel.className}: generateHistoricalTracks mostRecentPosition: ${d(now)}, base: ${d(base)}, previous: ${d(channel.webPathBaseTime)}`);
        const toStream = Object.entries(gliders).reduce<Record<string, any>>((result, [compno, glider]) => {
            if (glider.className == channel.className) {
                const p = glider.deck;
                if (p) {
                    const start = Math.max(Math.min(sortedIndexNumber(p.t.subarray(0, p.posIndex), firstPointTime), p.posIndex - 3), 0);
                    const end = Math.max(Math.min(sortedIndexNumber(p.t.subarray(0, p.posIndex), now), p.posIndex - 2), 0);
                    const length = end - start;
                    //                        console.log(`${compno}: ${end} - ${start} = ${length}, ${d(p.t[start])} => ${d(p.t[end])}, posIndex: ${p.posIndex} ,${d(glider.utcStart ?? 0)}`);
                    if (length) {
                        result[glider.compno] = {
                            compno: glider.compno,
                            positions: new Uint8Array(p.positions.buffer, start * 12, length * 12),
                            t: new Uint8Array(p.t.buffer, start * 4, length * 4),
                            climbRate: new Uint8Array(p.climbRate.buffer, start, length),
                            agl: new Uint8Array(p.agl.buffer, start * 2, length * 2),
                            bearing: new Uint8Array(p.bearing.buffer, start * 2, length * 2),
                            speed: new Uint8Array(p.speed.buffer, start * 2, length * 2),
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
        }, {});
        // Send the client the current version of the tracks
        const webPath = safeEncode(OnglideWebSocketMessage, {tracks: {pilots: toStream, baseTime: 0}}, `webPath ${channel.className}`);
        // Don't advertise a baseTime for a snapshot with no pilots — viewers
        // would fetch the empty .bin and the proxy/browser would cache it.
        if (webPath && Object.keys(toStream).length > 0) {
            channel.webPathData[now.toString()] = Buffer.from(webPath);
            channel.webPathBaseTime = now;
        }
    }
}

// Send the abbreviated track for all gliders, used when a new client connects
async function generateRecentPilotTracks(channel: Channel) {
    // Make sure they are up to date (does nothing if they are)
    await generateHistoricalTracks(channel);

    const toStream = Object.values(gliders).reduce<Record<string, any>>((result, glider) => {
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
                        bearing: new Uint8Array(p.bearing.buffer, start * 2, length * 2),
                        speed: new Uint8Array(p.speed.buffer, start * 2, length * 2),
                        posIndex: length,
                        trackVersion: p.trackVersion
                    };
                } else {
                    // make the placeholder, it's empty but the other end will make
                    // a new deck object for it.
                    result[glider.compno] = {
                        compno: glider.compno,
                        posIndex: 0,
                        trackVersion: p.trackVersion
                    };
                }
            }
        }
        return result;
    }, {});
    // Send the client the current version of the tracks
    return safeEncode(OnglideWebSocketMessage, {tracks: {pilots: toStream, baseTime: channel.webPathBaseTime ?? 0}}, `recentTracks ${channel.className}`) ?? new Uint8Array(0);
}

// Build the tracks message and broadcast it to all clients of the channel.
// When a non-zero webPathBaseTime is present we first fetch the snapshot
// through the public host so the upstream proxy/CDN caches it before clients
// race to fetch it themselves. Best-effort: failures don't block the send.
async function primeAndBroadcast(channel: Channel, label: string): Promise<void> {
    const msg = await generateRecentPilotTracks(channel);
    if (!msg.byteLength) return;

    const baseTime = channel.webPathBaseTime ?? 0;
    if (baseTime) {
        const host = process.env.NEXT_PUBLIC_HISTORY_HOST || process.env.NEXT_PUBLIC_SITEURL;
        if (host) {
            // Respect an explicit scheme if one was baked into the env var,
            // otherwise pick http for loopback hosts (where the daemon's
            // own HTTP listener answers) and https everywhere else (where
            // an upstream proxy is terminating TLS).
            let url: string;
            if (/^https?:\/\//i.test(host)) {
                url = `${host.replace(/\/$/, '')}/tracks/${(channel.className + channel.datecode).toUpperCase()}.${baseTime}.bin`;
            } else {
                const proto = /^(localhost|127\.|\[::1\])/i.test(host) ? 'http' : 'https';
                url = `${proto}://${host}/tracks/${(channel.className + channel.datecode).toUpperCase()}.${baseTime}.bin`;
            }
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 1000);
            try {
                await fetch(url, {signal: ctl.signal, method: 'GET'});
            } catch (e) {
                console.log(`${label}: prime failed for ${url}: ${(e as Error).message}`);
            } finally {
                clearTimeout(timer);
            }
        }
    }

    channel.sendBinary(msg);
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
        competition: channel.compid, //
        earliestScore: channel.earliestStart < Infinity ? channel.earliestStart - 60 : channel.earliestScore < Infinity ? channel.earliestScore : getNow(),
        latestScore: channel.latestScore,
        scoreId: channel.liveScoreId,
        live: channel.live,
        meanAgl: roundedUint32(channel.heightStatistics.mean),
        highestAgl: roundedUint32(channel.heightStatistics.max),
        deviationAgl: roundedUint32(channel.heightStatistics.standard_deviation)
    };
}

async function sendAllScores(client: OgnWebSocket) {
    const channel = channels[client.ognChannel];
    if (!channel || client.readyState !== WebSocket.OPEN) {
        return;
    }

    const updatedIdentifiers = safeEncode(
        OnglideWebSocketMessage,
        {
            identifiers: getIdentifiers(channel),
            scores: {
                scoreId: channel.liveScoreId,
                pilots: channel.allScores
            },
            t: channelNow(channel)
        },
        `sendAllScores ${channel.className}`
    );

    // If it's after a join then only send to the one client
    if (updatedIdentifiers) client.sendBinary(updatedIdentifiers);
}

async function sendIdentifiersToAll(channel: Channel, includeScore: boolean = false) {
    const updatedIdentifiers = safeEncode(
        OnglideWebSocketMessage,
        {
            identifiers: getIdentifiers(channel),
            t: channelNow(channel),
            ...(includeScore
                ? {
                      scores: {
                          scoreId: channel.scoreId,
                          pilots: channel.allScores
                      }
                  }
                : {})
        },
        `sendIdentifiersToAll ${channel.className}`
    );

    // If it's after a join then only send to the one client
    if (updatedIdentifiers) channel.sendBinary(updatedIdentifiers);
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
        // _live is the "live scoring is ready" signal — re-derive compstatus now.
        updateCompStatus(channel);
        sendIdentifiersToAll(channel, true);
        console.log(`${channel.className}/${channel.datecode}: updating all tracks`);
        await primeAndBroadcast(channel, `_live ${channel.className}/${channel.datecode}`);

        const pendingChannels = Object.values(channels)
            .filter(channelNeedsScoring)
            .filter((c) => !c.liveScoreId);
        if (pendingChannels.length) {
            const pendingLine = pendingChannels.map((c) => `${c.className} (${c.datecode})`).join(', ');
            if (lastPendingChannelsLog !== pendingLine) {
                console.log(`Channels not yet scored: ${pendingLine}`);
                lastPendingChannelsLog = pendingLine;
            }
        } else {
            lastPendingChannelsLog = null;
            console.log('all channels scored');
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

            const i = sortedIndexBy(sh, {t} as unknown as PilotScore, (x) => x.t);
            const prev = sh[i - 1];

            if (i === sh.length) {
                // In-order tail append: drop positional drift within
                // scoreFrequency of the last survivor. State transitions
                // (leg / sector / flight status / start / finish) always
                // land a row via scoreChanged so we never silently swallow
                // a meaningful event.
                if (!prev || t - prev.t >= scoreFrequency || scoreChanged(prev, score, false)) {
                    sh.push(score);
                }
            } else {
                // Out-of-order arrival: the chain rewound (e.g. dogleg
                // backtrack in taskpositiongenerator) and is now re-emitting
                // from t. Drop the stale tail and insert.
                console.log(`***** ${compno} rewind score history from ${d(sh.at(-1)?.t ?? 0)} to ${d(sh[i].t)} sh:[${i}/${sh.length}]`);
                sh.splice(i, Infinity, score);
            }
        }

        // Score from Live packets (either end of rescore or end of current score)
        if (score.live) {
            const msg = safeEncode(OnglideWebSocketMessage, {scores: {scoreId, pilots: {[compno]: score}}}, `live score ${channel.className}/${compno}`);
            if (msg) {
                channel.statistics.bytesSent += channel.clients.length * msg.byteLength;
                trackMetric(channel.className + '.scoring.bytesSent', msg.byteLength * channel.clients.length);
                channel.sendBinary(msg);
            }

            // We record this as the latest we are aware of - it's possible it will be wrong as
            // we don't differentiate between the two scoreIds but it's not a history so will
            // be fixed after a rescore. It could jump between two scores as the old scoring is terminated
            // Carry the prior optimalGrid forward when this tick didn't emit one (the worker only
            // populates it on leg entry) so sendAllScores / sendIdentifiersToAll still ship a grid
            // for the pilot's current leg.
            const prior = channel.allScores[compno];
            // Don't let a stale worker score overwrite the synthesised Blocked
            // entry — the worker may still have track points cached from before
            // the pilot was blocked, and migrating them on every updateScoreId
            // would otherwise resurrect a non-Blocked status.
            if (prior?.flightStatus === PositionStatus.Blocked) {
                return;
            }
            const stored =
                !score.optimalGrid?.length && prior?.optimalGrid?.length && prior.currentLeg === score.currentLeg //
                    ? {...score, optimalGrid: prior.optimalGrid}
                    : score;
            channel.allScores[compno] = stored;

            // Re-derive compstatus from the authoritative live chain only —
            // scoreId must match liveScoreId. A rescore running concurrently
            // (channel.scoreId !== channel.liveScoreId) does not block this:
            // its scores carry the proposed scoreId and won't take this branch.
            if (scoreId === channel.liveScoreId) {
                updateCompStatus(channel);
            }
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

        const channelGliders = Object.values(gliders).filter((glider) => glider.className == channel.className && glider.dbTrackerId && glider.dbTrackerId != 'unknown' && glider.dbTrackerId != 'blocked');

        channel.earliestStart = channelGliders.reduce((min, glider) => Math.min(min, glider.scoredStart ?? Infinity) as Epoch, Infinity as Epoch);

        console.log(`${channel.className}:${compno}: start time changed from ${d(oldStart)} to ${d(score.utcStart)}, [class earliest start ${d(channel.earliestStart)}] resetting tracks`);

        if (channel.task?.rules?.grandprixstart) {
            const mcs = channelGliders.reduce(
                (all, glider) => {
                    if (glider.scoredStart) {
                        const ti = Math.trunc(glider.scoredStart / 300) * 300;
                        all[ti] = (all[ti] ?? 0) + 1;
                    }
                    return all;
                },
                {} as Record<number, number>
            );

            const likely = Object.keys(mcs)
                .sort((a, b) => mcs[a] - mcs[b])
                .filter((a) => mcs[a] > channelGliders.length / 2)?.[0];

            const buckets = Object.keys(mcs)
                .sort((a, b) => Number(a) - Number(b))
                .map((t) => `${d(Number(t))}=${mcs[t]}`)
                .join(', ');
            console.log(`${channel.className} likely GP start ${likely ? d(Number(likely)) : 'none'}; buckets: ${buckets}`);
        }
    }

    if (glider && glider.scoredFinish != (score.utcFinish as Epoch)) {
        // Reset the glider starting point, but also the channel so we don't use invalid
        // mix of the two
        console.log(`${channel.className}:${compno}: finish time changed from ${glider.scoredFinish} to ${score.utcFinish}`);
        glider.scoredFinish = score.utcFinish as Epoch;
    }
}

// =====================================================================
// Global "all competitions" feed (channel `/all`)
// =====================================================================

// Refresh the in-memory map of comps that exist but haven't started flying
// yet. We pull the class roster for each upcoming comp so the landing page
// can show class chips with pilot counts even before tracking begins.
// Emits a /all delta covering anything added, changed, or removed since the
// last refresh.
async function refreshUpcomingCompetitions(rows: any[]) {
    const ymd = (v: any): string => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'string') return v.slice(0, 10);
        return '';
    };

    const seen = new Set<string>();
    const changed: string[] = [];
    for (const row of rows) {
        const compid = row.compid as string;
        seen.add(compid);
        // Pull classnames for this comp in one query. Pilot counts go via
        // the same pilots-table count the front-end used to do — these
        // pilots aren't being tracked yet so there's no in-memory glider
        // count to use.
        let classnames: string[] = [];
        try {
            const cls = await db.query<{classname: string}[]>('SELECT cl.classname FROM classes cl WHERE cl.compid = ? ORDER BY cl.classname', [compid]);
            classnames = cls.map((c) => c.classname);
        } catch (e) {
            console.log(`refreshUpcomingCompetitions: classes query failed for ${compid}:`, e);
        }

        const tzoffset = parseInt(row.tzoffset as unknown as string) || 0;
        const officialDelay = row.delayseconds != null ? Number(row.delayseconds) : (getDelay() as number);
        const next: CompetitionMetadata & {classnames: string[]} = {
            name: row.name,
            sitename: row.sitename ?? null,
            countrycode: row.countrycode || '',
            mainwebsite: row.mainwebsite ?? null,
            urllogo: row.urllogo ?? null,
            lat: Number(row.lat) || 0,
            lng: Number(row.lng) || 0,
            start: ymd(row.start),
            end: ymd(row.end),
            tz: row.tz || '',
            tzoffset,
            officialDelay,
            compgroup: row.compgroup ?? null,
            classnames
        };
        const prev = upcomingComps[compid];
        if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
            upcomingComps[compid] = next;
            changed.push(compid);
        }
    }

    // Drop entries that no longer appear in the upcoming list. They've
    // either become active (handled by the contexts path) or fallen out of
    // the date window entirely.
    const removed: string[] = [];
    for (const compid of Object.keys(upcomingComps)) {
        if (!seen.has(compid)) {
            delete upcomingComps[compid];
            removed.push(compid);
        }
    }

    if (changed.length || removed.length) {
        broadcastCompetitionsDelta(changed, removed);
    }
}

// Build a CompetitionSummary for one comp from in-memory state. Mirrors
// the aggregation that pages/api/competitions.ts used to do in JS, but
// reads compstatus mirrors directly off the per-class Channel objects so
// no DB round-trip is needed on every status change.
function buildUpcomingSummary(compid: string): CompetitionSummary | null {
    const meta = upcomingComps[compid];
    if (!meta) return null;
    const classes: CompetitionClassStatus[] = meta.classnames.map((classname) => ({
        class: classname, // class id == classname for upcoming (we don't expose the id pre-flight)
        classname,
        status: '',
        pilotCount: 0,
        statusDatecode: undefined,
        displayStatus: 'upcoming' as CompetitionDisplayStatus
    }));
    return {
        compid,
        name: meta.name,
        sitename: meta.sitename ?? undefined,
        lat: meta.lat,
        lng: meta.lng,
        start: meta.start,
        end: meta.end,
        countrycode: meta.countrycode,
        tz: meta.tz,
        tzoffset: clampInt32(meta.tzoffset),
        mainwebsite: meta.mainwebsite ?? undefined,
        urllogo: meta.urllogo ?? undefined,
        classCount: classes.length,
        classStatusesDiffer: false,
        displayStatus: 'upcoming',
        classes,
        officialDelay: clampUint32(meta.officialDelay)
    };
}

function buildCompetitionSummary(competition: CompetitionContext): CompetitionSummary | null {
    const sum = competition.summary;
    if (!sum) return null;

    // Day-of-flying compares done as YYYY-MM-DD strings against the comp's
    // local date so a westbound evening flight on the last day still scores
    // as inWindow. Replay mode bypasses live wall-clock checks.
    const todayLocalIso = (() => {
        const tzoffset = sum.tzoffset || 0;
        return new Date(Date.now() + tzoffset * 1000).toISOString().slice(0, 10);
    })();
    const todayDatecode = toDateCode(new Date(todayLocalIso));
    const yesterdayLocalIso = new Date(new Date(todayLocalIso).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterdayDatecode = toDateCode(new Date(yesterdayLocalIso));

    const inWindow = !!sum.start && !!sum.end && sum.start <= todayLocalIso && todayLocalIso <= sum.end;

    const classes: CompetitionClassStatus[] = [];
    for (const cname of competition.ownedChannels) {
        const ch = channels[cname];
        if (!ch) continue;
        const sdc = ch.statusDatecode ? String(ch.statusDatecode).toUpperCase() : null;
        // compstatus is sticky — only trust the status when its datecode
        // matches today; older datecodes get demoted to 'yesterday' or
        // 'notask' so a missed landing report from two days ago doesn't
        // look like 'racing'. See the original /api/competitions logic.
        //
        // 'yesterday' is reserved for a day the class actually flew.
        // compstatus is one sticky row per class and its datecode advances
        // onto a day as soon as a task is *briefed* — so a briefed-then-
        // scrubbed (status stalls at 'B'/'G') or cancelled ('Z') day also
        // carries yesterday's datecode. Only the launched/flying codes count
        // (FLEW_STATES); any other status demotes to 'notask'.
        let displayStatus: CompetitionDisplayStatus;
        if (sdc && sdc < todayDatecode) {
            const flewYesterday = sdc === yesterdayDatecode && FLEW_STATES.has(ch.compStatus);
            displayStatus = flewYesterday ? 'yesterday' : 'notask';
        } else {
            displayStatus = classDisplayStatus(ch.compStatus, inWindow);
        }
        // Prefer the live TaskRules from the briefed task. Pre-task, fall back
        // to a stub carrying just the class's configured handicapped/dh flags
        // so the per-comp page can still tell whether to surface handicapped
        // sort options before a task lands. Clients should not consult the
        // dummy zero fields (grandprixstart/nostartutc/maxHandicap) until a
        // real task message arrives over the per-class channel.
        const taskRules = ch.task?.rules
            ? ch.task.rules
            : ch.classHandicapped
              ? {
                    grandprixstart: false,
                    nostartutc: 0,
                    handicapped: ch.classHandicapped === 'Y' || ch.classHandicapped === 'D',
                    dh: ch.classHandicapped === 'D',
                    maxHandicap: 0
                }
              : undefined;
        // Pick the leader from allScores when the day has flown — used by the
        // landing-page side panel to show a trophy/winner once everyone is
        // home or the day has rolled to 'yesterday'. Prefer handicapped speed
        // (any pilot who completed task), otherwise handicapped distance.
        let winner: ClassWinner | undefined;
        if (displayStatus === 'home' || displayStatus === 'yesterday') {
            const scores = Object.values(ch.allScores);
            const bySpeed = scores.filter((s) => (s.handicapped?.taskSpeed ?? 0) > 0).sort((a, b) => b.handicapped!.taskSpeed! - a.handicapped!.taskSpeed!)[0];
            if (bySpeed) {
                winner = {compno: bySpeed.compno, taskSpeed: bySpeed.handicapped!.taskSpeed};
            } else {
                const byDistance = scores.filter((s) => (s.handicapped?.taskDistance ?? 0) > 0).sort((a, b) => b.handicapped!.taskDistance - a.handicapped!.taskDistance)[0];
                if (byDistance) winner = {compno: byDistance.compno, taskDistance: byDistance.handicapped!.taskDistance};
            }
        }

        classes.push({
            class: ch.className,
            classname: ch.classname || ch.className,
            status: ch.compStatus,
            pilotCount: clampUint32(ch.pilotCount),
            statusDatecode: sdc ?? undefined,
            displayStatus,
            taskRules,
            datecode: ch.datecode,
            taskDetails: ch.task?.details,
            winner
        });
    }
    classes.sort((a, b) => a.classname.localeCompare(b.classname));

    // Comp-level rollup: only classes whose compstatus is from today count
    // toward the live label. Stale rows already became yesterday/notask
    // above and shouldn't drag the comp marker into 'started' just
    // because nobody updated them.
    const todaysStatuses: string[] = [];
    for (const cname of competition.ownedChannels) {
        const ch = channels[cname];
        if (!ch) continue;
        const sdc = ch.statusDatecode ? String(ch.statusDatecode).toUpperCase() : null;
        if (sdc === todayDatecode && ch.compStatus) todaysStatuses.push(ch.compStatus);
    }
    // Roll up to 'yesterday' only when a class genuinely resolved to
    // 'yesterday' above — a no-task day never counts (see per-class logic).
    const anyYesterday = classes.some((c) => c.displayStatus === 'yesterday');
    let displayStatus: CompetitionDisplayStatus;
    const anyFinishing = todaysStatuses.some((s) => s === CompStatus.FirstFinisher);
    const anyStarted = todaysStatuses.some((s) => s === CompStatus.StartOpen);
    const anyLaunching = todaysStatuses.some((s) => s === CompStatus.Launched);
    const allHome = todaysStatuses.length > 0 && todaysStatuses.every((s) => s === CompStatus.AllHome);
    const anyTaskReady = todaysStatuses.some((s) => s === CompStatus.AfterBrief || s === CompStatus.Gridded);
    // A comp rolls up to 'cancelled' only when every class with a status
    // from today is cancelled — a mixed day (one class flying, one
    // scrubbed) keeps the more-active label below.
    const allCancelled = todaysStatuses.length > 0 && todaysStatuses.every((s) => s === CompStatus.Scrubbed);
    if (anyFinishing) displayStatus = 'finishing';
    else if (anyStarted) displayStatus = 'started';
    else if (anyLaunching) displayStatus = 'launching';
    else if (allHome) displayStatus = 'home';
    else if (anyTaskReady) displayStatus = 'task_set';
    else if (allCancelled) displayStatus = 'cancelled';
    else if (inWindow) displayStatus = 'notask';
    else displayStatus = 'upcoming';
    if (todaysStatuses.length === 0 && anyYesterday) displayStatus = 'yesterday';

    const classStatusesDiffer = new Set(classes.map((c) => c.displayStatus)).size > 1;

    return {
        compid: competition.compid,
        name: sum.name,
        sitename: sum.sitename ?? undefined,
        lat: sum.lat,
        lng: sum.lng,
        start: sum.start,
        end: sum.end,
        countrycode: sum.countrycode,
        tz: sum.tz,
        tzoffset: clampInt32(sum.tzoffset),
        mainwebsite: sum.mainwebsite ?? undefined,
        urllogo: sum.urllogo ?? undefined,
        classCount: classes.length,
        classStatusesDiffer,
        displayStatus,
        classes,
        officialDelay: clampUint32(sum.officialDelay)
    };
}

// Resolve a comp's group whether it's active (context) or upcoming.
function groupForCompid(compid: string): string | null {
    return contexts[compid]?.summary.compgroup ?? upcomingComps[compid]?.compgroup ?? null;
}

// Strict match for the /all/<group> feed: a null listener group (bare /all)
// sees every comp; a grouped listener sees only an exact, case-insensitive
// match. An ungrouped comp (null compgroup) is visible only on bare /all.
function listenerWantsComp(listenerGroup: string | null | undefined, compGroup: string | null): boolean {
    if (!listenerGroup) return true;
    return (compGroup ?? '').toLowerCase() === listenerGroup;
}

// Encode a CompetitionsList frame. A single comp carrying a value protobuf
// rejects would otherwise fail the whole batch and take the entire /all feed
// off the wire — so on a batch failure we probe each comp individually, drop
// and log the offender(s), and re-encode the survivors. With the summary
// numerics clamped at build time this fallback should never run; it is the
// last line of defence. Returns null only if even the cleaned frame fails.
function encodeCompetitionsList(summaries: CompetitionSummary[], removed: string[], full: boolean, context: string): Uint8Array | null {
    const generatedAt = Math.floor(getNow());
    const msg = safeEncode(OnglideWebSocketMessage, {competitions: {competitions: summaries, generatedAt, full, removed}}, context);
    if (msg) return msg;
    const good: CompetitionSummary[] = [];
    for (const s of summaries) {
        const probe = safeEncode(OnglideWebSocketMessage, {competitions: {competitions: [s], generatedAt, full: false, removed: []}}, `${context} probe`);
        if (probe) good.push(s);
        else console.error(`competitions: dropping comp ${s.compid} (${s.name}) from ${context} — summary failed to encode, fix upstream data`);
    }
    return safeEncode(OnglideWebSocketMessage, {competitions: {competitions: good, generatedAt, full, removed}}, `${context} recovered`);
}

// Build the encoded full snapshot for one listener group from the maintained
// competitionSummaries map. A grouped listener (/all/<group>) sees only comps
// in its group; bare /all (group === null) sees every comp.
function encodeCompetitionsSnapshot(group: string | null): Uint8Array | null {
    const summaries: CompetitionSummary[] = [];
    for (const [compid, s] of competitionSummaries) {
        if (listenerWantsComp(group, groupForCompid(compid))) summaries.push(s);
    }
    return encodeCompetitionsList(summaries, [], true, `competitions snapshot ${group || 'all'}`);
}

// Send the current full snapshot to a joining client. The encoded frame is
// cached per group and reused for every later joiner — comps change rarely,
// and broadcastCompetitionsDelta keeps the cache rebuilt — so a connect never
// re-walks or re-encodes the list.
function sendCompetitionsSnapshot(client: OgnWebSocket) {
    const groupKey = client.ognGroup ?? '';
    let msg = competitionsSnapshotCache.get(groupKey);
    if (msg === undefined) {
        msg = encodeCompetitionsSnapshot(client.ognGroup);
        competitionsSnapshotCache.set(groupKey, msg);
    }
    if (msg && client.readyState === WebSocket.OPEN) {
        client.send(msg, {binary: true});
        console.log('sendCompetitionsSnapshot', client.ognPeer, groupKey || 'all');
    }
}

// Rebuild the affected per-comp summaries, then broadcast a delta to every
// /all listener. A comp whose rebuilt summary is byte-identical to the one
// already held is skipped — a no-op tick never reaches the wire. Any real
// change also rebuilds every cached snapshot in place so the next joiner
// reads a current frame without re-encoding. `removedCompids` covers comps
// that have dropped off the live list (end date passed, or became active).
function broadcastCompetitionsDelta(changedCompids: string[], removedCompids: string[]) {
    const dirty: CompetitionSummary[] = [];
    for (const compid of changedCompids) {
        const ctx = contexts[compid];
        const s = ctx ? buildCompetitionSummary(ctx) : buildUpcomingSummary(compid);
        if (!s) continue;
        const prev = competitionSummaries.get(compid);
        if (prev && summaryFingerprint(prev) === summaryFingerprint(s)) continue;
        competitionSummaries.set(compid, s);
        // Fire Web Push notifications for any notifiable status transition.
        if (!readOnly) notifyCompetitionDelta(prev, s, getNow, db).catch((e) => console.log('notifyCompetitionDelta failed', e));
        dirty.push(s);
    }
    // Only treat a removal as real if the comp was actually being published —
    // a removed compid the client never had is a no-op not worth a frame.
    const removed: string[] = [];
    for (const compid of removedCompids) {
        if (competitionSummaries.delete(compid)) removed.push(compid);
    }

    if (dirty.length === 0 && removed.length === 0) return;

    // The maintained set changed — rebuild every cached snapshot in place so a
    // joining client (and a post-delta connect burst) reads a ready frame.
    for (const groupKey of competitionsSnapshotCache.keys()) {
        competitionsSnapshotCache.set(groupKey, encodeCompetitionsSnapshot(groupKey || null));
    }

    if (!competitionsListeners.length) return;
    competitionsListeners = competitionsListeners.filter((c) => c.readyState === WebSocket.OPEN);

    // Partition listeners by group and encode one message per distinct group:
    // a grouped listener only receives dirty comps in its group. `removed` is
    // sent to every group unchanged — a removed compid the client never had
    // is a harmless no-op, and the comp's group is no longer resolvable.
    const groups = new Set(competitionsListeners.map((c) => c.ognGroup ?? ''));
    for (const group of groups) {
        const listenerGroup = group || null;
        const groupDirty = listenerGroup ? dirty.filter((s) => listenerWantsComp(listenerGroup, groupForCompid(s.compid))) : dirty;
        if (groupDirty.length === 0 && removed.length === 0) continue;
        const msg = encodeCompetitionsList(groupDirty, removed, false, `competitions delta ${group || 'all'}`);
        if (!msg) continue;
        competitionsListeners.filter((c) => (c.ognGroup ?? '') === group).forEach((client) => client.send(msg, {binary: true}));
    }
}

// Stable string fingerprint of a CompetitionSummary for delta suppression.
// JSON.stringify is deterministic for our shape (no Maps, no field-order
// surprises since ts-proto emits a fixed property order).
function summaryFingerprint(s: CompetitionSummary): string {
    return JSON.stringify(s);
}

// Push a bare `ka` packet to every /all listener. Clients arm a 45s
// watchdog on each frame, so this keeps NAT-timed-out / silently-dead
// connections from sitting idle until the OS gives up.
function broadcastCompetitionsKeepalive() {
    competitionsListeners = competitionsListeners.filter((c) => c.readyState === WebSocket.OPEN);
    if (!competitionsListeners.length) return;

    const now = getNow();
    const msg = safeEncode(OnglideWebSocketMessage, {t: now, ka: {keepalive: true, at: Math.floor(now), listeners: competitionsListeners.length, airborne: 0}}, 'competitions keepalive');
    if (!msg) return;

    competitionsListeners.forEach((client) => client.send(msg, {binary: true}));
}

async function sendKeepalive(channel: Channel) {
    // Per-comp clock for the `at` field that the frontend reads as its
    // current-time reference. Without this, wsStatus.at runs ahead of the
    // delayed position stream and every info box gets greyed out.
    const compNow = channelNow(channel);

    const sumConnectedTime = channel.clients.reduce((a: number, c: any) => a + (compNow - c.connectedAt), 0);

    if (channel.clients.length) {
        console.log(`${channel.className}: ${channel.clients.length} subscribed ${Math.trunc(sumConnectedTime / channel.clients.length / 30) / 2}m avg time, ${channel.activeGliders.size} gliders airborne`);
    }

    // For sending the keepalive
    const keepaliveMsg = safeEncode(
        OnglideWebSocketMessage,
        {
            identifiers: getIdentifiers(channel),
            t: compNow,
            ka: {
                keepalive: true,
                at: Math.floor(compNow),
                listeners: channel.clients.length,
                airborne: channel.activeGliders.size
            }
        },
        `keepalive ${channel.className}`
    );

    // Reset for next iteration (independent of encode outcome — the snapshot was already taken)
    channel.activeGliders.clear();

    if (!keepaliveMsg) return;
    channel.lastKeepAliveMsg = keepaliveMsg;

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
        console.log(`${channel.className}/${message.c}: unexpected position ${d(message.t)}`);
        return;
    }

    // If we have a reset message
    if (message.t == (0 as Epoch)) {
        console.log(`${channel.className}/${message.c}: new track start received`);
        initialiseDeck(message.c as Compno, glider, randomBytes(4).readUInt32BE(0));
        return;
    }

    // We ignore ticks
    if ('tick' in message) {
        return;
    }

    channel.heightStatistics.update(message.g);

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
function identifyUnknownGlider(competition: CompetitionContext, data: PositionMessage, datecode: Datecode): void {
    //
    // We will get the flarm id in 'c' as there is no known compno
    const flarmId = data.c;

    // Check if it's a possible launch
    capturePossibleLaunchLanding(flarmId, datecode, data.t, [data.lng, data.lat], data.g, readOnly ? undefined : db, 'flarm', competition.compid);

    const firstSighting = !unknownTrackers[flarmId];

    // Store in the unknown list for status display
    unknownTrackers[flarmId] = {
        firstTime: data.t,
        ...unknownTrackers[flarmId],
        lastTime: data.t,
        flarmid: flarmId
    };

    if (firstSighting) {
        const ddbf = ddb[flarmId];
        const ddbInfo = ddbf ? `ddb: ${ddbf.cn || '-'}/${ddbf.registration || '-'} ${ddbf.aircraft_model || ''}` : 'not in ddb';
        console.log(`${compShort(competition.compid)}: unknown glider ${flarmId} first seen @ ${data.lat.toFixed(4)},${data.lng.toFixed(4)} (${ddbInfo})`);
    }

    // Do we have it in the DDB?
    const ddbf = ddb[flarmId];

    // If we have matched before then don't do it again
    if (unknownTrackers[flarmId].message) {
        return;
    }

    // This works by checking what is configured in the ddb. Only consider
    // gliders that belong to this competition — with multi-comp we'll see
    // the nearest-airfield's Unknown_<compid> channel so the glider really
    // must match a pilot entered in this competition, not a sibling one.
    if (ddbf && (ddbf.cn != '' || ddbf.registration != '')) {
        // Find all our gliders that could match, may be 0, 1 or possibly 2
        let matches = Object.values(gliders).filter((x) => {
            if (x.compid !== competition.compid) return false;
            return ddbf.cn == x.compno || (ddbf.registration == x.greg && (x.greg || '') != '');
        });

        // If multiple pilots share the matching cn/greg (typically same compno
        // across classes), prefer those whose stored glidertype is equivalent
        // to the DDB's aircraft_model. Only narrow when at least one survives;
        // a stale/wrong DDB type shouldn't lose us a real match.
        if (matches.length > 1 && ddbf.aircraft_model) {
            const typed = matches.filter((m) => gliderEquivalent(m.glidertype, ddbf.aircraft_model));
            if (typed.length > 0) matches = typed;
        }

        if (!Object.keys(matches).length) {
            unknownTrackers[flarmId].message = `No DDB match in competition ${ddbf.cn} (${ddbf.registration}) - ${ddbf.aircraft_model}`;
            console.log(unknownTrackers[flarmId].message);
            return;
        }

        // DDB Permit-Livetracking gate. If either upstream (OGN or
        // FlarmNet) marks this device tracked!=Y and the comp hasn't
        // opted into explicit consent, mark the pilot's tracker as
        // 'blocked' and stop — never subscribe APRS for them.
        if (isBlocked(ddbf, competition.trackingconsent)) {
            const sources = ddbf.sources?.join('+') ?? '?';
            const method = blockedMethod(ddbf);
            // Persist the real flarmId on the tracker row so the association
            // survives restarts; the in-memory dbTrackerId is set to 'blocked'
            // so updateTrackers / aprs.ts / scoring all treat the pilot as
            // blocked at runtime. applyDDBFirstLoadBlock re-runs the DDB
            // check on next load and restores the in-memory block state.
            for (const match of matches) {
                match.dbTrackerId = 'blocked';
                unknownTrackers[flarmId].matched = `${match.compno} ${match.className} (${ddbf.registration}/${ddbf.cn})`;
                unknownTrackers[flarmId].message = `${flarmId}: matched to ${match.compno} (${match.className}) from DDB but blocked — declined livetracking (sources: ${sources}, method: ${method})`;
                console.log(unknownTrackers[flarmId].message);
                if (!readOnly) {
                    db.transaction()
                        .query(
                            escape`
                            UPDATE tracker
                            SET
                                trackerid = ${flarmId}
                            WHERE
                                compno = ${match.compno}
                                AND class = ${match.className}
                                AND trackerid IN ('unknown', 'blocked', '')
                            LIMIT
                                1
                        `
                        )
                        .query(
                            escape`
                            INSERT INTO
                                trackerhistory (compno, class, changed, flarmid, greg, method)
                            VALUES
                                (
                                    ${match.compno},
                                    ${match.className},
                                    now(),
                                    ${flarmId},
                                    ${ddbf.registration || null},
                                    ${method}
                                )
                        `
                        )
                        .commit();
                }
            }
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
        if (match.dbTrackerId != flarmId && match.dbTrackerId != 'unknown' && match.dbTrackerId != 'blocked') {
            unknownTrackers[flarmId].message = `${flarmId} matches ${match.compno} from DDB but ${match.compno} has already got ID ${match.dbTrackerId}`;
            console.log(unknownTrackers[flarmId].message);
            return;
        }

        unknownTrackers[flarmId].message = `${flarmId}:  found in ddb, matched to ${match.compno} (${match.className})`;
        console.log(unknownTrackers[flarmId].message);

        // Link the two together (same as the db update)
        match.dbTrackerId = flarmId;

        // And we should ask the flarm handler to listen for them properly
        aprsController?.trackGlider(competition.compid, match.compno, match.className, datecode, competition.location.tzoffset, channelName(match.className, datecode), flarmId, true);

        // Save in the database so we will reuse them later ;)
        if (!readOnly) {
            db.transaction()
                .query(
                    escape`
                    UPDATE tracker
                    SET
                        trackerid = ${flarmId}
                    WHERE
                        compno = ${match.compno}
                        AND class = ${match.className}
                        AND trackerid IN ('unknown', 'blocked', '')
                    LIMIT
                        1
                `
                )
                .query(
                    escape`
                    INSERT INTO
                        trackerhistory (compno, class, changed, flarmid, launchtime, method)
                    VALUES
                        (
                            ${match.compno},
                            ${match.className},
                            now(),
                            ${flarmId},
                            now(),
                            "ognddb"
                        )
                `
                )
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

        // Reserved /all channel: landing-page listener gets a CompetitionsList
        // snapshot and is added to the dedicated competitionsListeners array.
        // It does not subscribe to any per-class scoring/track stream.
        // /all/<group> restricts the feed to comps with a matching compgroup;
        // bare /all (ognGroup = null) sees every competition.
        if (channelName === COMPETITIONS_CHANNEL || channelName.startsWith(COMPETITIONS_CHANNEL + '/')) {
            ws.ognGroup = channelName === COMPETITIONS_CHANNEL ? null : channelName.slice(COMPETITIONS_CHANNEL.length + 1).toLowerCase() || null;
            ws.sendBinary = (data: Uint8Array) => {
                if (ws.readyState === WebSocket.OPEN && ws.isAlive) {
                    return ws.send(data, {binary: true});
                }
                return undefined;
            };
            competitionsListeners.push(ws);
            ws.on('pong', () => {
                ws.isAlive = true;
            });
            ws.on('close', () => {
                ws.isAlive = false;
                ws.isClosed = true;
            });
            ws.on('error', console.error);
            sendCompetitionsSnapshot(ws);
            return;
        }

        if (!(channelName in channels)) {
            ws.send('reload');
            ws.isAlive = false;
            ws.isValid = false;
            return;
        }

        ws.on('pong', () => {
            ws.isAlive = true;
        });
        ws.on('close', () => {
            ws.isAlive = false;
            ws.isClosed = true;
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
        ws.connectedAt = channelNow(channel);
        ws.sendBinary = (data: Uint8Array) => {
            if (ws.readyState == WebSocket.OPEN && ws.isAlive && channel) {
                channel.statistics.bytesSent += data.byteLength;
                return ws.send(data, {binary: true});
            }
            return undefined;
        };
        channel.clients.push(ws);

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

    if (req?.url == '/status/overview') {
        console.log('request for status - ok');
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200, headers);

        const replacer = (key, value) => {
            switch (key) {
                case 'scoreHistory':
                case 'broadcastChannel':
                case 'deck':
                case 'flarmIdRegex':
                case 'geoTask':
                case 'optimalGrid':
                case 'optimalGridBaselinePath':
                case 'coordinates':
                case 'pointGeoJSON':
                case 'geoJSON':
                case 'linestring':
                case 'lineString':
                case 'lastKeepAliveMsg':
                case 'scoredPoints':
                case 'minDistancePoints':
                case 'maxDistancePoints':
                case 'webPathData':
                    return undefined;

                case 'dbTrackerId':
                    return typeof value === 'string' || value instanceof String ? value.split(',').length : 'invalid';

                // Size of some arrays
                case 'clients':
                    return Array.isArray(value) ? value.length : undefined;
            }
            return value;
        };

        res.end(JSON.stringify({channels: channels, gliders, unknownTrackers}, replacer));
        return;
    }

    if (req?.url == '/status/summary') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200, headers);

        const statusLabels: Record<Glider['scoredStatus'], string> = {S: 'started', F: 'finished', H: 'home'};
        const summary: Record<ChannelName, any> = {};

        for (const cname in channels) {
            const channel = channels[cname as ChannelName];
            const gliderStates = {started: 0, finished: 0, home: 0, airborne: channel.activeGliders.size, total: 0};

            for (const key in gliders) {
                const g = gliders[key as ClassName_Compno];
                if (g.className !== channel.className || g.datecode !== channel.datecode) continue;
                if (!g.dbTrackerId || g.dbTrackerId == 'unknown' || g.dbTrackerId == 'blocked') continue;
                gliderStates.total++;
                const label = statusLabels[g.scoredStatus];
                if (label) gliderStates[label as 'started' | 'finished' | 'home']++;
            }

            let visible = 0;
            let interacting = 0;
            for (const c of channel.clients) {
                if (c.isVisible) visible++;
                if (c.isInteracting) interacting++;
            }

            summary[cname as ChannelName] = {
                className: channel.className,
                datecode: channel.datecode,
                compid: channel.compid,
                gliders: gliderStates,
                viewers: {total: channel.clients.length, visible, interacting},
                rescoring: channel.scoreId !== channel.liveScoreId
            };
        }

        res.end(JSON.stringify(summary));
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

                    // Daemon hasn't built a history map for this scoreId yet — tell the
                    // client to retry instead of caching an empty 200 for up to 24h.
                    const scoresForId = channel.scoreHistory.get(scoreId);
                    if (!scoresForId) {
                        headers['Cache-Control'] = 'no-store';
                        headers['Retry-After'] = '2';
                        res.writeHead(503, headers);
                        res.end();
                        return;
                    }

                    const history: Record<Compno, {history: PilotScore[]}> = {};
                    let scoreCount = 0;
                    let glidersWithScores = 0;
                    for (const [compno, scores] of scoresForId) {
                        const preceeding = scores.findLast((score) => score.t < chunkStart);
                        history[compno] = {
                            history: [
                                ...(preceeding ? [preceeding] : []), // oldest one before the chunk so we have everybody
                                ...scores.filter((score) => score.t >= chunkStart && score.t <= chunkEnd)
                            ]
                        };
                        // Most ticks no longer carry the optimalGrid — backfill the active one onto the
                        // first record so the AAT heatmap renders for chunks that span no leg transition
                        const first = history[compno].history[0];
                        if (first && !first.optimalGrid?.length) {
                            const carrier = scores.findLast((s) => s.t <= first.t && s.currentLeg === first.currentLeg && s.optimalGrid?.length);
                            if (carrier) {
                                history[compno].history[0] = {...first, optimalGrid: carrier.optimalGrid};
                            }
                        }
                        scoreCount += history[compno].history.length;
                        glidersWithScores += history[compno].history.length ? 1 : 0;
                    }

                    const msg = safeEncode(
                        ClassScoreHistory,
                        {
                            className: channel.className,
                            datecode: '', // we need to use undefined otherwise it will die
                            pilots: history
                        },
                        `scorehistory ${channelName} ${timestamp}`
                    );
                    if (!msg) {
                        res.writeHead(500, headers);
                        res.end();
                        return;
                    }

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
                    }
                    console.log('no historical data matching', channelName, timestamp);
                    headers['Cache-Control'] = 'no-store';
                    headers['Retry-After'] = '2';
                    res.writeHead(503, headers);
                    res.end();
                    return;
                }
            }
        }
    }

    res.writeHead(404);
    res.end(http.STATUS_CODES[404]);
}
