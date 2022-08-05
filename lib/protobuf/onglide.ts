/* eslint-disable */
import * as _m0 from 'protobufjs/minimal';

export const protobufPackage = '';

/** import "google/protobuf/any.proto"; */

export interface OnglideWebSocketMessage {
    tracks: PilotTracks | undefined;
    scores: Scores | undefined;
    positions: Positions | undefined;
    ka: KeepAlive | undefined;
    t: number;
}

export interface PilotTracks {
    pilots: {[key: string]: PilotTrack};
}

export interface PilotTracks_PilotsEntry {
    key: string;
    value: PilotTrack | undefined;
}

export interface PilotTrack {
    /** what pilot */
    compno: string;
    /** number of points */
    posIndex: number;
    /** epoch time for each point (actually uint32) */
    t: Uint8Array;
    /** Three tuple of [lat,lng,alt] repeated length times (actually float) (and the height above ground) */
    positions: Uint8Array;
    /** Segments in the track line, for broken track drawing (actually uint32) */
    segmentIndex: number;
    indices: Uint8Array;
    /** int16 */
    agl: Uint8Array;
    /** Two Uint32 array containing the track segment that is most recent */
    recentIndices: Uint8Array;
    /** For colouring, all Uint8 arrays one for each point all optional */
    climbRate: Uint8Array;
    airSpeed: Uint8Array;
    altitudeBand: Uint8Array;
    leg: Uint8Array;
    /** Does this contain a full trace or just the most recent trace */
    partial: boolean;
}

export interface Scores {
    pilots: {[key: string]: PilotScore};
}

export interface Scores_PilotsEntry {
    key: string;
    value: PilotScore | undefined;
}

export interface SpeedDist {
    distance: number;
    distancedone: number;
    distancetonext: number;
    remainingdistance: number;
    grremaining: number;
    legspeed: number;
    taskspeed: number;
}

export interface Legs {
    leg: number;
    time: number;
    duration: number;
    lat: number;
    lng: number;
    alt: number;
    agl: number;
    estimatedend: boolean;
    estimatedstart: boolean;
    handicapped: SpeedDist | undefined;
    actual: SpeedDist | undefined;
}

export interface Wind {
    speed: number;
    direction: number;
}

export interface Stats {
    start: number;
    end: number;
    state: string;
    wind: Wind | undefined;
    turncount: number;
    distance: number;
    achievedDistance: number;
    delta: number;
    avgDelta: number;
    direction: number;
    heightgain: number;
    heightloss: number;
}

export interface PilotScore {
    class: string;
    compno: string;
    dbstatus: string;
    datafromscoring: string;
    scoredstatus: string;
    utcstart: number;
    utcfinish: number;
    utcduration: number;
    start: string;
    finish: string;
    duration: string;
    forcetp: number;
    name: string;
    glidertype: string;
    handicap: number;
    image: string;
    daypoints: number;
    dayrank: number;
    dayrankordinal: string;
    country: string;
    prevtotalrank: number;
    totalrank: number;
    hdistancedone: number;
    distancedone: number;
    speed: number;
    hspeed: number;
    maxdistancedone: number;
    min: number;
    max: number;
    taskduration: number;
    lat: number;
    lng: number;
    altitude: number;
    agl: number;
    lastUpdated: number;
    startFound: boolean;
    legs: {[key: number]: Legs};
    lasttp: number;
    status: string;
    remainingdistance: number;
    hremainingdistance: number;
    grremaining: number;
    hgrremaining: number;
    stats: Stats[];
    scoredpoints: number[];
    gainXsecond: number;
    lossXsecond: number;
    Xperiod: number;
    average: number;
    total: number;
    stationary: boolean;
    at: number;
    task: string;
    wind: Wind | undefined;
}

export interface PilotScore_LegsEntry {
    key: number;
    value: Legs | undefined;
}

export interface Positions {
    positions: PilotPositions[];
}

export interface PilotPositions {
    c: string;
    lat: number;
    lng: number;
    a: number;
    g: number;
    t: number;
    b: number;
    s: number;
    v: string;
}

export interface KeepAlive {
    keepalive: boolean;
    t: string;
    at: number;
    listeners: number;
    airborne: number;
}

function createBaseOnglideWebSocketMessage(): OnglideWebSocketMessage {
    return {tracks: undefined, scores: undefined, positions: undefined, ka: undefined, t: 0};
}

export const OnglideWebSocketMessage = {
    encode(message: OnglideWebSocketMessage, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.tracks !== undefined) {
            PilotTracks.encode(message.tracks, writer.uint32(10).fork()).ldelim();
        }
        if (message.scores !== undefined) {
            Scores.encode(message.scores, writer.uint32(18).fork()).ldelim();
        }
        if (message.positions !== undefined) {
            Positions.encode(message.positions, writer.uint32(26).fork()).ldelim();
        }
        if (message.ka !== undefined) {
            KeepAlive.encode(message.ka, writer.uint32(34).fork()).ldelim();
        }
        if (message.t !== 0) {
            writer.uint32(40).uint32(message.t);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): OnglideWebSocketMessage {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseOnglideWebSocketMessage();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.tracks = PilotTracks.decode(reader, reader.uint32());
                    break;
                case 2:
                    message.scores = Scores.decode(reader, reader.uint32());
                    break;
                case 3:
                    message.positions = Positions.decode(reader, reader.uint32());
                    break;
                case 4:
                    message.ka = KeepAlive.decode(reader, reader.uint32());
                    break;
                case 5:
                    message.t = reader.uint32();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): OnglideWebSocketMessage {
        return {
            tracks: isSet(object.tracks) ? PilotTracks.fromJSON(object.tracks) : undefined,
            scores: isSet(object.scores) ? Scores.fromJSON(object.scores) : undefined,
            positions: isSet(object.positions) ? Positions.fromJSON(object.positions) : undefined,
            ka: isSet(object.ka) ? KeepAlive.fromJSON(object.ka) : undefined,
            t: isSet(object.t) ? Number(object.t) : 0
        };
    },

    toJSON(message: OnglideWebSocketMessage): unknown {
        const obj: any = {};
        message.tracks !== undefined && (obj.tracks = message.tracks ? PilotTracks.toJSON(message.tracks) : undefined);
        message.scores !== undefined && (obj.scores = message.scores ? Scores.toJSON(message.scores) : undefined);
        message.positions !== undefined && (obj.positions = message.positions ? Positions.toJSON(message.positions) : undefined);
        message.ka !== undefined && (obj.ka = message.ka ? KeepAlive.toJSON(message.ka) : undefined);
        message.t !== undefined && (obj.t = Math.round(message.t));
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<OnglideWebSocketMessage>, I>>(object: I): OnglideWebSocketMessage {
        const message = createBaseOnglideWebSocketMessage();
        message.tracks = object.tracks !== undefined && object.tracks !== null ? PilotTracks.fromPartial(object.tracks) : undefined;
        message.scores = object.scores !== undefined && object.scores !== null ? Scores.fromPartial(object.scores) : undefined;
        message.positions = object.positions !== undefined && object.positions !== null ? Positions.fromPartial(object.positions) : undefined;
        message.ka = object.ka !== undefined && object.ka !== null ? KeepAlive.fromPartial(object.ka) : undefined;
        message.t = object.t ?? 0;
        return message;
    }
};

function createBasePilotTracks(): PilotTracks {
    return {pilots: {}};
}

export const PilotTracks = {
    encode(message: PilotTracks, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        Object.entries(message.pilots).forEach(([key, value]) => {
            PilotTracks_PilotsEntry.encode({key: key as any, value}, writer.uint32(10).fork()).ldelim();
        });
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): PilotTracks {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBasePilotTracks();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    const entry1 = PilotTracks_PilotsEntry.decode(reader, reader.uint32());
                    if (entry1.value !== undefined) {
                        message.pilots[entry1.key] = entry1.value;
                    }
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): PilotTracks {
        return {
            pilots: isObject(object.pilots)
                ? Object.entries(object.pilots).reduce<{[key: string]: PilotTrack}>((acc, [key, value]) => {
                      acc[key] = PilotTrack.fromJSON(value);
                      return acc;
                  }, {})
                : {}
        };
    },

    toJSON(message: PilotTracks): unknown {
        const obj: any = {};
        obj.pilots = {};
        if (message.pilots) {
            Object.entries(message.pilots).forEach(([k, v]) => {
                obj.pilots[k] = PilotTrack.toJSON(v);
            });
        }
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<PilotTracks>, I>>(object: I): PilotTracks {
        const message = createBasePilotTracks();
        message.pilots = Object.entries(object.pilots ?? {}).reduce<{[key: string]: PilotTrack}>((acc, [key, value]) => {
            if (value !== undefined) {
                acc[key] = PilotTrack.fromPartial(value);
            }
            return acc;
        }, {});
        return message;
    }
};

function createBasePilotTracks_PilotsEntry(): PilotTracks_PilotsEntry {
    return {key: '', value: undefined};
}

export const PilotTracks_PilotsEntry = {
    encode(message: PilotTracks_PilotsEntry, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.key !== '') {
            writer.uint32(10).string(message.key);
        }
        if (message.value !== undefined) {
            PilotTrack.encode(message.value, writer.uint32(18).fork()).ldelim();
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): PilotTracks_PilotsEntry {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBasePilotTracks_PilotsEntry();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.key = reader.string();
                    break;
                case 2:
                    message.value = PilotTrack.decode(reader, reader.uint32());
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): PilotTracks_PilotsEntry {
        return {
            key: isSet(object.key) ? String(object.key) : '',
            value: isSet(object.value) ? PilotTrack.fromJSON(object.value) : undefined
        };
    },

    toJSON(message: PilotTracks_PilotsEntry): unknown {
        const obj: any = {};
        message.key !== undefined && (obj.key = message.key);
        message.value !== undefined && (obj.value = message.value ? PilotTrack.toJSON(message.value) : undefined);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<PilotTracks_PilotsEntry>, I>>(object: I): PilotTracks_PilotsEntry {
        const message = createBasePilotTracks_PilotsEntry();
        message.key = object.key ?? '';
        message.value = object.value !== undefined && object.value !== null ? PilotTrack.fromPartial(object.value) : undefined;
        return message;
    }
};

function createBasePilotTrack(): PilotTrack {
    return {compno: '', posIndex: 0, t: new Uint8Array(), positions: new Uint8Array(), segmentIndex: 0, indices: new Uint8Array(), agl: new Uint8Array(), recentIndices: new Uint8Array(), climbRate: new Uint8Array(), airSpeed: new Uint8Array(), altitudeBand: new Uint8Array(), leg: new Uint8Array(), partial: false};
}

export const PilotTrack = {
    encode(message: PilotTrack, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.compno !== '') {
            writer.uint32(10).string(message.compno);
        }
        if (message.posIndex !== 0) {
            writer.uint32(16).uint32(message.posIndex);
        }
        if (message.t.length !== 0) {
            writer.uint32(26).bytes(message.t);
        }
        if (message.positions.length !== 0) {
            writer.uint32(34).bytes(message.positions);
        }
        if (message.segmentIndex !== 0) {
            writer.uint32(40).uint32(message.segmentIndex);
        }
        if (message.indices.length !== 0) {
            writer.uint32(50).bytes(message.indices);
        }
        if (message.agl.length !== 0) {
            writer.uint32(98).bytes(message.agl);
        }
        if (message.recentIndices.length !== 0) {
            writer.uint32(58).bytes(message.recentIndices);
        }
        if (message.climbRate.length !== 0) {
            writer.uint32(66).bytes(message.climbRate);
        }
        if (message.airSpeed.length !== 0) {
            writer.uint32(74).bytes(message.airSpeed);
        }
        if (message.altitudeBand.length !== 0) {
            writer.uint32(82).bytes(message.altitudeBand);
        }
        if (message.leg.length !== 0) {
            writer.uint32(90).bytes(message.leg);
        }
        if (message.partial === true) {
            writer.uint32(104).bool(message.partial);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): PilotTrack {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBasePilotTrack();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.compno = reader.string();
                    break;
                case 2:
                    message.posIndex = reader.uint32();
                    break;
                case 3:
                    message.t = reader.bytes();
                    break;
                case 4:
                    message.positions = reader.bytes();
                    break;
                case 5:
                    message.segmentIndex = reader.uint32();
                    break;
                case 6:
                    message.indices = reader.bytes();
                    break;
                case 12:
                    message.agl = reader.bytes();
                    break;
                case 7:
                    message.recentIndices = reader.bytes();
                    break;
                case 8:
                    message.climbRate = reader.bytes();
                    break;
                case 9:
                    message.airSpeed = reader.bytes();
                    break;
                case 10:
                    message.altitudeBand = reader.bytes();
                    break;
                case 11:
                    message.leg = reader.bytes();
                    break;
                case 13:
                    message.partial = reader.bool();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): PilotTrack {
        return {
            compno: isSet(object.compno) ? String(object.compno) : '',
            posIndex: isSet(object.posIndex) ? Number(object.posIndex) : 0,
            t: isSet(object.t) ? bytesFromBase64(object.t) : new Uint8Array(),
            positions: isSet(object.positions) ? bytesFromBase64(object.positions) : new Uint8Array(),
            segmentIndex: isSet(object.segmentIndex) ? Number(object.segmentIndex) : 0,
            indices: isSet(object.indices) ? bytesFromBase64(object.indices) : new Uint8Array(),
            agl: isSet(object.agl) ? bytesFromBase64(object.agl) : new Uint8Array(),
            recentIndices: isSet(object.recentIndices) ? bytesFromBase64(object.recentIndices) : new Uint8Array(),
            climbRate: isSet(object.climbRate) ? bytesFromBase64(object.climbRate) : new Uint8Array(),
            airSpeed: isSet(object.airSpeed) ? bytesFromBase64(object.airSpeed) : new Uint8Array(),
            altitudeBand: isSet(object.altitudeBand) ? bytesFromBase64(object.altitudeBand) : new Uint8Array(),
            leg: isSet(object.leg) ? bytesFromBase64(object.leg) : new Uint8Array(),
            partial: isSet(object.partial) ? Boolean(object.partial) : false
        };
    },

    toJSON(message: PilotTrack): unknown {
        const obj: any = {};
        message.compno !== undefined && (obj.compno = message.compno);
        message.posIndex !== undefined && (obj.posIndex = Math.round(message.posIndex));
        message.t !== undefined && (obj.t = base64FromBytes(message.t !== undefined ? message.t : new Uint8Array()));
        message.positions !== undefined && (obj.positions = base64FromBytes(message.positions !== undefined ? message.positions : new Uint8Array()));
        message.segmentIndex !== undefined && (obj.segmentIndex = Math.round(message.segmentIndex));
        message.indices !== undefined && (obj.indices = base64FromBytes(message.indices !== undefined ? message.indices : new Uint8Array()));
        message.agl !== undefined && (obj.agl = base64FromBytes(message.agl !== undefined ? message.agl : new Uint8Array()));
        message.recentIndices !== undefined && (obj.recentIndices = base64FromBytes(message.recentIndices !== undefined ? message.recentIndices : new Uint8Array()));
        message.climbRate !== undefined && (obj.climbRate = base64FromBytes(message.climbRate !== undefined ? message.climbRate : new Uint8Array()));
        message.airSpeed !== undefined && (obj.airSpeed = base64FromBytes(message.airSpeed !== undefined ? message.airSpeed : new Uint8Array()));
        message.altitudeBand !== undefined && (obj.altitudeBand = base64FromBytes(message.altitudeBand !== undefined ? message.altitudeBand : new Uint8Array()));
        message.leg !== undefined && (obj.leg = base64FromBytes(message.leg !== undefined ? message.leg : new Uint8Array()));
        message.partial !== undefined && (obj.partial = message.partial);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<PilotTrack>, I>>(object: I): PilotTrack {
        const message = createBasePilotTrack();
        message.compno = object.compno ?? '';
        message.posIndex = object.posIndex ?? 0;
        message.t = object.t ?? new Uint8Array();
        message.positions = object.positions ?? new Uint8Array();
        message.segmentIndex = object.segmentIndex ?? 0;
        message.indices = object.indices ?? new Uint8Array();
        message.agl = object.agl ?? new Uint8Array();
        message.recentIndices = object.recentIndices ?? new Uint8Array();
        message.climbRate = object.climbRate ?? new Uint8Array();
        message.airSpeed = object.airSpeed ?? new Uint8Array();
        message.altitudeBand = object.altitudeBand ?? new Uint8Array();
        message.leg = object.leg ?? new Uint8Array();
        message.partial = object.partial ?? false;
        return message;
    }
};

function createBaseScores(): Scores {
    return {pilots: {}};
}

export const Scores = {
    encode(message: Scores, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        Object.entries(message.pilots).forEach(([key, value]) => {
            Scores_PilotsEntry.encode({key: key as any, value}, writer.uint32(10).fork()).ldelim();
        });
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): Scores {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseScores();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    const entry1 = Scores_PilotsEntry.decode(reader, reader.uint32());
                    if (entry1.value !== undefined) {
                        message.pilots[entry1.key] = entry1.value;
                    }
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): Scores {
        return {
            pilots: isObject(object.pilots)
                ? Object.entries(object.pilots).reduce<{[key: string]: PilotScore}>((acc, [key, value]) => {
                      acc[key] = PilotScore.fromJSON(value);
                      return acc;
                  }, {})
                : {}
        };
    },

    toJSON(message: Scores): unknown {
        const obj: any = {};
        obj.pilots = {};
        if (message.pilots) {
            Object.entries(message.pilots).forEach(([k, v]) => {
                obj.pilots[k] = PilotScore.toJSON(v);
            });
        }
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<Scores>, I>>(object: I): Scores {
        const message = createBaseScores();
        message.pilots = Object.entries(object.pilots ?? {}).reduce<{[key: string]: PilotScore}>((acc, [key, value]) => {
            if (value !== undefined) {
                acc[key] = PilotScore.fromPartial(value);
            }
            return acc;
        }, {});
        return message;
    }
};

function createBaseScores_PilotsEntry(): Scores_PilotsEntry {
    return {key: '', value: undefined};
}

export const Scores_PilotsEntry = {
    encode(message: Scores_PilotsEntry, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.key !== '') {
            writer.uint32(10).string(message.key);
        }
        if (message.value !== undefined) {
            PilotScore.encode(message.value, writer.uint32(18).fork()).ldelim();
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): Scores_PilotsEntry {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseScores_PilotsEntry();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.key = reader.string();
                    break;
                case 2:
                    message.value = PilotScore.decode(reader, reader.uint32());
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): Scores_PilotsEntry {
        return {
            key: isSet(object.key) ? String(object.key) : '',
            value: isSet(object.value) ? PilotScore.fromJSON(object.value) : undefined
        };
    },

    toJSON(message: Scores_PilotsEntry): unknown {
        const obj: any = {};
        message.key !== undefined && (obj.key = message.key);
        message.value !== undefined && (obj.value = message.value ? PilotScore.toJSON(message.value) : undefined);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<Scores_PilotsEntry>, I>>(object: I): Scores_PilotsEntry {
        const message = createBaseScores_PilotsEntry();
        message.key = object.key ?? '';
        message.value = object.value !== undefined && object.value !== null ? PilotScore.fromPartial(object.value) : undefined;
        return message;
    }
};

function createBaseSpeedDist(): SpeedDist {
    return {distance: 0, distancedone: 0, distancetonext: 0, remainingdistance: 0, grremaining: 0, legspeed: 0, taskspeed: 0};
}

export const SpeedDist = {
    encode(message: SpeedDist, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.distance !== 0) {
            writer.uint32(9).double(message.distance);
        }
        if (message.distancedone !== 0) {
            writer.uint32(17).double(message.distancedone);
        }
        if (message.distancetonext !== 0) {
            writer.uint32(89).double(message.distancetonext);
        }
        if (message.remainingdistance !== 0) {
            writer.uint32(97).double(message.remainingdistance);
        }
        if (message.grremaining !== 0) {
            writer.uint32(160).uint32(message.grremaining);
        }
        if (message.legspeed !== 0) {
            writer.uint32(241).double(message.legspeed);
        }
        if (message.taskspeed !== 0) {
            writer.uint32(249).double(message.taskspeed);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): SpeedDist {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseSpeedDist();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.distance = reader.double();
                    break;
                case 2:
                    message.distancedone = reader.double();
                    break;
                case 11:
                    message.distancetonext = reader.double();
                    break;
                case 12:
                    message.remainingdistance = reader.double();
                    break;
                case 20:
                    message.grremaining = reader.uint32();
                    break;
                case 30:
                    message.legspeed = reader.double();
                    break;
                case 31:
                    message.taskspeed = reader.double();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): SpeedDist {
        return {
            distance: isSet(object.distance) ? Number(object.distance) : 0,
            distancedone: isSet(object.distancedone) ? Number(object.distancedone) : 0,
            distancetonext: isSet(object.distancetonext) ? Number(object.distancetonext) : 0,
            remainingdistance: isSet(object.remainingdistance) ? Number(object.remainingdistance) : 0,
            grremaining: isSet(object.grremaining) ? Number(object.grremaining) : 0,
            legspeed: isSet(object.legspeed) ? Number(object.legspeed) : 0,
            taskspeed: isSet(object.taskspeed) ? Number(object.taskspeed) : 0
        };
    },

    toJSON(message: SpeedDist): unknown {
        const obj: any = {};
        message.distance !== undefined && (obj.distance = message.distance);
        message.distancedone !== undefined && (obj.distancedone = message.distancedone);
        message.distancetonext !== undefined && (obj.distancetonext = message.distancetonext);
        message.remainingdistance !== undefined && (obj.remainingdistance = message.remainingdistance);
        message.grremaining !== undefined && (obj.grremaining = Math.round(message.grremaining));
        message.legspeed !== undefined && (obj.legspeed = message.legspeed);
        message.taskspeed !== undefined && (obj.taskspeed = message.taskspeed);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<SpeedDist>, I>>(object: I): SpeedDist {
        const message = createBaseSpeedDist();
        message.distance = object.distance ?? 0;
        message.distancedone = object.distancedone ?? 0;
        message.distancetonext = object.distancetonext ?? 0;
        message.remainingdistance = object.remainingdistance ?? 0;
        message.grremaining = object.grremaining ?? 0;
        message.legspeed = object.legspeed ?? 0;
        message.taskspeed = object.taskspeed ?? 0;
        return message;
    }
};

function createBaseLegs(): Legs {
    return {leg: 0, time: 0, duration: 0, lat: 0, lng: 0, alt: 0, agl: 0, estimatedend: false, estimatedstart: false, handicapped: undefined, actual: undefined};
}

export const Legs = {
    encode(message: Legs, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.leg !== 0) {
            writer.uint32(8).uint32(message.leg);
        }
        if (message.time !== 0) {
            writer.uint32(16).uint32(message.time);
        }
        if (message.duration !== 0) {
            writer.uint32(24).uint32(message.duration);
        }
        if (message.lat !== 0) {
            writer.uint32(33).double(message.lat);
        }
        if (message.lng !== 0) {
            writer.uint32(41).double(message.lng);
        }
        if (message.alt !== 0) {
            writer.uint32(48).uint32(message.alt);
        }
        if (message.agl !== 0) {
            writer.uint32(56).uint32(message.agl);
        }
        if (message.estimatedend === true) {
            writer.uint32(64).bool(message.estimatedend);
        }
        if (message.estimatedstart === true) {
            writer.uint32(72).bool(message.estimatedstart);
        }
        if (message.handicapped !== undefined) {
            SpeedDist.encode(message.handicapped, writer.uint32(82).fork()).ldelim();
        }
        if (message.actual !== undefined) {
            SpeedDist.encode(message.actual, writer.uint32(90).fork()).ldelim();
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): Legs {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseLegs();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.leg = reader.uint32();
                    break;
                case 2:
                    message.time = reader.uint32();
                    break;
                case 3:
                    message.duration = reader.uint32();
                    break;
                case 4:
                    message.lat = reader.double();
                    break;
                case 5:
                    message.lng = reader.double();
                    break;
                case 6:
                    message.alt = reader.uint32();
                    break;
                case 7:
                    message.agl = reader.uint32();
                    break;
                case 8:
                    message.estimatedend = reader.bool();
                    break;
                case 9:
                    message.estimatedstart = reader.bool();
                    break;
                case 10:
                    message.handicapped = SpeedDist.decode(reader, reader.uint32());
                    break;
                case 11:
                    message.actual = SpeedDist.decode(reader, reader.uint32());
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): Legs {
        return {
            leg: isSet(object.leg) ? Number(object.leg) : 0,
            time: isSet(object.time) ? Number(object.time) : 0,
            duration: isSet(object.duration) ? Number(object.duration) : 0,
            lat: isSet(object.lat) ? Number(object.lat) : 0,
            lng: isSet(object.lng) ? Number(object.lng) : 0,
            alt: isSet(object.alt) ? Number(object.alt) : 0,
            agl: isSet(object.agl) ? Number(object.agl) : 0,
            estimatedend: isSet(object.estimatedend) ? Boolean(object.estimatedend) : false,
            estimatedstart: isSet(object.estimatedstart) ? Boolean(object.estimatedstart) : false,
            handicapped: isSet(object.handicapped) ? SpeedDist.fromJSON(object.handicapped) : undefined,
            actual: isSet(object.actual) ? SpeedDist.fromJSON(object.actual) : undefined
        };
    },

    toJSON(message: Legs): unknown {
        const obj: any = {};
        message.leg !== undefined && (obj.leg = Math.round(message.leg));
        message.time !== undefined && (obj.time = Math.round(message.time));
        message.duration !== undefined && (obj.duration = Math.round(message.duration));
        message.lat !== undefined && (obj.lat = message.lat);
        message.lng !== undefined && (obj.lng = message.lng);
        message.alt !== undefined && (obj.alt = Math.round(message.alt));
        message.agl !== undefined && (obj.agl = Math.round(message.agl));
        message.estimatedend !== undefined && (obj.estimatedend = message.estimatedend);
        message.estimatedstart !== undefined && (obj.estimatedstart = message.estimatedstart);
        message.handicapped !== undefined && (obj.handicapped = message.handicapped ? SpeedDist.toJSON(message.handicapped) : undefined);
        message.actual !== undefined && (obj.actual = message.actual ? SpeedDist.toJSON(message.actual) : undefined);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<Legs>, I>>(object: I): Legs {
        const message = createBaseLegs();
        message.leg = object.leg ?? 0;
        message.time = object.time ?? 0;
        message.duration = object.duration ?? 0;
        message.lat = object.lat ?? 0;
        message.lng = object.lng ?? 0;
        message.alt = object.alt ?? 0;
        message.agl = object.agl ?? 0;
        message.estimatedend = object.estimatedend ?? false;
        message.estimatedstart = object.estimatedstart ?? false;
        message.handicapped = object.handicapped !== undefined && object.handicapped !== null ? SpeedDist.fromPartial(object.handicapped) : undefined;
        message.actual = object.actual !== undefined && object.actual !== null ? SpeedDist.fromPartial(object.actual) : undefined;
        return message;
    }
};

function createBaseWind(): Wind {
    return {speed: 0, direction: 0};
}

export const Wind = {
    encode(message: Wind, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.speed !== 0) {
            writer.uint32(8).uint32(message.speed);
        }
        if (message.direction !== 0) {
            writer.uint32(16).uint32(message.direction);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): Wind {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseWind();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.speed = reader.uint32();
                    break;
                case 2:
                    message.direction = reader.uint32();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): Wind {
        return {
            speed: isSet(object.speed) ? Number(object.speed) : 0,
            direction: isSet(object.direction) ? Number(object.direction) : 0
        };
    },

    toJSON(message: Wind): unknown {
        const obj: any = {};
        message.speed !== undefined && (obj.speed = Math.round(message.speed));
        message.direction !== undefined && (obj.direction = Math.round(message.direction));
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<Wind>, I>>(object: I): Wind {
        const message = createBaseWind();
        message.speed = object.speed ?? 0;
        message.direction = object.direction ?? 0;
        return message;
    }
};

function createBaseStats(): Stats {
    return {start: 0, end: 0, state: '', wind: undefined, turncount: 0, distance: 0, achievedDistance: 0, delta: 0, avgDelta: 0, direction: 0, heightgain: 0, heightloss: 0};
}

export const Stats = {
    encode(message: Stats, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.start !== 0) {
            writer.uint32(8).uint32(message.start);
        }
        if (message.end !== 0) {
            writer.uint32(16).uint32(message.end);
        }
        if (message.state !== '') {
            writer.uint32(26).string(message.state);
        }
        if (message.wind !== undefined) {
            Wind.encode(message.wind, writer.uint32(34).fork()).ldelim();
        }
        if (message.turncount !== 0) {
            writer.uint32(40).uint32(message.turncount);
        }
        if (message.distance !== 0) {
            writer.uint32(49).double(message.distance);
        }
        if (message.achievedDistance !== 0) {
            writer.uint32(57).double(message.achievedDistance);
        }
        if (message.delta !== 0) {
            writer.uint32(64).int32(message.delta);
        }
        if (message.avgDelta !== 0) {
            writer.uint32(73).double(message.avgDelta);
        }
        if (message.direction !== 0) {
            writer.uint32(80).uint32(message.direction);
        }
        if (message.heightgain !== 0) {
            writer.uint32(88).uint32(message.heightgain);
        }
        if (message.heightloss !== 0) {
            writer.uint32(96).uint32(message.heightloss);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): Stats {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseStats();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.start = reader.uint32();
                    break;
                case 2:
                    message.end = reader.uint32();
                    break;
                case 3:
                    message.state = reader.string();
                    break;
                case 4:
                    message.wind = Wind.decode(reader, reader.uint32());
                    break;
                case 5:
                    message.turncount = reader.uint32();
                    break;
                case 6:
                    message.distance = reader.double();
                    break;
                case 7:
                    message.achievedDistance = reader.double();
                    break;
                case 8:
                    message.delta = reader.int32();
                    break;
                case 9:
                    message.avgDelta = reader.double();
                    break;
                case 10:
                    message.direction = reader.uint32();
                    break;
                case 11:
                    message.heightgain = reader.uint32();
                    break;
                case 12:
                    message.heightloss = reader.uint32();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): Stats {
        return {
            start: isSet(object.start) ? Number(object.start) : 0,
            end: isSet(object.end) ? Number(object.end) : 0,
            state: isSet(object.state) ? String(object.state) : '',
            wind: isSet(object.wind) ? Wind.fromJSON(object.wind) : undefined,
            turncount: isSet(object.turncount) ? Number(object.turncount) : 0,
            distance: isSet(object.distance) ? Number(object.distance) : 0,
            achievedDistance: isSet(object.achievedDistance) ? Number(object.achievedDistance) : 0,
            delta: isSet(object.delta) ? Number(object.delta) : 0,
            avgDelta: isSet(object.avgDelta) ? Number(object.avgDelta) : 0,
            direction: isSet(object.direction) ? Number(object.direction) : 0,
            heightgain: isSet(object.heightgain) ? Number(object.heightgain) : 0,
            heightloss: isSet(object.heightloss) ? Number(object.heightloss) : 0
        };
    },

    toJSON(message: Stats): unknown {
        const obj: any = {};
        message.start !== undefined && (obj.start = Math.round(message.start));
        message.end !== undefined && (obj.end = Math.round(message.end));
        message.state !== undefined && (obj.state = message.state);
        message.wind !== undefined && (obj.wind = message.wind ? Wind.toJSON(message.wind) : undefined);
        message.turncount !== undefined && (obj.turncount = Math.round(message.turncount));
        message.distance !== undefined && (obj.distance = message.distance);
        message.achievedDistance !== undefined && (obj.achievedDistance = message.achievedDistance);
        message.delta !== undefined && (obj.delta = Math.round(message.delta));
        message.avgDelta !== undefined && (obj.avgDelta = message.avgDelta);
        message.direction !== undefined && (obj.direction = Math.round(message.direction));
        message.heightgain !== undefined && (obj.heightgain = Math.round(message.heightgain));
        message.heightloss !== undefined && (obj.heightloss = Math.round(message.heightloss));
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<Stats>, I>>(object: I): Stats {
        const message = createBaseStats();
        message.start = object.start ?? 0;
        message.end = object.end ?? 0;
        message.state = object.state ?? '';
        message.wind = object.wind !== undefined && object.wind !== null ? Wind.fromPartial(object.wind) : undefined;
        message.turncount = object.turncount ?? 0;
        message.distance = object.distance ?? 0;
        message.achievedDistance = object.achievedDistance ?? 0;
        message.delta = object.delta ?? 0;
        message.avgDelta = object.avgDelta ?? 0;
        message.direction = object.direction ?? 0;
        message.heightgain = object.heightgain ?? 0;
        message.heightloss = object.heightloss ?? 0;
        return message;
    }
};

function createBasePilotScore(): PilotScore {
    return {class: '', compno: '', dbstatus: '', datafromscoring: '', scoredstatus: '', utcstart: 0, utcfinish: 0, utcduration: 0, start: '', finish: '', duration: '', forcetp: 0, name: '', glidertype: '', handicap: 0, image: '', daypoints: 0, dayrank: 0, dayrankordinal: '', country: '', prevtotalrank: 0, totalrank: 0, hdistancedone: 0, distancedone: 0, speed: 0, hspeed: 0, maxdistancedone: 0, min: 0, max: 0, taskduration: 0, lat: 0, lng: 0, altitude: 0, agl: 0, lastUpdated: 0, startFound: false, legs: {}, lasttp: 0, status: '', remainingdistance: 0, hremainingdistance: 0, grremaining: 0, hgrremaining: 0, stats: [], scoredpoints: [], gainXsecond: 0, lossXsecond: 0, Xperiod: 0, average: 0, total: 0, stationary: false, at: 0, task: '', wind: undefined};
}

export const PilotScore = {
    encode(message: PilotScore, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.class !== '') {
            writer.uint32(10).string(message.class);
        }
        if (message.compno !== '') {
            writer.uint32(18).string(message.compno);
        }
        if (message.dbstatus !== '') {
            writer.uint32(26).string(message.dbstatus);
        }
        if (message.datafromscoring !== '') {
            writer.uint32(34).string(message.datafromscoring);
        }
        if (message.scoredstatus !== '') {
            writer.uint32(42).string(message.scoredstatus);
        }
        if (message.utcstart !== 0) {
            writer.uint32(48).uint32(message.utcstart);
        }
        if (message.utcfinish !== 0) {
            writer.uint32(432).uint32(message.utcfinish);
        }
        if (message.utcduration !== 0) {
            writer.uint32(440).uint32(message.utcduration);
        }
        if (message.start !== '') {
            writer.uint32(58).string(message.start);
        }
        if (message.finish !== '') {
            writer.uint32(66).string(message.finish);
        }
        if (message.duration !== '') {
            writer.uint32(74).string(message.duration);
        }
        if (message.forcetp !== 0) {
            writer.uint32(80).uint32(message.forcetp);
        }
        if (message.name !== '') {
            writer.uint32(90).string(message.name);
        }
        if (message.glidertype !== '') {
            writer.uint32(98).string(message.glidertype);
        }
        if (message.handicap !== 0) {
            writer.uint32(105).double(message.handicap);
        }
        if (message.image !== '') {
            writer.uint32(114).string(message.image);
        }
        if (message.daypoints !== 0) {
            writer.uint32(120).uint32(message.daypoints);
        }
        if (message.dayrank !== 0) {
            writer.uint32(128).uint32(message.dayrank);
        }
        if (message.dayrankordinal !== '') {
            writer.uint32(146).string(message.dayrankordinal);
        }
        if (message.country !== '') {
            writer.uint32(138).string(message.country);
        }
        if (message.prevtotalrank !== 0) {
            writer.uint32(152).uint32(message.prevtotalrank);
        }
        if (message.totalrank !== 0) {
            writer.uint32(160).uint32(message.totalrank);
        }
        if (message.hdistancedone !== 0) {
            writer.uint32(169).double(message.hdistancedone);
        }
        if (message.distancedone !== 0) {
            writer.uint32(177).double(message.distancedone);
        }
        if (message.speed !== 0) {
            writer.uint32(185).double(message.speed);
        }
        if (message.hspeed !== 0) {
            writer.uint32(193).double(message.hspeed);
        }
        if (message.maxdistancedone !== 0) {
            writer.uint32(200).uint32(message.maxdistancedone);
        }
        if (message.min !== 0) {
            writer.uint32(208).uint32(message.min);
        }
        if (message.max !== 0) {
            writer.uint32(216).uint32(message.max);
        }
        if (message.taskduration !== 0) {
            writer.uint32(224).uint32(message.taskduration);
        }
        if (message.lat !== 0) {
            writer.uint32(233).double(message.lat);
        }
        if (message.lng !== 0) {
            writer.uint32(241).double(message.lng);
        }
        if (message.altitude !== 0) {
            writer.uint32(248).uint32(message.altitude);
        }
        if (message.agl !== 0) {
            writer.uint32(256).uint32(message.agl);
        }
        if (message.lastUpdated !== 0) {
            writer.uint32(264).uint32(message.lastUpdated);
        }
        if (message.startFound === true) {
            writer.uint32(272).bool(message.startFound);
        }
        Object.entries(message.legs).forEach(([key, value]) => {
            PilotScore_LegsEntry.encode({key: key as any, value}, writer.uint32(290).fork()).ldelim();
        });
        if (message.lasttp !== 0) {
            writer.uint32(296).uint32(message.lasttp);
        }
        if (message.status !== '') {
            writer.uint32(306).string(message.status);
        }
        if (message.remainingdistance !== 0) {
            writer.uint32(313).double(message.remainingdistance);
        }
        if (message.hremainingdistance !== 0) {
            writer.uint32(321).double(message.hremainingdistance);
        }
        if (message.grremaining !== 0) {
            writer.uint32(328).uint32(message.grremaining);
        }
        if (message.hgrremaining !== 0) {
            writer.uint32(336).uint32(message.hgrremaining);
        }
        for (const v of message.stats) {
            Stats.encode(v!, writer.uint32(346).fork()).ldelim();
        }
        writer.uint32(418).fork();
        for (const v of message.scoredpoints) {
            writer.float(v);
        }
        writer.ldelim();
        if (message.gainXsecond !== 0) {
            writer.uint32(360).uint32(message.gainXsecond);
        }
        if (message.lossXsecond !== 0) {
            writer.uint32(368).uint32(message.lossXsecond);
        }
        if (message.Xperiod !== 0) {
            writer.uint32(376).uint32(message.Xperiod);
        }
        if (message.average !== 0) {
            writer.uint32(385).double(message.average);
        }
        if (message.total !== 0) {
            writer.uint32(392).uint32(message.total);
        }
        if (message.stationary === true) {
            writer.uint32(400).bool(message.stationary);
        }
        if (message.at !== 0) {
            writer.uint32(408).uint32(message.at);
        }
        if (message.task !== '') {
            writer.uint32(426).string(message.task);
        }
        if (message.wind !== undefined) {
            Wind.encode(message.wind, writer.uint32(450).fork()).ldelim();
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): PilotScore {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBasePilotScore();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.class = reader.string();
                    break;
                case 2:
                    message.compno = reader.string();
                    break;
                case 3:
                    message.dbstatus = reader.string();
                    break;
                case 4:
                    message.datafromscoring = reader.string();
                    break;
                case 5:
                    message.scoredstatus = reader.string();
                    break;
                case 6:
                    message.utcstart = reader.uint32();
                    break;
                case 54:
                    message.utcfinish = reader.uint32();
                    break;
                case 55:
                    message.utcduration = reader.uint32();
                    break;
                case 7:
                    message.start = reader.string();
                    break;
                case 8:
                    message.finish = reader.string();
                    break;
                case 9:
                    message.duration = reader.string();
                    break;
                case 10:
                    message.forcetp = reader.uint32();
                    break;
                case 11:
                    message.name = reader.string();
                    break;
                case 12:
                    message.glidertype = reader.string();
                    break;
                case 13:
                    message.handicap = reader.double();
                    break;
                case 14:
                    message.image = reader.string();
                    break;
                case 15:
                    message.daypoints = reader.uint32();
                    break;
                case 16:
                    message.dayrank = reader.uint32();
                    break;
                case 18:
                    message.dayrankordinal = reader.string();
                    break;
                case 17:
                    message.country = reader.string();
                    break;
                case 19:
                    message.prevtotalrank = reader.uint32();
                    break;
                case 20:
                    message.totalrank = reader.uint32();
                    break;
                case 21:
                    message.hdistancedone = reader.double();
                    break;
                case 22:
                    message.distancedone = reader.double();
                    break;
                case 23:
                    message.speed = reader.double();
                    break;
                case 24:
                    message.hspeed = reader.double();
                    break;
                case 25:
                    message.maxdistancedone = reader.uint32();
                    break;
                case 26:
                    message.min = reader.uint32();
                    break;
                case 27:
                    message.max = reader.uint32();
                    break;
                case 28:
                    message.taskduration = reader.uint32();
                    break;
                case 29:
                    message.lat = reader.double();
                    break;
                case 30:
                    message.lng = reader.double();
                    break;
                case 31:
                    message.altitude = reader.uint32();
                    break;
                case 32:
                    message.agl = reader.uint32();
                    break;
                case 33:
                    message.lastUpdated = reader.uint32();
                    break;
                case 34:
                    message.startFound = reader.bool();
                    break;
                case 36:
                    const entry36 = PilotScore_LegsEntry.decode(reader, reader.uint32());
                    if (entry36.value !== undefined) {
                        message.legs[entry36.key] = entry36.value;
                    }
                    break;
                case 37:
                    message.lasttp = reader.uint32();
                    break;
                case 38:
                    message.status = reader.string();
                    break;
                case 39:
                    message.remainingdistance = reader.double();
                    break;
                case 40:
                    message.hremainingdistance = reader.double();
                    break;
                case 41:
                    message.grremaining = reader.uint32();
                    break;
                case 42:
                    message.hgrremaining = reader.uint32();
                    break;
                case 43:
                    message.stats.push(Stats.decode(reader, reader.uint32()));
                    break;
                case 52:
                    if ((tag & 7) === 2) {
                        const end2 = reader.uint32() + reader.pos;
                        while (reader.pos < end2) {
                            message.scoredpoints.push(reader.float());
                        }
                    } else {
                        message.scoredpoints.push(reader.float());
                    }
                    break;
                case 45:
                    message.gainXsecond = reader.uint32();
                    break;
                case 46:
                    message.lossXsecond = reader.uint32();
                    break;
                case 47:
                    message.Xperiod = reader.uint32();
                    break;
                case 48:
                    message.average = reader.double();
                    break;
                case 49:
                    message.total = reader.uint32();
                    break;
                case 50:
                    message.stationary = reader.bool();
                    break;
                case 51:
                    message.at = reader.uint32();
                    break;
                case 53:
                    message.task = reader.string();
                    break;
                case 56:
                    message.wind = Wind.decode(reader, reader.uint32());
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): PilotScore {
        return {
            class: isSet(object.class) ? String(object.class) : '',
            compno: isSet(object.compno) ? String(object.compno) : '',
            dbstatus: isSet(object.dbstatus) ? String(object.dbstatus) : '',
            datafromscoring: isSet(object.datafromscoring) ? String(object.datafromscoring) : '',
            scoredstatus: isSet(object.scoredstatus) ? String(object.scoredstatus) : '',
            utcstart: isSet(object.utcstart) ? Number(object.utcstart) : 0,
            utcfinish: isSet(object.utcfinish) ? Number(object.utcfinish) : 0,
            utcduration: isSet(object.utcduration) ? Number(object.utcduration) : 0,
            start: isSet(object.start) ? String(object.start) : '',
            finish: isSet(object.finish) ? String(object.finish) : '',
            duration: isSet(object.duration) ? String(object.duration) : '',
            forcetp: isSet(object.forcetp) ? Number(object.forcetp) : 0,
            name: isSet(object.name) ? String(object.name) : '',
            glidertype: isSet(object.glidertype) ? String(object.glidertype) : '',
            handicap: isSet(object.handicap) ? Number(object.handicap) : 0,
            image: isSet(object.image) ? String(object.image) : '',
            daypoints: isSet(object.daypoints) ? Number(object.daypoints) : 0,
            dayrank: isSet(object.dayrank) ? Number(object.dayrank) : 0,
            dayrankordinal: isSet(object.dayrankordinal) ? String(object.dayrankordinal) : '',
            country: isSet(object.country) ? String(object.country) : '',
            prevtotalrank: isSet(object.prevtotalrank) ? Number(object.prevtotalrank) : 0,
            totalrank: isSet(object.totalrank) ? Number(object.totalrank) : 0,
            hdistancedone: isSet(object.hdistancedone) ? Number(object.hdistancedone) : 0,
            distancedone: isSet(object.distancedone) ? Number(object.distancedone) : 0,
            speed: isSet(object.speed) ? Number(object.speed) : 0,
            hspeed: isSet(object.hspeed) ? Number(object.hspeed) : 0,
            maxdistancedone: isSet(object.maxdistancedone) ? Number(object.maxdistancedone) : 0,
            min: isSet(object.min) ? Number(object.min) : 0,
            max: isSet(object.max) ? Number(object.max) : 0,
            taskduration: isSet(object.taskduration) ? Number(object.taskduration) : 0,
            lat: isSet(object.lat) ? Number(object.lat) : 0,
            lng: isSet(object.lng) ? Number(object.lng) : 0,
            altitude: isSet(object.altitude) ? Number(object.altitude) : 0,
            agl: isSet(object.agl) ? Number(object.agl) : 0,
            lastUpdated: isSet(object.lastUpdated) ? Number(object.lastUpdated) : 0,
            startFound: isSet(object.startFound) ? Boolean(object.startFound) : false,
            legs: isObject(object.legs)
                ? Object.entries(object.legs).reduce<{[key: number]: Legs}>((acc, [key, value]) => {
                      acc[Number(key)] = Legs.fromJSON(value);
                      return acc;
                  }, {})
                : {},
            lasttp: isSet(object.lasttp) ? Number(object.lasttp) : 0,
            status: isSet(object.status) ? String(object.status) : '',
            remainingdistance: isSet(object.remainingdistance) ? Number(object.remainingdistance) : 0,
            hremainingdistance: isSet(object.hremainingdistance) ? Number(object.hremainingdistance) : 0,
            grremaining: isSet(object.grremaining) ? Number(object.grremaining) : 0,
            hgrremaining: isSet(object.hgrremaining) ? Number(object.hgrremaining) : 0,
            stats: Array.isArray(object?.stats) ? object.stats.map((e: any) => Stats.fromJSON(e)) : [],
            scoredpoints: Array.isArray(object?.scoredpoints) ? object.scoredpoints.map((e: any) => Number(e)) : [],
            gainXsecond: isSet(object.gainXsecond) ? Number(object.gainXsecond) : 0,
            lossXsecond: isSet(object.lossXsecond) ? Number(object.lossXsecond) : 0,
            Xperiod: isSet(object.Xperiod) ? Number(object.Xperiod) : 0,
            average: isSet(object.average) ? Number(object.average) : 0,
            total: isSet(object.total) ? Number(object.total) : 0,
            stationary: isSet(object.stationary) ? Boolean(object.stationary) : false,
            at: isSet(object.at) ? Number(object.at) : 0,
            task: isSet(object.task) ? String(object.task) : '',
            wind: isSet(object.wind) ? Wind.fromJSON(object.wind) : undefined
        };
    },

    toJSON(message: PilotScore): unknown {
        const obj: any = {};
        message.class !== undefined && (obj.class = message.class);
        message.compno !== undefined && (obj.compno = message.compno);
        message.dbstatus !== undefined && (obj.dbstatus = message.dbstatus);
        message.datafromscoring !== undefined && (obj.datafromscoring = message.datafromscoring);
        message.scoredstatus !== undefined && (obj.scoredstatus = message.scoredstatus);
        message.utcstart !== undefined && (obj.utcstart = Math.round(message.utcstart));
        message.utcfinish !== undefined && (obj.utcfinish = Math.round(message.utcfinish));
        message.utcduration !== undefined && (obj.utcduration = Math.round(message.utcduration));
        message.start !== undefined && (obj.start = message.start);
        message.finish !== undefined && (obj.finish = message.finish);
        message.duration !== undefined && (obj.duration = message.duration);
        message.forcetp !== undefined && (obj.forcetp = Math.round(message.forcetp));
        message.name !== undefined && (obj.name = message.name);
        message.glidertype !== undefined && (obj.glidertype = message.glidertype);
        message.handicap !== undefined && (obj.handicap = message.handicap);
        message.image !== undefined && (obj.image = message.image);
        message.daypoints !== undefined && (obj.daypoints = Math.round(message.daypoints));
        message.dayrank !== undefined && (obj.dayrank = Math.round(message.dayrank));
        message.dayrankordinal !== undefined && (obj.dayrankordinal = message.dayrankordinal);
        message.country !== undefined && (obj.country = message.country);
        message.prevtotalrank !== undefined && (obj.prevtotalrank = Math.round(message.prevtotalrank));
        message.totalrank !== undefined && (obj.totalrank = Math.round(message.totalrank));
        message.hdistancedone !== undefined && (obj.hdistancedone = message.hdistancedone);
        message.distancedone !== undefined && (obj.distancedone = message.distancedone);
        message.speed !== undefined && (obj.speed = message.speed);
        message.hspeed !== undefined && (obj.hspeed = message.hspeed);
        message.maxdistancedone !== undefined && (obj.maxdistancedone = Math.round(message.maxdistancedone));
        message.min !== undefined && (obj.min = Math.round(message.min));
        message.max !== undefined && (obj.max = Math.round(message.max));
        message.taskduration !== undefined && (obj.taskduration = Math.round(message.taskduration));
        message.lat !== undefined && (obj.lat = message.lat);
        message.lng !== undefined && (obj.lng = message.lng);
        message.altitude !== undefined && (obj.altitude = Math.round(message.altitude));
        message.agl !== undefined && (obj.agl = Math.round(message.agl));
        message.lastUpdated !== undefined && (obj.lastUpdated = Math.round(message.lastUpdated));
        message.startFound !== undefined && (obj.startFound = message.startFound);
        obj.legs = {};
        if (message.legs) {
            Object.entries(message.legs).forEach(([k, v]) => {
                obj.legs[k] = Legs.toJSON(v);
            });
        }
        message.lasttp !== undefined && (obj.lasttp = Math.round(message.lasttp));
        message.status !== undefined && (obj.status = message.status);
        message.remainingdistance !== undefined && (obj.remainingdistance = message.remainingdistance);
        message.hremainingdistance !== undefined && (obj.hremainingdistance = message.hremainingdistance);
        message.grremaining !== undefined && (obj.grremaining = Math.round(message.grremaining));
        message.hgrremaining !== undefined && (obj.hgrremaining = Math.round(message.hgrremaining));
        if (message.stats) {
            obj.stats = message.stats.map((e) => (e ? Stats.toJSON(e) : undefined));
        } else {
            obj.stats = [];
        }
        if (message.scoredpoints) {
            obj.scoredpoints = message.scoredpoints.map((e) => e);
        } else {
            obj.scoredpoints = [];
        }
        message.gainXsecond !== undefined && (obj.gainXsecond = Math.round(message.gainXsecond));
        message.lossXsecond !== undefined && (obj.lossXsecond = Math.round(message.lossXsecond));
        message.Xperiod !== undefined && (obj.Xperiod = Math.round(message.Xperiod));
        message.average !== undefined && (obj.average = message.average);
        message.total !== undefined && (obj.total = Math.round(message.total));
        message.stationary !== undefined && (obj.stationary = message.stationary);
        message.at !== undefined && (obj.at = Math.round(message.at));
        message.task !== undefined && (obj.task = message.task);
        message.wind !== undefined && (obj.wind = message.wind ? Wind.toJSON(message.wind) : undefined);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<PilotScore>, I>>(object: I): PilotScore {
        const message = createBasePilotScore();
        message.class = object.class ?? '';
        message.compno = object.compno ?? '';
        message.dbstatus = object.dbstatus ?? '';
        message.datafromscoring = object.datafromscoring ?? '';
        message.scoredstatus = object.scoredstatus ?? '';
        message.utcstart = object.utcstart ?? 0;
        message.utcfinish = object.utcfinish ?? 0;
        message.utcduration = object.utcduration ?? 0;
        message.start = object.start ?? '';
        message.finish = object.finish ?? '';
        message.duration = object.duration ?? '';
        message.forcetp = object.forcetp ?? 0;
        message.name = object.name ?? '';
        message.glidertype = object.glidertype ?? '';
        message.handicap = object.handicap ?? 0;
        message.image = object.image ?? '';
        message.daypoints = object.daypoints ?? 0;
        message.dayrank = object.dayrank ?? 0;
        message.dayrankordinal = object.dayrankordinal ?? '';
        message.country = object.country ?? '';
        message.prevtotalrank = object.prevtotalrank ?? 0;
        message.totalrank = object.totalrank ?? 0;
        message.hdistancedone = object.hdistancedone ?? 0;
        message.distancedone = object.distancedone ?? 0;
        message.speed = object.speed ?? 0;
        message.hspeed = object.hspeed ?? 0;
        message.maxdistancedone = object.maxdistancedone ?? 0;
        message.min = object.min ?? 0;
        message.max = object.max ?? 0;
        message.taskduration = object.taskduration ?? 0;
        message.lat = object.lat ?? 0;
        message.lng = object.lng ?? 0;
        message.altitude = object.altitude ?? 0;
        message.agl = object.agl ?? 0;
        message.lastUpdated = object.lastUpdated ?? 0;
        message.startFound = object.startFound ?? false;
        message.legs = Object.entries(object.legs ?? {}).reduce<{[key: number]: Legs}>((acc, [key, value]) => {
            if (value !== undefined) {
                acc[Number(key)] = Legs.fromPartial(value);
            }
            return acc;
        }, {});
        message.lasttp = object.lasttp ?? 0;
        message.status = object.status ?? '';
        message.remainingdistance = object.remainingdistance ?? 0;
        message.hremainingdistance = object.hremainingdistance ?? 0;
        message.grremaining = object.grremaining ?? 0;
        message.hgrremaining = object.hgrremaining ?? 0;
        message.stats = object.stats?.map((e) => Stats.fromPartial(e)) || [];
        message.scoredpoints = object.scoredpoints?.map((e) => e) || [];
        message.gainXsecond = object.gainXsecond ?? 0;
        message.lossXsecond = object.lossXsecond ?? 0;
        message.Xperiod = object.Xperiod ?? 0;
        message.average = object.average ?? 0;
        message.total = object.total ?? 0;
        message.stationary = object.stationary ?? false;
        message.at = object.at ?? 0;
        message.task = object.task ?? '';
        message.wind = object.wind !== undefined && object.wind !== null ? Wind.fromPartial(object.wind) : undefined;
        return message;
    }
};

function createBasePilotScore_LegsEntry(): PilotScore_LegsEntry {
    return {key: 0, value: undefined};
}

export const PilotScore_LegsEntry = {
    encode(message: PilotScore_LegsEntry, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.key !== 0) {
            writer.uint32(8).uint32(message.key);
        }
        if (message.value !== undefined) {
            Legs.encode(message.value, writer.uint32(18).fork()).ldelim();
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): PilotScore_LegsEntry {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBasePilotScore_LegsEntry();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.key = reader.uint32();
                    break;
                case 2:
                    message.value = Legs.decode(reader, reader.uint32());
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): PilotScore_LegsEntry {
        return {
            key: isSet(object.key) ? Number(object.key) : 0,
            value: isSet(object.value) ? Legs.fromJSON(object.value) : undefined
        };
    },

    toJSON(message: PilotScore_LegsEntry): unknown {
        const obj: any = {};
        message.key !== undefined && (obj.key = Math.round(message.key));
        message.value !== undefined && (obj.value = message.value ? Legs.toJSON(message.value) : undefined);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<PilotScore_LegsEntry>, I>>(object: I): PilotScore_LegsEntry {
        const message = createBasePilotScore_LegsEntry();
        message.key = object.key ?? 0;
        message.value = object.value !== undefined && object.value !== null ? Legs.fromPartial(object.value) : undefined;
        return message;
    }
};

function createBasePositions(): Positions {
    return {positions: []};
}

export const Positions = {
    encode(message: Positions, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        for (const v of message.positions) {
            PilotPositions.encode(v!, writer.uint32(10).fork()).ldelim();
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): Positions {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBasePositions();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.positions.push(PilotPositions.decode(reader, reader.uint32()));
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): Positions {
        return {
            positions: Array.isArray(object?.positions) ? object.positions.map((e: any) => PilotPositions.fromJSON(e)) : []
        };
    },

    toJSON(message: Positions): unknown {
        const obj: any = {};
        if (message.positions) {
            obj.positions = message.positions.map((e) => (e ? PilotPositions.toJSON(e) : undefined));
        } else {
            obj.positions = [];
        }
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<Positions>, I>>(object: I): Positions {
        const message = createBasePositions();
        message.positions = object.positions?.map((e) => PilotPositions.fromPartial(e)) || [];
        return message;
    }
};

function createBasePilotPositions(): PilotPositions {
    return {c: '', lat: 0, lng: 0, a: 0, g: 0, t: 0, b: 0, s: 0, v: ''};
}

export const PilotPositions = {
    encode(message: PilotPositions, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.c !== '') {
            writer.uint32(10).string(message.c);
        }
        if (message.lat !== 0) {
            writer.uint32(17).double(message.lat);
        }
        if (message.lng !== 0) {
            writer.uint32(25).double(message.lng);
        }
        if (message.a !== 0) {
            writer.uint32(32).uint32(message.a);
        }
        if (message.g !== 0) {
            writer.uint32(40).uint32(message.g);
        }
        if (message.t !== 0) {
            writer.uint32(48).uint32(message.t);
        }
        if (message.b !== 0) {
            writer.uint32(56).uint32(message.b);
        }
        if (message.s !== 0) {
            writer.uint32(64).uint32(message.s);
        }
        if (message.v !== '') {
            writer.uint32(74).string(message.v);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): PilotPositions {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBasePilotPositions();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.c = reader.string();
                    break;
                case 2:
                    message.lat = reader.double();
                    break;
                case 3:
                    message.lng = reader.double();
                    break;
                case 4:
                    message.a = reader.uint32();
                    break;
                case 5:
                    message.g = reader.uint32();
                    break;
                case 6:
                    message.t = reader.uint32();
                    break;
                case 7:
                    message.b = reader.uint32();
                    break;
                case 8:
                    message.s = reader.uint32();
                    break;
                case 9:
                    message.v = reader.string();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): PilotPositions {
        return {
            c: isSet(object.c) ? String(object.c) : '',
            lat: isSet(object.lat) ? Number(object.lat) : 0,
            lng: isSet(object.lng) ? Number(object.lng) : 0,
            a: isSet(object.a) ? Number(object.a) : 0,
            g: isSet(object.g) ? Number(object.g) : 0,
            t: isSet(object.t) ? Number(object.t) : 0,
            b: isSet(object.b) ? Number(object.b) : 0,
            s: isSet(object.s) ? Number(object.s) : 0,
            v: isSet(object.v) ? String(object.v) : ''
        };
    },

    toJSON(message: PilotPositions): unknown {
        const obj: any = {};
        message.c !== undefined && (obj.c = message.c);
        message.lat !== undefined && (obj.lat = message.lat);
        message.lng !== undefined && (obj.lng = message.lng);
        message.a !== undefined && (obj.a = Math.round(message.a));
        message.g !== undefined && (obj.g = Math.round(message.g));
        message.t !== undefined && (obj.t = Math.round(message.t));
        message.b !== undefined && (obj.b = Math.round(message.b));
        message.s !== undefined && (obj.s = Math.round(message.s));
        message.v !== undefined && (obj.v = message.v);
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<PilotPositions>, I>>(object: I): PilotPositions {
        const message = createBasePilotPositions();
        message.c = object.c ?? '';
        message.lat = object.lat ?? 0;
        message.lng = object.lng ?? 0;
        message.a = object.a ?? 0;
        message.g = object.g ?? 0;
        message.t = object.t ?? 0;
        message.b = object.b ?? 0;
        message.s = object.s ?? 0;
        message.v = object.v ?? '';
        return message;
    }
};

function createBaseKeepAlive(): KeepAlive {
    return {keepalive: false, t: '', at: 0, listeners: 0, airborne: 0};
}

export const KeepAlive = {
    encode(message: KeepAlive, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
        if (message.keepalive === true) {
            writer.uint32(8).bool(message.keepalive);
        }
        if (message.t !== '') {
            writer.uint32(18).string(message.t);
        }
        if (message.at !== 0) {
            writer.uint32(24).uint32(message.at);
        }
        if (message.listeners !== 0) {
            writer.uint32(32).uint32(message.listeners);
        }
        if (message.airborne !== 0) {
            writer.uint32(40).uint32(message.airborne);
        }
        return writer;
    },

    decode(input: _m0.Reader | Uint8Array, length?: number): KeepAlive {
        const reader = input instanceof _m0.Reader ? input : new _m0.Reader(input);
        let end = length === undefined ? reader.len : reader.pos + length;
        const message = createBaseKeepAlive();
        while (reader.pos < end) {
            const tag = reader.uint32();
            switch (tag >>> 3) {
                case 1:
                    message.keepalive = reader.bool();
                    break;
                case 2:
                    message.t = reader.string();
                    break;
                case 3:
                    message.at = reader.uint32();
                    break;
                case 4:
                    message.listeners = reader.uint32();
                    break;
                case 5:
                    message.airborne = reader.uint32();
                    break;
                default:
                    reader.skipType(tag & 7);
                    break;
            }
        }
        return message;
    },

    fromJSON(object: any): KeepAlive {
        return {
            keepalive: isSet(object.keepalive) ? Boolean(object.keepalive) : false,
            t: isSet(object.t) ? String(object.t) : '',
            at: isSet(object.at) ? Number(object.at) : 0,
            listeners: isSet(object.listeners) ? Number(object.listeners) : 0,
            airborne: isSet(object.airborne) ? Number(object.airborne) : 0
        };
    },

    toJSON(message: KeepAlive): unknown {
        const obj: any = {};
        message.keepalive !== undefined && (obj.keepalive = message.keepalive);
        message.t !== undefined && (obj.t = message.t);
        message.at !== undefined && (obj.at = Math.round(message.at));
        message.listeners !== undefined && (obj.listeners = Math.round(message.listeners));
        message.airborne !== undefined && (obj.airborne = Math.round(message.airborne));
        return obj;
    },

    fromPartial<I extends Exact<DeepPartial<KeepAlive>, I>>(object: I): KeepAlive {
        const message = createBaseKeepAlive();
        message.keepalive = object.keepalive ?? false;
        message.t = object.t ?? '';
        message.at = object.at ?? 0;
        message.listeners = object.listeners ?? 0;
        message.airborne = object.airborne ?? 0;
        return message;
    }
};

declare var self: any | undefined;
declare var window: any | undefined;
declare var global: any | undefined;
var globalThis: any = (() => {
    if (typeof globalThis !== 'undefined') return globalThis;
    if (typeof self !== 'undefined') return self;
    if (typeof window !== 'undefined') return window;
    if (typeof global !== 'undefined') return global;
    throw 'Unable to locate global object';
})();

const atob: (b64: string) => string = globalThis.atob || ((b64) => globalThis.Buffer.from(b64, 'base64').toString('binary'));
function bytesFromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; ++i) {
        arr[i] = bin.charCodeAt(i);
    }
    return arr;
}

const btoa: (bin: string) => string = globalThis.btoa || ((bin) => globalThis.Buffer.from(bin, 'binary').toString('base64'));
function base64FromBytes(arr: Uint8Array): string {
    const bin: string[] = [];
    arr.forEach((byte) => {
        bin.push(String.fromCharCode(byte));
    });
    return btoa(bin.join(''));
}

type Builtin = Date | Function | Uint8Array | string | number | boolean | undefined;

export type DeepPartial<T> = T extends Builtin ? T : T extends Array<infer U> ? Array<DeepPartial<U>> : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>> : T extends {} ? {[K in keyof T]?: DeepPartial<T[K]>} : Partial<T>;

type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P : P & {[K in keyof P]: Exact<P[K], I[K]>} & Record<Exclude<keyof I, KeysOfUnion<P>>, never>;

function isObject(value: any): boolean {
    return typeof value === 'object' && value !== null;
}

function isSet(value: any): boolean {
    return value !== null && value !== undefined;
}
