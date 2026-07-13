import {describe, test, expect} from 'vitest';

import {prepareApiTask, rebaseTaskStart} from '../lib/view/apiTask';
import {fromDateCode, toDateCode} from '../lib/datecode';
import {distHaversine} from '../lib/flightprocessing/taskhelper';
import {runScoringChain} from './lib/scoringChainRunner';
import {makeMultiLegFlight, addPreStart, pointAtBearingDistance} from './lib/flightFixtures';

import type {Epoch, DistanceKM} from '../lib/types';
import type {API_ClassName_Task} from '../lib/rest-api-types';

// A synthetic task in the exact shape /api/[className]/task serves (the
// API_ClassName_Task type ties the two at compile time): line start, two
// 0.5km turnpoint barrels and a 3km finish ring back at the start, gate at
// 12:45 UTC+1. Regression-guards the hand-off from the API's raw
// pre-calculateTask JSON into the viewer's client scoring pipeline.
const DATECODE = toDateCode(new Date(Date.UTC(new Date().getUTCFullYear(), 6, 12)));
const TASK_DAY_UTC = (Date.parse(fromDateCode(DATECODE)) / 1000) as Epoch;
const NOSTART = (TASK_DAY_UTC + 12.75 * 3600 - 3600) as Epoch; // 12:45 local at UTC+1

const START = {lat: 43.9, lng: 5.9};
const TP1 = pointAtBearingDistance(START, 90, 60); // 60km east
const TP2 = pointAtBearingDistance(TP1, 0, 80); // 80km north
const LEG_LENGTHS = [0, 60, 80, distHaversine(TP2, START)] as DistanceKM[];
const CENTRES = [START, TP1, TP2, START];

function rawApiTask(): API_ClassName_Task['task'] {
    const legs = CENTRES.map((centre, legno) => ({
        datecode: DATECODE,
        class: 'TestClass',
        taskid: 1,
        legno,
        ntrigraph: `TP${legno}`,
        name: `Turnpoint ${legno}`,
        length: LEG_LENGTHS[legno],
        bearing: 0,
        nlat: centre.lat,
        nlng: centre.lng,
        Hi: 0,
        type: legno === 0 ? 'line' : 'sector',
        direction: legno === 0 ? 'np' : 'symmetrical',
        r1: [5, 0.5, 0.5, 3][legno],
        a1: [90, 180, 180, 180][legno],
        r2: 0,
        a2: 0,
        a12: 0
    }));
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
            class: 'TestClass',
            taskid: 1,
            task: 'A',
            flown: 'Y',
            description: '',
            type: 'S',
            duration: '00:00:00',
            nostart: '12:45:00',
            hash: 'test',
            nostartutc: NOSTART,
            durationsecs: 0,
            distance: 0,
            classname: 'Test Class',
            handicapped: 'N',
            grandprixstart: 'N',
            Dm: null,
            calendardate: fromDateCode(DATECODE),
            info: '',
            status: 'L'
        },
        legs
    } as API_ClassName_Task['task'];
}

const CRUISE_ALT = 1800;
const SPEED = 150; // kph

// Fly the task through the sector centres, starting shortly after the gate.
// Launch at the start point (the harness's airfield — ground fixes elsewhere
// read as a landout), head 5km out behind the line, then run back through it
// so the start crossing has an unambiguous side change.
const PRE_START = pointAtBearingDistance(START, 270, 5);

function taskFlight(gate: Epoch) {
    const waypoints = [START, PRE_START, ...CENTRES.slice(1)].map((centre) => ({lat: centre.lat, lng: centre.lng, altitude: CRUISE_ALT}));
    const flightStart = (gate + 600) as Epoch;
    return addPreStart(makeMultiLegFlight(waypoints, flightStart, SPEED), START.lat, START.lng, (flightStart - 300) as Epoch);
}

describe('API task → viewer scoring pipeline', () => {
    test('prepareApiTask computes the task distance from the raw legs', () => {
        const {task} = prepareApiTask(rawApiTask());
        // Sum of the legs less the 3km finish ring (line start: no adjustment)
        const expected = Math.round((LEG_LENGTHS[1] + LEG_LENGTHS[2] + LEG_LENGTHS[3] - 3) * 10) / 10;
        expect(task.details.distance).toBeCloseTo(expected, 1);
        expect(task.preparedLegs).toHaveLength(4);
    });

    // The viewer rebases the gate onto the IGC file's day; simulate a file
    // flown three days before the competition day the API served.
    const epochBase = (TASK_DAY_UTC - 3 * 86400) as Epoch;

    test('a different-day flight scores start and finish after the rebase', async () => {
        const {task} = prepareApiTask(rawApiTask());
        rebaseTaskStart(task, epochBase);
        expect(task.rules.nostartutc).toBe(NOSTART - 3 * 86400);

        const result = await runScoringChain(task, taskFlight(task.rules.nostartutc));
        expect(result.final.utcStart).toBeGreaterThanOrEqual(task.rules.nostartutc);
        expect(result.final.utcFinish).toBeGreaterThan(result.final.utcStart);
        expect(result.final.actual?.taskDistance).toBeGreaterThan(200);
    });

    test('without the rebase the same flight never starts (the gate trap)', async () => {
        const {task} = prepareApiTask(rawApiTask());
        const rebasedGate = (NOSTART - 3 * 86400) as Epoch;

        const result = await runScoringChain(task, taskFlight(rebasedGate));
        expect(result.final.utcStart ?? 0).toBe(0);
    });
});
