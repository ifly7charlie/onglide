// Shared actions - basically subscriptions, use these in the slices to
// pick up the global state changes and update the slice appropriately

import {createAction} from '@reduxjs/toolkit';

import type {Compno, Epoch, SortKey} from '../types';

import type {Identifiers} from '../protobuf/onglide';

// Change of selected class
export const updateClassAction = createAction<Identifiers & {t: Epoch}>('updateClass');

// New start time for a pilot
export const updatePilotStartTimeAction = createAction<{compno: Compno; startUtc: Epoch}>('updatePilotStart');

// Sorting change
export const updateSortKeyAction = createAction<{sortKey: SortKey}>('updateSortKey');

// New Track point
