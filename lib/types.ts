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

export type TZ = string & As<'TZ'>;

export function makeClassname_Compno(t: {className: string; compno: string} | ClassName, cn?: Compno): ClassName_Compno {
    if (typeof t != 'object') {
        return (t + '_' + cn) as ClassName_Compno;
    }
    return (t.className + '_' + t.compno) as ClassName_Compno;
}

export type ClassName_Compno = string & As<'ClassName_Compno'>;

export type Datecode = string & As<'Datecode'>;

export type FlarmID = string & As<'FlarmID'>;

// Base class for things that are timestamped
export interface TimeStampType {
    t: Epoch;
}

type ComparableCompareFunction<T> = (a: T, b: T) => number;

export interface Comparable<T> {
    compare: ComparableCompareFunction<T>;
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
    f?: string; // sender & id receiver
    v?: string; // vario string
    l?: boolean | null; // is late
    _?: boolean; // live
}

// A leg in the task
export interface TaskLeg {
    type: 'line' | 'sector';
    legno: number;

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
    geoJSON?: any; // geoJSON for the sector
    lineString?: any;
    point?: any; // coordiantes of center geoJSON style
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
    };

    details: any;

    legs: TaskLeg[];
}

export enum EstimatedTurnType {
    none = 'none',
    dogleg = 'dogleg',
    penalty = 'penalty'
}

export interface TaskLegStatus {
    legno: number;
    // If we are an AAT then we need to track the points (task.rules.aat controls this)
    points?: BasePositionMessage[];
    penaltyPoints?: BasePositionMessage[];

    entryTimeStamp?: Epoch;
    exitTimeStamp?: Epoch;
    penaltyTimeStamp?: Epoch;
    altitude?: AltitudeAMSL;

    estimatedTurn?: EstimatedTurnType;
}

export type TaskStatusGenerator = AsyncGenerator<TaskStatus, void, void>;
export interface TaskStatus extends TimeStampType {
    utcStart: Epoch | null;
    utcFinish: Epoch | null;
    startFound: boolean; // time for start has passed in the track
    startConfirmed: boolean; // been close to a turnpoint as well
    currentLeg: number; // what leg are we on

    //
    inSector: boolean;
    inPenalty: boolean;

    closestToNext?: DistanceKM;
    closestToNextSectorPoint?: any;

    //
    pointsProcessed: number;
    legs: TaskLegStatus[];

    //
    lastProcessedPoint?: BasePositionMessage | PositionMessage;
}

//
// We use basically the same structure once we have determined lengths
// This is ready for final scoring
export interface CalculatedTaskLegStatus extends TaskLegStatus {
    //extends Omit<TaskLegStatus, //'points' | 'penaltyPoints'> {
    point?: BasePositionMessage; // where is the turn scored to
    distance?: DistanceKM; // how long is this leg (to previous)
    maxPossible?: {
        distance: DistanceKM;
        point: BasePositionMessage;
    };
    minPossible?: {
        distance?: DistanceKM;
        point: BasePositionMessage;
    };
}

export interface CalculatedTaskStatus extends TaskStatus {
    //Omit<TaskStatus, 'lastProcessedPoint' > {
    legs: CalculatedTaskLegStatus[];
    distance?: DistanceKM; // flown distance
    distanceRemaining?: DistanceKM; // how much left
    maxTaskDistance?: DistanceKM;
    minTaskDistance?: DistanceKM;
}
export type CalculatedTaskGenerator = AsyncGenerator<CalculatedTaskStatus, void, void>;

//
// Final scores for sending to websocket
export type TaskScoresGenerator = AsyncGenerator<PilotScore, void, void>;
// For serialising to the client
export type ProtobufGenerator = AsyncGenerator<Uint8Array, void, void>;

export interface DeckData {
    compno: Compno;
    positions: Float32Array;
    indices: Uint32Array;
    agl: Int16Array;
    t: Uint32Array;
    recentIndices: Uint32Array;
    climbRate: Int8Array;
    posIndex: number;
    partial: boolean;
    segmentIndex: number;
}

export interface VarioData {
    altitude: AltitudeAMSL;
    agl: AltitudeAgl;
    lat: number;
    lng: number;
    min: AltitudeAgl;
    max: AltitudeAgl;

    lossXsecond: number;
    gainXsecond: number;
    total: number;
    average: number;
    Xperiod: number;

    delay: number;
}

export interface PilotTrackData {
    compno: Compno;
    deck?: DeckData;
    vario?: VarioData;
    t?: Epoch;
    //    colors?: Uint8Array; // deck colour picking
}

export {PilotScore} from './protobuf/onglide';
import {PilotScore} from './protobuf/onglide';
import {API_ClassName_Pilots_PilotDetail} from './rest-api-types';

export type TrackData = Record<Compno, PilotTrackData>;
export type ScoreData = Record<Compno, PilotScore>;

export interface PilotScoreDisplay extends PilotScore {
    scoredGeoJSON?: any;
    minGeoJSON?: any;
    maxGeoJSON?: any;
}

export interface SelectedPilotDetails {
    pilot: API_ClassName_Pilots_PilotDetail; // from db
    score: PilotScoreDisplay;
    track: PilotTrackData; // deck, vario
}
