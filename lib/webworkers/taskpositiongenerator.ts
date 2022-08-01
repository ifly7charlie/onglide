/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Epoch, DistanceKM, AltitudeAMSL, AltitudeAgl, Compno, TaskStatus, EstimatedTurnType} from '../types';

import {InOrderGeneratorFunction} from './inordergenerator';
import {PositionMessage} from './positionmessage';

import {Point, Feature, lineString, point as turfPoint} from '@turf/helpers';
import length from '@turf/length';
import distance from '@turf/distance';

import {cloneDeep as _clonedeep} from 'lodash';

import {checkIsInTP, checkIsInStartSector} from '../flightprocessing/taskhelper';

export type TaskPositionGeneratorFunction = (
    task: any,
    pointGenerator: InOrderGeneratorFunction,
    log?: Function
) => Generator<TaskStatus, TaskStatus, void>;

//
// Get a generator to calculate task status
export const taskPositionGenerator = function* (
    task: any,
    pointGenerator: InOrderGeneratorFunction,
    log?: Function
): Generator<TaskStatus, TaskStatus, void> {
    //
    // Make sure we have some logging
    if (!log) log = () => {};

    let status: TaskStatus = {
        t: 0 as Epoch,
        utcStart: null,
        utcFinish: null,
        startFound: false,
        startConfirmed: false
    };

    // If there is supposed to be a grandprix start then we assume it is, we don't
    // actually check they started
    if (task.rules.grandprixstart && task.rules.nostartutc) {
        log('grandprixstart');
        status.utcStart = task.task.nostartutc;
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

    // Helper to save us slicing all the time
    // just take first two turnpoints
    let actualTurnpoints = task.legs.slice(1, 2);

    // Last leg
    const finishLeg = task.legs.length - 1;

    // state for the search
    let insector = false;
    let wasinsector = false;
    let currentLeg: number = 0;

    // How close did we get to current turnpoint
    interface NearestSectorPoint {
        geometry: {
            coordinates: any;
        };
        properties: {t: Epoch; dist: DistanceKM};
    }
    let closestToNext: DistanceKM = 0 as DistanceKM;
    let closestSectorPoint: NearestSectorPoint;

    interface PossibleAdvance {
        nearestSectorPoint: NearestSectorPoint;
        estimatedTurnTime: Epoch;
        rewindTo: Epoch;
    }

    let possibleAdvance: PossibleAdvance | null = null;

    // Shortcut to the startline which is expected to always be the first point
    var startLine = task.legs[0];

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
    for (let iterator = pointGenerator(), current = iterator.next(); !current.done; current = iterator.next()) {
        if (!current.value) {
            return;
        }

        // Keep track of where we are
        previousPoint = point;
        point = current.value;

        // For distance calculations
        point.geoJSON = turfPoint([point.lng, point.lat]);

        // What time have we scored to
        status.t = point.t;

        //
        // Until we confirm the start we will keep seeing if there
        // is a more recent one
        if (!status.startConfirmed) {
            // If there is a specific start time and we are before it then
            // do nothing, if we are after it then it's a confirmed start
            // so we can just accept the time and not do anything else
            if (status.utcStart && !status.startFound) {
                if (point.t < status.utcStart) {
                    continue;
                } else {
                    status.startFound = true;
                    status.startConfirmed = true;
                }
            }
            // normal tasks require some form of sector entry/exit
            // or better still line cross
            // check if we are in the sector
            else if (checkIsInStartSector(startLine, point)) {
                insector = true;

                // If we are in the start sector this is now wrong
                status.utcStart = undefined;
                status.startFound = false;
                log('in start sector ' + point.t);
            }
            // We have left the start sector, remember we are going forward in time
            else if (wasinsector) {
                status.utcStart = point.t;
                status.startFound = true;
                wasinsector = false;
            }

            wasinsector = insector;

            // We don't need to do anything else until we have a start candidate
            // IE: you can't score without a start time
            if (!status.startFound) {
                continue;
            }

            if (currentLeg > 1) {
                status.startConfirmed = true;
            }
        }

        // Otherwise we are evaluating against the rest of the task, this
        // includes checking what turnpoint we are in etc
        const tp = task.legs[currentLeg];

        // Find what point would be closest
        let nearestSectorPoint: NearestSectorPoint;

        // Check if the point is in the next turnpoint and save away the closest point on that sector in case we need it
        const [inSector, inPenalty, distanceRemaining]: [boolean, boolean, DistanceKM] = checkIsInTP(tp, point, nearestSectorPoint);

        // If this point is closer to the sector than the last one then save it away so we can
        // check for doglegs
        if (!closestToNext || (!inSector && distanceRemaining < closestToNext)) {
            closestToNext = distanceRemaining;
            nearestSectorPoint.properties.t = point.t;
            closestSectorPoint = _clonedeep(nearestSectorPoint);
        }

        // Check for the finish, if it is then only one point counts and we can stop tracking
        if (currentLeg == finishLeg) {
            if (inSector) {
                log('* found a finish @ ' + point.t);
                status.utcFinish = point.t;
                // we are done scoring at this point so we can close the iterator and
                // return the status
                return status;
            } else {
                // we must see a point to complete this so nothing to do
                continue;
            }
        }

        // If we have a point in the sector then we should advance on this
        if (inSector) {
            if (task.rules.collectPoints) {
                status.legs[currentLeg].points.push(point);
            }
            if (task.rules.advanceOnEntry && !status.legs[currentLeg].entryTimeStamp) {
                status.legs[currentLeg].entryTimeStamp = point.t;
                status.legs[currentLeg].altitude = point.a;
                log('* next tp:' + currentLeg + '/' + insector);
            }
        }

        // If we have a point in the penalty sector and we don't yet/or ever
        // have a timestamp
        else if (inPenalty) {
            if (!status.legs[currentLeg].entryTimeStamp) {
                if (task.rules.collectPoints) {
                    status.legs[currentLeg].penaltyPoints.push(point);
                }
                if (task.rules.advanceOnEntry) {
                    status.legs[currentLeg].altitude = point.a;
                    status.legs[currentLeg].penaltyTimeStamp = point.t;
                }
            }
        }

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
                const distanceNeeded = length(
                    lineString([point.geoJSON.geometry.coordinates, closestSectorPoint.geometry.coordinates, point.geoJSON.geometry.coordinates])
                );

                const neededSpeed = distanceNeeded / (elapsedTime / 3600); // kph
                const ld = (point.a - previousPoint.a) / distanceNeeded;

                // What kind of speeds do we accept?
                // >10 minutes -> 160kph
                // >2  minutes -> 200kph
                // <2  minutes -> 330kph (final glide - should we confirm height loss?)
                // accept 50% higher with current LD for the glide in the 10 to 35 range - perhaps
                // this should be LD to finish but we don't calculate that till end of points as it's around turnpoints...
                const possibleSpeed = elapsedTime > 600 ? 160 : (ld > 10 && ld < 35 ? 1.5 : 1) * (elapsedTime < 120 ? 330 : 200);

                // Make sure we meet the constrants
                if (neededSpeed < possibleSpeed) {
                    log(
                        `* dog leg ${currentLeg}, ${distanceNeeded.toFixed(1)} km needed, gap length ${elapsedTime} seconds` +
                            ` could have achieved distance in the time: ${neededSpeed.toFixed(1)} kph < ${possibleSpeed} kph (between ${
                                previousPoint.t
                            } and ${point.t}) (ld: ${ld})`
                    );
                    possibleAdvance = {
                        nearestSectorPoint: closestSectorPoint,
                        estimatedTurnTime: Math.round((nearestSectorPoint.properties.dist / distanceNeeded) * elapsedTime + previousPoint.t) as Epoch,
                        rewindTo: point.t
                    };
                } else {
                    log(`- no dog log possible ${neededSpeed.toFixed(1)} kph over ${distanceNeeded.toFixed(1)} km (ld: ${ld}) is too fast`);
                }
            } else {
                log(`- no dog leg, insufficient distance between previous point and this ${interpointDistance.toFixed(2)} km < 0.3 km`);
            }
        }

        // Or are they are further away now,
        if (distanceRemaining > closestToNext + Math.min(task.legs[currentLeg + 1].length * 0.1, 2)) {
            if (possibleAdvance) {
                log(
                    `* using previously identified dogleg advance for sector, estimating turn @ ${possibleAdvance.estimatedTurnTime} and backtracking`
                );
                //
                // backtrack to immediately after the dogleg so we don't miss new sectors if the gap finishes inside the sector or
                // there is only one point between them, we can ignore the point it will be dealt with on next pass of for loop
                iterator.next(possibleAdvance.rewindTo);

                //
                if (task.rules.collectPoints) {
                    status.legs[currentLeg].points.push({
                        c: '' as Compno,
                        t: possibleAdvance.estimatedTurnTime,
                        lat: possibleAdvance.nearestSectorPoint.geometry.coordinates[1],
                        lng: possibleAdvance.nearestSectorPoint.geometry.coordinates[0],
                        a: 0 as AltitudeAMSL,
                        g: 0 as AltitudeAgl
                    });
                }
                status.legs[currentLeg].entryTimeStamp = possibleAdvance.estimatedTurnTime;
                status.legs[currentLeg].estimatedTurn = EstimatedTurnType.dogleg;
                status.legs[currentLeg].altitude = point.a;
            }

            // If we have an entry timestamp then we have turned the turn
            if (status.legs[currentLeg].entryTimeStamp || status.legs[currentLeg].penaltyTimeStamp) {
                currentLeg++;
            }
        }

        yield status;
    }
};
