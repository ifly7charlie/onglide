import {type ShortestResult, DistanceOptimiser} from '../flightprocessing/distanceOptimiser';

import type {Epoch, DistanceKM, Task, CalculatedTaskStatus, CalculatedTaskGenerator, TaskStatusGenerator, BasePositionMessage, TaskLegStatus} from '../types';
import {isTick, PositionStatus} from '../types';

import {cloneDeep as _clonedeep, keyBy as _keyby, sortBy as _sortby} from 'lodash';

import {distHaversine, sumPath, stripPoints} from '../flightprocessing/taskhelper';

import {convexHull} from '../flightprocessing/convexHull';

/*
 * This is used just for scoring an AAT task
 *
 * It accepts the task object, the tracker object the points to add
 *
 */
//
// Get a generator to calculate task status
export const assignedAreaScoringGenerator = async function* (task: Task, taskStatusGenerator: TaskStatusGenerator, _log?: Function): CalculatedTaskGenerator {
    // Generate log function as it's quite slow to read environment all the time
    const log = _log
        ? _log
        : () => {
              /**/
          };

    const preparedLegs = task.preparedLegs;
    if (!preparedLegs || !task.legs.length) {
        return;
    }

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
            taskPoints: task.legs[tl.legno].coordinates.map((sPoint: [number, number], index) => {
                return {t: (-tl.legno + index / 500) as Epoch, lat: sPoint[1], lng: sPoint[0]};
            })
        };
    });

    // The point that defines the end of the task
    const fakeFinishPoint = {t: -999999999 as Epoch, lat: task.legs.at(-1)!.nlat, lng: task.legs.at(-1)!.nlng, a: Infinity};
    aatLegStatus.at(-1)!.taskPoints = [fakeFinishPoint];

    // Generate the graphs for calculating min and max
    const maxGraph = new DistanceOptimiser<BasePositionMessage>(
        (point, ppoint) => 1000 - distHaversine(point, ppoint), //
        task.legs.length
    ); // min remaining graph

    // We initialise to the turnpoint
    task.legs.forEach((t) => {
        maxGraph.replaceGroup(
            t.legno,
            t.coordinates.map((c: [number, number]) => ({lat: c[1], lng: c[0], t: -t.legno as Epoch, a: 0}))
        );
    });
    maxGraph.replaceGroup(task.legs.length - 1, [fakeFinishPoint]);
    maxGraph.replaceGroup(0, [{t: -999999 as Epoch, lat: task.legs[0].nlat, lng: task.legs[0].nlng, a: -Infinity}]);

    // And the min graph is the same structure but different weight function
    const minGraph = maxGraph.clone(distHaversine);

    // Used to track if leg has changed since last calculation
    function legFingerPrint(leg: TaskLegStatus): string {
        return String(leg.entryTimeStamp || '-') + ',' + (leg.exitTimeStamp || '-') + ',' + ((leg?.points?.length ?? 0) * 10000 + leg.penaltyPoints?.length || 'np');
    }

    let scoredStatus: CalculatedTaskStatus = {} as CalculatedTaskStatus;
    let flightStatus: PositionStatus | undefined = undefined;

    for await (const current of taskStatusGenerator) {
        try {
            const taskStatus = Object.assign(scoredStatus, current);
            log(taskStatus);

            // Wait for the start
            if (!current.startConfirmed && !current.startFound) {
                if (flightStatus != taskStatus.flightStatus || isTick(taskStatus)) {
                    flightStatus = taskStatus.flightStatus;
                    yield taskStatus;
                }
                continue;
            }

            // If we have a new fingerprint then rescore required
            //        if( taskStatus.pointsProcessed! _some( taskStatus.legs, (l,i) => legFingerPrint(l) != aatLegStatus[i].fingerPrint )) {
            //            yield scores;
            //            continue;
            //        }
            if (!taskStatus.legs[0]?.points?.[0]) {
                continue;
            }

            aatLegStatus[0].convexHull = taskStatus.legs[0]?.points || [];
            scoredStatus.legs[0].point = taskStatus.legs[0]?.points[0];

            scoredStatus.inSector = current.inSector;
            scoredStatus.inPenalty = current.inPenalty;

            for (let legno = 1; legno <= taskStatus.currentLeg; legno++) {
                // Helpers
                let aatLeg = aatLegStatus[legno];
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
                    aatLeg.convexHull = [];
                    aatLeg.penaltyPoints = false;
                    aatLeg.lengthConvexHullGeneratedAt = 0;
                }

                // What points does this leg have so far
                const points = (leg.points?.length ? leg.points : leg.penaltyPoints) ?? [];

                // Did we generate from penalty points (used to reset convex hull above)
                aatLeg.penaltyPoints = points == leg.penaltyPoints;
                //                log('AATLEG', aatLeg, points.length);

                // Are we missing some from the convexhull?
                if (aatLeg.lengthConvexHullGeneratedAt < points.length) {
                    //
                    // this is a surprisingly easy update - basically we generate
                    // a set of points containing the existing convex hull and add any new points
                    // to it then re-run the convex hull routine. As it doesn't care about
                    // order it will find the optimal set regardless.
                    const newConvexHullPoints = [...aatLeg.convexHull, ...points.slice(aatLeg.lengthConvexHullGeneratedAt)];
                    const newConvexHull = convexHull(newConvexHullPoints);

                    log('================================ >>> cvex h', leg.legno);
                    log('newConvexHull', newConvexHull);

                    //
                    // Now we need to make sure the graph matches the hull
                    // first remove the links that shouldn't exist
                    const nchKey = _keyby(newConvexHull, 't');
                    maxGraph.filterGroup(legno, (a) => a.t in nchKey);
                    minGraph.filterGroup(legno, (a) => a.t in nchKey);

                    //
                    // Now add all of them back to previous turnpoint - this won't calculate distance
                    // unless the points are missing
                    const ochKey = _keyby(aatLeg.convexHull, 't');
                    const newAdditions = newConvexHull.filter((n) => !(n.t in ochKey));
                    maxGraph.addPointsToGroup(legno, newAdditions);
                    minGraph.addPointsToGroup(legno, newAdditions);

                    maxGraph.printSummary(log);

                    // Capture the status
                    aatLeg.convexHull = newConvexHull;
                    aatLeg.lengthConvexHullGeneratedAt = points.length;
                }
                // For display, just points & closed loop
                leg.convexHull = aatLeg.convexHull.flatMap((c) => [c.lng, c.lat]);
                leg.convexHull.push(...leg.convexHull.slice(0, 2));
            }

            maxGraph.printSummary(log);

            // What we optimize in next stage
            //            let scoredPoints: BasePositionMessage[];
            let scoredPoints: ShortestResult<BasePositionMessage> | undefined;

            // We don't optimize without a start
            if (taskStatus.startFound) {
                // If we have not finished
                if (!taskStatus.utcFinish) {
                    // If we are still in a sector and it isn't the finish sector then we need to link all points
                    log(`--- calculating unfinished task distance glider ${taskStatus.inSector ? 'is' : 'is not'} in sector ${taskStatus.currentLeg}`);

                    // To figure out the partial time we will generate a temporary object and copy
                    // the data into it, then we will add a link from current point to all the points
                    // in the previous sector so we can optimise properly
                    //                    var tempGraph = maxGraph.clone();

                    // If we are not in a sector it is a bit easier as it is just to the landout.  This is not
                    // 100% correct as it..
                    /// Annex A: to the point of the next Assigned Area which is nearest to the Outlanding Position,
                    /// less the distance from the Outlanding Position to this nearest point
                    // and this is doing it to the centre of the sector rather than the nearest point - it will be right
                    // on circular sectors but not on wedges
                    //                log('  assuming leg end leg' + t + ', at ' + (minNextDistP ? minNextDistP : p) + ' mdp:' + minNextDistP + ', finish:' + finish);
                    const isInSector = taskStatus.inSector || taskStatus.inPenalty;
                    const aatPreviousLeg = aatLegStatus[taskStatus.currentLeg - 1];

                    if (aatPreviousLeg) {
                        const convexHull = aatLegStatus[taskStatus.currentLeg].convexHull;
                        if (isInSector) {
                            // if we have multiple points check and see if they are making progress towards the
                            // next turnpoint
                            if (convexHull.length > 1) {
                                const chReversed = _sortby(convexHull, (a) => -a.t);
                                chReversed.pop(); // remove the oldest one — it has no prior points so the time filter would match nothing
                                const nextLeg = preparedLegs[taskStatus.currentLeg + 1];
                                scoredPoints = chReversed
                                    .map((point) => {
                                        const hc = nextLeg.hasCrossed(point, point); // get how close to next leg we are
                                        if (hc.distanceKm == null) return undefined; // already inside next sector
                                        const spr = nextLeg.scoredPointRemaining(hc.distanceKm);
                                        if (!spr) return undefined;
                                        return maxGraph.shortestAnyToGroupThenToPoint(spr, taskStatus.currentLeg, (p) => p.t < point.t);
                                    })
                                    .filter((r): r is ShortestResult<BasePositionMessage> => r != null)
                                    .sort((a, b) => a.distance - b.distance)?.[0];
                            } else {
                                // if there is only one then just solve to that point
                                scoredPoints = maxGraph.shortestAnyToGroup(taskStatus.currentLeg);
                            }
                        } else if (taskStatus.closestSectorPoint && taskStatus.closestDistanceToNext && isFinite(taskStatus.closestDistanceToNext)) {
                            log('ts/closestsectorpoint', taskStatus.closestSectorPoint, taskStatus.closestDistanceToNext);
                            const leg = preparedLegs[taskStatus.currentLeg];
                            const spr = leg.scoredPointRemaining(taskStatus.closestDistanceToNext);
                            if (spr) {
                                scoredPoints = maxGraph.shortestAnyToGroupThenToPoint(spr, taskStatus.currentLeg - 1); // spr is closest we are to next sector
                            }
                        }
                    }

                    log('scored points', scoredPoints?.path ?? []);

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
                    if (!taskStatus.inSector && !taskStatus.inPenalty) {
                        //
                        const longestRemainingPath = maxGraph.shortestAll();
                        log(taskStatus.compno, 'longestRemainingPath', longestRemainingPath);

                        // First sum up the total maximum distance - could be different solution than current
                        // score and covers whole flight
                        scoredStatus.maxPossible = sumPath(longestRemainingPath.path, 0, preparedLegs, true, (leg, distance, point) => {
                            if (point) {
                                scoredStatus.legs[leg].maxPossible = {distance, point};
                            }
                        });

                        log('maxPossible', scoredStatus.maxPossible, longestRemainingPath.distance);
                    }

                    // Next do distance remaining, it's shortest parth from current point to home
                    const minRemainingFirstLeg = taskStatus.inSector || taskStatus.inPenalty ? taskStatus.currentLeg + 1 : taskStatus.currentLeg;
                    const drPath = minGraph.shortestFrom(current.lastProcessedPoint!, taskStatus.currentLeg - 1);
                    log('drPath:', minRemainingFirstLeg, drPath);

                    const drPoints: BasePositionMessage[] = [];
                    scoredStatus.distanceRemaining = sumPath(drPath.path, taskStatus.currentLeg - 1, preparedLegs, true, (leg, distance, p) => {
                        log(`DR PATH: leg ${leg} distance ${distance} [${JSON.stringify(p)}]`);
                        scoredStatus.legs[leg].distanceRemaining = distance;
                        if (p) {
                            drPoints.push(p);
                        }
                    });

                    // Finally we need to find min possible remaining task distance
                    // this is basically the maximum distance up until now, and then the
                    // minimum distance from there to the finish.
                    const minPossibleGraph = minGraph.clone();
                    scoredPoints?.path.forEach((sp, index) => {
                        minPossibleGraph.replaceGroup(index, [sp]);
                    });

                    // Link from the current turn points to the next shortest path point
                    const startLeg = aatLegStatus[taskStatus.currentLeg].convexHull.length ? taskStatus.currentLeg : taskStatus.currentLeg - 1;
                    //find path from last point
                    const shortestRemainingPath = minPossibleGraph.shortestAll();

                    log('minPossible drPoints:', drPoints, 'shortestRemainingPath:', shortestRemainingPath?.path);

                    // now we need to add all those points in front
                    // Then add from where we are to the end of the task
                    scoredStatus.minPossible = sumPath([...drPoints, ...(shortestRemainingPath?.path || [])], 0, preparedLegs, true, (leg, distance, point) => {
                        if (point) {
                            if (!scoredStatus.legs[leg]) {
                                console.log('unable to set scored status', leg, distance, point);
                            } else {
                                scoredStatus.legs[leg].minPossible = {distance, point};
                            }
                        }
                    });
                } /* finished */ else {
                    // Calculate the longest path, doesn't include the start for some reason so we'll add it
                    scoredPoints = maxGraph.shortestAll();
                    scoredStatus.legs.forEach((l) => {
                        l.distanceRemaining = 0 as DistanceKM;
                        delete l.maxPossible;
                        delete l.minPossible;
                    });
                }

                // Reverse and output for logging...
                log('optimal path:', scoredPoints);

                if (scoredPoints) {
                    scoredStatus.distance = sumPath(scoredPoints.path, 0, preparedLegs, !!scoredStatus.utcFinish, (leg, distance, point) => {
                        log('SSD>', leg, distance, point);
                        scoredStatus.legs[leg].point = point;
                        scoredStatus.legs[leg].distance = distance;
                    });
                }

                // We don't need necessary precision
            }
            log('AAT Scoring:');
            log(JSON.stringify(scoredStatus, stripPoints, 4));
            log('-------------');
            yield scoredStatus;
        } catch (e) {
            console.log('Exception in AAT Generator');
            console.log(e);
            console.log(JSON.stringify(current, stripPoints, 4));
            maxGraph.printSummary(console.log);
            minGraph.printSummary(console.log);
            return;
        }
    }
};
