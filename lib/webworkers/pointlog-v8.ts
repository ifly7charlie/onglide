// V8-serialized variant of the pointlog file format.
//
// Layout — fixed-size records so binary search is index-based:
//
//   File header (16 bytes):
//     0  4  magic     "ONG8"
//     4  2  version   uint16 LE (= 1)
//     6  2  recSize   uint16 LE (= V8_RECORD_SIZE by default)
//     8  8  reserved  zeros
//
//   Record N lives at offset 16 + N * recSize. Record layout (recSize bytes):
//     0  4  writeTime  uint32 LE (= t + d at append; always positive, monotonic)
//     4  2  d          int16  LE (signed; t = writeTime - d)
//     6  ?  v8         output of v8.serialize(message); self-delimiting
//             ...      zero padding to recSize
//
// The 4-byte writeTime is the binary-search key directly — no add, no sign
// math, no V8 deserialize on the probe path. The 2-byte d lets the scanner
// compute t = writeTime - d for the per-record `since`/`until` filter
// before paying the V8 deserialize. d is signed because backfill replays
// and receiver clock skew can produce t > writeTime.
//
// The file is monotonic in writeTime (each record is appended at writer-now)
// but NOT in t — and for a given writeTime there is no guarantee that t is
// ordered either: two packets ingested in the same second can carry quite
// different t values (one live, one a backfill replay). The binary search
// therefore lands on the first record with writeTime >= target - SLACK and
// the linear scan from there applies the t-filter per record. Same invariant
// as the .log reader.
//
// No length prefix: v8.serialize emits a self-delimiting stream (header
// byte + version + tag-driven body), and v8.deserialize stops at the end
// of the encoded value, ignoring any trailing bytes (verified). Records
// padded with zeros to recSize round-trip cleanly.

import {openSync, closeSync, readSync, statSync, promises as fsp, createReadStream, createWriteStream} from 'fs';
import * as readline from 'readline';
import {serialize as v8serialize, deserialize as v8deserialize} from 'v8';

import type {FlarmID} from '../types';
import type {LoadPointsQuery, LoadPointsForIdsQuery, LoggedMessage} from './pointlog';

export const V8_FILE_MAGIC = Buffer.from('ONG8', 'ascii');
export const V8_FILE_VERSION = 1;
export const V8_FILE_HEADER_SIZE = 16;
// 6 B header + 131 B observed max payload = 137 B floor; 144 B gives 7 B of
// headroom and packs ~910 records per 128 KB chunk read. The writer throws
// immediately if anything exceeds the per-record budget — bump if it fires.
export const V8_RECORD_SIZE = 144;
export const V8_RECORD_HEADER_SIZE = 6;
const V8_D_MIN = -0x8000;
const V8_D_MAX = 0x7fff;

const OUT_OF_ORDER_SLACK_SEC = 30;

// ---------- codec ----------

export function buildFileHeader(recSize: number = V8_RECORD_SIZE): Buffer {
    const h = Buffer.alloc(V8_FILE_HEADER_SIZE);
    V8_FILE_MAGIC.copy(h, 0);
    h.writeUInt16LE(V8_FILE_VERSION, 4);
    h.writeUInt16LE(recSize, 6);
    return h;
}

export function parseFileHeader(buf: Buffer): {version: number; recSize: number} {
    if (buf.length < V8_FILE_HEADER_SIZE) throw new Error('v8 pointlog: file too short for header');
    if (buf.compare(V8_FILE_MAGIC, 0, 4, 0, 4) !== 0) throw new Error(`v8 pointlog: bad magic (got ${buf.subarray(0, 4).toString('hex')})`);
    const version = buf.readUInt16LE(4);
    const recSize = buf.readUInt16LE(6);
    if (version !== V8_FILE_VERSION) throw new Error(`v8 pointlog: unsupported version ${version}`);
    if (recSize <= V8_RECORD_HEADER_SIZE) throw new Error(`v8 pointlog: bad recSize ${recSize}`);
    return {version, recSize};
}

// Serialize one message into a recSize-byte record. Returns the record
// plus the V8 payload size (the record itself doesn't carry a length —
// v8.deserialize self-delimits; the size is returned so callers that
// track stats / detect near-budget records can use it). Throws if the V8
// payload doesn't fit or if d falls outside the int16 header field.
export interface SerializedRecord {
    rec: Buffer;
    payloadBytes: number;
}

export function serializeRecord(msg: LoggedMessage, recSize: number = V8_RECORD_SIZE): SerializedRecord {
    const payload = v8serialize(msg);
    const maxPayload = recSize - V8_RECORD_HEADER_SIZE;
    if (payload.length > maxPayload) {
        throw new Error(`v8 pointlog: payload ${payload.length} bytes exceeds budget ${maxPayload} for flarm=${(msg as any).f} t=${msg.t}`);
    }
    const d = ((msg.d ?? 0) as number) | 0;
    if (d < V8_D_MIN || d > V8_D_MAX) {
        throw new Error(`v8 pointlog: d=${d} out of int16 range for flarm=${(msg as any).f} t=${msg.t}`);
    }
    const writeTime = (msg.t + d) >>> 0;
    const rec = Buffer.alloc(recSize);
    rec.writeUInt32LE(writeTime, 0);
    rec.writeInt16LE(d, 4);
    payload.copy(rec, V8_RECORD_HEADER_SIZE);
    return {rec, payloadBytes: payload.length};
}

// Deserialize a record from a buffer at the given offset. The V8 stream is
// self-delimiting — extra trailing bytes in the record's body (zero
// padding, or even neighbour-record bytes if a slice runs long) are
// ignored by v8.deserialize. We pass a view starting at the payload offset.
export function deserializeRecord(buf: Buffer, offset: number, recSize: number = V8_RECORD_SIZE): LoggedMessage {
    return v8deserialize(buf.subarray(offset + V8_RECORD_HEADER_SIZE, offset + recSize)) as LoggedMessage;
}

// ---------- file open helper ----------

interface OpenV8File {
    fd: number;
    size: number;
    recSize: number;
    recordCount: number;
}

function openV8File(fullPath: string): OpenV8File | undefined {
    const size = statSync(fullPath).size;
    if (size < V8_FILE_HEADER_SIZE) return undefined;
    const fd = openSync(fullPath, 'r');
    try {
        const hdr = Buffer.alloc(V8_FILE_HEADER_SIZE);
        const n = readSync(fd, hdr, 0, V8_FILE_HEADER_SIZE, 0);
        if (n < V8_FILE_HEADER_SIZE) {
            closeSync(fd);
            return undefined;
        }
        const {recSize} = parseFileHeader(hdr);
        const body = size - V8_FILE_HEADER_SIZE;
        const recordCount = Math.floor(body / recSize);
        return {fd, size, recSize, recordCount};
    } catch (e) {
        closeSync(fd);
        throw e;
    }
}

// ---------- binary search ----------

// Returns the index of the first record whose writeTime >= target, or
// recordCount if every record is below target. Reads only the 4-byte
// writeTime field — no V8 deserialization, no signed math, no addition
// on the probe path.
export function binarySearchForTsV8(fd: number, recordCount: number, recSize: number, target: number): number {
    const probe = Buffer.alloc(4);
    let lo = 0;
    let hi = recordCount;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const off = V8_FILE_HEADER_SIZE + mid * recSize;
        const n = readSync(fd, probe, 0, 4, off);
        if (n < 4) {
            hi = mid;
            continue;
        }
        const writeTime = probe.readUInt32LE(0);
        if (writeTime < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// ---------- scan generators ----------

// Mirrors pointlog.ts:scanFile — filter by single flarmId. Chunked reads
// (one I/O per N records) and lazy V8 deserialize: we look at the header
// first, drop on t-range, then deserialize only when we know we'll yield.

const RECORDS_PER_CHUNK = 512; // 512 × 256 B = 128 KB, one 2^17 block per syscall

async function* scanV8File(fullPath: string, q: {since: number; until?: number; flarmId?: FlarmID; flarmIds?: Set<string>; everyFlarm?: boolean}): AsyncGenerator<LoggedMessage> {
    const opened = openV8File(fullPath);
    if (!opened) return;
    const {fd, recSize, recordCount} = opened;
    try {
        const startIndex = binarySearchForTsV8(fd, recordCount, recSize, q.since - OUT_OF_ORDER_SLACK_SEC);
        const chunkBytes = RECORDS_PER_CHUNK * recSize;
        const buf = Buffer.alloc(chunkBytes);
        for (let i = startIndex; i < recordCount; ) {
            const recsThisChunk = Math.min(RECORDS_PER_CHUNK, recordCount - i);
            const toRead = recsThisChunk * recSize;
            const off = V8_FILE_HEADER_SIZE + i * recSize;
            const n = readSync(fd, buf, 0, toRead, off);
            if (n <= 0) break;
            const recsRead = Math.floor(n / recSize);
            for (let r = 0; r < recsRead; r++) {
                const recOff = r * recSize;
                const writeTime = buf.readUInt32LE(recOff);
                const d = buf.readInt16LE(recOff + 4);
                const t = writeTime - d;
                if (t < q.since) continue;
                // File is monotonic in writeTime but NOT in t — a backfill
                // replay can drop a packet with future-ish t in the middle.
                // `continue`, don't `return`, so the rest of the scan stands.
                if (q.until != null && t > q.until) continue;
                const msg = deserializeRecord(buf, recOff, recSize);
                if (q.flarmId != null && msg.f !== q.flarmId) continue;
                if (q.flarmIds && !q.flarmIds.has(msg.f)) continue;
                yield msg;
            }
            i += recsRead;
            if (recsRead < recsThisChunk) break; // short read at EOF
            // Same cooperative-yield pattern as the .log reader so live APRS
            // packets and parentPort messages don't starve.
            await new Promise<void>((r) => setImmediate(r));
        }
    } finally {
        closeSync(fd);
    }
}

export function scanFileV8(fullPath: string, q: LoadPointsQuery): AsyncGenerator<LoggedMessage> {
    return scanV8File(fullPath, {since: q.since, until: q.until, flarmId: q.flarmId});
}

export function scanFileForIdsV8(fullPath: string, q: LoadPointsForIdsQuery): AsyncGenerator<LoggedMessage> {
    return scanV8File(fullPath, {since: q.since, until: q.until, flarmIds: q.flarmIds});
}

export function scanFileAllV8(fullPath: string, since: number, until: number | undefined): AsyncGenerator<LoggedMessage> {
    return scanV8File(fullPath, {since, until, everyFlarm: true});
}

// ---------- converter ----------

export interface ConvertStats {
    recordsIn: number;
    recordsWritten: number;
    skippedParse: number;
    // V8 payload size (excludes the 12-byte record header and zero padding).
    payloadBytesSum: number;
    payloadBytesMin: number;
    payloadBytesMax: number;
}

// Convert a JSON-lines pointlog file to a fixed-size V8 record file.
// Writes to `${dstPath}.tmp` then renames atomically. Throws if a record's
// V8 payload exceeds the per-record budget — caller is responsible for any
// retry / bigger recSize.
export async function convertLogFileToV8(srcPath: string, dstPath: string): Promise<ConvertStats> {
    const stats: ConvertStats = {recordsIn: 0, recordsWritten: 0, skippedParse: 0, payloadBytesSum: 0, payloadBytesMin: Infinity, payloadBytesMax: 0};
    const tmpPath = dstPath + '.tmp';
    const out = createWriteStream(tmpPath);
    out.write(buildFileHeader());

    const rl = readline.createInterface({input: createReadStream(srcPath, {encoding: 'utf8'}), crlfDelay: Infinity});
    try {
        for await (const line of rl) {
            if (!line) continue;
            stats.recordsIn++;
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                stats.skippedParse++;
                continue;
            }
            if (typeof msg.t !== 'number') {
                stats.skippedParse++;
                continue;
            }
            const {rec, payloadBytes} = serializeRecord(msg);
            stats.payloadBytesSum += payloadBytes;
            if (payloadBytes < stats.payloadBytesMin) stats.payloadBytesMin = payloadBytes;
            if (payloadBytes > stats.payloadBytesMax) stats.payloadBytesMax = payloadBytes;
            out.write(rec);
            stats.recordsWritten++;
        }
    } catch (e) {
        out.destroy();
        try {
            await fsp.unlink(tmpPath);
        } catch {}
        throw e;
    }

    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    await fsp.rename(tmpPath, dstPath);
    if (stats.recordsWritten === 0) stats.payloadBytesMin = 0;
    return stats;
}
