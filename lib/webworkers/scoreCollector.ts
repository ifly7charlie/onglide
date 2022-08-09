import Graph from '../flightprocessing/dijkstras';

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
export async function scoreCollector(interval: Epoch, port: MessagePort, task: Task, scoreStreams: Record<Compno, TaskScoresGenerator>, log?: Function): Promise<void> {
    // Generate log function as it's quite slow to read environment all the time
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    // Record of scores per pilot and a flag to optimise transfer
    // of scores when nothing happening
    const mostRecentScore: Record<Compno, PilotScore> = {};
    let latestSent = false;

    // Called when a new score is available, save it in the
    // object structure and flag that it's there
    function updateScore(compno: Compno, score: PilotScore) {
        mostRecentScore[compno] = score;
        latestSent = false;
    }

    // Start async functions to read scores and update our most recent
    const promises = [];
    for (const compno in scoreStreams) {
        promises.push(iterateAndUpdate(compno as Compno, scoreStreams[compno], updateScore));
    }

    // And a timer callback that posts the message to front end
    const timer = setInterval(() => {
        if (!latestSent) {
            composeAndSendProtobuf(task.details.class, task.details.task, port, mostRecentScore);
            latestSent = true;
        }
    }, interval * 1000);

    setTimeout(() => {
        composeAndSendProtobuf(task.details.class, task.details.task, port, mostRecentScore);
    }, 10000);

    // Wait for all the scoring to finish
    await Promise.allSettled(promises);

    // And then clear the interval and return - no need to keep running it if nothing is
    // scoring any longer
    clearInterval(timer);
}

async function iterateAndUpdate(compno: Compno, input: TaskScoresGenerator, updateScore: Function): Promise<void> {
    // Loop till we are told to stop
    try {
        for await (const value of input) {
            // let current = await input.next(); !current.done && current.value; current = await input.next()) {
            updateScore(compno, value); // .value);
        }
    } catch (e) {
        console.log(compno, e);
    }
    console.log(`Completed scoring iteration for ${compno}`);
}

function composeAndSendProtobuf(className: ClassName, taskId: string, port: MessagePort, recent: Record<Compno, PilotScore>) {
    //
    // Encoe this as a protobuf
    const msg = OnglideWebSocketMessage.encode({scores: {pilots: recent}, t: Math.trunc(Date.now() / 1000)}).finish();
    console.log(`Score update: ${className} [${taskId}]: ${Object.keys(recent).join(',')} => ${msg.byteLength} bytes`);

    // Now we need to send it back to the main thread - allow transfer, we don't
    // need the buffer again
    port.postMessage(msg, [msg.buffer]);
}
