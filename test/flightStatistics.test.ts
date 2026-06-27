import {describe, test, expect} from 'vitest';
import {createFlightStatistics} from '../lib/webworkers/flightStatistics';

// Segment coalescing must never leave two like-state segments adjacent. The
// subtle case (regression): a weak thermal absorbed into a preceding straight
// flips that straight to 'thermal', leaving it touching an earlier thermal —
// the cascade in pushOpen must collapse them.
describe('flightStatistics coalescing', () => {
    const noAdjacentSameState = (segs: {state: string; start: number; end: number}[]) => {
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i].state === segs[i - 1].state && segs[i].state !== 'gap', `adjacent ${segs[i].state} at index ${i} (${segs[i - 1].start}-${segs[i - 1].end} then ${segs[i].start}-${segs[i].end})`).toBe(false);
        }
    };

    test('a continuous circle is one thermal segment', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        let alt = 1000;
        for (let i = 0; i < 200; i++) {
            const bearing = (i * 96) % 360;
            t += 4;
            alt += 2;
            const ang = (bearing * Math.PI) / 180;
            fs.addPosition({t, a: alt, lat: 51 + 0.002 * Math.cos(ang), lng: -1 + 0.002 * Math.sin(ang), b: bearing, s: 90});
        }
        const segs = fs.getStats()?.segments ?? [];
        expect(segs.filter((s) => s.state === 'thermal')).toHaveLength(1);
    });

    test('the open segment coalesces with a like-state predecessor (no split tail)', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        let alt = 1000;
        const circle = (turns: number) => {
            for (let i = 0; i < turns * 6; i++) {
                const bearing = (i * 60) % 360;
                t += 4;
                alt += 8;
                const ang = (bearing * Math.PI) / 180;
                fs.addPosition({t, a: alt, lat: 51 + 0.002 * Math.cos(ang), lng: -1 + 0.002 * Math.sin(ang), b: bearing, s: 90});
            }
        };
        circle(4); // first thermal
        // a short straight blip (< MIN_STRAIGHT_TIME_S) — absorbed into the thermal
        for (let i = 0; i < 3; i++) {
            t += 4;
            alt += 4;
            fs.addPosition({t, a: alt, lat: 51 + 0.0001 * i, lng: -1, b: 0, s: 95});
        }
        circle(4); // still climbing — this is the currently-open segment
        // The open thermal must not sit adjacent to a just-closed thermal.
        expect((fs.getStats()?.segments ?? []).filter((s) => s.state === 'thermal')).toHaveLength(1);
    });

    test('noisy sparse circling never produces adjacent same-state segments', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        let alt = 1000;
        let bearing = 0;
        let seed = 42;
        const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let i = 0; i < 120; i++) {
            const dt = 4 + Math.floor(rand() * 28);
            const turnRate = 14 + rand() * 16;
            bearing = (bearing + turnRate * dt) % 360;
            t += dt;
            alt += 1.5 * dt;
            const ang = (bearing * Math.PI) / 180;
            fs.addPosition({t, a: alt, lat: 51 + 0.002 * Math.cos(ang), lng: -1 + 0.002 * Math.sin(ang), b: bearing, s: 85 + rand() * 20});
        }
        noAdjacentSameState(fs.getStats()?.segments ?? []);
    });
});
