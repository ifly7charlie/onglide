//
// This slice maintains the deck.gl data for tracks
//

import {createSlice, createAsyncThunk} from '@reduxjs/toolkit';

import type {PayloadAction} from '@reduxjs/toolkit';

import {createSelector} from 'reselect';

import {updateClassAction} from './actions';

import type {RootState} from './store';

import {PilotPosition, OnglideWebSocketMessage} from '../protobuf/onglide';

//const updateTracksAction = createAction<PilotTracks>('updateTracks');

import type {
    DisplayPilotTrackData, //
    TrackData,
    VarioData,
    DeckData,
    Compno,
    Datecode,
    Epoch,
    ClassName,
    AltitudeAgl
} from '../types';

import {oldTracksUrl} from '../react/fixupUrls';

import type {PilotTracks, PilotTrack} from '../protobuf/onglide';

import {mergePoint, calculateVario, calculateAverage, generateIndices} from '../flightprocessing/incremental';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex} from 'lodash';
import {mergeVHPoint, initaliseVH} from '../react/deckvh';

interface TracksSliceState {
    className: ClassName;
    dateCode: Datecode;
    latestUpdate: Epoch;
    tracks: TrackData;
    trackVersion: string;
    baseTime: Epoch;
    scoreId: string;
}

// Define the initial state using that type
const initialState: TracksSliceState = {
    className: 'unknown' as ClassName,
    dateCode: '' as Datecode,
    latestUpdate: 0 as Epoch,
    tracks: {},
    trackVersion: '',
    baseTime: 0 as Epoch,
    scoreId: ''
};

// Data for vario display
const _selectAllVarios = createSelector(
    [
        //
        (_state: TracksSliceState, t: Epoch | undefined) => t,
        (state: TracksSliceState, _t: Epoch | undefined) => state.tracks
    ],
    (t: Epoch | undefined, tracks: TrackData | undefined): Record<Compno, VarioData | null> =>
        _reduce(
            tracks,
            (result, track, compno) => {
                if (!track?.deck?.posIndex) {
                    result[compno] = null;
                } else {
                    const posIndex = findDisplayIndex(track.deck, t);
                    result[compno] = posIndex >= 0 && t - track.deck.t[posIndex] < 120 ? calculateVario(track.deck, posIndex) : null;
                }
                return result;
            },
            {} as Record<Compno, VarioData | undefined>
        )
);

const _selectPilotVario = createSelector(
    [
        //
        (_state: TracksSliceState, compno: Compno, _t: Epoch | undefined) => compno,
        (_state: TracksSliceState, _compno: Compno, t: Epoch | undefined) => t,
        (state: TracksSliceState, compno: Compno, _t: Epoch | undefined) => state.tracks[compno]
    ],
    (_compno: Compno, t: Epoch | undefined, track) => {
        if (!track?.deck) {
            return null;
        }
        const posIndex = findDisplayIndex(track.deck, t);
        return posIndex >= 0 && (t === undefined || t - track.deck.t[posIndex] < 60) ? calculateVario(track.deck, posIndex) : null;
    },
    {
        memoizeOptions: {
            resultEqualityCheck: (a, b) => a?.t === b?.t
        },
        argsMemoizeOptions: {
            resultEqualityCheck: (prev, next) => prev?.t === next?.t
        }
    }
);

function findDisplayIndex(deck: DeckData, t: Epoch | undefined) {
    if (!t || deck.t[deck.posIndex - 1] <= t) {
        return deck.posIndex - 1;
    }

    const nextPoint = _sortedIndex(deck.t.subarray(0, deck.posIndex), t);
    return deck.t[nextPoint] > t && nextPoint > 0 ? nextPoint - 1 : nextPoint;
}

// Data for vario display
const _selectAllAverageClimb = createSelector(
    [
        //
        (_state: TracksSliceState, t: Epoch | undefined) => t,
        (state: TracksSliceState, _t: Epoch | undefined) => state.tracks,
        (state: TracksSliceState) => state.latestUpdate
    ],
    (t: Epoch | undefined, tracks: TrackData | undefined, now: Epoch | undefined): Record<Compno, number | null> =>
        _reduce(
            tracks,
            (result, track, compno) => {
                if (!track.deck?.posIndex) {
                    result[compno] = null;
                } else {
                    const posIndex = findDisplayIndex(track.deck, t);
                    result[compno] = posIndex >= 0 && (t ?? now ?? 0) - track.deck.t[posIndex] < 60 ? calculateAverage(track.deck, posIndex) : null;
                }
                return result;
            },
            {} as Record<Compno, number | null>
        )
);

// The current position of all pilots at specified time
const _selectAllPositions = createSelector(
    [
        //
        (_state: TracksSliceState, t: Epoch | undefined) => t,
        (state: TracksSliceState) => state.tracks
    ],
    (t: Epoch, tracks: TrackData) => {
        return _map(tracks, (track) => {
            const {deck, name, compno} = track;
            if (!deck) {
                return {name, compno};
            }

            const displayIndex = findDisplayIndex(deck, t);

            return {
                name,
                compno,
                v: deck.climbRate[displayIndex], //
                g: deck.agl[displayIndex],
                a: deck.positions[displayIndex * 3 + 2],
                t: deck.t[displayIndex],
                position: [...deck.positions.subarray(displayIndex * 3, displayIndex * 3 + 3)]
            };
        });
    }
);

const _selectAllAGL = createSelector(
    [
        //
        (_state: TracksSliceState, t: Epoch | undefined) => t,
        (state: TracksSliceState) => state.tracks
    ],
    (t: Epoch, tracks: TrackData) => {
        const result: Record<Compno, AltitudeAgl | null> = {};
        for (const track of Object.values(tracks)) {
            const deck = track.deck;
            if (!deck) {
                result[track.compno] = undefined;
            } else {
                const posIndex = findDisplayIndex(track.deck, t);
                result[track.compno] = deck.agl[posIndex] as AltitudeAgl;
            }
        }
        return result;
    }
);

// Find the old tracks
export const fetchOldTracks = createAsyncThunk<{downloaded: PilotTracks; websocket: PilotTracks}, {baseTime: Epoch; className: ClassName; datecode: Datecode; residual: PilotTracks}>(
    'tracks/fetchOldTracks', //
    async ({baseTime, datecode, className, residual}, {signal, getState}) => {
        const state = (getState() as RootState).tracks;
        return await fetch(oldTracksUrl(className, datecode, baseTime.toString(), state.scoreId), {signal}) //
            .then((res) => res.arrayBuffer())
            .then(async (ab) => ({downloaded: OnglideWebSocketMessage.decode(new Uint8Array(ab)).tracks, websocket: residual}))
            .catch(async (_ab) => ({downloaded: undefined, websocket: residual}));
    }
);

export const tracksSlice = createSlice({
    name: 'tracks',
    // `createSlice` will infer the state type from the `initialState` argument
    initialState,
    reducers: {
        updateTracks: _updateTracks,
        updatePositions: _updatePositions
    },
    extraReducers: (builder) => {
        //
        // New class, needs to reset everything
        builder.addCase(updateClassAction, (state, {payload: {className, scoreId}}) => {
            if (className != state.className) {
                return {
                    className: className as ClassName,
                    dateCode: '' as Datecode,
                    latestUpdate: 0 as Epoch,
                    tracks: {},
                    trackVersion: '',
                    baseTime: 0 as Epoch,
                    scoreId: scoreId
                };
            }
            // If the score id has changed then we may have incomplete tracks
            // this should trigger a reload of the history
            if (state.scoreId != scoreId) {
                state.scoreId = scoreId;
            }
        });

        //
        // Sort key has built uint arrays so we need to rebuild them (VH)
        //        builder.addCase(updateSortKeyAction, (state, {payload: {sortKey}}) => {
        //            Object.values(state.tracks).forEach((track) => initaliseVH(track, sortKey));
        //        });

        //
        // Http query of old tracks, load it and then load the one from websocket
        builder.addCase(fetchOldTracks.fulfilled, (state, action) => {
            if (action.payload.downloaded) {
                _updateTracks(state, {payload: action.payload.downloaded, type: action.type});
            }
            _updateTracks(state, {payload: action.payload.websocket, type: action.type});
        });
    },
    selectors: {
        // Specific Pilot
        selectPilotVario: _selectPilotVario,

        // Everybody
        selectAllVarios: _selectAllVarios, // memoized
        selectAllAverageClimb: _selectAllAverageClimb,
        selectAllPositions: _selectAllPositions, // memoized
        selectAllAGL: _selectAllAGL,
        selectAllTracks: (state) => state.tracks,
        selectLatestUpdate: (state) => state.latestUpdate,
        selectTrackVersion: (state) => state.trackVersion,
        selectNewestBaseTime: (state) => Object.values(state.tracks).reduce((oldest, track) => Math.max(oldest, track.t ?? 0), 0)
    }
});

export default tracksSlice.reducer;
export const {updateTracks, updatePositions} = tracksSlice.actions;
export const {selectPilotVario, selectAllPositions, selectAllTracks, selectAllVarios, selectAllAGL, selectAllAverageClimb, selectTrackVersion, selectNewestBaseTime, selectLatestUpdate} = tracksSlice.selectors;

//////////////////////////////////////////
// Logic for updates
//////////////////////////////////////////

function _updatePositions(state: TracksSliceState, action: PayloadAction<{positions: PilotPosition[]; t: Epoch}>) {
    const trackData = state.tracks;

    // Update the current class
    action.payload?.positions?.forEach((point) => {
        if (!point) {
            return;
        }
        // We need to do a deep clone for the change detection to work
        const compno = point.c;
        const cp: DisplayPilotTrackData | undefined = trackData[compno];

        // If we don't no the pilot we'll discard - this could mean we miss a point or
        // two when connecting but eliminates ghosts when changing channel
        if (!cp) {
            return;
        }

        // Merge into the deck objects
        const result = mergePoint(point, cp, false);
        if (result !== false) {
            mergeVHPoint(point, cp, result.start);
            if (result.start + 1 != result.end) {
                mergeVHPoint(point, cp, result.start + 1);
            }
        }
    });
    state.latestUpdate = Math.max(state.latestUpdate, action.payload?.t) as Epoch;
}

function _updateTracks(state: TracksSliceState, action: PayloadAction<PilotTracks>) {
    // Inbound tracks
    //    const state = original(draft);
    const tracks = action.payload;

    if (tracks.baseTime) {
        state.baseTime = tracks.baseTime as Epoch;
    }

    // Go through all of them and update the track version while including the data if required
    state.trackVersion = Object.entries(tracks.pilots)
        .map(([compno, track]: [Compno, PilotTrack]) => {
            if (!state.tracks[compno]) {
                state.tracks[compno] = {compno: compno} as DisplayPilotTrackData;
            }

            // Check if we have a deck already
            let existing = state.tracks[compno].deck;

            // If we have just received a baseTime 0 set then we should erase the old stuff
            if (existing && tracks!.baseTime === 0) {
                existing = null;
            }

            // If it's a new version of the track then we need to ignore the old one
            if (existing && existing.trackVersion != track.trackVersion) {
                console.log(`${compno}:replacing track as version changed ${existing.trackVersion} != ${track.trackVersion}`);
                existing = null;
            }

            const ts = new Uint32Array(track.t.slice().buffer);
            const indexOfOverlap = existing ? _sortedIndex(ts, existing.t[existing.posIndex - 1]) : 0;
            if (existing) {
                console.log(`${compno}: existing latest: ${existing?.t[existing.posIndex - 1]}, new range: ${ts[0]} to ${ts[track.posIndex - 1]}`);
            }
            console.log(`${compno}: existing length ${existing?.posIndex}, overlap index: ${indexOfOverlap}`);

            let deck: DeckData = {
                compno: compno as Compno,
                positions: new Float32Array(track.positions.slice(indexOfOverlap * 3 * Float32Array.BYTES_PER_ELEMENT).buffer),
                t: new Uint32Array(track.t.slice(indexOfOverlap * Uint32Array.BYTES_PER_ELEMENT).buffer),
                climbRate: new Int8Array(track.climbRate.slice(indexOfOverlap * Int8Array.BYTES_PER_ELEMENT).buffer),
                agl: new Int16Array(track.agl.slice(indexOfOverlap * Int16Array.BYTES_PER_ELEMENT).buffer),
                posIndex: track.posIndex - indexOfOverlap,
                trackVersion: track.trackVersion
            };

            if (existing) {
                // Figure out which order to put them in
                const existingOlder = existing.t[0] < deck.t[0];
                const newPosition = existingOlder === true ? existing.posIndex : 0;
                const existingPosition = existingOlder === false ? deck.posIndex : 0;

                // Make the new structure it needs enough space for existing and new
                const combined: DeckData = {
                    compno: compno as Compno,
                    positions: new Float32Array(deck.positions.length + existing.positions.length || 0),
                    t: new Uint32Array(deck.t.length + existing.t.length || 0),
                    climbRate: new Int8Array(deck.climbRate.length + existing.climbRate.length || 0),
                    agl: new Int16Array(deck.agl.length + existing.agl.length || 0),
                    posIndex: deck.posIndex + existing.posIndex,
                    trackVersion: track.trackVersion
                };

                // Then we have to copy the data into it in the correct places
                // you can't do this on the constructor as that creates a view
                combined.positions.set(existing.positions, existingPosition * 3);
                combined.t.set(existing.t, existingPosition);
                combined.climbRate.set(existing.climbRate, existingPosition);
                combined.agl.set(existing.agl, existingPosition);

                combined.positions.set(deck.positions, newPosition * 3);
                combined.t.set(deck.t, newPosition);
                combined.climbRate.set(deck.climbRate, newPosition);
                combined.agl.set(deck.agl, newPosition);

                deck = combined;
            }

            generateIndices(deck, state.tracks[compno]);
            // Save the version
            deck.trackVersion = track.trackVersion;

            // Store away and update timestamps
            state.tracks[compno].deck = deck;
            state.tracks[compno].t = deck.t[deck.posIndex - 1] as Epoch;
            initaliseVH(state.tracks[compno]);

            state.latestUpdate = Math.max(state.latestUpdate ?? 0, state.tracks[compno as Compno].t) as Epoch;
            return deck.trackVersion.toString(16) ?? compno;
        })
        .sort()
        .join(',');
}
