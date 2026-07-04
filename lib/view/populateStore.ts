import type {Epoch, ClassName, Datecode, Compno, PositionMessage} from '../types';
import type {PilotScore, PilotTracks, Scores, Stats} from '../protobuf/onglide';
import type {AppDispatch} from '../redux/store';

import {updateClassAction} from '../redux/actions';
import {updateTask} from '../redux/taskSlice';
import {loadTracks} from '../redux/tracksSlice';
import {updateScores, setPilotStats} from '../redux/scoresSlice';

const SCORE_ID = 'igc-view';
const CLASS_NAME = 'View' as ClassName;
const DATECODE = 'view' as Datecode;

export function dispatchClass(dispatch: AppDispatch, earliestScore: Epoch, latestScore: Epoch, reset?: boolean) {
    if (reset) {
        // Use a temporary datecode to force all slices to clear their state
        dispatch(
            updateClassAction({
                className: CLASS_NAME,
                datecode: ('reset-' + Date.now()) as Datecode,
                competition: 'IGC Viewer',
                earliestScore: earliestScore as number,
                latestScore: latestScore as number,
                scoreId: SCORE_ID,
                t: latestScore
            })
        );
    }
    dispatch(
        updateClassAction({
            className: CLASS_NAME,
            datecode: DATECODE,
            competition: 'IGC Viewer',
            earliestScore: earliestScore as number,
            latestScore: latestScore as number,
            scoreId: SCORE_ID,
            t: latestScore
        })
    );
}

export function dispatchTask(dispatch: AppDispatch, task: any, geoJSON: any) {
    // Shallow-copy rules/details: Redux Toolkit (Immer) deep-freezes whatever is
    // stored in state. The caller keeps a live reference to this same task object
    // and mutates task.rules.handicapped / task.details.handicapped on (re)score,
    // so the stored copy must not alias the working object.
    dispatch(
        updateTask({
            rules: {...task.rules},
            details: {...task.details},
            legs: task.legs,
            geoJSON: JSON.stringify(geoJSON),
            startOpen: false
        })
    );
}

export function dispatchTrack(dispatch: AppDispatch, compno: Compno, name: string, fixes: PositionMessage[]) {
    if (!fixes.length) return;

    const count = fixes.length;

    // Build typed arrays matching PilotTrack protobuf format
    // These are Uint8Array wrappers around the actual typed arrays
    const positions = new Float32Array(count * 3);
    const t = new Uint32Array(count);
    const climbRate = new Int8Array(count);
    const agl = new Int16Array(count);

    let prevAlt = fixes[0].a;
    let prevT = fixes[0].t;

    for (let i = 0; i < count; i++) {
        const fix = fixes[i];
        positions[i * 3] = fix.lng;
        positions[i * 3 + 1] = fix.lat;
        positions[i * 3 + 2] = fix.a;
        t[i] = fix.t;
        agl[i] = fix.g;

        // Estimate climb rate in m/s, clamped to int8 range
        const dt = fix.t - prevT;
        if (dt > 0) {
            const cr = Math.round((fix.a - prevAlt) / dt);
            climbRate[i] = Math.max(-128, Math.min(127, cr));
        }
        prevAlt = fix.a;
        prevT = fix.t;
    }

    // Wrap as Uint8Array (PilotTrack protobuf format)
    const pilotTrack = {
        compno: compno as string,
        posIndex: count,
        t: new Uint8Array(t.buffer),
        positions: new Uint8Array(positions.buffer),
        climbRate: new Uint8Array(climbRate.buffer),
        agl: new Uint8Array(agl.buffer),
        trackVersion: Date.now()
    };

    const tracks: PilotTracks = {
        pilots: {[compno]: pilotTrack},
        baseTime: fixes[0].t
    };

    dispatch(loadTracks(tracks));
}

export function dispatchScores(dispatch: AppDispatch, scores: PilotScore[]) {
    if (!scores.length) return;

    // Dispatch each score to build up the historical record for replay
    for (const score of scores) {
        const payload: Scores = {
            scoreId: SCORE_ID,
            pilots: {[score.compno]: score}
        };
        dispatch(updateScores(payload));
    }
}

// Local IGC scorer produces the full segment list for the flight; replace the
// pilot's accumulator outright (the stats websocket plane is daemon-only).
export function dispatchPilotStats(dispatch: AppDispatch, compno: Compno, stats: Stats | undefined) {
    if (!stats?.segments?.length) return;
    dispatch(setPilotStats({compno, segments: stats.segments}));
}

export function dispatchTimeRange(dispatch: AppDispatch, earliestScore: Epoch, latestScore: Epoch) {
    // Re-dispatch updateClassAction to update the time range (for replay slider)
    dispatch(
        updateClassAction({
            className: CLASS_NAME,
            datecode: DATECODE,
            competition: 'IGC Viewer',
            earliestScore: earliestScore as number,
            latestScore: latestScore as number,
            scoreId: SCORE_ID,
            t: latestScore
        })
    );
}
