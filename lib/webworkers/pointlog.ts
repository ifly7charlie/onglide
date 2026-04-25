import {createWriteStream, WriteStream, promises as fsp, openSync, closeSync, readSync, fstatSync, statSync} from 'fs';
import * as path from 'path';
import * as os from 'os';

import type {PositionMessage} from '../types';
import type {FlarmID} from '../types';

// Line format: the serialized message itself, one JSON object per line.
// The message carries t (epoch), f (flarmId), o (sender) already — no
// wrapper needed.
type LoggedMessage = PositionMessage & {f: FlarmID; o: string; ad?: number; d?: number};

// ---------- module state ----------
const hostname = os.hostname();
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
let activeLastTs: number = 0;
let activeBytes: number = 0;
let rotating = false;
const pendingWrites: string[] = [];

// ---------- filename helpers ----------
// Active:   aprs-<host>-<pid>-<firstTs>.log        (3 segments)
// Rotated:  aprs-<host>-<pid>-<firstTs>-<lastTs>.log (4 segments)
const FILE_PREFIX = 'aprs-';
const FILE_SUFFIX = '.log';

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

// Return the timestamp of the last parseable line in a file, or undefined if
// there are none. Reads a small tail buffer.
function readLastTs(filePath: string): number | undefined {
    const fd = openSync(filePath, 'r');
    try {
        const size = fstatSync(fd).size;
        if (size === 0) return undefined;
        const tailSize = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(tailSize);
        readSync(fd, buf, 0, tailSize, size - tailSize);
        const text = buf.toString('utf8');
        // Find last complete line (preceded by \n).
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (typeof msg.t === 'number') return msg.t;
            } catch {
                // malformed; keep searching backward
            }
        }
        return undefined;
    } finally {
        closeSync(fd);
    }
}

// ---------- public API ----------

export async function openLog(): Promise<void> {
    reloadConfig();
    await ensureDir();
    await adoptOrphans();
    await purgeStale();

    activeFirstTs = Math.floor(Date.now() / 1000);
    activeLastTs = activeFirstTs;
    activePath = path.join(basePath(), activeFilename(activeFirstTs));
    activeStream = createWriteStream(activePath, {flags: 'a'});
    activeBytes = 0;
    console.log(`pointlog: opened ${activePath}`);
}

export async function closeLog(): Promise<void> {
    if (!activeStream) return;
    await new Promise<void>((resolve) => activeStream!.end(() => resolve()));
    activeStream = undefined;
}

export function appendPoint(message: LoggedMessage): void {
    if (!activeStream) return; // not open yet (shouldn't happen in practice)
    const line = JSON.stringify(message) + '\n';
    if (rotating) {
        pendingWrites.push(line);
        return;
    }
    activeStream.write(line);
    activeBytes += Buffer.byteLength(line, 'utf8');
    if (typeof message.t === 'number' && message.t > activeLastTs) activeLastTs = message.t;
    if (activeBytes >= rotateThreshold) {
        // Fire and forget — rotation handles its own errors.
        void rotate();
    }
}

async function rotate(): Promise<void> {
    if (rotating || !activeStream) return;
    rotating = true;
    try {
        const oldStream = activeStream;
        const oldPath = activePath;
        const oldFirstTs = activeFirstTs;
        const oldLastTs = activeLastTs;

        await new Promise<void>((resolve) => oldStream.end(() => resolve()));

        const rotatedPath = path.join(basePath(), rotatedFilename(hostname, pid, oldFirstTs, oldLastTs));
        try {
            await fsp.rename(oldPath, rotatedPath);
        } catch (e: any) {
            console.log(`pointlog: rename failed ${oldPath} → ${rotatedPath}: ${e.message}`);
        }

        activeFirstTs = Math.floor(Date.now() / 1000);
        if (activeFirstTs <= oldLastTs) activeFirstTs = oldLastTs + 1;
        activeLastTs = activeFirstTs;
        activePath = path.join(basePath(), activeFilename(activeFirstTs));
        activeStream = createWriteStream(activePath, {flags: 'a'});
        activeBytes = 0;
        console.log(`pointlog: rotated → ${rotatedPath}; new active ${activePath}`);

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
        if (f.rotated) continue;
        if (f.host !== hostname) continue;
        if (f.pid === pid) continue; // our own (shouldn't exist yet, but be safe)
        if (isPidAlive(f.pid)) continue;
        // Orphan — adopt it.
        const fullPath = path.join(basePath(), f.file);
        let lastTs: number | undefined;
        try {
            lastTs = readLastTs(fullPath);
        } catch (e: any) {
            console.log(`pointlog: cannot read ${f.file}: ${e.message}`);
        }
        if (lastTs == null) {
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

const OUT_OF_ORDER_SLACK_SEC = 30;

// Iterate every message across every file — diagnostic use (CLI tools that
// summarise across all flarmids). Slow (O(total bytes)) but simple.
export async function* scanAll(opts: {since?: number; until?: number} = {}): AsyncGenerator<LoggedMessage> {
    const files = await listAprsFiles();
    const since = opts.since ?? 0;
    const candidates = files
        .filter((f) => (f.rotated && (f.lastTs as number) < since - OUT_OF_ORDER_SLACK_SEC ? false : true))
        .sort((a, b) => a.firstTs - b.firstTs);
    for (const f of candidates) {
        const fullPath = path.join(basePath(), f.file);
        try {
            yield* scanFileAll(fullPath, since, opts.until);
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
                if (until != null && msg.t > until) return;
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
export interface LoadPointsForIdsQuery {
    flarmIds: Set<string>;
    since: number;
    until?: number;
}

export async function* loadPointsForIds(q: LoadPointsForIdsQuery): AsyncGenerator<LoggedMessage> {
    const files = await listAprsFiles();
    const candidates = files
        .filter((f) => {
            if (f.rotated && (f.lastTs as number) < q.since - OUT_OF_ORDER_SLACK_SEC) return false;
            return true;
        })
        .sort((a, b) => a.firstTs - b.firstTs);

    for (const f of candidates) {
        const fullPath = path.join(basePath(), f.file);
        try {
            yield* scanFileForIds(fullPath, q);
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
                if (q.until != null && msg.t > q.until) return;
                if (!q.flarmIds.has(msg.f)) continue;
                yield msg;
            }
        }
        if (leftover) {
            try {
                const msg: LoggedMessage = JSON.parse(leftover);
                if (typeof msg.t === 'number' && msg.t >= q.since && (q.until == null || msg.t <= q.until) && q.flarmIds.has(msg.f)) {
                    yield msg;
                }
            } catch {}
        }
    } finally {
        closeSync(fd);
    }
}

export async function* loadPoints(q: LoadPointsQuery): AsyncGenerator<LoggedMessage> {
    const files = await listAprsFiles();
    // Filename timestamps reflect writer wall-clock (open / close). In live
    // operation message-t ≈ wall time, so `lastTs < since` is a valid
    // "this file is too old" prefilter for rotated files. We never prefilter
    // by `firstTs` against `until` — firstTs is writer-open time, not a
    // lower bound on message-t (historical-t writes would break that).
    const candidates = files
        .filter((f) => {
            if (f.rotated && (f.lastTs as number) < q.since - OUT_OF_ORDER_SLACK_SEC) return false;
            return true;
        })
        .sort((a, b) => a.firstTs - b.firstTs);

    for (const f of candidates) {
        const fullPath = path.join(basePath(), f.file);
        try {
            yield* scanFile(fullPath, q);
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
                if (q.until != null && msg.t > q.until) return;
                yield msg;
            }
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
// start of a line whose t is roughly <= target. Caller is responsible for
// final filtering (t >= since) during scan.
function binarySearchForTs(fullPath: string, size: number, target: number): number {
    const fd = openSync(fullPath, 'r');
    try {
        let lo = 0;
        let hi = size;
        const probeBuf = Buffer.alloc(512);

        while (hi - lo > 4096) {
            const mid = Math.floor((lo + hi) / 2);
            const {offset, t} = readLineAt(fd, size, mid, probeBuf);
            if (offset == null || t == null) {
                // Couldn't parse — widen toward lo.
                hi = mid;
                continue;
            }
            if (t < target) lo = offset + 1; // skip past this line start
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
// offset of that line and its parsed t.
function readLineAt(fd: number, size: number, pos: number, _scratch: Buffer): {offset: number | null; t: number | null} {
    const start = alignToLineStart(fd, pos);
    // Read up to 8 KB from start to find next newline and parse.
    const maxLine = 8 * 1024;
    const buf = Buffer.alloc(Math.min(maxLine, size - start));
    const n = readSync(fd, buf, 0, buf.length, start);
    if (n <= 0) return {offset: null, t: null};
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const line = nl >= 0 ? text.slice(0, nl) : text;
    try {
        const msg = JSON.parse(line);
        if (typeof msg.t === 'number') return {offset: start, t: msg.t};
    } catch {
        // fall through
    }
    return {offset: start, t: null};
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
