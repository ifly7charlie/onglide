//
// trackshape — compare the shape (position + altitude + time) of two point streams.
//
// Primary use case: a pilot with two FLARM trackers registered (one delayed by
// `competition.delayseconds` as an anti-cheat). For the same flight the two
// streams should overlay after applying the configured delay; when they don't,
// the registration is wrong (different flights, mid-day swap, etc.).
//
// The core entry point compareShapes(a, b) takes two arbitrary streams so the
// same machinery extends later to (pilot-vs-pilot similarity) and
// (pilot-vs-synthetic-task) divergence checks.
//

import type {Epoch} from '../types';
import {loadPointsForIds} from '../webworkers/pointlog';
import {distHaversine} from './taskhelper';

// === Tunable thresholds — change here, not in the algorithm ===
const DEFAULT_INTERP_MAX_GAP_SEC = 5; // max gap to a real sample when interpolating; beyond this we say "no sample"
const ROLLING_WINDOW_SEC = 60;
const ROLLING_STRIDE_SEC = 10;
const GAP_MOD_HALFLIFE_SEC = 60;
const MIN_OVERLAP_FOR_LAG_SEC = 120;
const MIN_OVERLAP_FOR_CLASSIFY_SEC = 300;
const MATCHING_P95_POS_KM = 0.2;
const MATCHING_P95_ALT_M = 50;
const DIVERGED_P95_POS_KM = 1.0;
const VERY_DIFFERENT_MEAN_POS_KM = 5.0;
const ABRUPT_RATIO = 4.0;
const FEATURE_HALFWIDTH_SEC = 15; // window for extremum prominence
const FEATURE_MATCH_HALFWIDTH_SEC = 5; // ±s around coarseLag when matching B's extremum
const FEATURE_MIN_PROMINENCE_M = 30;
const XCORR_SIGMA_MIN = 2; // peak/median |xcorr| below this → alignment failed
const LAG_SEARCH_HALFWIDTH_FLOOR = 120;

export interface ShapePoint {
    t: Epoch;
    lat: number;
    lng: number;
    a: number; // AMSL m
    g?: number; // AGL m (optional)
}

export interface PointStream {
    id: string;
    points: ShapePoint[];
}

export interface LagEstimate {
    lag: number; // positive = stream B is delayed by `lag` seconds relative to A
    confidenceSigma: number; // xcorr peak / median |xcorr| over the search window
    featureMedianResidual: number | null; // Stage B: median (B_t - (A_t + lag)) over matched extrema
    featureCount: number;
    failed: boolean;
    searchHalfWidth: number;
    forced: boolean;
}

export interface RollingWindow {
    tStart: number;
    tEnd: number;
    n: number;
    meanPosKm: number;
    maxPosKm: number;
    meanAltDevM: number;
    maxGapSec: number;
    weight: number; // gapMod(maxGapSec) — for downstream consumers that want gap-weighted aggregates
}

export type ShapeClassificationKind =
    | 'matching'
    | 'consistent_offset'
    | 'diverged_abrupt'
    | 'diverged_slow'
    | 'very_different'
    | 'alignment_failed'
    | 'insufficient_overlap';

export interface ShapeClassification {
    kind: ShapeClassificationKind;
    summary: string;
    divergenceAtUtc?: Epoch | null;
    divergencePreKm?: number;
    divergencePostKm?: number;
    slowDriftKmPerHour?: number | null;
}

export interface ShapeReport {
    aId: string;
    bId: string;
    lag: LagEstimate;
    overlapSec: number;
    gapsOver60: number;
    gapsOver300: number;
    sampleCount: number;
    deltaPosP50Km: number;
    deltaPosP95Km: number;
    deltaPosMaxKm: number;
    deltaPosMeanKm: number;
    altBiasM: number; // median signed (A.a - B.a)
    altDevP95M: number; // p95 of |Δalt - bias|
    altDevMaxM: number;
    tResidMaxSec: number;
    windows: RollingWindow[];
    classification: ShapeClassification;
}

export interface CompareOpts {
    forcedLag?: number;
    lagSearchHalfWidth?: number;
}

// gapMod — same shape as lib/scoring/shared/trackerScore.ts:gapMod, reimplemented
// here so lib/flightprocessing/ doesn't take a dependency on lib/scoring/.
function gapMod(gapSec: number, halfLife = GAP_MOD_HALFLIFE_SEC): number {
    if (!Number.isFinite(gapSec) || gapSec < 0) return 0;
    return 1 / (1 + gapSec / halfLife);
}

// Load one flarm-id's points from the on-disk APRS log, materialised as a
// t-sorted, dedup'd array. ~20k points / tracker / day fits in memory fine;
// random access via binary search is what the comparison loop needs.
export async function loadStream(flarmId: string, since: number, until: number): Promise<PointStream> {
    const flarmIds = new Set<string>([flarmId.toUpperCase()]);
    const points: ShapePoint[] = [];
    for await (const m of loadPointsForIds({flarmIds, since, until})) {
        points.push({t: m.t, lat: m.lat, lng: m.lng, a: m.a, g: m.g});
    }
    points.sort((p, q) => p.t - q.t);
    const out: ShapePoint[] = [];
    for (const p of points) {
        if (out.length && out[out.length - 1].t === p.t) {
            out[out.length - 1] = p; // last write wins on exact t collision
            continue;
        }
        out.push(p);
    }
    return {id: flarmId.toUpperCase(), points: out};
}

interface Sampled {
    lat: number;
    lng: number;
    a: number;
    g?: number;
    gapSec: number;
}

// Sample a stream at epoch t via piecewise-linear interpolation. Returns null
// if both neighbours are further than maxAge from t. The optional cursor lets
// the caller walk forward in time without redoing the binary search each call.
function sampleStream(stream: PointStream, t: number, maxAge = DEFAULT_INTERP_MAX_GAP_SEC, cursor?: {idx: number}): Sampled | null {
    const pts = stream.points;
    if (!pts.length) return null;

    let lo = 0;
    if (cursor) {
        let i = cursor.idx;
        if (i < 0) i = 0;
        if (i >= pts.length) i = pts.length - 1;
        if (pts[i].t <= t) {
            while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
            lo = i;
        } else {
            while (i > 0 && pts[i - 1].t > t) i--;
            lo = i > 0 ? i - 1 : 0;
            // If pts[0].t > t we'll fall through to the "before any data" branch.
            if (pts[lo].t > t) lo = -1 as number;
        }
        cursor.idx = Math.max(0, lo);
    } else {
        let hi = pts.length - 1;
        if (pts[0].t > t) lo = -1;
        else {
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (pts[mid].t <= t) lo = mid;
                else hi = mid - 1;
            }
        }
    }

    const prev: ShapePoint | null = lo >= 0 ? pts[lo] : null;
    const next: ShapePoint | null = lo + 1 < pts.length ? pts[lo + 1] : null;

    if (!prev) {
        if (next && next.t - t <= maxAge) return {lat: next.lat, lng: next.lng, a: next.a, g: next.g, gapSec: next.t - t};
        return null;
    }
    if (!next) {
        if (t - prev.t <= maxAge) return {lat: prev.lat, lng: prev.lng, a: prev.a, g: prev.g, gapSec: t - prev.t};
        return null;
    }
    const gapBefore = t - prev.t;
    const gapAfter = next.t - t;
    if (gapBefore > maxAge && gapAfter > maxAge) return null;
    const span = next.t - prev.t;
    if (span <= 0) return {lat: prev.lat, lng: prev.lng, a: prev.a, g: prev.g, gapSec: Math.min(gapBefore, gapAfter)};
    const u = gapBefore / span;
    return {
        lat: prev.lat + u * (next.lat - prev.lat),
        lng: prev.lng + u * (next.lng - prev.lng),
        a: prev.a + u * (next.a - prev.a),
        g: prev.g != null && next.g != null ? prev.g + u * (next.g - prev.g) : undefined,
        gapSec: Math.min(gapBefore, gapAfter)
    };
}

// Build a uniform 1-Hz altitude signal over [t0, t1] from a stream.
// mask[i] === 0 wherever the interpolation gap exceeds DEFAULT_INTERP_MAX_GAP_SEC.
function buildAltitudeSignal(stream: PointStream, t0: number, t1: number): {sig: Float64Array; mask: Uint8Array; n: number} {
    const n = Math.max(0, Math.floor(t1 - t0) + 1);
    const sig = new Float64Array(n);
    const mask = new Uint8Array(n);
    const cursor = {idx: 0};
    for (let i = 0; i < n; i++) {
        const s = sampleStream(stream, t0 + i, DEFAULT_INTERP_MAX_GAP_SEC, cursor);
        if (s) {
            sig[i] = s.a;
            mask[i] = 1;
        }
    }
    return {sig, mask, n};
}

interface Stage1Result {
    lag: number;
    peak: number;
    sigma: number;
    valid: boolean;
}

// Stage A — coarse cross-correlation on AMSL altitude, sign convention is
// lag > 0 ⇒ B is delayed relative to A (A(t) ≈ B(t + lag)).
// Per-lag demeaning means a constant AMSL bias between trackers does not
// shift the correlation peak.
function stage1Lag(a: PointStream, b: PointStream, searchHalfWidth: number): Stage1Result | null {
    if (a.points.length < 2 || b.points.length < 2) return null;
    const t0 = Math.max(a.points[0].t, b.points[0].t);
    const t1 = Math.min(a.points[a.points.length - 1].t, b.points[b.points.length - 1].t);
    if (t1 - t0 < MIN_OVERLAP_FOR_LAG_SEC) return null;

    const A = buildAltitudeSignal(a, t0, t1);
    const B = buildAltitudeSignal(b, t0, t1);

    const W = searchHalfWidth;
    const corr = new Float64Array(2 * W + 1);
    let bestLag = 0;
    let bestPeak = -Infinity;

    for (let L = -W; L <= W; L++) {
        const iLo = Math.max(0, -L);
        const iHi = Math.min(A.n, B.n - L);
        let sumA = 0;
        let sumB = 0;
        let n = 0;
        for (let i = iLo; i < iHi; i++) {
            if (!A.mask[i] || !B.mask[i + L]) continue;
            sumA += A.sig[i];
            sumB += B.sig[i + L];
            n++;
        }
        if (n < MIN_OVERLAP_FOR_LAG_SEC) {
            corr[L + W] = 0;
            continue;
        }
        const meanA = sumA / n;
        const meanB = sumB / n;
        let dot = 0;
        let va = 0;
        let vb = 0;
        for (let i = iLo; i < iHi; i++) {
            if (!A.mask[i] || !B.mask[i + L]) continue;
            const da = A.sig[i] - meanA;
            const db = B.sig[i + L] - meanB;
            dot += da * db;
            va += da * da;
            vb += db * db;
        }
        const denom = Math.sqrt(va * vb);
        const c = denom > 0 ? dot / denom : 0;
        corr[L + W] = c;
        if (c > bestPeak) {
            bestPeak = c;
            bestLag = L;
        }
    }

    const abs = Array.from(corr, Math.abs).sort((x, y) => x - y);
    const medianAbs = abs[abs.length >> 1] || 1e-9;
    return {lag: bestLag, peak: bestPeak, sigma: bestPeak / medianAbs, valid: true};
}

// Stage B sanity check — for each prominent altitude extremum in A, locate the
// closest extremum in B around (A_t + coarseLag). With GPS time and a configured
// integer-second delay we expect a near-zero residual; anything larger feeds
// into the classification.
function detectExtrema(stream: PointStream): number[] {
    const pts = stream.points;
    if (pts.length < 3) return [];
    const out: number[] = [];
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const t = pts[i].t;
        while (lo < i && pts[lo].t < t - FEATURE_HALFWIDTH_SEC) lo++;
        while (hi + 1 < pts.length && pts[hi + 1].t <= t + FEATURE_HALFWIDTH_SEC) hi++;
        let minA = Infinity;
        let maxA = -Infinity;
        for (let k = lo; k <= hi; k++) {
            if (pts[k].a < minA) minA = pts[k].a;
            if (pts[k].a > maxA) maxA = pts[k].a;
        }
        const a = pts[i].a;
        if ((a === minA || a === maxA) && maxA - minA >= FEATURE_MIN_PROMINENCE_M) out.push(t);
    }
    const dedup: number[] = [];
    for (const t of out) if (!dedup.length || t - dedup[dedup.length - 1] >= FEATURE_HALFWIDTH_SEC) dedup.push(t);
    return dedup;
}

function stage2Residual(a: PointStream, b: PointStream, coarseLag: number): {medianResidualSec: number | null; n: number} {
    const aExtrema = detectExtrema(a);
    if (!aExtrema.length) return {medianResidualSec: null, n: 0};

    const residuals: number[] = [];
    let bStart = 0;
    for (const tA of aExtrema) {
        const target = tA + coarseLag;
        const lo = target - FEATURE_MATCH_HALFWIDTH_SEC;
        const hi = target + FEATURE_MATCH_HALFWIDTH_SEC;
        while (bStart < b.points.length && b.points[bStart].t < lo) bStart++;
        const aRef = sampleStream(a, tA);
        if (!aRef) continue;
        let bestT: number | null = null;
        let bestDistA = Infinity;
        for (let j = bStart; j < b.points.length; j++) {
            const bt = b.points[j].t;
            if (bt > hi) break;
            const da = Math.abs(b.points[j].a - aRef.a);
            if (da < bestDistA) {
                bestDistA = da;
                bestT = bt;
            }
        }
        if (bestT != null) residuals.push(bestT - target);
    }
    if (!residuals.length) return {medianResidualSec: null, n: 0};
    residuals.sort((x, y) => x - y);
    return {medianResidualSec: residuals[residuals.length >> 1], n: residuals.length};
}

export function estimateLag(a: PointStream, b: PointStream, opts: CompareOpts = {}): LagEstimate {
    const searchHalfWidth = Math.max(LAG_SEARCH_HALFWIDTH_FLOOR, opts.lagSearchHalfWidth ?? LAG_SEARCH_HALFWIDTH_FLOOR);

    if (opts.forcedLag != null) {
        const stage2 = stage2Residual(a, b, opts.forcedLag);
        return {
            lag: opts.forcedLag,
            confidenceSigma: Infinity,
            featureMedianResidual: stage2.medianResidualSec,
            featureCount: stage2.n,
            failed: false,
            searchHalfWidth,
            forced: true
        };
    }

    const s1 = stage1Lag(a, b, searchHalfWidth);
    if (!s1) {
        return {lag: 0, confidenceSigma: 0, featureMedianResidual: null, featureCount: 0, failed: true, searchHalfWidth, forced: false};
    }
    const failed = !Number.isFinite(s1.sigma) || s1.sigma < XCORR_SIGMA_MIN;
    const stage2 = failed ? {medianResidualSec: null, n: 0} : stage2Residual(a, b, s1.lag);
    return {
        lag: s1.lag,
        confidenceSigma: s1.sigma,
        featureMedianResidual: stage2.medianResidualSec,
        featureCount: stage2.n,
        failed,
        searchHalfWidth,
        forced: false
    };
}

function percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
    return sorted[i];
}

function nearestIndex(pts: ShapePoint[], t: number): number {
    if (!pts.length) return -1;
    let lo = 0;
    let hi = pts.length - 1;
    if (pts[0].t >= t) return 0;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pts[mid].t <= t) lo = mid;
        else hi = mid - 1;
    }
    if (lo + 1 < pts.length && Math.abs(pts[lo + 1].t - t) < Math.abs(pts[lo].t - t)) return lo + 1;
    return lo;
}

function linearSlope(xs: number[], ys: number[]): number {
    const n = xs.length;
    if (n < 2) return 0;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
        mx += xs[i];
        my += ys[i];
    }
    mx /= n;
    my /= n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx;
        num += dx * (ys[i] - my);
        den += dx * dx;
    }
    return den > 0 ? num / den : 0;
}

export function fmtUtcHms(epoch: number): string {
    const d = new Date(epoch * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

export interface ClassifyInput {
    lag: LagEstimate;
    deltaPosP95Km: number;
    deltaPosMeanKm: number;
    altDevP95M: number;
    tResidMaxSec: number;
    windows: RollingWindow[];
}

export function classifyShape(r: ClassifyInput): ShapeClassification {
    if (r.deltaPosMeanKm > VERY_DIFFERENT_MEAN_POS_KM) {
        return {kind: 'very_different', summary: `very different (mean Δpos ${r.deltaPosMeanKm.toFixed(2)} km)`};
    }
    if (r.deltaPosP95Km > DIVERGED_P95_POS_KM) {
        const overallMean = r.windows.length ? r.windows.reduce((s, w) => s + w.meanPosKm, 0) / r.windows.length : 0;
        let abruptIdx = -1;
        for (let i = 1; i < r.windows.length; i++) {
            const w = r.windows[i];
            const prev = r.windows[i - 1];
            const baseline = Math.max(prev.meanPosKm, overallMean * 0.25, 0.05);
            if (w.meanPosKm > ABRUPT_RATIO * baseline && w.meanPosKm > DIVERGED_P95_POS_KM) {
                abruptIdx = i;
                break;
            }
        }
        if (abruptIdx > 0) {
            const w = r.windows[abruptIdx];
            const pre = r.windows[abruptIdx - 1].meanPosKm;
            return {
                kind: 'diverged_abrupt',
                summary: `diverged at ${fmtUtcHms(w.tStart)} UTC (Δpos ${pre.toFixed(2)} → ${w.meanPosKm.toFixed(2)} km within ${ROLLING_WINDOW_SEC}s)`,
                divergenceAtUtc: w.tStart as Epoch,
                divergencePreKm: pre,
                divergencePostKm: w.meanPosKm
            };
        }
        const slope = linearSlope(
            r.windows.map((w) => w.tStart),
            r.windows.map((w) => w.meanPosKm)
        );
        const slopePerHour = slope * 3600;
        return {
            kind: 'diverged_slow',
            summary: `slow drift (${slopePerHour >= 0 ? '+' : ''}${slopePerHour.toFixed(2)} km/hr, p95 Δpos ${r.deltaPosP95Km.toFixed(2)} km)`,
            slowDriftKmPerHour: slopePerHour
        };
    }
    if (r.deltaPosP95Km < MATCHING_P95_POS_KM && r.altDevP95M < MATCHING_P95_ALT_M && r.tResidMaxSec <= 1) {
        if (Math.abs(r.lag.lag) >= 1) return {kind: 'consistent_offset', summary: `consistent offset (lag ${r.lag.lag >= 0 ? '+' : ''}${r.lag.lag}s)`};
        return {kind: 'matching', summary: `matching (lag 0)`};
    }
    if (Math.abs(r.lag.lag) >= 1) {
        return {kind: 'consistent_offset', summary: `consistent offset, noisy (lag ${r.lag.lag >= 0 ? '+' : ''}${r.lag.lag}s, p95 Δpos ${r.deltaPosP95Km.toFixed(2)} km)`};
    }
    return {kind: 'matching', summary: `matching, noisy (p95 Δpos ${r.deltaPosP95Km.toFixed(2)} km)`};
}

// Compare two arbitrary point streams. The signature is deliberately neutral —
// cross-pilot similarity and pilot-vs-synthetic-task divergence will both call
// this same function with different sources for `a` and `b`.
export function compareShapes(a: PointStream, b: PointStream, opts: CompareOpts = {}): ShapeReport {
    const lag = estimateLag(a, b, opts);

    if (lag.failed) {
        return makeEmptyReport(a, b, lag, {
            kind: 'alignment_failed',
            summary: `very different — alignment failed (xcorr σ ${lag.confidenceSigma.toFixed(2)} < ${XCORR_SIGMA_MIN})`
        });
    }

    const t0 = Math.max(a.points[0]?.t ?? 0, (b.points[0]?.t ?? 0) - lag.lag);
    const t1 = Math.min(a.points[a.points.length - 1]?.t ?? 0, (b.points[b.points.length - 1]?.t ?? 0) - lag.lag);

    if (t1 - t0 < MIN_OVERLAP_FOR_CLASSIFY_SEC) {
        return makeEmptyReport(a, b, lag, {
            kind: 'insufficient_overlap',
            summary: `insufficient overlap: ${Math.max(0, t1 - t0)}s`
        });
    }

    const sampleTs: number[] = [];
    const dPos: number[] = [];
    const dAlt: number[] = [];
    const dtResid: number[] = [];
    const sampleGap: number[] = [];

    const cursorA = {idx: 0};
    const cursorB = {idx: 0};

    let gapsOver60 = 0;
    let gapsOver300 = 0;
    let inSpan = false;
    let lastSpanEnd = t0;

    for (let t = t0; t <= t1; t++) {
        const sA = sampleStream(a, t, DEFAULT_INTERP_MAX_GAP_SEC, cursorA);
        const sB = sampleStream(b, t + lag.lag, DEFAULT_INTERP_MAX_GAP_SEC, cursorB);
        if (!sA || !sB) {
            if (inSpan) {
                lastSpanEnd = t - 1;
                inSpan = false;
            }
            continue;
        }
        if (!inSpan) {
            const gap = t - lastSpanEnd;
            if (gap > 60) gapsOver60++;
            if (gap > 300) gapsOver300++;
            inSpan = true;
        }
        sampleTs.push(t);
        dPos.push(distHaversine({lat: sA.lat, lng: sA.lng}, {lat: sB.lat, lng: sB.lng}));
        dAlt.push(sA.a - sB.a);
        const idx = nearestIndex(b.points, t + lag.lag);
        dtResid.push(idx >= 0 ? b.points[idx].t - (t + lag.lag) : 0);
        sampleGap.push(Math.max(sA.gapSec, sB.gapSec));
    }

    if (dPos.length < MIN_OVERLAP_FOR_CLASSIFY_SEC) {
        return makeEmptyReport(a, b, lag, {
            kind: 'insufficient_overlap',
            summary: `insufficient overlap: ${dPos.length}s of mutual samples`
        });
    }

    const dPosSorted = [...dPos].sort((x, y) => x - y);
    const altSorted = [...dAlt].sort((x, y) => x - y);
    const altBias = altSorted[altSorted.length >> 1];
    const altDev = dAlt.map((v) => Math.abs(v - altBias));
    const altDevSorted = [...altDev].sort((x, y) => x - y);
    const tResidMax = dtResid.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

    const deltaPosP50Km = percentile(dPosSorted, 0.5);
    const deltaPosP95Km = percentile(dPosSorted, 0.95);
    const deltaPosMaxKm = dPosSorted[dPosSorted.length - 1];
    const deltaPosMeanKm = dPos.reduce((s, v) => s + v, 0) / dPos.length;
    const altDevP95M = percentile(altDevSorted, 0.95);
    const altDevMaxM = altDevSorted[altDevSorted.length - 1];

    const windows: RollingWindow[] = [];
    let i0 = 0;
    for (let wStart = t0; wStart + ROLLING_WINDOW_SEC <= t1; wStart += ROLLING_STRIDE_SEC) {
        const wEnd = wStart + ROLLING_WINDOW_SEC;
        while (i0 < sampleTs.length && sampleTs[i0] < wStart) i0++;
        let i = i0;
        let sumPos = 0;
        let maxPos = 0;
        let sumAltDev = 0;
        let n = 0;
        let maxGap = 0;
        while (i < sampleTs.length && sampleTs[i] < wEnd) {
            sumPos += dPos[i];
            if (dPos[i] > maxPos) maxPos = dPos[i];
            sumAltDev += altDev[i];
            if (sampleGap[i] > maxGap) maxGap = sampleGap[i];
            n++;
            i++;
        }
        if (n === 0) continue;
        windows.push({
            tStart: wStart,
            tEnd: wEnd,
            n,
            meanPosKm: sumPos / n,
            maxPosKm: maxPos,
            meanAltDevM: sumAltDev / n,
            maxGapSec: maxGap,
            weight: gapMod(maxGap)
        });
    }

    const classification = classifyShape({lag, deltaPosP95Km, deltaPosMeanKm, altDevP95M, tResidMaxSec: tResidMax, windows});

    return {
        aId: a.id,
        bId: b.id,
        lag,
        overlapSec: t1 - t0,
        gapsOver60,
        gapsOver300,
        sampleCount: dPos.length,
        deltaPosP50Km,
        deltaPosP95Km,
        deltaPosMaxKm,
        deltaPosMeanKm,
        altBiasM: altBias,
        altDevP95M,
        altDevMaxM,
        tResidMaxSec: tResidMax,
        windows,
        classification
    };
}

function makeEmptyReport(a: PointStream, b: PointStream, lag: LagEstimate, classification: ShapeClassification): ShapeReport {
    return {
        aId: a.id,
        bId: b.id,
        lag,
        overlapSec: 0,
        gapsOver60: 0,
        gapsOver300: 0,
        sampleCount: 0,
        deltaPosP50Km: 0,
        deltaPosP95Km: 0,
        deltaPosMaxKm: 0,
        deltaPosMeanKm: 0,
        altBiasM: 0,
        altDevP95M: 0,
        altDevMaxM: 0,
        tResidMaxSec: 0,
        windows: [],
        classification
    };
}
