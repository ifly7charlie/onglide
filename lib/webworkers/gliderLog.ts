/*
 * Per-glider scoring logger — types and the no-op fallback.
 *
 * This module is intentionally dependency-free (no node:fs) so the
 * scoring generators can import the GliderLog type and noopGliderLog
 * without pulling Node-only code into the browser bundle (the same
 * generators run client-side via lib/view/clientScoringPipeline.ts).
 *
 * The on-disk implementation lives in ./gliderLogFile (worker-only).
 */

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

// Fallback for generators invoked without a logger (unit tests, the
// client-side IGC scoring pipeline): normal logging is dropped, errors
// still surface on the console.
export const noopGliderLog: GliderLog = Object.assign(
    () => {
        /* noop */
    },
    {error: (...args: any[]) => console.log(...args)}
);
