import {trackMetric} from '../insights';

import {Epoch, ClassName, Compno, Task, TaskScoresGenerator} from '../types';

import {PilotScore} from '../protobuf/onglide';

import {cloneDeep as _clonedeep, keyBy as _keyby} from 'lodash';

import {OnglideWebSocketMessage} from '../protobuf/onglide';
import {MessagePort} from 'node:worker_threads';

/*
 * collect scores from a collection of different generators and post update messages
 *
 */
//
// Get a generator to calculate task status
export async function scoreCollector(interval: Epoch, port: MessagePort, task: Task, scoreStreams: Record<Compno, TaskScoresGenerator>, getNow: () => Epoch, log?: Function): Promise<void> {
    // Generate log function as it's quite slow to read environment all the time
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    // Our internal ID so we can track everything
    const id = Math.trunc(Math.random() * 4094).toString(16);
    const taskId = task.details.taskid + '/' + task.details.task;
    const className = task.details.class;

    // Record of scores per pilot and a flag to optimise transfer
    // of scores when nothing happening
    const mostRecentScore: Record<Compno, PilotScore> = {};
    const mostRecentStart: Record<Compno, Epoch> = {};
    let startsToSend: Record<Compno, Epoch> = {};
    let latestSent = false;
    let running = true;

    let oldestUpdate = Infinity;
    let newestUpdate = 0;

    // Called when a new score is available, save it in the
    // object structure and flag that it's there
    function updateScore(compno: Compno, score: PilotScore) {
        mostRecentScore[compno] = score;

        if (score.utcStart && mostRecentStart[compno] != score.utcStart) {
            console.log(`[${id}/${taskId}] Start found for: ${className}:${compno} @ ${score.utcStart} - ${new Date(score.utcStart * 1000).toUTCString()}`);
            startsToSend[compno] = mostRecentStart[compno] = score.utcStart as Epoch;
        }

        oldestUpdate = Math.min(oldestUpdate, score.t);
        newestUpdate = Math.max(newestUpdate, score.t);

        latestSent = false;
        return running;
    }

    function composeAndSendProtobuf(className: ClassName, port: MessagePort, scores: Record<Compno, PilotScore>, startsToSend: Record<Compno, Epoch>) {
        const countScoredPilots = Object.keys(scores).length;
        const countStartsToSend = Object.keys(startsToSend).length;

        // Nothing to report don't report
        if (!countScoredPilots && !countStartsToSend) {
            console.log(`[${id}/${taskId}] No score update: ${className}`);
            return;
        }

        const now = getNow();
        trackMetric('sc.scoredPilots', countScoredPilots);
        trackMetric('sc.newStarts', countStartsToSend);
        trackMetric('sc.' + className + '.minDelay', Math.min(now - newestUpdate, now - oldestUpdate));
        trackMetric('sc.' + className + '.maxDelay', Math.max(now - newestUpdate, now - oldestUpdate));

        //
        // Encode this as a protobuf
        const msg = OnglideWebSocketMessage.encode({scores: {pilots: scores}}).finish();
        console.log(`[${id}/${taskId}] Startline update: ${className} :${Object.keys(startsToSend).join(',')}`);
        console.log(`[${id}/${taskId}] Score update: ${className} : ${Object.keys(scores).join(',')} => ${msg.byteLength} bytes`);
        console.log(`[${id}/${taskId}] Period: ${className} : [${new Date(oldestUpdate * 1000).toUTCString()}-${new Date(newestUpdate * 1000).toUTCString()}] ${oldestUpdate}-${newestUpdate} : ${Math.max(now - newestUpdate, now - oldestUpdate)}`);

        oldestUpdate = Infinity;
        newestUpdate = 0;
        // Now we need to send it back to the main thread - allow transfer, we don't
        // need the buffer again
        port.postMessage({scores: msg, recentStarts: startsToSend}, [msg.buffer]);
    }

    // Start async functions to read scores and update our most recent
    const promises = [];
    for (const compno in scoreStreams) {
        promises.push(iterateAndUpdate(id, task.details.class, compno as Compno, scoreStreams[compno], updateScore));
    }

    // And a timer callback that posts the message to front end
    const timer = setInterval(() => {
        if (!latestSent) {
            composeAndSendProtobuf(task.details.class, port, mostRecentScore, startsToSend);
            startsToSend = {};
            latestSent = true;
        }
    }, interval * 1000);

    // Wait for all the scoring to finish
    await Promise.allSettled(promises);

    // And then clear the interval and return - no need to keep running it if nothing is
    // scoring any longer
    clearInterval(timer);
}

async function iterateAndUpdate(id: string, className: ClassName, compno: Compno, input: TaskScoresGenerator, updateScore: Function): Promise<void> {
    // Loop till we are told to stop
    try {
        for await (const value of input) {
            if (!updateScore(compno, value)) {
                break;
            }
        }
    } catch (e) {
        console.log(compno, e);
    }
    trackMetric('sc.done.' + className, 1);
    trackMetric('sc.done', 1);
    console.log(`[${id}] SC: Completed scoring iteration for ${compno}`);
}
