// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Process-global rate limiter for outbound calls to www.soaringspot.com.
// Every fetch in lib/scoring/sources/soaringspotscrape.ts (and any
// future caller hitting that host) MUST go through fetchSoaringSpot so
// we serialise across all in-flight comps and never burst.
//
// Shape: a single FIFO promise chain. Each caller awaits the previous
// slot to settle, sleeps a jittered gap relative to the previous
// finish, then issues its fetch. The chain self-truncates — once a
// slot's handlers run, no live reference reaches the old promises and
// they GC, so the chain doesn't grow over weeks of uptime.
//
// Safeguards for long-running daemons:
//   - AbortController + FETCH_TIMEOUT_MS so a hung TCP connection
//     can't permanently stall every subsequent call (and the whole
//     scraper with it).
//   - `wait` capped at MAX_GAP_MS so a backwards clock jump (NTP
//     correction, VM snapshot resume) at worst inserts one max-gap
//     delay before self-correcting.
//   - Errors don't break the chain — `gate.catch()` swallows so the
//     next caller proceeds normally.
//
// Tunable via env at module-load time. Defaults target ~2s mean spacing
// with a small jitter window so concurrent caller storms (e.g. a
// discovery batch hitting ensureMetadata for many new comps) drain
// predictably.
//

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MIN_GAP_MS = envInt('SOARINGSPOT_MIN_GAP_MS', 1500);
export const MAX_GAP_MS = envInt('SOARINGSPOT_MAX_GAP_MS', 2500);
export const FETCH_TIMEOUT_MS = envInt('SOARINGSPOT_FETCH_TIMEOUT_MS', 30000);

let gate: Promise<unknown> = Promise.resolve();
let lastFinish = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fetchSoaringSpot(url: string, init?: RequestInit): Promise<Response> {
    const slot = gate.then(async () => {
        const gap = MIN_GAP_MS + Math.random() * Math.max(0, MAX_GAP_MS - MIN_GAP_MS);
        // Cap the wait at MAX_GAP_MS so a backwards clock jump can't
        // inject an arbitrarily long sleep.
        const wait = Math.min(MAX_GAP_MS, Math.max(0, lastFinish + gap - Date.now()));
        if (wait > 0) await sleep(wait);

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        try {
            return await fetch(url, {...init, signal: ac.signal});
        } finally {
            clearTimeout(timer);
            lastFinish = Date.now();
        }
    });
    // A failure in this slot must NOT poison the chain — subsequent
    // callers should still proceed.
    gate = slot.catch(() => undefined);
    return slot;
}
