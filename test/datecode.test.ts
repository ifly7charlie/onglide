import {describe, test, expect} from 'vitest';
import {competitionStartTs} from '../lib/datecode';

describe('competitionStartTs', () => {
    test('UTC+0 at 11:00 returns today 10:00 UTC', () => {
        const ref = Date.UTC(2026, 3, 22, 11, 0, 0) / 1000;
        const start = competitionStartTs(0, ref);
        expect(start).toBe(Date.UTC(2026, 3, 22, 10, 0, 0) / 1000);
    });

    test('UTC+0 at 09:00 returns yesterday 10:00 UTC', () => {
        const ref = Date.UTC(2026, 3, 22, 9, 0, 0) / 1000;
        const start = competitionStartTs(0, ref);
        expect(start).toBe(Date.UTC(2026, 3, 21, 10, 0, 0) / 1000);
    });

    test('UTC+2 at 09:00 UTC (=11:00 local) returns today 08:00 UTC', () => {
        const ref = Date.UTC(2026, 3, 22, 9, 0, 0) / 1000;
        const start = competitionStartTs(7200, ref);
        expect(start).toBe(Date.UTC(2026, 3, 22, 8, 0, 0) / 1000);
    });

    test('UTC+2 at 07:00 UTC (=09:00 local) returns yesterday 08:00 UTC', () => {
        const ref = Date.UTC(2026, 3, 22, 7, 0, 0) / 1000;
        const start = competitionStartTs(7200, ref);
        expect(start).toBe(Date.UTC(2026, 3, 21, 8, 0, 0) / 1000);
    });

    test('UTC-5 at 16:00 UTC (=11:00 local) returns today 15:00 UTC', () => {
        const ref = Date.UTC(2026, 3, 22, 16, 0, 0) / 1000;
        const start = competitionStartTs(-18000, ref);
        expect(start).toBe(Date.UTC(2026, 3, 22, 15, 0, 0) / 1000);
    });

    test('UTC-5 at 14:00 UTC (=09:00 local) returns yesterday 15:00 UTC', () => {
        const ref = Date.UTC(2026, 3, 22, 14, 0, 0) / 1000;
        const start = competitionStartTs(-18000, ref);
        expect(start).toBe(Date.UTC(2026, 3, 21, 15, 0, 0) / 1000);
    });

    test('exactly at 10:00 local returns that moment', () => {
        const ref = Date.UTC(2026, 3, 22, 10, 0, 0) / 1000;
        const start = competitionStartTs(0, ref);
        expect(start).toBe(ref);
    });

    test('default reference is Date.now()', () => {
        const before = Math.floor(Date.now() / 1000);
        const start = competitionStartTs(0);
        const after = Math.floor(Date.now() / 1000);
        expect(start).toBeLessThanOrEqual(before);
        expect(after - start).toBeLessThan(86400 + 1);
    });
});
