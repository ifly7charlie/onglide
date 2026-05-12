// APRS point log: per-process write-only stream + bulk reader.
//
// On-disk format — fixed 36-byte records, every field at a known offset,
// indexed by record number for trivial binary search. Every byte is data;
// there is no per-record padding.
//
//   File header (16 bytes):
//     0  4  magic       "ONG8"
//     4  2  version     uint16 LE  (= 2)
//     6  2  recSize     uint16 LE  (= 36)
//     8  8  reserved    zeros
//
//   Record N at offset 16 + N * 36. Layout:
//     0   4   writeTime  uint32 LE   (= t + d at append; monotonic; binary-search key)
//     4   2   d          int16  LE   (signed delay; t = writeTime - d)
//     6   4   f          uint32 LE   (= parseInt(msg.f, 16); also serves as fid filter key)
//    10  10   o          10 ASCII    (sender callsign, zero-padded; truncated if > 10 chars)
//    20   4   lat        int32  LE   (= round(msg.lat * 1e7); 1.1 cm grid)
//    24   4   lng        int32  LE
//    28   2   a          int16  LE   (altitude AMSL m)
//    30   2   g          int16  LE   (altitude AGL m)
//    32   2   b          int16  LE   (bearing 0-359; -1 = absent)
//    34   2   s_x10      int16  LE   (speed × 10; -1 = absent)
//
// The 4-byte writeTime is the binary-search key directly — no add, no sign
// math, no decode on the probe path. The 2-byte d lets the scanner compute
// t = writeTime - d for the per-record `since`/`until` filter before any
// further decode. d is signed because backfill replays and receiver clock
// skew can produce t > writeTime. The 4-byte f at offset 6 lets the scanner
// reject non-matching flarm IDs without touching the rest of the record.
//
// The file is monotonic in writeTime (each record is appended at writer-now)
// but NOT in t — and for a given writeTime there is no guarantee that t is
// ordered either: two packets ingested in the same second can carry quite
// different t values (one live, one a backfill replay). The binary search
// therefore lands on the first record with writeTime >= target - SLACK and
// the linear scan from there applies the t-filter per record.
//
// Dropped from storage: c (every consumer overwrites or falls back),
// l (writer always emits null), _ (writer never sets), ad (only consumer
// is a cosmetic ground-filter that no-ops gracefully when absent).

import {createWriteStream, WriteStream, promises as fsp, openSync, closeSync, readSync, statSync} from 'fs';
import * as path from 'path';
import * as os from 'os';

import type {PositionMessage, FlarmID} from '../types';

export type LoggedMessage = PositionMessage & {f: FlarmID; o: string; ad?: number; d?: number};

// ---------- format constants ----------

const FILE_MAGIC = Buffer.from('ONG8', 'ascii');
const FILE_FORMAT_VERSION = 2;
export const FILE_HEADER_SIZE = 16;
export const RECORD_SIZE = 36;
const O_FIELD_LEN = 10;
const D_MIN = -0x8000;
const D_MAX = 0x7fff;

// Chunk size for sequential scan reads. 4096 × 36 B = 144 KB per syscall —
// amortises read cost; doesn't affect file layout (the file is exactly
// 16 + N * 36 bytes, no padding).
const RECORDS_PER_CHUNK = 4096;
const OUT_OF_ORDER_SLACK_SEC = 30;

// ---------- module state ----------
// Strip non-alphanumerics so the hostname always occupies exactly one
// hyphen-delimited segment in filenames (parseFilename relies on this).
const hostname = os.hostname().replace(/[^A-Za-z0-9]/g, '');
const pid = process.pid;
const basePath = (): string => (process.env.DB_PATH ?? './db/').replace(/\/$/, '') + '/';

let rotateThreshold = 100 * 1024 * 1024;
let retainMs = 24 * 3600 * 1000;

function reloadConfig(): void {
    const mb = Number(process.env.APRS_LOG_ROTATE_MB);
    rotateThreshold = (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024;
    const hours = Number(process.env.APRS_LOG_RETAIN_HOURS);
    retainMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 1000;
}

let activeStream: WriteStream | undefined;
let activePath: string = '';
let activeFirstTs: number = 0;
let activeBytes: number = 0;
let rotating = false;
const pendingWrites: Buffer[] = [];

// Silent-failure diagnostics. The WriteStream has no error path of its own;
// if writes start going nowhere we want one log line per failure mode rather
// than total silence. Throttle so a sustained fault doesn't flood syslog.
let writesSinceOpen = 0;
let lastWriteTs = 0;
let lastNoStreamLog = 0;
let lastQueueLog = 0;
let lastWriteFailLog = 0;
let lastEncodeFailLog = 0;
let pendingHighWater = 0;

// Auto-reopen state. After a stream error / unexpected close / failed rotate
// we'd otherwise sit with activeStream === undefined and silently drop every
// packet. scheduleReopen() debounces a backoff'd reopen attempt so the writer
// self-heals without a process restart.
let reopenAttempt = 0;
let reopenTimer: NodeJS.Timeout | undefined;
let closing = false;

function logThrottled(lastTsRef: () => number, setLastTs: (t: number) => void, intervalMs: number, msg: string): void {
    const now = Date.now();
    if (now - lastTsRef() < intervalMs) return;
    setLastTs(now);
    console.log(msg);
}

// ---------- filename helpers ----------
// Active:   aprs-<host>-<pid>-<firstTs>.v8        (3 segments)
// Rotated:  aprs-<host>-<pid>-<firstTs>-<lastTs>.v8 (4 segments)
const FILE_PREFIX = 'aprs-';
const FILE_SUFFIX = '.v8';

interface ParsedName {
    file: string;
    host: string;
    pid: number;
    firstTs: number;
    lastTs?: number; // defined iff rotated
    rotated: boolean;
}

function parseFilename(file: string): ParsedName | undefined {
    if (!file.startsWith(FILE_PREFIX) || !file.endsWith(FILE_SUFFIX)) return undefined;
    const core = file.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
    const segments = core.split('-');
    // host segment itself may contain hyphens (hostnames can) — collapse to last 3 or 4.
    if (segments.length < 3) return undefined;
    let host: string, pidStr: string, firstStr: string, lastStr: string | undefined;
    if (segments.length === 3) {
        [host, pidStr, firstStr] = segments;
    } else if (segments.length === 4) {
        [host, pidStr, firstStr, lastStr] = segments;
    } else {
        const tail = segments.slice(-4);
        const maybeFirst = Number(tail[2]);
        const maybeLast = Number(tail[3]);
        if (Number.isFinite(maybeFirst) && Number.isFinite(maybeLast)) {
            host = segments.slice(0, -3).join('-');
            pidStr = tail[1];
            firstStr = tail[2];
            lastStr = tail[3];
        } else {
            host = segments.slice(0, -2).join('-');
            pidStr = segments[segments.length - 2];
            firstStr = segments[segments.length - 1];
        }
    }
    const parsedPid = Number(pidStr);
    const parsedFirst = Number(firstStr);
    if (!Number.isFinite(parsedPid) || !Number.isFinite(parsedFirst)) return undefined;
    const parsedLast = lastStr != null ? Number(lastStr) : undefined;
    if (lastStr != null && !Number.isFinite(parsedLast)) return undefined;
    return {file, host, pid: parsedPid, firstTs: parsedFirst, lastTs: parsedLast, rotated: lastStr != null};
}

function activeFilename(firstTs: number): string {
    return `${FILE_PREFIX}${hostname}-${pid}-${firstTs}${FILE_SUFFIX}`;
}

function rotatedFilename(host: string, pidN: number, firstTs: number, lastTs: number): string {
    return `${FILE_PREFIX}${host}-${pidN}-${firstTs}-${lastTs}${FILE_SUFFIX}`;
}

async function ensureDir(): Promise<void> {
    await fsp.mkdir(basePath(), {recursive: true});
}

async function listAprsFiles(): Promise<ParsedName[]> {
    let entries: string[];
    try {
        entries = await fsp.readdir(basePath());
    } catch (e: any) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
    const out: ParsedName[] = [];
    for (const e of entries) {
        const p = parseFilename(e);
        if (p) out.push(p);
    }
    return out;
}

function isPidAlive(p: number): boolean {
    try {
        process.kill(p, 0);
        return true;
    } catch (e: any) {
        if (e.code === 'ESRCH') return false;
        if (e.code === 'EPERM') return true; // exists, just not ours to signal
        return false;
    }
}

// ---------- codec ----------

export function buildFileHeader(recSize: number = RECORD_SIZE): Buffer {
    const h = Buffer.alloc(FILE_HEADER_SIZE);
    FILE_MAGIC.copy(h, 0);
    h.writeUInt16LE(FILE_FORMAT_VERSION, 4);
    h.writeUInt16LE(recSize, 6);
    return h;
}

export function parseFileHeader(buf: Buffer): {version: number; recSize: number} {
    if (buf.length < FILE_HEADER_SIZE) throw new Error('pointlog: file too short for header');
    if (buf.compare(FILE_MAGIC, 0, 4, 0, 4) !== 0) throw new Error(`pointlog: bad magic (got ${buf.subarray(0, 4).toString('hex')})`);
    const version = buf.readUInt16LE(4);
    const recSize = buf.readUInt16LE(6);
    if (version !== FILE_FORMAT_VERSION) throw new Error(`pointlog: unsupported version ${version}`);
    if (recSize !== RECORD_SIZE) throw new Error(`pointlog: unexpected recSize ${recSize} (expected ${RECORD_SIZE})`);
    return {version, recSize};
}

// Field offsets within a record.
const OFF_WRITE_TIME = 0;
const OFF_D = 4;
const OFF_F = 6;
const OFF_O = 10;
const OFF_LAT = 20;
const OFF_LNG = 24;
const OFF_A = 28;
const OFF_G = 30;
const OFF_B = 32;
const OFF_S = 34;

// Parse a 6-hex flarm ID to a uint32. Production flarmids are always 6-hex
// (OGN protocol), so this round-trips cleanly. `| 0` coerces NaN to 0 in
// the unexpected non-hex case.
export function fidFromFlarm(flarm: string): number {
    return parseInt(flarm, 16) | 0;
}

// Serialize one message into a 36-byte record. Throws only if d falls
// outside int16 range (writer state corruption — surfaces immediately).
export function serializeRecord(msg: LoggedMessage): Buffer {
    const d = ((msg.d ?? 0) as number) | 0;
    if (d < D_MIN || d > D_MAX) {
        throw new Error(`pointlog: d=${d} out of int16 range for flarm=${msg.f} t=${msg.t}`);
    }
    const writeTime = (msg.t + d) >>> 0;
    const rec = Buffer.alloc(RECORD_SIZE);
    rec.writeUInt32LE(writeTime, OFF_WRITE_TIME);
    rec.writeInt16LE(d, OFF_D);
    rec.writeUInt32LE(fidFromFlarm(msg.f), OFF_F);
    // 10-byte fixed ASCII slot for the sender. `write` truncates anything
    // longer than 10 chars and leaves zero padding after a short value
    // (Buffer.alloc above filled with zeros). The aprs.ts dedup tiebreaker
    // compares the decoded string, so the full sender name round-trips up
    // to 10 chars; longer collisions are a soft quality degradation.
    rec.write(msg.o ?? '', OFF_O, O_FIELD_LEN, 'ascii');
    rec.writeInt32LE(Math.round((msg.lat as number) * 1e7), OFF_LAT);
    rec.writeInt32LE(Math.round((msg.lng as number) * 1e7), OFF_LNG);
    rec.writeInt16LE((msg.a as number) | 0, OFF_A);
    rec.writeInt16LE((msg.g as number) | 0, OFF_G);
    rec.writeInt16LE(msg.b == null ? -1 : (msg.b as number) | 0, OFF_B);
    rec.writeInt16LE(msg.s == null ? -1 : Math.round((msg.s as number) * 10), OFF_S);
    return rec;
}

// Decode a record from the given offset into a LoggedMessage. Reconstructed
// fields: t (= writeTime - d), f (uppercase hex), c (= f, for dumptracks),
// l (always null, matches what the writer always stored).
export function deserializeRecord(buf: Buffer, offset: number): LoggedMessage {
    const writeTime = buf.readUInt32LE(offset + OFF_WRITE_TIME);
    const d = buf.readInt16LE(offset + OFF_D);
    const fid = buf.readUInt32LE(offset + OFF_F);
    const f = fid.toString(16).toUpperCase().padStart(6, '0');
    // ASCII slot is zero-padded — strip the trailing zeros.
    let oEnd = offset + OFF_O + O_FIELD_LEN;
    while (oEnd > offset + OFF_O && buf[oEnd - 1] === 0) oEnd--;
    const o = buf.toString('ascii', offset + OFF_O, oEnd);
    const lat = buf.readInt32LE(offset + OFF_LAT) / 1e7;
    const lng = buf.readInt32LE(offset + OFF_LNG) / 1e7;
    const a = buf.readInt16LE(offset + OFF_A);
    const g = buf.readInt16LE(offset + OFF_G);
    const bRaw = buf.readInt16LE(offset + OFF_B);
    const sRaw = buf.readInt16LE(offset + OFF_S);
    const out: any = {
        t: writeTime - d,
        d,
        f,
        c: f, // dumptracks fallback; aprs.ts reload overwrites with target.compno
        o,
        lat,
        lng,
        a,
        g,
        l: null,
    };
    if (bRaw !== -1) out.b = bRaw;
    if (sRaw !== -1) out.s = sRaw / 10;
    return out as LoggedMessage;
}

// ---------- writer ----------

// Wire up stream error / close logging. The default behaviour for an unhandled
// 'error' on a WriteStream is to crash the process; without listeners the
// emit happens before any write callback fires, so writes silently disappear.
function attachStreamHandlers(stream: WriteStream, p: string): void {
    stream.on('error', (err: NodeJS.ErrnoException) => {
        const ageMs = lastWriteTs ? Date.now() - lastWriteTs : -1;
        console.log(`pointlog: STREAM ERROR ${p}: ${err.message} (code=${err.code ?? 'unknown'}, lastWriteAgeMs=${ageMs}) — scheduling reopen`);
        if (activeStream === stream) {
            // Force the next appendPoint into the no-stream branch so we
            // notice rather than writing into a dead descriptor.
            activeStream = undefined;
            scheduleReopen();
        }
    });
    stream.on('close', () => {
        if (activeStream === stream && !rotating) {
            const ageMs = lastWriteTs ? Date.now() - lastWriteTs : -1;
            console.log(`pointlog: stream closed unexpectedly ${p} (writes=${writesSinceOpen}, bytes=${activeBytes}, lastWriteAgeMs=${ageMs})`);
            activeStream = undefined;
            scheduleReopen();
        }
    });
}

// Open a fresh fd against the existing activePath. Used after a stream-level
// failure: filename / firstTs stay the same so readers don't see a phantom
// new session, and writes resume in append mode into the same file. The
// file header is already at offset 0 from the original openLog, so we don't
// re-emit it here.
function reopenStream(): void {
    if (closing || activeStream || !activePath) return;
    try {
        const s = createWriteStream(activePath, {flags: 'a'});
        attachStreamHandlers(s, activePath);
        activeStream = s;
        reopenAttempt = 0;
        lastWriteTs = Date.now();
        console.log(`pointlog: reopened ${activePath} after failure`);
    } catch (e: any) {
        console.log(`pointlog: reopen failed ${activePath}: ${e?.message ?? e} (code=${e?.code ?? 'unknown'})`);
        scheduleReopen();
    }
}

function scheduleReopen(): void {
    if (closing || activeStream || reopenTimer) return;
    const delay = Math.min(60_000, 1000 * Math.pow(2, reopenAttempt));
    reopenAttempt++;
    reopenTimer = setTimeout(() => {
        reopenTimer = undefined;
        reopenStream();
    }, delay);
}

export async function openLog(): Promise<void> {
    closing = false;
    reopenAttempt = 0;
    if (reopenTimer) {
        clearTimeout(reopenTimer);
        reopenTimer = undefined;
    }
    reloadConfig();
    await ensureDir();
    await adoptOrphans();
    await purgeStale();

    activeFirstTs = Math.floor(Date.now() / 1000);
    activePath = path.join(basePath(), activeFilename(activeFirstTs));
    activeStream = createWriteStream(activePath, {flags: 'a'});
    attachStreamHandlers(activeStream, activePath);
    const fileHeader = buildFileHeader();
    activeStream.write(fileHeader);
    activeBytes = fileHeader.length;
    writesSinceOpen = 0;
    lastWriteTs = Date.now();
    console.log(`pointlog: opened ${activePath} (pid=${pid}, host=${hostname})`);
}

export async function closeLog(): Promise<void> {
    closing = true;
    if (reopenTimer) {
        clearTimeout(reopenTimer);
        reopenTimer = undefined;
    }
    if (!activeStream) return;
    await new Promise<void>((resolve) => activeStream!.end(() => resolve()));
    activeStream = undefined;
}

// Test hook: exposes the singleton stream so unit tests can drive the
// auto-reopen path with synthetic 'error' events. Not for production use.
export function __testGetActiveStream(): WriteStream | undefined {
    return activeStream;
}

export function appendPoint(message: LoggedMessage): void {
    if (!activeStream) {
        logThrottled(
            () => lastNoStreamLog,
            (t) => (lastNoStreamLog = t),
            5000,
            `pointlog: appendPoint dropped — no active stream (rotating=${rotating}, closing=${closing}, lastPath=${activePath || '<none>'})`
        );
        if (!rotating) scheduleReopen();
        return;
    }
    let rec: Buffer;
    try {
        rec = serializeRecord(message);
    } catch (e: any) {
        // Over-budget payload, or d out of int16 range. Drop the record
        // rather than crash the daemon, but throttle-log so it's visible.
        logThrottled(
            () => lastEncodeFailLog,
            (t) => (lastEncodeFailLog = t),
            10000,
            `pointlog: appendPoint dropped — serializeRecord failed: ${e?.message ?? e}`
        );
        return;
    }
    if (rotating) {
        pendingWrites.push(rec);
        if (pendingWrites.length > pendingHighWater) pendingHighWater = pendingWrites.length;
        // 5 000 ≈ a couple of seconds of nominal traffic; if rotate() has
        // wedged we want to see the queue climbing rather than silently
        // ballooning until OOM.
        if (pendingWrites.length >= 5000) {
            logThrottled(
                () => lastQueueLog,
                (t) => (lastQueueLog = t),
                10000,
                `pointlog: pendingWrites=${pendingWrites.length} (rotate stuck? activePath=${activePath})`
            );
        }
        return;
    }
    const ok = activeStream.write(rec);
    if (!ok) {
        // Backpressure isn't fatal but if it pins for long the kernel buffer
        // is full or the disk is choking — worth one line per 30s.
        logThrottled(
            () => lastWriteFailLog,
            (t) => (lastWriteFailLog = t),
            30000,
            `pointlog: write returned false (backpressure) on ${activePath}, bytes=${activeBytes}`
        );
    }
    activeBytes += rec.length;
    writesSinceOpen++;
    lastWriteTs = Date.now();
    if (activeBytes >= rotateThreshold) {
        // Fire and forget — rotation handles its own errors, but log if the
        // promise still rejects so we don't lose the failure.
        rotate().catch((e: any) => {
            console.log(`pointlog: rotate() rejected: ${e?.message ?? e} (stack=${e?.stack ?? 'none'})`);
            rotating = false; // unstick so future writes aren't permanently queued
            if (!activeStream) scheduleReopen();
        });
    }
}

async function rotate(): Promise<void> {
    if (rotating || !activeStream) return;
    rotating = true;
    const queuedAtStart = pendingWrites.length;
    try {
        const oldStream = activeStream;
        const oldPath = activePath;
        const oldFirstTs = activeFirstTs;
        // Encode the writer's wall-clock at close into the filename. This
        // is an upper bound on every record's writeTime in the file — every
        // record was written before this moment. Using max(writeTime) here
        // would underestimate the bound when the file ends with a backfilled
        // chunk whose t lags wall clock; wall-clock at close is conservative.
        const oldLastTs = Math.floor(Date.now() / 1000);

        await new Promise<void>((resolve) => {
            oldStream.end((err?: Error | null) => {
                if (err) console.log(`pointlog: end() on ${oldPath} reported error: ${err.message}`);
                resolve();
            });
        });

        const rotatedPath = path.join(basePath(), rotatedFilename(hostname, pid, oldFirstTs, oldLastTs));
        try {
            await fsp.rename(oldPath, rotatedPath);
        } catch (e: any) {
            console.log(`pointlog: rename failed ${oldPath} → ${rotatedPath}: ${e.message} (code=${e.code})`);
        }

        activeFirstTs = Math.floor(Date.now() / 1000);
        if (activeFirstTs <= oldLastTs) activeFirstTs = oldLastTs + 1;
        activePath = path.join(basePath(), activeFilename(activeFirstTs));
        try {
            activeStream = createWriteStream(activePath, {flags: 'a'});
            attachStreamHandlers(activeStream, activePath);
        } catch (e: any) {
            console.log(`pointlog: createWriteStream failed for ${activePath}: ${e?.message ?? e} (code=${e?.code ?? 'unknown'}) — discarding ${pendingWrites.length} queued records, scheduling reopen`);
            activeStream = undefined;
            pendingWrites.length = 0;
            scheduleReopen();
            return;
        }
        const newHeader = buildFileHeader();
        activeStream.write(newHeader);
        activeBytes = newHeader.length;
        writesSinceOpen = 0;
        lastWriteTs = Date.now();
        console.log(`pointlog: rotated → ${rotatedPath}; new active ${activePath} (queued=${queuedAtStart}, highWater=${pendingHighWater})`);
        pendingHighWater = 0;

        // Flush any writes that queued during rotation.
        while (pendingWrites.length > 0) {
            const rec = pendingWrites.shift()!;
            activeStream.write(rec);
            activeBytes += rec.length;
        }
    } finally {
        rotating = false;
    }
    await purgeStale();
}

async function adoptOrphans(): Promise<void> {
    const files = await listAprsFiles();
    for (const f of files) {
        if (f.rotated) continue;
        if (f.host !== hostname) continue;
        if (f.pid === pid) continue; // our own (shouldn't exist yet, but be safe)
        if (isPidAlive(f.pid)) continue;
        // Orphan — adopt it. The dead process never got to encode a close
        // time into its filename, so use the file's mtime as the proxy.
        // mtime is the OS's record of the last write, which is exactly the
        // wall-clock semantic we want for `lastTs` going forward.
        const fullPath = path.join(basePath(), f.file);
        let lastTs: number | undefined;
        let fileSize = 0;
        try {
            const st = await fsp.stat(fullPath);
            fileSize = st.size;
            if (fileSize > 0) lastTs = Math.floor(st.mtimeMs / 1000);
        } catch (e: any) {
            console.log(`pointlog: cannot stat ${f.file}: ${e.message}`);
        }
        // A file with only the file header carries no records — treat as
        // empty and delete instead of rotating.
        if (fileSize <= FILE_HEADER_SIZE || lastTs == null) {
            try {
                await fsp.unlink(fullPath);
                console.log(`pointlog: removed empty orphan ${f.file}`);
            } catch (e: any) {
                console.log(`pointlog: unlink ${f.file} failed: ${e.message}`);
            }
            continue;
        }
        if (lastTs < f.firstTs) lastTs = f.firstTs;
        const newName = rotatedFilename(f.host, f.pid, f.firstTs, lastTs);
        try {
            await fsp.rename(fullPath, path.join(basePath(), newName));
            console.log(`pointlog: adopted orphan ${f.file} → ${newName}`);
        } catch (e: any) {
            console.log(`pointlog: adopt rename failed: ${e.message}`);
        }
    }
}

async function purgeStale(): Promise<void> {
    const files = await listAprsFiles();
    const nowMs = Date.now();
    for (const f of files) {
        const fullPath = path.join(basePath(), f.file);
        let shouldUnlink = false;

        if (f.rotated) {
            if (nowMs - (f.lastTs as number) * 1000 > retainMs) shouldUnlink = true;
        } else {
            // Active file. Never purge our own or a live same-host peer.
            if (f.host === hostname && f.pid === pid) continue;
            if (f.host === hostname && isPidAlive(f.pid)) continue;
            // Either cross-host, or same-host dead PID that adopt missed — purge by firstTs.
            if (nowMs - f.firstTs * 1000 > retainMs) shouldUnlink = true;
        }

        if (shouldUnlink) {
            try {
                await fsp.unlink(fullPath);
                console.log(`pointlog: purged ${f.file}`);
            } catch (e: any) {
                if (e.code !== 'ENOENT') console.log(`pointlog: unlink ${f.file}: ${e.message}`);
            }
        }
    }
}

// ---------- reader ----------

export interface LoadPointsQuery {
    flarmId: FlarmID;
    since: number; // epoch seconds (inclusive, with slack)
    until?: number; // epoch seconds (inclusive)
}

export interface LoadPointsForIdsQuery {
    flarmIds?: Set<string>;
    since: number;
    until?: number;
}

interface OpenFile {
    fd: number;
    size: number;
    recSize: number;
    recordCount: number;
}

function openRecordFile(fullPath: string): OpenFile | undefined {
    const size = statSync(fullPath).size;
    if (size < FILE_HEADER_SIZE) return undefined;
    const fd = openSync(fullPath, 'r');
    try {
        const hdr = Buffer.alloc(FILE_HEADER_SIZE);
        const n = readSync(fd, hdr, 0, FILE_HEADER_SIZE, 0);
        if (n < FILE_HEADER_SIZE) {
            closeSync(fd);
            return undefined;
        }
        const {recSize} = parseFileHeader(hdr);
        const body = size - FILE_HEADER_SIZE;
        const recordCount = Math.floor(body / recSize);
        return {fd, size, recSize, recordCount};
    } catch (e) {
        closeSync(fd);
        throw e;
    }
}

// Returns the index of the first record whose writeTime >= target, or
// recordCount if every record is below target. Reads only the 4-byte
// writeTime field — no V8 deserialization, no signed math, no addition
// on the probe path.
export function binarySearchForTs(fd: number, recordCount: number, recSize: number, target: number): number {
    const probe = Buffer.alloc(4);
    let lo = 0;
    let hi = recordCount;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const off = FILE_HEADER_SIZE + mid * recSize;
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

// One-shot scanner. Chunked reads, then per-record: peek the 6-byte header,
// drop on t-range, deserialize the V8 payload only for the records we're
// going to yield.
async function* scanFileRecords(fullPath: string, q: {since: number; until?: number; flarmId?: FlarmID; flarmIds?: Set<string>}): AsyncGenerator<LoggedMessage> {
    const opened = openRecordFile(fullPath);
    if (!opened) return;
    const {fd, recSize, recordCount} = opened;
    // Pre-compute uint32 fingerprints for the filter set so the hot loop
    // does a single Set.has(uint32) per record. Flarm IDs are always 6-hex
    // in production (the OGN protocol enforces it), so the fid uniquely
    // identifies the flarm — no string post-check needed.
    const fidSet: Set<number> | undefined = q.flarmId != null ? new Set([fidFromFlarm(q.flarmId)]) : q.flarmIds != null ? new Set([...q.flarmIds].map(fidFromFlarm)) : undefined;
    try {
        const startIndex = binarySearchForTs(fd, recordCount, recSize, q.since - OUT_OF_ORDER_SLACK_SEC);
        const chunkBytes = RECORDS_PER_CHUNK * recSize;
        const buf = Buffer.alloc(chunkBytes);
        for (let i = startIndex; i < recordCount; ) {
            const recsThisChunk = Math.min(RECORDS_PER_CHUNK, recordCount - i);
            const toRead = recsThisChunk * recSize;
            const off = FILE_HEADER_SIZE + i * recSize;
            const n = readSync(fd, buf, 0, toRead, off);
            if (n <= 0) break;
            const recsRead = Math.floor(n / recSize);
            for (let r = 0; r < recsRead; r++) {
                const recOff = r * recSize;
                const writeTime = buf.readUInt32LE(recOff + OFF_WRITE_TIME);
                const d = buf.readInt16LE(recOff + OFF_D);
                const t = writeTime - d;
                if (t < q.since) continue;
                // File is monotonic in writeTime but NOT in t — a backfill
                // replay can drop a packet with future-ish t in the middle.
                // `continue`, don't `return`, so the rest of the scan stands.
                if (q.until != null && t > q.until) continue;
                // Fast flarm-ID pre-filter — single uint32 read, no further
                // decode for the ~97% of records that don't match.
                if (fidSet) {
                    const fid = buf.readUInt32LE(recOff + OFF_F);
                    if (!fidSet.has(fid)) continue;
                }
                yield deserializeRecord(buf, recOff);
            }
            i += recsRead;
            if (recsRead < recsThisChunk) break; // short read at EOF
            // Cooperative yield so live APRS packets and parentPort messages
            // don't starve during a long scan.
            await new Promise<void>((r) => setImmediate(r));
        }
    } finally {
        closeSync(fd);
    }
}

// Filename timestamps are writer wall-clock at open (firstTs) and close
// (lastTs). lastTs is a hard upper bound on every record's writeTime in
// the file — so `lastTs < since - SLACK` is a safe "this file has nothing
// in our window" prefilter for rotated files. We never prefilter by
// `firstTs` against `until`: firstTs is open time, not a lower bound on
// the message t (a backfill replay can append old-t records to a freshly
// opened file).
function pickCandidates(files: ParsedName[], since: number): ParsedName[] {
    return files
        .filter((f) => {
            if (f.rotated && (f.lastTs as number) < since - OUT_OF_ORDER_SLACK_SEC) return false;
            return true;
        })
        .sort((a, b) => a.firstTs - b.firstTs);
}

// Iterate every message across every file — diagnostic use (CLI tools that
// summarise across all flarmids). Slow (O(total bytes)) but simple.
export async function* scanAll(opts: {since?: number; until?: number} = {}): AsyncGenerator<LoggedMessage> {
    const files = await listAprsFiles();
    const since = opts.since ?? 0;
    for (const f of pickCandidates(files, since)) {
        const fullPath = path.join(basePath(), f.file);
        try {
            yield* scanFileRecords(fullPath, {since, until: opts.until});
        } catch (e: any) {
            if (e.code === 'ENOENT') continue;
            console.log(`pointlog: scan ${f.file}: ${e.message}`);
        }
    }
}

export async function* loadPoints(q: LoadPointsQuery): AsyncGenerator<LoggedMessage> {
    const files = await listAprsFiles();
    for (const f of pickCandidates(files, q.since)) {
        const fullPath = path.join(basePath(), f.file);
        try {
            yield* scanFileRecords(fullPath, {since: q.since, until: q.until, flarmId: q.flarmId});
        } catch (e: any) {
            if (e.code === 'ENOENT') continue; // rotated/purged mid-scan
            console.log(`pointlog: scan ${f.file}: ${e.message}`);
        }
    }
}

// Bulk variant: scan each candidate file once, yielding any record whose
// flarmId is in the provided set. Caller is responsible for dispatching to
// per-id queues and any per-id since trim (use the min(since) here, then
// drop msg.t < target.since at dispatch time). Cuts restart cost from
// (n_gliders × n_files × scan) down to (n_files × scan).
//
// If flarmIds is omitted, every record in the window is yielded — used by
// matching tools that don't know the candidate ids in advance.
export async function* loadPointsForIds(q: LoadPointsForIdsQuery): AsyncGenerator<LoggedMessage> {
    const files = await listAprsFiles();
    for (const f of pickCandidates(files, q.since)) {
        const fullPath = path.join(basePath(), f.file);
        try {
            yield* scanFileRecords(fullPath, {since: q.since, until: q.until, flarmIds: q.flarmIds});
        } catch (e: any) {
            if (e.code === 'ENOENT') continue;
            console.log(`pointlog: scan ${f.file}: ${e.message}`);
        }
    }
}
