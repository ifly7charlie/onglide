/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Compno, Epoch, DistanceKM, BasePositionMessage, PositionMessage, TaskStatus, EstimatedTurnType, Task, PositionStatus} from '../types';

import {EnrichedPositionGenerator, EnrichedPosition} from '../types';

import {Point, Feature, lineString, point as turfPoint} from '@turf/helpers';
import length from '@turf/length';
import distance from '@turf/distance';
import lineIntersect from '@turf/line-intersect';

import {setTimeout} from 'timers/promises';

import {cloneDeep as _clonedeep} from 'lodash';

import {checkIsInTP, checkIsInStartSector} from '../flightprocessing/taskhelper';

const sleepInterval = 10 * 1000;

//export type TaskPositionGeneratorFunction = (task: Task, pointGenerator: InOrderGeneratorFunction, log?: Function) => AsyncGenerator<TaskStatus, void, void>;

function simplifyPoint(point: PositionMessage): BasePositionMessage {
    return {t: point.t, lat: point.lat, lng: point.lng, a: point.a};
}

//
// Get a generator to calculate task status
export const taskPositionGenerator = async function* (task: Task, iterator: EnrichedPositionGenerator, log?: Function): AsyncGenerator<TaskStatus, void, void> {
    //
    // Make sure we have some logging
    if (!log) {
        log = () => {
            /**/
        };
    }

    let status: TaskStatus = {
        compno: 'init' as Compno,
        t: 0 as Epoch,
        utcStart: null,
        utcFinish: null,
        startFound: false,
        startConfirmed: false,
        currentLeg: 0,
        closestToNext: Infinity as DistanceKM,
        inSector: false,
        inPenalty: false,
        pointsProcessed: 0,
        legs: task.legs.map((l) => {
            return {legno: l.legno, points: [], penaltyPoints: []};
        })
    };

    // If there is supposed to be a grandprix start then we assume it is, we don't
    // actually check they started
    if (task.rules.grandprixstart && task.rules.nostartutc) {
        log('grandprixstart');
        status.utcStart = task.rules.nostartutc;
    }

    // If there has been a time put into soaringspot then use that
    /*    if (status.manualstart) {
        log('manual start from db');
        status.utcstart = status.manualstart;
        status.start = timeToText(status.utcstart);
        status.dbstatus = 'S';
        status.startFound = true;
        return;
    } 
    // Otherwise if there are scores
    if (status.datafromscoring == 'Y') {
        if (status.utcstart) {
            log('start from results');
            status.startFound = true;
            status.dbstatus = 'S';
        }
        return;
    }
    */

    // state for the search
    let inStartSector = false;
    let wasInStartSector = false;

    // How close did we get to current turnpoint
    interface NearestSectorPoint {
        geometry?: {
            coordinates: any;
        };
        properties?: {t: Epoch; dist: DistanceKM};
    }
    let closestSectorPoint: NearestSectorPoint;

    interface PossibleAdvance {
        nearestSectorPoint: NearestSectorPoint;
        estimatedTurnTime: Epoch;
        rewindTo: Epoch;
        ld: number;
    }

    let possibleAdvances: PossibleAdvance[] = [];

    // Shortcut to the startline/finishline which is expected to always be the first/last points
    var startLine = task.legs[0];
    const finishLeg = task.legs.length - 1;

    if (startLine.type !== 'sector') {
        log('please write line cross stuff!');
        return;
    }

    let previousPoint: EnrichedPosition | null = null;
    let point: EnrichedPosition | null = null;

    //
    // Loop reading the next point - this will block until a point
    // is available so no need to keep track of anything else except
    // where in the task we are. At the end of each loop we will
    // yield with the status object so the downstream scorer can process
    // properly. If it's not suitable to yield then call continue to wait
    // for next point
    //    let iterator = pointGenerator(log);
    for (let current = await iterator.next(); !current.done; current = await iterator.next()) {
        if (!current.value) {
            console.log(`TPG: no value received in iterator for ${previousPoint?.c || 'unknown'}`, current);
            break;
        }
        try {
            // Keep track of where we are
            previousPoint = point;
            point = status.lastProcessedPoint = current.value;

            // What time have we scored to
            status.t = point.t;
            status.pointsProcessed++;
            status.lastProcessedPoint = simplifyPoint(point);
            status.compno = point.c as Compno;

            if (status.flightStatus != point.ps) {
                status.flightStatus = point.ps;
                yield status;
            }

            // Skip if we are not flying
            if (status.flightStatus != PositionStatus.Low && status.flightStatus != PositionStatus.Airborne) {
                continue;
            }

            // Helper
            let legStatus = status.legs[status.currentLeg];

            //
            // Until we confirm the start we will keep seeing if there
            // is a more recent one
            if (!status.startConfirmed) {
                // If there is a specific start time and we are before it then
                // do nothing, if we are after it then it's a confirmed start
                // so we can just accept the time and not do anything else
                if (status.utcStart && !status.startFound) {
                    if (point.t < status.utcStart) {
                        if (point._) yield status;
                        continue;
                    } else {
                        status.startFound = true;
                        status.startConfirmed = true;
                        status.legs[0].points = [{t: (previousPoint || point).t, lat: startLine.nlat, lng: startLine.nlng, a: (previousPoint || point).a}];
                        status.legs[0].exitTimeStamp = (previousPoint || point).t;
                    }
                }
                // normal tasks require some form of sector entry/exit
                // or better still line cross
                // check if we are in the sector
                else if ((inStartSector = checkIsInStartSector(startLine, point))) {
                    // If we are in the start sector this is now wrong
                    status.utcStart = undefined;
                    status.startFound = false;
                    status.legs[0].points = [];
                    status.closestToNext = Infinity as DistanceKM;
                    status.currentLeg = 0;
                    delete status.closestToNextSectorPoint;
                    delete status.legs[0].exitTimeStamp;
                }
                // We have left the start sector, remember we are going forward in time
                // we will advance but the start is not confirmed until we get
                else if (wasInStartSector) {
                    status.startFound = true;
                    wasInStartSector = false;
                    status.currentLeg = 1;
                    status.legs[0].points = [{t: (previousPoint || point).t, a: (previousPoint || point).a, lat: startLine.nlat, lng: startLine.nlng}];
                    status.utcStart = status.legs[0].exitTimeStamp = (previousPoint || point).t;
                    if (point._) {
                        yield status;
                        await setTimeout(sleepInterval);
                    }
                    continue;
                }

                wasInStartSector = inStartSector;

                // We don't need to do anything else until we have a start candidate
                // IE: you can't score without a start time
                if (!status.startFound) {
                    if (point._) {
                        yield status;
                        await setTimeout(sleepInterval);
                    }
                    continue;
                }

                // We keep looking for new starts (this whole block of code)
                // until we are on the second leg, that locks the start in
                if (status.currentLeg > 1) {
                    status.startConfirmed = true;
                }
            }

            //
            // We need to give them a window to re-enter an AAT sector, 10% of leg length or 10km
            if (status.recentLegAdvance) {
                const [inPreviousSector /*inPreviousPenalty*/, , distFromPrevious] = checkIsInTP(task.legs[status.recentLegAdvance], point);
                if (inPreviousSector) {
                    log(`re-entry of AAT sector ${status.recentLegAdvance} at ${point.t}, ${distFromPrevious}`);
                    status.currentLeg = status.recentLegAdvance;
                    legStatus = status.legs[status.currentLeg];
                    status.closestToNext = Infinity as DistanceKM;
                    possibleAdvances = [];
                    delete status.closestToNextSectorPoint;
                } else if (distFromPrevious > Math.min(task.legs[status.currentLeg]?.length * 0.1, 10)) {
                    status.recentLegAdvance = 0;
                }
            }

            // Otherwise we are evaluating against the rest of the task, this
            // includes checking what turnpoint we are in etc
            const tp = task.legs[status.currentLeg];

            // Find what point would be closest
            let nearestSectorPoint: NearestSectorPoint = {};

            const [inSector, inPenalty, distanceRemaining]: [boolean, boolean, DistanceKM] = checkIsInTP(tp, point, nearestSectorPoint);
            status.inPenalty = inPenalty;
            status.inSector = inSector;

            // If this point is closer to the sector than the last one then save it away so we can
            // check for doglegs
            if (!inSector && !inPenalty && distanceRemaining < status.closestToNext) {
                status.closestToNext = (Math.round(distanceRemaining * 10) / 10) as DistanceKM;
                status.closestToNextSectorPoint = simplifyPoint(point);
                nearestSectorPoint.properties.t = point.t;
                closestSectorPoint = _clonedeep(nearestSectorPoint);
                status.closestSectorPoint = {t: -status.currentLeg as Epoch, a: 0, lat: closestSectorPoint.geometry.coordinates[1], lng: closestSectorPoint.geometry.coordinates[0]};
            }

            // Check for the finish, if it is then only one point counts and we can stop tracking
            if (status.currentLeg == finishLeg) {
                if (inSector) {
                    log('* found a finish @ ' + point.t);
                    status.utcFinish = point.t;
                    legStatus.entryTimeStamp = point.t;
                    //                legStatus.altitude = point.a;
                    //                legStatus.points.push(simplifyPoint(point));
                    legStatus.points = [{t: point.t, a: point.a, lat: tp.nlat, lng: tp.nlng}];
                    status.closestToNext = Infinity as DistanceKM;
                    delete status.closestToNextSectorPoint;
                    // we are done scoring at this point so we can close the iterator and
                    // return the status
                    console.log(`TPG: ${status.compno} finish found at ${point.t}`);
                    yield status;
                    return;
                } else {
                    // we must see a point to complete this so nothing to do
                    if (point._) {
                        yield status;
                        await setTimeout(sleepInterval);
                    }
                    continue;
                }
            }

            // If we have a point in the sector then we should advance on this
            if (inSector) {
                legStatus.penaltyPoints = [];
                if (task.rules.aat) {
                    legStatus.points.push(simplifyPoint(point));
                }
                if (!legStatus.entryTimeStamp) {
                    legStatus.entryTimeStamp = point.t;
                    delete legStatus.penaltyTimeStamp;
                    //                legStatus.altitude = point.a;
                    if (!task.rules.aat) {
                        legStatus.points = [simplifyPoint(point)];
                    }
                    log('* next tp:' + status.currentLeg + '/' + inSector + ',' + legStatus.legno);
                }
                legStatus.exitTimeStamp = point.t;
                status.closestToNext = Infinity as DistanceKM;
                delete status.closestToNextSectorPoint;
            }

            // If we have a point in the penalty sector and we don't yet/or ever
            // have a timestamp
            else if (inPenalty) {
                if (!legStatus.entryTimeStamp) {
                    if (task.rules.aat && !legStatus.points.length) {
                        legStatus.penaltyPoints.push(simplifyPoint(point));
                    }
                    if (!legStatus.penaltyTimeStamp) {
                        //                    legStatus.altitude = point.a;
                        legStatus.penaltyTimeStamp = point.t;
                        if (!task.rules.aat) {
                            legStatus.penaltyPoints = [simplifyPoint(point)];
                        }
                    }
                    legStatus.exitTimeStamp = point.t;
                }
            }

            // If we have an entry timestamp then we have been in the turn so we can simply
            // advance - this isn't such a good idea for AATs because people sometimes go back
            // into them and if they did that with an instant exit advance we wouldn't
            // score them again
            else if (legStatus.entryTimeStamp && !task.rules.aat) {
                if (!inSector) {
                    status.currentLeg++;
                    status.closestToNext = Infinity as DistanceKM;
                    delete status.closestToNextSectorPoint;
                }
            }

            // If we have a penalty only sector then we give it more time (or aat in regular sector)
            else if (legStatus.entryTimeStamp || legStatus.penaltyTimeStamp) {
                //
                // Make sure we have actually left the sector and passed a small distance from the TP before
                // assuming advance. AAT is longer otherwise a brief pop out will ignore points after
                // however need to cope with short legs (control points for example)
                if (task.rules.aat && !inPenalty && !inSector) {
                    log(`setting a advance`, JSON.stringify(legStatus));
                    log(point);
                    //                    log(status);
                    status.recentLegAdvance = status.currentLeg;
                    status.currentLeg++;
                    legStatus = status.legs[status.currentLeg];
                    status.closestToNext = Infinity as DistanceKM;
                    possibleAdvances = [];
                    delete status.closestToNextSectorPoint;
                }
            }

            // Otherwise check for missed turns
            else {
                // Allow for a dog leg - ie closer and then further
                // most recent two point may be the departure rather than
                // the entry so we need to look back an extra one
                // We need to have a closest point and not be the finish leg (expectation is good coverage
                // of finish area)

                // A gap but a closest point is known and check if we could do it
                const elapsedTime = point.t - previousPoint.t;
                if (elapsedTime > 20) {
                    const interpointDistance = distance(point.geoJSON, previousPoint.geoJSON);

                    // Make sure that they have actually moved between the two points, 250m should be enough
                    // as it's a bit more than a thermal circle. This should stop us picking up a jump when
                    // they are stationary with a gap
                    if (interpointDistance > 0.25) {
                        //
                        // Check for intersection of the line and the turnpoint
                        const line = lineString([point.geoJSON.geometry.coordinates, previousPoint.geoJSON.geometry.coordinates]);
                        const intersections = lineIntersect(line, task.legs[status.currentLeg].geoJSON);
                        if (intersections.features.length >= 2) {
                            log(`* turnpoint ${status.currentLeg} intersection between ${previousPoint.t} and ${point.t} `);

                            const speedKps = interpointDistance / elapsedTime; // kps
                            const altPs = (point.a - previousPoint.a) / elapsedTime; //mps

                            for (const intersection of intersections.features) {
                                const intersectionDistance = distance(previousPoint.geoJSON, intersection);
                                const estimatedTime = Math.round(intersectionDistance * speedKps + previousPoint.t);
                                const estimatedAlt = Math.round(intersectionDistance * altPs + previousPoint.a);

                                legStatus.points.push({t: estimatedTime as Epoch, a: estimatedAlt, lat: intersection.geometry.coordinates[1], lng: intersection.geometry.coordinates[0]});

                                if (!task.rules.aat) {
                                    // If we are not an AAT then we only take the first point
                                    break;
                                }
                            }
                            legStatus.exitTimeStamp = legStatus.points[legStatus.points.length - 1].t;
                            legStatus.entryTimeStamp = legStatus.points[0].t;
                            legStatus.estimatedTurn = EstimatedTurnType.crossing;

                            status.currentLeg++;
                            status.closestToNext = Infinity as DistanceKM;
                            delete status.closestToNextSectorPoint;
                            possibleAdvances = [];

                            // Otherwise check for a dogleg
                        } else {
                            // How far from previous point, to closest point on sector to current point
                            // NOTE: this is closest point from most recent not from previous which is
                            //       slightly wrong as you turn a turnpoint on entry not departure
                            //       but we are just making sure they could have put a point in the
                            //       sector so I'm not sure it matters
                            const distanceNeeded = length(lineString([point.geoJSON.geometry.coordinates, closestSectorPoint.geometry.coordinates, previousPoint.geoJSON.geometry.coordinates]));

                            const neededSpeed = distanceNeeded / (elapsedTime / 3600); // kph
                            const ld = (point.a - previousPoint.a) / distanceNeeded;

                            // What kind of speeds do we accept?
                            // >10 minutes -> 160kph
                            // >2  minutes -> 210kph
                            // <2  minutes -> 330kph (final glide - should we confirm height loss?)
                            // accept 50% higher with current LD for the glide in the 10 to 35 range - perhaps
                            // this should be LD to finish but we don't calculate that till end of points as it's around turnpoints...
                            const possibleSpeed = elapsedTime > 600 ? 160 : (ld > 10 && ld < 35 ? 1.5 : 1) * (elapsedTime < 120 ? 330 : 210);

                            // Make sure we meet the constrants
                            if (neededSpeed < possibleSpeed) {
                                log(`* dog leg ${status.currentLeg}, ${distanceNeeded.toFixed(1)} km needed, gap length ${elapsedTime} seconds` + ` could have achieved distance in the time: ${neededSpeed.toFixed(1)} kph < ${possibleSpeed} kph (between ${previousPoint.t} and ${point.t}) (ld: ${ld})`);
                                possibleAdvances.push({
                                    nearestSectorPoint: _clonedeep(closestSectorPoint),
                                    estimatedTurnTime: Math.round((nearestSectorPoint.properties.dist / distanceNeeded) * elapsedTime + previousPoint.t) as Epoch,
                                    rewindTo: point.t,
                                    ld: ld
                                });
                            } else {
                                log(`- no dog log possible ${neededSpeed.toFixed(1)} kph over ${distanceNeeded.toFixed(1)} km (ld: ${ld}) is too fast, gap: ${elapsedTime} [${point.t}-${previousPoint.t}]`);
                            }
                        }
                    } else {
                        //                        log(`- no dog leg, insufficient distance between previous point and this ${interpointDistance.toFixed(2)} km < 0.3 km, gap: ${elapsedTime}`);
                    }
                }

                // Or are they are further away now,
                if (possibleAdvances.length && distanceRemaining > status.closestToNext + Math.min(task.legs[status.currentLeg + 1]?.length * 0.1, 2)) {
                    // We pick the advance based on - lowest ld
                    const advanceChosen = possibleAdvances.sort((paA, paB) => paA.ld - paB.ld)[0];
                    log(`* using previously identified dogleg advance for sector, estimating turn @ ${advanceChosen.estimatedTurnTime} [1 of ${possibleAdvances.length} candidates] and backtracking`);
                    //
                    // backtrack to immediately after the dogleg so we don't miss new sectors if the gap finishes inside the sector or
                    // there is only one point between them, we can ignore the point it will be dealt with on next pass of for loop
                    iterator.next(advanceChosen.rewindTo);

                    legStatus.points.push({
                        a: null,
                        t: advanceChosen.estimatedTurnTime,
                        lat: advanceChosen.nearestSectorPoint.geometry.coordinates[1],
                        lng: advanceChosen.nearestSectorPoint.geometry.coordinates[0]
                    });

                    legStatus.exitTimeStamp = legStatus.entryTimeStamp = advanceChosen.estimatedTurnTime;
                    legStatus.estimatedTurn = EstimatedTurnType.dogleg;
                    status.closestToNext = Infinity as DistanceKM;
                    delete status.closestToNextSectorPoint;
                    status.currentLeg++;
                    possibleAdvances = [];
                }
            }

            // If we are live we only score so often
            if (point._) {
                log(status);
                yield status;
                await setTimeout(sleepInterval);
            }
        } catch (e) {
            console.log('Exception in taskPositionGenerator');
            console.log(e);
            console.log(JSON.stringify(current));
            console.log(JSON.stringify(status));
        }
    }

    log(`Sending final startings for ${status.compno}`);
    yield status;
};
