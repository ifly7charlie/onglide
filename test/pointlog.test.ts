import {describe, test, expect, afterEach, vi} from 'vitest';
import {promises as fsp, readdirSync, openSync, closeSync, readSync, statSync} from 'fs';
import * as path from 'path';
import * as os from 'os';

import {openLog, appendPoint, closeLog, loadPoints, __testGetActiveStream, serializeRecord, deserializeRecord, binarySearchForTs, parseFileHeader, FILE_HEADER_SIZE, RECORD_SIZE} from '../lib/webworkers/pointlog';

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
            // hex flarmIDs so the fid-prefilter works on real data shape.
            const flarm = i % 5 === 0 ? 'ABCDEF' : `BBBBB${i % 7}`;
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
            const msg = makeMsg(baseT + i, 'AABBCC');
            appendPoint(msg);
            expected.push(msg);
            if (i % 50 === 0) await new Promise((r) => setImmediate(r));
        }
        await new Promise((r) => setTimeout(r, 100));
        await closeLog();

        const files = readdirSync(dir).filter((f) => f.startsWith('aprs-') && f.endsWith('.v8'));
        expect(files.length).toBeGreaterThan(1);

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'AABBCC' as any, since: baseT})) got.push(m);
        expect(got.length).toBe(expected.length);
    });

    test('binary search: since near middle skips early bytes and finds correct subset', async () => {
        dir = await freshEnv('binsearch');
        await openLog();

        const baseT = 1700000000;
        for (let i = 0; i < 20000; i++) appendPoint(makeMsg(baseT + i, i % 2 === 0 ? 'AAAAAA' : 'BBBBBB'));
        await closeLog();

        const midT = baseT + 10000;
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'AAAAAA' as any, since: midT})) got.push(m);
        expect(got.length).toBe(5000);
        for (const m of got) expect(m.t).toBeGreaterThanOrEqual(midT);
    });

    test('until bound stops scanning', async () => {
        dir = await freshEnv('until');
        await openLog();

        const baseT = Math.floor(Date.now() / 1000); // realistic (live-style) message times
        for (let i = 0; i < 1000; i++) appendPoint(makeMsg(baseT + i, 'AABBCC'));
        await closeLog();

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'AABBCC' as any, since: baseT + 100, until: baseT + 200})) got.push(m);
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
            appendPoint(makeMsg(baseT + i + jitter, 'AABBCC'));
        }
        await closeLog();

        const since = baseT + 500;
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'AABBCC' as any, since})) got.push(m);
        for (const m of got) expect(m.t).toBeGreaterThanOrEqual(since);
        expect(got.length).toBeGreaterThan(0);
    });

    test('empty directory yields no points', async () => {
        dir = await freshEnv('empty');
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'AABBCC' as any, since: 0})) got.push(m);
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
        for (let i = 0; i < 10; i++) appendPoint(makeMsg(baseT + 100 + i, 'AABBCC'));

        await closeLog();

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'AABBCC' as any, since: baseT + 100})) got.push(m);
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
            appendPoint(makeMsg(1700000000, 'AABBCC'));
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
        try {
            await fsp.rm(dir, {recursive: true, force: true});
        } catch {}
    });

    test('record round-trip via serializeRecord / deserializeRecord', () => {
        const msg = makeMsg(1700000123, 'ABCDEF');
        msg.d = 5;
        const rec = serializeRecord(msg);
        expect(rec.length).toBe(RECORD_SIZE);
        // Header: 4 B writeTime, 2 B signed d
        expect(rec.readUInt32LE(0)).toBe(msg.t + msg.d);
        expect(rec.readInt16LE(4)).toBe(msg.d);
        const round = deserializeRecord(rec, 0) as any;
        expect(round.t).toBe(msg.t);
        expect(round.f).toBe(msg.f);
        expect(round.o).toBe(msg.o);
        // lat/lng quantize to 1e-7 grid; tolerate the round-trip delta.
        expect(round.lat).toBeCloseTo(msg.lat, 6);
        expect(round.lng).toBeCloseTo(msg.lng, 6);
        expect(round.a).toBe(msg.a);
        expect(round.g).toBe(msg.g);
        expect(round.b).toBe(msg.b);
        expect(round.s).toBe(msg.s);
        expect(round.d).toBe(msg.d);
        // c is reconstructed as f for diagnostic compatibility; l is always null.
        expect(round.c).toBe(msg.f);
        expect(round.l).toBeNull();
    });

    test('negative d survives the int16 header field', () => {
        const msg = makeMsg(1700000200, 'CAFE00');
        msg.d = -7; // clock skew: packet stamped in the future
        const rec = serializeRecord(msg);
        expect(rec.readUInt32LE(0)).toBe(msg.t + msg.d);
        expect(rec.readInt16LE(4)).toBe(-7);
        const round = deserializeRecord(rec, 0) as any;
        expect(round.d).toBe(-7);
        expect(round.t).toBe(msg.t);
    });

    test('long sender truncates to 10 ASCII bytes', () => {
        const msg = makeMsg(1700000300, 'AABBCC', 'LONGRECEIVER01'); // 14 chars
        const rec = serializeRecord(msg);
        const round = deserializeRecord(rec, 0) as any;
        expect(round.o).toBe('LONGRECEIV');
    });

    test('binary search lands on first record with writeTime >= target', async () => {
        dir = await fspMkTmp('binsearch');
        const file = path.join(dir, 'aprs-h-1-1700000000.v8');
        // Build 1000 records, monotonic in writeTime. d = 0 keeps t == writeTime.
        const N = 1000;
        const base = 1700000000;
        const records: Buffer[] = [];
        // File header (must match FILE_FORMAT_VERSION = 2 and RECORD_SIZE)
        const fileHeader = Buffer.alloc(FILE_HEADER_SIZE);
        Buffer.from('ONG8', 'ascii').copy(fileHeader, 0);
        fileHeader.writeUInt16LE(2, 4);
        fileHeader.writeUInt16LE(RECORD_SIZE, 6);
        records.push(fileHeader);
        for (let i = 0; i < N; i++) {
            records.push(serializeRecord(makeMsg(base + i, 'AABBCC')));
        }
        await fsp.writeFile(file, Buffer.concat(records));

        const fd = openSync(file, 'r');
        try {
            const size = statSync(file).size;
            const hdr = Buffer.alloc(FILE_HEADER_SIZE);
            readSync(fd, hdr, 0, FILE_HEADER_SIZE, 0);
            const {recSize} = parseFileHeader(hdr);
            const recordCount = (size - FILE_HEADER_SIZE) / recSize;
            expect(recordCount).toBe(N);

            // Search for several targets, compare to linear-scan ground truth.
            for (const target of [base - 100, base, base + 1, base + 500, base + N - 1, base + N, base + N + 100]) {
                const idx = binarySearchForTs(fd, recordCount, recSize, target);
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

    test('fid pre-filter: records with non-matching flarm IDs are not yielded', async () => {
        dir = await freshEnv('fidfilter');
        await openLog();
        const baseT = 1700000000;
        const wanted: any[] = [];
        for (let i = 0; i < 600; i++) {
            // 1 in 6 records is "AABBCC"; rest are five distinct hex IDs.
            const flarm = i % 6 === 0 ? 'AABBCC' : `BBBBB${i % 5}`;
            const msg = makeMsg(baseT + i, flarm);
            appendPoint(msg);
            if (flarm === 'AABBCC') wanted.push(msg);
        }
        await closeLog();

        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'AABBCC' as any, since: baseT})) got.push(m);
        expect(got.length).toBe(wanted.length);
        for (const m of got) expect(m.f).toBe('AABBCC');
    });
});

async function fspMkTmp(sub: string): Promise<string> {
    const d = path.join(os.tmpdir(), `onglide-pointlog-v8-${sub}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(d, {recursive: true});
    return d;
}
