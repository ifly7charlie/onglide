/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Compno, Epoch, DistanceKM, BasePositionMessage, EnrichedPosition, EnrichedPositionGenerator, AirfieldLocation, InOrderGeneratorFunction} from '../types';

import {Point, Feature, lineString, point as turfPoint} from '@turf/helpers';
import length from '@turf/length';
import distance from '@turf/distance';

import {cloneDeep as _clonedeep} from 'lodash';

//
// Get a generator to calculate task status
export const positionMessageStatusGenerator = async function* (airfield: AirfieldLocation, pointGenerator: InOrderGeneratorFunction, log?: Function): PositionMessageStatusGenerator {
    //
    // Make sure we have some logging
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    let previousPoint: EnrichedPosition | null = null;
    let point: EnrichedPosition | null = null;

    let stationary: boolean | null = null;
    let recentTrack: Feature<Point>[] | null = null;
    //
    // Loop reading the next point - this will block until a point
    // is available so no need to keep track of anything else except
    // where in the task we are. At the end of each loop we will
    // yield with the status object so the downstream scorer can process
    // properly. If it's not suitable to yield then call continue to wait
    // for next point
    let iterator = pointGenerator(log);
    for (let current = await iterator.next(); !current.done; current = await iterator.next()) {
        if (!current.value) {
            break;
        }
        try {
            // Keep track of where we are
            point = current.value;
            stationary = false;

            // For distance calculations
            point.geoJSON = turfPoint([point.lng, point.lat]);

            // If we have gone back in time then do nothing just
            // pass the point on and reset ourselves
            if( point.t < (previousPoint?.t||0) ) {
                point.ps = PositionStatus.Unknown;
                previousPoint = null;
                yield point;
                continue;
            }

            point.ps = PositionStatus.Airborne;

            // Close to the ground 50m and we think we were flying
            if( point.g < 50 && previousPoint.ps == PositionStatus.Airborne ) {

                // Check for movements
                const distanceFromLast = distance(point.geoJSON, previousPoint.geoJSON) : 1;
                if (distanceFromLast < 0.02) {
                    // And enough elapsed time
                    if (point.t - previousPoint.t > 60) {
                        // And if it's at home or somewhere else
                        if( distance( point.geoJSON, airfield.point ) < 0.5 ) {
                            point.ps = PositionStatus.Home;
                        }
                        else {
                            point.ps = PositionStatus.Landed;
                        }
                    }
                    stationary = true;
                }
            }

            if( ! stationary ) {
                previousPoint = point;
            }

            // If we are live then we should return the scoring
            yield point;
        } catch (e) {
            console.log('Exception in flightStatusGenerator');
            console.log(e);
            console.log(JSON.stringify(current));
        }
    }
};
