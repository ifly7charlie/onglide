import Graph from '../flightprocessing/dijkstras';

import {Epoch, Compno, Task, TaskScoresGenerator} from '../types';

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
export async function scoreCollector(interval: Epoch, port: MessagePort, task: Task, scoreStreams: Record<Compno, TaskScoresGenerator>, log?: Function) {
    // Generate log function as it's quite slow to read environment all the time
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    //
    const mostRecentScore: Record<Compno, PilotScore> = {};

    function updateScore(compno: Compno, score: PilotScore) {
        const sendImmediately = !mostRecentScore[compno];
        mostRecentScore[compno] = score;
        if (sendImmediately) {
            console.log(`first score for ${compno} received`);
            composeAndSendProtobuf(port, mostRecentScore);
        }
    }

    // Start async functions to read scores and update our most recent
    const promises = [];
    for (const compno in scoreStreams) {
        promises.push(iterateAndUpdate(compno as Compno, scoreStreams[compno], updateScore));
    }

    // And a timer callback that posts the message to front end
    setInterval(() => {
        composeAndSendProtobuf(port, mostRecentScore);
    }, 30000);

    Promise.allSettled(promises);
}

async function iterateAndUpdate(compno: Compno, input: TaskScoresGenerator, updateScore: Function): Promise<void> {
    // Loop till we are told to stop
    try {
        for (let current = input.next(); !current.done && current.value; current = input.next()) {
            updateScore(compno, current.value);
        }
    } catch (e) {
        console.log(e);
    }
}

function composeAndSendProtobuf(port: MessagePort, recent: Record<Compno, PilotScore>) {
    console.log('composeAndSendProtobuf');
    //
    // Encoe this as a protobuf
    const msg = OnglideWebSocketMessage.encode({scores: {pilots: recent}, t: Math.trunc(Date.now() / 1000)}).finish();

    // Now we need to send it back to the main thread
    port.postMessage(msg);
}
