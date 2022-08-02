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

export type Compno = string & As<'Compno'>;
export type ClassName = string & As<'ClassName'>;

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

export interface BasePositionMessage extends TimeStampType {
    lat: number;
    lng: number;
}

export interface PositionMessage extends BasePositionMessage {
    c: Compno | FlarmID; // compno
    a: AltitudeAMSL; // altitude
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
    dogleg = 'dogleg'
}

export type TaskStatusGenerator = Generator<TaskStatus, void, void>;
export interface TaskStatus extends TimeStampType {
    utcStart: Epoch | null;
    utcFinish: Epoch | null;
    startFound: boolean; // time for start has passed in the track
    startConfirmed: boolean; // been close to a turnpoint as well
    currentLeg: number; // what leg are we on

    //
    inSector?: boolean;
    inPenalty?: boolean;
    distanceRemaining?: DistanceKM;
    closestToNext?: DistanceKM;

    //
    pointsProcessed: number;

    legs?: {
        legno: number;
        // If we are an AAT then we need to track the points (task.rules.aat controls this)
        points?: BasePositionMessage[];
        penaltyPoints?: BasePositionMessage[];

        entryTimeStamp?: Epoch;
        exitTimeStamp?: Epoch;
        penaltyTimeStamp?: Epoch;
        altitude?: AltitudeAMSL;

        estimatedTurn?: EstimatedTurnType;
    }[];
}

export type TaskScoresGenerator = Generator<TaskScores, void, void>;
export interface TaskScores extends TaskStatus {}
