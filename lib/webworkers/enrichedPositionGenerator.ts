/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Epoch, PositionStatus, EnrichedPosition, EnrichedPositionGenerator, AirfieldLocation, InOrderGenerator, isTick} from '../types';

import {point as turfPoint} from '@turf/helpers';
import distance from '@turf/distance';

import {cloneDeep as _clonedeep} from 'lodash';

//
// Get a generator to calculate task status
export const enrichedPositionGenerator = async function* (airfield: AirfieldLocation, pointGenerator: InOrderGenerator, log?: Function): EnrichedPositionGenerator {
    //
    // Make sure we have some logging
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    let previousPoint: EnrichedPosition | null = null;
    let point: EnrichedPosition | null = null;

    let stationary: boolean | null = null;
    let airborneFound: boolean = false;

    let nextArg: Epoch | void = void false; // we may be asked to rewind and if we are then we should do so by passing this into iterator.next

    //
    // Loop reading the next point - this will block until a point
    // is available so no need to keep track of anything else except
    // where in the task we are. At the end of each loop we will
    // yield with the status object so the downstream scorer can process
    // properly. If it's not suitable to yield then call continue to wait
    // for next point
    for (let current = await pointGenerator.next(); !current.done; current = await pointGenerator.next(nextArg)) {
        if (!current.value) {
            break;
        }
        try {
            //  If we get a tick and it's been long enough then we will send it on as a tick
            if (isTick(current.value)) {
                if (!previousPoint) {
                    // If we have not had a point then we are unknown
                    nextArg = yield {ps: PositionStatus.Unknown, ...current.value};
                    continue;
                } else {
                    // if (current.value.t - previousPoint.t > 120) {
                    // If we have had a point then we should report tick but with that status
                    nextArg = yield {ps: previousPoint.ps, ...current.value};
                    continue;
                } //else {
                // don't tick too often and don't try and process a tick as it has no coordinates
                //                    console.log('supressing tick due to time', current.value.t, previousPoint.t);
                //                    continue;
                //                }
            }

            // Keep track of where we are
            point = current.value as EnrichedPosition;
            stationary = false;

            if (!point.lng) {
                console.log(`${previousPoint?.c ?? 'unknown compno'}: ending EPG ${point}, prev: ${previousPoint}`);
                return;
            }

            // For distance calculations
            point.geoJSON = turfPoint([point.lng, point.lat]);

            // If we have gone back in time then do nothing just
            // pass the point on and reset ourselves
            if (nextArg) {
                point.ps = PositionStatus.Unknown;
                previousPoint = null;
                stationary = false;
                nextArg = yield point;
                continue;
            }

            // We can't do any more without a previous point
            if (!previousPoint) {
                point.ps = point.g >= 150 ? PositionStatus.Airborne : PositionStatus.Grid;
                previousPoint = point;
                stationary = false;
                nextArg = yield point;
                continue;
            }

            // Until it changes we are the same
            point.ps = previousPoint.ps;

            // Close to the ground 50m and we think we were flying
            if (point.g < 50) {
                // Check for movements
                const distanceFromLast = distance(point.geoJSON, previousPoint.geoJSON!);
                if (distanceFromLast < 0.012) {
                    // And enough elapsed time
                    if (point.t - previousPoint.t > 60) {
                        // And if it's at home or somewhere else
                        if (distance(point.geoJSON, airfield.point!) < 2) {
                            point.ps = airborneFound ? PositionStatus.Home : PositionStatus.Grid;
                        } else {
                            point.ps = PositionStatus.Landed;
                        }
                    }
                    stationary = true;
                }
            } else if (point.g > 150) {
                point.ps = PositionStatus.Airborne;
                airborneFound = true;
            }

            // We don't forward points from grid or home, but we always want to forward
            // status changes
            // Don't save if we are not moving except if the status changes
            // Also ensure we yield the point if it's the end of the replay packets
            // otherwise we may never generate the initial score
            if (!stationary || previousPoint.ps != point.ps || point._ != previousPoint._) {
                nextArg = yield point;
                previousPoint = point;
            }

            // If pilot has landed and not at home then we can stop scoring altogether
            if (point.ps == PositionStatus.Landed) {
                console.log(`Completing scoring for ${point.c} as landed out ${JSON.stringify(point)}`);
                return;
            }
        } catch (e) {
            console.log('Exception in enrichedPositionGenerator');
            console.log(e);
            console.log('current:', JSON.stringify(point), 'previous:', JSON.stringify(previousPoint));
        }
    }
};
