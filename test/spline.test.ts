import {describe, test, expect} from 'vitest';
import {buildSmoothedDeck, extendSmoothedDeck} from '../lib/flightprocessing/spline';
import {getEmptyDeck, generateIndices} from '../lib/flightprocessing/incremental';
import {referenceDate, setReferenceDate} from '../lib/flightprocessing/referenceDate';
import {Compno, DeckData, PilotTrackData} from '../lib/types';

// SmoothedDeck.t is Float32 fractional-seconds-from-referenceDate. At
// production scale (anchor t ≈ epoch-seconds, referenceDate ~10 days earlier)
// the subtraction lands in ~0–864000 where Float32 gives ~0.06s precision.
// Tests below use small anchor t values (1000-1200ish), so we anchor
// referenceDate near them — otherwise Float32 precision at -1.7e9 would
// collapse the inner-vertex t values and break monotonicity assertions.
setReferenceDate(1000);

// Build a DeckData by walking a list of synthetic anchors and stuffing
// them into the raw arrays directly (avoids exercising mergePoint's gap
// logic — we want a controlled segmentation).
function makeDeck(anchors: Array<{t: number; lat: number; lng: number; alt: number; agl?: number; climb?: number; bearing?: number; speed?: number}>): DeckData {
    const deck = getEmptyDeck('00' as Compno, 1);
    for (const [i, a] of anchors.entries()) {
        deck.positions[i * 3] = a.lng;
        deck.positions[i * 3 + 1] = a.lat;
        deck.positions[i * 3 + 2] = a.alt;
        deck.t[i] = a.t;
        deck.agl[i] = a.agl ?? 500;
        deck.climbRate[i] = a.climb ?? 0;
        deck.bearing[i] = a.bearing ?? -1;
        deck.speed[i] = a.speed ?? 0;
    }
    deck.posIndex = anchors.length;
    generateIndices(deck, {compno: '00' as Compno} as PilotTrackData);
    return deck;
}

describe('spline', () => {
    test('two anchors 10s apart with perpendicular bearings produce a curved arc', () => {
        // Anchor 0 at (50, 0) heading due east at 80 kph
        // Anchor 1 at (50.001, 0.001) heading due north at 80 kph
        // Straight chord would go NE; Hermite should bend east-then-north
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1010, lat: 50.001, lng: 0.001, alt: 1010, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        const s = deck.smoothed!;
        // Expect: anchor 0 + several inner vertices + anchor 1.
        expect(s.posIndex).toBeGreaterThan(2);
        // First and last are the anchors. Float32 limits us to ~6-7 decimal
        // digits of precision; positions like 50.001 round to ~50.0009994.
        expect(s.positions[0]).toBeCloseTo(0, 5);
        expect(s.positions[1]).toBeCloseTo(50, 5);
        expect(s.positions[(s.posIndex - 1) * 3]).toBeCloseTo(0.001, 5);
        expect(s.positions[(s.posIndex - 1) * 3 + 1]).toBeCloseTo(50.001, 5);
        // Inner vertices should deviate from the straight chord. A vertex
        // halfway in time is at u=0.5; on the chord that would be
        // lat=50.0005, lng=0.0005. With east-then-north tangents the
        // curve should be biased toward lng > chord at the start (east
        // pull) — pick u near 0.25 and confirm it sits east of the chord.
        const midIdx = Math.floor(s.posIndex * 0.25);
        const lng = s.positions[midIdx * 3];
        const lat = s.positions[midIdx * 3 + 1];
        const chordLng = 0 + 0.25 * 0.001;
        const chordLat = 50 + 0.25 * 0.001;
        // East bias: lng > chord, lat closer to anchor 0.
        expect(lng).toBeGreaterThan(chordLng);
        expect(lat).toBeLessThan(chordLat);
    });

    test('bracket dt > gapLength produces a segment break (no inner vertices, no chord across the break)', () => {
        // 120s gap → far past gapLength=60 → isSegmentBreak triggers and
        // the bracket is treated as a fresh segment start (no Hermite, no
        // chord across the gap from the prior anchor).
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1120, lat: 50.002, lng: 0.002, alt: 1020, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        expect(deck.smoothed!.posIndex).toBe(2);
        expect(deck.smoothed!.segmentIndex).toBe(2);
    });

    test('bracket dt in [SPLINE_TANGENT_CAP_S, gapLength) still emits inner vertices, but tangent magnitude is capped', () => {
        // 30s bracket: above the tangent cap (20s) but below gapLength (60s).
        // Inner vertices ARE emitted (unlike the old behaviour where this
        // would have been chord-only); the curve respects the bearings but
        // can't deviate further from the chord than ~20s × velocity at each
        // end. Sanity check: at u=0.5 the inner vertex sits closer to the
        // chord midpoint than a full-tangent Hermite would have placed it.
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1030, lat: 50.003, lng: 0.003, alt: 1030, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        const s = deck.smoothed!;
        // Expect at least one inner vertex.
        expect(s.posIndex).toBeGreaterThan(2);
        // Tangent-cap sanity: a non-capped Hermite at u=0.5 with these
        // tangents would put the curve substantially off the chord; the
        // capped version stays within a 20s × 80 kph ≈ 440 m envelope from
        // the chord. Convert that into degrees: ~0.004° at this latitude.
        // Pick the middle inner vertex by time and verify its offset from
        // the chord midpoint is below the envelope.
        let mid = -1;
        let bestDt = Infinity;
        const chordT = (1000 + 1030) / 2 - referenceDate;
        for (let i = 0; i < s.posIndex; i++) {
            const dt = Math.abs(s.t[i] - chordT);
            if (dt < bestDt) {
                bestDt = dt;
                mid = i;
            }
        }
        expect(mid).toBeGreaterThan(0);
        const midLng = s.positions[mid * 3];
        const midLat = s.positions[mid * 3 + 1];
        const chordLng = (0 + 0.003) / 2;
        const chordLat = (50 + 50.003) / 2;
        const offset = Math.hypot(midLng - chordLng, midLat - chordLat);
        // Envelope corresponds to ~440 m at this latitude.
        expect(offset).toBeLessThan(0.005);
    });

    test('bracket dt < SPLINE_SUB_MIN_DT_S emits no inner vertices', () => {
        // SUB_MIN_DT_S = 0.5 → use a bracket below that. The makeDeck DeckData
        // uses Uint32 t, so we'd need fractional t support to test < 1s — but
        // a 0s self-bracket is enough to exercise the gate.
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1000, lat: 50.0001, lng: 0.0001, alt: 1002, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        expect(deck.smoothed!.posIndex).toBe(2);
    });

    test('bearing missing on one end falls back to anchor-only', () => {
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            // bearing absent
            {t: 1010, lat: 50.001, lng: 0.001, alt: 1010, bearing: -1, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        expect(deck.smoothed!.posIndex).toBe(2);
    });

    test('speed=0 on one end falls back to anchor-only', () => {
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 0},
            {t: 1010, lat: 50.001, lng: 0.001, alt: 1010, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        expect(deck.smoothed!.posIndex).toBe(2);
    });

    test('segment boundary between anchors blocks Hermite across it', () => {
        // gapLength is 60s by default; put a 120s gap between two anchors
        // that both have bearing/speed. The break should be respected even
        // though SPLINE_DENSE_DT_S would also have caught it.
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1010, lat: 50.001, lng: 0.001, alt: 1010, bearing: 0, speed: 80},
            // 120s gap — segment break in deck.indices.
            {t: 1130, lat: 50.002, lng: 0.002, alt: 1020, bearing: 0, speed: 80},
            {t: 1140, lat: 50.003, lng: 0.003, alt: 1030, bearing: 0, speed: 80}
        ]);
        // Confirm the deck has two segments.
        expect(deck.segmentIndex).toBe(2);
        buildSmoothedDeck(deck);
        const s = deck.smoothed!;
        // Both segments should have inner vertices (each anchor pair within
        // a segment is 10s, which is in the subdivision window).
        // But no inner vertex should bridge the gap.
        // smoothed.indices should mirror the segment break.
        expect(s.segmentIndex).toBe(2);
        // Inner vertex (if any) at the gap break must have anchorIndex
        // pointing to anchor 2 (the new segment's first anchor), not
        // anchor 1, because emitAnchor for a segment-start uses prevAnchor=-1.
        // The simplest check: walk smoothed.anchorIndex and confirm we
        // never see anchorIndex=2 except for anchor 2 itself.
        let interpolatedFromAnchor2 = 0;
        const anchor2T = deck.t[2] - referenceDate;
        for (let i = 0; i < s.posIndex; i++) {
            if (s.anchorIndex[i] === 2 && Math.abs(s.t[i] - anchor2T) > 1e-3) interpolatedFromAnchor2++;
        }
        expect(interpolatedFromAnchor2).toBe(0);
    });

    test('inner vertex times monotonically increase along the bracket', () => {
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1010, lat: 50.001, lng: 0.001, alt: 1010, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        const s = deck.smoothed!;
        for (let i = 1; i < s.posIndex; i++) {
            expect(s.t[i]).toBeGreaterThanOrEqual(s.t[i - 1]);
        }
    });

    test('extendSmoothedDeck after appending one anchor matches full rebuild', () => {
        // Build a deck with N anchors, smooth it, then add one more anchor
        // and call extendSmoothedDeck. Compare against a fresh full build.
        const baseAnchors = [
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1010, lat: 50.001, lng: 0.001, alt: 1010, bearing: 0, speed: 80},
            {t: 1020, lat: 50.002, lng: 0.002, alt: 1020, bearing: 45, speed: 90}
        ];
        const incremental = makeDeck(baseAnchors);
        buildSmoothedDeck(incremental);
        // Add a fourth anchor.
        const newAnchor = {t: 1030, lat: 50.003, lng: 0.003, alt: 1030, bearing: 90, speed: 80};
        incremental.positions[3 * 3] = newAnchor.lng;
        incremental.positions[3 * 3 + 1] = newAnchor.lat;
        incremental.positions[3 * 3 + 2] = newAnchor.alt;
        incremental.t[3] = newAnchor.t;
        incremental.agl[3] = 500;
        incremental.climbRate[3] = 0;
        incremental.bearing[3] = newAnchor.bearing;
        incremental.speed[3] = newAnchor.speed;
        incremental.posIndex = 4;
        generateIndices(incremental, {compno: '00' as Compno} as PilotTrackData);
        extendSmoothedDeck(incremental, 3);

        const fullRebuild = makeDeck([...baseAnchors, newAnchor]);
        buildSmoothedDeck(fullRebuild);

        const sa = incremental.smoothed!;
        const sb = fullRebuild.smoothed!;
        expect(sa.posIndex).toBe(sb.posIndex);
        for (let i = 0; i < sa.posIndex; i++) {
            expect(sa.t[i]).toBe(sb.t[i]);
            expect(sa.positions[i * 3]).toBeCloseTo(sb.positions[i * 3], 9);
            expect(sa.positions[i * 3 + 1]).toBeCloseTo(sb.positions[i * 3 + 1], 9);
            expect(sa.positions[i * 3 + 2]).toBeCloseTo(sb.positions[i * 3 + 2], 9);
            expect(sa.anchorIndex[i]).toBe(sb.anchorIndex[i]);
        }
        expect(sa.segmentIndex).toBe(sb.segmentIndex);
    });

    test('empty deck produces empty smoothed sidecar', () => {
        const deck = getEmptyDeck('00' as Compno, 1);
        buildSmoothedDeck(deck);
        expect(deck.smoothed!.posIndex).toBe(0);
    });

    test('single anchor deck produces single-vertex smoothed sidecar', () => {
        const deck = makeDeck([{t: 1000, lat: 50, lng: 0, alt: 1000}]);
        buildSmoothedDeck(deck);
        expect(deck.smoothed!.posIndex).toBe(1);
    });

    test('inner vertices carry sub-second timing instead of rounded seconds', () => {
        // 10s bracket → at least one inner vertex with fractional t. With
        // SPLINE_SUB_TARGET_DT_S=2 the loop targets N=5 inner positions, so
        // u values 1/5, 2/5, 3/5, 4/5 produce inner t deltas 2, 4, 6, 8s
        // from prevAnchor — all integer, *unhelpful for this test*. Use a
        // 5s bracket → N=3 → inner u in {1/3, 2/3} → deltas 5/3, 10/3 →
        // baseline-relative t values are non-integer.
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1005, lat: 50.0005, lng: 0.0005, alt: 1005, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        const s = deck.smoothed!;
        expect(s.posIndex).toBeGreaterThan(2);
        const anchor0T = 1000 - referenceDate;
        // Inner vertices must have non-integer deltas from the anchor — the
        // old Math.round would have collapsed these to whole seconds.
        let sawFractional = false;
        for (let i = 1; i < s.posIndex - 1; i++) {
            const delta = s.t[i] - anchor0T;
            if (Math.abs(delta - Math.round(delta)) > 0.01) sawFractional = true;
        }
        expect(sawFractional).toBe(true);
    });
});
