import {Compno, PositionStatus, AltitudeAgl, BasePositionMessage, Epoch, TimeStampType, TaskScoresGenerator, CalculatedTaskGenerator, CalculatedTaskLegStatus, Task} from '../types';

import {PilotScore, PilotScoreLeg, SpeedDist} from '../protobuf/onglide';

//
function copyPick(d, o, ...props) {
    return Object.assign(d, ...props.map((prop) => ({[prop]: o[prop]})));
}

function selectPick(o, ...props) {
    return props.map((prop) => ({[prop]: o[prop]}));
}

//export function everySoOftenGenerator<Type extends TimeStampType> *(interval: Epoch, input: SoftenGenerator<Type>): SoftenGenerator<Type> {
export const taskScoresGenerator = async function* (task: Task, compno: Compno, handicap: number, input: CalculatedTaskGenerator, log: Function): TaskScoresGenerator {
    // Helper for handicapping
    function calcHandicap(dist) {
        return Math.round((1000.0 * dist) / handicap) / 10;
    }

    const doSpeedCalc = (sd: SpeedDist, legDuration: number, taskDuration: number) => {
        if (!sd) {
            return;
        }
        if (legDuration) {
            sd.legSpeed = Math.max(0, Math.round(sd.distance / (legDuration / 36000)) / 10);
        }
        if (taskDuration) {
            sd.taskSpeed = Math.max(Math.round(sd.taskDistance / (taskDuration / 36000)) / 10);
        }
    };

    const doGrCalc = (sd: SpeedDist | null, agl: AltitudeAgl) => {
        if (sd && agl) {
            sd.grRemaining = Math.round((sd.distanceRemaining || sd.minPossible) / (agl / 1000));
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
            console.log(`TSG: no value received in iterator for ${compno}`, current);
            return;
        }

        //        log(item);

        // We will get called every time a calculation is ready for final scoring.
        // Our job is to calculate & populate the structure that goes to the front end
        //
        const score: PilotScore = {
            t: item.t,
            compno: compno,

            utcStart: item.utcStart,
            utcFinish: item.utcFinish,
            flightStatus: item.flightStatus,

            currentLeg: item.currentLeg,

            // We will fill these in enxt
            legs: {},
            scoredPoints: [],
            minDistancePoints: [],
            maxDistancePoints: []
        };

        let previousLeg: CalculatedTaskLegStatus = null;
        for (const leg of item.legs) {
            // For the time of the leg we use:
            // 1. AAT specific turnpoint time
            // 2. The entry to the TP
            // 3. the exit from the TP (ie startLine)
            const legTime = (leg) => leg.entryTimeStamp || leg.exitTimeStamp || 0;

            // Proper turnpoint - startPoint doesn't count
            if (previousLeg) {
                const sl: PilotScoreLeg = (score.legs[leg.legno] = {
                    legno: leg.legno,
                    time: legTime(previousLeg),
                    estimatedStart: previousLeg?.estimatedTurn ? true : false,
                    estimatedEnd: leg.estimatedTurn ? true : false
                });

                // Figure out actuals for the leg/copy them over
                sl.actual = {
                    distance: Math.round(leg.distance * 10) / 10,
                    taskDistance: Math.round(((score.legs[leg.legno - 1]?.actual?.taskDistance || 0) + leg.distance) * 10) / 10
                };
                if (previousLeg?.point?.a) {
                    sl.alt = previousLeg?.point?.a;
                }
                if (leg.minPossible) {
                    sl.actual.minPossible = Math.round(leg.minPossible.distance * 10) / 10;
                }
                if (leg.maxPossible) {
                    sl.actual.maxPossible = Math.round(leg.maxPossible.distance * 10) / 10;
                }
                if (leg.distanceRemaining || leg.minPossible) {
                    sl.actual.distanceRemaining = Math.round((leg.distanceRemaining || leg.minPossible.distance) * 10) / 10;
                }

                doHandicapping(sl);
                doGrCalc(sl.actual, sl.alt);
                doGrCalc(sl.handicapped, sl.alt);

                //
                sl.duration = (legTime(leg) || leg.point?.t) - sl.time;
                sl.taskDuration = (legTime(leg) || leg.point?.t) - item.utcStart;

                // And now do speeds
                doSpeedCalc(sl.actual, sl.duration, sl.taskDuration);
                doSpeedCalc(sl.handicapped, sl.duration, sl.taskDuration);
            }
            // otherwise we are start leg
            else {
                score.legs[leg.legno] = {
                    legno: leg.legno,
                    time: leg.point?.t || leg.exitTimeStamp
                };
            }
            if (leg.point) {
                score.scoredPoints.push(leg.point.lng, leg.point.lat);
            }
            if (leg.minPossible) {
                if (leg.minPossible.start) {
                    score.minDistancePoints.push(leg.minPossible.start.lng, leg.minPossible.start.lat);
                }
                score.minDistancePoints.push(leg.minPossible.point.lng, leg.minPossible.point.lat);
            }
            if (leg.maxPossible) {
                score.maxDistancePoints.push(leg.maxPossible.point.lng, leg.maxPossible.point.lat);
            }

            previousLeg = leg;
        }

        //
        // Task overalls
        const duration = (item.utcFinish || item.t) - item.utcStart;
        score.actual = {
            taskDistance: item.distance
        };
        score.taskDuration = duration;

        // Looks weird but take it if it is there, if it isn't then take the alternative
        // AAT uses all three, racing uses dR
        score.actual.distanceRemaining = Math.round((item.distanceRemaining || item.minPossible) * 10) / 10;
        score.actual.minPossible = Math.round((item.minPossible || item.distanceRemaining) * 10) / 10;
        if (item.maxPossible) {
            score.actual.maxPossible = Math.round(item.maxPossible * 10) / 10;
        }

        doHandicapping(score);

        // Speeds only appropriate at some points in the flight
        // If we haven't landed out or come home without a finish
        if (item.flightStatus != PositionStatus.Landed && (item.utcFinish || item.flightStatus != PositionStatus.Home)) {
            doSpeedCalc(score.actual, 0, duration);
            doSpeedCalc(score.handicapped, 0, duration);
            //
            // Calculate overall speed and remaining GR if there is a need for one
            score.actual.taskSpeed = Math.round(score.actual.taskDistance / (duration / 36000)) / 10;
            if (!item.utcFinish && item.lastProcessedPoint?.a) {
                doGrCalc(score.actual, item.lastProcessedPoint.a);
                doGrCalc(score.handicapped, item.lastProcessedPoint.a);
            }
        }

        if (Date.now() / 1000 - score.t > 930) {
            console.log(score.compno, 'scored delay:', (Date.now() / 1000 - score.t).toFixed(0));
        }
        yield score;
    }

    console.log(`TSG: ${compno} leaving function`);
};
