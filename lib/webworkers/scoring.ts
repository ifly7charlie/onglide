//
// This webworker will parse inbound APRS messages and package them to be passed to
// both scoring and the front end using messages
//

//
// Subscribe to APRS and then broadcast to
// -> `Unknown_${competitionName}` for close to airfield but unknown
// -> `${className}` for known gliders
//
// Control channel allows adding new trackers and stopping the
// worker

// Import the APRS server

import {initialiseInsights} from '../insights';

import {PositionMessage} from './positionmessage';
import {Epoch, Datecode, ClassName_Compno, makeClassname_Compno, ClassName, Compno, InOrderGeneratorFunction, AirfieldLocation} from '../types';

import {Worker, parentPort, isMainThread, SHARE_ENV, workerData} from 'node:worker_threads';

import {bindChannelForInOrderPackets} from './inordergenerator';

// Scoring types
import {assignedAreaScoringGenerator} from './assignedAreaScoringGenerator';
import {racingScoringGenerator} from './racingScoringGenerator';
import {enrichedPositionGenerator} from './enrichedPositionGenerator';

// Figure out where in the task we are and produce status around that - no speeds or scores
import {taskPositionGenerator} from './taskpositiongenerator';
import {taskScoresGenerator} from './taskScoresGenerator';
import {scoreCollector} from './scoreCollector';

import {cloneDeep as _clonedeep} from 'lodash';

// FLOW:
//
// APRS => broadcast channel [ClassName_Compno] // incoming unsorted aprs packets
//
//                 -> inordergenerator  // sort the packets and forward
//                 -> taskpositiongenerator // figure out task position (start/turnpoints etc)
//                 -> scoreaat|scorespeed // actually produce the speeds
//                 -> everysooftengenerator // only output this so often
//                            -> broadcast channel // [ClassName] with scores
//
//                                     => websocket to clients

//
// THREADS:
//   [APRS]  => [SCORING] => [WEBSOCKET]
//   Interthread communication is broadcast channel
//

//
// GENERATORS:
//   - Generators block in place in the function simplifying the
//     flow between the different steps.
//   - Each time a new value is returned by a generator it's
//     the next value (excepting backtracking via inordergenerator)
//   - Each step can therefore simply move forwards in time
//   - Nothing cares where the messages come from
//   - A full rescore involes deleting and reloading the whole
//     process
//

export type scoresCallback = (message: {allScores: Buffer; recentScores: Buffer; recentStarts: Record<Compno, Epoch>}) => void;

export interface ScoringConfig {
    className: ClassName;
    datecode: Datecode;
    airfield: AirfieldLocation;
}

export class ScoringController {
    className: ClassName;
    datecode: Datecode;
    worker: Worker;

    constructor(config: ScoringConfig) {
        this.className = config.className;
        this.datecode = config.datecode;
        this.worker = spawnScoringContestListener(config);
    }

    // Load these points into scoring
    setInitialTrack(compno: Compno, handicap: number, utcStart: Epoch, points: PositionMessage[]) {
        this.worker.postMessage({action: ScoringCommandEnum.initialTrack, className: this.className, datecode: this.datecode, compno, points, handicap, utcStart});
    }

    // This actually starts scoring for the task
    setTask(task: any) {
        this.worker.postMessage({action: ScoringCommandEnum.newtask, className: this.className, datecode: this.datecode, task});
    }

    clearTask() {
        this.worker.postMessage({action: ScoringCommandEnum.cleartask, className: this.className, datecode: this.datecode});
    }

    rescoreGlider(compno: Compno, handicap: number, utcStart: Epoch) {
        this.worker.postMessage({action: ScoringCommandEnum.rescoreGlider, className: this.className, datecode: this.datecode, compno, handicap, utcStart});
    }

    clearGlider(compno: Compno) {
        this.worker.postMessage({action: ScoringCommandEnum.clearGlider, className: this.className, datecode: this.datecode, compno});
    }

    shutdown() {
        this.worker.postMessage({action: ScoringCommandEnum.shutdown});
    }

    hookScores(callback: scoresCallback) {
        this.worker.on('message', callback);
    }
}

//////////////////////////////////////////////
//

interface GliderState {
    className: ClassName;
    compno: Compno;
    handicap: number;
    utcStart: Epoch;

    // Sequence of steps used to do the scoring
    // inorder returns a generator that gives all of the glider points
    // that have been received in the correct order and listens for any
    // new points
    inorder: InOrderGeneratorFunction;

    // this gets passed to taskposition generator that reads these
    // messages and figures out where in the task the pilot is, yielding
    // status updates to the scoring generator

    // scoring is the output generator - of the type appropriate
    // for the scoring of the task
    scoring: any;

    task: any;
}

// What are we scoring - we will register each one when
// an initial track is set
let gliders: Record<ClassName_Compno, GliderState> = {};
let scoreUpdater: ReturnType<typeof scoreCollector>;

// Control function via post message
enum ScoringCommandEnum {
    none,
    shutdown,
    newtask,
    cleartask,
    track,
    initialTrack,
    rescoreGlider,
    clearGlider
}

export type ScoringCommand = ScoringCommandShutdown | ScoringCommandNewTask | ScoringCommandTrack | ScoringCommandRescoreGlider | any;

interface ScoringCommandBase {
    className: ClassName;
    datecode: Datecode;
}

// Task has changed
interface ScoringCommandNewTask extends ScoringCommandBase {
    action: ScoringCommandEnum.newtask;

    task: any; // should define type, this is what is returned by API call
}

interface ScoringCommandRescoreGlider extends ScoringCommandBase {
    action: ScoringCommandEnum.rescoreGlider;

    compno: Compno;
    handicap: number;
    utcStart: Epoch;
}

// Data for glider from DB - will reset track point
// generators and initialise them with this data
interface ScoringCommandTrack {
    action: ScoringCommandEnum.track;

    compno: Compno;
    handicap: number;
    utcStart: Epoch;

    // Historical points, must be in sorted order
    points: PositionMessage[];
}

// Exit
interface ScoringCommandShutdown {
    action: ScoringCommandEnum.shutdown;
}

//
// Start a listener
function spawnScoringContestListener(config: ScoringConfig): Worker {
    if (!isMainThread) {
        throw new Error('umm, this is only available in main thread');
    }
    console.log(`Starting Scoring:${config.className} worker thread`);

    return new Worker(__filename, {env: SHARE_ENV, workerData: config});
}

if (!isMainThread) {
    console.log(`Started Scoring Thread for class ${workerData.className}/${workerData.datecode} :)`);

    // Perhaps we need to do this in the thread?
    initialiseInsights();

    // The parent can post a few different messages to us
    //
    // action: shutdown
    // action: track
    parentPort.on('message', (task: ScoringCommand) => {
        // If we have been asked to exit then do so
        if (task.action == ScoringCommandEnum.shutdown) {
            console.log('closing worker');
            process.exit();
        }

        // Load data for specific tracker and add it to the list
        // of gliders to track
        if (task.action == ScoringCommandEnum.initialTrack) {
            const itTask: ScoringCommandTrack = task;
            console.log(`${task.className}/${task.compno}: initial track received ${itTask.points.length} positions ${itTask.handicap} hcap, ${itTask.utcStart} utcStart`);
            const alreadyScoring = !!gliders[makeClassname_Compno(task)]?.scoring;
            const existingTask = gliders[makeClassname_Compno(task)]?.task;

            gliders[makeClassname_Compno(task)] = {
                className: task.className,
                compno: task.compno,
                handicap: task.handicap,
                utcStart: task.utcStart,
                inorder: bindChannelForInOrderPackets(task.className, task.datecode, task.compno, itTask.points), //, () => (1659883036 - 4000) as Epoch),
                scoring: null,
                task: existingTask
            };

            if (alreadyScoring && existingTask) {
                rescoreGlider(task.compno, {className: task.className, datecode: task.datecode, airfield: workerData.airfield}, task.handicap, task.utcStart);
            }
        }

        // Actually start scoring the task, will score all the gliders we have tracks for
        if (task.action == ScoringCommandEnum.newtask) {
            console.log(`${task.className}: scoring started ${JSON.stringify(task?.task?.rules || {no: 'task'})}`);
            startScoring({className: task.className, datecode: task.datecode, airfield: workerData.airfield}, task.task);
            // Save task in case we rescore
            Object.values(gliders).forEach((g) => {
                g.task = task.task;
            });
        }

        if (task.action == ScoringCommandEnum.cleartask) {
            console.log(`${task.className}: scoring task cleared`);
            scoreUpdater.reset();
        }

        if (task.action == ScoringCommandEnum.rescoreGlider) {
            console.log(`${task.className}/${task.compno}: scoring started hcap: ${task.hcap}, start:${task.utcStart ? new Date(task.utcStart * 1000).toISOString() : '-'}`);
            rescoreGlider(task.compno, {className: task.className, datecode: task.datecode, airfield: workerData.airfield}, task.handicap, task.utcStart);
        }

        if (task.action == ScoringCommandEnum.clearGlider) {
            console.log(`${task.className}/${task.compno}: stopping scoring for ${task.compno}`);
            scoreUpdater.clearGlider(task.compno);
        }
    });
}

//
// Connect to the APRS Server
function startScoring(config: ScoringConfig, task: any) {
    console.log(`${config.className} -/ newTask ${task.details.taskid}/${task.details.task}: ${task.legs.map((l) => l.name).join(',')}...`);
    console.log(`${config.className} -> gliders: ${Object.keys(gliders).join(',')}`);

    try {
        const iterators: Record<Compno, any> = {};

        for (const glider of Object.values(gliders)) {
            // Loop through all of them
            glider.scoring = iterators[glider.compno] = getScoringChain(glider, config, task);
            glider.task = task;
        }

        // This setups up a set of async listeners for each of the above iterators
        // and a timer to collect the results to bundle them up and send back to the
        // parent port
        scoreUpdater = scoreCollector(15 as Epoch, parentPort, task, iterators, getNow, console.log);
    } catch (e) {
        console.log(e);
    }
}

function rescoreGlider(compno: Compno, config: ScoringConfig, handicap: number, utcStart: Epoch) {
    //
    const glider = gliders[makeClassname_Compno(config.className, compno)];
    glider.handicap = handicap;
    glider.utcStart = utcStart;

    if (!glider || !glider.task) {
        console.error(`unable to rescore glider ${compno}, ${config.className}: no task or glider not found`);
    } else {
        scoreUpdater.collect(compno, (glider.scoring = getScoringChain(glider, config, glider.task)));
    }
}

// Loop through all of them
function getScoringChain(glider: GliderState, config: ScoringConfig, task: any) {
    const log =
        glider.compno == '--'
            ? console.log
            : () => {
                  /*noop*/
              };

    // 0. Check if we are flying etc
    const epg = enrichedPositionGenerator(config.airfield, glider.inorder(getNow), log);

    // 1. Figure out where in the task we are
    const tpg = taskPositionGenerator(task, glider.utcStart, epg, log);

    // 2. Figure out what that means for leg distances
    const distances = task.rules.aat // what kind of scoring do we do
        ? assignedAreaScoringGenerator(task, tpg, log)
        : racingScoringGenerator(task, tpg, log);

    // 3. Once we have distances we can calculate task lengths
    //    and therefore speeds
    const scores = taskScoresGenerator(task, glider.compno, glider.handicap, distances, log);

    return scores;
}

// Correct timing for the competition
const compDelay = process.env.NEXT_PUBLIC_COMPETITION_DELAY ? parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') : 0;
let getNow = (): Epoch => (Math.trunc(Date.now() / 1000) - compDelay) as Epoch;

// And the replay
if (process.env.REPLAY) {
    let start = Math.trunc(Date.now() / 1000);
    let multiplier = parseInt(process.env.REPLAY_MULTIPLIER || '1');
    const replayBase = parseInt(process.env.REPLAY);

    getNow = (): Epoch => {
        const now = Math.trunc(Date.now() / 1000);
        const elapsed = now - start;
        const effectiveElapsed = elapsed * multiplier;
        return (replayBase + effectiveElapsed) as Epoch;
    };
}
