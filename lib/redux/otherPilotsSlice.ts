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
import {getNow} from '../now';

import type {ClassPositions} from '../protobuf/onglide';

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
    (className: ClassName, t: Epoch | undefined, others: OtherPilotData) => {
        try {
            const timeCutoff = (t == undefined ? Math.trunc(getNow()) - 180 : t - 180) as Epoch;
            const m = Object.entries(others).map(([key, pos]) => ({
                class: key?.split('_')?.[0] as ClassName,
                compno: pos.c,
                ...pos,
                position: [pos.lng, pos.lat, pos.a]
            }));
            return m.filter((p) => p.t > timeCutoff && p.class != className);
        } catch (e) {
            console.error(e);
        }
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
