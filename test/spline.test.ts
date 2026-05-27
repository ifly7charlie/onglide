import {describe, test, expect} from 'vitest';
import {buildSmoothedDeck, extendSmoothedDeck} from '../lib/flightprocessing/spline';
import {getEmptyDeck, generateIndices} from '../lib/flightprocessing/incremental';
import {Compno, DeckData, PilotTrackData} from '../lib/types';

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

    test('bracket dt >= SPLINE_DENSE_DT_S emits no inner vertices', () => {
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1025, lat: 50.002, lng: 0.002, alt: 1020, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        // 25s > DENSE_DT_S=20s → anchor-only.
        expect(deck.smoothed!.posIndex).toBe(2);
    });

    test('bracket dt < SPLINE_SUB_MIN_DT_S emits no inner vertices', () => {
        const deck = makeDeck([
            {t: 1000, lat: 50, lng: 0, alt: 1000, bearing: 90, speed: 80},
            {t: 1002, lat: 50.0001, lng: 0.0001, alt: 1002, bearing: 0, speed: 80}
        ]);
        buildSmoothedDeck(deck);
        // 2s < SUB_MIN_DT_S=4s → straight chord is fine, no inner vertices.
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
        for (let i = 0; i < s.posIndex; i++) {
            if (s.anchorIndex[i] === 2 && s.t[i] !== deck.t[2]) interpolatedFromAnchor2++;
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
});
