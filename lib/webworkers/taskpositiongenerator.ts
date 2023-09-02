/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Compno, Epoch, DistanceKM, BasePositionMessage, PositionMessage, TaskStatus, EstimatedTurnType, Task, PositionStatus, EnrichedPositionGenerator, EnrichedPosition, AltitudeAMSL} from '../types';

import {Point, Feature, lineString, point as turfPoint} from '@turf/helpers';
import length from '@turf/length';
import distance from '@turf/distance';
import lineIntersect from '@turf/line-intersect';

import {setTimeout} from 'timers/promises';

import {cloneDeep as _clonedeep} from 'lodash';

import {checkIsInTP, checkIsInStartSector, stripPoints} from '../flightprocessing/taskhelper';

const sleepInterval = 10 * 1000;

//export type TaskPositionGeneratorFunction = (task: Task, pointGenerator: InOrderGeneratorFunction, log?: Function) => AsyncGenerator<TaskStatus, void, void>;

function simplifyPoint(point: PositionMessage): BasePositionMessage {
    return {t: point.t, lat: point.lat, lng: point.lng, a: point.a};
}

//
// Get a generator to calculate task status
export const taskPositionGenerator = async function* (task: Task, officialStart: Epoch, iterator: EnrichedPositionGenerator, log?: Function): AsyncGenerator<TaskStatus, void, void> {
    //
    // Make sure we have some logging
    if (!log) {
        log = () => {
            /**/
        };
    }

    let status: TaskStatus = null;
    // Reset everything related to the current task
    function resetStart() {
        status = {
            compno: status?.compno || ('init' as Compno),
            t: status?.t || (0 as Epoch),
            flightStatus: status?.flightStatus || PositionStatus.Unknown,
            utcStart: officialStart || null,
            utcFinish: null,
            startFound: false,
            startConfirmed: false,
            currentLeg: 0,
            closestToNext: Infinity as DistanceKM,
            inSector: false,
            inPenalty: false,
            pointsProcessed: status?.pointsProcessed || 0,
            legs: task.legs.map((l) => {
                return {legno: l.legno, points: [], penaltyPoints: []};
            })
        };
    }
    resetStart();

    // If there is supposed to be a grandprix start then we assume it is, we don't
    // actually check they started
    let grandPrixStart = task.rules.grandprixstart && task.rules.nostartutc;

    // state for the search
    let inStartSector = false;
    let wasInStartSector = false;
    let landedBack = false;

    // How close did we get to current turnpoint
    interface NearestSectorPoint {
        geometry?: {
            coordinates: any;
        };
        properties?: {t: Epoch; dist: DistanceKM};
    }
    let closestSectorPoint: NearestSectorPoint;

    interface PossibleAdvance {
        possiblePoints: BasePositionMessage[];
        rewindTo: Epoch;
        estimatedTurnType: EstimatedTurnType;
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
            point = current.value;

            // What time have we scored to
            status.t = point.t;
            status.pointsProcessed++;
            status.lastProcessedPoint = simplifyPoint(point);
            status.compno = point.c as Compno;

            if (status.flightStatus != point.ps) {
                status.flightStatus = point.ps;
                yield status;
            }

            // If we had started but are now home then we will need to reset the
            // start if they fly again
            if (status.flightStatus == PositionStatus.Home && status.startFound) {
                landedBack = true;
            }

            // Skip if we are not flying
            if (status.flightStatus != PositionStatus.Low && status.flightStatus != PositionStatus.Airborne) {
                continue;
            }

            // If we had previous landed back but are now airborne then we can reset the task
            if (landedBack) {
                landedBack = false;
                resetStart();
                console.log(`New flight found for ${status.compno} after landback - t:${status.t}`);
            }

            // Helper
            let legStatus = status.legs[status.currentLeg];

            //
            // Until we confirm the start we will keep seeing if there
            // is a more recent one
            if (!status.startConfirmed) {
                // If there is a specific start time and we are before it then
                // do nothing,
                if (point.t < task.rules.nostartutc - 10) {
                    //if (point._) yield status;
                    continue;
                }

                // If the pilot has a specific utcStart time already then
                // ignore before - this can happen if scored into soaringspot
                if (status.utcStart && point.t < status.utcStart) {
                    //                    if (point._) yield status;
                    continue;
                }

                // We will start scoring at this point - utcStart
                // updated and the exitTimestamp - relies on the previous if statement to
                // skip up to the correct point
                if (grandPrixStart || officialStart) {
                    resetStart();
                    status.utcStart = officialStart ? officialStart : task.rules.nostartutc;
                    status.startConfirmed = true;
                    status.startFound = true;
                    status.currentLeg = 1;
                    status.legs[0].points = [{t: status.utcStart, lat: startLine.nlat, lng: startLine.nlng, a: (previousPoint || point).a}];
                    status.legs[0].exitTimeStamp = status.utcStart;

                    console.log(point.c, 'start reached', new Date(point.t * 1000).toISOString());
                    if (point._) {
                        yield status;
                        await setTimeout(sleepInterval);
                    }
                    continue;
                }
                // normal tasks require some form of sector entry/exit
                // or better still line cross
                // check if we are in the sector
                else if ((inStartSector = checkIsInStartSector(startLine, point))) {
                    resetStart();
                }
                // We have left the start sector, remember we are going forward in time
                // we will advance but the start is not confirmed until we get to the
                // first sector
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
                } else {
                    // We advance on the first point in sector if not AAT
                    status.currentLeg++;
                    legStatus.points = [simplifyPoint(point)];
                }

                if (!legStatus.entryTimeStamp) {
                    legStatus.entryTimeStamp = point.t;
                    delete legStatus.penaltyTimeStamp;
                    //                legStatus.altitude = point.a;
                    log('* next tp:' + status.currentLeg + '/' + inSector + ',' + legStatus.legno);
                }
                legStatus.exitTimeStamp = point.t;
                status.closestToNext = Infinity as DistanceKM;
                possibleAdvances = [];
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

            // If we have any timestamp, and we aren't in either penalty or sector
            // then we have been in the turn so we can simply
            // advance -
            // for AATs people sometimes go back
            // into them and if they did that with an instant exit advance we wouldn't
            // score them again
            else if (legStatus.entryTimeStamp || legStatus.penaltyTimeStamp) {
                if (!inPenalty && !inSector) {
                    if (!task.rules.aat) {
                        status.currentLeg++;
                        status.closestToNext = Infinity as DistanceKM;
                        possibleAdvances = [];
                        delete status.closestToNextSectorPoint;
                    }
                    //
                    // Make sure we have actually left the sector and passed a small distance from the TP before
                    // assuming advance. AAT is longer otherwise a brief pop out will ignore points after
                    // however need to cope with short legs (control points for example)
                    else {
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
                    // they are stationary with a gap, we also check for other reasons such as altitude
                    // change or longer gaps
                    if (interpointDistance > 0.25 || Math.abs(point.a - previousPoint.a) > 100 || elapsedTime > 70) {
                        //
                        // Check for intersection of the line and the turnpoint
                        const line = lineString([point.geoJSON.geometry.coordinates, previousPoint.geoJSON.geometry.coordinates]);
                        const intersections = lineIntersect(line, task.legs[status.currentLeg].geoJSON);
                        if (intersections.features.length >= 2) {
                            log(`* turnpoint ${status.currentLeg} intersection between ${previousPoint.t} and ${point.t} `);

                            const speedKps = interpointDistance / elapsedTime; // kps
                            const altPs = (point.a - previousPoint.a) / elapsedTime; //mps
                            let sectorPoints: BasePositionMessage[] = [];

                            for (const intersection of intersections.features) {
                                const intersectionDistance = distance(previousPoint.geoJSON, intersection);
                                const estimatedTime = Math.round(intersectionDistance * speedKps + previousPoint.t);
                                const estimatedAlt = Math.round(intersectionDistance * altPs + previousPoint.a);

                                sectorPoints.push({t: estimatedTime as Epoch, a: estimatedAlt as AltitudeAMSL, lat: intersection.geometry.coordinates[1], lng: intersection.geometry.coordinates[0]});

                                if (!task.rules.aat) {
                                    // If we are not an AAT then we only take the first point
                                    break;
                                }
                            }
                            possibleAdvances.push({
                                possiblePoints: sectorPoints,
                                estimatedTurnType: EstimatedTurnType.crossing,
                                rewindTo: point.t,
                                ld: 0
                            });

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
                                const possibleT = Math.round((nearestSectorPoint.properties.dist / distanceNeeded) * elapsedTime + previousPoint.t) as Epoch;
                                possibleAdvances.push({
                                    possiblePoints: [
                                        {
                                            a: null,
                                            t: possibleT,
                                            lat: closestSectorPoint.geometry.coordinates[1],
                                            lng: closestSectorPoint.geometry.coordinates[0]
                                        }
                                    ],
                                    estimatedTurnType: EstimatedTurnType.dogleg,
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
                    log(`* using previously identified ${advanceChosen.estimatedTurnType} advance for sector, estimating turn @ ${advanceChosen.possiblePoints[0].t} [1 of ${possibleAdvances.length} candidates] and backtracking`);
                    //
                    // backtrack to immediately after the dogleg so we don't miss new sectors if the gap finishes inside the sector or
                    // there is only one point between them, we can ignore the point it will be dealt with on next pass of for loop
                    iterator.next(advanceChosen.rewindTo);

                    legStatus.points.push(...advanceChosen.possiblePoints);

                    legStatus.exitTimeStamp = advanceChosen.possiblePoints[advanceChosen.possiblePoints.length - 1].t;
                    legStatus.entryTimeStamp = advanceChosen.possiblePoints[0].t;
                    legStatus.estimatedTurn = advanceChosen.estimatedTurnType;

                    // reset for next leg
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
            console.log(JSON.stringify(current, stripPoints, 4));
            console.log(JSON.stringify(status, stripPoints, 4));
            //            console.log(JSON.stringify(task, null, 4));
        }
    }

    log(`Sending final startings for ${status.compno}`);
    yield status;
};
