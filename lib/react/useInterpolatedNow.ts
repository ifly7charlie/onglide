'use client';

import {useEffect, useRef, useState} from 'react';

import type {Epoch} from '../types';

// How far behind the latest known update the display cursor sits. With
// ~1Hz websocket updates and natural jitter, a small lag means the cursor
// almost always has a known "target" ahead of it, so the RAF loop advances
// at wall-clock rate continuously and never has to snap forward when a
// new update arrives. Bigger = smoother under jitter; smaller = less
// perceived latency.
const DISPLAY_LAG_S = 10;

// Catch-up cap (s): if the display falls more than this far behind the
// target (e.g. tab backgrounded), snap forward instead of taking forever
// to catch up at wall-clock rate.
const MAX_CATCHUP_S = 30;

// Cap the React re-render rate. RAF fires at display refresh (60-360Hz);
// each tick re-renders deckgl and pushes new TripsLayer/IconLayer props
// which prods MapboxOverlay to repaint. 15Hz is plenty for a cursor
// moving ~22 m/s (1.5m per tick — invisible on screen) and cuts the
// React+MapLibre churn roughly 4-24× depending on display.
const TICK_INTERVAL_MS = 1000 / 10;

// Drives a fractional epoch-seconds cursor that advances at wall-clock
// rate between WebSocket updates. The cursor sits ~DISPLAY_LAG_S behind
// `latestUpdate` so incoming updates land ahead of it — the advance is
// continuous; updates just shift the target forward, never the cursor.
//
// Pass `frozen` truthy (e.g. replayTime) to bypass interpolation — the
// hook short-circuits and returns `latestUpdate` unchanged.
export function useInterpolatedNow(latestUpdate: Epoch, frozen: unknown): Epoch {
    const [, setTick] = useState(0);
    // Single source of truth for the smoothed display value. Updated on
    // every render — render itself is triggered by RAF below.
    const stateRef = useRef<{display: number; lastWallMs: number} | null>(null);

    useEffect(() => {
        if (frozen || !latestUpdate) return;

        let raf = 0;
        let lastTickMs = 0;
        const loop = () => {
            if (!document.hidden) {
                const now = performance.now();
                if (now - lastTickMs >= TICK_INTERVAL_MS) {
                    lastTickMs = now;
                    setTick((v) => (v + 1) | 0);
                }
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);

        const onVisibility = () => {
            if (!document.hidden && stateRef.current) {
                // Don't sweep through the dead time — re-anchor wall clock.
                stateRef.current.lastWallMs = performance.now();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            cancelAnimationFrame(raf);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [frozen, latestUpdate === 0]);

    if (frozen || !latestUpdate) {
        stateRef.current = null;
        return latestUpdate;
    }

    const nowMs = performance.now();
    if (!stateRef.current) {
        // First valid render — start the cursor at the lag target so we
        // don't have to chase forward from latestUpdate.
        stateRef.current = {display: latestUpdate - DISPLAY_LAG_S, lastWallMs: nowMs};
    }

    const target = latestUpdate - DISPLAY_LAG_S;
    const dt = (nowMs - stateRef.current.lastWallMs) / 1000;
    stateRef.current.lastWallMs = nowMs;

    let next = stateRef.current.display + dt;
    // Don't run past the latest known point — wait for the next update.
    if (next > target) next = target;
    // Snap forward if we've fallen badly behind (tab hidden a long time,
    // or first update after a long gap).
    if (target - next > MAX_CATCHUP_S) next = target;

    stateRef.current.display = next;
    return next as Epoch;
}
