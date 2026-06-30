import type {Compno, AltitudeAgl, TaskScoresGenerator, CalculatedTaskGenerator, CalculatedTaskLegStatus, Task, DistanceKM, SpeedKPH} from '../types';
import {PositionStatus} from '../types';

import {PilotScore, PilotScoreLeg, SpeedDist} from '../protobuf/onglide';
import {distHaversineRaw} from '../flightprocessing/taskhelper';
import {GliderLog} from './gliderLog';

//
function copyPick(d, o, ...props) {
    return Object.assign(d, ...props.map((prop) => ({[prop]: o[prop]})));
}

function selectPick(o, ...props) {
    return props.map((prop) => ({[prop]: o[prop]}));
}

//export function everySoOftenGenerator<Type extends TimeStampType> *(interval: Epoch, input: SoftenGenerator<Type>): SoftenGenerator<Type> {
export const taskScoresGenerator = async function* (task: Task, compno: Compno, handicap: number, input: CalculatedTaskGenerator, log: GliderLog): TaskScoresGenerator {
    // Helper for handicapping
    function calcHandicap(dist) {
        return Math.round((1000.0 * dist) / handicap) / 10;
    }

    const doSpeedCalc = (sd: SpeedDist | undefined, legDuration: number | undefined, taskDuration: number) => {
        if (!sd) {
            return;
        }
        if (legDuration && sd.distance) {
            sd.legSpeed = Math.max(0, Math.round(sd.distance / (legDuration / 36000)) / 10);
        }
        if (taskDuration) {
            sd.taskSpeed = Math.max(Math.round(sd.taskDistance / (taskDuration / 36000)) / 10);
        }
    };

    const doGrCalc = (sd: SpeedDist | null | undefined, agl: AltitudeAgl) => {
        if (sd && agl > 0) {
            sd.grRemaining = Math.round((sd.distanceRemaining || sd.minPossible || 0) / (agl / 1000));
        }
    };

    const doHandicapping = !task.rules.handicapped
        ? () => {}
        : (container: PilotScore | PilotScoreLeg) => {
              // Make sure we have a holder for it
              if (!container.handicapped) {
                  container.handicapped = {taskDistance: 0};
              }
              const handicapped = container.handicapped;

              // Calculate the handicapped distances from the actuals
              for (const i of ['distance', 'taskDistance', 'distanceRemaining', 'maxPossible', 'minPossible']) {
                  if (i in container.actual) {
                      handicapped[i] = calcHandicap(container.actual[i]);
                  }
              }

              //
              handicapped.taskSpeed = Math.round(handicapped.taskDistance / (container.taskDuration / 36000)) / 10;
          };

    //
    // Loop till we are told to stop
    for (let current = await input.next(); !current.done && current.value; current = await input.next()) {
        const item = current.value;
        if (!item) {
            log.error(`TSG: no value received in iterator for ${compno}`, current);
            return;
        }

        // We will get called every time a calculation is ready for final scoring.
        // Our job is to calculate & populate the structure that goes to the front end
        //
        const score: PilotScore = {
            t: item.t,
            live: item._ ?? false,
            compno: compno,

            utcStart: item.utcStart ?? 0,
            utcFinish: item.utcFinish ?? 0,
            flightStatus: item.flightStatus,
            inSector: item.inSector,
            inPenalty: item.inPenalty,

            currentLeg: item.currentLeg,

            actual: {
                taskDistance: 0 as DistanceKM,
                taskSpeed: 0 as SpeedKPH
            },

            // We will fill these in as we go
            legs: {},
            scoredPoints: [],
            minDistancePoints: [],
            maxDistancePoints: [],
            // preparedTurnpoint marks synthetic boundary points with t: -pos.t (debug marker);
            // the maxGraph also uses sentinel negative times for turnpoint/finish nodes. The wire
            // format only carries the absolute epoch — Math.abs strips the sign before encoding.
            scoringClosestPoint: item.scoringClosestPoint ? {t: Math.abs(item.scoringClosestPoint.t), lat: item.scoringClosestPoint.lat, lng: item.scoringClosestPoint.lng} : undefined,
            optimalNextSectorPoint: item.optimalNextSectorPoint ? {t: Math.abs(item.optimalNextSectorPoint.t), lat: item.optimalNextSectorPoint.lat, lng: item.optimalNextSectorPoint.lng} : undefined,
            optimalGrid: item.optimalGrid?.length ? item.optimalGrid : [],
            optimalGridBaseline: item.optimalGridBaseline,
            optimalGridBaselinePath: item.optimalGridBaselinePath ?? [],
            suggestedTrackPoints: item.suggestedTrackPoints ?? []
        };

        // If we have no start we may have had a tick we should just pass it through and ignore
        if (!item.utcStart) {
            yield score;
            continue;
        }

        let previousLeg: CalculatedTaskLegStatus | null = null;
        for (const leg of item.legs) {
            // For the time of the leg we use:
            // 1. AAT specific turnpoint time
            // 2. The entry to the TP
            // 3. the exit from the TP (ie startLine)
            // AAT min/max graphs use negative sentinel timestamps (e.g. -999999 for the synthetic
            // start point in assignedAreaScoringGenerator); treat anything <= 10000 as not-a-real-time.
            const validTime = (t: number | undefined | null) => (typeof t === 'number' && t > 10000 ? t : 0);
            const legTime = (leg) => validTime(leg.entryTimeStamp ? leg.point?.t : 0) || validTime(leg.entryTimeStamp) || validTime(leg.exitTimeStamp);

            leg.convexHull ??= [];

            // Proper turnpoint - startPoint doesn't count
            if (previousLeg) {
                const sl: PilotScoreLeg = (score.legs[leg.legno] = {
                    legno: leg.legno,
                    time: legTime(previousLeg),
                    estimatedStart: previousLeg?.estimatedTurn ? true : false,
                    estimatedEnd: leg.estimatedTurn ? true : false,
                    convexHull: !leg.convexHull?.length ? [] : leg.convexHull
                });

                // Figure out actuals for the leg/copy them over
                sl.actual = {
                    distance: Math.max(Math.round(leg.distance * 10) / 10, 0),
                    taskDistance: Math.round(((score.legs[leg.legno - 1]?.actual?.taskDistance || 0) + Math.max(leg.distance, 0)) * 10) / 10
                };
                if (previousLeg?.point?.a && isFinite(previousLeg.point.a)) {
                    sl.alt = Math.round(previousLeg.point.a);
                }
                if (!score.utcFinish) {
                    if (leg.minPossible) {
                        sl.actual.minPossible = Math.round((leg.minPossible?.distance ?? 0) * 10) / 10;
                    }
                    if (leg.maxPossible) {
                        sl.actual.maxPossible = Math.round(leg.maxPossible.distance * 10) / 10;
                    }
                    if (leg.distanceRemaining || leg.minPossible) {
                        sl.actual.distanceRemaining = Math.round((leg.distanceRemaining || leg.minPossible?.distance || 0) * 10) / 10;
                    }
                }

                doHandicapping(sl);
                doGrCalc(sl.actual, (sl.alt ?? 0) - (leg.altitude ?? 0));
                doGrCalc(sl.handicapped, (sl.alt ?? 0) - (leg.altitude ?? 0));

                // If we don't have a time then it's because we are in progress, don't use leg.point as that's scored
                // and may have fake time for AATs use the actual time we are scored to which is in item.t
                const currentLegTime = legTime(leg);
                if (sl.time) {
                    const endT = currentLegTime || item.t;
                    if (endT >= sl.time) sl.duration = endT - sl.time;
                    if (item.utcStart && endT >= item.utcStart) sl.taskDuration = endT - item.utcStart;
                }

                // And now do speeds
                doSpeedCalc(sl.actual, sl.duration, sl.taskDuration);
                doSpeedCalc(sl.handicapped, sl.duration, sl.taskDuration);
            }
            // otherwise we are start leg
            else {
                score.legs[leg.legno] = {
                    legno: leg.legno,
                    time: validTime(leg.point?.t) || validTime(leg.exitTimeStamp),
                    convexHull: []
                };
            }

            // Output points for construction lines
            {
                const sl: PilotScoreLeg = score.legs[leg.legno];

                if (leg.point) {
                    score.scoredPoints.push(leg.point.lng, leg.point.lat, sl.actual?.distance || 0, sl.handicapped?.distance || 0);
                }
                if (!score.utcFinish) {
                    if (leg.minPossible && leg.legno >= item.currentLeg - (item.inSector ? 0 : 1)) {
                        score.minDistancePoints.push(leg.minPossible.point.lng, leg.minPossible.point.lat, sl.actual?.minPossible || 0, sl.handicapped?.minPossible || 0);
                    }
                    if (leg.maxPossible && leg.legno >= item.currentLeg - 1) {
                        score.maxDistancePoints.push(leg.maxPossible.point.lng, leg.maxPossible.point.lat, sl.actual?.maxPossible || 0, sl.handicapped?.maxPossible || 0);
                    }
                    //                    if (item.closestSectorPoint) {
                    //                        score.closestSectorPoint = [item.closestSectorPoint.lng, item.closestSectorPoint.lat];
                    //                    }
                }
            }

            // And move on
            previousLeg = leg;
        }

        //
        // Task overalls. utcStart can be set from task.rules.nostartutc before the pilot
        // actually crosses the start, so a tick from before nostartutc would compute a
        // negative duration. Treat that as "no duration yet" — leave taskDuration absent.
        const endT = item.utcFinish || item.t;
        const haveDuration = item.utcStart && endT && endT >= item.utcStart;
        let duration = haveDuration ? endT - item.utcStart : 0;

        // AAT (or min duration tasks) with duration configured and a finish we need to make sure
        // it took longer than task time - only do this after finish as it's misleading while they
        // are flying - perhaps it should be done if they are obviously going to be under
        if (haveDuration && task.details.durationsecs) {
            score.taskTimeRemaining = duration - task.details.durationsecs;
            if (item.utcFinish) {
                duration = Math.max(duration, task.details.durationsecs);
            }
        }

        score.actual = {
            taskDistance: Math.max(item.distance, 0)
        };
        if (haveDuration) score.taskDuration = duration;

        // Looks weird but take it if it is there, if it isn't then take the alternative
        // AAT uses all three, racing uses dR
        score.actual.distanceRemaining = Math.round((item.distanceRemaining ?? item.minPossible ?? 0) * 10) / 10;
        score.actual.minPossible = Math.round((item.minPossible ?? item.distanceRemaining ?? 0) * 10) / 10;
        if (item.maxPossible) {
            score.actual.maxPossible = Math.round(item.maxPossible * 10) / 10;
        }

        doHandicapping(score);

        // Speeds only appropriate at some points in the flight
        // If we haven't landed out or come home without a finish
        // and don't start reporting them too quickly
        if (item.flightStatus != PositionStatus.Landed && (item.utcFinish || item.flightStatus != PositionStatus.Home)) {
            const finishLeg = task.legs[task.legs.length - 1];
            const finishAlt = finishLeg.altitude ?? 0;

            if (task.rules.grandprixstart || (duration > 60 * 7.5 && score.actual.taskDistance > 10)) {
                doSpeedCalc(score.actual, 0, duration);
                doSpeedCalc(score.handicapped, 0, duration);
                //
                // Calculate overall speed and remaining GR if there is a need for one
                score.actual.taskSpeed = Math.round(score.actual.taskDistance / (duration / 36000)) / 10;
                if (!item.utcFinish && item.lastProcessedPoint?.a) {
                    doGrCalc(score.actual, item.lastProcessedPoint.a - finishAlt);
                    doGrCalc(score.handicapped, item.lastProcessedPoint.a - finishAlt);
                }
            }

            // Calculate the GR to home
            if (item.lastProcessedPoint) {
                score.home = {
                    taskDistance: score.actual.taskDistance ?? 0,
                    distanceRemaining: item.lastProcessedPoint ? distHaversineRaw([item.lastProcessedPoint.lng, item.lastProcessedPoint.lat], finishLeg.point!) : 0
                };
                doGrCalc(score.home, item.lastProcessedPoint.a - finishAlt);
            }
        }

        yield score;
    }

    log(`TSG: ${compno} leaving function`);
};
