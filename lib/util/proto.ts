// Helpers around @bufbuild/protobuf-backed message encoding.
//
// @bufbuild/protobuf is strict about numeric wire types: a uint32 field rejects
// fractional, negative, or non-finite input synchronously. The previous ts-proto
// runtime silently coerced those values with `>>> 0`. These helpers sit at the
// boundary between domain code and the wire to keep one bad pilot/score from
// taking the whole daemon down.

// Round a numeric stat to a non-negative uint32 suitable for the protobuf wire format.
// Returns undefined when the value isn't a finite non-negative number (e.g. stats-incremental
// returns -Number.MAX_VALUE for .max before any sample is added).
export function roundedUint32(v: number | undefined | null): number | undefined {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return undefined;
    return Math.round(v);
}

// Wrap a protobuf encode call so a single bad value (NaN, negative, fractional in a uint32
// slot, etc.) doesn't take the whole daemon down. Returns null on failure; callers must
// skip the send when null.
export type ProtoEncoder<T> = {encode: (m: T) => {finish: () => Uint8Array}};

export function safeEncode<T>(encoder: ProtoEncoder<T>, message: T, context: string): Uint8Array | null {
    try {
        return encoder.encode(message).finish();
    } catch (e) {
        const err = e as Error;
        console.error(`protobuf encode failed [${context}]: ${err.message}`);
        if (err.stack) console.error(err.stack);
        return null;
    }
}
