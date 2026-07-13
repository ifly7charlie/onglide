import {ClassName, Compno, Epoch, DistanceKM, SpeedKPH, Task, TaskLeg} from './types';

export interface API_ClassName_Pilots_PilotDetail {
    class: ClassName;
    compno: Compno;
    name: string;
    gliderType: string;
    handicap: number;
    country: string;
    image: string;

    // Force TP advance (TBD)
    forceTP: number;

    // Scoring
    dataFromScoring: 'Y' | 'N';
    scoredStatus: 'L' | 'H' | 'F' | 'G';
    utcStart: Epoch;
    utcFinish: Epoch;
    distance: DistanceKM;
    speed: SpeedKPH;
}

export type API_ClassName_Pilots = Record<Compno, API_ClassName_Pilots_PilotDetail>;

// /api/[className]/task — the current comp-day task as raw pre-calculateTask
// JSON; the client must run calculateTask() to rebuild preparedLegs and
// per-leg geometry before use
export interface API_ClassName_Task {
    task: {rules: Task['rules']; details: Task['details']; legs: TaskLeg[]};
}
