import Graph from '../flightprocessing/dijkstras';

import {Epoch, DistanceKM, AltitudeAMSL, AltitudeAgl, Compno, TaskStatus, EstimatedTurnType, Task, CalculatedTaskStatus, CalculatedTaskGenerator, TaskStatusGenerator, BasePositionMessage, TaskLegStatus} from '../types';

import {cloneDeep as _clonedeep, keyBy as _keyby} from 'lodash';

import {distHaversine, sumPath} from '../flightprocessing/taskhelper';

import {convexHull} from '../flightprocessing/convexHull';
import length from '@turf/length';
import distance from '@turf/distance';
import along from '@turf/along';
import {lineString} from '@turf/helpers';

/*
 * This is used just for scoring an AAT task
 *
 * It accepts the task object, the tracker object the points to add
 *
 */
//
// Get a generator to calculate task status
export const assignedAreaScoringGenerator = async function* (task: Task, taskStatusGenerator: TaskStatusGenerator, log?: Function): CalculatedTaskGenerator {
    // Generate log function as it's quite slow to read environment all the time
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    // We do a dijkstra on this
    let aatGraph = new Graph<BasePositionMessage, DistanceKM>();

    let aatLegStatus: {
        legno: number;
        convexHull: BasePositionMessage[]; // list of points with properties.t = Epoch
        lengthConvexHullGeneratedAt: number; // how many points in array when convex hull generated - we can use this as an optimization
        fingerPrint: string;
        penaltyPoints?: boolean;
        taskPoints: BasePositionMessage[]; // list of points for the TP used for min/max/remaining
    }[] = task.legs.map((tl) => {
        return {
            legno: tl.legno,
            convexHull: [],
            lengthConvexHullGeneratedAt: 0,
            fingerPrint: '',
            taskPoints: task.legs[tl.legno].geoJSON.coordinates[0].map((sPoint: [number, number]) => {
                return {t: -tl.legno as Epoch, lat: sPoint[1], lng: sPoint[0]};
            })
        };
    });

    // The point that defines the end of the task
    const fakeFinishPoint = {t: -999999999 as Epoch, lat: task.legs[task.legs.length - 1].nlat, lng: task.legs[task.legs.length - 1].nlng, a: null};
    aatLegStatus[aatLegStatus.length - 1].taskPoints = [fakeFinishPoint];

    // Used to track if leg has changed since last calculation
    function legFingerPrint(leg: TaskLegStatus): string {
        return String(leg.entryTimeStamp || '-') + ',' + (leg.exitTimeStamp || '-') + ',' + (leg.points?.length * 10000 + leg.penaltyPoints?.length || 'np');
    }

    let scoredStatus: CalculatedTaskStatus;

    for await (const current of taskStatusGenerator) {
        try {
            const taskStatus = (scoredStatus = current);
            log(current);

            // If we have a new fingerprint then rescore required
            //        if( taskStatus.pointsProcessed! _some( taskStatus.legs, (l,i) => legFingerPrint(l) != aatLegStatus[i].fingerPrint )) {
            //            yield scores;
            //            continue;
            //        }

            aatLegStatus[0].convexHull = taskStatus.legs[0]?.points || [];
            scoredStatus.legs[0].point = taskStatus.legs[0]?.points[0];

            // For the graph. We use the one from the previous iterator if we have it
            // if we haven't got a finish we need a temporary one - it's not persisted
            // so it's ok
            const startPoint = aatLegStatus[0].convexHull[0];
            const finishPoint = taskStatus.utcFinish ? taskStatus.legs[taskStatus.currentLeg].points[0] : fakeFinishPoint;

            for (let legno = 1; legno <= taskStatus.currentLeg; legno++) {
                // Helpers
                let aatLeg = aatLegStatus[legno];
                let aatPreviousLeg = aatLegStatus[legno - 1];
                let leg = taskStatus.legs[legno];

                // Check if the sector has changed
                const newFingerPrint = legFingerPrint(leg);
                if (newFingerPrint == aatLeg.fingerPrint) {
                    continue;
                }

                aatLeg.fingerPrint = newFingerPrint;

                // If we have points but we previously had penalty points
                // then we need to ignore the previous scoring
                if (leg.points && aatLeg.penaltyPoints) {
                    aatLeg.convexHull = null;
                    aatLeg.penaltyPoints = false;
                    aatLeg.lengthConvexHullGeneratedAt = 0;
                }

                // What points does this leg have so far
                const points = leg.points?.length ? leg.points : leg.penaltyPoints;

                // Did we generate from penalty points (used to reset convex hull above)
                aatLeg.penaltyPoints = points == leg.penaltyPoints;
                log('AATLEG', aatLeg, points.length);

                // Are we missing some from the convexhull?
                if (aatLeg.lengthConvexHullGeneratedAt < points.length) {
                    //
                    // this is a surprisingly easy update - basically we generate
                    // a set of points containing the existing convex hull and add any new points
                    // to it then re-run the convex hull routine. As it doesn't care about
                    // order it will find the optimal set regardless.
                    const newConvexHullPoints = [...(aatLeg.convexHull || []), ...points.slice(aatLeg.lengthConvexHullGeneratedAt)];
                    const newConvexHull = convexHull(newConvexHullPoints);

                    log('================================ >>> cvex h', leg.legno);
                    log('newConvexHull', newConvexHull);

                    //
                    // Now we need to make sure the graph matches the hull
                    // first remove the links that shouldn't exist
                    const nchKey = _keyby(newConvexHull, 't');
                    for (const point of aatLeg?.convexHull || []) {
                        if (!nchKey[point.t]) {
                            aatGraph.removeVertex(point);
                        }
                    }

                    //
                    // Now add all of them back to previous turnpoint - this won't calculate distance
                    // unless the points are missing
                    //                    if (aatPreviousLeg) {
                    for (const point of newConvexHull) {
                        for (const ppoint of aatPreviousLeg.convexHull) {
                            aatGraph.addLinkIfMissing(point, ppoint, () => (1000 - distHaversine(point, ppoint)) as DistanceKM);
                        }
                    }
                    //                  }

                    // Capture the status
                    aatLeg.convexHull = newConvexHull;
                    aatLeg.lengthConvexHullGeneratedAt = points.length;
                }
            }

            //        aatGraph.dump(long, (a) => a.t);

            // What we optimize in next stage
            let scoredPoints: BasePositionMessage[];

            // We don't optimize without a start
            if (taskStatus.startFound) {
                // If we have not finished
                if (!taskStatus.utcFinish) {
                    // If we are still in a sector and it isn't the finish sector then we need to link all points
                    log(`--- calculating unfinished task distance glider ${taskStatus.inSector ? 'is' : 'is not'} in sector ${taskStatus.currentLeg}`);

                    // To figure out the partial time we will generate a temporary object and copy
                    // the data into it, then we will add a link from current point to all the points
                    // in the previous sector so we can optimise properly
                    var tempGraph = new Graph<BasePositionMessage, DistanceKM>();
                    tempGraph.clone(aatGraph);

                    // If we are not in a sector it is a bit easier as it is just to the landout.  This is not
                    // 100% correct as it..
                    /// Annex A: to the point of the next Assigned Area which is nearest to the Outlanding Position,
                    /// less the distance from the Outlanding Position to this nearest point
                    // and this is doing it to the centre of the sector rather than the nearest point - it will be right
                    // on circular sectors but not on wedges
                    //                log('  assuming leg end leg' + t + ', at ' + (minNextDistP ? minNextDistP : p) + ' mdp:' + minNextDistP + ', finish:' + finish);

                    const intermediatePoint = taskStatus.closestToNextSectorPoint || taskStatus.lastProcessedPoint; // may be missing if restart and always further away after
                    const fakePoint: BasePositionMessage = {
                        a: 0 as AltitudeAMSL,
                        t: (taskStatus.currentLeg + (taskStatus.inSector ? 1 : 0)) as Epoch, //
                        lat: task.legs[taskStatus.currentLeg + (taskStatus.inSector ? 1 : 0)].nlat,
                        lng: task.legs[taskStatus.currentLeg + (taskStatus.inSector ? 1 : 0)].nlng
                    };

                    const aatPreviousLeg = aatLegStatus[taskStatus.currentLeg - 1];
                    if (aatPreviousLeg) {
                        if (taskStatus.inSector) {
                            for (const ppoint of aatPreviousLeg.convexHull) {
                                for (const point of aatLegStatus[taskStatus.currentLeg].convexHull) {
                                    tempGraph.addLink(point, ppoint, (1000 - distHaversine(point, ppoint)) as DistanceKM);
                                }
                            }
                            for (const point of aatLegStatus[taskStatus.currentLeg].convexHull) {
                                tempGraph.addLink(point, fakePoint, (1000 - distHaversine(point, fakePoint)) as DistanceKM);
                            }
                        } else {
                            for (const ppoint of aatPreviousLeg.convexHull) {
                                const ls = lineString([
                                    [ppoint.lng, ppoint.lat],
                                    [taskStatus.closestSectorPoint.lng, taskStatus.closestSectorPoint.lat]
                                ]);
                                const lsDistance = length(ls);
                                const scoredTo = along(ls, Math.max(lsDistance - taskStatus.closestToNext, 0));

                                const intermediatePoint: BasePositionMessage = {
                                    a: 0,
                                    t: -taskStatus.currentLeg as Epoch,
                                    lat: scoredTo.geometry.coordinates[1],
                                    lng: scoredTo.geometry.coordinates[0]
                                };

                                log('add link', ppoint.t, intermediatePoint, 'along:', lsDistance, 'ctn', taskStatus.closestToNext);
                                log('add link', intermediatePoint, fakePoint);
                                tempGraph.addLink(ppoint, intermediatePoint, (1000 - lsDistance) as DistanceKM);
                                tempGraph.addLink(intermediatePoint, fakePoint, 0 as DistanceKM);
                            }
                        }
                    }

                    log('from->', startPoint.t);
                    tempGraph.dump(log, (a) => a.t);
                    log('<-to', fakePoint);

                    // Calculate the longest path, doesn't include the start for some reason so we'll add it
                    scoredPoints = tempGraph.findPath(startPoint, fakePoint);
                    log('scoredPoints:', scoredPoints);

                    // If we are in sector then we added a control point to the next turnpoint that we don't need
                    //                    if (taskStatus.inSector) {
                    scoredPoints.shift();
                    //                    }

                    //
                    // Now the fun part - calculate possible distance remaining from where we are
                    // longest distance is fairly easy, just use the turnpoint coordinates for the dijkstra
                    // shortest is trickier - we will do that with a new dijkstra and a positive calculation
                    // and cheat a bit as it will be just from current point

                    // If we are in a sector then we really need to unwind and do it from the previous sector
                    // as where we are doesn't impact on the maximum distances that could be flown, but
                    // it does impact the minimum because you can't do less than you have done

                    // we don't need to remove points for current sector from max we just need to
                    // link to the previous sectors to new fake points and then from there to a end
                    // the graph will ignore any non-linked points. temp graph has only link to end
                    // added above and we reclone from before that

                    // 3x calculations
                    //     a) minimum task distance based on achieved points
                    //     b) maximum task distance based on achieved points
                    //     c) distanceRemaining = minimum from current point
                    //

                    // 1. Build the graphs
                    const maxGraph = new Graph<BasePositionMessage, DistanceKM>();
                    const minGraph = new Graph<BasePositionMessage, DistanceKM>(); // min remaining graph
                    maxGraph.clone(aatGraph); // max possible graph, intialised for turnpoints flown but not finish
                    minGraph.clone(aatGraph);

                    let previousLeg = aatLegStatus[taskStatus.currentLeg - 1];
                    for (let legno = taskStatus.currentLeg; legno < task.legs.length; legno++) {
                        const aatLeg = aatLegStatus[legno];

                        for (const ppoint of previousLeg.convexHull.length ? previousLeg.convexHull : previousLeg.taskPoints) {
                            for (const point of aatLeg.taskPoints) {
                                maxGraph.addLinkIfMissing(point, ppoint, () => (1000 - distHaversine(point, ppoint)) as DistanceKM);
                                minGraph.addLinkIfMissing(point, ppoint, () => distHaversine(point, ppoint) as DistanceKM);
                            }
                        }
                        previousLeg = aatLeg;
                    }

                    const longestRemainingPath = maxGraph.findPath(startPoint, fakeFinishPoint).reverse();
                    log('longestRemainingPath', longestRemainingPath);
                    const shortestRemainingPath = minGraph.findPath(startPoint, fakeFinishPoint).reverse();
                    log('shortestRemainingPath', shortestRemainingPath);

                    // We also need a slight tweak on shortest to get the shortest distance around and home - we don't
                    // need points just distances
                    for (const point of aatLegStatus[taskStatus.currentLeg].taskPoints) {
                        minGraph.addLink(intermediatePoint, point, distHaversine(intermediatePoint, point) as DistanceKM);
                    }
                    scoredStatus.distanceRemaining = sumPath(
                        minGraph.findPath(intermediatePoint, fakeFinishPoint).reverse(), //
                        taskStatus.inSector ? taskStatus.currentLeg : taskStatus.currentLeg - 1,
                        task.legs,
                        (leg, distance) => {
                            scoredStatus.legs[leg].distanceRemaining = distance;
                        }
                    );

                    // First sum up the total maximum distance - could be different solution than current
                    // score and covers whole flight
                    scoredStatus.maxPossible = sumPath(longestRemainingPath, 0, task.legs, (leg, distance, point) => {
                        scoredStatus.legs[leg].maxPossible = {distance, point};
                    });

                    // Then add from where we are to the end of the task
                    scoredStatus.minPossible = sumPath(shortestRemainingPath, 0, task.legs, (leg, distance, point) => {
                        scoredStatus.legs[leg].minPossible = {distance, point};
                    });
                } else {
                    // Calculate the longest path, doesn't include the start for some reason so we'll add it
                    scoredPoints = aatGraph.findPath(startPoint, finishPoint);
                }

                // Reverse and output for logging...
                scoredPoints = scoredPoints.reverse();
                log('optimal path:', scoredPoints);

                // We get them out backwards so switch it round and iterate, each node is named after its time
                let previousPoint: BasePositionMessage | null = null;
                let leg = 0;

                scoredStatus.distance = sumPath(scoredPoints, 0, task.legs, (leg, distance, point) => {
                    log('SSD>', leg, distance, point);
                    scoredStatus.legs[leg].point = point;
                    scoredStatus.legs[leg].distance = distance;
                });

                // We don't need necessary precision
            }
            log('AAT Scoring:');
            log(scoredStatus);
            log('-------------');
            yield scoredStatus;
        } catch (e) {
            console.log('Exception in AAT Generator');
            console.log(e);
            let a: any = _clonedeep(current);
            for (const l of a.legs) {
                l.points = l.points.length;
                l.penaltyPoints = l.penaltyPoints.length;
            }
            console.log(JSON.stringify(a));
        }
    }
};
