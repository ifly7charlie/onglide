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

    // Task distance flown changed by more than the proximity-scaled threshold.
    // Gate on taskDistance (the cumulative whole-task total the UI shows) —
    // actual.distance is the per-leg increment and is never populated on the
    // task-level summary, so reading it here would compare 0-0 and never fire.
    //
    // The threshold shrinks as the pilot nears the next turnpoint, so the score
    // (and the displayed position rounding the turn) refreshes more often there:
    // full 1.5km while >9km out on the leg, easing linearly down to a 0.5km floor
    // at the turn. distToTurn is the current leg's remaining distance (current
    // point -> next turnpoint, in km, same source as taskDistance); when it isn't
    // populated (e.g. sitting in-sector, where inSector already gates) it defaults
    // to the flat 1.5km.
    const distToTurn = newScore.legs?.[newScore.currentLeg]?.actual?.distanceRemaining ?? Infinity;
    const distanceThreshold = Math.min(1.5, Math.max(0.5, distToTurn / 6));
    if (Math.abs((oa.taskDistance ?? 0) - (na.taskDistance ?? 0)) > distanceThreshold) {
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
