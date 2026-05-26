// Helpers around protobuf message encoding.
//
// @bufbuild/protobuf is strict about numeric wire types: a uint32 field rejects
// fractional, negative, or non-finite input synchronously. The previous ts-proto
// runtime silently coerced those values with `>>> 0`. `safeEncode` sits at the
// boundary between domain code and the wire to keep one bad pilot/score from
// taking the whole daemon down.
//
// The numeric clamp helpers (roundedUint32 / clampUint32 / clampInt32) now live
// in lib/protobuf/wireScaling.ts alongside the ×10 wire-scaling functions.

import {OnglideWebSocketMessage, ClassScoreHistory} from '../protobuf/onglide';
import {scaleForWire, scaleClassScoreHistoryForWire} from '../protobuf/wireScaling';

// Wrap a protobuf encode call so a single bad value (NaN, negative, fractional in a uint32
// slot, etc.) doesn't take the whole daemon down. Returns null on failure; callers must
// skip the send when null.
export type ProtoEncoder<T> = {encode: (m: T) => {finish: () => Uint8Array}};

export function safeEncode<T>(encoder: ProtoEncoder<T>, message: T, context: string): Uint8Array | null {
    try {
        // Scale ×10 speed/distance/handicap/angle/radius fields onto the wire.
        // unscaleFromWire / unscaleClassScoreHistoryFromWire reverse this right
        // after decode on the client (see lib/protobuf/wireScaling.ts).
        let toEncode: T = message;
        if ((encoder as unknown) === OnglideWebSocketMessage) {
            toEncode = scaleForWire(message as OnglideWebSocketMessage) as unknown as T;
        } else if ((encoder as unknown) === ClassScoreHistory) {
            toEncode = scaleClassScoreHistoryForWire(message as ClassScoreHistory) as unknown as T;
        }
        return encoder.encode(toEncode).finish();
    } catch (e) {
        const err = e as Error;
        console.error(`protobuf encode failed [${context}]: ${err.message}`);
        if (err.stack) console.error(err.stack);
        return null;
    }
}
