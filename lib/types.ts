// Ensure that types are 'protected' to help enforce correct
// assignments
// https://softwareengineering.stackexchange.com/a/437630
export declare abstract class As<Tag extends keyof never> {
    private static readonly $as$: unique symbol;
    private [As.$as$]: Record<Tag, true>;
}

export type Epoch = number & As<'Epoch'>;

export type AltitudeAgl = number;
export type AltitudeAMSL = number;

export type Bearing = number & As<'Bearing'>; /// Degrees
export type Speed = number & As<'Speed'>; /// Kph
export type DistanceKM = number & As<'DistanceKM'>;
export type SpeedKPH = number & As<'SpeedKPH'>;

export type Compno = string & As<'Compno'>;
export type ClassName = string & As<'ClassName'>;
export type ChannelName = string & As<'ChannelName'>;
export type TaskVersion = string & As<'TaskVersion'>;

export type TZ = string & As<'TZ'>;

export function makeClassname_Compno(t: {className: string | ClassName; compno: string | Compno} | ClassName, cn?: Compno): ClassName_Compno {
    if (typeof t != 'object') {
        return (t + '_' + cn) as ClassName_Compno;
    }
    return (t.className + '_' + t.compno) as ClassName_Compno;
}

export type ClassName_Compno = string & As<'ClassName_Compno'>;

export type Datecode = string & As<'Datecode'>;

export type FlarmID = string & As<'FlarmID'>;

// Combined 32-bit stream identifier carried through the ingest + fusion
// pipeline. Low 24 bits = the 6-hex flarmid; high 8 bits = protocol enum
// (OGFLR=1, OGNAVI=2, OGNTRK=3, …; see lib/webworkers/pointlog.ts) — the
// OGN APRS destCallsign of the packet, which identifies the upload /
// processing pipeline (e.g. radio gateway vs. Naviter cloud relay vs.
// OGN-Delay). Two packets that share the 6-hex but came via different
// protocols produce different StreamIds and land in their own bucket
// inside stickyPrimary. Branded so a bare `number` (e.g. an epoch or
// array index) can't be accidentally substituted at a call site that
// expects a stream.
export type StreamId = number & As<'StreamId'>;

export type StartTime = string & As<'StartTime'>;
export type Duration = string & As<'Duration'>;

export type TaskId = number & As<'TaskId'>;

// Base class for things that are timestamped
export interface TimeStampType {
    t: Epoch;
}

import type {Point, Feature, Polygon, LineString} from 'geojson';
import type {PreparedTurnpoint} from './flightprocessing/preparedTurnpoint';

// Where is the airfield
export interface AirfieldLocation {
    name: string;
    tz: TZ;
    tzoffset: number;
    sunset: Epoch;
    lat: number;
    lng: number;
    start: string;
    end: string;
    officialDelay: Epoch;
    altitude?: AltitudeAMSL;
    point?: Feature<Point>;
}

type ComparableCompareFunction<T> = (a: T, b: T) => number;

export interface Comparable<T> {
    compare: ComparableCompareFunction<T>;
}

export interface TickMessage extends TimeStampType {
    c: Compno | FlarmID; // compno
    tick: true;
    _?: boolean;
}

export function isEnrichedTick(m: any): m is EnrichedTickMessage {
    return 'tick' in m && 'ps' in m;
}
export interface EnrichedTickMessage extends TickMessage {
    ps: PositionStatus;
}

export interface BasePositionMessage extends TimeStampType {
    lat: number;
    lng: number;
    a: AltitudeAMSL;
}

export interface PositionMessage extends BasePositionMessage {
    c: Compno | FlarmID; // compno
    //    a: AltitudeAMSL; // altitude
    g: AltitudeAgl; // agl
    b?: Bearing; // course
    s?: Speed; // speed
    l?: boolean | null; // picked
    _?: boolean; // live
    pev?: boolean; // pilot pressed PEV at this fix (IGC E record; viewer/IGC path only — OGN carries no pilot events)
    // Flight-statistics piggyback (APRS worker -> main + scoring, low cadence).
    // Attached only when the segment set materially changes; structured-clone
    // over the BroadcastChannel, never serialised to the wire here.
    stats?: Stats; // full current segment list (incl. per-segment wind)
    wind?: Wind; // most recent wind estimate (scoring welds it onto PilotScore.wind)
    // Final stats broadcast: the glider has finished and tracking has stopped,
    // so this carries the frozen, tail-collapsed segment list with no position.
    // Main applies it to its statsStore; the (now-terminal) scoring chain ignores it.
    statsFinal?: boolean;
}

export function isTick(m: any): m is TickMessage {
    return 'tick' in m;
}

export enum PositionStatus {
    Unknown = 0,
    Stationary = 1,
    Grid = 2,
    Low = 3,
    Airborne = 4,
    Home = 5,
    Landed = 6,
    Finished = 7,
    // Pilot is identified, but the device's DDB Permit-Livetracking
    // flag is N (and the comp has not opted into explicit consent).
    // No APRS subscription is created for them.
    Blocked = 8
}

export const PositionStatusText = {
    [PositionStatus.Unknown]: 'unknown',
    [PositionStatus.Stationary]: 'stationary',
    [PositionStatus.Grid]: 'grid',
    [PositionStatus.Low]: 'low',
    [PositionStatus.Airborne]: 'airborne',
    [PositionStatus.Home]: 'home',
    [PositionStatus.Landed]: 'landed',
    [PositionStatus.Finished]: 'finished',
    [PositionStatus.Blocked]: 'tracking declined'
};

export interface EnrichedPosition extends PositionMessage {
    ps: PositionStatus;
    geoJSON?: Feature<Point>;
}

// A leg in the task
export interface TaskLeg extends TaskLegsTableRow {
    type: 'line' | 'sector';
    legno: number;
    finish?: boolean;

    // Center
    nlat: number;
    nlng: number;

    length: DistanceKM;

    r1: DistanceKM;
    r2: DistanceKM;

    a12: Bearing;
    a1: Bearing;
    a2: Bearing;

    direction: 'symmetrical' | 'np' | 'pp' | 'fixed';

    maxR?: DistanceKM;
    geoJSON?: Polygon | LineString; // geoJSON for the sector
    lineString?: any;
    point?: [number, number]; // coordiantes of center geoJSON style
    pointGeoJSON?: Feature<Point>;
    altitude?: AltitudeAMSL; // altitude of the point
    coordinates?: any; // array of geoJSON ordered points eg [ [lng,lat], [lng,lat] ]
    quickSector?: boolean; // are we simple or not?
    legDistanceAdjust?: DistanceKM; // start/finish rings need length adjustment
}

// The task from the DB and decorated
export interface Task {
    rules: {
        grandprixstart: boolean;
        nostartutc: Epoch;
        aat?: boolean; // capture points
        dh?: boolean; // distance handicap
        pevStart?: boolean; // IGC cylinder (PEV) start — start estimated inside the cylinder

        handicapped?: boolean;
        dm?: number;
        maxHandicap: number; // highest handicap in the class
    };

    details: TasksTableRow & {nostartutc: Epoch; durationsecs: number; distance: DistanceKM} & ClassesTableRow & ContestDayTableRow;

    legs: TaskLeg[];
    preparedLegs?: PreparedTurnpoint[];
}

export enum EstimatedTurnType {
    none = 'none',
    dogleg = 'dogleg',
    crossing = 'crossing',
    penalty = 'penalty',
    pev = 'pev'
}

export interface TaskLegStatus {
    legno: number;
    // If we are an AAT then we need to track the points (task.rules.aat controls this)
    points: BasePositionMessage[];
    penaltyPoints: BasePositionMessage[];

    entryTimeStamp?: Epoch;
    exitTimeStamp?: Epoch;
    penaltyTimeStamp?: Epoch;
    altitude?: AltitudeAMSL;

    estimatedTurn?: EstimatedTurnType;
}

export interface TaskStatus extends TimeStampType {
    utcStart: Epoch | null;
    utcFinish: Epoch | null;
    startFound: boolean; // time for start has passed in the track
    startConfirmed: boolean; // been close to a turnpoint as well
    currentLeg: number; // what leg are we on
    recentLegAdvance?: number; // aat if we just advance from TP then we may still need to check for it

    //
    inSector: boolean;
    inPenalty: boolean;

    closestDistanceToNext?: DistanceKM; // closest point to next sector (dist)
    closestToNextSectorPoint?: BasePositionMessage; // positionmessage
    closestSectorPoint?: BasePositionMessage; // point on next sector that matches above

    closestDistanceToTPCenter?: DistanceKM; // min distance from pilot to next TP center coords (for landout scoring)
    closestToTPCenterPoint?: BasePositionMessage; // pilot position when above was minimized

    //
    pointsProcessed: number;
    legs: TaskLegStatus[];

    // Details from flight directly
    lastProcessedPoint?: BasePositionMessage | PositionMessage;
    flightStatus?: PositionStatus;

    // Who are we ;)
    compno: Compno;
    _?: boolean;
}

//
// We use basically the same structure once we have determined lengths
// This is ready for final scoring
export interface CalculatedTaskLegStatus extends TaskLegStatus {
    //extends Omit<TaskLegStatus, //'points' | 'penaltyPoints'> {
    point?: BasePositionMessage; // where is the turn scored to
    distance?: DistanceKM; // how long is this leg (to previous)
    distanceRemaining?: DistanceKM; // if it's available (aat only)
    maxPossible?: {
        // end of leg for max
        distance: DistanceKM;
        point: BasePositionMessage;
    };
    minPossible?: {
        distance?: DistanceKM;
        point: BasePositionMessage;
        start?: BasePositionMessage;
    };
    convexHull?: number[];
}

export interface CalculatedTaskStatus extends TaskStatus {
    //Omit<TaskStatus, 'lastProcessedPoint' > {
    legs: CalculatedTaskLegStatus[];
    distance?: DistanceKM; // flown distance
    distanceRemaining?: DistanceKM; // how much left (for both aat & speed)
    maxPossible?: DistanceKM; // max task distance remaining
    minPossible?: DistanceKM; // shortest distance to home (for aat this is smallest task distance based on what has been flown)
    scoringClosestPoint?: BasePositionMessage; // the point used for scoring on uncompleted leg
    optimalNextSectorPoint?: BasePositionMessage; // optimal point in next sector for direction visualization
    optimalGrid?: number[]; // flat [lng, lat, taskDist, ...] per grid cell for AAT direction heatmap
    optimalGridBaseline?: number; // scored dist to current sector point + max remaining forward
    optimalGridBaselinePath?: number[]; // flat [lng, lat, ...] for the baseline path visualization
    suggestedTrackPoints?: number[]; // flat [lng, lat, segDist, 0, ...] aim points from current pos to finish
}

// Optimal direction grid snapshot, stored independently for replay
export interface OptimalGridEntry {
    t: Epoch;
    currentLeg: number;
    grid: number[];
}

// points re-ordered if necessary
export type SoftenGenerator<Type extends TimeStampType> = AsyncGenerator<Type, Type | void, void>;

export type InOrderGenerator = AsyncGenerator<PositionMessage | TickMessage, void, Epoch | void>;
export type InOrderGeneratorFunction = (getNow: () => Epoch) => InOrderGenerator;

// Figure out what is happening in the flight
export type EnrichedPositionGenerator = AsyncGenerator<EnrichedPosition | EnrichedTickMessage, void, Epoch | void>;

// Figure out where in a task somebody is
export type TaskStatusGenerator = AsyncGenerator<TaskStatus, void, void>;

// Calculate tasks speeds/distances
export type CalculatedTaskGenerator = AsyncGenerator<CalculatedTaskStatus, void, void>;

// Final scores for sending to websocket
export type TaskScoresGenerator = AsyncGenerator<PilotScore, void, void>;

// For serialising to the client
export type ProtobufGenerator = AsyncGenerator<Uint8Array, void, void>;

export interface DeckData {
    compno: Compno;
    positions: Float32Array;
    indices?: Uint32Array;
    agl: Int16Array;
    t: Uint32Array;
    climbRate: Int8Array;
    // Per-anchor bracket bearing (degrees 0–359) and speed (kph × 10).
    // bearing[i] === -1 means absent (OGN packet without course).
    bearing: Int16Array;
    speed: Uint16Array;
    posIndex: number;
    segmentIndex?: number;
    trackVersion: number;
    // Optional sidecar of Hermite-subdivided vertices for display only.
    // Built by lib/flightprocessing/spline.ts; renderers should source from
    // `deck.smoothed ?? deck`. Scoring path never reads it.
    smoothed?: SmoothedDeck;
}

export interface SmoothedDeck {
    positions: Float32Array;
    indices?: Uint32Array;
    agl: Int16Array;
    // Display-side time: fractional seconds since referenceDate. Float32 has
    // ~0.06s precision at the 10-day baseline-relative scale, plenty for the
    // TripsLayer animation cursor. Picking adds referenceDate back to recover
    // epoch-seconds (lib/react/ogntripslayer.ts).
    t: Float32Array;
    climbRate: Int8Array;
    // For each smoothed vertex, the index of the anchor it is emitted FOR
    // (the bracket's END anchor — inner vertices share the end anchor's
    // index, anchors themselves have their own index). Used for incremental
    // truncation: drop smoothed vertices whose anchorIndex >= fromAnchor.
    anchorIndex: Uint32Array;
    posIndex: number;
    segmentIndex?: number;
}

export interface VarioData {
    altitude: AltitudeAMSL; // current
    agl: AltitudeAgl;

    total: number; // total loss / gain
    average: number; // average of total/Xperiod
    Xperiod: Epoch; // period

    t: Epoch; // when was this updated
    valid: boolean;
}

export type SortKey =
    | 'speed'
    | 'aspeed'
    | 'fspeed'
    | 'faspeed'
    | 'climb'
    | 'remaining'
    | 'aremaining'
    | 'distance'
    | 'adistance'
    | 'height'
    | 'aheight'
    | 'start'
    | 'finish'
    | 'duration'
    | 'delay'
    | 'ald'
    | 'ld'
    | 'done'
    | 'auto'
    | 'times';

export interface DisplayPilotTrackData extends PilotTrackData {
    deckAdditional: {
        // Float32 fractional seconds-from-referenceDate. Built in
        // lib/react/deckvh.ts; passed straight to TripsLayer's getTimestamps.
        tr: Float32Array;
        climb: Uint8Array;
        aheight: Uint8Array;
    };
    icon?: string;
    iconSelected?: string;

    name: string;
}

export interface PilotTrackData {
    compno: Compno;
    deck?: DeckData;
    t?: Epoch;
}

// How close did we get to current turnpoint
export interface NearestSectorPoint {
    geometry?: {
        coordinates: any;
    };
    properties?: {t: Epoch; dist: DistanceKM; p?: EnrichedPosition};
}

export {PilotScore, PilotScoreLeg} from './protobuf/onglide';
import {PilotScore, Stats, Wind} from './protobuf/onglide';
//import {API_ClassName_Pilots_PilotDetail} from './rest-api-types';

export type TrackData = Record<Compno, DisplayPilotTrackData>;
export type ScoreData = Record<Compno, PilotScoreDisplay>;

export type OtherPilotData = Record<ClassName_Compno, PositionMessage>;

export interface PilotScoreDisplay extends PilotScore {
    scoredGeoJSON?: any;
    minGeoJSON?: any;
    maxGeoJSON?: any;
    suggestedGeoJSON?: any;
}

/// Database types
export interface TasksTableRow {
    datecode: Datecode;
    class: ClassName;
    taskid: TaskId;
    task: string;
    flown: string;
    description: string;
    type: 'S' | 'A' | 'D' | 'E';
    //    distance: DistanceKM;
    duration: Duration;
    nostart: StartTime;
    pevstart?: 'Y' | 'N'; // Y = IGC cylinder (PEV) start; manually set, no upstream feed carries it
    hash: string;
}

export interface TaskLegsTableRow {
    datecode: Datecode;
    class: ClassName;
    taskid: TaskId;
    legno: number;

    ntrigraph: string;
    name: string;

    length: DistanceKM;
    bearing: number;
    nlat: number;
    nlng: number;
    altitude?: AltitudeAMSL;
    Hi: number;

    type: 'sector' | 'line';
    direction: 'fixed' | 'np' | 'symmetrical' | 'pp';
    r1: DistanceKM;
    a1: Bearing;
    r2: DistanceKM;
    a2: Bearing;
    a12: Bearing;
}

export interface ClassesTableRow {
    class: ClassName;
    classname: string;
    description: string;
    type: string | null;
    handicapped: 'Y' | 'N' | 'D';
    grandprixstart: 'Y' | 'N';
    Dm: number | null;
}

export interface ContestDayTableRow {
    calendardate: string;
    info: string;
    status: string;
}

//
// compstatus.status — a single-character per-class day-state code. The
// `compstatus` table holds one sticky row per class; it is written by the
// scoring scrapers and the OGN daemon and read by classDisplayStatus()
// (lib/competition-display-status.ts) and the scoring scheduler. Codes and
// member names come from the column comment in conf/sql/onglide_schema.sql.
// The schema also defines 'X' (confirm reg), 'P' (prebrief) and 'R' (all
// reported); the current system never writes them, so they are omitted.
//
export enum CompStatus {
    PreReg = '?', // prereg (the DB column default)
    AfterBrief = 'B', // afterbrief
    Gridded = 'G', // gridded
    Launched = 'L', // launched
    StartOpen = 'S', // start open / flying
    FirstFinisher = 'F', // first finisher imminent
    AllHome = 'H', // all home
    Scrubbed = 'Z', // scrubbed
    CompOver = 'O', // comp over
    NoTask = ':' // no task this day (set by resetStaleCompStatus on rollover)
}

// compstatus codes that mean a task exists for the day.
export const TASK_STATES: ReadonlySet<string> = new Set<string>([CompStatus.AfterBrief, CompStatus.Launched, CompStatus.StartOpen, CompStatus.AllHome, CompStatus.Scrubbed]);

// compstatus codes that mean launching has begun.
export const LAUNCHED_STATES: ReadonlySet<string> = new Set<string>([CompStatus.Launched, CompStatus.StartOpen, CompStatus.FirstFinisher, CompStatus.AllHome]);

// compstatus codes that mean the class actually launched/flew that day —
// used to gate the globe's 'yesterday' badge so a briefed-but-scrubbed or
// cancelled day is not mistaken for a flown one.
export const FLEW_STATES: ReadonlySet<string> = new Set<string>([CompStatus.Launched, CompStatus.StartOpen, CompStatus.FirstFinisher, CompStatus.AllHome]);

export enum Units {
    metric = 0,
    british = 1
}

export enum PathLength {
    recent = 0,
    selectedFull = 1,
    allFull = 2
}

export enum MapType {
    street = 0,
    satellite = 1
}

export enum TaskUp {
    north = 0,
    track = 1,
    user = 2
}

export interface Options {
    //
    rainRadar: boolean;
    rainRadarAdvance: 0 | 1 | 2 | 3;
    units: Units;
    mapType: MapType;
    map2d: boolean;
    taskUp: TaskUp;
    follow: boolean;
    // Transient (not meaningfully persisted — reset to false on load). Set when
    // the user manually repositions the map, which temporarily suspends both the
    // follow-pilot effect and the orientation lock (north/task/track up) until a
    // new pilot is selected or the follow/orientation buttons are clicked.
    viewSuspended?: boolean;
    zoomTask: boolean;
    // Per-turnpoint zoom request — set by the task leg list, consumed and
    // cleared by deckgl's easeTo effect. Same one-shot pattern as zoomTask.
    zoomTurnpoint?: {lat: number; lng: number; radius?: number} | null;
    sortKey: SortKey;
    showOthers: boolean;
    // Climb-rate badges beside circling gliders (gaggle + solo). Off by default.
    showClimb?: boolean;
    constructionLines?: boolean;
    fullPaths?: PathLength;
    // Live distance/height readout between the selected glider and the
    // hovered glider (or the leaderboard leader). Rendered by comparePilotsLayer.
    comparePilots?: boolean;

    options2d: {taskUp: 0 | 1 | 2; mapType: 0 | 1; follow: boolean};
    options3d: {taskUp: 0 | 1 | 2; mapType: 0 | 1; follow: boolean};

    loadId?: number;
}
