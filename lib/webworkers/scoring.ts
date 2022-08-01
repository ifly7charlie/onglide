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

import {PositionMessage} from './positionmessage';
import {Epoch, ClassName_Compno, makeClassname_Compno, ClassName, Compno, FlarmID, Bearing, Speed} from '../types';

import {Worker, parentPort, isMainThread, workerData, SHARE_ENV} from 'node:worker_threads';

import {bindChannelForInOrderPackets, InOrderGeneratorFunction} from './inordergenerator';

// Figure out where in the task we are and produce status around that - no speeds or scores
import {taskPositionGenerator} from './taskpositiongenerator';

// Downsample something with a timestamp
import {everySoOftenGenerator} from './everysooftengenerator';

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

export interface ScoringConfig {
    className: ClassName;
}

export class ScoringController {
    className: ClassName;
    worker: Worker;

    constructor(config: ScoringConfig) {
        this.className = config.className;
        this.worker = spawnScoringContestListener(config);
    }

    // Load these points into scoring
    setInitialTrack(compno: Compno, points: PositionMessage[]) {
        this.worker.postMessage({action: ScoringCommandEnum.initialTrack, className: this.className, compno: compno, points: points});
    }

    // This actually starts scoring for the task
    setTask(task: any) {
        this.worker.postMessage({action: ScoringCommandEnum.newtask, className: this.className, task});
    }

    shutdown() {
        this.worker.postMessage({action: ScoringCommandEnum.shutdown});
    }
}

//////////////////////////////////////////////
//

interface GliderState {
    className: ClassName;
    compno: Compno;

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
    scoring: null;
}

// What are we scoring - we will register each one when
// an initial track is set
let gliders: Record<ClassName_Compno, GliderState> = {};

// Control function via post message
enum ScoringCommandEnum {
    none,
    shutdown,
    newtask,
    track,
    initialTrack
}

export type ScoringCommand = ScoringCommandShutdown | ScoringCommandNewTask | ScoringCommandTrack | any;

interface ScoringCommandBase {
    className: ClassName;
}

// Task has changed
interface ScoringCommandNewTask extends ScoringCommandBase {
    action: ScoringCommandEnum.newtask;

    task: any; // should define type, this is what is returned by API call
}

// Data for glider from DB - will reset track point
// generators and initialise them with this data
interface ScoringCommandTrack {
    action: ScoringCommandEnum.track;

    compno: Compno;

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
    console.log('Started Scoring:${config.className} worker thread');

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
            gliders[makeClassname_Compno(task)] = {
                className: task.className,
                compno: task.compno,
                inorder: bindChannelForInOrderPackets(makeClassname_Compno(task), task.initialPoints),
                scoring: null
            };
        }

        // Actually start scoring the task, will score all the gliders we have tracks for
        if (task.action == ScoringCommandEnum.newtask) {
        }
    });
}

//
// Connect to the APRS Server
function startScoring(config: ScoringConfig, task: any) {
    // Loop through all of them
    for (const cncn in gliders) {
        const glider = gliders[cncn];

        if (glider.scoring) {
            //			glider.scoring.stop();
        }

        scorePilot(glider, task);
    }
}

//
// Setup the pipeworks for the pilot, this does not reset any
// received APRS messages
async function scorePilot(glider: GliderState, task: any) {
    if (task.rules.aat) {
    } else {
        const tpg = taskPositionGenerator(task, glider.inorder, console.log);
        const esog = everySoOftenGenerator(30 as Epoch, tpg);

        for (const output in esog) {
            console.log(output);
        }
    }
}