//
// This slice maintains the deck.gl data for tracks
//

import {createSlice} from '@reduxjs/toolkit';

import {updateClassAction} from './actions';

//const updateTracksAction = createAction<PilotTracks>('updateTracks');

import type {Datecode, Epoch, ClassName} from '../types';
import type {Identifiers} from '../protobuf/onglide';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex} from 'lodash';

interface TracksSliceState {
    className: ClassName;
    datecode: Datecode;
    earliestScore: Epoch;
    latestScore: Epoch;
    now: Epoch;
    onlineStart: Epoch;
}

// Define the initial state using that type
const initialState: TracksSliceState = {
    className: 'unknown' as ClassName,
    datecode: '' as Datecode,
    now: 0 as Epoch,
    earliestScore: Infinity as Epoch,
    latestScore: 0 as Epoch,
    onlineStart: 0 as Epoch
};

export const nowSlice = createSlice({
    name: 'now',
    // `createSlice` will infer the state type from the `initialState` argument
    initialState,
    reducers: {
        updateNow: (state, {payload: now}: {payload: Epoch}) => {
            state.now = now;
        },

        offline: (state) => {
            state.onlineStart = 0 as Epoch;
        }
    },
    extraReducers: (builder) => {
        //
        // New class, needs to reset everything
        builder.addCase(updateClassAction, (state, {payload}) => {
            state.className = payload.className as ClassName;
            state.datecode = payload.datecode as Datecode;
            state.earliestScore = payload.earliestScore as Epoch;
            state.latestScore = payload.latestScore as Epoch;
            state.onlineStart = payload.t as Epoch;
        });
    },
    selectors: {
        selectNow: (state) => state.now,
        selectClassName: (state) => state.className,
        selectDatecode: (state) => state.datecode,
        selectAvailableScoreTimes: (state) => ({earliestScore: state.earliestScore, latestScore: state.latestScore}),
        selectOnline: (state) => state.onlineStart
    }
});

export default nowSlice.reducer;
export const {updateNow, offline} = nowSlice.actions;
export const {selectNow, selectClassName, selectDatecode, selectAvailableScoreTimes, selectOnline} = nowSlice.selectors;
