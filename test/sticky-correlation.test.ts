import {describe, test, expect} from 'vitest';

import {checkSecondaryOffset, pushOffsetSample, madOf, type Aircraft, type FlarmOffsetState} from '../lib/webworkers/aprs';
import type {StreamId} from '../lib/types';

// Build a minimal Aircraft shape for the MAD trust gate. The checker
// only reads className/compno (for the log line) and writes back
// untrusted on the state object — the rest is irrelevant.
function makeAircraft(): Aircraft {
    return {
        compno: 'AB1' as any,
        className: 'Open' as any
    } as unknown as Aircraft;
}

function emptyState(): FlarmOffsetState {
    return {dLats: [], dLngs: [], dAlts: [], cursor: 0, count: 0};
}

const PRIMARY: StreamId = (((1 << 24) | 0xaabbcc) >>> 0) as StreamId; // FLR:AABBCC
const SECONDARY: StreamId = (((4 << 24) | 0xaabbcc) >>> 0) as StreamId; // NAV:AABBCC
const LAT_AT_PILOT = 52.0; // realistic comp latitude — cos(lat) ≈ 0.616

describe('madOf', () => {
    test('zero spread → zero MAD', () => {
        expect(madOf([1, 1, 1, 1, 1])).toBe(0);
    });
    test('symmetric ±1 around median → MAD = 1', () => {
        expect(madOf([-1, 0, 0, 0, 1])).toBe(0);
        // median = 0; |dev| = [1,0,0,0,1]; median of those = 0
        expect(madOf([-2, -1, 0, 1, 2])).toBe(1); // |dev| = [2,1,0,1,2] → median 1
    });
    test('single outlier does not dominate (MAD robustness)', () => {
        const cluster = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1_000_000]; // 9 zeros + 1 huge
        // median of cluster = 0; |dev| = [0,0,0,0,0,0,0,0,0,1_000_000]
        // median of those = 0 (5th of 10 sorted = 0)
        expect(madOf(cluster)).toBe(0);
    });
});

describe('pickStickyPrimary MAD gate via checkSecondaryOffset', () => {
    test('drifting secondary latches untrusted after 20+ samples', () => {
        // Simulate a Naviter-at-airfield: each co-occurrence the
        // primary has moved further from the stationary secondary, so
        // the offset sample grows monotonically. After 20 such samples
        // the MAD on lat (in degrees) is large — well over the 50 m
        // threshold once scaled.
        const aircraft = makeAircraft();
        const state = emptyState();
        // 25 samples of dLat growing from 0 to ~0.025 degrees
        // (~2.7 km horizontal drift across the window). MAD on a
        // monotonically growing sequence ≈ a quarter of the range.
        for (let i = 0; i < 25; i++) {
            pushOffsetSample(state, i * 0.001, 0, 0); // ~111 m per sample step on dLat
            checkSecondaryOffset(aircraft, SECONDARY, state, PRIMARY, LAT_AT_PILOT);
        }
        expect(state.untrusted).toBe(true);
    });

    test('tight cockpit-mounted secondary stays trusted across full window', () => {
        // Both devices in the same cockpit — tiny GPS jitter only.
        // ~5 m equivalent peak-to-peak; MAD ~ a couple of metres.
        const aircraft = makeAircraft();
        const state = emptyState();
        // Use a deterministic small jitter so the test is reproducible.
        const SAMPLES = 64;
        for (let i = 0; i < SAMPLES; i++) {
            // ±5 m on lat (≈ ±4.5e-5 deg), same on lng, ±2 m on alt
            const dLat = (((i * 73) % 11) - 5) * 0.45e-5;
            const dLng = (((i * 41) % 11) - 5) * 0.45e-5;
            const dAlt = (((i * 29) % 5) - 2);
            pushOffsetSample(state, dLat, dLng, dAlt);
            checkSecondaryOffset(aircraft, SECONDARY, state, PRIMARY, LAT_AT_PILOT);
        }
        expect(state.untrusted).toBeFalsy();
    });

    test('single bad-GPS outlier does not flip the trust latch', () => {
        // 24 tightly-clustered samples + 1 wild outlier — MAD's
        // robustness is the whole reason we chose it over max-min spread.
        const aircraft = makeAircraft();
        const state = emptyState();
        for (let i = 0; i < 24; i++) {
            pushOffsetSample(state, 0.5e-5, 0.5e-5, 1); // ~0.5 m, basically zero
            checkSecondaryOffset(aircraft, SECONDARY, state, PRIMARY, LAT_AT_PILOT);
        }
        // One wild sample equivalent to ~10 km lat offset.
        pushOffsetSample(state, 0.1, 0.1, 500);
        checkSecondaryOffset(aircraft, SECONDARY, state, PRIMARY, LAT_AT_PILOT);
        expect(state.untrusted).toBeFalsy();
    });

    test('not enough samples → no trust decision yet', () => {
        // Even a wildly-drifting secondary doesn't latch until we have
        // at least STICKY_TRUST_MIN_SAMPLES (20) — below that the MAD
        // isn't statistically meaningful.
        const aircraft = makeAircraft();
        const state = emptyState();
        for (let i = 0; i < 10; i++) {
            pushOffsetSample(state, i * 0.01, 0, 0); // huge drift
            checkSecondaryOffset(aircraft, SECONDARY, state, PRIMARY, LAT_AT_PILOT);
        }
        expect(state.untrusted).toBeFalsy();
    });
});
