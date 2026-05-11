import {describe, test, expect, afterEach, vi} from 'vitest';
import {promises as fsp, readdirSync, openSync, closeSync, readSync, statSync} from 'fs';
import * as path from 'path';
import * as os from 'os';

import {openLog, appendPoint, closeLog, loadPoints, __testGetActiveStream} from '../lib/webworkers/pointlog';
import {convertLogFileToV8, serializeRecord, deserializeRecord, binarySearchForTsV8, parseFileHeader, V8_FILE_HEADER_SIZE, V8_RECORD_SIZE} from '../lib/webworkers/pointlog-v8';

async function freshEnv(sub: string, rotateMb = 100, retainHours = 24): Promise<string> {
    const dir = path.join(os.tmpdir(), `onglide-pointlog-${sub}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(dir, {recursive: true});
    process.env.DB_PATH = dir;
    process.env.APRS_LOG_ROTATE_MB = String(rotateMb);
    process.env.APRS_LOG_RETAIN_HOURS = String(retainHours);
    return dir;
}

function makeMsg(t: number, flarmId: string, sender: string = 'TEST'): any {
    return {t, f: flarmId, o: sender, c: flarmId, lat: 50 + Math.random() * 0.1, lng: -1 + Math.random() * 0.1, a: 1000, g: 500, b: 90, s: 100, l: null, d: 0, ad: 0};
}

describe('pointlog', () => {
    let dir: string;

    afterEach(async () => {
        await closeLog();
        try {
            await fsp.rm(dir, {recursive: true, force: true});
        } catch {}
    });

    test('round-trip: write N messages then loadPoints recovers the flarmid subset', async () => {
        dir = await freshEnv('roundtrip');
        await openLog();

        const baseT = 1700000000;
        const targets: any[] = [];
        for (let i = 0; i < 500; i++) {
            const flarm = i % 5 === 0 ? 'ABCDEF' : `OTHER${i % 7}`;
            const msg = makeMsg(baseT + i, flarm);
            appendPoint(msg);
            if (flarm === 'ABCDEF') targets.push(msg);
        }
        await closeLog();

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'ABCDEF' as any, since: baseT})) got.push(m);
        expect(got.length).toBe(targets.length);
        expect(got.map((m) => m.t)).toEqual(targets.map((m) => m.t));
    });

    test('rotation: small threshold produces multiple files; round-trip still works', async () => {
        dir = await freshEnv('rotate', 0.01); // 10 KB rotation
        await openLog();

        const baseT = 1700000000;
        const expected: any[] = [];
        for (let i = 0; i < 500; i++) {
            const msg = makeMsg(baseT + i, 'TARGET');
            appendPoint(msg);
            expected.push(msg);
            if (i % 50 === 0) await new Promise((r) => setImmediate(r));
        }
        await new Promise((r) => setTimeout(r, 100));
        await closeLog();

        const files = readdirSync(dir).filter((f) => f.startsWith('aprs-') && f.endsWith('.log'));
        expect(files.length).toBeGreaterThan(1);

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'TARGET' as any, since: baseT})) got.push(m);
        expect(got.length).toBe(expected.length);
    });

    test('binary search: since near middle skips early bytes and finds correct subset', async () => {
        dir = await freshEnv('binsearch');
        await openLog();

        const baseT = 1700000000;
        for (let i = 0; i < 20000; i++) appendPoint(makeMsg(baseT + i, i % 2 === 0 ? 'A' : 'B'));
        await closeLog();

        const midT = baseT + 10000;
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'A' as any, since: midT})) got.push(m);
        expect(got.length).toBe(5000);
        for (const m of got) expect(m.t).toBeGreaterThanOrEqual(midT);
    });

    test('until bound stops scanning', async () => {
        dir = await freshEnv('until');
        await openLog();

        const baseT = Math.floor(Date.now() / 1000); // realistic (live-style) message times
        for (let i = 0; i < 1000; i++) appendPoint(makeMsg(baseT + i, 'X'));
        await closeLog();

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'X' as any, since: baseT + 100, until: baseT + 200})) got.push(m);
        expect(got.length).toBe(101);
        expect(got[0].t).toBe(baseT + 100);
        expect(got.at(-1).t).toBe(baseT + 200);
    });

    test('out-of-order tolerance: late-arriving backward-jitter messages still match', async () => {
        dir = await freshEnv('ooo');
        await openLog();

        const baseT = 1700000000;
        for (let i = 0; i < 1000; i++) {
            const jitter = i % 50 === 0 ? -5 : 0;
            appendPoint(makeMsg(baseT + i + jitter, 'Y'));
        }
        await closeLog();

        const since = baseT + 500;
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'Y' as any, since})) got.push(m);
        for (const m of got) expect(m.t).toBeGreaterThanOrEqual(since);
        expect(got.length).toBeGreaterThan(0);
    });

    test('empty directory yields no points', async () => {
        dir = await freshEnv('empty');
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'NOPE' as any, since: 0})) got.push(m);
        expect(got.length).toBe(0);
    });

    test('auto-reopen: stream error clears activeStream and reopens after backoff', async () => {
        dir = await freshEnv('reopen');
        await openLog();

        const baseT = 1700000000;
        const stream = __testGetActiveStream();
        expect(stream).toBeDefined();

        vi.useFakeTimers();
        try {
            stream!.emit('error', Object.assign(new Error('synthetic EIO'), {code: 'EIO'}));
            // Error handler runs synchronously — activeStream cleared, reopen
            // scheduled at delay 1000ms (Math.min(60_000, 1000 * 2^0)).
            expect(__testGetActiveStream()).toBeUndefined();

            await vi.advanceTimersByTimeAsync(1100);
        } finally {
            vi.useRealTimers();
        }

        const reopened = __testGetActiveStream();
        expect(reopened).toBeDefined();
        expect(reopened).not.toBe(stream);

        // Post-reopen writes go into the same activePath (append mode); a
        // single `loadPoints` query covers them.
        for (let i = 0; i < 10; i++) appendPoint(makeMsg(baseT + 100 + i, 'TARGET'));

        await closeLog();

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'TARGET' as any, since: baseT + 100})) got.push(m);
        expect(got.length).toBe(10);
    });

    test('auto-reopen: closeLog cancels a pending reopen', async () => {
        dir = await freshEnv('cancelreopen');
        await openLog();

        const stream = __testGetActiveStream();
        expect(stream).toBeDefined();

        vi.useFakeTimers();
        try {
            stream!.emit('error', Object.assign(new Error('synthetic EIO'), {code: 'EIO'}));
            expect(__testGetActiveStream()).toBeUndefined();

            // closeLog should clear the pending reopen timer.
            vi.useRealTimers();
            await closeLog();

            vi.useFakeTimers();
            await vi.advanceTimersByTimeAsync(2000);
        } finally {
            vi.useRealTimers();
        }

        // Without cancellation we'd see a fresh stream here; with it, none.
        expect(__testGetActiveStream()).toBeUndefined();
    });

    test('auto-reopen: appendPoint with no active stream schedules a reopen', async () => {
        dir = await freshEnv('reopenfromappend');
        await openLog();

        const stream = __testGetActiveStream();

        vi.useFakeTimers();
        try {
            // Fake timers must be active BEFORE the error so the reopen timer
            // is registered with vitest's scheduler.
            stream!.emit('error', Object.assign(new Error('synthetic EIO'), {code: 'EIO'}));
            expect(__testGetActiveStream()).toBeUndefined();

            // appendPoint into the no-stream branch should be idempotent —
            // existing scheduled reopen still fires.
            appendPoint(makeMsg(1700000000, 'X'));
            await vi.advanceTimersByTimeAsync(1100);
        } finally {
            vi.useRealTimers();
        }

        expect(__testGetActiveStream()).toBeDefined();
    });
});

describe('pointlog-v8', () => {
    let dir: string;

    afterEach(async () => {
        await closeLog();
        delete process.env.POINTLOG_FORMAT;
        try {
            await fsp.rm(dir, {recursive: true, force: true});
        } catch {}
    });

    test('record round-trip via serializeRecord / deserializeRecord', () => {
        const msg = makeMsg(1700000123, 'ABCDEF');
        msg.d = 5;
        const {rec, payloadBytes} = serializeRecord(msg);
        expect(rec.length).toBe(V8_RECORD_SIZE);
        expect(payloadBytes).toBeGreaterThan(0);
        expect(payloadBytes).toBeLessThanOrEqual(V8_RECORD_SIZE - 6);
        // Header: 4 B writeTime, 2 B signed d
        expect(rec.readUInt32LE(0)).toBe(msg.t + msg.d);
        expect(rec.readInt16LE(4)).toBe(msg.d);
        const round = deserializeRecord(rec, 0) as any;
        expect(round.t).toBe(msg.t);
        expect(round.f).toBe(msg.f);
        expect(round.o).toBe(msg.o);
        expect(round.lat).toBe(msg.lat);
        expect(round.lng).toBe(msg.lng);
        expect(round.a).toBe(msg.a);
        expect(round.g).toBe(msg.g);
        expect(round.d).toBe(msg.d);
    });

    test('negative d survives the int16 header field', () => {
        const msg = makeMsg(1700000200, 'XYZ');
        msg.d = -7; // clock skew: packet stamped in the future
        const {rec} = serializeRecord(msg);
        expect(rec.readUInt32LE(0)).toBe(msg.t + msg.d);
        expect(rec.readInt16LE(4)).toBe(-7);
        const round = deserializeRecord(rec, 0) as any;
        expect(round.d).toBe(-7);
        expect(round.t).toBe(msg.t);
    });

    test('binary search lands on first record with t+d >= target', async () => {
        dir = await fspMkTmp('binsearchv8');
        const file = path.join(dir, 'aprs-h-1-1700000000.v8');
        // Build 1000 records, monotonic in t+d. d = 0 to keep things obvious.
        const N = 1000;
        const base = 1700000000;
        const records: Buffer[] = [];
        // file header
        records.push(Buffer.alloc(V8_FILE_HEADER_SIZE));
        Buffer.from('ONG8', 'ascii').copy(records[0]!, 0);
        records[0]!.writeUInt16LE(1, 4);
        records[0]!.writeUInt16LE(V8_RECORD_SIZE, 6);
        for (let i = 0; i < N; i++) {
            records.push(serializeRecord(makeMsg(base + i, 'X')).rec);
        }
        await fsp.writeFile(file, Buffer.concat(records));

        const fd = openSync(file, 'r');
        try {
            const size = statSync(file).size;
            const hdr = Buffer.alloc(V8_FILE_HEADER_SIZE);
            readSync(fd, hdr, 0, V8_FILE_HEADER_SIZE, 0);
            const {recSize} = parseFileHeader(hdr);
            const recordCount = (size - V8_FILE_HEADER_SIZE) / recSize;
            expect(recordCount).toBe(N);

            // Search for several targets, compare to linear-scan ground truth.
            for (const target of [base - 100, base, base + 1, base + 500, base + N - 1, base + N, base + N + 100]) {
                const idx = binarySearchForTsV8(fd, recordCount, recSize, target);
                const linear = (() => {
                    for (let i = 0; i < N; i++) {
                        if (base + i >= target) return i;
                    }
                    return N;
                })();
                expect(idx).toBe(linear);
            }
        } finally {
            closeSync(fd);
        }
    });

    test('cross-format: convert .log → .v8 then loadPoints with POINTLOG_FORMAT=v8 matches .log read', async () => {
        dir = await freshEnv('crossformat');
        await openLog();

        const baseT = 1700000000;
        const expected: any[] = [];
        for (let i = 0; i < 1500; i++) {
            const flarm = i % 3 === 0 ? 'ABCDEF' : `OTH${i % 11}`;
            const msg = makeMsg(baseT + i, flarm);
            appendPoint(msg);
            if (flarm === 'ABCDEF') expected.push(msg);
        }
        await closeLog();

        // Read via .log first as the ground truth.
        delete process.env.POINTLOG_FORMAT;
        const fromLog: any[] = [];
        for await (const m of loadPoints({flarmId: 'ABCDEF' as any, since: baseT})) fromLog.push(m);
        expect(fromLog.length).toBe(expected.length);

        // Convert every .log file in dir to .v8.
        const logs = readdirSync(dir).filter((f) => f.endsWith('.log'));
        expect(logs.length).toBeGreaterThan(0);
        for (const log of logs) {
            const src = path.join(dir, log);
            const dst = path.join(dir, log.slice(0, -'.log'.length) + '.v8');
            const stats = await convertLogFileToV8(src, dst);
            expect(stats.recordsWritten).toBeGreaterThan(0);
        }

        // Swap to .v8 mode and re-read; same records, same order.
        process.env.POINTLOG_FORMAT = 'v8';
        const fromV8: any[] = [];
        for await (const m of loadPoints({flarmId: 'ABCDEF' as any, since: baseT})) fromV8.push(m);
        expect(fromV8.length).toBe(fromLog.length);
        expect(fromV8.map((m) => m.t)).toEqual(fromLog.map((m) => m.t));
        // Spot-check a couple of fields survived the V8 roundtrip.
        for (let i = 0; i < fromV8.length; i++) {
            expect(fromV8[i].f).toBe(fromLog[i].f);
            expect(fromV8[i].lat).toBe(fromLog[i].lat);
            expect(fromV8[i].lng).toBe(fromLog[i].lng);
        }
    });

    test('v8 reader: since/until window narrows the result the same way', async () => {
        dir = await freshEnv('v8window');
        await openLog();
        const baseT = 1700000000;
        for (let i = 0; i < 1000; i++) appendPoint(makeMsg(baseT + i, 'W'));
        await closeLog();
        const logs = readdirSync(dir).filter((f) => f.endsWith('.log'));
        for (const log of logs) {
            await convertLogFileToV8(path.join(dir, log), path.join(dir, log.slice(0, -'.log'.length) + '.v8'));
        }
        process.env.POINTLOG_FORMAT = 'v8';
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'W' as any, since: baseT + 200, until: baseT + 300})) got.push(m);
        expect(got.length).toBe(101);
        expect(got[0].t).toBe(baseT + 200);
        expect(got.at(-1).t).toBe(baseT + 300);
    });
});

async function fspMkTmp(sub: string): Promise<string> {
    const d = path.join(os.tmpdir(), `onglide-pointlog-v8-${sub}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(d, {recursive: true});
    return d;
}
