import {ClassName, Compno, Epoch, DistanceKM, SpeedKPH} from '../../../lib/types';

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

export type API_ClassName_Pilots = API_ClassName_Pilots_PilotDetail[];
