import {describe, test, expect} from 'vitest';
import {createFlightStatistics, StatsFix} from '../lib/webworkers/flightStatistics';

// Segment coalescing must never leave two like-state segments adjacent, and
// absorbing a minor segment must never relabel or collapse its substantial
// neighbour. A weak thermal blip merged into a glide must leave the glide a
// glide (not flip it to 'thermal'), and a long glide must survive intact even
// when a proper thermal forms right beside it.
describe('flightStatistics coalescing', () => {
    const dur = (s: {start?: number; end?: number}) => (s.end ?? 0) - (s.start ?? 0);

    const noAdjacentSameState = (segs: {state: string; start: number; end: number}[]) => {
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i].state === segs[i - 1].state && segs[i].state !== 'gap', `adjacent ${segs[i].state} at index ${i} (${segs[i - 1].start}-${segs[i - 1].end} then ${segs[i].start}-${segs[i].end})`).toBe(false);
        }
    };

    // Integrate a synthetic track from a list of phases. Each phase is a run of
    // fixes flown at a constant ground speed and climb rate with a fixed per-fix
    // bearing change (0 = straight glide, large = circling). Positions advance
    // along the current heading so the haversine distance/bearing the state
    // machine recomputes stay self-consistent with the supplied bearing/speed.
    interface Phase {
        steps: number;
        turnPerStep: number; // degrees of heading change per fix
        speed: number; // kph
        climb: number; // m/s
    }
    const buildTrack = (phases: Phase[], dt = 4): StatsFix[] => {
        const KM_PER_DEG = 111.32;
        const fixes: StatsFix[] = [];
        let t = 1000;
        let a = 1500; // m AMSL
        let lat = 47.0;
        let lng = 19.0;
        let bearing = 90; // heading east
        fixes.push({t, a, lng, lat, b: bearing, s: phases[0].speed});
        for (const ph of phases) {
            for (let i = 0; i < ph.steps; i++) {
                t += dt;
                bearing = (bearing + ph.turnPerStep + 360) % 360;
                const distKm = (ph.speed / 3600) * dt;
                const rad = (bearing * Math.PI) / 180;
                lat += (distKm * Math.cos(rad)) / KM_PER_DEG;
                lng += (distKm * Math.sin(rad)) / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
                a += ph.climb * dt;
                fixes.push({t, a, lng, lat, b: bearing, s: ph.speed});
            }
        }
        return fixes;
    };
    const runTrack = (phases: Phase[]) => {
        const fs = createFlightStatistics();
        for (const fix of buildTrack(phases)) fs.addPosition(fix);
        return fs.getStats()?.segments ?? [];
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

    // Regression for the leg-long phantom thermal: a glide carries occasional
    // brief steep turns (course corrections / a single stray circle). Each is a
    // weak sub-threshold thermal blip that merges back into the glide. The merge
    // must NOT relabel the glide 'thermal' — otherwise the glide cascades into
    // the preceding real thermal and one "thermal" swallows whole legs.
    test('brief turns in a glide do not turn the glide into a thermal', () => {
        const segs = runTrack([
            {steps: 45, turnPerStep: 40, speed: 80, climb: 2}, // thermal A (strong: 1800° of turn)
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1.5}, // glide
            {steps: 4, turnPerStep: 40, speed: 100, climb: 0}, // brief turn (weak: ~160°)
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1.5}, // glide continues
            {steps: 4, turnPerStep: 40, speed: 100, climb: 0}, // another brief turn
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1.5}, // glide continues
            {steps: 45, turnPerStep: 40, speed: 80, climb: 2} // thermal B (strong)
        ]);
        noAdjacentSameState(segs);
        const thermals = segs.filter((s) => s.state === 'thermal');
        const straights = segs.filter((s) => s.state === 'straight');
        // Only the two real thermals survive — the blips were absorbed.
        expect(thermals).toHaveLength(2);
        // The track is majority glide, so straight time dominates, and no thermal
        // spans more than its own ~180s of circling (a swallowed glide pushes one
        // past 300s).
        expect(straights.reduce((a, s) => a + dur(s), 0)).toBeGreaterThan(thermals.reduce((a, s) => a + dur(s), 0));
        expect(Math.max(...thermals.map(dur))).toBeLessThan(300);
    });

    // The user's follow-up case: a glide whose entry to the next thermal starts
    // with a weak turn (absorbed into the glide) must keep the glide as its own
    // segment once the turn commits to a proper thermal — the strong thermal must
    // not collapse the long straight that preceded it.
    test('a proper thermal forming after a glide does not collapse the glide', () => {
        const segs = runTrack([
            {steps: 45, turnPerStep: 40, speed: 80, climb: 2}, // thermal A (strong)
            {steps: 40, turnPerStep: 0, speed: 120, climb: -1.5}, // glide (long: 160s)
            {steps: 4, turnPerStep: 40, speed: 100, climb: 0}, // weak entry blip — absorbed
            {steps: 40, turnPerStep: 0, speed: 120, climb: -1.5}, // glide continues
            {steps: 45, turnPerStep: 40, speed: 80, climb: 2} // thermal B (commits — strong)
        ]);
        noAdjacentSameState(segs);
        const thermals = segs.filter((s) => s.state === 'thermal');
        const straights = segs.filter((s) => s.state === 'straight');
        expect(thermals).toHaveLength(2);
        // The whole glide survives as straight flight (≈ 336s), not swallowed.
        expect(straights.reduce((a, s) => a + dur(s), 0)).toBeGreaterThan(300);
        expect(Math.max(...thermals.map(dur))).toBeLessThan(250);
    });

    // Sparse circling aliases the per-fix bearing: when a thermalling glider is
    // sampled so coarsely that it sweeps > 180° of the circle between fixes, the
    // wrapped bearing delta flips sign (a 250° turn reads as -110°) and the naive
    // per-second turn rate falls below the thermal threshold — so the climb gets
    // mislabelled a long "straight". Net displacement stays small (the glider
    // keeps returning near its start), which is what lets the classifier recover
    // the real rotation. Enter the thermal on a few dense fixes, then sustain it
    // on sparse ones — exactly the OGN burst-then-quiet cadence that triggered it.
    test('sparse circling that aliases the bearing stays one thermal', () => {
        const KM_PER_DEG = 111.32;
        const R = 0.0015; // ~167 m circle radius (degrees)
        const lat0 = 47;
        const lng0 = 19;
        const speed = 100; // kph airspeed
        const period = ((2 * Math.PI * R * KM_PER_DEG) / speed) * 3600; // seconds per full circle
        const fs = createFlightStatistics();
        let t = 1000;
        let a = 1200;
        let ang = 0; // position angle around the circle (deg)
        const emit = () => {
            const rad = (ang * Math.PI) / 180;
            const lat = lat0 + R * Math.cos(rad);
            const lng = lng0 + (R * Math.sin(rad)) / Math.cos((lat0 * Math.PI) / 180);
            // Instantaneous (tangent) bearing for a point at angle ang is (90+ang).
            fs.addPosition({t, a, lat, lng, b: (90 + ang) % 360, s: speed});
        };
        emit();
        const step = (deg: number) => {
            ang = (ang + deg) % 360;
            t += Math.round((deg / 360) * period);
            a += 12; // climbing
            emit();
        };
        for (let i = 0; i < 6; i++) step(30); // dense entry (~3 s fixes, ~10°/s — enters thermal)
        for (let i = 0; i < 10; i++) step(250); // sparse sustain (~26 s fixes — aliases to the wrong sign)
        const segs = fs.getStats()?.segments ?? [];
        noAdjacentSameState(segs);
        const thermals = segs.filter((s) => s.state === 'thermal');
        // The whole climb is one thermal, not a phantom straight cut out of it.
        expect(thermals).toHaveLength(1);
        expect(segs.filter((s) => s.state === 'straight')).toHaveLength(0);
        // The credited rotation is realistic (the track actually flew 6×30 + 10×250
        // = 2680°), not the aliased near-zero that the raw wrapped deltas sum to.
        expect(thermals[0].turncount).toBeGreaterThan(720);
    });
});
