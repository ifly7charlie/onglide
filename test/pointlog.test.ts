import {describe, test, expect, afterEach} from 'vitest';
import {promises as fsp, readdirSync} from 'fs';
import * as path from 'path';
import * as os from 'os';

import {openLog, appendPoint, closeLog, loadPoints} from '../lib/webworkers/pointlog';

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
});
