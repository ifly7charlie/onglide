import {trackMetric} from '../insights';

import {Epoch, ClassName, Compno, Task, TaskScoresGenerator} from '../types';

import {PilotScore} from '../protobuf/onglide';

import {cloneDeep as _clonedeep, keyBy as _keyby} from 'lodash';

import {MessagePort} from 'node:worker_threads';

import {setTimeout} from 'timers/promises';

import equal from 'fast-deep-equal';

/*
 * collect scores from a collection of different generators and post update messages
 *
 */
interface AddToScoreCollector {
    collect: (compno: Compno, input: TaskScoresGenerator, scoreId: string) => Promise<void>;
    reset: (scoreId?: string) => void;
    clearGlider: (compno: Compno) => void;
}

type ScoreIdDetails = {
    allScores: Record<Compno, PilotScore>;
    mostRecentStart: Record<Compno, Epoch>;
    optionsForCompno: Record<Compno, {restartCount: number}>;
    live: Record<Compno, boolean>;
};

//
// Get a generator to calculate task status
export function scoreCollector(port: MessagePort, className: ClassName, getNow: () => Epoch, log?: Function): AddToScoreCollector {
    // Generate log function as it's quite slow to read environment all the time
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    // Our internal ID so we can track everything
    const id = Math.trunc(Math.random() * 4094).toString(16);
    console.log(`[${id}]: ${className} starting scoreCollector`);

    // Record of scores per pilot and a flag to optimise transfer
    // of scores when nothing happening
    const scoreIdDetails = new Map<string, ScoreIdDetails>();
    let running = true;

    const getScoreIdDetails = (scoreId: string): ScoreIdDetails =>
        scoreIdDetails.has(scoreId) //
            ? scoreIdDetails.get(scoreId)!
            : scoreIdDetails.set(scoreId, {allScores: {}, mostRecentStart: {}, optionsForCompno: {}, live: {}}).get(scoreId)!;

    //  let oldestUpdate = Infinity;
    //    let newestUpdate = 0;

    // Called when a new score is available, save it in the
    // object structure and flag that it's there
    function updateScore(compno: Compno, score: PilotScore, scoreId: string) {
        const c = getScoreIdDetails(scoreId);
        if (scoreChanged(c.allScores[compno], score)) {
            const recentStart = score.utcStart && c.mostRecentStart[compno] != score.utcStart ? score.utcStart : undefined;
            c.mostRecentStart[compno] = score.utcStart as Epoch;

            // If we are now live we can close off the older ones
            if (score.live && !c.live[compno]) {
                c.live[compno] = true;

                console.log(`[${id}]: ${className} ${Object.keys(c.live).length}/${Object.keys(c.optionsForCompno).length} live [${scoreId}]`);
                // if all are live
                if (Object.keys(c.live).length == Object.keys(c.optionsForCompno).length && scoreIdDetails.size > 1) {
                    console.log(`[${id}]: closing old scoring tasks ${[...scoreIdDetails.keys()].join(',')}`);
                    for (const [closeId, c] of scoreIdDetails.entries()) {
                        if (closeId != scoreId) {
                            console.log(`[${id}]: ${className} closing ${closeId}`);
                            Object.values(c.optionsForCompno).forEach((option) => option.restartCount++);
                        }
                    }
                    port.postMessage({compno: '_live', score: {live: score.live}, t: getNow(), scoreId});
                }
            }

            console.log(`[${id}] updating score for ${compno} [${scoreId}] status: ${score.flightStatus}, ${new Date(score.t * 1000).toISOString()}`);
            c.allScores[compno] = score;

            //            oldestUpdate = Math.min(c.oldestUpdate, score.t);
            //            newestUpdate = Math.max(c.newestUpdate, score.t);

            port.postMessage({compno, score, recentStart, t: score.t, scoreId});
        }
        return running;
    }

    // Return a function to
    return {
        collect: async function addToScoreCollector(compno: Compno, input: TaskScoresGenerator, scoreId: string) {
            const c = getScoreIdDetails(scoreId);
            c.optionsForCompno[compno] = Object.assign(c.optionsForCompno[compno] ?? {}, {restartCount: (c.optionsForCompno[compno]?.restartCount ?? 0) + 1});
            return iterateAndUpdate(id, className, compno, input, updateScore, c.optionsForCompno[compno], scoreId);
        },
        reset: function (scoreId: string | undefined) {
            if (!scoreId) {
                for (const scoreId in scoreIdDetails.keys()) {
                    const c = getScoreIdDetails(scoreId);
                    Object.values(c.optionsForCompno).forEach((option) => option.restartCount++);
                }
            } else {
                const c = getScoreIdDetails(scoreId);
                Object.values(c.optionsForCompno).forEach((option) => option.restartCount++);
            }
        },
        clearGlider: function (compno: Compno) {
            for (const scoreId in scoreIdDetails.keys()) {
                const c = getScoreIdDetails(scoreId);
                if (compno in c.optionsForCompno) {
                    c.optionsForCompno[compno].restartCount++;
                }
            }
        }
    };

    // Nah, we might need to restart so don't do this...
    // Abandon promises, intervals and some hope
}

type UpdateScoreFunction = (compno: Compno, score: PilotScore, scoreId: string) => boolean;
async function iterateAndUpdate(id: string, className: ClassName, compno: Compno, input: TaskScoresGenerator, updateScore: UpdateScoreFunction, options: {restartCount: number}, scoreId: string): Promise<void> {
    // Loop till we are told to stop
    const myRestartCount = options.restartCount;
    try {
        for await (const value of input) {
            if (myRestartCount != options.restartCount) {
                break;
            }
            if (!updateScore(compno, value, scoreId)) {
                break;
            }
            await setTimeout(1); // explicit yield - ensures logging and stuff are working and spreads out between the different compnos so one doesn't starve the rest on restart
        }
    } catch (e) {
        console.log(compno, 'scoreCollector exception', e);
    }
    trackMetric('sc.done.' + className, 1);
    trackMetric('sc.done', 1);
    console.log(`[${id}] SC: Completed scoring iteration (restart #${myRestartCount}) for ${compno} [${scoreId}]`);
}

function scoreChanged(oldScore?: PilotScore, newScore?: PilotScore): boolean {
    //    console.log('CHANGED', oldScore, newScore);
    if (!oldScore || !newScore) {
        return !oldScore !== !newScore; // both undefined or defined
    }

    // If we have switched from replay
    if (oldScore.live !== newScore.live) {
        return true;
    }

    // If the timestamp is the same then nothing has changed
    if (oldScore.t === newScore.t) {
        return false;
    }
    // If the start time is different then it must have changed
    if (oldScore.utcStart !== newScore.utcStart) {
        return true;
    }

    // Now we know that duration or flight status must change for it to count
    if (oldScore.flightStatus != newScore.flightStatus) {
        console.log(newScore.compno, 'fs change', newScore.flightStatus, oldScore.flightStatus);
        return true;
    }

    // If we haven't started then all we care about is flight status
    if (!newScore.utcStart) {
        return false;
    }

    // If we have scored and the score hasn't changed then we are equivalent - nothing after
    // finish matters
    if (oldScore.utcFinish && oldScore.utcFinish == newScore.utcFinish) {
        return false;
    }

    // Otherwise check time and distance - actual should always be there and it's enough
    return !equal(oldScore.actual, newScore.actual);
}
