//
// This slice maintains the deck.gl data for tracks
//

import {createSlice} from '@reduxjs/toolkit';

import type {PayloadAction} from '@reduxjs/toolkit';

import {createSelector} from 'reselect';

//const updateTracksAction = createAction<PilotTracks>('updateTracks');

import type {
    OtherPilotData, //
    PositionMessage,
    Compno,
    Epoch,
    ClassName
} from '../types';

import {makeClassname_Compno} from '../types';

import type {ClassPositions} from '../protobuf/onglide';

import {map as _map} from 'lodash';

interface OtherPilotsSliceState {
    positions: OtherPilotData;
    latestUpdate: Epoch;
}

// Define the initial state using that type
const initialState: OtherPilotsSliceState = {
    latestUpdate: 0 as Epoch,
    positions: {}
};

// The current position of all pilots at specified time
const _selectAllPositions = createSelector(
    [
        //
        (_state: OtherPilotsSliceState, className: ClassName) => className,
        (_state: OtherPilotsSliceState, _className: ClassName, t: Epoch | undefined) => t,
        (state: OtherPilotsSliceState) => state.positions
    ],
    (className: ClassName, t: Epoch, others: OtherPilotData) => {
        const timeCutoff = (t == undefined ? Date.now() - 180 : t - 180) as Epoch;
        return _map(others, (pos, key) => ({
            className: key.split('_')[0],
            compno: pos.c,
            ...pos,
            position: [pos.lng, pos.lat, pos.a]
        })).filter((p) => p.t > timeCutoff && p.className != className);
    }
);

export const otherPilotsSlice = createSlice({
    name: 'otherPilots',
    // `createSlice` will infer the state type from the `initialState` argument
    initialState,
    reducers: {
        updateOtherPilotsPositions: _updatePositions
    },
    selectors: {
        selectAllPositions: _selectAllPositions // memoized
    }
});

export default otherPilotsSlice.reducer;
export const {updateOtherPilotsPositions} = otherPilotsSlice.actions;
export const {selectAllPositions} = otherPilotsSlice.selectors;

//////////////////////////////////////////
// Logic for updates
//////////////////////////////////////////

function _updatePositions(state: OtherPilotsSliceState, action: PayloadAction<{positions: ClassPositions; t: Epoch}>) {
    // And now update our other pilots list
    for (const [className, positions] of Object.entries(action.payload?.positions.class)) {
        for (const position of positions.positions) {
            state.positions[makeClassname_Compno(className as ClassName, position.c as Compno)] = position as PositionMessage;
        }
    }
    state.latestUpdate = Math.max(state.latestUpdate, action.payload?.t) as Epoch;
}
