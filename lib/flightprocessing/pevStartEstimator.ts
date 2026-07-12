/*
 * PEV (Cylinder) start estimation — IGC SC3 Annex A 7.4.4.
 *
 * With a Cylinder Start the pilot starts by pressing PEV inside the start
 * cylinder; the start is the latest PEV, or the latest cylinder exit if no
 * PEV was recorded. OGN tracking cannot see PEV presses, so we estimate the
 * start as the beginning of the latest "committed glide": a straight segment
 * (from the flightStatistics classifier) that starts inside the cylinder and
 * makes sustained progress toward TP1. The segment start is the top of the
 * preceding climb, which is where a pilot would press PEV before setting off.
 *
 * Pure functions over raw flightStatistics segments — geometry (insideness /
 * distance-to-TP1) is supplied by the caller so this unit tests without a
 * prepared task or the scoring chain. taskpositiongenerator owns the state
 * wiring (candidate replacement, exit fallback, retro hook).
 */

import type {Epoch, BasePositionMessage} from '../types';
import type {Segment} from '../webworkers/flightStatistics';
import {distHaversine} from './taskhelper';
import {PEV_MIN_COMMIT_KM, PEV_ONTRACK_RATIO, PEV_MIN_GLIDE_EFFICIENCY} from '../constants';

// Geometry callbacks from the prepared task
export interface PevGeometry {
    insideStart: (p: BasePositionMessage) => boolean; // inside the start cylinder
    distToTP1: (p: BasePositionMessage) => number; // km to the TP1 centre
}

export function segmentStartFix(seg: Readonly<Segment>): BasePositionMessage {
    return {t: seg.startTime as Epoch, lat: seg.startLat, lng: seg.startLng, a: seg.startAlt} as BasePositionMessage;
}

export function segmentEndFix(seg: Readonly<Segment>): BasePositionMessage {
    return {t: seg.endTime as Epoch, lat: seg.endLat, lng: seg.endLng, a: seg.endAlt} as BasePositionMessage;
}

//
// Does a glide from `from` to `to` qualify as a committed start glide toward
// TP1? Requires enough net displacement to rule out drifting/local flying,
// that the flight actually went there directly (pathKm is the distance flown —
// a straight segment can hide an out-and-return, which coalesces into one
// straight without a thermal to split it), and that most of the displacement
// is progress toward TP1.
export function qualifiesAsPevGlide(from: BasePositionMessage, to: BasePositionMessage, distToTP1: PevGeometry['distToTP1'], pathKm?: number): boolean {
    const covered = distHaversine(from, to);
    if (covered < PEV_MIN_COMMIT_KM) {
        return false;
    }
    if (pathKm !== undefined && pathKm > 0 && covered / pathKm < PEV_MIN_GLIDE_EFFICIENCY) {
        return false;
    }
    return (distToTP1(from) - distToTP1(to)) / covered >= PEV_ONTRACK_RATIO;
}

//
// The candidate start fix for a straight segment, or null if it can't start a
// PEV glide: not a straight, starts outside the cylinder, or starts before the
// gate opens. A glide already underway when the gate opens is clamped to the
// first inside fix after gate-open (the earliest moment the pilot could have
// pressed PEV on that glide) — supplied by the caller, which sees the stream.
// The clamp fix must fall within the segment: a clamp captured after the
// segment ended belongs to a later part of the flight, and substituting it
// would evaluate a backwards (from.t > to.t) glide.
export function eligibleStartFix(seg: Readonly<Segment>, nostartutc: Epoch, insideStart: PevGeometry['insideStart'], firstInsideAfterGate?: BasePositionMessage | null): BasePositionMessage | null {
    if (seg.state !== 'straight') {
        return null;
    }
    let fix = segmentStartFix(seg);
    if (fix.t < nostartutc) {
        if (!firstInsideAfterGate || firstInsideAfterGate.t > seg.endTime) {
            return null;
        }
        fix = firstInsideAfterGate;
    }
    return insideStart(fix) ? fix : null;
}

//
// The segment path attributable to a glide from `from` onward. When
// eligibleStartFix clamped the start to a mid-segment fix, the segment's
// distance still includes the pre-clamp portion; charge only the direct
// displacement start→from against it (the segment is straight, so the
// displacement is the best estimate of the unseen pre-clamp path) —
// otherwise the efficiency ratio rejects straight gate-straddling glides.
export function pathAfter(seg: Readonly<Segment>, from: BasePositionMessage): number {
    return from.t > seg.startTime ? seg.distance - distHaversine(segmentStartFix(seg), from) : seg.distance;
}

//
// Retro pass, run once TP1 has been turned: over the closed segment history
// (caller appends the open segment), pick the start of the LATEST straight
// segment inside the cylinder in [nostartutc, windowEnd] whose closed
// geometry commits toward TP1 — the rule's "latest PEV wins".
//
// Two things this recovers over the live forward check:
//  - tracking gaps: a glide split by an OGN coverage hole is evaluated across
//    the gap (chains of straight/gap segments are extended end by end; only a
//    thermal breaks the chain, since a climb is where a re-PEV would happen);
//  - late-committing glides: a glide that left the top of the climb off-track
//    and curved onto track never passes the live from-segment-start ratio,
//    but its closed start→end geometry can.
export function pickRetroStart(segments: ReadonlyArray<Readonly<Segment>>, nostartutc: Epoch, windowEnd: Epoch, geometry: PevGeometry, firstInsideAfterGate?: BasePositionMessage | null): BasePositionMessage | null {
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.startTime > windowEnd) {
            continue;
        }
        const from = eligibleStartFix(seg, nostartutc, geometry.insideStart, firstInsideAfterGate);
        if (!from) {
            continue;
        }
        // Try the segment's own extent first, then extend the chain across
        // gaps and further straights — first qualifying extent wins. (A gap's
        // end fix is the real resumption position, so it's a valid test point;
        // its path contribution is the displacement, the best case for what
        // was flown unseen.)
        let pathKm = pathAfter(seg, from);
        if (qualifiesAsPevGlide(from, segmentEndFix(seg), geometry.distToTP1, pathKm)) {
            return from;
        }
        for (let j = i + 1; j < segments.length && segments[j].state !== 'thermal'; j++) {
            const next = segments[j];
            pathKm += next.state === 'gap' ? distHaversine(segmentStartFix(next), segmentEndFix(next)) : next.distance;
            if (qualifiesAsPevGlide(from, segmentEndFix(next), geometry.distToTP1, pathKm)) {
                return from;
            }
        }
    }
    return null;
}
