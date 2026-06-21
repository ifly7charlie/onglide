import {PilotScore} from '../protobuf/onglide';

//
// Compare two scores. Returns true when the new score is materially different
// from the old. Used in two places:
//   - scoreCollector (worker): pass checkActual=true so any positional movement
//     in actual{} counts as a change — the front end should never sit on stale
//     taskDistance.
//   - sendScore history splice (main): pass checkActual=false so a stream of
//     positional drifts within the same leg collapses into the scoreFrequency
//     window; only state transitions land a row.
//
export function scoreChanged(oldScore: PilotScore | undefined, newScore: PilotScore | undefined, checkActual: boolean): boolean {
    if (!oldScore || !newScore) {
        return !oldScore !== !newScore; // both undefined or defined
    }

    // If we have switched from replay
    if (oldScore.live !== newScore.live) {
        return true;
    }

    // If the timestamp is the same then nothing has changed
    if (oldScore.t === newScore.t) {
        return false;
    }

    // If the start time is different then it must have changed
    if (oldScore.utcStart !== newScore.utcStart) {
        return true;
    }

    // Finish detection or refinement
    if (oldScore.utcFinish !== newScore.utcFinish) {
        return true;
    }

    // Sector advancement, AAT re-entries, racing leg transitions
    if (oldScore.currentLeg !== newScore.currentLeg) {
        return true;
    }
    if (oldScore.inSector !== newScore.inSector || oldScore.inPenalty !== newScore.inPenalty) {
        return true;
    }

    // Flight status transition (grid / airborne / landed / home / finished)
    if (oldScore.flightStatus != newScore.flightStatus) {
        return true;
    }

    // If we haven't started then all we care about is flight status
    if (!newScore.utcStart) {
        return false;
    }

    // Already finished; nothing after finish matters
    if (oldScore.utcFinish) {
        return false;
    }

    if (!checkActual) {
        return true;
    }

    const oa = oldScore.actual;
    const na = newScore.actual;

    // Makew sure we have both, if one is missing it's changed
    if (!oa || !na) {
        return oa !== na;
    }

    // moved more than 1.5km
    if (Math.abs((oa.distance ?? 0) - (na.distance ?? 0)) > 1.5) {
        return true;
    }

    // Speed changed by more than 1.5kph
    if (Math.abs((oa.taskSpeed ?? 0) - (na.taskSpeed ?? 0)) > 1.5) {
        return true;
    }

    // ld change of 3 or more don't want it to change too often in a good climb
    if (Math.abs((oa.grRemaining ?? 0) - (na.grRemaining ?? 0)) > 2) {
        return true;
    }

    return false;
}

//
// True when the flight-statistics segment set changed between two scores — a new
// thermal/straight/gap segment was finalised (or a rescore reset them). A segment
// boundary is a meaningful flight event in its own right, so the scoreCollector
// treats it as a reason to emit even when no core score field moved. This matters
// most pre-start: scoreChanged short-circuits to false before utcStart, so a glider
// soaring through the pre-start window would otherwise post no scores and its
// thermal/wind segments would never reach the front end. Both scores must be
// full-stats (the flightStatistics attacher decorates every tick) for the length
// comparison to be a valid segment count.
export function statsChanged(oldScore: PilotScore | undefined, newScore: PilotScore | undefined): boolean {
    return (oldScore?.stats?.segments?.length ?? 0) !== (newScore?.stats?.segments?.length ?? 0);
}
