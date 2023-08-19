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
import {Epoch, ClassName_Compno, makeClassname_Compno, ClassName, Compno, InOrderGenerator} from '../types';

import {Worker, parentPort, isMainThread, SHARE_ENV, workerData} from 'node:worker_threads';

import {bindChannelForInOrderPackets} from './inordergenerator';

import {cloneDeep as _clonedeep} from 'lodash';

export interface ReplayConfig {
    className: ClassName;
}

export class ReplayController {
    className: ClassName;
    worker: Worker;

    constructor(config: ReplayConfig) {
        this.className = config.className;
        this.worker = spawnReplayContestListener(config);
    }

    // Load these points into scoring
    setInitialTrack(compno: Compno, points: PositionMessage[], channelName: string) {
        this.worker.postMessage({action: ReplayCommandEnum.initialTrack, className: this.className, compno: compno, points: points, channelName});
    }

    // This actually starts scoring for the task
    start(task: any) {
        this.worker.postMessage({action: ReplayCommandEnum.start, className: this.className, task});
    }

    shutdown() {
        this.worker.postMessage({action: ReplayCommandEnum.shutdown});
    }

    hookScores(callback) {
        this.worker.on('message', callback);
    }
}

//////////////////////////////////////////////
//

interface GliderState {
    className: ClassName;
    compno: Compno;
    handicap: number;

    // Sequence of steps used to do the scoring
    // inorder returns a generator that gives all of the glider points
    // that have been received in the correct order and listens for any
    // new points
    inorder: InOrderGenerator;

    channel?: any;
}

// What are we scoring - we will register each one when
// an initial track is set
let gliders: Record<ClassName_Compno, GliderState> = {};
let channels: any = {};

// Control function via post message
enum ReplayCommandEnum {
    none,
    shutdown,
    start,
    initialTrack
}

export type ReplayCommand = ReplayCommandShutdown | ReplayCommandNewTask | ReplayCommandTrack | any;

interface ReplayCommandBase {
    className: ClassName;
    channelName: string;
}

// Task has changed
interface ReplayCommandNewTask extends ReplayCommandBase {
    action: ReplayCommandEnum.start;

    task: any; // should define type, this is what is returned by API call
}

// Data for glider from DB - will reset track point
// generators and initialise them with this data
interface ReplayCommandTrack {
    action: ReplayCommandEnum.initialTrack;

    compno: Compno;
    handicap: number;

    // Historical points, must be in sorted order
    points: PositionMessage[];
}

// Exit
interface ReplayCommandShutdown {
    action: ReplayCommandEnum.shutdown;
}

//
// Start a listener
function spawnReplayContestListener(config: ReplayConfig): Worker {
    if (!isMainThread) {
        throw new Error('umm, this is only available in main thread');
    }
    console.log(`Starting Replay:${config.className} worker thread`);

    return new Worker(__filename, {env: SHARE_ENV, workerData: config});
}

if (!isMainThread) {
    console.log(`Started Replay Thread for class ${workerData.className} :)`);

    // The parent can post a few different messages to us
    //
    // action: shutdown
    // action: track
    parentPort.on('message', (task: ReplayCommand) => {
        // If we have been asked to exit then do so
        if (task.action == ReplayCommandEnum.shutdown) {
            console.log('closing worker');
            process.exit();
        }

        // Load data for specific tracker and add it to the list
        // of gliders to track
        if (task.action == ReplayCommandEnum.initialTrack) {
            const itTask: ReplayCommandTrack = task;
            if (!channels[task.channelName]) {
                channels[task.channelName] = new BroadcastChannel(task.channelName);
            }

            let start = Math.trunc(Date.now() / 1000);
            let multiplier = parseInt(process.env.REPLAY_MULTIPLIER || '1');
            const replayBase = parseInt(process.env.REPLAY);

            // base + time elapsed * multiplier

            gliders[makeClassname_Compno(task)] = {
                className: task.className,
                compno: task.compno,
                handicap: task.handicap,
                inorder: bindChannelForInOrderPackets(
                    'replay' as ClassName,
                    task.compno,
                    task.datecode,
                    itTask.points,
                    true
                )((): Epoch => {
                    const now = Math.trunc(Date.now() / 1000);
                    const elapsed = now - start;
                    const effectiveElapsed = elapsed * multiplier;
                    return (replayBase + effectiveElapsed) as Epoch;
                }),
                channel: channels[task.channelName]
            };
        }

        // Actually start scoring the task, will score all the gliders we have tracks for
        if (task.action == ReplayCommandEnum.start) {
            startReplay({className: task.className});
        }
    });
}

//
// Connect to the APRS Server
async function startReplay(config: ReplayConfig) {
    console.log(`${config.className} -/ starting replay`);
    console.log(`${config.className} -> gliders: ${Object.keys(gliders).join(',')}`);

    try {
        const iterators: Record<Compno, any> = {};

        const promises: Promise<void>[] = [];

        // Loop through all of them
        for (const cncn in gliders) {
            const glider: GliderState = gliders[cncn];

            const iterateAndSend = async function (input: InOrderGenerator): Promise<void> {
                // Loop till we are told to stop
                try {
                    for await (const value of input) {
                        delete value._;
                        delete value.l;
                        value.v = '';
                        glider.channel.postMessage(value);
                    }
                } catch (e) {
                    console.log(`replay for ${glider.compno} failed, error:`, e);
                }
                console.log(`Completed replay for ${glider.compno}`);
            };

            promises.push(iterateAndSend(glider.inorder));
        }

        await Promise.allSettled(promises);
    } catch (e) {
        console.log(e);
    }

    console.log('Done all replay');
}
