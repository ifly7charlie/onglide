import {type ShortestResult, DistanceOptimiser} from '../flightprocessing/distanceOptimiser';

import type {Epoch, DistanceKM, Task, CalculatedTaskStatus, CalculatedTaskGenerator, TaskStatusGenerator, BasePositionMessage, TaskLegStatus} from '../types';
import {isTick, PositionStatus} from '../types';

import {distHaversine, sumPath, stripPoints} from '../flightprocessing/taskhelper';

import {convexHull} from '../flightprocessing/convexHull';
import {PreparedTurnpoint} from '../flightprocessing/preparedTurnpoint';
import {computeOptimalGrid} from '../flightprocessing/computeOptimalGrid';
import {computeSuggestedTrack} from '../flightprocessing/computeSuggestedTrack';

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

    // Optimal direction grid: computed once per sector entry, stored independently in Redux
    let lastGridLeg = -1;

    // Skip key: set to the leg-fingerprint + flight-state hash of the last iteration
    // that made it through to a yield. If the next iteration hashes to the same value,
    // nothing the scoring calculation actually depends on has changed, so we `continue`
    // and the downstream viewer keeps showing the previous score.
    let lastScoredKey = '';

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

                    log(`newConvexHull: ${leg.legno}:`, newConvexHull);

                    //
                    // Now we need to make sure the graph matches the hull
                    // first remove the links that shouldn't exist
                    const nchKey = Object.fromEntries(newConvexHull.map((p) => [p.t, p]));
                    maxGraph.filterGroup(legno, (a) => a.t in nchKey);
                    minGraph.filterGroup(legno, (a) => a.t in nchKey);

                    //
                    // Now add all of them back to previous turnpoint - this won't calculate distance
                    // unless the points are missing
                    const ochKey = Object.fromEntries(aatLeg.convexHull.map((p) => [p.t, p]));
                    const newAdditions = newConvexHull.filter((n) => !(n.t in ochKey));
                    maxGraph.addPointsToGroup(legno, newAdditions);
                    minGraph.addPointsToGroup(legno, newAdditions);

                    maxGraph.printSummary('graphSizes' + legno, log);

                    // Capture the status
                    aatLeg.convexHull = newConvexHull;
                    aatLeg.lengthConvexHullGeneratedAt = points.length;
                }
                // For display, just points & closed loop
                leg.convexHull = aatLeg.convexHull.flatMap((c) => [c.lng, c.lat]);
                leg.convexHull.push(...leg.convexHull.slice(0, 2));
            }

            // If no leg has new hull points and flight state is unchanged since the last
            // yield, skip the full dijkstra block — the previously-emitted score is still
            // correct. Forced ticks still fall through so time-based heartbeats keep firing.
            const newScoredKey = [
                ...aatLegStatus.map((l) => l.fingerPrint),
                taskStatus.currentLeg,
                taskStatus.inSector ? '1' : '0',
                taskStatus.inPenalty ? '1' : '0',
                taskStatus.utcFinish || 0,
                taskStatus.startFound ? 1 : 0,
                taskStatus.flightStatus
            ].join('|');
            if (!isTick(taskStatus) && newScoredKey === lastScoredKey) {
                continue;
            }
            lastScoredKey = newScoredKey;

            // Compute optimal direction grid once per sector entry (when previous hull is finalized)
            const isFinishLegForGrid = taskStatus.currentLeg === task.legs.length - 1;
            if (taskStatus.currentLeg !== lastGridLeg && taskStatus.currentLeg > 0 && !isFinishLegForGrid) {
                lastGridLeg = taskStatus.currentLeg;
                const grid = computeOptimalGrid(task.legs[taskStatus.currentLeg].coordinates as [number, number][], taskStatus.currentLeg, maxGraph, preparedLegs, log);
                if (grid) {
                    scoredStatus.optimalGrid = grid;
                }
            }

            // What we optimize in next stage
            //            let scoredPoints: BasePositionMessage[];
            let scoredPoints: ShortestResult<BasePositionMessage> | undefined;
            let scoredDistanceAdjust = 0;
            let scoredDistanceAdjustLeg = 0;

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

                    // FAI Annex A: If not in a sector, route to the nearest boundary point of the
                    // next Assigned Area, less the distance from the outlanding position to that point.
                    // If achieved distance on the uncompleted leg is negative, take as zero.
                    const isInSector = taskStatus.inSector || taskStatus.inPenalty;
                    const aatPreviousLeg = aatLegStatus[taskStatus.currentLeg - 1];

                    if (aatPreviousLeg) {
                        // For the finish leg there is no "next sector" to extend to, so
                        // always use the FAI boundary approach (same as not-in-sector).
                        const isFinishLeg = taskStatus.currentLeg === task.legs.length - 1;

                        if (isInSector && !isFinishLeg) {
                            // When in sector, find the maximum distance path from start
                            // through all previous sectors to the best point in the current sector's
                            // convex hull. Don't extend to the next sector - that inflates the scored distance.
                            const cl = taskStatus.currentLeg;
                            const groupPoints = maxGraph.getGroups()[cl];
                            log(
                                `scoredPoints [t=${taskStatus.t}]: leg=${cl} inSector=${taskStatus.inSector} inPenalty=${taskStatus.inPenalty}` +
                                    ` groupSize=${groupPoints?.length}` +
                                    ` hullSize=${aatLegStatus[cl]?.convexHull?.length}` +
                                    ` penaltyPoints=${aatLegStatus[cl]?.penaltyPoints}` +
                                    ` points=[${groupPoints?.map((p) => `(${p.lat.toFixed(4)},${p.lng.toFixed(4)},t=${p.t})`).join(', ')}]`
                            );
                            scoredPoints = maxGraph.shortestAnyToGroup(taskStatus.currentLeg);
                            const numEdges = scoredPoints.path.length - 1;
                            log(
                                `  -> scored path[${cl}]=(${scoredPoints.path[cl]?.lat.toFixed(4)},${scoredPoints.path[cl]?.lng.toFixed(4)},t=${scoredPoints.path[cl]?.t})` +
                                    ` actualDist=${(numEdges * 1000 - scoredPoints.distance).toFixed(1)}km (raw weight=${scoredPoints.distance.toFixed(1)}, edges=${numEdges})`
                            );

                            // Compute optimal next sector point for direction visualization.
                            // Use shortestAll() to get the globally optimal point in the next sector,
                            // not conditioned on the current hull point — this matches the max distance line.
                            if (taskStatus.currentLeg + 1 < task.legs.length) {
                                const globalPath = maxGraph.shortestAll();
                                if (globalPath.path.length > taskStatus.currentLeg + 1) {
                                    scoredStatus.optimalNextSectorPoint = globalPath.path[taskStatus.currentLeg + 1];
                                }
                            }

                            // FAI Annex A: also credit progress toward next sector.
                            // Append the nearest boundary point of the next AA to the optimal path
                            // (preserving the credited fixes), then subtract pilot-to-boundary distance.
                            // The uncompleted leg distance is clamped to zero so this never reduces the score.
                            if (current.lastProcessedPoint && scoredPoints) {
                                const nextPreparedLeg = preparedLegs[taskStatus.currentLeg + 1];
                                if (nextPreparedLeg) {
                                    const hc = nextPreparedLeg.hasCrossed(current.lastProcessedPoint, current.lastProcessedPoint);
                                    if (hc.distanceKm && hc.onBoundary && isFinite(hc.distanceKm)) {
                                        scoredPoints = {distance: scoredPoints.distance, path: [...scoredPoints.path, hc.onBoundary]};
                                        scoredDistanceAdjust = hc.distanceKm;
                                        scoredDistanceAdjustLeg = taskStatus.currentLeg + 1;
                                        scoredStatus.scoringClosestPoint = hc.onBoundary;
                                    }
                                }
                            }
                        } else if (taskStatus.closestSectorPoint && taskStatus.closestDistanceToNext && isFinite(taskStatus.closestDistanceToNext)) {
                            log('ts/closestsectorpoint', taskStatus.closestSectorPoint, taskStatus.closestDistanceToNext);
                            // FAI Annex A: route to nearest boundary point of next AA,
                            // then subtract distance from outlanding to that point
                            scoredPoints = maxGraph.shortestAnyToGroupThenToPoint(taskStatus.closestSectorPoint, taskStatus.currentLeg - 1);
                            scoredDistanceAdjust = taskStatus.closestDistanceToNext;
                            scoredDistanceAdjustLeg = taskStatus.currentLeg;
                            scoredStatus.scoringClosestPoint = taskStatus.closestSectorPoint;
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

                    // Next do distance remaining, it's shortest path from current point to home
                    // When in sector, skip the current sector (pilot is already there) and go to next
                    const minRemainingFirstLeg = taskStatus.inSector || taskStatus.inPenalty ? taskStatus.currentLeg + 1 : taskStatus.currentLeg;
                    const drPoints: BasePositionMessage[] = [];

                    // Guard: if in the finish sector, there's nowhere left to go
                    if (minRemainingFirstLeg < task.legs.length) {
                        const drPath = minGraph.shortestFrom(current.lastProcessedPoint!, minRemainingFirstLeg - 1);
                        log('drPath:', minRemainingFirstLeg, drPath);

                        scoredStatus.distanceRemaining = sumPath(drPath.path, minRemainingFirstLeg - 1, preparedLegs, true, (leg, distance, p) => {
                            log(`DR PATH: leg ${leg} distance ${distance} [${JSON.stringify(p)}]`);
                            scoredStatus.legs[leg].distanceRemaining = distance;
                            if (p) {
                                drPoints.push(p);
                            }
                        });
                    } else {
                        scoredStatus.distanceRemaining = 0 as DistanceKM;
                    }

                    // Finally we need to find min possible remaining task distance
                    // this is basically the maximum distance up until now, and then the
                    // minimum distance from there to the finish.
                    const minPossibleGraph = minGraph.clone();
                    const minPossibleGroups = minPossibleGraph.getGroups().length;
                    scoredPoints?.path.forEach((sp, index) => {
                        if (index < minPossibleGroups) {
                            minPossibleGraph.replaceGroup(index, [sp]);
                        }
                    });

                    const shortestRemainingPath = minPossibleGraph.shortestAll();

                    log('minPossible drPoints:', drPoints, 'shortestRemainingPath:', shortestRemainingPath?.path);

                    // Use the full min path which has scored points pinned for completed legs
                    // and minimum remaining through future sectors
                    scoredStatus.minPossible = sumPath(shortestRemainingPath?.path || [], 0, preparedLegs, true, (leg, distance, point) => {
                        if (point) {
                            if (!scoredStatus.legs[leg]) {
                                log('unable to set scored status', leg, distance, point);
                            } else {
                                scoredStatus.legs[leg].minPossible = {distance, point};
                            }
                        }
                    });

                    // Compute aim points for remaining sectors based on current speed + 10%
                    if (current.lastProcessedPoint) {
                        const suggestedPoints = computeSuggestedTrack(
                            (current.t - current.utcStart!) as number,
                            task.details.durationsecs,
                            scoredStatus.distance,
                            taskStatus.currentLeg,
                            !!(taskStatus.inSector || taskStatus.inPenalty),
                            current.lastProcessedPoint,
                            scoredStatus.legs,
                            {lat: task.legs.at(-1)!.nlat, lng: task.legs.at(-1)!.nlng},
                            log
                        );
                        if (suggestedPoints) {
                            scoredStatus.suggestedTrackPoints = suggestedPoints;
                        } else {
                            delete scoredStatus.suggestedTrackPoints;
                        }
                    } else {
                        delete scoredStatus.suggestedTrackPoints;
                    }
                } /* finished */ else {
                    // Calculate the longest path, doesn't include the start for some reason so we'll add it
                    scoredPoints = maxGraph.shortestAll();
                    delete scoredStatus.scoringClosestPoint;
                    delete scoredStatus.optimalNextSectorPoint;
                    scoredStatus.legs.forEach((l) => {
                        l.distanceRemaining = 0 as DistanceKM;
                        delete l.maxPossible;
                        delete l.minPossible;
                    });
                }

                // Reverse and output for logging...
                log('optimal path:', scoredPoints);

                if (!scoredPoints && (taskStatus.inSector || taskStatus.inPenalty)) {
                    log(`optimalGridBaseline [t=${taskStatus.t}]: SKIPPED - no scoredPoints while inSector=${taskStatus.inSector} inPenalty=${taskStatus.inPenalty} currentLeg=${taskStatus.currentLeg}`);
                }
                if (scoredPoints) {
                    scoredStatus.distance = sumPath(scoredPoints.path, 0, preparedLegs, !!scoredStatus.utcFinish, (leg, distance, point) => {
                        log('SSD>', leg, distance, point);
                        scoredStatus.legs[leg].point = point;
                        scoredStatus.legs[leg].distance = distance;
                    });

                    // Compute live baseline for optimal grid: the best total task distance
                    // achievable from the current scored point (scored path to here + max
                    // remaining forward). This is the reference each grid cell's taskDist
                    // is compared against — cells where taskDist > baseline are worth
                    // detouring to, cells below baseline would reduce overall distance.
                    const isInSectorForGrid = (taskStatus.inSector || taskStatus.inPenalty) && taskStatus.currentLeg < task.legs.length - 1;
                    if (isInSectorForGrid) {
                        // Get the original scored path (without FAI Annex A extension to next sector)
                        const originalScoredPath = maxGraph.shortestAnyToGroup(taskStatus.currentLeg);
                        if (!originalScoredPath || originalScoredPath.path.length <= taskStatus.currentLeg) {
                            log(`optimalGridBaseline [t=${taskStatus.t}]: SKIPPED - originalScoredPath length=${originalScoredPath?.path?.length} currentLeg=${taskStatus.currentLeg}`);
                        } else {
                            const scoredPointInSector = originalScoredPath.path[taskStatus.currentLeg];
                            // Scored distance: start → current sector scored point only
                            const scoredDistToSector = sumPath(originalScoredPath.path, 0, preparedLegs, true);
                            // Max remaining: scored point → finish via max distance
                            const maxRemainingPath = maxGraph.shortestFrom(scoredPointInSector, taskStatus.currentLeg);
                            const maxRemaining = sumPath(maxRemainingPath.path, taskStatus.currentLeg, preparedLegs, true);
                            scoredStatus.optimalGridBaseline = (scoredDistToSector + maxRemaining) as DistanceKM;

                            // Build baseline path: scored points (start → scored point) + max remaining (→ finish)
                            const baselinePath: number[] = [];
                            for (const p of originalScoredPath.path) {
                                baselinePath.push(p.lng, p.lat);
                            }
                            for (let ri = 1; ri < maxRemainingPath.path.length; ri++) {
                                baselinePath.push(maxRemainingPath.path[ri].lng, maxRemainingPath.path[ri].lat);
                            }
                            scoredStatus.optimalGridBaselinePath = baselinePath;

                            log(
                                `optimalGridBaseline [t=${taskStatus.t}]: scoredDistToSector=${scoredDistToSector.toFixed(1)}` +
                                    ` + maxRemaining=${maxRemaining.toFixed(1)}` +
                                    ` = ${scoredStatus.optimalGridBaseline.toFixed(1)}km` +
                                    ` (scoredPt=(${scoredPointInSector.lat.toFixed(4)},${scoredPointInSector.lng.toFixed(4)})` +
                                    ` path=[${baselinePath.length / 2} points])`
                            );
                        }
                    }
                    // Don't delete baseline when not in-sector — keep last known value
                    // so the grid can still render if debouncing causes a timing gap

                    // FAI Annex A: "less the distance from the Outlanding Position to this nearest point"
                    // "If the achieved distance of the uncompleted leg is less than zero, it shall be taken as zero"
                    if (scoredDistanceAdjust > 0) {
                        const cl = scoredStatus.legs[scoredDistanceAdjustLeg];
                        if (cl) {
                            const fullDist = cl.distance;
                            const adj = Math.min(scoredDistanceAdjust, fullDist) as DistanceKM;
                            const creditedDist = Math.max(fullDist - scoredDistanceAdjust, 0) as DistanceKM;

                            cl.distance = (Math.round(creditedDist * 20) / 20) as DistanceKM;
                            scoredStatus.distance = (Math.round((scoredStatus.distance - adj) * 20) / 20) as DistanceKM;

                            // Move the scored point along the geodesic from previous fix toward
                            // the boundary, so the visual line ends at the credited position
                            const prevPoint = scoredStatus.legs[scoredDistanceAdjustLeg - 1]?.point;
                            if (prevPoint && cl.point && fullDist > 0 && creditedDist > 0) {
                                cl.point = PreparedTurnpoint.interpolatePoint(prevPoint, cl.point, creditedDist);
                            } else {
                                // No credited distance — remove the point to avoid a zero-length line
                                cl.point = undefined;
                            }
                        }
                    }

                    // For finished tasks, recompute the finish leg distance along the
                    // correct geodesic (previous fix → finish center) minus the ring radius,
                    // rather than using the LDA approach-line approximation.
                    if (scoredStatus.utcFinish) {
                        const lastIdx = scoredStatus.legs.length - 1;
                        const finishLeg = scoredStatus.legs[lastIdx];
                        const prevLeg = scoredStatus.legs[lastIdx - 1];
                        if (finishLeg?.point && prevLeg?.point) {
                            const ringRadius = preparedLegs[lastIdx]?.leg?.legDistanceAdjust ?? 0;
                            const fullDist = PreparedTurnpoint.geodesicDistance(prevLeg.point, fakeFinishPoint);
                            const correctedDist = (Math.round(Math.max(fullDist - ringRadius, 0) * 20) / 20) as DistanceKM;
                            scoredStatus.distance = (Math.round((scoredStatus.distance - finishLeg.distance + correctedDist) * 20) / 20) as DistanceKM;
                            finishLeg.distance = correctedDist;
                            if (correctedDist > 0) {
                                finishLeg.point = PreparedTurnpoint.interpolatePoint(prevLeg.point, fakeFinishPoint, correctedDist);
                            }
                        }
                    }
                }

                // We don't need necessary precision
            }
            log('AAT Scoring:');
            log(JSON.stringify(scoredStatus, stripPoints, 4));
            log('-------------');
            yield scoredStatus;
            // Grid changes only on leg entry — clear so subsequent yields don't carry it forward
            // via the Object.assign at the top of the loop. The yielded reference above is
            // already captured by the downstream generator.
            scoredStatus.optimalGrid = [];
        } catch (e) {
            console.log('Exception in AAT Generator');
            console.log(e);
            console.log(JSON.stringify(current, stripPoints, 4));
            maxGraph.printSummary('maxGraph', console.log);
            minGraph.printSummary('minGraph', console.log);
            return;
        }
    }
};
