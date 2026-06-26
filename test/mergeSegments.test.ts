import {describe, test, expect} from 'vitest';
import {mergeSegments} from '../lib/redux/scoresSlice';
import type {StatSegment} from '../lib/protobuf/onglide';

// Minimal segment builder — mergeSegments only reads start/end.
const seg = (start: number, end: number, over: Partial<StatSegment> = {}): StatSegment => ({start, end, state: 'thermal', ...over}) as StatSegment;

const starts = (list: StatSegment[]) => list.map((s) => s.start);

describe('mergeSegments', () => {
    test('appends new segments in start order', () => {
        const list: StatSegment[] = [];
        mergeSegments(list, [seg(100, 130), seg(200, 240)]);
        mergeSegments(list, [seg(160, 180)]);
        expect(starts(list)).toEqual([100, 160, 200]);
    });

    test('upserts the open segment by start, keeping the more-evolved (max end) version', () => {
        const list: StatSegment[] = [];
        mergeSegments(list, [seg(100, 130, {turncount: 1})]); // in-progress
        mergeSegments(list, [seg(100, 180, {turncount: 3})]); // same segment, grown + closed
        expect(list).toHaveLength(1);
        expect(list[0].end).toBe(180);
        expect(list[0].turncount).toBe(3);
    });

    test('a stale in-progress copy never clobbers the finalised one (order independent)', () => {
        const list: StatSegment[] = [];
        mergeSegments(list, [seg(100, 180, {turncount: 3})]); // final arrives first
        mergeSegments(list, [seg(100, 130, {turncount: 1})]); // stale earlier copy arrives later
        expect(list).toHaveLength(1);
        expect(list[0].end).toBe(180);
        expect(list[0].turncount).toBe(3);
    });

    test('merging full-then-delta and delta-then-full converge to the same list', () => {
        const a: StatSegment[] = [];
        mergeSegments(a, [seg(100, 130), seg(200, 230)]); // full baseline
        mergeSegments(a, [seg(200, 260), seg(300, 320)]); // delta tail

        const b: StatSegment[] = [];
        mergeSegments(b, [seg(300, 320)]); // out-of-order chunk first
        mergeSegments(b, [seg(100, 130), seg(200, 260)]);

        expect(starts(a)).toEqual([100, 200, 300]);
        expect(starts(b)).toEqual([100, 200, 300]);
        expect(a.find((s) => s.start === 200)?.end).toBe(260);
        expect(b.find((s) => s.start === 200)?.end).toBe(260);
    });
});
