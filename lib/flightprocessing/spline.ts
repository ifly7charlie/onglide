import {gapLength, SPLINE_DENSE_DT_S, SPLINE_SUB_MIN_DT_S, SPLINE_SUB_TARGET_DT_S, SPLINE_SUB_MAX, deckPointIncrement, deckSegmentIncrement} from '../constants';
import {DeckData, SmoothedDeck} from '../types';
import {resize} from './incremental';

// Build a Hermite-subdivided sidecar from a DeckData's anchor arrays.
//
// Math reference: lib/smoothing/velocityHermite.ts (validated by the
// offline bake-off in bin/evalSmoothing.ts). Cubic Hermite using each
// anchor's bracket (bearing, speed) as the velocity tangent, scaled by
// the bracket dt so the curve enters/leaves at the reported physical
// speed.
//
// Don't-fabricate contract: between anchors with dt >= SPLINE_DENSE_DT_S
// (typically 20s), no inner vertices are emitted — the renderer shows a
// visible gap rather than a fabricated arc spanning unknown territory.
// For dt < SPLINE_SUB_MIN_DT_S (4s) a straight chord between anchors is
// already smooth at display zoom, so no inner vertices either.
//
// Segment handling: when the anchor-side deck has a segment boundary
// between two consecutive anchors (deck.indices contains the higher
// anchor index), the smoothed sidecar mirrors that break and never
// emits an arc across it.

const METRES_PER_DEG_LAT = 111320;
const DEG2RAD = Math.PI / 180;

function metresPerDegLng(latDeg: number): number {
    return METRES_PER_DEG_LAT * Math.cos(latDeg * DEG2RAD);
}

function bearingSpeedToVelDeg(speedKph: number, bearingDeg: number, atLat: number): {vLng: number; vLat: number} {
    const speedMps = speedKph / 3.6;
    const theta = bearingDeg * DEG2RAD;
    const vEastMps = speedMps * Math.sin(theta);
    const vNorthMps = speedMps * Math.cos(theta);
    return {
        vLng: vEastMps / metresPerDegLng(atLat),
        vLat: vNorthMps / METRES_PER_DEG_LAT
    };
}

function emptySmoothed(initialCapacity: number): SmoothedDeck {
    return {
        positions: new Float32Array(initialCapacity * 3),
        indices: new Uint32Array(deckSegmentIncrement),
        agl: new Int16Array(initialCapacity),
        t: new Uint32Array(initialCapacity),
        climbRate: new Int8Array(initialCapacity),
        anchorIndex: new Uint32Array(initialCapacity),
        posIndex: 0,
        segmentIndex: 1
    };
}

function ensureCapacity(s: SmoothedDeck, needed: number): void {
    if (needed <= s.t.length) return;
    const target = Math.max(needed, s.t.length + deckPointIncrement);
    s.positions = resize(Float32Array, s.positions, target * 3);
    s.t = resize(Uint32Array, s.t, target);
    s.agl = resize(Int16Array, s.agl, target);
    s.climbRate = resize(Int8Array, s.climbRate, target);
    s.anchorIndex = resize(Uint32Array, s.anchorIndex, target);
}

function ensureIndicesCapacity(s: SmoothedDeck, needed: number): void {
    if (needed <= s.indices!.length) return;
    s.indices = resize(Uint32Array, s.indices!, needed + deckSegmentIncrement);
}

function pushVertex(s: SmoothedDeck, lng: number, lat: number, alt: number, agl: number, climb: number, t: number, anchorIdx: number): void {
    const p = s.posIndex;
    s.positions[p * 3] = lng;
    s.positions[p * 3 + 1] = lat;
    s.positions[p * 3 + 2] = alt;
    s.agl[p] = agl;
    s.climbRate[p] = climb;
    s.t[p] = t;
    s.anchorIndex[p] = anchorIdx;
    s.posIndex = p + 1;
}

// Anchor-set boundary detection. The anchor-side deck uses gapLength
// (currently 60s, becoming 20s in step 5) as its segment threshold; we
// mirror those breaks so the renderer's TripsLayer sees consistent
// segmentation between smoothed and anchor data.
function isSegmentBreak(deck: DeckData, prevAnchor: number, anchor: number): boolean {
    return deck.t[anchor] - deck.t[prevAnchor] > gapLength;
}

// Emit one anchor i into the smoothed sidecar; if prevAnchor is given,
// emit Hermite inner vertices first (when the bracket is dense and has
// valid bearing/speed at both ends), then the anchor itself.
//
// Returns the smoothed.posIndex value just after this anchor's emit.
function emitAnchor(deck: DeckData, s: SmoothedDeck, anchor: number, prevAnchor: number): number {
    if (prevAnchor < 0) {
        // First anchor — emit as-is.
        ensureCapacity(s, s.posIndex + 1);
        pushVertex(s, deck.positions[anchor * 3], deck.positions[anchor * 3 + 1], deck.positions[anchor * 3 + 2], deck.agl[anchor], deck.climbRate[anchor], deck.t[anchor], anchor);
        return s.posIndex;
    }

    const dt = deck.t[anchor] - deck.t[prevAnchor];
    const b0 = deck.bearing[prevAnchor];
    const b1 = deck.bearing[anchor];
    const sp0 = deck.speed[prevAnchor];
    const sp1 = deck.speed[anchor];

    // Subdivision gate: dense bracket, both ends have valid bearing/speed,
    // and dt is in the "interesting" window.
    const subdividable = dt >= SPLINE_SUB_MIN_DT_S && dt < SPLINE_DENSE_DT_S && b0 >= 0 && b1 >= 0 && sp0 > 0 && sp1 > 0;

    if (subdividable) {
        const lat0 = deck.positions[prevAnchor * 3 + 1];
        const lng0 = deck.positions[prevAnchor * 3];
        const alt0 = deck.positions[prevAnchor * 3 + 2];
        const lat1 = deck.positions[anchor * 3 + 1];
        const lng1 = deck.positions[anchor * 3];
        const alt1 = deck.positions[anchor * 3 + 2];
        const agl0 = deck.agl[prevAnchor];
        const agl1 = deck.agl[anchor];
        const v0 = bearingSpeedToVelDeg(sp0, b0, lat0);
        const v1 = bearingSpeedToVelDeg(sp1, b1, lat1);
        // Vertical velocity: same value at both ends (mean climb).
        const vAlt = (alt1 - alt0) / dt;
        const climb = deck.climbRate[anchor];
        const N = Math.min(SPLINE_SUB_MAX, Math.max(1, Math.ceil(dt / SPLINE_SUB_TARGET_DT_S)));
        ensureCapacity(s, s.posIndex + N);
        for (let i = 1; i < N; i++) {
            const u = i / N;
            const u2 = u * u;
            const u3 = u2 * u;
            const h00 = 2 * u3 - 3 * u2 + 1;
            const h10 = u3 - 2 * u2 + u;
            const h01 = -2 * u3 + 3 * u2;
            const h11 = u3 - u2;
            const lng = h00 * lng0 + h10 * dt * v0.vLng + h01 * lng1 + h11 * dt * v1.vLng;
            const lat = h00 * lat0 + h10 * dt * v0.vLat + h01 * lat1 + h11 * dt * v1.vLat;
            const alt = h00 * alt0 + h10 * dt * vAlt + h01 * alt1 + h11 * dt * vAlt;
            const agl = Math.round(agl0 + (agl1 - agl0) * u);
            const t = Math.round(deck.t[prevAnchor] + u * dt);
            pushVertex(s, lng, lat, alt, agl, climb, t, anchor);
        }
    } else {
        ensureCapacity(s, s.posIndex + 1);
    }

    // Always emit the anchor itself.
    pushVertex(s, deck.positions[anchor * 3], deck.positions[anchor * 3 + 1], deck.positions[anchor * 3 + 2], deck.agl[anchor], deck.climbRate[anchor], deck.t[anchor], anchor);
    return s.posIndex;
}

// Rebuild the smoothed.indices array from the anchor-side deck.indices,
// translating each anchor index into its corresponding smoothed position.
// Walks forward through the anchor's segmentIndex+1 entries.
function rebuildIndices(deck: DeckData, s: SmoothedDeck, anchorEnd: Uint32Array): void {
    const segCount = deck.segmentIndex ?? 1;
    ensureIndicesCapacity(s, segCount + 1);
    // deck.indices entries 0..segCount-1 are segment STARTS; deck.indices[segCount]
    // is the LAST point's index. Translate accordingly: segment-start anchor's
    // smoothed position is (anchorEnd[anchorIdx] - 1) (its emit position).
    for (let i = 0; i < segCount; i++) {
        const anchorIdx = deck.indices![i];
        s.indices![i] = anchorEnd[anchorIdx] - 1;
    }
    s.indices![segCount] = s.posIndex - 1;
    s.segmentIndex = segCount;
}

// Build the smoothed sidecar from scratch.
export function buildSmoothedDeck(deck: DeckData): void {
    if (deck.posIndex === 0) {
        // Nothing to smooth yet.
        deck.smoothed = emptySmoothed(deckPointIncrement);
        return;
    }
    const s = emptySmoothed(Math.max(deckPointIncrement, deck.posIndex * 2));
    // Map of anchor index → smoothed.posIndex just after that anchor's emit.
    // Used by rebuildIndices to translate segment-start anchor indices into
    // smoothed positions.
    const anchorEnd = new Uint32Array(deck.posIndex);
    let prevAnchor = -1;
    for (let i = 0; i < deck.posIndex; i++) {
        if (prevAnchor >= 0 && isSegmentBreak(deck, prevAnchor, i)) {
            // Segment break — no Hermite across it; emit anchor as a "fresh start".
            anchorEnd[i] = emitAnchor(deck, s, i, -1);
        } else {
            anchorEnd[i] = emitAnchor(deck, s, i, prevAnchor);
        }
        prevAnchor = i;
    }
    rebuildIndices(deck, s, anchorEnd);
    deck.smoothed = s;
}

// Incrementally extend the smoothed sidecar after mergePoint added new
// anchors. fromAnchor is the index of the first newly-added anchor (i.e.
// mergePoint's result.start). The bracket entering anchor fromAnchor
// depends on the new anchor's data, so we discard smoothed vertices with
// anchorIndex >= fromAnchor and re-emit from there.
//
// If the sidecar doesn't exist yet, builds it from scratch.
export function extendSmoothedDeck(deck: DeckData, fromAnchor: number): void {
    if (!deck.smoothed) {
        buildSmoothedDeck(deck);
        return;
    }
    const s = deck.smoothed;
    // Truncate any smoothed vertices belonging to bracket (fromAnchor-1, fromAnchor)
    // or later — i.e. anchorIndex >= fromAnchor. Anchor fromAnchor-1 (if it exists)
    // is preserved.
    while (s.posIndex > 0 && s.anchorIndex[s.posIndex - 1] >= fromAnchor) {
        s.posIndex--;
    }
    // Re-emit from fromAnchor onward.
    const anchorEnd = new Uint32Array(deck.posIndex);
    // Backfill anchorEnd for the anchors we kept. Walk smoothed.anchorIndex
    // and record the position just after each anchor's last emit.
    for (let p = 0; p < s.posIndex; p++) {
        anchorEnd[s.anchorIndex[p]] = p + 1;
    }
    let prevAnchor = fromAnchor - 1;
    for (let i = fromAnchor; i < deck.posIndex; i++) {
        if (prevAnchor < 0 || isSegmentBreak(deck, prevAnchor, i)) {
            anchorEnd[i] = emitAnchor(deck, s, i, -1);
        } else {
            anchorEnd[i] = emitAnchor(deck, s, i, prevAnchor);
        }
        prevAnchor = i;
    }
    rebuildIndices(deck, s, anchorEnd);
}
