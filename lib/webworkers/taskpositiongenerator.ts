/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Epoch, DistanceKM, BasePositionMessage, PositionMessage, TaskStatus, EstimatedTurnType, Task} from '../types';

import {InOrderGeneratorFunction} from './inordergenerator';

import {Point, Feature, lineString, point as turfPoint} from '@turf/helpers';
import length from '@turf/length';
import distance from '@turf/distance';

import {cloneDeep as _clonedeep} from 'lodash';

import {checkIsInTP, checkIsInStartSector} from '../flightprocessing/taskhelper';

export type TaskPositionGeneratorFunction = (task: Task, pointGenerator: InOrderGeneratorFunction, log?: Function) => Generator<TaskStatus, void, void>;

function simplifyPoint(point: PositionMessage): BasePositionMessage {
    return {t: point.t, lat: point.lat, lng: point.lng};
}

//
// Get a generator to calculate task status
export const taskPositionGenerator = function* (task: Task, pointGenerator: InOrderGeneratorFunction, log?: Function): Generator<TaskStatus, void, void> {
    //
    // Make sure we have some logging
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    let status: TaskStatus = {
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
    }

    let possibleAdvance: PossibleAdvance | null = null;

    // Shortcut to the startline/finishline which is expected to always be the first/last points
    var startLine = task.legs[0];
    const finishLeg = task.legs.length - 1;

    if (startLine.type !== 'sector') {
        log('please write line cross stuff!');
        return;
    }

    interface EnrichedPosition extends PositionMessage {
        geoJSON?: Feature<Point>;
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
    let iterator = pointGenerator();
    for (let current = iterator.next(); !current.done; current = iterator.next()) {
        if (!current.value) {
            break;
        }

        // Keep track of where we are
        previousPoint = point;
        point = status.lastProcessedPoint = current.value;

        // For distance calculations
        point.geoJSON = turfPoint([point.lng, point.lat]);

        // What time have we scored to
        status.t = point.t;
        status.pointsProcessed++;
        status.lastProcessedPoint = simplifyPoint(point);

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
                    if (task.rules.aat) {
                        status.legs[0].points = [{t: point.t, lat: startLine.nlat, lng: startLine.nlng}];
                    }
                    status.legs[0].exitTimeStamp = point.t;
                }
            }
            // normal tasks require some form of sector entry/exit
            // or better still line cross
            // check if we are in the sector
            else if ((inStartSector = checkIsInStartSector(startLine, point))) {
                // If we are in the start sector this is now wrong
                status.utcStart = undefined;
                status.startFound = false;
                if (task.rules.aat) {
                    status.legs[0].points = [];
                }
                delete status.legs[0].exitTimeStamp;
            }
            // We have left the start sector, remember we are going forward in time
            // we will advance but the start is not confirmed until we get
            else if (wasInStartSector) {
                status.utcStart = point.t;
                status.startFound = true;
                wasInStartSector = false;
                status.currentLeg = 1;
                if (task.rules.aat) {
                    status.legs[0].points = [{t: point.t, lat: startLine.nlat, lng: startLine.nlng}];
                }
                status.legs[0].exitTimeStamp = point.t;
                if (point._) yield status;
                continue;
            }

            wasInStartSector = inStartSector;

            // We don't need to do anything else until we have a start candidate
            // IE: you can't score without a start time
            if (!status.startFound) {
                if (point._) yield status;
                continue;
            }

            if (status.currentLeg > 1) {
                status.startConfirmed = true;
            }
        }

        // Otherwise we are evaluating against the rest of the task, this
        // includes checking what turnpoint we are in etc
        const tp = task.legs[status.currentLeg];

        // Find what point would be closest
        let nearestSectorPoint: NearestSectorPoint = {};

        // Check if the point is in the next turnpoint and save away the closest point on that sector in case we need it
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
        }

        // Check for the finish, if it is then only one point counts and we can stop tracking
        if (status.currentLeg == finishLeg) {
            if (inSector) {
                log('* found a finish @ ' + point.t);
                status.utcFinish = point.t;
                legStatus.entryTimeStamp = point.t;
                legStatus.altitude = point.a;
                //                legStatus.points.push(simplifyPoint(point));
                legStatus.points = [{t: point.t, lat: tp.nlat, lng: tp.nlng}];
                status.closestToNext = Infinity as DistanceKM;
                delete status.closestToNextSectorPoint;
                // we are done scoring at this point so we can close the iterator and
                // return the status
                yield status;
                return;
            } else {
                // we must see a point to complete this so nothing to do
                if (point._) yield status;
                continue;
            }
        }

        // If we have a point in the sector then we should advance on this
        if (inSector) {
            if (task.rules.aat) {
                legStatus.points.push(simplifyPoint(point));
                legStatus.penaltyPoints = [];
            }
            if (!legStatus.entryTimeStamp) {
                legStatus.entryTimeStamp = point.t;
                delete legStatus.penaltyTimeStamp;
                legStatus.altitude = point.a;
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
                    legStatus.altitude = point.a;
                    legStatus.penaltyTimeStamp = point.t;
                }
                legStatus.exitTimeStamp = point.t;
            }
        }

        // If we have an entry timestamp then we have been in the turn
        else if (legStatus.entryTimeStamp || legStatus.penaltyTimeStamp) {
            //
            // Make sure we have actually left the sector and passed a small distance from the TP before
            // assuming advance. AAT is longer otherwise a brief pop out will ignore points after
            // however need to cope with short legs (control points for example)
            if (!status.inSector && !status.inPenalty && distanceRemaining > Math.min(task.legs[status.currentLeg + 1]?.length * 0.1, task.rules.aat ? 10 : 2)) {
                status.currentLeg++;
                status.closestToNext = Infinity as DistanceKM;
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

                // Make sure that they have actually moved between the two points, 300m should be enough
                // as it's a bit more than a thermal circle. This should stop us picking up a jump when
                // they are stationary with a gap
                if (interpointDistance > 0.3) {
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
                        possibleAdvance = {
                            nearestSectorPoint: _clonedeep(closestSectorPoint),
                            estimatedTurnTime: Math.round((nearestSectorPoint.properties.dist / distanceNeeded) * elapsedTime + previousPoint.t) as Epoch,
                            rewindTo: point.t
                        };
                    } else {
                        log(`- no dog log possible ${neededSpeed.toFixed(1)} kph over ${distanceNeeded.toFixed(1)} km (ld: ${ld}) is too fast, gap: ${elapsedTime} [${point.t}-${previousPoint.t}]`);
                    }
                } else {
                    log(`- no dog leg, insufficient distance between previous point and this ${interpointDistance.toFixed(2)} km < 0.3 km, gap: ${elapsedTime}`);
                }
            }

            // Or are they are further away now,
            if (possibleAdvance && distanceRemaining > status.closestToNext + Math.min(task.legs[status.currentLeg + 1]?.length * 0.1, 2)) {
                log(`* using previously identified dogleg advance for sector, estimating turn @ ${possibleAdvance.estimatedTurnTime} and backtracking`);
                //
                // backtrack to immediately after the dogleg so we don't miss new sectors if the gap finishes inside the sector or
                // there is only one point between them, we can ignore the point it will be dealt with on next pass of for loop
                iterator.next(possibleAdvance.rewindTo);

                //
                if (task.rules.aat) {
                    legStatus.points.push({
                        t: possibleAdvance.estimatedTurnTime,
                        lat: possibleAdvance.nearestSectorPoint.geometry.coordinates[1],
                        lng: possibleAdvance.nearestSectorPoint.geometry.coordinates[0]
                    });
                }
                legStatus.exitTimeStamp = legStatus.entryTimeStamp = possibleAdvance.estimatedTurnTime;
                legStatus.estimatedTurn = EstimatedTurnType.dogleg;
                legStatus.altitude = point.a;
                possibleAdvance = null;
            }
        }

        // If we are live then we should return the scoring
        if (point._) yield status;
    }

    yield status;
};
