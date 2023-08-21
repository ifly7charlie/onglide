/* eslint-disable */
import * as _m0 from "protobufjs/minimal";

export const protobufPackage = "";

/** import "google/protobuf/any.proto"; */

export interface OnglideWebSocketMessage {
  tracks?: PilotTracks | undefined;
  scores?: Scores | undefined;
  positions?: Positions | undefined;
  ka?: KeepAlive | undefined;
  t?: number | undefined;
}

export interface PilotTracks {
  pilots: { [key: string]: PilotTrack };
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
  /**
   * Segments in the track line, for broken track drawing (actually uint32)
   *    uint32 segmentIndex = 5;
   *    bytes indices = 6;
   */
  agl: Uint8Array;
  /** For colouring, all Uint8 arrays one for each point all optional */
  climbRate: Uint8Array;
  /** Does this contain a full trace or just the most recent trace */
  partial?: boolean | undefined;
}

export interface Scores {
  pilots: { [key: string]: PilotScore };
}

export interface Scores_PilotsEntry {
  key: string;
  value: PilotScore | undefined;
}

export interface SpeedDist {
  /** done distance on this leg */
  distance?:
    | number
    | undefined;
  /** done distance on whole task */
  taskDistance: number;
  /** Speed */
  distanceRemaining?:
    | number
    | undefined;
  /** AAT */
  maxPossible?: number | undefined;
  minPossible?: number | undefined;
  grRemaining?:
    | number
    | undefined;
  /** speed on this leg */
  legSpeed?:
    | number
    | undefined;
  /** speed on task to end of leg */
  taskSpeed?: number | undefined;
}

export interface PilotScoreLeg {
  legno: number;
  time: number;
  /** time from previous point to this one */
  duration?:
    | number
    | undefined;
  /** time from start to this */
  taskDuration?: number | undefined;
  point?: BasePositionMessage | undefined;
  alt?: number | undefined;
  agl?: number | undefined;
  estimatedEnd?: boolean | undefined;
  estimatedStart?: boolean | undefined;
  inPenalty?:
    | boolean
    | undefined;
  /** Scores */
  handicapped?: SpeedDist | undefined;
  actual?: SpeedDist | undefined;
}

export interface Wind {
  speed: number;
  direction: number;
}

/** A segment of the flight */
export interface StatSegment {
  /** Epoch */
  start: number;
  /** Epoch */
  end: number;
  /** Type of segment */
  state: string;
  /** Wind for segment */
  wind:
    | Wind
    | undefined;
  /** Number of turns */
  turncount: number;
  /** Distance (ground not task) */
  distance: number;
  /** From first point to last point - straight */
  achievedDistance: number;
  /** height delta? */
  delta: number;
  avgDelta: number;
  /** left or right */
  direction: number;
  /** gain m */
  heightgain: number;
  /** loss m */
  heightloss: number;
}

export interface Stats {
  segments: StatSegment[];
}

export interface BasePositionMessage {
  t: number;
  lat: number;
  lng: number;
}

/** Scores for each pilot */
export interface PilotScore {
  /** timestamp */
  t: number;
  /** Pilot details */
  compno: string;
  /** Start/Finish details */
  utcStart: number;
  utcFinish: number;
  /** scored to when */
  taskDuration?:
    | number
    | undefined;
  /** how many seconds remaining on an aat, will be negative if under time */
  taskTimeRemaining?:
    | number
    | undefined;
  /** bool startFound = 6; */
  inSector?: boolean | undefined;
  inPenalty?: boolean | undefined;
  stationary?:
    | boolean
    | undefined;
  /** What phase of flight (see PositionStatus in types.ts) */
  flightStatus?:
    | number
    | undefined;
  /** Scores */
  actual?: SpeedDist | undefined;
  handicapped?:
    | SpeedDist
    | undefined;
  /** Leg details */
  currentLeg: number;
  legs: { [key: number]: PilotScoreLeg };
  /** If we are generating statistics then include that */
  stats?: Stats | undefined;
  wind?:
    | Wind
    | undefined;
  /** List of points [x,y,actualDistance,hcapDistance,x,y,actualDistance,hcapDistance,x,y,actualDistance,hcapDistance] */
  scoredPoints: number[];
  minDistancePoints: number[];
  maxDistancePoints: number[];
  /** For DH we have a specific task for the pilot */
  taskGeoJSON?: string | undefined;
}

export interface PilotScore_LegsEntry {
  key: number;
  value: PilotScoreLeg | undefined;
}

/** This message is generate position updates for the pilots */
export interface PilotPosition {
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

export interface Positions {
  positions: PilotPosition[];
}

/** Are we connected? */
export interface KeepAlive {
  keepalive: boolean;
  at: number;
  listeners: number;
  airborne: number;
}

function createBaseOnglideWebSocketMessage(): OnglideWebSocketMessage {
  return { tracks: undefined, scores: undefined, positions: undefined, ka: undefined, t: undefined };
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
    if (message.t !== undefined) {
      writer.uint32(40).uint32(message.t);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): OnglideWebSocketMessage {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseOnglideWebSocketMessage();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.tracks = PilotTracks.decode(reader, reader.uint32());
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.scores = Scores.decode(reader, reader.uint32());
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.positions = Positions.decode(reader, reader.uint32());
          continue;
        case 4:
          if (tag !== 34) {
            break;
          }

          message.ka = KeepAlive.decode(reader, reader.uint32());
          continue;
        case 5:
          if (tag !== 40) {
            break;
          }

          message.t = reader.uint32();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): OnglideWebSocketMessage {
    return {
      tracks: isSet(object.tracks) ? PilotTracks.fromJSON(object.tracks) : undefined,
      scores: isSet(object.scores) ? Scores.fromJSON(object.scores) : undefined,
      positions: isSet(object.positions) ? Positions.fromJSON(object.positions) : undefined,
      ka: isSet(object.ka) ? KeepAlive.fromJSON(object.ka) : undefined,
      t: isSet(object.t) ? Number(object.t) : undefined,
    };
  },

  toJSON(message: OnglideWebSocketMessage): unknown {
    const obj: any = {};
    if (message.tracks !== undefined) {
      obj.tracks = PilotTracks.toJSON(message.tracks);
    }
    if (message.scores !== undefined) {
      obj.scores = Scores.toJSON(message.scores);
    }
    if (message.positions !== undefined) {
      obj.positions = Positions.toJSON(message.positions);
    }
    if (message.ka !== undefined) {
      obj.ka = KeepAlive.toJSON(message.ka);
    }
    if (message.t !== undefined) {
      obj.t = Math.round(message.t);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<OnglideWebSocketMessage>, I>>(base?: I): OnglideWebSocketMessage {
    return OnglideWebSocketMessage.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<OnglideWebSocketMessage>, I>>(object: I): OnglideWebSocketMessage {
    const message = createBaseOnglideWebSocketMessage();
    message.tracks = (object.tracks !== undefined && object.tracks !== null)
      ? PilotTracks.fromPartial(object.tracks)
      : undefined;
    message.scores = (object.scores !== undefined && object.scores !== null)
      ? Scores.fromPartial(object.scores)
      : undefined;
    message.positions = (object.positions !== undefined && object.positions !== null)
      ? Positions.fromPartial(object.positions)
      : undefined;
    message.ka = (object.ka !== undefined && object.ka !== null) ? KeepAlive.fromPartial(object.ka) : undefined;
    message.t = object.t ?? undefined;
    return message;
  },
};

function createBasePilotTracks(): PilotTracks {
  return { pilots: {} };
}

export const PilotTracks = {
  encode(message: PilotTracks, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    Object.entries(message.pilots).forEach(([key, value]) => {
      PilotTracks_PilotsEntry.encode({ key: key as any, value }, writer.uint32(10).fork()).ldelim();
    });
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): PilotTracks {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePilotTracks();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          const entry1 = PilotTracks_PilotsEntry.decode(reader, reader.uint32());
          if (entry1.value !== undefined) {
            message.pilots[entry1.key] = entry1.value;
          }
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): PilotTracks {
    return {
      pilots: isObject(object.pilots)
        ? Object.entries(object.pilots).reduce<{ [key: string]: PilotTrack }>((acc, [key, value]) => {
          acc[key] = PilotTrack.fromJSON(value);
          return acc;
        }, {})
        : {},
    };
  },

  toJSON(message: PilotTracks): unknown {
    const obj: any = {};
    if (message.pilots) {
      const entries = Object.entries(message.pilots);
      if (entries.length > 0) {
        obj.pilots = {};
        entries.forEach(([k, v]) => {
          obj.pilots[k] = PilotTrack.toJSON(v);
        });
      }
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<PilotTracks>, I>>(base?: I): PilotTracks {
    return PilotTracks.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<PilotTracks>, I>>(object: I): PilotTracks {
    const message = createBasePilotTracks();
    message.pilots = Object.entries(object.pilots ?? {}).reduce<{ [key: string]: PilotTrack }>((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = PilotTrack.fromPartial(value);
      }
      return acc;
    }, {});
    return message;
  },
};

function createBasePilotTracks_PilotsEntry(): PilotTracks_PilotsEntry {
  return { key: "", value: undefined };
}

export const PilotTracks_PilotsEntry = {
  encode(message: PilotTracks_PilotsEntry, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.key !== "") {
      writer.uint32(10).string(message.key);
    }
    if (message.value !== undefined) {
      PilotTrack.encode(message.value, writer.uint32(18).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): PilotTracks_PilotsEntry {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePilotTracks_PilotsEntry();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.key = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.value = PilotTrack.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): PilotTracks_PilotsEntry {
    return {
      key: isSet(object.key) ? String(object.key) : "",
      value: isSet(object.value) ? PilotTrack.fromJSON(object.value) : undefined,
    };
  },

  toJSON(message: PilotTracks_PilotsEntry): unknown {
    const obj: any = {};
    if (message.key !== "") {
      obj.key = message.key;
    }
    if (message.value !== undefined) {
      obj.value = PilotTrack.toJSON(message.value);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<PilotTracks_PilotsEntry>, I>>(base?: I): PilotTracks_PilotsEntry {
    return PilotTracks_PilotsEntry.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<PilotTracks_PilotsEntry>, I>>(object: I): PilotTracks_PilotsEntry {
    const message = createBasePilotTracks_PilotsEntry();
    message.key = object.key ?? "";
    message.value = (object.value !== undefined && object.value !== null)
      ? PilotTrack.fromPartial(object.value)
      : undefined;
    return message;
  },
};

function createBasePilotTrack(): PilotTrack {
  return {
    compno: "",
    posIndex: 0,
    t: new Uint8Array(0),
    positions: new Uint8Array(0),
    agl: new Uint8Array(0),
    climbRate: new Uint8Array(0),
    partial: undefined,
  };
}

export const PilotTrack = {
  encode(message: PilotTrack, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.compno !== "") {
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
    if (message.agl.length !== 0) {
      writer.uint32(98).bytes(message.agl);
    }
    if (message.climbRate.length !== 0) {
      writer.uint32(66).bytes(message.climbRate);
    }
    if (message.partial !== undefined) {
      writer.uint32(104).bool(message.partial);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): PilotTrack {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePilotTrack();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.compno = reader.string();
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.posIndex = reader.uint32();
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.t = reader.bytes();
          continue;
        case 4:
          if (tag !== 34) {
            break;
          }

          message.positions = reader.bytes();
          continue;
        case 12:
          if (tag !== 98) {
            break;
          }

          message.agl = reader.bytes();
          continue;
        case 8:
          if (tag !== 66) {
            break;
          }

          message.climbRate = reader.bytes();
          continue;
        case 13:
          if (tag !== 104) {
            break;
          }

          message.partial = reader.bool();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): PilotTrack {
    return {
      compno: isSet(object.compno) ? String(object.compno) : "",
      posIndex: isSet(object.posIndex) ? Number(object.posIndex) : 0,
      t: isSet(object.t) ? bytesFromBase64(object.t) : new Uint8Array(0),
      positions: isSet(object.positions) ? bytesFromBase64(object.positions) : new Uint8Array(0),
      agl: isSet(object.agl) ? bytesFromBase64(object.agl) : new Uint8Array(0),
      climbRate: isSet(object.climbRate) ? bytesFromBase64(object.climbRate) : new Uint8Array(0),
      partial: isSet(object.partial) ? Boolean(object.partial) : undefined,
    };
  },

  toJSON(message: PilotTrack): unknown {
    const obj: any = {};
    if (message.compno !== "") {
      obj.compno = message.compno;
    }
    if (message.posIndex !== 0) {
      obj.posIndex = Math.round(message.posIndex);
    }
    if (message.t.length !== 0) {
      obj.t = base64FromBytes(message.t);
    }
    if (message.positions.length !== 0) {
      obj.positions = base64FromBytes(message.positions);
    }
    if (message.agl.length !== 0) {
      obj.agl = base64FromBytes(message.agl);
    }
    if (message.climbRate.length !== 0) {
      obj.climbRate = base64FromBytes(message.climbRate);
    }
    if (message.partial !== undefined) {
      obj.partial = message.partial;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<PilotTrack>, I>>(base?: I): PilotTrack {
    return PilotTrack.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<PilotTrack>, I>>(object: I): PilotTrack {
    const message = createBasePilotTrack();
    message.compno = object.compno ?? "";
    message.posIndex = object.posIndex ?? 0;
    message.t = object.t ?? new Uint8Array(0);
    message.positions = object.positions ?? new Uint8Array(0);
    message.agl = object.agl ?? new Uint8Array(0);
    message.climbRate = object.climbRate ?? new Uint8Array(0);
    message.partial = object.partial ?? undefined;
    return message;
  },
};

function createBaseScores(): Scores {
  return { pilots: {} };
}

export const Scores = {
  encode(message: Scores, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    Object.entries(message.pilots).forEach(([key, value]) => {
      Scores_PilotsEntry.encode({ key: key as any, value }, writer.uint32(10).fork()).ldelim();
    });
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Scores {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseScores();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          const entry1 = Scores_PilotsEntry.decode(reader, reader.uint32());
          if (entry1.value !== undefined) {
            message.pilots[entry1.key] = entry1.value;
          }
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Scores {
    return {
      pilots: isObject(object.pilots)
        ? Object.entries(object.pilots).reduce<{ [key: string]: PilotScore }>((acc, [key, value]) => {
          acc[key] = PilotScore.fromJSON(value);
          return acc;
        }, {})
        : {},
    };
  },

  toJSON(message: Scores): unknown {
    const obj: any = {};
    if (message.pilots) {
      const entries = Object.entries(message.pilots);
      if (entries.length > 0) {
        obj.pilots = {};
        entries.forEach(([k, v]) => {
          obj.pilots[k] = PilotScore.toJSON(v);
        });
      }
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Scores>, I>>(base?: I): Scores {
    return Scores.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Scores>, I>>(object: I): Scores {
    const message = createBaseScores();
    message.pilots = Object.entries(object.pilots ?? {}).reduce<{ [key: string]: PilotScore }>((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = PilotScore.fromPartial(value);
      }
      return acc;
    }, {});
    return message;
  },
};

function createBaseScores_PilotsEntry(): Scores_PilotsEntry {
  return { key: "", value: undefined };
}

export const Scores_PilotsEntry = {
  encode(message: Scores_PilotsEntry, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.key !== "") {
      writer.uint32(10).string(message.key);
    }
    if (message.value !== undefined) {
      PilotScore.encode(message.value, writer.uint32(18).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Scores_PilotsEntry {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseScores_PilotsEntry();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.key = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.value = PilotScore.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Scores_PilotsEntry {
    return {
      key: isSet(object.key) ? String(object.key) : "",
      value: isSet(object.value) ? PilotScore.fromJSON(object.value) : undefined,
    };
  },

  toJSON(message: Scores_PilotsEntry): unknown {
    const obj: any = {};
    if (message.key !== "") {
      obj.key = message.key;
    }
    if (message.value !== undefined) {
      obj.value = PilotScore.toJSON(message.value);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Scores_PilotsEntry>, I>>(base?: I): Scores_PilotsEntry {
    return Scores_PilotsEntry.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Scores_PilotsEntry>, I>>(object: I): Scores_PilotsEntry {
    const message = createBaseScores_PilotsEntry();
    message.key = object.key ?? "";
    message.value = (object.value !== undefined && object.value !== null)
      ? PilotScore.fromPartial(object.value)
      : undefined;
    return message;
  },
};

function createBaseSpeedDist(): SpeedDist {
  return {
    distance: undefined,
    taskDistance: 0,
    distanceRemaining: undefined,
    maxPossible: undefined,
    minPossible: undefined,
    grRemaining: undefined,
    legSpeed: undefined,
    taskSpeed: undefined,
  };
}

export const SpeedDist = {
  encode(message: SpeedDist, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.distance !== undefined) {
      writer.uint32(9).double(message.distance);
    }
    if (message.taskDistance !== 0) {
      writer.uint32(17).double(message.taskDistance);
    }
    if (message.distanceRemaining !== undefined) {
      writer.uint32(89).double(message.distanceRemaining);
    }
    if (message.maxPossible !== undefined) {
      writer.uint32(97).double(message.maxPossible);
    }
    if (message.minPossible !== undefined) {
      writer.uint32(105).double(message.minPossible);
    }
    if (message.grRemaining !== undefined) {
      writer.uint32(160).uint32(message.grRemaining);
    }
    if (message.legSpeed !== undefined) {
      writer.uint32(241).double(message.legSpeed);
    }
    if (message.taskSpeed !== undefined) {
      writer.uint32(249).double(message.taskSpeed);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): SpeedDist {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSpeedDist();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 9) {
            break;
          }

          message.distance = reader.double();
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.taskDistance = reader.double();
          continue;
        case 11:
          if (tag !== 89) {
            break;
          }

          message.distanceRemaining = reader.double();
          continue;
        case 12:
          if (tag !== 97) {
            break;
          }

          message.maxPossible = reader.double();
          continue;
        case 13:
          if (tag !== 105) {
            break;
          }

          message.minPossible = reader.double();
          continue;
        case 20:
          if (tag !== 160) {
            break;
          }

          message.grRemaining = reader.uint32();
          continue;
        case 30:
          if (tag !== 241) {
            break;
          }

          message.legSpeed = reader.double();
          continue;
        case 31:
          if (tag !== 249) {
            break;
          }

          message.taskSpeed = reader.double();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): SpeedDist {
    return {
      distance: isSet(object.distance) ? Number(object.distance) : undefined,
      taskDistance: isSet(object.taskDistance) ? Number(object.taskDistance) : 0,
      distanceRemaining: isSet(object.distanceRemaining) ? Number(object.distanceRemaining) : undefined,
      maxPossible: isSet(object.maxPossible) ? Number(object.maxPossible) : undefined,
      minPossible: isSet(object.minPossible) ? Number(object.minPossible) : undefined,
      grRemaining: isSet(object.grRemaining) ? Number(object.grRemaining) : undefined,
      legSpeed: isSet(object.legSpeed) ? Number(object.legSpeed) : undefined,
      taskSpeed: isSet(object.taskSpeed) ? Number(object.taskSpeed) : undefined,
    };
  },

  toJSON(message: SpeedDist): unknown {
    const obj: any = {};
    if (message.distance !== undefined) {
      obj.distance = message.distance;
    }
    if (message.taskDistance !== 0) {
      obj.taskDistance = message.taskDistance;
    }
    if (message.distanceRemaining !== undefined) {
      obj.distanceRemaining = message.distanceRemaining;
    }
    if (message.maxPossible !== undefined) {
      obj.maxPossible = message.maxPossible;
    }
    if (message.minPossible !== undefined) {
      obj.minPossible = message.minPossible;
    }
    if (message.grRemaining !== undefined) {
      obj.grRemaining = Math.round(message.grRemaining);
    }
    if (message.legSpeed !== undefined) {
      obj.legSpeed = message.legSpeed;
    }
    if (message.taskSpeed !== undefined) {
      obj.taskSpeed = message.taskSpeed;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<SpeedDist>, I>>(base?: I): SpeedDist {
    return SpeedDist.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<SpeedDist>, I>>(object: I): SpeedDist {
    const message = createBaseSpeedDist();
    message.distance = object.distance ?? undefined;
    message.taskDistance = object.taskDistance ?? 0;
    message.distanceRemaining = object.distanceRemaining ?? undefined;
    message.maxPossible = object.maxPossible ?? undefined;
    message.minPossible = object.minPossible ?? undefined;
    message.grRemaining = object.grRemaining ?? undefined;
    message.legSpeed = object.legSpeed ?? undefined;
    message.taskSpeed = object.taskSpeed ?? undefined;
    return message;
  },
};

function createBasePilotScoreLeg(): PilotScoreLeg {
  return {
    legno: 0,
    time: 0,
    duration: undefined,
    taskDuration: undefined,
    point: undefined,
    alt: undefined,
    agl: undefined,
    estimatedEnd: undefined,
    estimatedStart: undefined,
    inPenalty: undefined,
    handicapped: undefined,
    actual: undefined,
  };
}

export const PilotScoreLeg = {
  encode(message: PilotScoreLeg, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.legno !== 0) {
      writer.uint32(8).uint32(message.legno);
    }
    if (message.time !== 0) {
      writer.uint32(16).uint32(message.time);
    }
    if (message.duration !== undefined) {
      writer.uint32(24).uint32(message.duration);
    }
    if (message.taskDuration !== undefined) {
      writer.uint32(32).uint32(message.taskDuration);
    }
    if (message.point !== undefined) {
      BasePositionMessage.encode(message.point, writer.uint32(42).fork()).ldelim();
    }
    if (message.alt !== undefined) {
      writer.uint32(48).uint32(message.alt);
    }
    if (message.agl !== undefined) {
      writer.uint32(56).uint32(message.agl);
    }
    if (message.estimatedEnd !== undefined) {
      writer.uint32(64).bool(message.estimatedEnd);
    }
    if (message.estimatedStart !== undefined) {
      writer.uint32(72).bool(message.estimatedStart);
    }
    if (message.inPenalty !== undefined) {
      writer.uint32(80).bool(message.inPenalty);
    }
    if (message.handicapped !== undefined) {
      SpeedDist.encode(message.handicapped, writer.uint32(90).fork()).ldelim();
    }
    if (message.actual !== undefined) {
      SpeedDist.encode(message.actual, writer.uint32(98).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): PilotScoreLeg {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePilotScoreLeg();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.legno = reader.uint32();
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.time = reader.uint32();
          continue;
        case 3:
          if (tag !== 24) {
            break;
          }

          message.duration = reader.uint32();
          continue;
        case 4:
          if (tag !== 32) {
            break;
          }

          message.taskDuration = reader.uint32();
          continue;
        case 5:
          if (tag !== 42) {
            break;
          }

          message.point = BasePositionMessage.decode(reader, reader.uint32());
          continue;
        case 6:
          if (tag !== 48) {
            break;
          }

          message.alt = reader.uint32();
          continue;
        case 7:
          if (tag !== 56) {
            break;
          }

          message.agl = reader.uint32();
          continue;
        case 8:
          if (tag !== 64) {
            break;
          }

          message.estimatedEnd = reader.bool();
          continue;
        case 9:
          if (tag !== 72) {
            break;
          }

          message.estimatedStart = reader.bool();
          continue;
        case 10:
          if (tag !== 80) {
            break;
          }

          message.inPenalty = reader.bool();
          continue;
        case 11:
          if (tag !== 90) {
            break;
          }

          message.handicapped = SpeedDist.decode(reader, reader.uint32());
          continue;
        case 12:
          if (tag !== 98) {
            break;
          }

          message.actual = SpeedDist.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): PilotScoreLeg {
    return {
      legno: isSet(object.legno) ? Number(object.legno) : 0,
      time: isSet(object.time) ? Number(object.time) : 0,
      duration: isSet(object.duration) ? Number(object.duration) : undefined,
      taskDuration: isSet(object.taskDuration) ? Number(object.taskDuration) : undefined,
      point: isSet(object.point) ? BasePositionMessage.fromJSON(object.point) : undefined,
      alt: isSet(object.alt) ? Number(object.alt) : undefined,
      agl: isSet(object.agl) ? Number(object.agl) : undefined,
      estimatedEnd: isSet(object.estimatedEnd) ? Boolean(object.estimatedEnd) : undefined,
      estimatedStart: isSet(object.estimatedStart) ? Boolean(object.estimatedStart) : undefined,
      inPenalty: isSet(object.inPenalty) ? Boolean(object.inPenalty) : undefined,
      handicapped: isSet(object.handicapped) ? SpeedDist.fromJSON(object.handicapped) : undefined,
      actual: isSet(object.actual) ? SpeedDist.fromJSON(object.actual) : undefined,
    };
  },

  toJSON(message: PilotScoreLeg): unknown {
    const obj: any = {};
    if (message.legno !== 0) {
      obj.legno = Math.round(message.legno);
    }
    if (message.time !== 0) {
      obj.time = Math.round(message.time);
    }
    if (message.duration !== undefined) {
      obj.duration = Math.round(message.duration);
    }
    if (message.taskDuration !== undefined) {
      obj.taskDuration = Math.round(message.taskDuration);
    }
    if (message.point !== undefined) {
      obj.point = BasePositionMessage.toJSON(message.point);
    }
    if (message.alt !== undefined) {
      obj.alt = Math.round(message.alt);
    }
    if (message.agl !== undefined) {
      obj.agl = Math.round(message.agl);
    }
    if (message.estimatedEnd !== undefined) {
      obj.estimatedEnd = message.estimatedEnd;
    }
    if (message.estimatedStart !== undefined) {
      obj.estimatedStart = message.estimatedStart;
    }
    if (message.inPenalty !== undefined) {
      obj.inPenalty = message.inPenalty;
    }
    if (message.handicapped !== undefined) {
      obj.handicapped = SpeedDist.toJSON(message.handicapped);
    }
    if (message.actual !== undefined) {
      obj.actual = SpeedDist.toJSON(message.actual);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<PilotScoreLeg>, I>>(base?: I): PilotScoreLeg {
    return PilotScoreLeg.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<PilotScoreLeg>, I>>(object: I): PilotScoreLeg {
    const message = createBasePilotScoreLeg();
    message.legno = object.legno ?? 0;
    message.time = object.time ?? 0;
    message.duration = object.duration ?? undefined;
    message.taskDuration = object.taskDuration ?? undefined;
    message.point = (object.point !== undefined && object.point !== null)
      ? BasePositionMessage.fromPartial(object.point)
      : undefined;
    message.alt = object.alt ?? undefined;
    message.agl = object.agl ?? undefined;
    message.estimatedEnd = object.estimatedEnd ?? undefined;
    message.estimatedStart = object.estimatedStart ?? undefined;
    message.inPenalty = object.inPenalty ?? undefined;
    message.handicapped = (object.handicapped !== undefined && object.handicapped !== null)
      ? SpeedDist.fromPartial(object.handicapped)
      : undefined;
    message.actual = (object.actual !== undefined && object.actual !== null)
      ? SpeedDist.fromPartial(object.actual)
      : undefined;
    return message;
  },
};

function createBaseWind(): Wind {
  return { speed: 0, direction: 0 };
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
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseWind();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.speed = reader.uint32();
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.direction = reader.uint32();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Wind {
    return {
      speed: isSet(object.speed) ? Number(object.speed) : 0,
      direction: isSet(object.direction) ? Number(object.direction) : 0,
    };
  },

  toJSON(message: Wind): unknown {
    const obj: any = {};
    if (message.speed !== 0) {
      obj.speed = Math.round(message.speed);
    }
    if (message.direction !== 0) {
      obj.direction = Math.round(message.direction);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Wind>, I>>(base?: I): Wind {
    return Wind.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Wind>, I>>(object: I): Wind {
    const message = createBaseWind();
    message.speed = object.speed ?? 0;
    message.direction = object.direction ?? 0;
    return message;
  },
};

function createBaseStatSegment(): StatSegment {
  return {
    start: 0,
    end: 0,
    state: "",
    wind: undefined,
    turncount: 0,
    distance: 0,
    achievedDistance: 0,
    delta: 0,
    avgDelta: 0,
    direction: 0,
    heightgain: 0,
    heightloss: 0,
  };
}

export const StatSegment = {
  encode(message: StatSegment, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.start !== 0) {
      writer.uint32(8).uint32(message.start);
    }
    if (message.end !== 0) {
      writer.uint32(16).uint32(message.end);
    }
    if (message.state !== "") {
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

  decode(input: _m0.Reader | Uint8Array, length?: number): StatSegment {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseStatSegment();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.start = reader.uint32();
          continue;
        case 2:
          if (tag !== 16) {
            break;
          }

          message.end = reader.uint32();
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.state = reader.string();
          continue;
        case 4:
          if (tag !== 34) {
            break;
          }

          message.wind = Wind.decode(reader, reader.uint32());
          continue;
        case 5:
          if (tag !== 40) {
            break;
          }

          message.turncount = reader.uint32();
          continue;
        case 6:
          if (tag !== 49) {
            break;
          }

          message.distance = reader.double();
          continue;
        case 7:
          if (tag !== 57) {
            break;
          }

          message.achievedDistance = reader.double();
          continue;
        case 8:
          if (tag !== 64) {
            break;
          }

          message.delta = reader.int32();
          continue;
        case 9:
          if (tag !== 73) {
            break;
          }

          message.avgDelta = reader.double();
          continue;
        case 10:
          if (tag !== 80) {
            break;
          }

          message.direction = reader.uint32();
          continue;
        case 11:
          if (tag !== 88) {
            break;
          }

          message.heightgain = reader.uint32();
          continue;
        case 12:
          if (tag !== 96) {
            break;
          }

          message.heightloss = reader.uint32();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): StatSegment {
    return {
      start: isSet(object.start) ? Number(object.start) : 0,
      end: isSet(object.end) ? Number(object.end) : 0,
      state: isSet(object.state) ? String(object.state) : "",
      wind: isSet(object.wind) ? Wind.fromJSON(object.wind) : undefined,
      turncount: isSet(object.turncount) ? Number(object.turncount) : 0,
      distance: isSet(object.distance) ? Number(object.distance) : 0,
      achievedDistance: isSet(object.achievedDistance) ? Number(object.achievedDistance) : 0,
      delta: isSet(object.delta) ? Number(object.delta) : 0,
      avgDelta: isSet(object.avgDelta) ? Number(object.avgDelta) : 0,
      direction: isSet(object.direction) ? Number(object.direction) : 0,
      heightgain: isSet(object.heightgain) ? Number(object.heightgain) : 0,
      heightloss: isSet(object.heightloss) ? Number(object.heightloss) : 0,
    };
  },

  toJSON(message: StatSegment): unknown {
    const obj: any = {};
    if (message.start !== 0) {
      obj.start = Math.round(message.start);
    }
    if (message.end !== 0) {
      obj.end = Math.round(message.end);
    }
    if (message.state !== "") {
      obj.state = message.state;
    }
    if (message.wind !== undefined) {
      obj.wind = Wind.toJSON(message.wind);
    }
    if (message.turncount !== 0) {
      obj.turncount = Math.round(message.turncount);
    }
    if (message.distance !== 0) {
      obj.distance = message.distance;
    }
    if (message.achievedDistance !== 0) {
      obj.achievedDistance = message.achievedDistance;
    }
    if (message.delta !== 0) {
      obj.delta = Math.round(message.delta);
    }
    if (message.avgDelta !== 0) {
      obj.avgDelta = message.avgDelta;
    }
    if (message.direction !== 0) {
      obj.direction = Math.round(message.direction);
    }
    if (message.heightgain !== 0) {
      obj.heightgain = Math.round(message.heightgain);
    }
    if (message.heightloss !== 0) {
      obj.heightloss = Math.round(message.heightloss);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<StatSegment>, I>>(base?: I): StatSegment {
    return StatSegment.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<StatSegment>, I>>(object: I): StatSegment {
    const message = createBaseStatSegment();
    message.start = object.start ?? 0;
    message.end = object.end ?? 0;
    message.state = object.state ?? "";
    message.wind = (object.wind !== undefined && object.wind !== null) ? Wind.fromPartial(object.wind) : undefined;
    message.turncount = object.turncount ?? 0;
    message.distance = object.distance ?? 0;
    message.achievedDistance = object.achievedDistance ?? 0;
    message.delta = object.delta ?? 0;
    message.avgDelta = object.avgDelta ?? 0;
    message.direction = object.direction ?? 0;
    message.heightgain = object.heightgain ?? 0;
    message.heightloss = object.heightloss ?? 0;
    return message;
  },
};

function createBaseStats(): Stats {
  return { segments: [] };
}

export const Stats = {
  encode(message: Stats, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.segments) {
      StatSegment.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Stats {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseStats();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.segments.push(StatSegment.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Stats {
    return {
      segments: Array.isArray(object?.segments) ? object.segments.map((e: any) => StatSegment.fromJSON(e)) : [],
    };
  },

  toJSON(message: Stats): unknown {
    const obj: any = {};
    if (message.segments?.length) {
      obj.segments = message.segments.map((e) => StatSegment.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Stats>, I>>(base?: I): Stats {
    return Stats.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Stats>, I>>(object: I): Stats {
    const message = createBaseStats();
    message.segments = object.segments?.map((e) => StatSegment.fromPartial(e)) || [];
    return message;
  },
};

function createBaseBasePositionMessage(): BasePositionMessage {
  return { t: 0, lat: 0, lng: 0 };
}

export const BasePositionMessage = {
  encode(message: BasePositionMessage, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.t !== 0) {
      writer.uint32(8).uint32(message.t);
    }
    if (message.lat !== 0) {
      writer.uint32(21).float(message.lat);
    }
    if (message.lng !== 0) {
      writer.uint32(29).float(message.lng);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): BasePositionMessage {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseBasePositionMessage();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.t = reader.uint32();
          continue;
        case 2:
          if (tag !== 21) {
            break;
          }

          message.lat = reader.float();
          continue;
        case 3:
          if (tag !== 29) {
            break;
          }

          message.lng = reader.float();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): BasePositionMessage {
    return {
      t: isSet(object.t) ? Number(object.t) : 0,
      lat: isSet(object.lat) ? Number(object.lat) : 0,
      lng: isSet(object.lng) ? Number(object.lng) : 0,
    };
  },

  toJSON(message: BasePositionMessage): unknown {
    const obj: any = {};
    if (message.t !== 0) {
      obj.t = Math.round(message.t);
    }
    if (message.lat !== 0) {
      obj.lat = message.lat;
    }
    if (message.lng !== 0) {
      obj.lng = message.lng;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<BasePositionMessage>, I>>(base?: I): BasePositionMessage {
    return BasePositionMessage.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<BasePositionMessage>, I>>(object: I): BasePositionMessage {
    const message = createBaseBasePositionMessage();
    message.t = object.t ?? 0;
    message.lat = object.lat ?? 0;
    message.lng = object.lng ?? 0;
    return message;
  },
};

function createBasePilotScore(): PilotScore {
  return {
    t: 0,
    compno: "",
    utcStart: 0,
    utcFinish: 0,
    taskDuration: undefined,
    taskTimeRemaining: undefined,
    inSector: undefined,
    inPenalty: undefined,
    stationary: undefined,
    flightStatus: undefined,
    actual: undefined,
    handicapped: undefined,
    currentLeg: 0,
    legs: {},
    stats: undefined,
    wind: undefined,
    scoredPoints: [],
    minDistancePoints: [],
    maxDistancePoints: [],
    taskGeoJSON: undefined,
  };
}

export const PilotScore = {
  encode(message: PilotScore, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.t !== 0) {
      writer.uint32(8).uint32(message.t);
    }
    if (message.compno !== "") {
      writer.uint32(18).string(message.compno);
    }
    if (message.utcStart !== 0) {
      writer.uint32(24).uint32(message.utcStart);
    }
    if (message.utcFinish !== 0) {
      writer.uint32(32).uint32(message.utcFinish);
    }
    if (message.taskDuration !== undefined) {
      writer.uint32(40).uint32(message.taskDuration);
    }
    if (message.taskTimeRemaining !== undefined) {
      writer.uint32(432).int32(message.taskTimeRemaining);
    }
    if (message.inSector !== undefined) {
      writer.uint32(56).bool(message.inSector);
    }
    if (message.inPenalty !== undefined) {
      writer.uint32(64).bool(message.inPenalty);
    }
    if (message.stationary !== undefined) {
      writer.uint32(72).bool(message.stationary);
    }
    if (message.flightStatus !== undefined) {
      writer.uint32(96).uint32(message.flightStatus);
    }
    if (message.actual !== undefined) {
      SpeedDist.encode(message.actual, writer.uint32(82).fork()).ldelim();
    }
    if (message.handicapped !== undefined) {
      SpeedDist.encode(message.handicapped, writer.uint32(90).fork()).ldelim();
    }
    if (message.currentLeg !== 0) {
      writer.uint32(296).uint32(message.currentLeg);
    }
    Object.entries(message.legs).forEach(([key, value]) => {
      PilotScore_LegsEntry.encode({ key: key as any, value }, writer.uint32(290).fork()).ldelim();
    });
    if (message.stats !== undefined) {
      Stats.encode(message.stats, writer.uint32(346).fork()).ldelim();
    }
    if (message.wind !== undefined) {
      Wind.encode(message.wind, writer.uint32(450).fork()).ldelim();
    }
    writer.uint32(418).fork();
    for (const v of message.scoredPoints) {
      writer.float(v);
    }
    writer.ldelim();
    writer.uint32(482).fork();
    for (const v of message.minDistancePoints) {
      writer.float(v);
    }
    writer.ldelim();
    writer.uint32(490).fork();
    for (const v of message.maxDistancePoints) {
      writer.float(v);
    }
    writer.ldelim();
    if (message.taskGeoJSON !== undefined) {
      writer.uint32(426).string(message.taskGeoJSON);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): PilotScore {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePilotScore();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.t = reader.uint32();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.compno = reader.string();
          continue;
        case 3:
          if (tag !== 24) {
            break;
          }

          message.utcStart = reader.uint32();
          continue;
        case 4:
          if (tag !== 32) {
            break;
          }

          message.utcFinish = reader.uint32();
          continue;
        case 5:
          if (tag !== 40) {
            break;
          }

          message.taskDuration = reader.uint32();
          continue;
        case 54:
          if (tag !== 432) {
            break;
          }

          message.taskTimeRemaining = reader.int32();
          continue;
        case 7:
          if (tag !== 56) {
            break;
          }

          message.inSector = reader.bool();
          continue;
        case 8:
          if (tag !== 64) {
            break;
          }

          message.inPenalty = reader.bool();
          continue;
        case 9:
          if (tag !== 72) {
            break;
          }

          message.stationary = reader.bool();
          continue;
        case 12:
          if (tag !== 96) {
            break;
          }

          message.flightStatus = reader.uint32();
          continue;
        case 10:
          if (tag !== 82) {
            break;
          }

          message.actual = SpeedDist.decode(reader, reader.uint32());
          continue;
        case 11:
          if (tag !== 90) {
            break;
          }

          message.handicapped = SpeedDist.decode(reader, reader.uint32());
          continue;
        case 37:
          if (tag !== 296) {
            break;
          }

          message.currentLeg = reader.uint32();
          continue;
        case 36:
          if (tag !== 290) {
            break;
          }

          const entry36 = PilotScore_LegsEntry.decode(reader, reader.uint32());
          if (entry36.value !== undefined) {
            message.legs[entry36.key] = entry36.value;
          }
          continue;
        case 43:
          if (tag !== 346) {
            break;
          }

          message.stats = Stats.decode(reader, reader.uint32());
          continue;
        case 56:
          if (tag !== 450) {
            break;
          }

          message.wind = Wind.decode(reader, reader.uint32());
          continue;
        case 52:
          if (tag === 421) {
            message.scoredPoints.push(reader.float());

            continue;
          }

          if (tag === 418) {
            const end2 = reader.uint32() + reader.pos;
            while (reader.pos < end2) {
              message.scoredPoints.push(reader.float());
            }

            continue;
          }

          break;
        case 60:
          if (tag === 485) {
            message.minDistancePoints.push(reader.float());

            continue;
          }

          if (tag === 482) {
            const end2 = reader.uint32() + reader.pos;
            while (reader.pos < end2) {
              message.minDistancePoints.push(reader.float());
            }

            continue;
          }

          break;
        case 61:
          if (tag === 493) {
            message.maxDistancePoints.push(reader.float());

            continue;
          }

          if (tag === 490) {
            const end2 = reader.uint32() + reader.pos;
            while (reader.pos < end2) {
              message.maxDistancePoints.push(reader.float());
            }

            continue;
          }

          break;
        case 53:
          if (tag !== 426) {
            break;
          }

          message.taskGeoJSON = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): PilotScore {
    return {
      t: isSet(object.t) ? Number(object.t) : 0,
      compno: isSet(object.compno) ? String(object.compno) : "",
      utcStart: isSet(object.utcStart) ? Number(object.utcStart) : 0,
      utcFinish: isSet(object.utcFinish) ? Number(object.utcFinish) : 0,
      taskDuration: isSet(object.taskDuration) ? Number(object.taskDuration) : undefined,
      taskTimeRemaining: isSet(object.taskTimeRemaining) ? Number(object.taskTimeRemaining) : undefined,
      inSector: isSet(object.inSector) ? Boolean(object.inSector) : undefined,
      inPenalty: isSet(object.inPenalty) ? Boolean(object.inPenalty) : undefined,
      stationary: isSet(object.stationary) ? Boolean(object.stationary) : undefined,
      flightStatus: isSet(object.flightStatus) ? Number(object.flightStatus) : undefined,
      actual: isSet(object.actual) ? SpeedDist.fromJSON(object.actual) : undefined,
      handicapped: isSet(object.handicapped) ? SpeedDist.fromJSON(object.handicapped) : undefined,
      currentLeg: isSet(object.currentLeg) ? Number(object.currentLeg) : 0,
      legs: isObject(object.legs)
        ? Object.entries(object.legs).reduce<{ [key: number]: PilotScoreLeg }>((acc, [key, value]) => {
          acc[Number(key)] = PilotScoreLeg.fromJSON(value);
          return acc;
        }, {})
        : {},
      stats: isSet(object.stats) ? Stats.fromJSON(object.stats) : undefined,
      wind: isSet(object.wind) ? Wind.fromJSON(object.wind) : undefined,
      scoredPoints: Array.isArray(object?.scoredPoints) ? object.scoredPoints.map((e: any) => Number(e)) : [],
      minDistancePoints: Array.isArray(object?.minDistancePoints)
        ? object.minDistancePoints.map((e: any) => Number(e))
        : [],
      maxDistancePoints: Array.isArray(object?.maxDistancePoints)
        ? object.maxDistancePoints.map((e: any) => Number(e))
        : [],
      taskGeoJSON: isSet(object.taskGeoJSON) ? String(object.taskGeoJSON) : undefined,
    };
  },

  toJSON(message: PilotScore): unknown {
    const obj: any = {};
    if (message.t !== 0) {
      obj.t = Math.round(message.t);
    }
    if (message.compno !== "") {
      obj.compno = message.compno;
    }
    if (message.utcStart !== 0) {
      obj.utcStart = Math.round(message.utcStart);
    }
    if (message.utcFinish !== 0) {
      obj.utcFinish = Math.round(message.utcFinish);
    }
    if (message.taskDuration !== undefined) {
      obj.taskDuration = Math.round(message.taskDuration);
    }
    if (message.taskTimeRemaining !== undefined) {
      obj.taskTimeRemaining = Math.round(message.taskTimeRemaining);
    }
    if (message.inSector !== undefined) {
      obj.inSector = message.inSector;
    }
    if (message.inPenalty !== undefined) {
      obj.inPenalty = message.inPenalty;
    }
    if (message.stationary !== undefined) {
      obj.stationary = message.stationary;
    }
    if (message.flightStatus !== undefined) {
      obj.flightStatus = Math.round(message.flightStatus);
    }
    if (message.actual !== undefined) {
      obj.actual = SpeedDist.toJSON(message.actual);
    }
    if (message.handicapped !== undefined) {
      obj.handicapped = SpeedDist.toJSON(message.handicapped);
    }
    if (message.currentLeg !== 0) {
      obj.currentLeg = Math.round(message.currentLeg);
    }
    if (message.legs) {
      const entries = Object.entries(message.legs);
      if (entries.length > 0) {
        obj.legs = {};
        entries.forEach(([k, v]) => {
          obj.legs[k] = PilotScoreLeg.toJSON(v);
        });
      }
    }
    if (message.stats !== undefined) {
      obj.stats = Stats.toJSON(message.stats);
    }
    if (message.wind !== undefined) {
      obj.wind = Wind.toJSON(message.wind);
    }
    if (message.scoredPoints?.length) {
      obj.scoredPoints = message.scoredPoints;
    }
    if (message.minDistancePoints?.length) {
      obj.minDistancePoints = message.minDistancePoints;
    }
    if (message.maxDistancePoints?.length) {
      obj.maxDistancePoints = message.maxDistancePoints;
    }
    if (message.taskGeoJSON !== undefined) {
      obj.taskGeoJSON = message.taskGeoJSON;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<PilotScore>, I>>(base?: I): PilotScore {
    return PilotScore.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<PilotScore>, I>>(object: I): PilotScore {
    const message = createBasePilotScore();
    message.t = object.t ?? 0;
    message.compno = object.compno ?? "";
    message.utcStart = object.utcStart ?? 0;
    message.utcFinish = object.utcFinish ?? 0;
    message.taskDuration = object.taskDuration ?? undefined;
    message.taskTimeRemaining = object.taskTimeRemaining ?? undefined;
    message.inSector = object.inSector ?? undefined;
    message.inPenalty = object.inPenalty ?? undefined;
    message.stationary = object.stationary ?? undefined;
    message.flightStatus = object.flightStatus ?? undefined;
    message.actual = (object.actual !== undefined && object.actual !== null)
      ? SpeedDist.fromPartial(object.actual)
      : undefined;
    message.handicapped = (object.handicapped !== undefined && object.handicapped !== null)
      ? SpeedDist.fromPartial(object.handicapped)
      : undefined;
    message.currentLeg = object.currentLeg ?? 0;
    message.legs = Object.entries(object.legs ?? {}).reduce<{ [key: number]: PilotScoreLeg }>((acc, [key, value]) => {
      if (value !== undefined) {
        acc[Number(key)] = PilotScoreLeg.fromPartial(value);
      }
      return acc;
    }, {});
    message.stats = (object.stats !== undefined && object.stats !== null) ? Stats.fromPartial(object.stats) : undefined;
    message.wind = (object.wind !== undefined && object.wind !== null) ? Wind.fromPartial(object.wind) : undefined;
    message.scoredPoints = object.scoredPoints?.map((e) => e) || [];
    message.minDistancePoints = object.minDistancePoints?.map((e) => e) || [];
    message.maxDistancePoints = object.maxDistancePoints?.map((e) => e) || [];
    message.taskGeoJSON = object.taskGeoJSON ?? undefined;
    return message;
  },
};

function createBasePilotScore_LegsEntry(): PilotScore_LegsEntry {
  return { key: 0, value: undefined };
}

export const PilotScore_LegsEntry = {
  encode(message: PilotScore_LegsEntry, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.key !== 0) {
      writer.uint32(8).uint32(message.key);
    }
    if (message.value !== undefined) {
      PilotScoreLeg.encode(message.value, writer.uint32(18).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): PilotScore_LegsEntry {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePilotScore_LegsEntry();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.key = reader.uint32();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.value = PilotScoreLeg.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): PilotScore_LegsEntry {
    return {
      key: isSet(object.key) ? Number(object.key) : 0,
      value: isSet(object.value) ? PilotScoreLeg.fromJSON(object.value) : undefined,
    };
  },

  toJSON(message: PilotScore_LegsEntry): unknown {
    const obj: any = {};
    if (message.key !== 0) {
      obj.key = Math.round(message.key);
    }
    if (message.value !== undefined) {
      obj.value = PilotScoreLeg.toJSON(message.value);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<PilotScore_LegsEntry>, I>>(base?: I): PilotScore_LegsEntry {
    return PilotScore_LegsEntry.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<PilotScore_LegsEntry>, I>>(object: I): PilotScore_LegsEntry {
    const message = createBasePilotScore_LegsEntry();
    message.key = object.key ?? 0;
    message.value = (object.value !== undefined && object.value !== null)
      ? PilotScoreLeg.fromPartial(object.value)
      : undefined;
    return message;
  },
};

function createBasePilotPosition(): PilotPosition {
  return { c: "", lat: 0, lng: 0, a: 0, g: 0, t: 0, b: 0, s: 0, v: "" };
}

export const PilotPosition = {
  encode(message: PilotPosition, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.c !== "") {
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
    if (message.v !== "") {
      writer.uint32(74).string(message.v);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): PilotPosition {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePilotPosition();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.c = reader.string();
          continue;
        case 2:
          if (tag !== 17) {
            break;
          }

          message.lat = reader.double();
          continue;
        case 3:
          if (tag !== 25) {
            break;
          }

          message.lng = reader.double();
          continue;
        case 4:
          if (tag !== 32) {
            break;
          }

          message.a = reader.uint32();
          continue;
        case 5:
          if (tag !== 40) {
            break;
          }

          message.g = reader.uint32();
          continue;
        case 6:
          if (tag !== 48) {
            break;
          }

          message.t = reader.uint32();
          continue;
        case 7:
          if (tag !== 56) {
            break;
          }

          message.b = reader.uint32();
          continue;
        case 8:
          if (tag !== 64) {
            break;
          }

          message.s = reader.uint32();
          continue;
        case 9:
          if (tag !== 74) {
            break;
          }

          message.v = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): PilotPosition {
    return {
      c: isSet(object.c) ? String(object.c) : "",
      lat: isSet(object.lat) ? Number(object.lat) : 0,
      lng: isSet(object.lng) ? Number(object.lng) : 0,
      a: isSet(object.a) ? Number(object.a) : 0,
      g: isSet(object.g) ? Number(object.g) : 0,
      t: isSet(object.t) ? Number(object.t) : 0,
      b: isSet(object.b) ? Number(object.b) : 0,
      s: isSet(object.s) ? Number(object.s) : 0,
      v: isSet(object.v) ? String(object.v) : "",
    };
  },

  toJSON(message: PilotPosition): unknown {
    const obj: any = {};
    if (message.c !== "") {
      obj.c = message.c;
    }
    if (message.lat !== 0) {
      obj.lat = message.lat;
    }
    if (message.lng !== 0) {
      obj.lng = message.lng;
    }
    if (message.a !== 0) {
      obj.a = Math.round(message.a);
    }
    if (message.g !== 0) {
      obj.g = Math.round(message.g);
    }
    if (message.t !== 0) {
      obj.t = Math.round(message.t);
    }
    if (message.b !== 0) {
      obj.b = Math.round(message.b);
    }
    if (message.s !== 0) {
      obj.s = Math.round(message.s);
    }
    if (message.v !== "") {
      obj.v = message.v;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<PilotPosition>, I>>(base?: I): PilotPosition {
    return PilotPosition.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<PilotPosition>, I>>(object: I): PilotPosition {
    const message = createBasePilotPosition();
    message.c = object.c ?? "";
    message.lat = object.lat ?? 0;
    message.lng = object.lng ?? 0;
    message.a = object.a ?? 0;
    message.g = object.g ?? 0;
    message.t = object.t ?? 0;
    message.b = object.b ?? 0;
    message.s = object.s ?? 0;
    message.v = object.v ?? "";
    return message;
  },
};

function createBasePositions(): Positions {
  return { positions: [] };
}

export const Positions = {
  encode(message: Positions, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.positions) {
      PilotPosition.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): Positions {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBasePositions();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.positions.push(PilotPosition.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Positions {
    return {
      positions: Array.isArray(object?.positions) ? object.positions.map((e: any) => PilotPosition.fromJSON(e)) : [],
    };
  },

  toJSON(message: Positions): unknown {
    const obj: any = {};
    if (message.positions?.length) {
      obj.positions = message.positions.map((e) => PilotPosition.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Positions>, I>>(base?: I): Positions {
    return Positions.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Positions>, I>>(object: I): Positions {
    const message = createBasePositions();
    message.positions = object.positions?.map((e) => PilotPosition.fromPartial(e)) || [];
    return message;
  },
};

function createBaseKeepAlive(): KeepAlive {
  return { keepalive: false, at: 0, listeners: 0, airborne: 0 };
}

export const KeepAlive = {
  encode(message: KeepAlive, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.keepalive === true) {
      writer.uint32(8).bool(message.keepalive);
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
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseKeepAlive();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 8) {
            break;
          }

          message.keepalive = reader.bool();
          continue;
        case 3:
          if (tag !== 24) {
            break;
          }

          message.at = reader.uint32();
          continue;
        case 4:
          if (tag !== 32) {
            break;
          }

          message.listeners = reader.uint32();
          continue;
        case 5:
          if (tag !== 40) {
            break;
          }

          message.airborne = reader.uint32();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): KeepAlive {
    return {
      keepalive: isSet(object.keepalive) ? Boolean(object.keepalive) : false,
      at: isSet(object.at) ? Number(object.at) : 0,
      listeners: isSet(object.listeners) ? Number(object.listeners) : 0,
      airborne: isSet(object.airborne) ? Number(object.airborne) : 0,
    };
  },

  toJSON(message: KeepAlive): unknown {
    const obj: any = {};
    if (message.keepalive === true) {
      obj.keepalive = message.keepalive;
    }
    if (message.at !== 0) {
      obj.at = Math.round(message.at);
    }
    if (message.listeners !== 0) {
      obj.listeners = Math.round(message.listeners);
    }
    if (message.airborne !== 0) {
      obj.airborne = Math.round(message.airborne);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<KeepAlive>, I>>(base?: I): KeepAlive {
    return KeepAlive.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<KeepAlive>, I>>(object: I): KeepAlive {
    const message = createBaseKeepAlive();
    message.keepalive = object.keepalive ?? false;
    message.at = object.at ?? 0;
    message.listeners = object.listeners ?? 0;
    message.airborne = object.airborne ?? 0;
    return message;
  },
};

declare const self: any | undefined;
declare const window: any | undefined;
declare const global: any | undefined;
const tsProtoGlobalThis: any = (() => {
  if (typeof globalThis !== "undefined") {
    return globalThis;
  }
  if (typeof self !== "undefined") {
    return self;
  }
  if (typeof window !== "undefined") {
    return window;
  }
  if (typeof global !== "undefined") {
    return global;
  }
  throw "Unable to locate global object";
})();

function bytesFromBase64(b64: string): Uint8Array {
  if (tsProtoGlobalThis.Buffer) {
    return Uint8Array.from(tsProtoGlobalThis.Buffer.from(b64, "base64"));
  } else {
    const bin = tsProtoGlobalThis.atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; ++i) {
      arr[i] = bin.charCodeAt(i);
    }
    return arr;
  }
}

function base64FromBytes(arr: Uint8Array): string {
  if (tsProtoGlobalThis.Buffer) {
    return tsProtoGlobalThis.Buffer.from(arr).toString("base64");
  } else {
    const bin: string[] = [];
    arr.forEach((byte) => {
      bin.push(String.fromCharCode(byte));
    });
    return tsProtoGlobalThis.btoa(bin.join(""));
  }
}

type Builtin = Date | Function | Uint8Array | string | number | boolean | undefined;

export type DeepPartial<T> = T extends Builtin ? T
  : T extends Array<infer U> ? Array<DeepPartial<U>> : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>>
  : T extends {} ? { [K in keyof T]?: DeepPartial<T[K]> }
  : Partial<T>;

type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & { [K in Exclude<keyof I, KeysOfUnion<P>>]: never };

function isObject(value: any): boolean {
  return typeof value === "object" && value !== null;
}

function isSet(value: any): boolean {
  return value !== null && value !== undefined;
}
