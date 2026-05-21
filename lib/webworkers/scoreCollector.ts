import {trackMetric} from '../insights';

import {Epoch, ClassName, Compno, TaskScoresGenerator, PositionStatusText, PositionStatus} from '../types';

import {PilotScore} from '../protobuf/onglide';

import {MessagePort} from 'node:worker_threads';

import {setTimeout} from 'timers/promises';

import {scoreChanged} from '../flightprocessing/scoreChanged';

import {d} from '../now';

/*
 * collect scores from a collection of different generators and post update messages
 *
 */
interface AddToScoreCollector {
    collect: (compno: Compno, input: TaskScoresGenerator, scoreId: string) => Promise<void>;
    reset: () => void;
    clearGlider: (compno: Compno) => void;
    updateScoreId: (oldScoreId: string, scoreId: string) => void;
}

type ScoreIdDetails = {
    allScores: Record<Compno, PilotScore>;
    mostRecentStart: Record<Compno, Epoch>;
    optionsForCompno: Record<Compno, {restartCount: number; scoreId: string}>;
    live: Record<Compno, boolean>;
    state: 'starting' | 'aborted' | 'live';
    startedAt: Epoch;
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
    const allGliders = new Set<Compno>();
    let running = true;

    const getScoreIdDetails = (scoreId: string): ScoreIdDetails =>
        scoreIdDetails.has(scoreId) //
            ? scoreIdDetails.get(scoreId)!
            : scoreIdDetails.set(scoreId, {allScores: {}, mostRecentStart: {}, optionsForCompno: {}, live: {}, state: 'starting', startedAt: getNow()}).get(scoreId)!;

    //  let oldestUpdate = Infinity;
    //    let newestUpdate = 0;

    function checkIfScoreIdIsLive(scoreId: string) {
        const c = getScoreIdDetails(scoreId);
        const numLive = Object.keys(c.live).length;
        const numRunning = Object.keys(c.optionsForCompno).length;
        const numCompnos = allGliders.size;
        // if all are live
        if (numLive == numRunning && numLive == numCompnos) {
            const elapsed = getNow() - c.startedAt;
            if (c.state === 'aborted') {
                console.log(`[${id}] ${className}: received live for old scoring task ${scoreId} after ${elapsed}s (all tasks ${[...scoreIdDetails.keys()].join(',')})`);
            } else {
                console.log(`[${id}] ${className}: received live for ${scoreId} after ${elapsed}s closing old scoring tasks ${[...scoreIdDetails.keys()].join(',')}`);
                for (const [closeId, old] of scoreIdDetails.entries()) {
                    if (closeId != scoreId) {
                        console.log(`[${id}] ${className}: closing ${closeId}`);
                        Object.values(old.optionsForCompno).forEach((option) => option.restartCount++);
                        scoreIdDetails.delete(closeId);
                    }
                }
                port.postMessage({compno: '_live', score: {live: true}, t: getNow(), scoreId});
                c.state = 'live';
            }
        }
    }

    // Called when a new score is available, save it in the
    // object structure and flag that it's there
    function updateScore(compno: Compno, score: PilotScore, scoreId: string) {
        const c = getScoreIdDetails(scoreId);
        const oldScore = c.allScores[compno];
        const changed = scoreChanged(oldScore, score, true);
        if (changed) {
            if (oldScore && oldScore.flightStatus != score.flightStatus) {
                console.log(`${className}:${score.compno}: ${PositionStatusText[oldScore.flightStatus ?? PositionStatus.Unknown]} => ${PositionStatusText[score.flightStatus ?? PositionStatus.Unknown]} @ ${d(score.t)}`);
            }
            const recentStart = score.utcStart && c.mostRecentStart[compno] != score.utcStart ? score.utcStart : undefined;
            c.mostRecentStart[compno] = score.utcStart as Epoch;

            score.scoreId = scoreId;
            c.allScores[compno] = score;
            port.postMessage({compno, score, recentStart, t: score.t, scoreId});

            // If we are now live we can close off the older ones
            if (score.live && !c.live[compno]) {
                c.live[compno] = true;
                for (const [closeId, old] of scoreIdDetails.entries()) {
                    if (closeId != scoreId) {
                        console.log(`[${id}] ${className}/${compno}: closing ${closeId}`);
                        if (old.optionsForCompno[compno]) {
                            old.optionsForCompno[compno].restartCount++;
                        }
                    }
                }

                checkIfScoreIdIsLive(scoreId);
            }
        }
        return running;
    }

    // Return a function to
    return {
        collect: async function addToScoreCollector(compno: Compno, input: TaskScoresGenerator, scoreId: string) {
            console.log(`[${scoreId}] ${className}: scoreCollect collect ${compno}`);
            allGliders.add(compno);
            const c = getScoreIdDetails(scoreId);
            c.optionsForCompno[compno] = Object.assign(c.optionsForCompno[compno] ?? {}, {restartCount: (c.optionsForCompno[compno]?.restartCount ?? 0) + 1, scoreId});
            return iterateAndUpdate(id, className, compno, input, updateScore, c.optionsForCompno[compno]);
        },
        // Clear all scoring
        reset: function () {
            for (const compno of allGliders.keys()) {
                console.log(`[ALL] ${className}: scoreCollect reset ${compno}`);
                this.clearGlider(compno);
            }
        },
        clearGlider: function (compno: Compno) {
            for (const scoreId of scoreIdDetails.keys()) {
                const c = getScoreIdDetails(scoreId);
                console.log(`[ALL] ${className}: scoreCollect clearGlider ${compno}: restartCount ${c.optionsForCompno[compno]?.restartCount}`);
                if (compno in c.optionsForCompno) {
                    c.optionsForCompno[compno].restartCount++;
                }
                delete c.allScores[compno];
                delete c.mostRecentStart[compno];
                delete c.live[compno];
                delete c.optionsForCompno[compno];
            }
            allGliders.delete(compno);
        },
        // Move from one score ID to another
        updateScoreId: function (oldScoreId: string, scoreId: string) {
            if (oldScoreId === scoreId) {
                return;
            }
            console.log(`[${oldScoreId}->${scoreId}] ${className}: scoreCollect updateScoreId`);
            const cO = scoreIdDetails.get(oldScoreId);
            const cN = getScoreIdDetails(scoreId);
            if (cO) {
                const migrated: Compno[] = [],
                    cancelled: Compno[] = [];

                // If it hasn't already been put into the new scoreId then
                // (which means it hasn't already been restarted) then
                // we need to just move it over
                (Object.keys(cO.allScores) as Compno[]).forEach((compno) => {
                    if (!(compno in cN.optionsForCompno)) {
                        cN.allScores[compno] = cO.allScores[compno];
                        cN.allScores[compno].scoreId = scoreId;
                        port.postMessage({compno, score: cN.allScores[compno], recentStart: false, t: cN.allScores[compno].t, scoreId, migrateFrom: oldScoreId});
                        delete cO.allScores[compno];
                        cN.optionsForCompno[compno] = cO.optionsForCompno[compno];
                        cN.optionsForCompno[compno].scoreId = scoreId;
                        delete cO.optionsForCompno[compno];
                        cN.live[compno] = cO.live[compno];
                        delete cO.live[compno];
                        cN.mostRecentStart[compno] = cO.mostRecentStart[compno];
                        delete cO.mostRecentStart[compno];
                        migrated.push(compno as Compno);
                    } else {
                        if (cO.state === 'starting') {
                            cO.optionsForCompno[compno].restartCount++;
                            cancelled.push(compno as Compno);
                        }
                    }
                });
                cO.state = 'aborted';
                console.log(`[${oldScoreId}->${scoreId}] ${className}: scoreCollect, migrated: ${migrated.join(',')}, cancelled: ${cancelled.join(',')}`);
                checkIfScoreIdIsLive(scoreId);
            }
        }
    };

    // Nah, we might need to restart so don't do this...
    // Abandon promises, intervals and some hope
}

type UpdateScoreFunction = (compno: Compno, score: PilotScore, scoreId: string) => boolean;
async function iterateAndUpdate(id: string, className: ClassName, compno: Compno, input: TaskScoresGenerator, updateScore: UpdateScoreFunction, options: {restartCount: number; scoreId: string}): Promise<void> {
    // Loop till we are told to stop
    const myRestartCount = options.restartCount;
    try {
        for await (const value of input) {
            if (myRestartCount != options.restartCount) {
                break;
            }
            if (!updateScore(compno, value, options.scoreId)) {
                break;
            }
            await setTimeout(1); // explicit yield - ensures logging and stuff are working and spreads out between the different compnos so one doesn't starve the rest on restart
        }
    } catch (e) {
        console.log(compno, '[', options.scoreId, '] scoreCollector exception', e, (e as Error)?.stack);
    }
    trackMetric('sc.done.' + className, 1);
    trackMetric('sc.done', 1);
    console.log(`[${id}] SC: Completed scoring iteration (restart #${myRestartCount}) for ${compno} [${options.scoreId}]`);
}
