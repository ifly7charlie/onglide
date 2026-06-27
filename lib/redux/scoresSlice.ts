//
// This slice maintains the deck.gl data for scores
//

import {createSlice, createAsyncThunk, createSelector, original} from '@reduxjs/toolkit';

import type {PayloadAction} from '@reduxjs/toolkit';

import {scoreChunkSize} from '../constants';

import {updatePilotStartTimeAction, updateClassAction, updateSortKeyAction} from './actions';

import {PilotScore, Scores, Scores_PilotsEntry, StatSegment} from '../protobuf/onglide';
import {ClassScoreHistory, OnglideWebSocketMessage, PilotStatsUpdate} from '../protobuf/onglide';
import {unscaleClassScoreHistoryFromWire, unscaleFromWire} from '../protobuf/wireScaling';

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
    pilotStats: Record<Compno, StatSegment[]>;
    // Per-pilot trackVersion the accumulator was last (re)built at. A change means
    // the deck was rebuilt (tracker change / new position lineage) — rebuild the
    // segment list from the incoming full set rather than merging onto stale data.
    pilotStatsTrackVersion: Record<Compno, number>;
    loading: Record<Epoch, string>; // request id for requests to load - we only remove on error (so it retries) otherwise
    scoreId: string; //  copy of track version set when loading something
    // leave the ID in the structure so we don't keep trying to get missing scores
    scoresScoreId: string; // scoreId at which `scores` was last reconciled (full-snapshot prune); lags scoreId by one dispatch
}

// Define the initial state using that type
const initialState: ScoresSliceState = {
    className: '' as ClassName,
    scores: {},
    historical: {},
    optimalGrids: {},
    pilotStats: {},
    pilotStatsTrackVersion: {},
    loading: {},
    scoreId: '',
    scoresScoreId: ''
};

// Find the old scores / stats
import {oldScoresUrl, oldStatsUrl} from '../react/fixupUrls';

export const scoresSlice = createSlice({
    name: 'scores',
    // `createSlice` will infer the state type from the `initialState` argument
    initialState,
    reducers: {
        updateScores: _updateScores,
        // Direct stats replace for the local IGC scorer (pages/viewer.tsx), which
        // has no websocket / snapshot plane — it rescore the whole flight and
        // replaces the segment list outright.
        setPilotStats(state, {payload}: PayloadAction<{compno: Compno; segments: StatSegment[]}>) {
            state.pilotStats[payload.compno] = payload.segments;
        }
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
                    pilotStats: {},
                    pilotStatsTrackVersion: {},
                    loading: {},
                    scoreId,
                    // scores is empty for the new class, so mark it reconciled at this
                    // scoreId — the next snapshot merges in, no spurious prune.
                    scoresScoreId: scoreId
                };
            }
            // If the score id has changed then we need to reset everything historical.
            // pilotStats are keyed to trackVersion (position lineage), not scoreId, so a
            // rescore leaves them intact — only a class change clears them.
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

        // Flight-statistics plane: every stats message (live residual or connect
        // snapshot) routes through fetchOldStats. The snapshot (when baseTime>0)
        // is applied first as the baseline, then the residual tail on top.
        builder.addCase(fetchOldStats.fulfilled, (state, {payload}) => {
            if (!payload) return;
            applyStatsUpdate(state, payload.snapshot);
            applyStatsUpdate(state, payload.residual);
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
        ),
        // Returns the merged, start-sorted segment list for a pilot. The store
        // is a single accumulator (deltas merged on arrival), so there is no
        // per-time snapshot to pick — consumers (thermalLayer, decktooltip) clip
        // by segment start/end against the replay cursor themselves.
        selectPilotStats: createSelector(
            [(state: ScoresSliceState, compno: Compno | undefined) => (compno ? state.pilotStats[compno] : undefined)],
            (segments: StatSegment[] | undefined) => {
                if (!segments?.length) return undefined;
                return segments;
            },
            {
                memoizeOptions: {
                    resultEqualityCheck: (a, b) => a === b
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
                    return {data: unscaleClassScoreHistoryFromWire(ClassScoreHistory.decode(new Uint8Array(ab))), chunkId};
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

// Flight-statistics fetch. The websocket carries a PilotStatsUpdate per class:
// baseTime>0 means "fetch the immutable /stats snapshot first" (a fresh/connect
// bootstrap); baseTime===0 means "merge this residual inline" (the steady-state
// 500ms tail). No scoreId — stats key to trackVersion, not scoreId.
export const fetchOldStats = createAsyncThunk<
    {snapshot?: PilotStatsUpdate; residual?: PilotStatsUpdate} | undefined,
    {baseTime: Epoch; residual: PilotStatsUpdate; className: ClassName; datecode: Datecode}
>('scores/fetchOldStats', async ({baseTime, residual, className, datecode}, {signal}) => {
    if (!baseTime) {
        // Inline residual — no snapshot to fetch.
        return {residual};
    }
    const url = oldStatsUrl(className, datecode, baseTime.toString());
    const MAX_RETRIES = 10;
    for (let attempt = 0; attempt < MAX_RETRIES && !signal.aborted; attempt++) {
        try {
            const res = await fetch(url, {signal});
            if (res.ok) {
                const ab = await res.arrayBuffer();
                const snapshot = unscaleFromWire(OnglideWebSocketMessage.decode(new Uint8Array(ab))).stats?.class[className];
                return {snapshot, residual};
            }
            if (res.status !== 503) return {residual}; // give up on the snapshot, still apply the residual
            const retryAfter = Math.max(1, parseInt(res.headers.get('Retry-After') ?? '2', 10));
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, retryAfter * 1000);
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(signal.reason);
                }, {once: true});
            });
        } catch (e) {
            console.error('FOStats:', e);
            return {residual};
        }
    }
    return {residual};
});

export default scoresSlice.reducer;
export const {updateScores, setPilotStats} = scoresSlice.actions;
export const {selectReplayAvailable, selectAllScores, selectAllTimes, selectPilotScore, selectAllStatus, selectOptimalGrid, selectPilotStats} = scoresSlice.selectors;

//////////////////////////////////////////
// Logic for updates
//////////////////////////////////////////

// Merge a batch of (possibly partial) flight-statistics segment deltas into the
// pilot's single start-sorted accumulator, in place. Segments are keyed by their
// immutable `start`; a segment only ever grows its `end` — the open segment as
// it extends, and the last closed segment when pushOpen coalesces its successor
// into it — so we upsert keeping the larger-`end` version. This makes the merge
// idempotent and order-independent — a stale earlier copy arriving after the
// grown one (e.g. /scorehistory chunks fetched out of order) can't overwrite it.
// Apply one PilotStatsUpdate (snapshot or residual) to the accumulator. Per
// pilot: if the trackVersion differs from what the accumulator was last built
// at, the deck was rebuilt (tracker change / first load) so rebuild from the
// incoming full list; otherwise merge the tail (idempotent, max-end wins).
function applyStatsUpdate(state: ScoresSliceState, update: PilotStatsUpdate | undefined): void {
    if (!update) return;
    for (const compno in update.pilots) {
        const {trackVersion, segments} = update.pilots[compno];
        if (!segments?.length) continue;
        if (state.pilotStatsTrackVersion[compno as Compno] !== trackVersion) {
            state.pilotStats[compno as Compno] = segments.slice();
            state.pilotStatsTrackVersion[compno as Compno] = trackVersion;
        } else {
            mergeSegments((state.pilotStats[compno as Compno] ??= []), segments);
        }
    }
}

export function mergeSegments(list: StatSegment[], incoming: StatSegment[]): void {
    for (const seg of incoming) {
        const idx = sortedIndexBy(list, seg, (x) => x.start);
        if (list[idx]?.start === seg.start) {
            if (seg.end >= list[idx].end) list[idx] = seg;
        } else {
            list.splice(idx, 0, seg);
        }
    }
}

function _updateScores(state: ScoresSliceState, action: PayloadAction<Scores>) {
    if (Object.keys(action.payload.pilots).length > 1) {
        console.log(`updateScores live: ${state.scoreId}, received: ${action.payload.scoreId}, ${Object.keys(action.payload.pilots).join(',')}`);
    }
    if (action.payload.scoreId != state.scoreId) {
        return;
    }

    // The first scores payload at a new scoreId is the full snapshot that the
    // daemon bundles with the identifiers message that bumped scoreId (sendAllScores
    // on connect, sendIdentifiersToAll on _live). updateClassAction advanced
    // state.scoreId in the prior dispatch; scoresScoreId still lags, so this branch
    // fires exactly once per scoreId — never on a per-pilot live delta (those share
    // the current scoreId). Drop any pilot the snapshot no longer lists: that's a
    // pilot removed from the class. Done in this same reducer as the merge below, so
    // there's no empty-scores render in between.
    if (state.scoresScoreId != action.payload.scoreId) {
        state.scoresScoreId = action.payload.scoreId;
        for (const compno in state.scores) {
            if (!(compno in action.payload.pilots)) {
                delete state.scores[compno];
                delete state.optimalGrids[compno];
            }
        }
    }

    const result = state.scores ?? {};
    for (const compno in action.payload.pilots) {
        const score: PilotScore = action.payload.pilots[compno];
        // Extract optimal grid into separate storage (emitted once per sector entry).
        const {optimalGrid, ...scoreWithoutExtras} = score;
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
        result[compno] = mapScoresToDisplayScores(prev, scoreWithoutExtras as PilotScore);

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

        // Pull any optimalGrid / stats carried in this chunk into their dedicated
        // stores. Use sorted insert/replace rather than splice-Infinity — older
        // chunks must not drop later-loaded entries from the tail.
        for (const ns of newScores) {
            if (ns.optimalGrid?.length) {
                const entry: OptimalGridEntry = {t: ns.t as Epoch, currentLeg: ns.currentLeg, grid: ns.optimalGrid};
                const gh = (state.optimalGrids[compno as Compno] ??= []);
                const gIdx = sortedIndexBy(gh, entry, (x) => x.t);
                if (gh[gIdx]?.t === entry.t) {
                    gh[gIdx] = entry;
                } else {
                    gh.splice(gIdx, 0, entry);
                }
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
