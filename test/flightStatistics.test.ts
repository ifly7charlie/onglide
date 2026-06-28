import {describe, test, expect} from 'vitest';
import {createFlightStatistics, StatsFix, FlightStatistics} from '../lib/webworkers/flightStatistics';

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

    // A mixed thermal: the pilot circles one way, reverses, and circles back the
    // other — two attempts in one core (or an S-shaped climb). The *signed*
    // turncount cancels toward zero across the reversal, so gating the weak-thermal
    // merge on it let the whole climb (here ~2400° of actual turning, gaining
    // height) get swallowed by the surrounding glide. It must survive as one
    // thermal, flagged mixed (proto direction 0), with its gross rotation credited.
    test('a reversing (mixed) thermal is kept, not absorbed into the glide', () => {
        const segs = runTrack([
            {steps: 40, turnPerStep: 0, speed: 120, climb: -1.5}, // glide in
            {steps: 30, turnPerStep: 40, speed: 80, climb: 2}, // right attempt (+1200°, climbing)
            {steps: 3, turnPerStep: 0, speed: 90, climb: 0}, // brief recentre straight (absorbed)
            {steps: 30, turnPerStep: -40, speed: 80, climb: 2}, // left attempt (-1200°, climbing)
            {steps: 40, turnPerStep: 0, speed: 120, climb: -1.5} // glide out
        ]);
        noAdjacentSameState(segs);
        const thermals = segs.filter((s) => s.state === 'thermal');
        const straights = segs.filter((s) => s.state === 'straight');
        // The reversal nets ~0° but flew ~2400° gross — kept as one thermal, not
        // merged into the glide on either side.
        expect(thermals).toHaveLength(1);
        expect(thermals[0].turncount).toBeGreaterThan(720); // gross rotation, not the cancelled net
        expect(thermals[0].direction).toBe(0); // flagged mixed, not a slim dominant side
        // The glides on both sides survive intact.
        expect(straights.length).toBeGreaterThanOrEqual(2);
    });

    // The flip side of the mixed-thermal case: when the two opposite circles are
    // separated by a *substantial* straight (the pilot left the first core, glided,
    // and worked a second one), that straight is real gliding flight and must not
    // be absorbed — the result is two distinct, single-direction thermals, not one
    // merged "mixed" blob.
    test('two opposite thermals split by a long straight stay two thermals', () => {
        const segs = runTrack([
            {steps: 40, turnPerStep: 0, speed: 120, climb: -1.5}, // glide in
            {steps: 30, turnPerStep: 40, speed: 80, climb: 2}, // right thermal
            {steps: 10, turnPerStep: 0, speed: 110, climb: -0.5}, // long straight between (40 s)
            {steps: 30, turnPerStep: -40, speed: 80, climb: 2}, // left thermal
            {steps: 40, turnPerStep: 0, speed: 120, climb: -1.5} // glide out
        ]);
        noAdjacentSameState(segs);
        const thermals = segs.filter((s) => s.state === 'thermal');
        expect(thermals).toHaveLength(2);
        // each is a clean single-direction circle, not flagged mixed
        expect(thermals[0].direction).not.toBe(0);
        expect(thermals[1].direction).not.toBe(0);
        // and the 40 s glide between them survives as straight flight
        expect(segs.some((s) => s.state === 'straight' && s.start > thermals[0].end - 1 && s.end < thermals[1].start + 1)).toBe(true);
    });
});

// Documented contracts that aren't about coalescing: gap insertion, wind
// estimation, the ascending-time-order requirement, and reset(). These are core
// behaviours the panel depends on but had no coverage.
describe('flightStatistics gaps, wind, and stream hygiene', () => {
    // A break longer than MAX_GAP_S is a tracking outage, not flown distance — it
    // becomes its own 'gap' segment so the snail trail and stats don't draw a
    // straight line through missing data.
    test('a break longer than the gap threshold becomes a gap segment', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        for (let i = 0; i < 10; i++) {
            fs.addPosition({t, a: 1000, lat: 47 + i * 0.001, lng: 19, b: 0, s: 100});
            t += 4;
        }
        t += 200; // > MAX_GAP_S (60)
        for (let i = 0; i < 10; i++) {
            fs.addPosition({t, a: 1000, lat: 47.1 + i * 0.001, lng: 19, b: 0, s: 100});
            t += 4;
        }
        const segs = fs.getStats()?.segments ?? [];
        const gi = segs.findIndex((s) => s.state === 'gap');
        expect(gi).toBeGreaterThan(0); // flown segment before it
        expect(segs[gi].end - segs[gi].start).toBeGreaterThan(60);
        expect(segs[gi - 1].state).not.toBe('gap');
        expect(segs[gi + 1]?.state).toBe('straight'); // flown segment after it
    });

    // A single fix marooned between two outages is a real observation. Both gaps
    // are kept (abutting at that fix) rather than merged into one span that erases
    // where the glider actually was — the only case that produces adjacent gaps,
    // and it is intentional (noAdjacentSameState exempts gaps).
    test('an isolated fix between two outages keeps both gaps', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        fs.addPosition({t, a: 1000, lat: 47.0, lng: 19, b: 0, s: 100});
        t += 200;
        fs.addPosition({t, a: 1000, lat: 47.1, lng: 19, b: 0, s: 100}); // lone fix
        t += 200;
        fs.addPosition({t, a: 1000, lat: 47.2, lng: 19, b: 0, s: 100});
        const gaps = (fs.getStats()?.segments ?? []).filter((s) => s.state === 'gap');
        expect(gaps).toHaveLength(2);
        expect(gaps[0].end).toBe(gaps[1].start); // they meet at the observed fix
    });

    // Wind comes from circling drift: across each rotation the slowest ground
    // speed is heading most into wind, the fastest most downwind. Fly a real
    // 100 kph circle in a 20 kph wind from 270° (integrating ground velocity so
    // the track is a genuine downwind-drifting spiral) and recover both — with
    // OGN-style instantaneous bearing+speed and position-only (the IGC path,
    // where bearing is derived from successive positions). dropFraction randomly
    // discards fixes (seeded, deterministic) to model lossy tracking: the wind
    // must still come out of the sparser, irregular-cadence surviving points.
    const flyWindSpiral = (withBearingSpeed: boolean, dropFraction = 0, seed = 1) => {
        const fs = createFlightStatistics();
        let rng = seed;
        const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        const V = 100;
        const windSpeed = 20;
        const windFrom = 270;
        const wTo = ((windFrom + 180) % 360) * (Math.PI / 180); // direction wind blows toward
        const we = windSpeed * Math.sin(wTo);
        const wn = windSpeed * Math.cos(wTo);
        const KM_PER_DEG = 111.32;
        let t = 1000;
        let a = 1000;
        let lat = 47;
        let lng = 19;
        let h = 0;
        const dt = 3;
        for (let i = 0; i < 120; i++) {
            const ae = V * Math.sin((h * Math.PI) / 180);
            const an = V * Math.cos((h * Math.PI) / 180);
            const ge = ae + we;
            const gn = an + wn;
            const gs = Math.hypot(ge, gn); // ground speed
            // Drop fixes to simulate lossy tracking; always keep the first so the
            // stream has a seed. The position/time/heading still advance, so the
            // surviving fixes stay on the true drifting spiral.
            if (i === 0 || rand() >= dropFraction) {
                const fix: StatsFix = {t, a, lat, lng};
                if (withBearingSpeed) {
                    fix.b = (h + 360) % 360;
                    fix.s = gs;
                }
                fs.addPosition(fix);
            }
            const distKm = (gs * dt) / 3600;
            const gh = Math.atan2(ge, gn); // ground-track direction (rad)
            lat += (distKm * Math.cos(gh)) / KM_PER_DEG;
            lng += (distKm * Math.sin(gh)) / (KM_PER_DEG * Math.cos((47 * Math.PI) / 180));
            t += dt;
            a += 2 * dt;
            h = (h + 24) % 360; // ~8°/s — a clean thermal
        }
        return fs.getWind();
    };
    const assertWind = (wind: ReturnType<FlightStatistics['getWind']>, speedTol = 5, dirTol = 15) => {
        expect(wind).toBeDefined();
        expect(wind!.speed).toBeGreaterThanOrEqual(20 - speedTol);
        expect(wind!.speed).toBeLessThanOrEqual(20 + speedTol);
        expect(Math.abs(((wind!.direction - 270 + 540) % 360) - 180)).toBeLessThan(dirTol);
    };
    test('wind is estimated from circling drift (OGN bearing+speed)', () => assertWind(flyWindSpiral(true)));
    test('wind is estimated from circling drift (IGC position-only)', () => assertWind(flyWindSpiral(false)));
    // Lossy tracking: drop ~45% of fixes at several seeds — wind must survive the
    // sparser, irregular cadence on both paths (looser tolerance for the thinner
    // sampling). IGC is the hardest case: bearing and speed are both derived from
    // the surviving sparse positions, yet the estimate still holds.
    for (const [label, withBearingSpeed] of [
        ['OGN bearing+speed', true],
        ['IGC position-only', false]
    ] as const) {
        for (const seed of [1, 7, 42, 99]) {
            test(`wind survives lossy tracking — ${label}, ~45% dropped (seed ${seed})`, () => assertWind(flyWindSpiral(withBearingSpeed, 0.45, seed), 7, 25));
        }
    }

    // The caller contract is ascending-time fixes; out-of-order/duplicate ones are
    // dropped (timedif <= 0). A wild rejected fix must not corrupt the open segment.
    test('out-of-order and duplicate fixes are ignored', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        for (let i = 0; i < 10; i++) {
            fs.addPosition({t, a: 1000 + i, lat: 47 + i * 0.001, lng: 19, b: 0, s: 100});
            t += 4;
        }
        const clean = fs.getStats()?.segments ?? [];
        fs.addPosition({t: t - 4, a: 9999, lat: 48, lng: 25, b: 180, s: 300}); // duplicate timestamp
        fs.addPosition({t: t - 40, a: -500, lat: 10, lng: 10, b: 90, s: 5}); // far out of order
        const after = fs.getStats()?.segments ?? [];
        expect(after).toHaveLength(clean.length);
        expect(after[after.length - 1].end).toBe(clean[clean.length - 1].end);
        expect(after.every((s) => s.state !== 'gap')).toBe(true); // no phantom gap/jump
    });

    // reset() drops every byte of state (new track / tracker change) and leaves the
    // unit reusable with no leakage from the prior flight.
    test('reset clears all state and the unit is reusable', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        for (let i = 0; i < 30; i++) {
            const b = (i * 30) % 360;
            fs.addPosition({t, a: 1000 + i * 6, lat: 47 + 0.002 * Math.cos((b * Math.PI) / 180), lng: 19 + 0.002 * Math.sin((b * Math.PI) / 180), b, s: 90});
            t += 3;
        }
        expect((fs.getStats()?.segments ?? []).length).toBeGreaterThan(0);
        fs.reset();
        expect(fs.getStats()).toBeUndefined();
        expect(fs.getWind()).toBeUndefined();
        t = 1000;
        for (let i = 0; i < 10; i++) {
            fs.addPosition({t, a: 1000, lat: 47 + i * 0.001, lng: 19, b: 0, s: 100});
            t += 4;
        }
        const segs = fs.getStats()?.segments ?? [];
        expect(segs).toHaveLength(1);
        expect(segs[0].state).toBe('straight'); // no circling leaked from before reset
    });

    // The IGC client path supplies only t/lat/lng/alt — no bearing or ground
    // speed — so the unit must derive bearing from successive positions
    // (bearingRaw) and still classify circling. IGC logger data is dense, which
    // is where this fallback has to hold up.
    test('classifies a circle from position alone (no bearing/speed)', () => {
        const fs = createFlightStatistics();
        let t = 1000;
        let alt = 1000;
        for (let i = 0; i < 80; i++) {
            const ang = (i * 24 * Math.PI) / 180; // 24°/step, dt 3 s -> ~8°/s
            t += 3;
            alt += 6;
            fs.addPosition({t, a: alt, lat: 51 + 0.002 * Math.cos(ang), lng: -1 + 0.002 * Math.sin(ang)}); // no b, no s
        }
        const segs = fs.getStats()?.segments ?? [];
        const thermalTime = segs.filter((s) => s.state === 'thermal').reduce((acc, s) => acc + (s.end - s.start), 0);
        const straightTime = segs.filter((s) => s.state === 'straight').reduce((acc, s) => acc + (s.end - s.start), 0);
        expect(segs.filter((s) => s.state === 'thermal').length).toBeGreaterThanOrEqual(1);
        expect(thermalTime).toBeGreaterThan(straightTime);
    });
});
