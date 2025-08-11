//
// This slice maintains the deck.gl data for tracks
//

import {createSlice} from '@reduxjs/toolkit';

import {updateClassAction} from './actions';

import type {Datecode, ClassName, Task} from '../types';
import type {Task as TaskProto} from '../protobuf/onglide';
import type {Point, FeatureCollection} from 'geojson';

import {adjustDistanceHandicapTask} from '../flightprocessing/distancehandicap';
import {taskGeoJSON} from '../flightprocessing/taskhelper';

import {d} from '../now';

import {reduce as _reduce, forEach as _foreach, cloneDeep as _cloneDeep, find as _find, map as _map, isEqual as _isEqual, sortedIndex as _sortedIndex} from 'lodash';

interface TaskSliceState {
    className: ClassName;
    datecode: Datecode;
    geoJSON?: {tp: FeatureCollection; track: FeatureCollection; Dm: Point} | undefined;
    task?: Task | undefined;
    taskReceived: boolean;
}

// Define the initial state using that type
const initialState: TaskSliceState = {
    className: 'unknown' as ClassName,
    datecode: '' as Datecode,
    taskReceived: false
};

export const taskSlice = createSlice({
    name: 'task',
    // `createSlice` will infer the state type from the `initialState` argument
    initialState,
    reducers: {
        updateTask: (state, {payload}: {payload: TaskProto}) => {
            try {
                state.task = payload.taskJSON ? (JSON.parse(payload.taskJSON) as Task) : undefined;
                state.geoJSON = payload.geoJSON ? (JSON.parse(payload.geoJSON) as (typeof state)['geoJSON']) : undefined;
                state.taskReceived = true;
                console.log(`task updated to ${state.task?.details.taskid}: nostart:${d(state.task?.rules?.nostartutc)} [${state.task?.details?.hash}]`);
            } catch (e) {
                state.task = undefined;
                state.geoJSON = undefined;
            }
        }
    },
    extraReducers: (builder) => {
        //
        // New class, needs to reset everything
        builder.addCase(updateClassAction, (state, {payload}) => {
            if (payload.className != state.className || payload.datecode != state.datecode) {
                state.className = payload.className as ClassName;
                state.datecode = payload.datecode as Datecode;
                state.task = undefined;
                state.geoJSON = undefined;
                state.taskReceived = false;
            }
        });
    },
    selectors: {
        selectHasTask: (state, vc: ClassName) => (state.className == vc ? state.taskReceived : false),
        selectTask: (state, vc: ClassName) => (state.className == vc ? state.task : undefined),
        selectTaskGeoJSON: (state, vc: ClassName, handicap: number | undefined) =>
            state.className == vc //
                ? state.task?.rules?.dh
                    ? taskGeoJSON(adjustDistanceHandicapTask(state.task, handicap))
                    : state.geoJSON
                : undefined
    }
});

export default taskSlice.reducer;
export const {updateTask} = taskSlice.actions;
export const {selectTask, selectTaskGeoJSON, selectHasTask} = taskSlice.selectors;
