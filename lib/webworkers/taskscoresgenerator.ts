import {Compno, Epoch, TimeStampType, TaskScoresGenerator, CalculatedTaskGenerator, CalculatedTaskLegStatus, Task} from '../types';

import {PilotScore, PilotScoreLeg} from '../protobuf/onglide';

//
function copyPick(d, o, ...props) {
    return Object.assign(d, ...props.map((prop) => ({[prop]: o[prop]})));
}

function selectPick(o, ...props) {
    return props.map((prop) => ({[prop]: o[prop]}));
}

//export function everySoOftenGenerator<Type extends TimeStampType> *(interval: Epoch, input: SoftenGenerator<Type>): SoftenGenerator<Type> {
export const taskScoresGenerator = function* (task: Task, compno: Compno, handicap: number, input: CalculatedTaskGenerator): TaskScoresGenerator {
    //
    // Loop till we are told to stop
    for (let current = input.next(); !current.done && current.value; current = input.next()) {
        const item = current.value;
        if (!item) {
            return;
        }

        // We will get called every time a calculation is ready for final scoring.
        // Our job is to calculate & populate the structure that goes to the front end
        //
        const score: PilotScore = {
            t: item.t,
            compno: compno,

            utcStart: item.utcStart,
            utcFinish: item.utcFinish,

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
            const legTime = (leg) => leg.point?.t || leg.entryTimeStamp || leg.exitTimeStamp;

            // Proper turnpoint - startPoint doesn't count
            if (previousLeg) {
                const sl: PilotScoreLeg = (score.legs[leg.legno] = {
                    legno: leg.legno,
                    time: legTime(leg),
                    estimatedEnd: leg.estimatedTurn ? true : false,
                    estimatedStart: previousLeg?.estimatedTurn ? true : false
                });

                // Figure out actuals for the leg/copy them over
                sl.actual = {
                    distance: leg.distance,
                    taskDistance: (score.legs[leg.legno - 1]?.actual?.taskDistance || 0) + leg.distance
                };
                copyPick(sl.actual, leg, 'distanceRemaining', 'minPossible', 'maxPossible');

                // And now do speeds
                if (sl.time) {
                    const totalDuration = sl.time - item.utcStart;
                    sl.duration = sl.time - legTime(previousLeg);
                    sl.actual.legSpeed = Math.round(sl.actual.distance / (sl.duration / 360)) * 10;
                    sl.actual.taskSpeed = Math.round(sl.actual.taskDistance / (totalDuration / 360)) * 10;
                }
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
                score.minDistancePoints.push(leg.minPossible.point.lng, leg.minPossible.point.lat);
            }
            if (leg.maxPossible) {
                score.maxDistancePoints.push(leg.maxPossible.point.lng, leg.maxPossible.point.lat);
            }

            previousLeg = leg;
        }

        // Helper for handicapping
        const calcHandicap = (dist, leg) => {
            return (100.0 * dist) / Math.max(handicap + leg.Hi, 25);
        };

        console.log('--------> score [', compno, '] <--------');
        console.log(JSON.stringify(score, null, 2));
        yield score;
    }
};
