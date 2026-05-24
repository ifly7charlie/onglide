/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Epoch, PositionStatus, EnrichedPosition, EnrichedPositionGenerator, AirfieldLocation, InOrderGenerator, isTick, DistanceKM} from '../types';

import {point as turfPoint} from '@turf/helpers';
import distance from '@turf/distance';

import {GliderLog, noopGliderLog} from './gliderLog';

// Injected DEM relief lookup. Server scoring chain wires in the real
// getLocalRelief from getelevationoffset (which uses fs/disk caching and
// can't run in the browser). Client/test callers leave it default and get
// the noop — they don't need terrain-aware landout detection. Same pattern
// as the GliderLog dependency above.
export type LocalReliefFn = (lat: number, lng: number, radiusPixels?: number) => Promise<number>;
const noopLocalRelief: LocalReliefFn = async () => -1;

//
// Get a generator to calculate task status
export const enrichedPositionGenerator = async function* (
    airfield: AirfieldLocation,
    pointGenerator: InOrderGenerator,
    _log?: GliderLog,
    _localRelief?: LocalReliefFn
): EnrichedPositionGenerator {
    //
    // Make sure we have some logging
    const log: GliderLog = _log ?? noopGliderLog;
    const localRelief: LocalReliefFn = _localRelief ?? noopLocalRelief;

    let previousPoint: EnrichedPosition | null = null;
    let point: EnrichedPosition | null = null;

    let stationary: boolean | null = null;
    let airborneFound: boolean = false;
    let ridgeRunningDistance: DistanceKM = 0 as DistanceKM;

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
                    // Check to see if it's close to the ground and has been absent for a while, this
                    // most likely indicates a landout
                    let ps = previousPoint.ps;
                    if (ps == PositionStatus.Airborne) {
                        const gapLength = current.value.t - previousPoint.t;
                        log(`epg: ${previousPoint.c} checking for landout on tick gap:${gapLength} agl: ${previousPoint.g} rrd: ${ridgeRunningDistance}`);

                        if (
                            (gapLength > 60 && previousPoint.g < 10) || // acceptable gaps for altitude
                            (gapLength > 120 && previousPoint.g < 25) ||
                            (gapLength > 240 && previousPoint.g < 75) ||
                            (gapLength > 900 && previousPoint.g < 200) ||
                            (gapLength > 2 * 3600 && previousPoint.g < 400) || // 2h silent at modest altitude: assume landed
                            gapLength > 5 * 3600 // 5h silent at any altitude: assume landed
                        ) {
                            if (distance(previousPoint.geoJSON!, airfield.point!) < 5) {
                                ps = airborneFound ? PositionStatus.Home : PositionStatus.Grid;
                                log(`epg: ${previousPoint.c} home/grid: ${ps}`);
                                stationary = true;
                            } else if (gapLength > 2 * 3600) {
                                // 2h silent overrides ridge-running protection — definitely landed
                                log(`epg: ${previousPoint.c} landed out rrd: ${ridgeRunningDistance} (>2h gap)`);
                                ps = PositionStatus.Landed;
                                stationary = true;
                            } else if (ridgeRunningDistance < 2.5) {
                                // Too little tracked low-altitude movement to call it ridge-running.
                                // Fall back to terrain: high local relief (~1.1km window) means
                                // there's ridge-soarable ground at this point, so don't land them
                                // out just because we haven't accumulated rrd yet. Tile is already
                                // RAM-cached from the AGL lookup upstream in aprs.ts.
                                // relief < 0 means the DEM lookup failed — fail flying (don't land
                                // out on a DEM outage).
                                const relief = await localRelief(previousPoint.lat, previousPoint.lng, 20);
                                if (relief > 25 || relief < 0) {
                                    log(`epg: ${previousPoint.c} not landing out: ridge terrain relief ${relief}m (rrd: ${ridgeRunningDistance})`);
                                } else {
                                    log(`epg: ${previousPoint.c} landed out rrd: ${ridgeRunningDistance} relief: ${relief}m`);
                                    ps = PositionStatus.Landed;
                                    stationary = true;
                                }
                            } else {
                                log(`epg: ${previousPoint.c} not landing out due to rrd: ${ridgeRunningDistance}`);
                            }
                        }
                    }

                    // Persist the new status so a subsequent tick or low-altitude position doesn't
                    // re-read the old Airborne value from previousPoint and flip the verdict back.
                    if (ps != previousPoint.ps) {
                        previousPoint = {...previousPoint, ps};
                    }

                    // if (current.value.t - previousPoint.t > 120) {
                    // If we have had a point then we should report tick but with that status
                    nextArg = yield {ps, ...current.value};
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
                log.error(`${previousPoint?.c ?? 'unknown compno'}: ending EPG ${JSON.stringify(point)}, prev: ${JSON.stringify(previousPoint)}`);
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
                        if (distance(point.geoJSON, airfield.point!) < 3) {
                            point.ps = airborneFound ? PositionStatus.Home : PositionStatus.Grid;
                        } else {
                            point.ps = PositionStatus.Landed;
                        }
                    }
                    stationary = true;
                } else {
                    // If we are close to the ground but moving then treat it as ridge running
                    // so we don't land them out by accident
                    ridgeRunningDistance = (ridgeRunningDistance + distanceFromLast) as DistanceKM;
                }
            } else if (point.g > 150) {
                point.ps = PositionStatus.Airborne;
                airborneFound = true;
                ridgeRunningDistance = 0 as DistanceKM;
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
                log(`Completing scoring for ${point.c} as landed out ${JSON.stringify(point)}`);
                return;
            }
        } catch (e) {
            log.error('Exception in enrichedPositionGenerator', e, 'current:', JSON.stringify(point), 'previous:', JSON.stringify(previousPoint));
        }
    }
};
