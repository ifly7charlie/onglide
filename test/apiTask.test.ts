import {describe, test, expect} from 'vitest';
import {prepareApiTask, rebaseTaskStart} from '../lib/view/apiTask';
import {assembleTask, TaskDetailsRow} from '../lib/flightprocessing/taskhelper';
import {fromDateCode, toDateCode} from '../lib/datecode';
import type {Task, Epoch, Datecode} from '../lib/types';

// A raw task as the API serves it: the shape assembleTask produces from the
// tasks/taskleg rows, before calculateTask has run on it. Datecode is derived
// for the current decade so fromDateCode round-trips regardless of when the
// tests run.
const DATECODE = toDateCode(new Date(Date.UTC(new Date().getUTCFullYear(), 6, 12)));
const TASK_DAY_UTC = (Date.parse(fromDateCode(DATECODE)) / 1000) as Epoch;
const NOSTART = (TASK_DAY_UTC + 10 * 3600) as Epoch; // 10:00 UTC on the task day

const leg = (legno: number, overrides: any = {}) => ({
    datecode: DATECODE,
    class: 'Std',
    taskid: 1,
    legno,
    ntrigraph: `TP${legno}`,
    name: `Turnpoint ${legno}`,
    length: 0,
    bearing: 0,
    nlat: 52 + legno * 0.5,
    nlng: -1,
    Hi: 0,
    type: 'sector',
    direction: 'symmetrical',
    r1: 0.5,
    a1: 180,
    r2: 0,
    a2: 0,
    a12: 0,
    ...overrides
});

function rawTask(): any {
    return {
        rules: {
            grandprixstart: false,
            nostartutc: NOSTART,
            aat: false,
            dh: false,
            dm: undefined,
            pevStart: false,
            handicapped: false,
            maxHandicap: 110
        },
        details: {
            datecode: DATECODE,
            class: 'Std',
            taskid: 1,
            task: 'A',
            flown: 'Y',
            description: '',
            type: 'S',
            duration: '00:00:00',
            nostart: '10:00:00',
            hash: 'x',
            nostartutc: NOSTART,
            durationsecs: 0,
            distance: 0,
            classname: 'Standard',
            handicapped: 'N',
            grandprixstart: 'N',
            Dm: null,
            calendardate: fromDateCode(DATECODE),
            info: '',
            status: 'Y'
        },
        legs: [
            leg(0, {r1: 5, length: 0}), // 5km start ring
            leg(1, {length: 50, bearing: 180}),
            leg(2, {r1: 3, length: 40, bearing: 90}) // 3km finish ring
        ]
    };
}

describe('prepareApiTask', () => {
    test('builds preparedLegs and computes the task distance', () => {
        const {task} = prepareApiTask(rawTask());
        expect(task.preparedLegs).toHaveLength(3);
        // 50 + 40 less the 5km start ring and 3km finish ring
        expect(task.details.distance).toBe(82);
    });

    test('does not mutate the raw input (calculateTask is destructive)', () => {
        const raw = rawTask();
        prepareApiTask(raw);
        expect(raw.legs[0].length).toBe(0);
        expect(raw.legs[2].length).toBe(40);
        expect(raw.preparedLegs).toBeUndefined();
        expect(raw.details.distance).toBe(0);
    });

    test('is repeatable from the same raw (reset re-seed path)', () => {
        const raw = rawTask();
        const first = prepareApiTask(raw);
        const second = prepareApiTask(raw);
        expect(second.task.details.distance).toBe(first.task.details.distance);
        expect(second.task.legs[0].length).toBe(first.task.legs[0].length);
    });

    test('returns geoJSON with a feature per leg and the track lines', () => {
        const {geoJSON} = prepareApiTask(rawTask());
        expect(geoJSON.tp.features).toHaveLength(3);
        expect(geoJSON.track.features).toHaveLength(2);
    });

    test('clears pevStart when the start leg is not a cylinder', () => {
        const raw = rawTask();
        raw.rules.pevStart = true;
        raw.legs[0].a1 = 90; // sector, not a full cylinder
        const {task} = prepareApiTask(raw);
        expect(task.rules.pevStart).toBe(false);
    });
});

describe('rebaseTaskStart', () => {
    const gateTask = (nostartutc: number): Task =>
        ({
            rules: {nostartutc: nostartutc as Epoch},
            details: {datecode: DATECODE, nostartutc: nostartutc as Epoch}
        }) as any;

    test('same-day file leaves the gate untouched', () => {
        const task = gateTask(NOSTART);
        rebaseTaskStart(task, TASK_DAY_UTC);
        expect(task.rules.nostartutc).toBe(NOSTART);
        expect(task.details.nostartutc).toBe(NOSTART);
    });

    test('file a day later moves the gate forward a day', () => {
        const task = gateTask(NOSTART);
        rebaseTaskStart(task, (TASK_DAY_UTC + 86400) as Epoch);
        expect(task.rules.nostartutc).toBe(NOSTART + 86400);
        expect(task.details.nostartutc).toBe(NOSTART + 86400);
    });

    test('file a day earlier moves the gate back a day', () => {
        const task = gateTask(NOSTART);
        rebaseTaskStart(task, (TASK_DAY_UTC - 86400) as Epoch);
        expect(task.rules.nostartutc).toBe(NOSTART - 86400);
        expect(task.details.nostartutc).toBe(NOSTART - 86400);
    });

    test('an open gate (0) is never shifted', () => {
        const task = gateTask(0);
        rebaseTaskStart(task, (TASK_DAY_UTC + 86400) as Epoch);
        expect(task.rules.nostartutc).toBe(0);
        expect(task.details.nostartutc).toBe(0);
    });
});

describe('assembleTask', () => {
    const details = (overrides: any = {}): TaskDetailsRow =>
        ({
            datecode: DATECODE as Datecode,
            type: 'S',
            pevstart: 'N',
            handicapped: 'N',
            grandprixstart: 'N',
            Dm: null,
            nostartutc: NOSTART,
            ...overrides
        }) as any;

    test('speed task derives no aat/dh flags', () => {
        const task = assembleTask(details(), [], 105);
        expect(task.rules).toEqual({
            grandprixstart: false,
            nostartutc: NOSTART,
            aat: false,
            dh: false,
            dm: undefined,
            pevStart: false,
            handicapped: false,
            maxHandicap: 105
        });
    });

    test('type A is an AAT', () => {
        expect(assembleTask(details({type: 'A'}), [], 100).rules.aat).toBe(true);
    });

    test('type D is distance-handicapped and handicapped', () => {
        const rules = assembleTask(details({type: 'D'}), [], 100).rules;
        expect(rules.dh).toBe(true);
        expect(rules.handicapped).toBe(true);
    });

    test("handicapped 'D' class implies dh and handicapped", () => {
        const rules = assembleTask(details({handicapped: 'D'}), [], 100).rules;
        expect(rules.dh).toBe(true);
        expect(rules.handicapped).toBe(true);
    });

    test("handicapped 'Y' class is handicapped but not dh", () => {
        const rules = assembleTask(details({handicapped: 'Y'}), [], 100).rules;
        expect(rules.dh).toBe(false);
        expect(rules.handicapped).toBe(true);
    });

    test('pevstart and grandprixstart flags pass through', () => {
        const rules = assembleTask(details({pevstart: 'Y', grandprixstart: 'Y'}), [], 100).rules;
        expect(rules.pevStart).toBe(true);
        expect(rules.grandprixstart).toBe(true);
    });

    test('details and legs are passed through untouched', () => {
        const d = details();
        const legs: any[] = [leg(0), leg(1)];
        const task = assembleTask(d, legs, 100);
        expect(task.details).toBe(d);
        expect(task.legs).toBe(legs);
    });
});
