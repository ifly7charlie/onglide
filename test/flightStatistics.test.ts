import {describe, test, expect} from 'vitest';
import {createFlightStatistics, StatsFix, FlightStatistics} from '../lib/webworkers/flightStatistics';

// Segment coalescing must never leave two like-state segments adjacent, and
// absorbing a minor segment must never relabel or collapse its substantial
// neighbour. A weak thermal blip merged into a glide must leave the glide a
// glide (not flip it to 'thermal'), and a long glide must survive intact even
// when a proper thermal forms right beside it.
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

describe('flightStatistics coalescing', () => {
    const dur = (s: {start?: number; end?: number}) => (s.end ?? 0) - (s.start ?? 0);

    const noAdjacentSameState = (segs: {state: string; start: number; end: number}[]) => {
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i].state === segs[i - 1].state && segs[i].state !== 'gap', `adjacent ${segs[i].state} at index ${i} (${segs[i - 1].start}-${segs[i - 1].end} then ${segs[i].start}-${segs[i].end})`).toBe(false);
        }
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

    // An S-shaped course correction (bend one way, then back) rectifies both
    // real bends into ~400 deg of GROSS rotation - enough to pass a
    // gross-rotation gate - while never committing to a circle: the running
    // signed rotation peaks at ~200 deg and unwinds. It must be absorbed into
    // the glide, not kept as a phantom "thermal" the panel shows with
    // "1 turns" and a net sink.
    test('an S-shaped course correction is not kept as a thermal', () => {
        const segs = runTrack([
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1}, // glide in
            {steps: 5, turnPerStep: 40, speed: 100, climb: -1}, // bend right (~200 deg)
            {steps: 5, turnPerStep: -40, speed: 100, climb: -1}, // bend back left (~200 deg)
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1} // glide out
        ]);
        expect(segs.filter((s) => s.state === 'thermal')).toHaveLength(0);
        expect(segs.filter((s) => s.state === 'straight')).toHaveLength(1);
    });

    // A multi-bend course correction - roughly 45 deg right, 90 deg left,
    // 80 deg right - with jittery straight-ish pauses between the bends. The
    // bends plus the pauses' rectified jitter sum well past a full circle of
    // gross rotation, but the running signed rotation never gets past ~50
    // deg: every bend is mostly unwound by the next. It must collapse into
    // the surrounding glide.
    test('a right-left-right wiggle with jittery pauses collapses into the glide', () => {
        const KM_PER_DEG = 111.32;
        const fs = createFlightStatistics();
        let t = 1000;
        let alt = 1400;
        let lat = 47;
        let lng = 19;
        let heading = 270; // tracking west
        let jitterSign = 1;
        const speed = 95;
        const push = (turn: number) => {
            jitterSign = -jitterSign;
            heading = (heading + turn + jitterSign * 3 + 360) % 360;
            const distKm = speed / 3600; // dt = 1 s
            const rad = (heading * Math.PI) / 180;
            lat += (distKm * Math.cos(rad)) / KM_PER_DEG;
            lng += (distKm * Math.sin(rad)) / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
            t += 1;
            alt -= 0.4; // gentle net sink throughout, as observed
            fs.addPosition({t, a: alt, lat, lng, b: heading, s: speed});
        };
        const run = (fixes: number, turnPerFix: number) => {
            for (let i = 0; i < fixes; i++) push(turnPerFix);
        };
        run(60, 0); // glide in
        run(5, 9); // ~45 deg right
        run(4, 0); // jittery pause
        run(10, -9); // ~90 deg left
        run(4, 0); // jittery pause
        run(8, 10); // ~80 deg right
        run(60, 0); // glide out
        fs.finish();
        const segs = fs.getStats()?.segments ?? [];
        expect(segs.filter((s) => s.state === 'thermal')).toHaveLength(0);
        expect(segs.filter((s) => s.state === 'straight')).toHaveLength(1);
    });

    // Field case from a live competition trace, confirmed against the
    // pilot's own logger (real fixes with reported course/speed; coordinates
    // offset to sit near 0,0): the glider arcs gently left for ~4 s
    // (entering thermal mode) and tracking then drops out for 41 s - under
    // MAX_GAP_S, so the dropout interval is classified as flown. It really
    // was a thermal: coverage loss is often caused by the aircraft banking
    // away from the receiver. The reported course is 271 both entering and
    // leaving the dropout - bearing carries no rotation information at all -
    // so the recovery rests entirely on the displacement deficit: 610 m made
    // good against the ~1.9 km the reported 170 kph would cover. The sparse
    // unwrap must extrapolate the established rate across the dropout and
    // recover the circle (exactly -360 here) - the on-map track (splined
    // through the gap) shows no turn, but the classification is the true one.
    test('a dropout while circling away from coverage keeps the thermal (field trace)', () => {
        // [t, alt, lat, lng, course, speed]
        const fixes: [number, number, number, number, number, number][] = [
            [51934, 1049, 0.017383, 0.080867, 45, 101.9],
            [51988, 1026, 0.018, 0.061933, 295, 138.9],
            [52002, 996, 0.02025, 0.054367, 295, 150],
            [52010, 987, 0.02155, 0.050067, 296, 148.2],
            [52013, 984, 0.02205, 0.048467, 298, 146.3],
            [52016, 986, 0.022567, 0.046917, 300, 144.5],
            [52019, 987, 0.023133, 0.0454, 301, 144.5],
            [52025, 988, 0.024367, 0.042517, 310, 140.8],
            [52027, 993, 0.024833, 0.041667, 314, 138.9],
            [52028, 997, 0.025083, 0.041283, 316, 135.2],
            [52030, 1001, 0.025567, 0.040533, 316, 131.5],
            [52031, 1003, 0.0258, 0.040167, 315, 131.5],
            [52033, 1004, 0.026267, 0.0394, 313, 131.5],
            [52037, 1020, 0.0271, 0.037783, 306, 127.8],
            [52038, 1028, 0.027283, 0.03735, 299, 124.1],
            [52039, 1037, 0.027417, 0.0369, 290, 124.1],
            [52041, 1046, 0.027533, 0.035917, 271, 125.9],
            [52082, 1029, 0.025367, 0.027767, 271, 170.4], // 41 s dropout ends here
            [52086, 1006, 0.025467, 0.024917, 273, 181.5],
            [52093, 987, 0.025667, 0.019683, 273, 187.1]
        ];
        const fs = createFlightStatistics();
        for (const [t, a, lat, lng, b, s] of fixes) {
            fs.addPosition({t, a, lat, lng, b, s});
        }
        fs.finish();
        const segs = fs.getStats()?.segments ?? [];
        const thermals = segs.filter((s) => s.state === 'thermal');
        expect(thermals).toHaveLength(1);
        // The thermal spans the dropout and is credited about one circle
        // (the panel shows "1 turns"), left-handed, not flagged mixed.
        expect(thermals[0].start).toBeLessThanOrEqual(52041);
        expect(thermals[0].end).toBeGreaterThanOrEqual(52082);
        expect(Math.round(thermals[0].turncount / 360)).toBe(1);
        expect(thermals[0].direction).toBe(1);
        // The glide in survives as its own straight segment.
        expect(segs[0].state).toBe('straight');
        expect(segs[0].end).toBeLessThanOrEqual(52041);
    });

    // At 1 Hz the smoothed turn rate must ride through a single jittered
    // bearing delta: one wrong-sign fix inside a steady circle may not drag the
    // rate under the exit threshold (a phantom straight splitting the climb),
    // and the credited rotation stays close to what was actually flown.
    test('a single jittered fix at 1 Hz does not split a thermal', () => {
        const KM_PER_DEG = 111.32;
        const R = 0.025 / (2 * Math.sin((7.5 * Math.PI) / 180)) / KM_PER_DEG; // chord per 15 deg step = the 25 m a 90 kph fix covers in 1 s
        const fs = createFlightStatistics();
        let t = 1000;
        let alt = 1000;
        let bearing = 0;
        const seen = new Set<string>();
        const push = (delta: number) => {
            bearing = (bearing + delta + 360) % 360;
            t += 1;
            alt += 2;
            const ang = (bearing * Math.PI) / 180;
            fs.addPosition({t, a: alt, lat: 51 + R * Math.cos(ang), lng: -1 + R * Math.sin(ang), b: bearing, s: 90});
            for (const s of fs.getStats()?.segments ?? []) seen.add(s.state);
        };
        for (let i = 0; i < 20; i++) push(15);
        push(-12); // one jittered fix mid-circle
        for (let i = 0; i < 20; i++) push(15);
        expect(seen.has('straight')).toBe(false); // never even transiently split
        const thermals = (fs.getStats()?.segments ?? []).filter((s) => s.state === 'thermal');
        expect(thermals).toHaveLength(1);
        expect(thermals[0].turncount).toBeGreaterThan(500); // ~612 deg flown; smoothing must not eat real rotation
    });

    // A single circle flown in poor coverage: a few dense fixes enter the
    // thermal, one ~26 s fix carries most of the rotation (aliased, recovered
    // by the unwrap), then the glider leaves on a long glide. The
    // reconstructed signed rotation must keep the climb a thermal - sparse
    // sampling may not downgrade a real circle into the surrounding straight.
    test('a single circle in poor coverage survives as a thermal', () => {
        const KM_PER_DEG = 111.32;
        const R = 0.0015; // ~167 m circle radius (degrees)
        const speed = 100;
        const period = ((2 * Math.PI * R * KM_PER_DEG) / speed) * 3600;
        const fs = createFlightStatistics();
        let t = 1000;
        let a = 1200;
        let ang = 0;
        const emit = () => {
            const rad = (ang * Math.PI) / 180;
            fs.addPosition({t, a, lat: 47 + R * Math.cos(rad), lng: 19 + (R * Math.sin(rad)) / Math.cos((47 * Math.PI) / 180), b: (90 + ang) % 360, s: speed});
        };
        emit();
        const step = (deg: number) => {
            ang = (ang + deg) % 360;
            t += Math.round((deg / 360) * period);
            a += 12;
            emit();
        };
        for (let i = 0; i < 6; i++) step(30); // dense entry (~3 s fixes)
        step(250); // one sparse fix completes the circle (~26 s, aliases)
        // long glide out at a 4 s cadence
        let lat = 47 + R * Math.cos((ang * Math.PI) / 180);
        for (let i = 0; i < 50; i++) {
            t += 4;
            a -= 4;
            lat += (120 / 3600) * 4 * (1 / KM_PER_DEG);
            fs.addPosition({t, a, lat, lng: 19, b: 0, s: 120});
        }
        const segs = fs.getStats()?.segments ?? [];
        noAdjacentSameState(segs);
        expect(segs.filter((s) => s.state === 'thermal')).toHaveLength(1);
        expect(segs.filter((s) => s.state === 'straight')).toHaveLength(1);
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

    // finish() closes the flight when the glider crosses the line and tracking
    // stops. The open tail segment is normally only roll-up-merged when the next
    // segment opens; at the finish there is no next segment, so finish() runs the
    // same merge so a stray recentre/blip at the end doesn't survive as its own.
    test('finish() collapses a stray open tail into its neighbour', () => {
        const fs = createFlightStatistics();
        const fixes = buildTrack([
            {steps: 30, turnPerStep: 40, speed: 80, climb: 2}, // strong thermal
            {steps: 3, turnPerStep: 0, speed: 90, climb: 0} // brief straight — left open at the end
        ]);
        for (const f of fixes) fs.addPosition(f);
        // While open, the brief straight is still its own (uncollapsed) segment.
        expect((fs.getStats()?.segments ?? []).filter((s) => s.state === 'straight')).toHaveLength(1);
        fs.finish();
        const after = fs.getStats()?.segments ?? [];
        expect(after).toHaveLength(1);
        expect(after[0].state).toBe('thermal');
    });

    // A substantial final glide is real flight and must survive finish() — the
    // tail roll-up only absorbs a brief/short stray, never a proper segment.
    test('finish() keeps a substantial final glide', () => {
        const fs = createFlightStatistics();
        const fixes = buildTrack([
            {steps: 30, turnPerStep: 40, speed: 80, climb: 2}, // thermal
            {steps: 40, turnPerStep: 0, speed: 120, climb: -2} // long final glide (160 s)
        ]);
        for (const f of fixes) fs.addPosition(f);
        fs.finish();
        const after = fs.getStats()?.segments ?? [];
        expect(after.map((s) => s.state)).toEqual(['thermal', 'straight']);
    });

    // After finish() the unit is closed: later fixes (here a whole new glide) are
    // dropped, and finish() is idempotent.
    test('addPosition after finish() is ignored, and finish() is idempotent', () => {
        const fs = createFlightStatistics();
        for (const f of buildTrack([{steps: 30, turnPerStep: 40, speed: 80, climb: 2}])) fs.addPosition(f);
        fs.finish();
        const frozen = JSON.stringify(fs.getStats());
        let t = 100000; // well after the first track, in forward order
        for (let i = 0; i < 40; i++, t += 4) fs.addPosition({t, a: 2000 - i, lat: 50 + i * 0.001, lng: 19, b: 0, s: 120});
        expect(JSON.stringify(fs.getStats())).toBe(frozen);
        fs.finish();
        expect(JSON.stringify(fs.getStats())).toBe(frozen);
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

// The raw accessors expose the internal (unrounded) segment objects for the
// PEV start estimator: closed segments plus the open one, with full start/end
// fix geometry. They must mirror exactly what getStats() lifts, at every point
// of the stream — including through blip absorption and open-segment resume,
// where a closed segment is popped back to open.
describe('flightStatistics raw segment accessors', () => {
    const collectRaw = (fs: FlightStatistics) => {
        const raw = [...fs.getSegmentsRaw()];
        const open = fs.getOpenSegmentRaw();
        if (open) raw.push(open);
        return raw;
    };

    test('raw views mirror getStats at every fix through coalescing', () => {
        const fs = createFlightStatistics();
        for (const f of buildTrack([
            {steps: 45, turnPerStep: 40, speed: 80, climb: 2}, // thermal
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1.5}, // glide
            {steps: 4, turnPerStep: 40, speed: 100, climb: 0}, // blip — absorbed, resumes the glide
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1.5}, // glide continues
            {steps: 45, turnPerStep: 40, speed: 80, climb: 2} // thermal
        ])) {
            fs.addPosition(f);
            const lifted = fs.getStats()?.segments ?? [];
            const raw = collectRaw(fs);
            expect(raw.map((s) => s.state)).toEqual(lifted.map((s) => s.state));
            expect(raw.map((s) => s.startTime)).toEqual(lifted.map((s) => s.start));
            expect(raw.map((s) => s.endTime)).toEqual(lifted.map((s) => s.end));
        }
    });

    test('a raw straight segment starts at the top-of-climb fix with full geometry', () => {
        const fs = createFlightStatistics();
        const fixes = buildTrack([
            {steps: 45, turnPerStep: 40, speed: 80, climb: 2}, // thermal
            {steps: 50, turnPerStep: 0, speed: 120, climb: -1.5} // glide (open at the end)
        ]);
        for (const f of fixes) fs.addPosition(f);
        const open = fs.getOpenSegmentRaw();
        expect(open?.state).toBe('straight');
        // Segments abut: the glide begins where the previous fix was, so its
        // start geometry is an actual track fix — the top of the climb.
        const at = fixes.find((f) => f.t === open!.startTime);
        expect(at).toBeDefined();
        expect(open!.startLat).toBeCloseTo(at!.lat, 9);
        expect(open!.startLng).toBeCloseTo(at!.lng, 9);
        expect(open!.startAlt).toBeCloseTo(at!.a, 9);
    });

    test('raw accessors are empty before any segment and after reset', () => {
        const fs = createFlightStatistics();
        expect(fs.getOpenSegmentRaw()).toBeNull();
        expect(fs.getSegmentsRaw()).toHaveLength(0);
        for (const f of buildTrack([{steps: 30, turnPerStep: 40, speed: 80, climb: 2}])) fs.addPosition(f);
        expect(collectRaw(fs).length).toBeGreaterThan(0);
        fs.reset();
        expect(fs.getOpenSegmentRaw()).toBeNull();
        expect(fs.getSegmentsRaw()).toHaveLength(0);
    });
});
