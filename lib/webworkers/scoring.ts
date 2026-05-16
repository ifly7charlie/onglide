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
import {Epoch, Datecode, ClassName_Compno, makeClassname_Compno, ClassName, Compno, InOrderGeneratorFunction, AirfieldLocation, PilotScore, Task} from '../types';

import {Worker, parentPort, isMainThread, SHARE_ENV, workerData} from 'node:worker_threads';

import {bindChannelForInOrderPackets} from './inordergenerator';

// Scoring types
import {assignedAreaScoringGenerator} from './assignedAreaScoringGenerator';
import {racingScoringGenerator} from './racingScoringGenerator';
import {enrichedPositionGenerator} from './enrichedPositionGenerator';

// DH adjuster
import {adjustDistanceHandicapTask} from '../flightprocessing/distancehandicap';
import {PreparedTurnpoint} from '../flightprocessing/preparedTurnpoint';

// Figure out where in the task we are and produce status around that - no speeds or scores
import {taskPositionGenerator} from './taskpositiongenerator';
import {taskScoresGenerator} from './taskScoresGenerator';
import {scoreCollector} from './scoreCollector';

// Optional flight statistics (thermals/straights/wind), per competition flag
import {createFlightStatistics} from './flightStatistics';

// Per-glider on-disk scoring log
import {createGliderLog, GliderLogHandle} from './gliderLog';

import {makeGetNow, getDelay} from '../now';

// Per-worker clock. Each scoring worker owns one class — and therefore one
// competition — so its getNow lags real-time by the comp's configured
// official delay. The scoring pipeline's inordergenerator gates output on
// this clock, so the visible delay on the public websocket matches the
// per-comp setting. Rebuilt in the setAirfield handler so live edits to
// competition.delayseconds take effect at the next rescore. In the main
// thread (where this module is loaded by `import` for the controller class
// but no scoring runs) we still wire a sensible getNow via the env-var
// fallback so any stray call matches the rest of the codebase.
let getNow: () => Epoch = makeGetNow(!isMainThread && workerData ? (workerData as ScoringConfig).airfield.officialDelay : getDelay());

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

export type scoreCallback = (message: {compno: Compno; score: PilotScore; recentStart: Epoch | undefined; t: Epoch | undefined; scoreId: string; migrateFrom?: string}) => void;

export interface ScoringConfig {
    className: ClassName;
    datecode: Datecode;
    airfield: AirfieldLocation;
    flightstats?: boolean;
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
    setInitialTrack(compno: Compno, handicap: number, utcStart: Epoch, points: PositionMessage[], scoreId: string, task: any) {
        const command: ScoringCommandTrack = {
            action: ScoringCommandEnum.initialTrack,
            className: this.className,
            datecode: this.datecode,
            compno,
            points,
            handicap,
            utcStart,
            scoreId,
            task
        };
        this.worker.postMessage(command);
    }

    // This actually starts scoring for the task
    setTask(task: any, scoreId: string) {
        this.worker.postMessage({action: ScoringCommandEnum.newTask, className: this.className, datecode: this.datecode, task, scoreId} as ScoringCommand);
    }

    clearTask() {
        this.worker.postMessage({action: ScoringCommandEnum.clearTask, className: this.className, datecode: this.datecode} as ScoringCommand);
    }

    rescoreGlider(compno: Compno, handicap: number, utcStart: Epoch, scoreId: string) {
        this.worker.postMessage({
            action: ScoringCommandEnum.rescoreGlider,
            className: this.className,
            datecode: this.datecode,
            compno,
            handicap,
            utcStart,
            scoreId
        } as ScoringCommand);
    }

    updateScoreId(oldScoreId: string, scoreId: string) {
        this.worker.postMessage({
            action: ScoringCommandEnum.updateScoreId,
            datecode: this.datecode,
            className: this.className,
            oldScoreId,
            scoreId
        } as ScoringCommand);
    }

    clearGlider(compno: Compno) {
        this.worker.postMessage({action: ScoringCommandEnum.clearGlider, className: this.className, datecode: this.datecode, compno} as ScoringCommand);
    }

    setAirfield(airfield: AirfieldLocation) {
        this.worker.postMessage({action: ScoringCommandEnum.setAirfield, className: this.className, datecode: this.datecode, airfield} as ScoringCommand);
    }

    // Send the shutdown command to the worker and return a promise that
    // resolves when the worker process has actually exited, or after a
    // 5-second timeout (so teardown doesn't hang if the worker is stuck).
    shutdown(): Promise<void> {
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };
            this.worker.once('exit', finish);
            this.worker.postMessage({action: ScoringCommandEnum.shutdown} as ScoringCommand);
            setTimeout(finish, 5000);
        });
    }

    hookScore(callback: scoreCallback) {
        this.worker.on('message', (msg) => ('score' in msg ? callback(msg) : 0));
    }
}

//////////////////////////////////////////////
//

interface GliderState {
    className: ClassName;
    compno: Compno;
    handicap: number;
    utcStart: Epoch;
    scoreId: string;

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

    // Per-glider on-disk log for the current scoring chain instance.
    // Recreated (and the file truncated) on every rescore.
    log?: GliderLogHandle;
}

// What are we scoring - we will register each one when
// an initial track is set
let gliders: Record<ClassName_Compno, GliderState> = {};
let scoreUpdater: ReturnType<typeof scoreCollector>;

// Control function via post message
enum ScoringCommandEnum {
    none,
    shutdown,
    newTask,
    clearTask,
    initialTrack,
    rescoreGlider,
    updateScoreId,
    clearGlider,
    setAirfield
}

export type ScoringCommand =
    | ScoringCommandShutdown
    | ScoringCommandNewTask
    | ScoringCommandTrack
    | ScoringCommandRescoreGlider
    | ScoringCommandUpdateScoreId
    | ScoringCommandClearGlider
    | ScoringCommandClearTask
    | ScoringCommandSetAirfield;

interface ScoringCommandBase {
    className: ClassName;
    datecode: Datecode;
}

// Task has changed
interface ScoringCommandNewTask extends ScoringCommandBase {
    action: ScoringCommandEnum.newTask;

    task: any; // should define type, this is what is returned by API call
    scoreId: string;
}

interface ScoringCommandRescoreGlider extends ScoringCommandBase {
    action: ScoringCommandEnum.rescoreGlider;

    compno: Compno;
    handicap: number;
    utcStart: Epoch;
    scoreId: string;
}

interface ScoringCommandUpdateScoreId extends ScoringCommandBase {
    action: ScoringCommandEnum.updateScoreId;

    oldScoreId: string;
    scoreId: string;
}

// Data for glider from DB - will reset track point
// generators and initialise them with this data
interface ScoringCommandTrack extends ScoringCommandBase {
    action: ScoringCommandEnum.initialTrack;

    compno: Compno;
    handicap: number;
    utcStart: Epoch;

    // Historical points, must be in sorted order
    points: PositionMessage[];
    scoreId: string;
    task: any;
}

// Exit
interface ScoringCommandShutdown {
    action: ScoringCommandEnum.shutdown;
}

interface ScoringCommandClearGlider extends ScoringCommandBase {
    action: ScoringCommandEnum.clearGlider;
    compno: Compno;
}

interface ScoringCommandClearTask extends ScoringCommandBase {
    action: ScoringCommandEnum.clearTask;
}

// Site coordinates moved in the DB; mutate the worker's airfield in place
// and rescore every glider so sticky landing classifications recompute.
interface ScoringCommandSetAirfield extends ScoringCommandBase {
    action: ScoringCommandEnum.setAirfield;
    airfield: AirfieldLocation;
}

//
// Start a listener
function spawnScoringContestListener(config: ScoringConfig): Worker {
    if (!isMainThread) {
        throw new Error('umm, this is only available in main thread');
    }
    console.log(`Starting Scoring:${config.className} worker thread`);

    return new Worker(__filename, {env: SHARE_ENV, workerData: config, name: `${config.airfield.name}:${config.className}`});
}

if (!isMainThread) {
    console.log(`Started Scoring Thread for class ${workerData.className}/${workerData.datecode} :)`);

    // Perhaps we need to do this in the thread?
    initialiseInsights();

    // The parent can post a few different messages to us
    //
    // action: shutdown
    // action: track
    parentPort?.on('message', (task: ScoringCommand) => {
        // If we have been asked to exit then do so
        if (task.action == ScoringCommandEnum.shutdown) {
            console.log('closing worker');
            process.exit();
        }

        // Load data for specific tracker and add it to the list
        // of gliders to track
        switch (task.action) {
            case ScoringCommandEnum.initialTrack: {
                const itTask: ScoringCommandTrack = task;
                console.log(`${task.className}/${task.compno}: ${itTask.handicap} hcap, ${itTask.utcStart} utcStart [${itTask.scoreId}]`);
                const alreadyScoring = !!scoreUpdater;

                // Structured cloning across the worker boundary strips class
                // prototypes, so any preparedLegs in the incoming task are
                // plain objects. Rebuild them as PreparedTurnpoint instances.
                if (task.task?.legs) {
                    task.task.preparedLegs = task.task.legs.map((_leg, i) => new PreparedTurnpoint(task.task.legs, i));
                }

                gliders[makeClassname_Compno(task)] = {
                    className: task.className,
                    compno: task.compno,
                    handicap: task.handicap,
                    utcStart: task.utcStart,
                    inorder: bindChannelForInOrderPackets(task.className, task.datecode, task.compno, itTask.points),
                    scoring: null,
                    task: task.task,
                    scoreId: task.scoreId
                };

                if (alreadyScoring) {
                    rescoreGlider(task.compno, {className: task.className, datecode: task.datecode, airfield: workerData.airfield, flightstats: workerData.flightstats}, task.handicap, task.utcStart, task.scoreId);
                }

                break;
            }

            // Actually start scoring the task, will score all the gliders we have tracks for
            case ScoringCommandEnum.newTask:
                console.log(`${task.className}: scoring started ${JSON.stringify(task?.task?.rules || {no: 'task'})} [${task.scoreId}]`);
                startScoring({className: task.className, datecode: task.datecode, airfield: workerData.airfield, flightstats: workerData.flightstats}, task.task, task.scoreId);
                break;

            case ScoringCommandEnum.clearTask:
                console.log(`${task.className}: scoring task cleared`);
                scoreUpdater?.reset();
                // Clear the task just in case
                Object.values(gliders).forEach((g) => {
                    g.task = undefined;
                });
                break;

            case ScoringCommandEnum.rescoreGlider:
                console.log(`${task.className}/${task.compno}: scoring started hcap: ${task.handicap}, start:${task.utcStart ? new Date(task.utcStart * 1000).toISOString() : '-'}`);
                rescoreGlider(task.compno, {className: task.className, datecode: task.datecode, airfield: workerData.airfield, flightstats: workerData.flightstats}, task.handicap, task.utcStart, task.scoreId);
                break;

            case ScoringCommandEnum.updateScoreId:
                console.log(`${task.className}: update scoreId from ${task.oldScoreId} to ${task.scoreId} for unchanged gliders`);
                scoreUpdater?.updateScoreId(task.oldScoreId, task.scoreId);
                break;

            case ScoringCommandEnum.clearGlider:
                console.log(`${task.className}/${task.compno}: stopping scoring for ${task.compno}`);
                scoreUpdater?.clearGlider(task.compno);
                break;

            case ScoringCommandEnum.setAirfield:
                // Mutate in place so any in-flight enrichedPositionGenerator
                // closures see the new point on their next read.
                Object.assign(workerData.airfield, task.airfield);
                // Rebuild the per-comp clock so a changed delayseconds
                // takes effect on the next rescore — scoring chains
                // constructed below close over this fresh getNow.
                getNow = makeGetNow(workerData.airfield.officialDelay);
                console.log(`${task.className}: airfield moved to (${workerData.airfield.lat},${workerData.airfield.lng}) delay=${workerData.airfield.officialDelay}s, rescoring ${Object.keys(gliders).length} gliders`);
                for (const g of Object.values(gliders)) {
                    rescoreGlider(g.compno, {className: g.className, datecode: workerData.datecode, airfield: workerData.airfield, flightstats: workerData.flightstats}, g.handicap, g.utcStart, g.scoreId);
                }
                break;
        }
    });
}

//
// Connect to the APRS Server
function startScoring(config: ScoringConfig, task, scoreId: string) {
    console.log(`${config.className} -/ newTask ${task.details.taskid}/${task.details.task}: ${task.legs.map((l) => l.name).join(',')}...`);
    console.log(`${config.className} -> gliders: ${Object.keys(gliders).join(',')}`);

    try {
        // This setups up a set of that handlers for rescoring and controlling a whole lot
        // of async iterators
        if (!scoreUpdater) {
            scoreUpdater = scoreCollector(parentPort!, config.className, getNow);
        }

        task.preparedLegs = task.legs.map((_leg, i) => new PreparedTurnpoint(task.legs, i));

        for (const glider of Object.values(gliders)) {
            glider.task = task;
            rescoreGlider(glider.compno, config, glider.handicap, glider.utcStart, scoreId);
        }
    } catch (e) {
        console.log(e);
    }
}

function rescoreGlider(compno: Compno, config: ScoringConfig, handicap: number, utcStart: Epoch, scoreId: string) {
    //
    const glider = gliders[makeClassname_Compno(config.className, compno)];
    glider.handicap = handicap;
    glider.utcStart = utcStart;
    glider.scoreId = scoreId;

    if (!glider) {
        console.log(`${config.className}/${compno}: unable to rescore glider (no glider configured) [${scoreId}]`, Object.keys(gliders));
    } else if (!glider.task) {
        console.log(`${config.className}/${compno}: unable to rescore glider (no task configured) [${scoreId}]`);
    } else {
        // Flush + close the previous chain's logger before the new chain
        // (and a fresh, truncated log file) is built in getScoringChain.
        glider.log?.close();
        scoreUpdater?.collect(compno, (glider.scoring = getScoringChain(glider, config, glider.task)), scoreId);
    }
}

// Loop through all of them
function getScoringChain(glider: GliderState, config: ScoringConfig, task: Task) {
    // Per-glider on-disk log: logs/<datecode>/<class>/<compno>.log,
    // truncated fresh for this chain instance.
    const log = createGliderLog(config.datecode, glider.className, glider.compno);
    glider.log = log;

    let handicap = glider.handicap;

    // Distance handicap
    if (task.rules.dh) {
        log('adjusting for dh task');
        task = adjustDistanceHandicapTask(task, glider.handicap);
        //        handicap = 100;
    }

    // Optional: per-flight statistics (thermals/straights/wind). When
    // enabled we build a single FlightStatistics instance and wrap the
    // chain with it at both ends so the rest of the pipeline is unaware.
    const stats = config.flightstats ? createFlightStatistics(glider.compno, log) : null;

    // 0. Check if we are flying etc
    const epg = enrichedPositionGenerator(config.airfield, glider.inorder(getNow), log);
    const observed = stats ? stats.observer(epg) : epg;

    // 1. Figure out where in the task we are
    const tpg = taskPositionGenerator(task, glider.utcStart, observed, log);

    // 2. Figure out what that means for leg distances
    const distances = task.rules.aat // what kind of scoring do we do
        ? assignedAreaScoringGenerator(task, tpg, log)
        : racingScoringGenerator(task, tpg, log);

    // 3. Once we have distances we can calculate task lengths
    //    and therefore speeds
    const scores = taskScoresGenerator(task, glider.compno, handicap, distances, log);

    return stats ? stats.attacher(scores) : scores;
}
