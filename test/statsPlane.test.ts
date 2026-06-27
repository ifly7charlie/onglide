import {describe, test, expect} from 'vitest';
import scoresReducer, {fetchOldStats} from '../lib/redux/scoresSlice';
import type {StatSegment, PilotStatsUpdate} from '../lib/protobuf/onglide';
import type {Compno, ClassName, Datecode, Epoch} from '../lib/types';

// The flight-statistics data plane is applied via fetchOldStats.fulfilled, which
// routes both the connect snapshot and the live residual through applyStatsUpdate.
// These tests exercise the reducer directly with synthetic fulfilled actions.

const seg = (start: number, end: number, over: Partial<StatSegment> = {}): StatSegment => ({start, end, state: 'thermal', ...over}) as StatSegment;

const update = (trackVersion: number, segments: StatSegment[]): PilotStatsUpdate => ({baseTime: 0, pilots: {'42': {trackVersion, segments}}});

// Synthesise the async-thunk fulfilled action the reducer listens for.
const fulfilled = (payload: {snapshot?: PilotStatsUpdate; residual?: PilotStatsUpdate}) => ({
    type: fetchOldStats.fulfilled.type,
    payload,
    meta: {arg: {baseTime: 0 as Epoch, residual: payload.residual ?? ({} as PilotStatsUpdate), className: 'A' as ClassName, datecode: 'A' as Datecode}, requestId: 'x', requestStatus: 'fulfilled' as const}
});

describe('stats data plane reducer', () => {
    test('residual builds the accumulator and leaves scores untouched', () => {
        const s1 = scoresReducer(undefined, fulfilled({residual: update(1, [seg(100, 130)])}));
        expect((s1.pilotStats['42' as Compno] ?? []).map((x) => x.start)).toEqual([100]);
        expect(Object.keys(s1.scores)).toHaveLength(0);
    });

    test('same trackVersion merges (max-end wins), growing the open segment', () => {
        let s = scoresReducer(undefined, fulfilled({residual: update(1, [seg(100, 130, {turncount: 1})])}));
        s = scoresReducer(s, fulfilled({residual: update(1, [seg(100, 180, {turncount: 3})])}));
        expect(s.pilotStats['42' as Compno]).toHaveLength(1);
        expect(s.pilotStats['42' as Compno][0].end).toBe(180);
    });

    test('a new trackVersion rebuilds from scratch (tracker change), dropping stale segments', () => {
        let s = scoresReducer(undefined, fulfilled({residual: update(1, [seg(100, 130), seg(200, 240)])}));
        // New lineage: a different trackVersion replaces, it does not merge onto the old list.
        s = scoresReducer(s, fulfilled({residual: update(2, [seg(500, 560)])}));
        expect(s.pilotStats['42' as Compno].map((x) => x.start)).toEqual([500]);
    });

    test('snapshot is applied as baseline before the residual tail', () => {
        const s = scoresReducer(undefined, fulfilled({snapshot: update(1, [seg(100, 130), seg(200, 240)]), residual: update(1, [seg(200, 290)])}));
        const starts = s.pilotStats['42' as Compno].map((x) => x.start);
        expect(starts).toEqual([100, 200]);
        expect(s.pilotStats['42' as Compno].find((x) => x.start === 200)!.end).toBe(290);
    });
});
