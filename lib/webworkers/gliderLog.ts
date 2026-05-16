/*
 * Per-glider scoring log files.
 *
 * Each glider that gets a scoring chain writes to
 *   logs/<datecode>/<class>/<compno>.log
 * The file is truncated every time the chain is (re)instantiated, so it
 * always holds the log from the current chain instance up to now.
 *
 * Writes are batched: log calls append to an in-memory buffer and a
 * single shared timer flushes every live logger every few seconds. This
 * keeps the scoring hot path free of per-message disk IO.
 *
 * The logger is a callable (file only) with an .error() method that
 * additionally tees to the process console so major issues stay visible
 * in the main process log.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {inspect} from 'node:util';

import {stripPoints} from '../flightprocessing/taskhelper';

// What the generators receive: callable for normal logging plus .error
// for exceptions (file + console).
export interface GliderLog {
    (...args: any[]): void;
    error(...args: any[]): void;
}

// What getScoringChain holds onto so it can flush/close on rescore.
export interface GliderLogHandle extends GliderLog {
    flush(): void;
    close(): void;
}

// Fallback for generators invoked without a logger (e.g. unit tests):
// normal logging is dropped, errors still surface on the console.
export const noopGliderLog: GliderLog = Object.assign(
    () => {
        /* noop */
    },
    {error: (...args: any[]) => console.log(...args)}
);

const FLUSH_INTERVAL_MS = 3000;

// Every live logger — flushed together by the shared timer / exit hook.
const loggers = new Set<GliderLogHandle & {flush(): void}>();
let flushTimer: NodeJS.Timeout | null = null;
let exitHooked = false;

function ensureFlusher() {
    if (!flushTimer) {
        flushTimer = setInterval(() => {
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

export function createGliderLog(datecode: string | number, className: string, compno: string): GliderLogHandle {
    const dir = path.join(process.cwd(), 'logs', String(datecode), String(className));
    const filePath = path.join(dir, `${compno}.log`);
    const consolePrefix = `${className}/${compno}:`;

    let fd = -1;
    try {
        fs.mkdirSync(dir, {recursive: true});
        // 'w' truncates — a fresh chain instance gets a fresh file.
        fd = fs.openSync(filePath, 'w');
    } catch (e) {
        console.log(`gliderLog: unable to open ${filePath}: ${e}`);
    }

    let buffer: string[] = [];

    const append = (args: any[], isError: boolean) => {
        const stamp = new Date().toISOString();
        const body = args.map(formatArg).join(' ');
        buffer.push(isError ? `${stamp} ERROR ${body}` : `${stamp} ${body}`);
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
