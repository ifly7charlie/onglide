import {createWriteStream, WriteStream, promises as fsp, openSync, closeSync, readSync, statSync} from 'fs';
import * as path from 'path';
import * as os from 'os';

import type {PositionMessage} from '../types';
import type {FlarmID} from '../types';
import {scanFileV8, scanFileForIdsV8, scanFileAllV8} from './pointlog-v8';

// Line format: the serialized message itself, one JSON object per line.
// The message carries t (epoch), f (flarmId), o (sender) already — no
// wrapper needed.
export type LoggedMessage = PositionMessage & {f: FlarmID; o: string; ad?: number; d?: number};

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
const pendingWrites: string[] = [];

// Silent-failure diagnostics. The WriteStream has no error path of its own;
// if writes start going nowhere we want one log line per failure mode rather
// than total silence. Throttle so a sustained fault doesn't flood syslog.
let writesSinceOpen = 0;
let lastWriteTs = 0;
let lastNoStreamLog = 0;
let lastQueueLog = 0;
let lastWriteFailLog = 0;
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
// Active:   aprs-<host>-<pid>-<firstTs>.log        (3 segments)
// Rotated:  aprs-<host>-<pid>-<firstTs>-<lastTs>.log (4 segments)
// V8 variant uses the same scheme with .v8 suffix; produced by
// bin/convert-pointlog.ts, never written by the live daemon.
const FILE_PREFIX = 'aprs-';
const FILE_SUFFIX_LOG = '.log';
const FILE_SUFFIX_V8 = '.v8';

export type PointlogFormat = 'log' | 'v8';

function pointlogFormat(): PointlogFormat {
    const v = process.env.POINTLOG_FORMAT;
    return v === 'v8' ? 'v8' : 'log';
}

interface ParsedName {
    file: string;
    host: string;
    pid: number;
    firstTs: number;
    lastTs?: number; // defined iff rotated
    rotated: boolean;
    format: PointlogFormat;
}

function parseFilename(file: string): ParsedName | undefined {
    if (!file.startsWith(FILE_PREFIX)) return undefined;
    let format: PointlogFormat;
    let suffix: string;
    if (file.endsWith(FILE_SUFFIX_LOG)) {
        format = 'log';
        suffix = FILE_SUFFIX_LOG;
    } else if (file.endsWith(FILE_SUFFIX_V8)) {
        format = 'v8';
        suffix = FILE_SUFFIX_V8;
    } else {
        return undefined;
    }
    const core = file.slice(FILE_PREFIX.length, -suffix.length);
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
    return {file, host, pid: parsedPid, firstTs: parsedFirst, lastTs: parsedLast, rotated: lastStr != null, format};
}

function activeFilename(firstTs: number): string {
    return `${FILE_PREFIX}${hostname}-${pid}-${firstTs}${FILE_SUFFIX_LOG}`;
}

function rotatedFilename(host: string, pidN: number, firstTs: number, lastTs: number): string {
    return `${FILE_PREFIX}${host}-${pidN}-${firstTs}-${lastTs}${FILE_SUFFIX_LOG}`;
}

async function ensureDir(): Promise<void> {
    await fsp.mkdir(basePath(), {recursive: true});
}

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
// new session, and writes resume in append mode into the same file.
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

// ---------- public API ----------

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
    activeBytes = 0;
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
    const line = JSON.stringify(message) + '\n';
    if (rotating) {
        pendingWrites.push(line);
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
    const ok = activeStream.write(line);
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
    activeBytes += Buffer.byteLength(line, 'utf8');
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
        // is an upper bound on every record's t in the file — every record
        // was written before this moment, and d ≥ 0 means t ≤ write_time.
        // Using max(t in records) here would underestimate the bound when
        // the file ends with a backfilled chunk whose t lags wall clock.
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
            console.log(`pointlog: createWriteStream failed for ${activePath}: ${e?.message ?? e} (code=${e?.code ?? 'unknown'}) — discarding ${pendingWrites.length} queued lines, scheduling reopen`);
            activeStream = undefined;
            pendingWrites.length = 0;
            scheduleReopen();
            return;
        }
        activeBytes = 0;
        writesSinceOpen = 0;
        lastWriteTs = Date.now();
        console.log(`pointlog: rotated → ${rotatedPath}; new active ${activePath} (queued=${queuedAtStart}, highWater=${pendingHighWater})`);
        pendingHighWater = 0;

        // Flush any writes that queued during rotation.
        while (pendingWrites.length > 0) {
            const line = pendingWrites.shift()!;
            activeStream.write(line);
            activeBytes += Buffer.byteLength(line, 'utf8');
        }
    } finally {
        rotating = false;
    }
    await purgeStale();
}

async function adoptOrphans(): Promise<void> {
    const files = await listAprsFiles();
    const now = Math.floor(Date.now() / 1000);
    for (const f of files) {
        // .v8 files are derived/static — never an "active" stream to adopt.
        if (f.format !== 'log') continue;
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
        if (fileSize === 0 || lastTs == null) {
            // Empty / unreadable — delete.
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
    void now;
}

async function purgeStale(): Promise<void> {
    const files = await listAprsFiles();
    const nowMs = Date.now();
    for (const f of files) {
        const fullPath = path.join(basePath(), f.file);
        let shouldUnlink = false;

        if (f.format === 'v8') {
            // Derived files. Purge by lastTs if rotated, firstTs otherwise —
            // they have no live writer to protect.
            const refTs = f.rotated ? (f.lastTs as number) : f.firstTs;
            if (nowMs - refTs * 1000 > retainMs) shouldUnlink = true;
        } else if (f.rotated) {
            if (nowMs - (f.lastTs as number) * 1000 > retainMs) shouldUnlink = true;
        } else {
            // Active .log file. Never purge our own or a live same-host peer.
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

const OUT_OF_ORDER_SLACK_SEC = 30;

// Iterate every message across every file — diagnostic use (CLI tools that
// summarise across all flarmids). Slow (O(total bytes)) but simple.
export async function* scanAll(opts: {since?: number; until?: number} = {}): AsyncGenerator<LoggedMessage> {
    const fmt = pointlogFormat();
    const files = await listAprsFiles();
    const since = opts.since ?? 0;
    const candidates = files
        .filter((f) => f.format === fmt)
        .filter((f) => (f.rotated && (f.lastTs as number) < since - OUT_OF_ORDER_SLACK_SEC ? false : true))
        .sort((a, b) => a.firstTs - b.firstTs);
    for (const f of candidates) {
        const fullPath = path.join(basePath(), f.file);
        try {
            if (f.format === 'v8') {
                yield* scanFileAllV8(fullPath, since, opts.until);
            } else {
                yield* scanFileAll(fullPath, since, opts.until);
            }
        } catch (e: any) {
            if (e.code === 'ENOENT') continue;
            console.log(`pointlog: scan ${f.file}: ${e.message}`);
        }
    }
}

async function* scanFileAll(fullPath: string, since: number, until: number | undefined): AsyncGenerator<LoggedMessage> {
    const size = statSync(fullPath).size;
    if (size === 0) return;
    const startOffset = since > 0 ? binarySearchForTs(fullPath, size, since - OUT_OF_ORDER_SLACK_SEC) : 0;
    const fd = openSync(fullPath, 'r');
    try {
        const chunkSize = 64 * 1024;
        const buf = Buffer.alloc(chunkSize);
        let leftover = '';
        let offset = startOffset;
        while (offset < size) {
            const toRead = Math.min(chunkSize, size - offset);
            const n = readSync(fd, buf, 0, toRead, offset);
            if (n <= 0) break;
            offset += n;
            const chunk = leftover + buf.subarray(0, n).toString('utf8');
            const lines = chunk.split('\n');
            leftover = lines.pop() ?? '';
            for (const line of lines) {
                if (!line) continue;
                let msg: LoggedMessage;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (typeof msg.t !== 'number') continue;
                if (msg.t < since) continue;
                // See scanFileForIds: file is arrival-ordered, not
                // strictly t-ordered.
                if (until != null && msg.t > until) continue;
                yield msg;
            }
        }
        if (leftover) {
            try {
                const msg: LoggedMessage = JSON.parse(leftover);
                if (typeof msg.t === 'number' && msg.t >= since && (until == null || msg.t <= until)) yield msg;
            } catch {}
        }
    } finally {
        closeSync(fd);
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
export interface LoadPointsForIdsQuery {
    flarmIds?: Set<string>;
    since: number;
    until?: number;
}

export async function* loadPointsForIds(q: LoadPointsForIdsQuery): AsyncGenerator<LoggedMessage> {
    const fmt = pointlogFormat();
    const files = await listAprsFiles();
    const candidates = files
        .filter((f) => f.format === fmt)
        .filter((f) => {
            if (f.rotated && (f.lastTs as number) < q.since - OUT_OF_ORDER_SLACK_SEC) return false;
            return true;
        })
        .sort((a, b) => a.firstTs - b.firstTs);

    for (const f of candidates) {
        const fullPath = path.join(basePath(), f.file);
        try {
            if (f.format === 'v8') {
                yield* scanFileForIdsV8(fullPath, q);
            } else {
                yield* scanFileForIds(fullPath, q);
            }
        } catch (e: any) {
            if (e.code === 'ENOENT') continue;
            console.log(`pointlog: scan ${f.file}: ${e.message}`);
        }
    }
}

async function* scanFileForIds(fullPath: string, q: LoadPointsForIdsQuery): AsyncGenerator<LoggedMessage> {
    const size = statSync(fullPath).size;
    if (size === 0) return;

    const startOffset = binarySearchForTs(fullPath, size, q.since - OUT_OF_ORDER_SLACK_SEC);

    const fd = openSync(fullPath, 'r');
    try {
        const chunkSize = 64 * 1024;
        const buf = Buffer.alloc(chunkSize);
        let leftover = '';
        let offset = startOffset;

        while (offset < size) {
            const toRead = Math.min(chunkSize, size - offset);
            const n = readSync(fd, buf, 0, toRead, offset);
            if (n <= 0) break;
            offset += n;
            const chunk = leftover + buf.subarray(0, n).toString('utf8');
            const lines = chunk.split('\n');
            leftover = lines.pop() ?? '';

            for (const line of lines) {
                if (!line) continue;
                let msg: LoggedMessage;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (typeof msg.t !== 'number') continue;
                if (msg.t < q.since) continue;
                // The log is roughly arrival-ordered, not t-ordered: a
                // backfill replay or a receiver with clock skew can drop
                // a packet with future-ish t in the middle of the file.
                // `continue` (not `return`) past it so the rest of the
                // file's legitimate records still get scanned.
                if (q.until != null && msg.t > q.until) continue;
                if (q.flarmIds && !q.flarmIds.has(msg.f)) continue;
                yield msg;
            }

            // Yield to the macrotask queue so live APRS data and parentPort
            // messages don't starve during a long bulk scan.
            await new Promise<void>((r) => setImmediate(r));
        }
        if (leftover) {
            try {
                const msg: LoggedMessage = JSON.parse(leftover);
                if (typeof msg.t === 'number' && msg.t >= q.since && (q.until == null || msg.t <= q.until) && (!q.flarmIds || q.flarmIds.has(msg.f))) {
                    yield msg;
                }
            } catch {}
        }
    } finally {
        closeSync(fd);
    }
}

export async function* loadPoints(q: LoadPointsQuery): AsyncGenerator<LoggedMessage> {
    const fmt = pointlogFormat();
    const files = await listAprsFiles();
    // Filename timestamps are writer wall-clock at open (firstTs) and
    // close (lastTs). With every record carrying d ≥ 0, lastTs is a hard
    // upper bound on every record's t in the file — so `lastTs < since`
    // is a safe "this file has nothing in our window" prefilter for
    // rotated files. We never prefilter by `firstTs` against `until`:
    // firstTs is open time, not a lower bound on t (a backfill replay can
    // append old-t records to a freshly opened file).
    const candidates = files
        .filter((f) => f.format === fmt)
        .filter((f) => {
            if (f.rotated && (f.lastTs as number) < q.since - OUT_OF_ORDER_SLACK_SEC) return false;
            return true;
        })
        .sort((a, b) => a.firstTs - b.firstTs);

    for (const f of candidates) {
        const fullPath = path.join(basePath(), f.file);
        try {
            if (f.format === 'v8') {
                yield* scanFileV8(fullPath, q);
            } else {
                yield* scanFile(fullPath, q);
            }
        } catch (e: any) {
            if (e.code === 'ENOENT') continue; // rotated/purged mid-scan
            console.log(`pointlog: scan ${f.file}: ${e.message}`);
        }
    }
}

// Scan a single file, starting at a binary-search position for since.
async function* scanFile(fullPath: string, q: LoadPointsQuery): AsyncGenerator<LoggedMessage> {
    const size = statSync(fullPath).size;
    if (size === 0) return;

    const startOffset = binarySearchForTs(fullPath, size, q.since - OUT_OF_ORDER_SLACK_SEC);

    const fd = openSync(fullPath, 'r');
    try {
        const chunkSize = 64 * 1024;
        const buf = Buffer.alloc(chunkSize);
        let leftover = '';
        let offset = startOffset;

        while (offset < size) {
            const toRead = Math.min(chunkSize, size - offset);
            const n = readSync(fd, buf, 0, toRead, offset);
            if (n <= 0) break;
            offset += n;
            const chunk = leftover + buf.subarray(0, n).toString('utf8');
            const lines = chunk.split('\n');
            leftover = lines.pop() ?? '';

            for (const line of lines) {
                if (!line) continue;
                let msg: LoggedMessage;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (msg.f !== q.flarmId) continue;
                if (typeof msg.t !== 'number') continue;
                if (msg.t < q.since) continue;
                // See note in scanFileForIds: file is arrival-ordered,
                // not strictly t-ordered, so a single rogue future-t
                // packet should not truncate the rest of the scan.
                if (q.until != null && msg.t > q.until) continue;
                yield msg;
            }

            // Yield to the macrotask queue so live APRS data and parentPort
            // messages don't starve while we're chewing through a long file.
            // The for-await consumer otherwise drains microtasks back-to-back
            // and never returns to the event loop.
            await new Promise<void>((r) => setImmediate(r));
        }
        // Try the trailing leftover too (file might not end with \n).
        if (leftover) {
            try {
                const msg: LoggedMessage = JSON.parse(leftover);
                if (msg.f === q.flarmId && typeof msg.t === 'number' && msg.t >= q.since && (q.until == null || msg.t <= q.until)) {
                    yield msg;
                }
            } catch {
                // partial last line
            }
        }
    } finally {
        closeSync(fd);
    }
}

// Return a byte offset at which to start scanning. The offset points to the
// start of a line whose t+d (writer wall-clock at the moment that line was
// serialized) is roughly <= target. We compare on t+d, not t alone: the
// file is monotonic in t+d (each line is appended at its writer-now), but
// NOT in t — backfill replays from APRS-IS history can inject very-old-t
// packets in the middle of an otherwise live-ordered file (d up to ~17 min
// observed), and a probed t there is wildly out of step with the file's
// ambient write-time at that offset. The caller is responsible for final
// filtering (t >= since) during scan.
function binarySearchForTs(fullPath: string, size: number, target: number): number {
    const fd = openSync(fullPath, 'r');
    try {
        let lo = 0;
        let hi = size;
        const probeBuf = Buffer.alloc(512);

        while (hi - lo > 4096) {
            const mid = Math.floor((lo + hi) / 2);
            const {offset, t, d} = readLineAt(fd, size, mid, probeBuf);
            if (offset == null || t == null) {
                // Couldn't parse — widen toward lo.
                hi = mid;
                continue;
            }
            const writeTime = t + d;
            if (writeTime < target)
                lo = offset + 1; // skip past this line start
            else hi = offset;
        }
        // Align lo to a line start: scan backward from lo to the previous \n (or BOF).
        return alignToLineStart(fd, lo);
    } finally {
        closeSync(fd);
    }
}

// Read the line that contains byte `pos`: seek to pos, back up to the
// previous '\n', read forward to the next '\n', parse. Returns the start
// offset of that line, its parsed t, and its parsed d (defaults to 0 when
// absent — older log format, or live packets that didn't record a latency).
function readLineAt(fd: number, size: number, pos: number, _scratch: Buffer): {offset: number | null; t: number | null; d: number} {
    const start = alignToLineStart(fd, pos);
    // Read up to 8 KB from start to find next newline and parse.
    const maxLine = 8 * 1024;
    const buf = Buffer.alloc(Math.min(maxLine, size - start));
    const n = readSync(fd, buf, 0, buf.length, start);
    if (n <= 0) return {offset: null, t: null, d: 0};
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const line = nl >= 0 ? text.slice(0, nl) : text;
    try {
        const msg = JSON.parse(line);
        if (typeof msg.t === 'number') {
            return {offset: start, t: msg.t, d: typeof msg.d === 'number' ? msg.d : 0};
        }
    } catch {
        // fall through
    }
    return {offset: start, t: null, d: 0};
}

function alignToLineStart(fd: number, pos: number): number {
    if (pos <= 0) return 0;
    const probe = Buffer.alloc(512);
    let cur = pos;
    while (cur > 0) {
        const readFrom = Math.max(0, cur - probe.length);
        const toRead = cur - readFrom;
        const n = readSync(fd, probe, 0, toRead, readFrom);
        if (n <= 0) return 0;
        // Find last '\n' in probe[0..n]
        for (let i = n - 1; i >= 0; i--) {
            if (probe[i] === 0x0a) return readFrom + i + 1;
        }
        cur = readFrom;
    }
    return 0;
}
