/*
 * Per-glider scoring log files (on-disk implementation).
 *
 * Each glider that gets a scoring chain writes to
 *   <SCORING_LOG_DIR>/<datecode>/<class>/<compno>.log
 * The file is truncated every time the chain is (re)instantiated, so it
 * always holds the log from the current chain instance up to now.
 *
 * Writes are batched: log calls append to an in-memory buffer and a
 * single shared timer flushes every live logger every few seconds. This
 * keeps the scoring hot path free of per-message disk IO.
 *
 * Worker-only — imports node:fs. The GliderLog type and the no-op
 * fallback live in ./gliderLog, which stays dependency-free.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {inspect} from 'node:util';

import {stripPoints} from '../flightprocessing/taskhelper';
import {fromDateCode} from '../datecode';

import type {GliderLogHandle} from './gliderLog';

const FLUSH_INTERVAL_MS = 3000;

// A datecode whose competition day is more than this far in the past is
// dead — its whole log subtree is removed. 37h leaves a margin past the
// end of the comp day before the previous day's logs are reaped.
const STALE_AFTER_MS = 37 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // rescan for stale datecodes at most hourly

// Every live logger — flushed together by the shared timer / exit hook.
const loggers = new Set<GliderLogHandle>();
let flushTimer: NodeJS.Timeout | null = null;
let exitHooked = false;
let lastPurge = 0;

// Remove log directories for datecodes that are no longer valid. Each
// top-level entry under logBaseDir is a datecode; once fromDateCode()
// puts its competition day >37h in the past the whole subtree is deleted.
// Non-datecode entries parse to an invalid date and are left alone.
function purgeStaleLogs() {
    const now = Date.now();
    if (now - lastPurge < PURGE_INTERVAL_MS) return;
    lastPurge = now;

    let entries: string[];
    try {
        entries = fs.readdirSync(logBaseDir);
    } catch {
        return; // base dir not created yet
    }

    const cutoff = now - STALE_AFTER_MS;
    for (const entry of entries) {
        const dayMs = new Date(fromDateCode(entry)).getTime();
        if (isFinite(dayMs) && dayMs < cutoff) {
            try {
                fs.rmSync(path.join(logBaseDir, entry), {recursive: true, force: true});
            } catch (e) {
                console.log(`gliderLog: unable to remove stale log dir ${entry}: ${e}`);
            }
        }
    }
}

function ensureFlusher() {
    if (!flushTimer) {
        flushTimer = setInterval(() => {
            purgeStaleLogs();
            for (const l of loggers) l.flush();
        }, FLUSH_INTERVAL_MS);
        // Never keep the worker alive purely for the flush timer.
        flushTimer.unref();
    }
    if (!exitHooked) {
        exitHooked = true;
        // 'exit' only allows synchronous work — hence the sync fs calls below.
        process.on('exit', () => {
            for (const l of loggers) l.flush();
        });
    }
}

// console.log-ish formatting. Objects go through JSON.stringify with the
// shared stripPoints replacer so large point arrays don't bloat the file;
// fall back to util.inspect for anything JSON can't handle (circular refs).
function formatArg(a: any): string {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (a !== null && typeof a === 'object') {
        try {
            return JSON.stringify(a, stripPoints) ?? String(a);
        } catch {
            return inspect(a, {depth: 4, breakLength: Infinity});
        }
    }
    return String(a);
}

// Base directory for the per-glider log tree. Override with SCORING_LOG_DIR
// (absolute, or relative to the process cwd); defaults to <cwd>/logs.
const logBaseDir = process.env.SCORING_LOG_DIR || path.join(process.cwd(), 'logs');

export function createGliderLog(datecode: string | number, className: string, compno: string, scoreId: string): GliderLogHandle {
    const dir = path.join(logBaseDir, String(datecode), String(className));
    // pid in the filename so two ogn processes scoring the same comp don't
    // truncate-and-overwrite each other's file (which leaves NUL-byte holes).
    const filePath = path.join(dir, `${compno}.${process.pid}.log`);
    const consolePrefix = `${className}/${compno}:`;

    let fd = -1;
    try {
        fs.mkdirSync(dir, {recursive: true});
        // 'a' appends — concurrent rescore sequences share the file; each
        // line carries the scoreId so they can be untangled by grep.
        fd = fs.openSync(filePath, 'a');
    } catch (e) {
        console.log(`gliderLog: unable to open ${filePath}: ${e}`);
    }

    let buffer: string[] = [`${new Date().toISOString()} [${scoreId}] chain start ${className}/${compno}`];

    const append = (args: any[], isError: boolean) => {
        const stamp = new Date().toISOString();
        const body = args.map(formatArg).join(' ');
        buffer.push(isError ? `${stamp} [${scoreId}] ERROR ${body}` : `${stamp} [${scoreId}] ${body}`);
    };

    const flush = () => {
        if (fd < 0 || !buffer.length) return;
        const text = buffer.join('\n') + '\n';
        buffer = [];
        try {
            fs.writeSync(fd, text);
        } catch (e) {
            console.log(`gliderLog: write failed for ${filePath}: ${e}`);
        }
    };

    const log = ((...args: any[]) => {
        append(args, false);
    }) as GliderLogHandle;

    log.error = (...args: any[]) => {
        append(args, true);
        // Tee to the main process log so major issues stay visible.
        console.log(consolePrefix, ...args);
    };

    log.flush = flush;

    log.close = () => {
        flush();
        loggers.delete(log);
        if (fd >= 0) {
            try {
                fs.closeSync(fd);
            } catch {
                /* already closed */
            }
            fd = -1;
        }
    };

    loggers.add(log);
    ensureFlusher();

    return log;
}
