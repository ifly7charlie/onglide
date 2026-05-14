//
// This slice maintains the deck.gl data for scores
//

import {createSlice, createAsyncThunk, createSelector, original} from '@reduxjs/toolkit';

import type {PayloadAction} from '@reduxjs/toolkit';

import {scoreChunkSize} from '../constants';

import {updatePilotStartTimeAction, updateClassAction, updateSortKeyAction} from './actions';

import {PilotScore, Scores, Scores_PilotsEntry} from '../protobuf/onglide';
import {ClassScoreHistory, OnglideWebSocketMessage} from '../protobuf/onglide';

//const updateScoresAction = createAction<PilotScores>('updateScores');
import {assembleLabeledLine} from '../react/distanceLine';

import type {ScoreData, Compno, Datecode, Epoch, ClassName, PilotScoreDisplay, SortKey, OptimalGridEntry} from '../types';

import {sortedIndexBy} from '../util/binarySearch';

import type {RootState} from './store';

const d = (d) => new Date(d * 1000).toISOString();

type HistoricalScoreData = Record<Compno, PilotScoreDisplay[]>;
interface ScoresSliceState {
    className: ClassName;
    scores: ScoreData;
    historical: HistoricalScoreData;
    optimalGrids: Record<Compno, OptimalGridEntry[]>;
    loading: Record<Epoch, string>; // request id for requests to load - we only remove on error (so it retries) otherwise
    scoreId: string; //  copy of track version set when loading something
    // leave the ID in the structure so we don't keep trying to get missing scores
}

// Define the initial state using that type
const initialState: ScoresSliceState = {
    className: '' as ClassName,
    scores: {},
    historical: {},
    optimalGrids: {},
    loading: {},
    scoreId: ''
};

// Find the old scores
import {oldScoresUrl} from '../react/fixupUrls';

export const scoresSlice = createSlice({
    name: 'scores',
    // `createSlice` will infer the state type from the `initialState` argument
    initialState,
    reducers: {
        updateScores: _updateScores
    },
    extraReducers: (builder) => {
        //
        // New class, needs to reset everything
        builder.addCase(updateClassAction, (state, {payload: {className, scoreId}}) => {
            if (className != state.className) {
                return {
                    className: className as ClassName,
                    scores: {},
                    historical: {},
                    optimalGrids: {},
                    loading: {},
                    scoreId
                };
            }
            // If the score id has changed then we need to reset everything historical
            if (state.scoreId != scoreId) {
                console.log(`update scoreId ${state.scoreId} => ${scoreId}`);
                state.loading = {};
                state.scoreId = scoreId;
                state.historical = {};
            }
        });

        builder.addCase(fetchOldScores.fulfilled, (state, action) => {
            _updateOldScores(state, {payload: action.payload, type: action.type});
        });

        builder.addCase(fetchOldScores.pending, (state, {meta}) => {
            const {t, now} = meta.arg;
            if (!state.loading[getChunk(t, now).toString()]) {
                state.loading[getChunk(t, now).toString()] = meta.requestId;
            }
        });

        builder.addCase(fetchOldScores.rejected, (state, {meta}) => {
            const {t, now} = meta.arg;
            delete state.loading[getChunk(t, now).toString()];
        });
    },
    selectors: {
        selectReplayAvailable: (state) => Object.keys(state.historical).length > 0,
        selectAllScores: createSelector(
            [
                //
                (_state: ScoresSliceState, t: Epoch | undefined) => t,
                (state: ScoresSliceState, t: Epoch | undefined) => (t ? null : state.scores),
                (state: ScoresSliceState, t: Epoch | undefined) => (t ? state.historical : null)
            ],
            (t: Epoch | undefined, scores: ScoreData | null, historical: HistoricalScoreData | null) => {
                if (!t) {
                    return scores;
                }
                const result: Record<string, PilotScoreDisplay> = {};
                for (const compno in historical!) {
                    const scores = historical![compno];
                    const index = sortedIndexBy(scores, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
                    if (index >= 0 && scores[index]) {
                        result[compno] = scores[index];
                    }
                }
                return result;
            }
            /*            {
                memoizeOptions: {
                    resultEqualityCheck
                }
            } */
        ),
        selectAllStatus: createSelector(
            [
                //
                (_state: ScoresSliceState, t: Epoch | undefined) => t,
                (state: ScoresSliceState, t: Epoch | undefined) => (t ? null : state.scores),
                (state: ScoresSliceState, t: Epoch | undefined) => (t ? state.historical : null)
            ],
            (t: Epoch | undefined, scores: ScoreData | null, historical: HistoricalScoreData | null) => {
                if (!t) {
                    const prev: Record<string, {t: number; status: number}> = {};
                    for (const key in scores!) {
                        const current = scores![key];
                        prev[key] = {t: current.t, status: current.flightStatus};
                    }
                    return prev;
                }
                const result: Record<string, {t: number; status: number}> = {};
                for (const compno in historical!) {
                    const histScores = historical![compno];
                    const index = sortedIndexBy(histScores, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
                    if (index >= 0) {
                        result[compno] = {t: histScores[index].t, status: histScores[index].flightStatus};
                    }
                }
                return result;
            }
            /*    {
                memoizeOptions: {
                    resultEqualityCheck
                }
            } */
        ),
        selectAllTimes: createSelector(
            [
                (_state: ScoresSliceState, t: Epoch | undefined) => t,
                (state: ScoresSliceState, t: Epoch | undefined) => (t ? null : state.scores),
                (state: ScoresSliceState, t: Epoch | undefined) => (t ? state.historical : null)
            ],
            (t: Epoch | undefined, scores: ScoreData | null, historical: HistoricalScoreData | null) => {
                if (!t) {
                    const prev: Record<string, {startUtc: number; finishUtc: number}> = {};
                    for (const key in scores ?? {}) {
                        const current = scores![key];
                        prev[key] = {startUtc: current.utcStart, finishUtc: current.utcFinish};
                    }
                    return prev;
                }
                const prev: Record<string, {startUtc: number; finishUtc: number}> = {};
                for (const key in historical ?? {}) {
                    const pilotScores = historical![key];
                    const index = sortedIndexBy(pilotScores, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
                    if (index >= 0 && pilotScores[index]) {
                        prev[key] = {startUtc: pilotScores[index].utcStart, finishUtc: pilotScores[index].utcFinish};
                    }
                }
                return prev;
            }
        ),
        selectPilotScore: createSelector(
            [
                //
                (_state: ScoresSliceState, _compno: Compno | undefined, t: Epoch | undefined) => t,
                (_state: ScoresSliceState, compno: Compno | undefined, _t: Epoch | undefined) => compno,
                (state: ScoresSliceState, compno: Compno | undefined, t: Epoch | undefined) => (t ? null : state.scores[compno]),
                (state: ScoresSliceState, compno: Compno | undefined, t: Epoch | undefined) => (t ? state.historical[compno] : null)
            ],
            (t: Epoch | undefined, compno: Compno | undefined, score: PilotScoreDisplay | null | undefined, historical: PilotScoreDisplay[] | undefined | null) => {
                if (!compno) {
                    return undefined;
                }
                if (score) {
                    return score;
                }
                if (!historical) {
                    return undefined;
                }
                const index = sortedIndexBy(historical, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
                return index >= 0 ? historical[index] : undefined;
            },
            {
                memoizeOptions: {
                    resultEqualityCheck: (a, b) => a?.t === b?.t
                }
            }
        ),
        selectOptimalGrid: createSelector(
            [
                (_state: ScoresSliceState, _compno: Compno | undefined, t: Epoch | undefined) => t,
                (_state: ScoresSliceState, compno: Compno | undefined) => compno,
                (state: ScoresSliceState, compno: Compno | undefined) => (compno ? state.optimalGrids[compno] : undefined)
            ],
            (t: Epoch | undefined, compno: Compno | undefined, entries: OptimalGridEntry[] | undefined) => {
                if (!compno || !entries?.length) return undefined;
                if (!t) return entries.at(-1);
                const index = sortedIndexBy(entries, {t} as OptimalGridEntry, (x) => x.t) - 1;
                return index >= 0 ? entries[index] : undefined;
            },
            {
                memoizeOptions: {
                    resultEqualityCheck: (a, b) => a?.t === b?.t
                }
            }
        )
    }
});

function getChunk(t: Epoch, now: Epoch) {
    const chunkStart = t - (t % scoreChunkSize); // 30 minute chunks
    const nowChunkStart = now - (now % scoreChunkSize); // 30 minute chunks

    return nowChunkStart == chunkStart // request for time inside current partial chunk don't cache
        ? now
        : chunkStart + scoreChunkSize - 1; // one second before this chunk finishes, filter includes this time on server end
}

function isCurrentChunk(t: Epoch, now: Epoch) {
    const chunkStart = t - (t % scoreChunkSize); // 30 minute chunks
    const nowChunkStart = now - (now % scoreChunkSize); // 30 minute chunks

    return nowChunkStart == chunkStart; // request for time inside current partial chunk don't cache
}

function getPreviousChunk(t: Epoch) {
    return t - (t % scoreChunkSize) - 1; // 30 minute chunks
}

export const fetchOldScores = createAsyncThunk<{data: ClassScoreHistory}, {t: Epoch; now: Epoch; className: ClassName; datecode: Datecode}>(
    'scores/fetchOldScores', //
    async ({t, datecode, now, className}, {signal, getState, requestId}) => {
        const state = (getState() as RootState).scores;
        const onlineStart = (getState() as RootState).now.onlineStart;

        // Before, after or in the middle and missing
        const requestChunk = getChunk(t, now);
        const chunkId = requestChunk.toString();
        if (state.loading[chunkId] != requestId) {
            return;
        }

        if (isCurrentChunk(t, now)) {
            const previous = getPreviousChunk(t);
            if (previous > onlineStart) {
                return;
            }
        }
        const url = oldScoresUrl(className, datecode, requestChunk.toString(), state.scoreId);
        const MAX_RETRIES = 10;
        for (let attempt = 0; attempt < MAX_RETRIES && !signal.aborted; attempt++) {
            try {
                const res = await fetch(url, {signal});
                if (res.ok) {
                    const ab = await res.arrayBuffer();
                    return {data: ClassScoreHistory.decode(new Uint8Array(ab)), chunkId};
                }
                // 503 = daemon's not ready, retry; anything else, give up
                if (res.status !== 503) {
                    return;
                }
                const retryAfter = Math.max(1, parseInt(res.headers.get('Retry-After') ?? '2', 10));
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, retryAfter * 1000);
                    signal.addEventListener(
                        'abort',
                        () => {
                            clearTimeout(timer);
                            reject(signal.reason);
                        },
                        {once: true}
                    );
                });
            } catch (e) {
                console.error('FOS:', e);
                return;
            }
        }
    }
);

export default scoresSlice.reducer;
export const {updateScores} = scoresSlice.actions;
export const {selectReplayAvailable, selectAllScores, selectAllTimes, selectPilotScore, selectAllStatus, selectOptimalGrid} = scoresSlice.selectors;

//////////////////////////////////////////
// Logic for updates
//////////////////////////////////////////

function _updateScores(state: ScoresSliceState, action: PayloadAction<Scores>) {
    if (Object.keys(action.payload.pilots).length > 1) {
        console.log(`updateScores live: ${state.scoreId}, received: ${action.payload.scoreId}, ${Object.keys(action.payload.pilots).join(',')}`);
    }
    if (action.payload.scoreId != state.scoreId) {
        return;
    }
    const result = state.scores ?? {};
    for (const compno in action.payload.pilots) {
        const score: PilotScore = action.payload.pilots[compno];
        // Extract optimal grid into separate storage (emitted once per sector entry)
        const {optimalGrid, ...scoreWithoutGrid} = score;
        if (optimalGrid?.length) {
            const entry: OptimalGridEntry = {t: score.t as Epoch, currentLeg: score.currentLeg, grid: optimalGrid};
            const gh = (state.optimalGrids[compno as Compno] ??= []);
            const gIdx = sortedIndexBy(gh, entry, (x) => x.t);
            gh.splice(gIdx, Infinity, entry);
        }

        // Read the prior display score via original() so we get the plain
        // pre-draft value — passing an Immer draft as prev risks smuggling
        // draft references into the new object.
        const prev = result[compno] ? (original(result[compno]) as PilotScoreDisplay | undefined) : undefined;
        result[compno] = mapScoresToDisplayScores(prev, scoreWithoutGrid as PilotScore);

        // If the scoreId is the current one then we will use that
        const sh = (state.historical[compno] ??= []);
        const index = sortedIndexBy(sh, score, (x) => x.t);
        if (index < sh.length && index >= 0 && sh[index].t != score.t) {
            console.log(compno, '***** rewind score history to ', index, sh[index].t, d(sh[index].t));
            console.log(compno, `   ** new ${score.t} ${d(score.t)}, latest: ${sh.at(-1)?.t} ${d(sh.at(-1)?.t ?? 0)}`);
        }
        sh.splice(index, Infinity, result[compno]);
    }
}

function sameNumberArray(a: number[] | undefined, b: number[] | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// Reducer-shaped: takes the previously-displayed score for this pilot plus the
// incoming raw score and returns a new display score. `prev` must be a plain
// pre-draft value (see original() at the call site). When the underlying point
// arrays are content-identical to `prev`, the prior FeatureCollection
// references are reused so mapbox's <Source data> ref stays stable and tiles
// don't reparse on a tick that emitted an identical path.
function mapScoresToDisplayScores(prev: PilotScoreDisplay | undefined, p: PilotScore): PilotScoreDisplay {
    const result: PilotScoreDisplay = {...p};

    if (p?.scoredPoints && p.scoredPoints.length > 3) {
        if (prev?.scoredGeoJSON && sameNumberArray(p.scoredPoints, prev.scoredPoints) && prev.scoringClosestPoint?.lat === p.scoringClosestPoint?.lat && prev.scoringClosestPoint?.lng === p.scoringClosestPoint?.lng) {
            result.scoredGeoJSON = prev.scoredGeoJSON;
        } else {
            result.scoredGeoJSON = assembleLabeledLine(p.scoredPoints, p.scoringClosestPoint);
        }
    }
    if (p?.minDistancePoints && p.minDistancePoints.length > 2) {
        result.minGeoJSON = prev?.minGeoJSON && sameNumberArray(p.minDistancePoints, prev.minDistancePoints) ? prev.minGeoJSON : assembleLabeledLine(p.minDistancePoints);
    }
    if (p?.maxDistancePoints && p.maxDistancePoints.length > 2) {
        result.maxGeoJSON = prev?.maxGeoJSON && sameNumberArray(p.maxDistancePoints, prev.maxDistancePoints) ? prev.maxGeoJSON : assembleLabeledLine(p.maxDistancePoints);
    }
    if (p?.suggestedTrackPoints && p.suggestedTrackPoints.length > 7) {
        result.suggestedGeoJSON = prev?.suggestedGeoJSON && sameNumberArray(p.suggestedTrackPoints, prev.suggestedTrackPoints) ? prev.suggestedGeoJSON : assembleLabeledLine(p.suggestedTrackPoints);
    }

    return result;
}

function _updateOldScores(state: ScoresSliceState, action: PayloadAction<{data: ClassScoreHistory}>) {
    //
    const pilots = action.payload?.data?.pilots;
    if (!pilots) {
        // no scores fetched
        return;
    }

    for (const compno in pilots) {
        const newScores = pilots[compno].history;
        const oldScores = state.historical[compno];

        if (!newScores) {
            continue;
        }

        // Pull any optimalGrid carried in this chunk into the dedicated store. The /scorehistory
        // endpoint backfills the active grid onto the first record per pilot (plus mid-chunk leg
        // transitions still carry their own), so this is at most a handful of entries. Use a
        // sorted insert/replace rather than the splice-Infinity rewind used by _updateScores —
        // older chunks must not drop later-loaded grids from the tail.
        for (const ns of newScores) {
            if (!ns.optimalGrid?.length) continue;
            const entry: OptimalGridEntry = {t: ns.t as Epoch, currentLeg: ns.currentLeg, grid: ns.optimalGrid};
            const gh = (state.optimalGrids[compno as Compno] ??= []);
            const gIdx = sortedIndexBy(gh, entry, (x) => x.t);
            if (gh[gIdx]?.t === entry.t) {
                gh[gIdx] = entry;
            } else {
                gh.splice(gIdx, 0, entry);
            }
        }

        // List of the newly received times, we need to remove existing ones from our data so any
        // that are not in the
        const newIndicies = newScores.map((scoreHistoryMessage) => scoreHistoryMessage.t as Epoch);
        const oldIndicies = oldScores?.map((psd) => psd.t as Epoch) ?? [];

        const resultIndex: Epoch[] = [];
        const resultScores: PilotScoreDisplay[] = [];

        let oldIndex = 0;
        let newIndex = 0;
        while (oldIndex < oldIndicies.length || newIndex < newIndicies.length) {
            // Distinguish "ran off the end" from "value is falsy". A pilot with no
            // tracker / blocked tracker is stored with t === 0 so the live list still
            // shows them, and a previous version of this loop that gated on `o &&`
            // spun forever for that compno because oldIndex never advanced past 0.
            const oOk = oldIndex < oldIndicies.length;
            const nOk = newIndex < newIndicies.length;
            const o = oOk ? oldIndicies[oldIndex] : undefined;
            const n = nOk ? newIndicies[newIndex] : undefined;

            if (oOk && (!nOk || o! <= n!)) {
                // end of new, or old is older
                resultIndex.push(o!);
                resultScores.push(oldScores.at(oldIndex)!);
                oldIndex++;
                if (o === n) {
                    newIndex++;
                }
            } else {
                // end of old or new is older — take from the new score
                const ns = newScores.at(newIndex)!;
                resultScores.push(mapScoresToDisplayScores(resultScores.at(-1), ns));
                resultIndex.push(n!);
                newIndex++;
            }
        }

        if (resultIndex.join(',') != resultIndex.sort().join(',')) {
            console.log(compno, ' FOS: out of order');
        }
        if (oldIndicies.join(',') != resultIndex.join(',')) {
            state.historical[compno] = resultScores;
        }
    }
}
