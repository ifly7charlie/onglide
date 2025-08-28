import {Epoch, DistanceKM, Task, CalculatedTaskStatus, CalculatedTaskGenerator, TaskStatusGenerator, BasePositionMessage, PositionStatus, isTick} from '../types';

import Graph from '../flightprocessing/dijkstras';
import {DistanceOptimiser} from '../flightprocessing/distanceOptimiser';

import {distHaversine, sumPath} from '../flightprocessing/taskhelper';

import {lineString} from '@turf/helpers';
import along from '@turf/along';

import {d} from '../now';

/*
 * This is used just for scoring an AAT task
 *
 * It accepts the task object, the tracker object the points to add
 *
 */
//
// Get a generator to calculate task status
export const racingScoringGenerator = async function* (task: Task, taskStatusGenerator: TaskStatusGenerator, log?: Function): CalculatedTaskGenerator {
    // Generate log function as it's quite slow to read environment all the time
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    const preparedLegs = task.preparedLegs;
    if (!preparedLegs) {
        return;
    }

    let compno = '';
    let lastClosestToNext: DistanceKM | undefined = Infinity as DistanceKM;
    let lastTime: Epoch | undefined = undefined;

    const minGraph = new DistanceOptimiser<BasePositionMessage>(distHaversine, task.legs.length); // min remaining graph
    task.legs.forEach((t) => {
        minGraph.replaceGroup(
            t.legno,
            t.coordinates.map((c: [number, number]) => ({lat: c[1], lng: c[0], t: 0, a: 0}))
        );
    });

    let flightStatus: PositionStatus | undefined = undefined;

    for await (const current of taskStatusGenerator) {
        try {
            // Get current position in the task, we will update this
            // with the information needed for generating the scores
            const taskStatus: CalculatedTaskStatus = current;

            // Wait for the start
            if ((!current.startConfirmed && !current.startFound) || !taskStatus.utcStart) {
                if (flightStatus != taskStatus.flightStatus || isTick(taskStatus)) {
                    log(compno, 'rsg: no start tick');
                    flightStatus = taskStatus.flightStatus;
                    yield taskStatus;
                }
                continue;
            }

            if (!taskStatus.lastProcessedPoint) {
                continue;
            }

            compno = taskStatus.compno;

            // Make sure the task position or time has changed
            if (!isTick(taskStatus) && lastClosestToNext === taskStatus.closestDistanceToNext && lastTime === taskStatus.t) {
                continue;
            }
            lastClosestToNext = taskStatus.closestDistanceToNext;
            lastTime = taskStatus.t;

            taskStatus.distance = 0 as DistanceKM;

            // Where is the scoring from
            const previousLeg = taskStatus.legs[0];
            previousLeg.point = {
                t: taskStatus.utcStart,
                lat: task.legs[0].nlat,
                lng: task.legs[0].nlng,
                a: previousLeg?.points?.[0]?.a ?? 0
            };

            delete previousLeg.minPossible;

            // 1. Calculate all the completed legs - simply task length and
            //    positions
            for (let legno = 1; legno < taskStatus.currentLeg; legno++) {
                // If we have entered the sector then count the length of the leg
                const leg = taskStatus.legs[legno];
                if (leg.entryTimeStamp || leg.penaltyTimeStamp) {
                    leg.distance = (Math.round(task.legs[legno].length * 10) / 10) as DistanceKM; // already adjusted for start/finish rings
                    taskStatus.distance = (Math.round((taskStatus.distance + leg.distance) * 10) / 10) as DistanceKM;
                    leg.point = {
                        t: (leg.entryTimeStamp || leg.penaltyTimeStamp) ?? (0 as Epoch), //
                        lat: task.legs[legno].nlat,
                        lng: task.legs[legno].nlng,
                        a: leg?.points?.[0]?.a ?? 0
                    };
                    delete leg.minPossible;
                }
            }

            // 2. Check if we are in the sector for the current leg or not
            //    if we aren't then we need to do fractional distance calculations
            const currentLeg = taskStatus.legs[taskStatus.currentLeg];
            log(taskStatus);
            if (!taskStatus.inSector && taskStatus.closestToNextSectorPoint && taskStatus.closestDistanceToNext) {
                currentLeg.distance = (Math.round((task.legs[taskStatus.currentLeg].length - taskStatus.closestDistanceToNext) * 10) / 10) as DistanceKM;
                taskStatus.distance = (Math.round((taskStatus.distance + currentLeg.distance) * 10) / 10) as DistanceKM;
                currentLeg.point = taskStatus.closestToNextSectorPoint;

                currentLeg.point = preparedLegs[taskStatus.currentLeg] // figure out where the scored point is
                    .scoredPointRemaining(Math.min(Math.max(taskStatus.closestDistanceToNext, 0) + (task.legs[taskStatus.currentLeg].legDistanceAdjust || 0), task.legs[taskStatus.currentLeg].length) as DistanceKM);
            }

            // If we haven't finished then we will figure out the shortest path from
            // our current position to the end of the task and put that in the
            // minTaskDistance - this is much more interesting that just the 'task length'
            // remaining as it's what the pilot needs to fly to finish
            if (taskStatus.utcFinish) {
                const leg = taskStatus.legs[taskStatus.currentLeg];
                leg.distance = (Math.round(task.legs[leg.legno].length * 10) / 10) as DistanceKM; // already adjusted for start/finish rings
                taskStatus.distance = (Math.round((taskStatus.distance + leg.distance) * 10) / 10) as DistanceKM;
                leg.point = {
                    t: taskStatus.utcFinish,
                    lat: task.legs[leg.legno].nlat,
                    lng: task.legs[leg.legno].nlng,
                    a: taskStatus.lastProcessedPoint.a
                };
            } else {
                // 1. Build the graphs

                const shortestRemainingPath = minGraph.shortestFrom(taskStatus.lastProcessedPoint, taskStatus.currentLeg - 1);
                //                console.log('shortestRemainingPath', shortestRemainingPath);

                try {
                    // Then add from where we are to the end of the task
                    taskStatus.distanceRemaining = 0 as DistanceKM;
                    taskStatus.minPossible = sumPath(shortestRemainingPath.path, taskStatus.currentLeg - 1, preparedLegs, true, (leg, distance, point) => {
                        taskStatus.legs[leg].minPossible = {distance, point};
                        taskStatus.distanceRemaining = (taskStatus.distanceRemaining + distance) as DistanceKM;
                    });
                    taskStatus.legs[taskStatus.currentLeg].minPossible!.start = taskStatus.lastProcessedPoint;
                } catch (e) {
                    console.log(e);
                    // Lazy, should really confirm everything is valid ;)
                }
            }

            log('ts', JSON.stringify(taskStatus, null, 4));
            yield taskStatus;
        } catch (e) {
            // it's best if we just carry on because otherwise we may never score them again
            console.log(`unable to score ${compno} due to exception ${e?.message}`);
            //            console.log('Exception in racingScoringGenerator');
            //console.log(e);
            //            console.log(JSON.stringify(current));
            //            console.log(JSON.stringify(task));
        }
    }
    console.log(`RSG: ${compno} done`);
};
