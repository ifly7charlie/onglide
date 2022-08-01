//
// This is used for transferring position information out of APRS
// on the broadcast channel named after the class
//
import {Epoch, AltitudeAgl, AltitudeAMSL, Compno, FlarmID, Bearing, Speed} from '../types';

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
