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

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex, sortedIndexOf as _sortedIndexOf} from 'lodash';

import type {RootState} from './store';

const d = (d) => new Date(d * 1000).toISOString();

interface ScoresSliceState {
    className: ClassName;
    scores: ScoreData;
    historical: {
        scores: ScoreData[];
        index: Epoch[]; // paired arrays
        loading: Record<Epoch, string>; // request id for requests to load - we only remove on error (so it retries) otherwise
        // leave the ID in the structure so we don't keep trying to get missing scores
    };
}

// Define the initial state using that type
const initialState: ScoresSliceState = {
    className: '' as ClassName,
    scores: {},
    historical: {
        scores: [],
        index: [],
        loading: {}
    }
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
        builder.addCase(updateClassAction, (state, {payload: {className}}) => {
            if (className != state.className && state.className) {
                return {
                    className: className as ClassName,
                    scores: {},
                    historical: {
                        scores: [],
                        index: [],
                        loading: {}
                    }
                };
            }
        });

        builder.addCase(fetchOldScores.fulfilled, (state, action) => {
            _updateOldScores(state, {payload: action.payload, type: action.type});
        });

        builder.addCase(fetchOldScores.pending, (state, {meta}) => {
            const {t, now} = meta.arg;
            if (!state.historical.loading[getChunk(t, now).toString()]) {
                state.historical.loading[getChunk(t, now).toString()] = meta.requestId;
            }
        });

        builder.addCase(fetchOldScores.rejected, (state, {meta}) => {
            const {t, now} = meta.arg;
            delete state.historical.loading[getChunk(t, now).toString()];
        });
    },
    selectors: {
        selectReplayAvailable: (state) => (state.historical.scores?.length ?? 0) > 0,
        selectAllScores: createSelector(
            [
                //
                (_state: ScoresSliceState, t: Epoch | undefined) => t,
                (state: ScoresSliceState, t: Epoch | undefined) => {
                    const index = t ? _sortedIndex(state.historical.index, t) : -1;
                    return index >= state.historical.index.length ? state.historical.index.length - 1 : index;
                },
                (state: ScoresSliceState) => state
            ],
            (_t: Epoch | undefined, index, state) => {
                const score = index >= 0 ? state.historical.scores[index] : state.scores;
                return score;
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
                (state: ScoresSliceState, t: Epoch | undefined) => {
                    const index = t ? _sortedIndex(state.historical.index, t) : -1;
                    return index >= state.historical.index.length ? state.historical.index.length - 1 : index;
                },
                (state: ScoresSliceState) => state
            ],
            (_t: Epoch | undefined, index, state) => {
                const score = index >= 0 ? state.historical.scores[index] : state.scores;
                return score
                    ? _reduce(
                          score,
                          (prev, current, key) => {
                              prev[key] = {t: current.t, status: current.flightStatus};
                              return prev;
                          },
                          {}
                      )
                    : undefined;
            }
            /*    {
                memoizeOptions: {
                    resultEqualityCheck
                }
            } */
        ),
        selectPilotScore: createSelector(
            [
                //
                (_state: ScoresSliceState, _compno: Compno | undefined, t: Epoch | undefined) => t,
                (_state: ScoresSliceState, compno: Compno | undefined, _t: Epoch | undefined) => compno,
                (state: ScoresSliceState, _compno: Compno | undefined, t: Epoch | undefined) => {
                    const index = t && state.historical.index.length ? _sortedIndex(state.historical.index, t) : -1;
                    if (index >= state.historical.index.length) {
                        return state.historical.index.length - 1;
                    }
                    return index;
                },
                (state: ScoresSliceState) => state
            ],
            (_t: Epoch | undefined, compno, index, state) => {
                if (!compno) {
                    return undefined;
                }
                const score = index >= 0 ? state.historical.scores[index] : state.scores;
                return score ? score[compno] : undefined;
            },
            {
                //                memoizeOptions: {
                //                    resultEqualityCheck: (a, b) => a?.t === b?.t // t is enough for a unique time
                //                }
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

export const fetchOldScores = createAsyncThunk<{data: ClassScoreHistory}, {t: Epoch; now: Epoch; className: ClassName; datecode: Datecode}>(
    'scores/fetchOldScores', //
    async ({t, datecode, now, className}, {signal, getState, requestId}) => {
        const state = (getState() as RootState).scores;
        const index = state.historical.index.length ? _sortedIndex(state.historical.index, t) - 1 : -1;
        console.log('FOS: index', index, index >= 0 && index < state.historical.index.length ? d(state.historical.index.at(index)) : '-notfound-', d(t));

        // Before, after or in the middle and missing
        if (index == -1 || index >= state.historical.index.length || Math.abs(t - state.historical.index.at(index)) > 61) {
            const requestChunk = getChunk(t, now);
            if (state.historical.loading[requestChunk.toString()] != requestId) {
                console.log('FOS chunk already requested', d(requestChunk), state.historical.loading[requestChunk.toString()]);
                return;
            }
            console.log('FOS requesting chunk', d(requestChunk), state.historical.loading[requestChunk.toString()]);

            return await fetch(oldScoresUrl(className, datecode, requestChunk.toString()), {signal}) //
                .then((res) => res.arrayBuffer())
                .then((res) => {
                    console.log('FOS: got data', d(requestChunk), res.byteLength);
                    return res;
                })
                .then(async (ab) => ({data: ClassScoreHistory.decode(new Uint8Array(ab))}))
                .catch((e) => void console.error('FOS:', e));
        }
    }
);

export default scoresSlice.reducer;
export const {updateScores} = scoresSlice.actions;
export const {selectReplayAvailable, selectAllScores, selectPilotScore, selectAllStatus} = scoresSlice.selectors;

//////////////////////////////////////////
// Logic for updates
//////////////////////////////////////////

function _updateScores(state: ScoresSliceState, action: PayloadAction<Scores>) {
    geoJSONFixup(action.payload.pilots, state.scores);
}

function geoJSONFixup(scores: Scores['pilots'], previousScores?: ScoreData): ScoreData {
    return _reduce(
        scores,
        (result, p: PilotScore, compno) => {
            result[compno] = mapScoresToDisplayScores(p);
            return result;
        },
        previousScores ?? {}
    );
}

function mapScoresToDisplayScores(p: PilotScore): PilotScoreDisplay {
    return {
        ...p,
        ...(p.scoredPoints && p.scoredPoints.length > 3
            ? {
                  scoredGeoJSON: assembleLabeledLine(p.scoredPoints)
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
        ...(p.taskGeoJSON
            ? {
                  taskGeoJSON: JSON.parse(p.taskGeoJSON)
              }
            : {})
    };
}

function _updateOldScores(state: ScoresSliceState, action: PayloadAction<{data: ClassScoreHistory}>) {
    if (!action.payload?.data?.history?.length) {
        return;
    }

    // List of the newly received times, we need to remove existing ones from our data so any
    // that are not in the
    const newIndicies = action.payload.data.history.map((scoreHistoryMessage) => scoreHistoryMessage.t as Epoch);
    const oldIndicies = state.historical.index;
    const newScores = action.payload.data.history;
    const oldScores = state.historical.scores;

    console.log('received new score times', newIndicies.map(d).join(','));

    const resultIndex = [];
    const resultScores = [];

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
        } else if (!o || n < o) {
            // end of old or new is older
            const ns = newScores.at(newIndex);
            // take from the new score if it's there, otherwise it's a reference to one we have decoded
            // so use that instead
            if (ns.scoreMessage) {
                resultScores.push(geoJSONFixup(OnglideWebSocketMessage.decode(newScores.at(newIndex).scoreMessage).scores.pilots));
            } else {
                const index = _sortedIndexOf(resultIndex, ns.sameAsT);
                if (index != -1) {
                    resultScores.push(resultScores[index]);
                } else {
                    console.log(`FOS: unable to find referenced score index ${d(ns.sameAsT)} ${ns.sameAsT} in existing results while evaluating n=${d(n)}@${newIndex}`);
                }
            }
            resultIndex.push(n);

            newIndex++;
        }
    }

    if (state.historical.index.join(',') == resultIndex.join(',')) {
        console.log('no change! why did you fetch');
    } else {
        state.historical.index = resultIndex;
        state.historical.scores = resultScores;
        console.log(`FOS: result: ${resultIndex.length} idents, newIndicies ${newIndicies.length} & oldIndicies ${oldIndicies.length}`);
        console.log('FOS:', resultIndex, resultScores);
    }
}
