import {Epoch, DistanceKM, AltitudeAMSL, AltitudeAgl, Compno, TaskStatus, EstimatedTurnType, Task, CalculatedTaskStatus, CalculatedTaskGenerator, TaskStatusGenerator, BasePositionMessage, TaskLegStatus} from '../types';

import {cloneDeep as _clonedeep, keyBy as _keyby} from 'lodash';

import Graph from '../flightprocessing/dijkstras';

import {distHaversine, sumPath} from '../flightprocessing/taskhelper';

import {lineString} from '@turf/helpers';
import along from '@turf/along';

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

    for await (const current of taskStatusGenerator) {
        try {
            // Get current position in the task, we will update this
            // with the information needed for generating the scores
            const taskStatus: CalculatedTaskStatus = current;

            // Wait for the start
            if (!taskStatus.utcStart) {
                continue;
            }

            taskStatus.distance = 0 as DistanceKM;
            const previousLeg = taskStatus.legs[0];

            log(previousLeg);

            // Where is the scoring from
            previousLeg.point = {
                t: taskStatus.utcStart,
                lat: task.legs[0].nlat,
                lng: task.legs[0].nlng,
                a: previousLeg.points[0]?.a
            };

            // 1. Calculate all the completed legs - simply task length and
            //    positions
            for (let legno = 1; legno < taskStatus.currentLeg; legno++) {
                // If we have entered the sector then count the length of the leg
                const leg = taskStatus.legs[legno];
                if (leg.entryTimeStamp || leg.penaltyTimeStamp) {
                    leg.distance = (Math.round(task.legs[legno].length * 10) / 10) as DistanceKM; // already adjusted for start/finish rings
                    taskStatus.distance = (Math.round((taskStatus.distance + leg.distance) * 10) / 10) as DistanceKM;
                    leg.point = {
                        t: leg.entryTimeStamp || leg.penaltyTimeStamp, //
                        lat: task.legs[legno].nlat,
                        lng: task.legs[legno].nlng,
                        a: leg.points[0]?.a || 0
                    };
                }
            }

            // 2. Check if we are in the sector for the current leg or not
            //    if we aren't then we need to do fractional distance calculations
            const currentLeg = taskStatus.legs[taskStatus.currentLeg];
            log(taskStatus);
            if (!taskStatus.inSector && !taskStatus.inPenalty && taskStatus.closestToNextSectorPoint) {
                currentLeg.distance = (Math.round((task.legs[taskStatus.currentLeg].length - taskStatus.closestToNext) * 10) / 10) as DistanceKM;
                taskStatus.distance = (Math.round((taskStatus.distance + currentLeg.distance) * 10) / 10) as DistanceKM;
                currentLeg.point = taskStatus.closestToNextSectorPoint;
                // figure out where the scored point is
                const scoredTo = along(
                    lineString([task.legs[taskStatus.currentLeg].point, task.legs[taskStatus.currentLeg - 1].point]), //
                    Math.min(Math.max(taskStatus.closestToNext, 0), task.legs[taskStatus.currentLeg].length)
                );
                [currentLeg.point.lng, currentLeg.point.lat] = scoredTo.geometry.coordinates;
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
                const minGraph = new Graph<BasePositionMessage, DistanceKM>(); // min remaining graph
                let fakePointCount = -1;

                const minLegStart = taskStatus.currentLeg;
                let previousMinPoints = [taskStatus.lastProcessedPoint];
                const finishLeg = task.legs.length - 1;
                const finishPoint: BasePositionMessage = {t: finishLeg as Epoch, lat: task.legs[task.legs.length - 1].nlat, lng: task.legs[task.legs.length - 1].nlng} as BasePositionMessage;

                for (let legno = taskStatus.currentLeg; legno <= finishLeg; legno++) {
                    // Points depend on the leg
                    let thisLegPoints: BasePositionMessage[] =
                        legno == finishLeg
                            ? [finishPoint]
                            : task.legs[legno].geoJSON.coordinates[0].map((sPoint: [number, number]) => {
                                  return {t: legno as Epoch, lat: sPoint[1], lng: sPoint[0]};
                              });

                    for (const sectorPoint of thisLegPoints) {
                        for (const pPoint of previousMinPoints) {
                            // If it's our temp starting point then ignore
                            // if it's the first leg then we need to do maximum as we can't shrink it
                            minGraph.addLink(pPoint, sectorPoint, distHaversine(pPoint, sectorPoint));
                        }
                    }
                    previousMinPoints = thisLegPoints; // after first point they are the same
                }

                const shortestRemainingPath = minGraph.findPath(taskStatus.lastProcessedPoint, finishPoint).reverse();
                //            shortestRemainingPath.shift();
                log('shortestRemainingPath', shortestRemainingPath);

                try {
                    // Then add from where we are to the end of the task
                    taskStatus.distanceRemaining = 0 as DistanceKM;
                    taskStatus.minPossible = sumPath(shortestRemainingPath, taskStatus.currentLeg - 1, task.legs, (leg, distance, point) => {
                        taskStatus.legs[leg].minPossible = {distance, point};
                        taskStatus.distanceRemaining = (taskStatus.distanceRemaining + distance) as DistanceKM;
                    });
                } catch (e) {}

                taskStatus.legs[taskStatus.currentLeg].minPossible.start = taskStatus.lastProcessedPoint;
            }

            log(JSON.stringify(taskStatus, null, 4));
            yield taskStatus;
        } catch (e) {
            // it's best if we just carry on because otherwise we may never score them again
            console.log('Exception in racingScoringGenerator');
            console.log(e);
            console.log(JSON.stringify(current));
        }
    }
};
