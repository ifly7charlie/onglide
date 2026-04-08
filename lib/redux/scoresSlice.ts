//
// This slice maintains the deck.gl data for scores
//

import {createSlice, createAsyncThunk, createSelector} from '@reduxjs/toolkit';

import type {PayloadAction} from '@reduxjs/toolkit';

import {scoreChunkSize} from '../constants';

import {updatePilotStartTimeAction, updateClassAction, updateSortKeyAction} from './actions';

import {PilotScore, Scores, Scores_PilotsEntry} from '../protobuf/onglide';
import {ClassScoreHistory, OnglideWebSocketMessage} from '../protobuf/onglide';

//const updateScoresAction = createAction<PilotScores>('updateScores');
import {assembleLabeledLine} from '../react/distanceLine';

import type {ScoreData, Compno, Datecode, Epoch, ClassName, PilotScoreDisplay, SortKey} from '../types';

import {
    reduce as _reduce,
    forEach as _foreach,
    cloneDeep as _cloneDeep,
    find as _find,
    map as _map,
    isEqual as _isEqual,
    sortedIndex as _sortedIndex,
    sortedIndexOf as _sortedIndexOf,
    sortedIndexBy as _sortedIndexBy
} from 'lodash';

import type {RootState} from './store';

const d = (d) => new Date(d * 1000).toISOString();

type HistoricalScoreData = Record<Compno, PilotScoreDisplay[]>;
interface OptimalGridEntry {
    t: Epoch;
    currentLeg: number;
    grid: number[];
}
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
                return _reduce(
                    historical,
                    (result, scores, compno) => {
                        const index = _sortedIndexBy(scores, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
                        if (index >= 0 && scores[index]) {
                            result[compno] = scores[index];
                        }
                        return result;
                    },
                    {}
                );
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
                    return _reduce(
                        scores,
                        (prev, current, key) => {
                            prev[key] = {t: current.t, status: current.flightStatus};
                            return prev;
                        },
                        {}
                    );
                }
                return _reduce(
                    historical,
                    (result, scores, compno) => {
                        const index = _sortedIndexBy(scores, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
                        if (index >= 0) {
                            result[compno] = {t: scores[index].t, status: scores[index].flightStatus};
                        }
                        return result;
                    },
                    {}
                );
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
                    return _reduce(
                        scores ?? {},
                        (prev, current, key) => {
                            prev[key] = {startUtc: current.utcStart, finishUtc: current.utcFinish};
                            return prev;
                        },
                        {}
                    );
                }
                return _reduce(
                    historical ?? {},
                    (prev, pilotScores, key) => {
                        const index = _sortedIndexBy(pilotScores, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
                        if (index >= 0 && pilotScores[index]) {
                            prev[key] = {startUtc: pilotScores[index].utcStart, finishUtc: pilotScores[index].utcFinish};
                        }
                        return prev;
                    },
                    {}
                );
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
                const index = _sortedIndexBy(historical, {t} as unknown as PilotScoreDisplay, (x) => x.t) - 1;
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
                const index = _sortedIndexBy(entries, {t} as OptimalGridEntry, (x) => x.t) - 1;
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
        return await fetch(oldScoresUrl(className, datecode, requestChunk.toString(), state.scoreId), {signal}) //
            .then((res) => res.arrayBuffer())
            .then(async (ab) => ({data: ClassScoreHistory.decode(new Uint8Array(ab)), chunkId}))
            .catch((e) => void console.error('FOS:', e));
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
    _reduce(
        action.payload.pilots,
        (result, score: PilotScore, compno) => {
            // Extract optimal grid into separate storage (emitted once per sector entry)
            const {optimalGrid, ...scoreWithoutGrid} = score;
            if (optimalGrid?.length) {
                const entry: OptimalGridEntry = {t: score.t as Epoch, currentLeg: score.currentLeg, grid: optimalGrid};
                const gh = (state.optimalGrids[compno as Compno] ??= []);
                const gIdx = _sortedIndexBy(gh, entry, (x) => x.t);
                gh.splice(gIdx, Infinity, entry);
            }

            result[compno] = mapScoresToDisplayScores(scoreWithoutGrid as PilotScore);

            // If the scoreId is the current one then we will use that
            const sh = (state.historical[compno] ??= []);
            const index = _sortedIndexBy(sh, score, (x) => x.t);
            if (index < sh.length && index >= 0 && sh[index].t != score.t) {
                console.log(compno, '***** rewind score history to ', index, sh[index].t, d(sh[index].t));
                console.log(compno, `   ** new ${score.t} ${d(score.t)}, latest: ${sh.at(-1)?.t} ${d(sh.at(-1)?.t ?? 0)}`);
            }
            sh.splice(index, Infinity, result[compno]);

            return result;
        },
        state.scores ?? {}
    );
}

function mapScoresToDisplayScores(p: PilotScore): PilotScoreDisplay {
    return {
        ...p,
        ...(p.scoredPoints && p.scoredPoints.length > 3
            ? {
                  scoredGeoJSON: assembleLabeledLine(p.scoredPoints, p.scoringClosestPoint)
              }
            : {}),
        ...(p.minDistancePoints && p.minDistancePoints.length > 2
            ? {
                  minGeoJSON: assembleLabeledLine(p.minDistancePoints)
              }
            : {}),
        ...(p.maxDistancePoints && p.maxDistancePoints.length > 2
            ? {
                  maxGeoJSON: assembleLabeledLine(p.maxDistancePoints)
              }
            : {}),
        ...(p.suggestedTrackPoints && p.suggestedTrackPoints.length > 7
            ? {
                  suggestedGeoJSON: assembleLabeledLine(p.suggestedTrackPoints)
              }
            : {})
        /*        ...(p.taskGeoJSON
            ? {
                  taskGeoJSON: JSON.parse(p.taskGeoJSON)
              }
            : {}) */
    };
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

        // List of the newly received times, we need to remove existing ones from our data so any
        // that are not in the
        const newIndicies = newScores.map((scoreHistoryMessage) => scoreHistoryMessage.t as Epoch);
        const oldIndicies = oldScores?.map((psd) => psd.t as Epoch) ?? [];

        const resultIndex: Epoch[] = [];
        const resultScores: PilotScoreDisplay[] = [];

        let oldIndex = 0;
        let newIndex = 0;
        while (oldIndex < oldIndicies.length || newIndex < newIndicies.length) {
            const o = oldIndicies.at(oldIndex);
            const n = newIndicies.at(newIndex);

            if (o && (!n || o <= n)) {
                // end of new, or old is older
                resultIndex.push(o);
                resultScores.push(oldScores.at(oldIndex));
                oldIndex++;
                if (o == n) {
                    newIndex++;
                }
            } else if (!o || n! < o) {
                // end of old or new is older
                const ns = newScores.at(newIndex);
                // take from the new score if it's there, otherwise it's a reference to one we have decoded
                // so use that instead
                resultScores.push(mapScoresToDisplayScores(ns!));
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
