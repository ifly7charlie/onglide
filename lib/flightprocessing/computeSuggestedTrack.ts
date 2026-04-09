import {distHaversine} from './taskhelper';

import type {Epoch, BasePositionMessage, CalculatedTaskLegStatus} from '../types';

/**
 * Compute suggested track aim points for remaining AAT sectors.
 *
 * Uses the pilot's current achieved speed + 10% as a target, then binary
 * searches for a lerp fraction between each sector's min/max possible points
 * such that the total remaining distance matches the target remaining distance.
 * The last sector before finish uses fraction/4 to avoid overshooting.
 *
 * Returns a stride-4 flat array [lng, lat, segDist, 0, ...] starting from
 * the pilot's current position, or null if preconditions aren't met.
 */
export function computeSuggestedTrack(
    elapsedSecs: number,
    durationSecs: number,
    scoredDistance: number,
    currentLeg: number,
    inSector: boolean,
    lastProcessedPoint: BasePositionMessage,
    legs: CalculatedTaskLegStatus[],
    finishPoint: {lat: number; lng: number},
    log: Function
): number[] | null {
    // Guard: need >5 min elapsed (for stable speed estimate), >10km scored
    // (avoid noise from initial circling), and time remaining in the task
    if (durationSecs <= 0 || elapsedSecs <= 300 || scoredDistance <= 10 || elapsedSecs >= durationSecs) {
        return null;
    }

    const taskSpeedKph = scoredDistance / (elapsedSecs / 3600);
    // Target 10% above achieved speed — final glide is typically faster
    // than average since the pilot stops thermalling
    const targetSpeed = taskSpeedKph * 1.1;
    const remainingTimeSecs = durationSecs - elapsedSecs;
    const targetRemainingDist = targetSpeed * (remainingTimeSecs / 3600);

    const lastSectorBeforeFinish = legs.length - 2;
    // When in sector, skip it — pilot is already there, only aim at future sectors
    const firstRemaining = inSector ? currentLeg + 1 : currentLeg;
    const remainingSectors: {minPoint: BasePositionMessage; maxPoint: BasePositionMessage; isLast: boolean}[] = [];

    for (let i = firstRemaining; i <= lastSectorBeforeFinish; i++) {
        const leg = legs[i];
        if (!leg?.minPossible?.point || !leg?.maxPossible?.point) {
            return null;
        }
        remainingSectors.push({
            minPoint: leg.minPossible.point,
            maxPoint: leg.maxPossible.point,
            isLast: i === lastSectorBeforeFinish
        });
    }

    if (remainingSectors.length === 0) return null;

    const lerpPt = (a: BasePositionMessage, b: BasePositionMessage, fraction: number) => ({
        t: 0 as Epoch,
        lat: a.lat + (b.lat - a.lat) * fraction,
        lng: a.lng + (b.lng - a.lng) * fraction,
        a: 0
    });

    const finishCenter = {t: 0 as Epoch, lat: finishPoint.lat, lng: finishPoint.lng, a: 0};

    // Last sector uses fraction/4: being under time on final glide is much
    // more costly than over time, so keep the aim point conservative to
    // reserve room for extending the last sector if needed
    const sectorFraction = (sector: (typeof remainingSectors)[0], fraction: number) => Math.max(0, Math.min(1, sector.isLast ? fraction / 4 : fraction));

    const computeTotalDist = (fraction: number): number => {
        let total = 0;
        let prev: {lat: number; lng: number} = lastProcessedPoint;
        for (const sector of remainingSectors) {
            const aim = lerpPt(sector.minPoint, sector.maxPoint, sectorFraction(sector, fraction));
            total += distHaversine(prev, aim);
            prev = aim;
        }
        total += distHaversine(prev, finishCenter);
        return total;
    };

    // Binary search for fraction where computeTotalDist === targetRemainingDist
    let lo = 0,
        hi = 1;
    const distAtLo = computeTotalDist(0);
    const distAtHi = computeTotalDist(1);

    let bestFraction: number;
    if (targetRemainingDist <= distAtLo) {
        bestFraction = 0;
    } else if (targetRemainingDist >= distAtHi) {
        bestFraction = 1;
    } else {
        for (let iter = 0; iter < 20; iter++) {
            const mid = (lo + hi) / 2;
            if (computeTotalDist(mid) < targetRemainingDist) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        bestFraction = (lo + hi) / 2;
    }

    // Build stride-4 flat array: [lng, lat, segDist, 0, ...]
    const suggestedPoints: number[] = [lastProcessedPoint.lng, lastProcessedPoint.lat, 0, 0];
    let prev: {lat: number; lng: number} = lastProcessedPoint;
    for (const sector of remainingSectors) {
        const aim = lerpPt(sector.minPoint, sector.maxPoint, sectorFraction(sector, bestFraction));
        const segDist = Math.round(distHaversine(prev, aim) * 10) / 10;
        suggestedPoints.push(aim.lng, aim.lat, segDist, 0);
        prev = aim;
    }
    const finishDist = Math.round(distHaversine(prev, finishCenter) * 10) / 10;
    suggestedPoints.push(finishCenter.lng, finishCenter.lat, finishDist, 0);

    log(`suggestedTrack: fraction=${bestFraction.toFixed(3)} targetDist=${targetRemainingDist.toFixed(1)} speed=${taskSpeedKph.toFixed(1)}kph`);
    return suggestedPoints;
}
