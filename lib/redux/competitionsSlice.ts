//
// Live mirror of the daemon's /all WebSocket feed. The websocket subscriber
// (lib/react/competitionsSocket.tsx) dispatches snapshot/delta/connected
// actions; consumers read via the selectors below.
//

import {createSlice, createSelector} from '@reduxjs/toolkit';

import type {CompetitionSummary} from '../protobuf/onglide';
import type {Competition, CompetitionClass} from '../react/globe';
import type {CompetitionDisplayStatus} from '../competition-display-status';

interface CompetitionsState {
    byCompid: Record<string, CompetitionSummary>;
    order: string[];
    connected: boolean;
}

const initialState: CompetitionsState = {
    byCompid: {},
    order: [],
    connected: false
};

const reorder = (byCompid: Record<string, CompetitionSummary>): string[] =>
    Object.values(byCompid)
        .sort((a, b) => {
            if (a.start !== b.start) return (a.start || '').localeCompare(b.start || '');
            return a.compid.localeCompare(b.compid);
        })
        .map((c) => c.compid);

export const competitionsSlice = createSlice({
    name: 'competitions',
    initialState,
    reducers: {
        competitionsConnected: (state, {payload}: {payload: boolean}) => {
            state.connected = payload;
        },
        competitionsSnapshot: (state, {payload}: {payload: CompetitionSummary[]}) => {
            state.byCompid = {};
            for (const s of payload) state.byCompid[s.compid] = s;
            state.order = reorder(state.byCompid);
        },
        competitionsDelta: (state, {payload}: {payload: {summaries: CompetitionSummary[]; removed: string[]}}) => {
            for (const s of payload.summaries) state.byCompid[s.compid] = s;
            for (const compid of payload.removed) delete state.byCompid[compid];
            state.order = reorder(state.byCompid);
        }
    },
    selectors: {
        selectCompetitionsConnected: (state) => state.connected,
        selectCompetitionsByCompid: (state) => state.byCompid,
        selectCompetitionsOrder: (state) => state.order
    }
});

export default competitionsSlice.reducer;
export const {competitionsConnected, competitionsSnapshot, competitionsDelta} = competitionsSlice.actions;
export const {selectCompetitionsConnected, selectCompetitionsByCompid, selectCompetitionsOrder} = competitionsSlice.selectors;

// Project the raw summary into the lossy `Competition` shape that
// pages/index.tsx + lib/react/globe.tsx already consume. Memoised so the
// globe doesn't re-render on every unrelated /all delta.
export const selectCompetitionsList = createSelector([selectCompetitionsByCompid, selectCompetitionsOrder], (byCompid, order): Competition[] =>
    order.map((compid) => summaryToCompetition(byCompid[compid]))
);

// Returns the raw CompetitionSummary (preserves taskRules / datecode etc).
// Returns null while the snapshot hasn't arrived OR the compid is unknown —
// callers treat null as the loading/not-found state. Use a memoised selector
// so referential equality holds across unrelated deltas.
export const selectCompByCompid = (compid: string | undefined) =>
    createSelector([selectCompetitionsByCompid], (byCompid): CompetitionSummary | null => (compid ? byCompid[compid] ?? null : null));

function summaryToCompetition(s: CompetitionSummary): Competition {
    return {
        compid: s.compid,
        name: s.name,
        sitename: s.sitename ?? null,
        lat: s.lat,
        lng: s.lng,
        start: s.start,
        end: s.end,
        countrycode: s.countrycode,
        tz: s.tz,
        tzoffset: s.tzoffset,
        mainwebsite: s.mainwebsite ?? null,
        classCount: s.classCount,
        classes: s.classes.map(
            (c): CompetitionClass => ({
                class: c.class,
                classname: c.classname,
                status: c.status,
                pilotCount: c.pilotCount,
                displayStatus: c.displayStatus as CompetitionDisplayStatus
            })
        ),
        classStatusesDiffer: s.classStatusesDiffer,
        displayStatus: s.displayStatus as CompetitionDisplayStatus
    };
}
