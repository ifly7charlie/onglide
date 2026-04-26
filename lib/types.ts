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
    penalty = 'penalty'
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
    posIndex: number;
    segmentIndex?: number;
    trackVersion: number;
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
        tr: Uint32Array;
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
import {PilotScore} from './protobuf/onglide';
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
    type: 'S' | 'A' | 'D' | 'E' | 'G';
    //    distance: DistanceKM;
    duration: Duration;
    nostart: StartTime;
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
    zoomTask: boolean;
    sortKey: SortKey;
    showOthers: boolean;
    constructionLines?: boolean;
    fullPaths?: PathLength;

    options2d: {taskUp: 0 | 1 | 2; mapType: 0 | 1; follow: boolean};
    options3d: {taskUp: 0 | 1 | 2; mapType: 0 | 1; follow: boolean};

    loadId?: number;
}
