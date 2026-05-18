import {PositionStatus, type Compno, type Epoch} from '../types';
import {FINISHING_ETA_MINUTES, HOME_OGN_COVERAGE, LAUNCHING_TRACKED_FRACTION, LAUNCHING_TOTAL_FRACTION} from '../constants';

// One tracked pilot's inputs to the compstatus state machine — the minimal set
// pulled from the official scorer status and the pilot's latest live PilotScore.
// flightStatus is undefined when the pilot has no score yet.
export interface PartialPilotScoredStatus {
    compno: Compno;
    scoredStatus: 'S' | 'F' | 'H';
    flightStatus: PositionStatus | undefined;
    started: boolean; // utcStart !== 0
    distanceRemaining: number;
    taskDistance: number;
    taskSpeed: number;
    t: Epoch;
}

// A forward compstatus transition: the target state, the prior states it may
// overwrite, and a human-readable reason for the log line.
export interface CompStatusResult {
    status: string;
    allowFrom: string[];
    reason: string;
}

// Derive the compstatus state for a single class from its tracked pilots' live
// scoring state. Pure (bar diagnostic logging): returns the transition to apply,
// or null when no state is indicated — the caller owns the DB write and channel
// updates. `scored` is the tracked subset; `totalScored` is the full class field
// size (used for tracker-coverage gating). `className` is only for log lines.
export function computeCompStatus(scored: PartialPilotScoredStatus[], totalScored: number, className: string, now: Epoch): CompStatusResult | null {
    if (scored.length === 0) return null;
    const trackerCoverage = totalScored > 0 ? scored.length / totalScored : 0;

    const isTerminalScored = (p: PartialPilotScoredStatus) => p.scoredStatus === 'F' || p.scoredStatus === 'H';
    // First pass — strict per-pilot home check. A pilot is strictly home if:
    //   - officially finalised by the scorer (scoredStatus F or H), OR
    //   - live flightStatus is Landed / Home / Finished.
    // APRS evidence on its own (Grid, Stationary, stale tracking) doesn't count
    // here — those heuristics produced false positives, so we'd rather lag
    // reality than declare H prematurely.
    const isStrictHome = (p: PartialPilotScoredStatus) => {
        if (isTerminalScored(p)) return true;
        if (p.flightStatus === undefined) {
            return false;
        }
        const fs = p.flightStatus;
        return fs === PositionStatus.Landed || fs === PositionStatus.Home || fs === PositionStatus.Finished;
    };
    const strictHomeCount = scored.filter(isStrictHome).length;
    // Once a majority of the class is strictly home the day is clearly winding
    // down: a tracked pilot still on the grid who never started never launched
    // (DNS, or the tracker went offline on the grid). Count those home too, so a
    // handful of no-shows can't wedge the class out of H. Requiring a majority
    // (not just one starter) keeps a pre-launch / mid-launch field — where the
    // racers aren't home yet — from reading as "all home".
    const majorityHome = strictHomeCount > scored.length / 2;
    const isHome = (p: PartialPilotScoredStatus) => isStrictHome(p) || (majorityHome && !p.started && p.flightStatus === PositionStatus.Grid);
    const homeCount = scored.filter(isHome).length;
    const allLanded = scored.length > 0 && homeCount === scored.length;
    const startedCount = scored.filter((p) => p.started).length;
    const airborneCount = scored.filter((p) => p.flightStatus !== undefined && p.flightStatus >= PositionStatus.Airborne).length;
    const griddedCount = scored.filter((p) => p.flightStatus === PositionStatus.Grid).length;
    // 'finishing' = at least one still-flying, started pilot whose
    // distanceRemaining / taskSpeed puts them within FINISHING_ETA_MINUTES of home,
    // AND who is past the halfway point of the task — otherwise a pilot near home
    // on the first leg (or a short out-and-back AAT sample) would flip the class to F.
    const finishingCount = scored.filter((p) => {
        const fs = p.flightStatus;
        const scoreAge = now - p.t;
        if (fs === PositionStatus.Finished || fs === PositionStatus.Home || fs === PositionStatus.Landed) return false;
        if (!p.started) return false;
        if (p.distanceRemaining <= 0 || p.taskSpeed <= 0) return false;
        if (p.taskDistance <= p.distanceRemaining) return false;
        return scoreAge < FINISHING_ETA_MINUTES * 2 && (p.distanceRemaining / p.taskSpeed) * 60 < FINISHING_ETA_MINUTES;
    }).length;

    let nextStatus: string | null = null;
    let allowFrom: string[] = [];
    let reason = '';
    // Only promote to H when we can see most of the field — otherwise a class
    // with 5% tracker coverage would land as soon as those 5% touched down.
    // L and S can overwrite H so a class that all-landed and then relaunches
    // (weather hold, regrid, fresh launch) climbs back through the states.
    // If every tracked pilot has been finalised by the official scorer
    // (F/H), the class is unambiguously done — widen allowFrom so we
    // can recover from a class that never progressed past B/G in the
    // live loop (sparse tracker coverage, late OGN pickup, etc.).
    const allOfficiallyFinalised = scored.length > 0 && scored.every(isTerminalScored);
    // OGN evidence on its own can drive the widening once we've got
    // decent tracker coverage — we don't need to wait for the
    // official scorer to finalise everyone before recovering a
    // class stuck at B/G.
    const ognDeterminedHome = allLanded && trackerCoverage >= HOME_OGN_COVERAGE;

    if (allLanded && (trackerCoverage >= 0.1 || airborneCount === homeCount)) {
        nextStatus = 'H';
        allowFrom = allOfficiallyFinalised || ognDeterminedHome ? ['B', 'G', 'L', 'S', 'F'] : ['L', 'S', 'F'];
        const homeBy = allOfficiallyFinalised ? ' (officially finalised)' : ognDeterminedHome ? ' (OGN coverage)' : '';
        reason = `${homeCount}/${scored.length} of ${totalScored} tracked gliders home${homeBy}`;
    } else if (finishingCount > 0) {
        nextStatus = 'F';
        allowFrom = ['L', 'S'];
        reason = `${finishingCount}/${scored.length} tracked gliders finishing (< ${FINISHING_ETA_MINUTES} min to home)`;
    } else if (startedCount / scored.length > 0.1) {
        nextStatus = 'S';
        allowFrom = [':', '?', 'P', 'B', 'X', 'G', 'L', 'H'];
        reason = `${startedCount}/${scored.length} tracked gliders started`;
    } else if (airborneCount > Math.max(LAUNCHING_TRACKED_FRACTION * scored.length, LAUNCHING_TOTAL_FRACTION * totalScored)) {
        // Require enough of the field to be airborne before declaring 'launching'.
        // One ferry/training/test flight on a non-task day shouldn't flip the
        // whole class to 'L' — and in that situation `resetStaleCompStatus`
        // can't undo it because the row's datecode is already today's. Compare
        // against both the tracked subset (so a class with 5 trackers needs
        // ≥2 airborne, not just 1) and the full field (so a 40-pilot class
        // doesn't go 'L' on the back of 1 tracked pilot).
        nextStatus = 'L';
        allowFrom = [':', '?', 'P', 'B', 'X', 'G', 'H'];
        reason = `${airborneCount}/${scored.length} tracked gliders airborne (of ${totalScored} total)`;
    } else if (griddedCount > 0) {
        nextStatus = 'G';
        allowFrom = [':', '?', 'P', 'B', 'X'];
        reason = `${griddedCount}/${scored.length} tracked gliders on grid`;
    }

    console.log(
        `${className}: allLanded ${allLanded}, trackerCoverage ${trackerCoverage}, allOfficiallyFinalised ${allOfficiallyFinalised}, ognDeterminedHome ${ognDeterminedHome}`,
        `finishingCount: ${finishingCount}, startedCount ${startedCount}, scored.length ${scored.length}, airborneCount: ${airborneCount}, griddedCount: ${griddedCount} homeCount ${homeCount}, nextStatus ${nextStatus}/${reason}`
    );

    return nextStatus ? {status: nextStatus, allowFrom, reason} : null;
}
