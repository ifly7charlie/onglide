import {describe, test, expect} from 'vitest';
import {qualifiesAsPevGlide, eligibleStartFix, pickRetroStart, segmentStartFix, pathAfter, PevGeometry} from '../lib/flightprocessing/pevStartEstimator';
import type {Segment} from '../lib/webworkers/flightStatistics';
import type {Epoch, BasePositionMessage} from '../lib/types';
import {distHaversine} from '../lib/flightprocessing/taskhelper';

// Geometry: start cylinder r=10km centred at (47, 19); TP1 centre 40km due
// east. Points are built from km offsets east/north of the cylinder centre.
const KM_PER_DEG = 111.32;
const CENTRE = {lat: 47, lng: 19};
const pt = (eastKm: number, northKm: number, t = 0, a = 1500): BasePositionMessage =>
    ({
        t: t as Epoch,
        lat: CENTRE.lat + northKm / KM_PER_DEG,
        lng: CENTRE.lng + eastKm / (KM_PER_DEG * Math.cos((CENTRE.lat * Math.PI) / 180)),
        a
    }) as BasePositionMessage;
const TP1 = pt(40, 0);
const geometry: PevGeometry = {
    insideStart: (p) => distHaversine(p, CENTRE) < 10,
    distToTP1: (p) => distHaversine(p, TP1)
};

// A raw Segment with only the fields the estimator reads populated from
// from/to fixes; the rest defaulted. pathKm overrides the flown distance when
// the segment is meant to have wandered (default: the direct displacement).
const seg = (state: Segment['state'], from: BasePositionMessage, to: BasePositionMessage, pathKm?: number): Segment => ({
    state,
    startTime: from.t,
    endTime: to.t,
    startLng: from.lng,
    startLat: from.lat,
    endLng: to.lng,
    endLat: to.lat,
    startAlt: from.a,
    endAlt: to.a,
    turncount: 0,
    grossTurn: 0,
    distance: pathKm ?? distHaversine(from, to),
    heightgain: 0,
    heightloss: 0,
    direction: 0,
    packets: 2,
    maxDelay: 4,
    ws: {minSpeed: Infinity, minAngle: 0, maxSpeed: -Infinity, maxAngle: 0, cumulative: 0, packets: 0},
    circles: []
});

describe('qualifiesAsPevGlide', () => {
    test('a committed glide toward TP1 qualifies', () => {
        expect(qualifiesAsPevGlide(pt(-5, 0), pt(-2, 0), geometry.distToTP1)).toBe(true);
    });
    test('a glide below the commit distance does not qualify', () => {
        expect(qualifiesAsPevGlide(pt(-5, 0), pt(-4, 0), geometry.distToTP1)).toBe(false);
    });
    test('a glide perpendicular to TP1 does not qualify', () => {
        expect(qualifiesAsPevGlide(pt(-5, 0), pt(-5, 4), geometry.distToTP1)).toBe(false);
    });
    test('a glide away from TP1 does not qualify', () => {
        expect(qualifiesAsPevGlide(pt(-5, 0), pt(-9, 0), geometry.distToTP1)).toBe(false);
    });
    test('a mostly-on-track glide (within ~53° of the TP1 bearing) qualifies', () => {
        // 4km at ~37° off the direct bearing: progress/covered = cos(37°) ≈ 0.8
        expect(qualifiesAsPevGlide(pt(-5, 0), pt(-5 + 3.2, 2.4), geometry.distToTP1)).toBe(true);
    });
    test('an out-and-return hidden in one straight is rejected on path efficiency', () => {
        // Net 4km toward TP1, but 20km actually flown (out west and back):
        // adjacent straights coalesce, so only the path/displacement ratio
        // can tell this from a genuine glide.
        expect(qualifiesAsPevGlide(pt(-5, 0), pt(-1, 0), geometry.distToTP1, 20)).toBe(false);
        // The same displacement flown directly qualifies.
        expect(qualifiesAsPevGlide(pt(-5, 0), pt(-1, 0), geometry.distToTP1, 4.1)).toBe(true);
    });
});

describe('eligibleStartFix', () => {
    const GATE = 1000 as Epoch;
    test('a straight starting inside the cylinder after the gate is eligible', () => {
        const s = seg('straight', pt(-5, 0, 1200), pt(0, 0, 1400));
        expect(eligibleStartFix(s, GATE, geometry.insideStart)).toMatchObject({t: 1200});
    });
    test('thermals and gaps are never eligible', () => {
        expect(eligibleStartFix(seg('thermal', pt(-5, 0, 1200), pt(-5, 0.4, 1400)), GATE, geometry.insideStart)).toBeNull();
        expect(eligibleStartFix(seg('gap', pt(-5, 0, 1200), pt(0, 0, 1400)), GATE, geometry.insideStart)).toBeNull();
    });
    test('a straight starting outside the cylinder is not eligible', () => {
        expect(eligibleStartFix(seg('straight', pt(-15, 0, 1200), pt(0, 0, 1400)), GATE, geometry.insideStart)).toBeNull();
    });
    test('a straight entirely before the gate is not eligible even with a clamp fix', () => {
        const s = seg('straight', pt(-5, 0, 500), pt(-3, 0, 900));
        expect(eligibleStartFix(s, GATE, geometry.insideStart, pt(-4, 0, 1005))).toBeNull();
    });
    test('a glide straddling gate-open clamps to the first inside fix after the gate', () => {
        const s = seg('straight', pt(-8, 0, 500), pt(0, 0, 1400));
        // without a clamp fix the pre-gate start disqualifies it
        expect(eligibleStartFix(s, GATE, geometry.insideStart)).toBeNull();
        // with one, the clamped fix is the candidate
        expect(eligibleStartFix(s, GATE, geometry.insideStart, pt(-6, 0, 1005))).toMatchObject({t: 1005});
    });
    test('a clamp fix after the segment end is never substituted (no backwards glide)', () => {
        // The straight straddled gate-open but the pilot only entered the
        // cylinder later, on a different segment: substituting the clamp
        // would evaluate a glide whose start postdates its end.
        const s = seg('straight', pt(-9, 0, 500), pt(-7, 0, 1200));
        expect(eligibleStartFix(s, GATE, geometry.insideStart, pt(-6, 0, 1500))).toBeNull();
    });
});

describe('pathAfter', () => {
    test('the full segment path when the start fix is the segment start', () => {
        const s = seg('straight', pt(-8, 0, 500), pt(2, 0, 1500), 12);
        expect(pathAfter(s, segmentStartFix(s))).toBe(12);
    });
    test('the pre-clamp displacement is not charged against a clamped glide', () => {
        const s = seg('straight', pt(-8, 0, 500), pt(2, 0, 1500)); // 10km direct
        expect(pathAfter(s, pt(-3, 0, 1000))).toBeCloseTo(5, 1);
    });
});

describe('pickRetroStart', () => {
    const GATE = 1000 as Epoch;

    test('latest qualifying glide wins over an earlier one', () => {
        const segments = [
            seg('straight', pt(-8, 0, 1100), pt(-4, 0, 1300)), // qualifying glide A
            seg('thermal', pt(-4, 0, 1300), pt(-4, 0.3, 1600)), // climb inside the cylinder
            seg('straight', pt(-4, 0.3, 1600), pt(5, 0, 2000)) // qualifying glide B (later)
        ];
        const pick = pickRetroStart(segments, GATE, 2500 as Epoch, geometry);
        expect(pick?.t).toBe(1600);
    });

    test('a tracking gap is bridged: a short pre-gap glide qualifies on the combined extent', () => {
        const segments = [
            seg('thermal', pt(-6, 0, 1100), pt(-6, 0.3, 1500)),
            seg('straight', pt(-6, 0.3, 1500), pt(-5, 0.2, 1540)), // only 1km — below commit on its own
            seg('gap', pt(-5, 0.2, 1540), pt(-1, 0, 1700)), // OGN coverage hole
            seg('straight', pt(-1, 0, 1700), pt(6, 0, 2000)) // glide resumes toward TP1
        ];
        // The latest straight starts OUTSIDE the (10km) cylinder? No — (-1,0) is
        // inside, so it is itself the latest candidate and qualifies.
        expect(pickRetroStart(segments, GATE, 2500 as Epoch, geometry)?.t).toBe(1700);
        // Make the post-gap resume point sit outside the cylinder: the pre-gap
        // segment start must then be credited via the bridged geometry.
        const outsideResume = [
            seg('thermal', pt(-6, 0, 1100), pt(-6, 0.3, 1500)),
            seg('straight', pt(-6, 0.3, 1500), pt(-5, 0.2, 1540)),
            seg('gap', pt(-5, 0.2, 1540), pt(11, 0, 1800)),
            seg('straight', pt(11, 0, 1800), pt(16, 0, 2000))
        ];
        expect(pickRetroStart(outsideResume, GATE, 2500 as Epoch, geometry)?.t).toBe(1500);
    });

    test('a thermal breaks the bridge chain', () => {
        // Short glide, then a climb, then a glide AWAY from TP1: nothing may be
        // credited by chaining the short glide through the climb.
        const segments = [
            seg('straight', pt(-5, 0, 1100), pt(-4, 0, 1140)), // short, below commit
            seg('thermal', pt(-4, 0, 1140), pt(-4, 0.3, 1500)),
            seg('straight', pt(-4, 0.3, 1500), pt(-9, 0, 2000)) // away from TP1
        ];
        expect(pickRetroStart(segments, GATE, 2500 as Epoch, geometry)).toBeNull();
    });

    test('segments starting after the window end are ignored', () => {
        const segments = [
            seg('straight', pt(-8, 0, 1100), pt(-4, 0, 1300)), // qualifying, in window
            seg('straight', pt(-4, 0, 2600), pt(2, 0, 3000)) // qualifying, after TP1 entry
        ];
        expect(pickRetroStart(segments, GATE, 2500 as Epoch, geometry)?.t).toBe(1100);
    });

    test('a glide that only becomes on-track later qualifies on closed geometry', () => {
        // Leaves the top of the climb heading ~90° off-track, curving on-track:
        // classifier keeps it one straight (slow curve), and the closed
        // start→end displacement is toward TP1 even though the early live
        // ratio from the segment start never was.
        const segments = [seg('straight', pt(-6, 0, 1200), pt(0, 2, 1700))];
        expect(pickRetroStart(segments, GATE, 2500 as Epoch, geometry)?.t).toBe(1200);
    });

    test('no qualifying glide returns null (exit fallback stays in force)', () => {
        const segments = [
            seg('thermal', pt(-5, 0, 1100), pt(-5, 0.3, 1400)),
            seg('straight', pt(-5, 0.3, 1400), pt(-5, 6, 1800)) // perpendicular wander
        ];
        expect(pickRetroStart(segments, GATE, 2500 as Epoch, geometry)).toBeNull();
    });

    test('gate-straddling glide is credited at the clamp fix', () => {
        const segments = [seg('straight', pt(-8, 0, 500), pt(2, 0, 1500))];
        const pick = pickRetroStart(segments, GATE, 2500 as Epoch, geometry, pt(-6, 0, 1010));
        expect(pick?.t).toBe(1010);
    });

    test('a straight gate-straddling glide is not rejected on path efficiency', () => {
        // Half the glide was flown pre-clamp: covered from the clamp fix is
        // 5km against a 10km segment path. Charging the whole path would
        // fail the efficiency ratio (0.5 < 0.75) for a dead-straight glide.
        const segments = [seg('straight', pt(-8, 0, 500), pt(2, 0, 1500))];
        expect(pickRetroStart(segments, GATE, 2500 as Epoch, geometry, pt(-3, 0, 1000))?.t).toBe(1000);
    });

    test('segmentStartFix carries full fix geometry', () => {
        const s = seg('straight', pt(-5, 1, 1200, 1800), pt(0, 0, 1500));
        const fix = segmentStartFix(s);
        expect(fix.t).toBe(1200);
        expect(fix.a).toBe(1800);
        expect(fix.lat).toBeCloseTo(pt(-5, 1).lat, 9);
        expect(fix.lng).toBeCloseTo(pt(-5, 1).lng, 9);
    });
});
