import Graph from '../flightprocessing/dijkstras';

import {ProtobufGenerator, Epoch, DistanceKM, AltitudeAMSL, AltitudeAgl, Compno, TaskStatus, EstimatedTurnType, Task, ScoredTaskDistanceStatus, TaskScoresGenerator, TaskStatusGenerator, BasePositionMessage, TaskLegStatus} from '../types';

import {InOrderGeneratorFunction} from './inordergenerator';
import {PositionMessage} from './positionmessage';

import {cloneDeep as _clonedeep, keyBy as _keyby} from 'lodash';

import {distHaversine} from '../flightprocessing/taskhelper';

import {OnglideWebSocketMessage} from '../protobuf/onglide';

/*
 * collect scores from a collection of different generators and post update messages
 *
 */
//
// Get a generator to calculate task status
export async function scoreCollector(interval: Epoch, task: Task, scoreStreams: Record<Compno, TaskScoresGenerator>, log?: Function) {
    // Generate log function as it's quite slow to read environment all the time
    if (!log)
        log = (...a) => {
            console.log(...a);
        };

    //
    const mostRecentScore: Record<Compno, ScoredTaskDistanceStatus> = {};

    function updateScore(compno: Compno, score: ScoredTaskDistanceStatus) {
        mostRecentScore[compno] = score;
    }

    // Start async functions to read scores and update our most recent
    const promises = [];
    for (const compno in scoreStreams) {
        promises.push(iterateAndUpdate(compno as Compno, scoreStreams[compno], updateScore));
    }

    // And a timer callback that posts the message to front end
    setInterval(() => {
        composeAndSendProtobuf(mostRecentScore);
    }, 30000);

    Promise.allSettled(promises);
}

async function iterateAndUpdate(compno: Compno, input: TaskScoresGenerator, updateScore: Function): Promise<void> {
    // Loop till we are told to stop
    for (let current = input.next(); !current.done && current.value; current = input.next()) {
        updateScore(compno, current.value);
    }
}

function composeAndSendProtobuf(recent: Record<Compno, ScoredTaskDistanceStatus>) {}
