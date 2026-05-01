import {describe, test, expect, afterEach} from 'vitest';
import {promises as fsp} from 'fs';
import * as path from 'path';
import * as os from 'os';

import {openLog, appendPoint, closeLog, loadPoints, loadPointsForIds, scanAll} from '../lib/webworkers/pointlog';

async function freshEnv(sub: string, retainHours = 24): Promise<string> {
    const dir = path.join(os.tmpdir(), `onglide-pointlog-${sub}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(dir, {recursive: true});
    process.env.DB_PATH = dir;
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

        await openLog();
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'ABCDEF' as any, since: baseT})) got.push(m);
        expect(got.length).toBe(targets.length);
        expect(got.map((m) => m.t)).toEqual(targets.map((m) => m.t));
    });

    test('index seek: since near middle picks the right subset', async () => {
        dir = await freshEnv('binsearch');
        await openLog();

        const baseT = 1700000000;
        for (let i = 0; i < 20000; i++) appendPoint(makeMsg(baseT + i, i % 2 === 0 ? 'A' : 'B'));
        await closeLog();
        await openLog();

        const midT = baseT + 10000;
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'A' as any, since: midT})) got.push(m);
        expect(got.length).toBe(5000);
        for (const m of got) expect(m.t).toBeGreaterThanOrEqual(midT);
    });

    test('until bound stops scanning', async () => {
        dir = await freshEnv('until');
        await openLog();

        const baseT = Math.floor(Date.now() / 1000);
        for (let i = 0; i < 1000; i++) appendPoint(makeMsg(baseT + i, 'X'));
        await closeLog();
        await openLog();

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
            appendPoint(makeMsg(baseT + i + jitter, 'Y', `TX${i}`));
        }
        await closeLog();
        await openLog();

        const since = baseT + 500;
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'Y' as any, since})) got.push(m);
        for (const m of got) expect(m.t).toBeGreaterThanOrEqual(since);
        expect(got.length).toBeGreaterThan(0);
    });

    test('empty database yields no points', async () => {
        dir = await freshEnv('empty');
        await openLog();
        const got: any[] = [];
        for await (const m of loadPoints({flarmId: 'NOPE' as any, since: 0})) got.push(m);
        expect(got.length).toBe(0);
    });

    test('loadPointsForIds: time-range scan with optional flarmId IN filter', async () => {
        dir = await freshEnv('forids');
        await openLog();

        const baseT = 1700000000;
        for (let i = 0; i < 600; i++) {
            const flarm = ['A', 'B', 'C'][i % 3];
            appendPoint(makeMsg(baseT + i, flarm));
        }
        await closeLog();
        await openLog();

        const ab: any[] = [];
        for await (const m of loadPointsForIds({flarmIds: new Set(['A', 'B']), since: baseT})) ab.push(m);
        expect(ab.length).toBe(400);
        for (const m of ab) expect(['A', 'B']).toContain(m.f);

        const all: any[] = [];
        for await (const m of scanAll({since: baseT})) all.push(m);
        expect(all.length).toBe(600);
    });
});
