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

export interface PositionMessage {
    c: Compno | FlarmID; // compno
    lat: number; // location
    lng: number;
    a: AltitudeAMSL; // altitude
    g: AltitudeAgl; // agl
    t: Epoch; // timestamp
    b?: Bearing; // course
    s?: Speed; // speed
    f?: string; // sender & id receiver
    v?: string; // vario string
    l?: boolean | null; // is late
}

// Base class for things that are timestamped
export interface TimeStampType {
    t: Epoch;
}

export interface task {
    rules: {
        grandprixstart: boolean;
        nostartutc: Epoch;
        aat?: boolean; // capture points
        dh?: boolean; // distance handicap
    };

    legs: {
        type: 'line' | 'sector';
        length: DistanceKM;

        r1: DistanceKM;
        r2: DistanceKM;

        a12: Bearing;
        a1: Bearing;
        a2: Bearing;

        direction: 'symmetrical' | 'np' | 'pp' | 'fixed';

        geoJSON: any; // geoJSON for the sector
        quickSector: boolean; // are we simple or not?
    }[];
}

export enum EstimatedTurnType {
    dogleg
}

export interface TaskStatus extends TimeStampType {
    utcStart: Epoch | null;
    utcFinish: Epoch | null;
    startFound: boolean; // time for start has passed in the track
    startConfirmed: boolean; // been close to a turnpoint as well

    legs?: {
        // If we are an AAT then we need to track the points (task.rules.aat controls this)
        points?: PositionMessage[];
        penaltyPoints?: PositionMessage[];

        entryTimeStamp?: Epoch;
        penaltyTimeStamp?: Epoch;
        altitude?: AltitudeAMSL;

        estimatedTurn?: EstimatedTurnType;
    }[];
}
