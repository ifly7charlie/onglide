/*
 * This is a generator that listens to an inorder packet stream and figures out where in the task a
 * glider is. It then yields information about the task so far upstream for the scoring
 * generator to actually process
 *
 */

import {Compno, Epoch, DistanceKM, BasePositionMessage, PositionMessage, TaskStatus, EstimatedTurnType, Task, PositionStatus, EnrichedPositionGenerator, EnrichedPosition, isEnrichedTick} from '../types';

import {stripPoints} from '../flightprocessing/taskhelper';
import {PreparedTurnpoint} from '../flightprocessing/preparedTurnpoint';

import {RELAXED_START_TOLERANCE_M} from '../constants';

//export type TaskPositionGeneratorFunction = (task: Task, pointGenerator: InOrderGeneratorFunction, log?: Function) => AsyncGenerator<TaskStatus, void, void>;

function simplifyPoint(point: PositionMessage | BasePositionMessage): BasePositionMessage {
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

    let lastTickStatus: TaskStatus | null = null;
    let status: TaskStatus = null;
    // Relaxed start line detection state
    let relaxedStartCandidate: {crossing: {entered: boolean; left: boolean; at: BasePositionMessage}; beyondM: number; distToTP1: DistanceKM} | null = null;
    let closestDistToStartLine: DistanceKM = Infinity as DistanceKM;

    interface PossibleAdvance {
        possiblePoints: BasePositionMessage[];
        rewindTo: Epoch;
        estimatedTurnType: EstimatedTurnType;
        ld: number;
    }
    let possibleAdvances: PossibleAdvance[] = [];

    // Reset everything related to the current task
    function resetStart() {
        relaxedStartCandidate = null;
        closestDistToStartLine = Infinity as DistanceKM;
        possibleAdvances = [];
        status = {
            compno: status?.compno || ('init' as Compno),
            t: status?.t || (0 as Epoch),
            flightStatus: status?.flightStatus || PositionStatus.Unknown,
            utcStart: officialStart || null,
            utcFinish: null,
            startFound: false,
            startConfirmed: false,
            currentLeg: 0,
            closestDistanceToNext: Infinity as DistanceKM,
            closestDistanceToTPCenter: Infinity as DistanceKM,
            inSector: false,
            inPenalty: false,
            pointsProcessed: status?.pointsProcessed || 0,
            lastProcessedPoint: status?.lastProcessedPoint,
            legs: task.legs.map((l) => {
                return {legno: l.legno, points: [], penaltyPoints: []};
            })
        };
        return status;
    }
    resetStart();

    const legs = task.preparedLegs;
    if (!legs) {
        return;
    }

    // If there is supposed to be a grandprix start then we assume it is, we don't
    // actually check they started
    let grandPrixStart = task.rules.grandprixstart && task.rules.nostartutc;

    // state for the search
    let landedBack = false;

    // Shortcut to the startline/finishline which is expected to always be the first/last points
    var startLine = legs[0];
    const finishLeg = task.legs.length - 1;

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
            // Queue information & copy glider through
            status._ = current.value._;
            status.compno = current.value.c as Compno;

            // We pass ticks through and then do nothing more
            if (isEnrichedTick(current.value)) {
                // Copy any changes to flight status across
                status.flightStatus = current.value.ps;
                // Now see if things have changed
                const progress = (status?.closestDistanceToNext ?? 0) - (lastTickStatus?.closestDistanceToNext ?? 0);
                let ok =
                    !lastTickStatus?.closestDistanceToNext ||
                    lastTickStatus.closestDistanceToNext > 0 ||
                    status.flightStatus != lastTickStatus.flightStatus ||
                    status.currentLeg != lastTickStatus.currentLeg ||
                    (progress < 0 && -progress / lastTickStatus.closestDistanceToNext / lastTickStatus.closestDistanceToNext > 0.1) || // 10% of remaining distance at least
                    (task.rules.aat && (status.inPenalty || status.inSector));

                if (ok) {
                    log('ok tick on isTick', status);
                    if (previousPoint) {
                        status.lastProcessedPoint = simplifyPoint(previousPoint);
                    }
                    let startIsCloseOrPassed = status.t + 59 > (status.utcStart ?? 0);
                    if (lastTickStatus && !startIsCloseOrPassed && !status._) {
                        continue;
                    }
                    lastTickStatus = structuredClone(status);
                    yield {...status, tick: true} as any;
                }
                continue;
            }

            // What time have we scored to, we don't update this on a tick otherwise we will
            // have an old score with a new t and things may end up out of order in the UI
            status.t = current.value.t;

            // Keep track of where we are
            previousPoint = point;
            point = current.value;

            status.pointsProcessed++;
            status.lastProcessedPoint = simplifyPoint(point);

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

            // Can't score with only one point
            if (!previousPoint) {
                continue;
            }

            // Helper
            let legStatus = status.legs[status.currentLeg]!;

            //
            // Until we confirm the start we will keep seeing if there
            // is a more recent one
            if (!status.startConfirmed) {
                // If there is a specific start time and we are before it then
                // do nothing,
                if (point.t < task.rules.nostartutc - 10) {
                    if (point._) {
                        yield status;
                    }
                    continue;
                }

                // If the pilot has a specific utcStart time already then
                // ignore before - this can happen if scored into soaringspot
                if (status.utcStart && point.t < status.utcStart) {
                    if (point._) {
                        yield status;
                    }
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
                    status.legs[0].points = [{t: status.utcStart, lat: task.legs[0].nlat, lng: task.legs[0].nlng, a: (previousPoint || point).a}];
                    status.legs[0].exitTimeStamp = status.utcStart;

                    console.log(point.c, 'start reached', new Date(point.t * 1000).toISOString());

                    // If we were not tracking at the start then we can assume a start point at the
                    // start point... this will allow dog leg etc to calculate and may help with 'recovery'
                    if (!previousPoint) {
                        previousPoint = {...status.legs[0].points[0], ps: PositionStatus.Airborne, c: point.c, g: 0, a: 0};
                    }

                    if (point._) {
                        yield status;
                    }
                    continue;
                }
                // normal tasks require some form of sector entry/exit
                // or better still line cross
                // check if we are in the sector
                else {
                    const hc = startLine.hasCrossed(previousPoint, point);

                    // Track closest perpendicular approach to the start line
                    if (hc.distanceKm !== undefined && hc.distanceKm < closestDistToStartLine) {
                        closestDistToStartLine = hc.distanceKm;
                    }

                    if ((hc.distanceKm ?? Infinity) < 0.2 || hc.everInside) log('startline:', hc.everInside, 'crossings:', hc.crossings.length, 'dist:', hc.distanceKm?.toFixed(3));
                    if (hc.everInside) {
                        if (!hc.finalInside) {
                            // for starts it's always the last crossing that matters
                            resetStart();
                            status.legs[0].points = [simplifyPoint(hc.crossings.at(-1)?.at!)];
                            status.startFound = true;
                            status.currentLeg = 1;
                            status.utcStart = status.legs[0].exitTimeStamp = status.legs[0].points[0].t;
                            relaxedStartCandidate = null; // strict takes priority
                            if (point._) {
                                yield status;
                            }
                        } else {
                            // if we are entering then we can reset - this only works for sectors not lines
                            // lines can never have finalInside set
                            resetStart();
                            continue;
                        }
                    }
                    // Relaxed start line detection: near-miss crossing beyond finite extent
                    else if (
                        !status.startFound &&
                        startLine.leg.type === 'line' &&
                        hc.nearMissBeyondM !== undefined &&
                        hc.nearMissBeyondM <= RELAXED_START_TOLERANCE_M &&
                        hc.nearMissCrossing &&
                        closestDistToStartLine < 2.0 // pilot was near the line at some point
                    ) {
                        const distToTP1 = (legs[1]?.fromSector(point) ?? Infinity) as DistanceKM;
                        relaxedStartCandidate = {
                            crossing: hc.nearMissCrossing,
                            beyondM: hc.nearMissBeyondM,
                            distToTP1
                        };
                        log(`relaxed start candidate: beyond=${hc.nearMissBeyondM.toFixed(0)}m, distToTP1=${distToTP1.toFixed(1)}`);
                    }
                    // Confirm a relaxed start candidate: pilot moving toward TP1
                    else if (!status.startFound && relaxedStartCandidate) {
                        const distToTP1 = (legs[1]?.fromSector(point) ?? Infinity) as DistanceKM;
                        if (distToTP1 < relaxedStartCandidate.distToTP1 - 0.5) {
                            // Pilot is closer to TP1 → accept the relaxed start
                            log(`relaxed start ACCEPTED: beyond=${relaxedStartCandidate.beyondM.toFixed(0)}m, distToTP1 ${relaxedStartCandidate.distToTP1.toFixed(1)}->${distToTP1.toFixed(1)}`);
                            status.legs[0].points = [simplifyPoint(relaxedStartCandidate.crossing.at)];
                            status.legs[0].estimatedTurn = EstimatedTurnType.dogleg;
                            status.startFound = true;
                            status.currentLeg = 1;
                            status.utcStart = status.legs[0].exitTimeStamp = status.legs[0].points[0].t;
                            relaxedStartCandidate = null;
                            if (point._) {
                                yield status;
                            }
                        } else if (distToTP1 > relaxedStartCandidate.distToTP1 + 2.0) {
                            // Pilot moving away from TP1 → reject candidate
                            log(`relaxed start candidate rejected: pilot moving away from TP1`);
                            relaxedStartCandidate = null;
                        }
                    }
                }

                // We don't need to do anything else until we have a start candidate
                // IE: you can't score without a start time
                if (!status.startFound) {
                    if (point._) {
                        yield status;
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
                const distFromPrevious = legs[status.recentLegAdvance].fromSector(point) ?? 0;
                log(`checking recentLegAdvance: ${distFromPrevious} dist, ${status.recentLegAdvance}tp`);
                if (distFromPrevious <= 0) {
                    log(`re-entry of AAT sector ${status.recentLegAdvance} at ${point.t}, ${distFromPrevious}`);
                    status.currentLeg = status.recentLegAdvance;
                    legStatus = status.legs[status.currentLeg];

                    // we are now inside...
                    status.closestDistanceToNext = Infinity as DistanceKM;
                    status.closestDistanceToTPCenter = Infinity as DistanceKM;
                    possibleAdvances = [];
                    delete status.closestToNextSectorPoint;
                    delete status.closestToTPCenterPoint;
                } else if (distFromPrevious > Math.min(task.legs[status.currentLeg]?.length * 0.1, 10)) {
                    status.recentLegAdvance = 0;
                }
            }

            // Otherwise we are evaluating against the rest of the task, this
            // includes checking what turnpoint we are in etc
            const tp = legs[status.currentLeg];

            const setClosest = (point: BasePositionMessage) => {
                // Find what point would be closest
                const hc = legs[status.currentLeg].hasCrossed(point, point);
                const distanceRemaining = hc.distanceKm as DistanceKM | undefined;

                // If this point is closer to the sector than the last one then save it away so we can
                // check for doglegs
                if (distanceRemaining) {
                    status.closestDistanceToNext = (Math.round(distanceRemaining * 10) / 10) as DistanceKM;
                    status.closestToNextSectorPoint = simplifyPoint(point);
                    status.closestSectorPoint = hc.onBoundary;
                } else {
                    // Nowhere else to go as we are in the sector...
                    status.closestDistanceToNext = Infinity as DistanceKM;
                    status.closestDistanceToTPCenter = Infinity as DistanceKM;
                    delete status.closestToNextSectorPoint;
                    delete status.closestSectorPoint;
                    delete status.closestToTPCenterPoint;
                }
            };

            // Find what point would be closest
            const hc = tp.hasCrossed(previousPoint, point);

            const inSector = (status.inSector = hc.everInside);
            const inPenalty = (status.inPenalty = !inSector && hc.distanceKm! < 0.5);
            const distanceRemaining = hc.distanceKm as DistanceKM;

            // If this point is closer to the sector than the last one then save it away so we can
            // check for doglegs
            if (!inSector && !inPenalty && distanceRemaining < status.closestDistanceToNext!) {
                status.closestDistanceToNext = (Math.round(distanceRemaining * 10) / 10) as DistanceKM;
                status.closestToNextSectorPoint = simplifyPoint(point);
                status.closestSectorPoint = hc.onBoundary;
            }

            // Also track closest approach to TP center (for FAI landout scoring which uses
            // distance to Turn Point, not to observation zone boundary)
            if (!inSector && !inPenalty) {
                const tpCenter = {lat: task.legs[status.currentLeg].nlat, lng: task.legs[status.currentLeg].nlng} as BasePositionMessage;
                const distToCenter = PreparedTurnpoint.geodesicDistance(point, tpCenter);
                if (distToCenter < (status.closestDistanceToTPCenter ?? Infinity)) {
                    status.closestDistanceToTPCenter = (Math.round(distToCenter * 10) / 10) as DistanceKM;
                    status.closestToTPCenterPoint = simplifyPoint(point);
                }
            }

            // Check for the finish, if it is then only one point counts and we can stop tracking
            if (status.currentLeg == finishLeg) {
                const crossing = hc.crossings[0];
                if (inSector && crossing) {
                    log(`* found a finish between ${previousPoint.t} and ${point.t} @ ${crossing.at.t}`);
                    status.utcFinish = crossing.at.t;
                    status.flightStatus = PositionStatus.Finished;
                    legStatus.entryTimeStamp = crossing.at.t;
                    legStatus.altitude = crossing.at.a;
                    legStatus.points = [{t: point.t, a: point.a, lat: tp.leg.nlat, lng: tp.leg.nlng}]; // explicity set to center?

                    // explicity mark it as 'live' as it is a finish and the end of the flight
                    // so we don't want to miss it.
                    status._ = true;

                    // Nowhere else to go
                    status.closestDistanceToNext = Infinity as DistanceKM;
                    status.closestDistanceToTPCenter = Infinity as DistanceKM;
                    delete status.closestToNextSectorPoint;
                    delete status.closestToTPCenterPoint;
                    // we are done scoring at this point so we can close the iterator and
                    // return to complete scoring
                    yield status;
                    return;
                } else {
                    // we must see a point to complete this so nothing to do
                    if (point._) {
                        yield status;
                    }
                    continue;
                }
            }

            // If we have a point in the sector then we should advance on this
            if (inSector) {
                legStatus.penaltyPoints = [];
                if (task.rules.aat) {
                    if (hc.finalInside) {
                        // If the point is actually inside then use it
                        legStatus.points.push(simplifyPoint(point));
                    } else {
                        // If it isn't then add a point for every crossing
                        legStatus.points.push(...hc.crossings.map((c) => c.at));
                    }
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
                status.closestDistanceToNext = Infinity as DistanceKM;
                status.closestDistanceToTPCenter = Infinity as DistanceKM;
                possibleAdvances = [];
                delete status.closestToNextSectorPoint;
                delete status.closestToTPCenterPoint;
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
                    if (task.rules.aat) {
                        // Make sure we have actually left the sector and passed a small distance from the TP before
                        // assuming advance. AAT is longer otherwise a brief pop out will ignore points after
                        // however need to cope with short legs (control points for example)
                        log(`setting a advance`, point);
                        status.recentLegAdvance = status.currentLeg;
                    }
                    status.currentLeg++;
                    legStatus = status.legs[status.currentLeg];
                    setClosest(point);
                    possibleAdvances = [];
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
                    const interpointDistance = tp.interpointDistance(previousPoint, point);

                    // Make sure that they have actually moved between the two points, 250m should be enough
                    // as it's a bit more than a thermal circle. This should stop us picking up a jump when
                    // they are stationary with a gap, we also check for other reasons such as altitude
                    // change or longer gaps
                    if (interpointDistance > 0.25 || Math.abs(point.a - previousPoint.a) > 100 || elapsedTime > 70) {
                        //
                        // Check for intersection of the line and the turnpoint - this happens if there is a point on either side
                        const crossings = hc.crossings;
                        if (crossings.length >= 2) {
                            log(`* turnpoint ${status.currentLeg} intersection between ${previousPoint.t} and ${point.t} `);
                            if (!task.rules.aat) {
                                possibleAdvances.push({
                                    possiblePoints: [hc.crossings.at(0)!.at],
                                    estimatedTurnType: EstimatedTurnType.crossing,
                                    rewindTo: point.t,
                                    ld: 0
                                });
                                // If we are not an AAT then we only take the first point
                                break;
                            } else {
                                possibleAdvances.push({
                                    possiblePoints: hc.crossings.map((c) => c.at),
                                    estimatedTurnType: EstimatedTurnType.crossing,
                                    rewindTo: point.t,
                                    ld: 0
                                });
                            }

                            // Otherwise check for a dogleg
                        } else {
                            // How far from previous point, to closest point on sector to current point
                            // NOTE: this is closest point from most recent not from previous which is
                            //       slightly wrong as you turn a turnpoint on entry not departure
                            //       but we are just making sure they could have put a point in the
                            //       sector so I'm not sure it matters
                            const distanceNeeded = tp.interpointDistance(previousPoint, hc.onBoundary!) + distanceRemaining;

                            const neededSpeed = distanceNeeded / (elapsedTime / 3600); // kph
                            const ld = (point.a - previousPoint.a) / distanceNeeded;

                            // What kind of speeds do we accept?
                            // >10 minutes -> 160kph
                            // >2  minutes -> 210kph
                            // <2  minutes -> 330kph (final glide - should we confirm height loss?)
                            // accept 50% higher with current LD for the glide in the 10 to 35 range - perhaps
                            // this should be LD to finish but we don't calculate that till end of points as it's around turnpoints...
                            const possibleSpeed = elapsedTime > 600 ? 180 : (ld > 10 && ld < 35 ? 1.5 : 1) * (elapsedTime < 120 ? 330 : 210);

                            // Make sure we meet the constrants
                            if (neededSpeed < possibleSpeed) {
                                log(
                                    `* dog leg ${status.currentLeg}, ${distanceNeeded.toFixed(1)} km needed, gap length ${elapsedTime} seconds` +
                                        ` could have achieved distance in the time: ${neededSpeed.toFixed(1)} kph < ${possibleSpeed} kph (between ${previousPoint.t} and ${point.t}) (ld: ${ld})`
                                );
                                const possibleT = Math.round(point.t - (distanceRemaining / distanceNeeded) * elapsedTime) as Epoch;
                                possibleAdvances.push({
                                    possiblePoints: [{...hc.onBoundary!, t: possibleT}],
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
                if (possibleAdvances.length && distanceRemaining > (status.closestDistanceToNext ?? 0) + Math.min(task.legs[status.currentLeg + 1]?.length * 0.1, 2)) {
                    // We pick the advance based on - lowest ld
                    const advanceChosen = possibleAdvances.sort((paA, paB) => paA.ld - paB.ld)[0];
                    log(
                        `* using previously identified ${advanceChosen.estimatedTurnType} advance for sector, estimating turn @ ${advanceChosen.possiblePoints[0].t} [1 of ${possibleAdvances.length} candidates] and backtracking`
                    );

                    legStatus.points.push(...advanceChosen.possiblePoints);

                    legStatus.exitTimeStamp = advanceChosen.possiblePoints[advanceChosen.possiblePoints.length - 1].t;
                    legStatus.entryTimeStamp = advanceChosen.possiblePoints[0].t;
                    legStatus.estimatedTurn = advanceChosen.estimatedTurnType;

                    // Just in case we missed more than one turn we set point to be the advance and then rewind to the end of the
                    // gap - this allows us to do several advances in a row but the timing will get messed up as it
                    // doesn't spread the speeds over the total range well, but it does calculate the proprotion of the first
                    // dogleg so may be good enough - don't advance past more than 2
                    if (!status.legs[status.currentLeg - 1].estimatedTurn) {
                        point = {...point, ...advanceChosen.possiblePoints.at(-1), g: 0} as EnrichedPosition;
                    }

                    // reset for next leg
                    status.currentLeg++;
                    possibleAdvances = [];

                    // Make sure we have a calculated closest point
                    setClosest(point);

                    //
                    // backtrack to immediately after the dogleg so we don't miss new sectors if the gap finishes inside the sector or
                    // there is only one point between them, we can ignore the point it will be dealt with on next pass of for loop
                    iterator.next(advanceChosen.rewindTo);
                }
            }

            // If we are live we only score so often
            if (point._) {
                log(status);
                yield status;
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
    yield {...status, tick: true, _: true} as any;
};
