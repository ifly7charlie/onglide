import {PositionStatus, PositionStatusText, Compno, ClassName, Datecode, AirfieldLocation, Epoch, Task, PilotScore, FlarmID} from '../lib/types';

import {groupBy as _groupby, cloneDeep as _clonedeep, isEqual as _isEqual} from 'lodash';

import {bindChannelForInOrderPackets} from '../lib/webworkers/inordergenerator';

import {point} from '@turf/helpers';

import {calculateTask} from '../lib/flightprocessing/taskhelper';
import {PreparedTurnpoint} from '../lib/flightprocessing/preparedTurnpoint';

// Scoring types
import {assignedAreaScoringGenerator} from '../lib/webworkers/assignedAreaScoringGenerator';
import {racingScoringGenerator} from '../lib/webworkers/racingScoringGenerator';
import {enrichedPositionGenerator} from '../lib/webworkers/enrichedPositionGenerator';

// Figure out where in the task we are and produce status around that - no speeds or scores
import {taskPositionGenerator} from '../lib/webworkers/taskpositiongenerator';
import {taskScoresGenerator} from '../lib/webworkers/taskScoresGenerator';
import {createFlightStatistics} from '../lib/webworkers/flightStatistics';

import type {Aircraft, Airfield} from '../lib/webworkers/aprs';
import {processMessageQueue} from '../lib/webworkers/aprs';
import {loadPoints} from '../lib/webworkers/pointlog';
import {competitionStartTs, fromDateCode} from '../lib/datecode';

import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';

import * as dotenv from 'dotenv';

// Where is the comp based
const error = dotenv.config({path: '.env.local'}).error;

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

if (error) {
    console.log(error);
}

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        // mysql2@3.x returns BIGINT/DECIMAL as strings by default;
        // restore mysql@2.x behaviour of returning numbers
        decimalNumbers: true
    },
    onError: (e) => {
        console.log(e);
    },
    onConnectError: (x) => {
        console.log('mysql connect errror', x);
    },
    onKill: (x) => {
        console.log('mysql killed xx', x);
    },
    onClose: (x) => {
        console.log('mysql connection closed', x);
    },
    onConnect: (x) => {
        console.log(`mysql connection opened ${x.config.host}:${x.config.port} user: ${x.config.user} state: ${x.state}`);
    },
    maxConnsFreq: 15 * 60 * 1000,
    usedConnsFreq: 10 * 60 * 1000,
    maxRetries: 2,
    zombieMaxTimeout: 120,
    connUtilization: 0.2
});

const argv = yargs(hideBin(process.argv))
    .scriptName('benchmark')
    .usage('$0 --legs ./legs.json [options]')
    .option('datecode', {
        type: 'string',
        demandOption: true,
        describe: 'datecode'
    })
    .option('className', {
        type: 'string',
        describe: 'Class'
    })
    .option('compno', {
        type: 'string',
        describe: 'compno to score'
    })
    .option('log', {
        type: 'boolean',
        describe: 'output logging'
    })
    .option('verbose', {
        type: 'boolean',
        describe: 'output logging of interim scores'
    })
    .strict()
    .help()
    .parseSync();

let location: AirfieldLocation;

run();

async function run() {
    const pilots = await mysql.query<{compno: Compno; class: ClassName; handicap: number; trackerid: string}[]>(escape`
        SELECT
            pilots.compno,
            pilots.class,
            handicap,
            trackerid
        FROM
            pilots
            LEFT JOIN tracker ON pilots.class = tracker.class
            AND pilots.compno = tracker.compno
        WHERE
            (
                NOT (${argv.className ?? ''} != '')
                OR pilots.class = ${argv.className}
            )
            AND (
                NOT ('' != (${argv.compno ?? ''}))
                OR pilots.compno IN (${argv.compno?.split(',')})
            )
    `);

    location = ((await mysql.query('SELECT name, lt as lat,lg as lng,tz FROM competition LIMIT 1')) as any)[0];
    location.point = point([location.lng, location.lat]);
    location.officialDelay = parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') as Epoch;
    const internalName = location.name.replace(/[^a-z]/gi, '').substring(0, 10);

    const results = (await Promise.allSettled(pilots.map((p) => runScore(argv.datecode as Datecode, p.class, p.compno, p.trackerid, p.handicap))))
        .filter((r) => r.status == 'fulfilled')
        .map((p) => p.value)
        .filter((p) => p !== undefined);

    const points = results.reduce((a, r) => a + (r.points as number), 0);

    const totalPoints = results.reduce((a, r) => a + (r.totalPoints as number), 0);
    const numberOfScores = results.reduce((a, r) => a + (r.numberOfScores as number), 0);
    const ms = results.reduce((a, r) => a + (r.ms as number), 0);
    results.push({
        compno: 'TOTAL',
        points,
        numberOfScores,
        totalPoints,
        ms,
        avgUs: +((ms * 1000) / (points || 1)),
        cps: +((points || 0) / (ms / 1000 || 1))
    } as any);

    console.table(
        results
            .map((p) => ({...p, ms: +p.ms.toFixed(1), avgUs: +p.avgUs.toFixed(3), cps: +p.cps.toFixed(0)})) //
            .sort((a, b) => ((b.taskSpeed ? b.taskSpeed * 100 : b.taskDistance) ?? -1) - ((a.taskSpeed ? a.taskSpeed * 100 : a.taskDistance) ?? -1))
    );
    process.exit(1);
}

async function runScore(datecode: Datecode, className: ClassName, compno: Compno, trackerDb: string, handicap: number, tzoffset: number = 0) {
    const log = argv.log
        ? console.log
        : () => {
              /*noop*/
          };

    if (!trackerDb) {
        log(`${className}/${compno}: no trackers found`);
        return;
    }

    // Stub airfield: mainthread-score is a replay/test harness that never
    // invokes the worker prefilter. Bbox absent → pre-task semantics if any
    // path ever did consult it.
    const stubAirfield: Airfield = {compid: '', point: [0, 0] as any, elevation: 0 as any};

    const glider: Aircraft = {
        compno,
        className: className,
        airfield: stubAirfield,
        trackers: trackerDb.split(',') as FlarmID[],

        datecode,
        tzoffset,

        // Not had a message
        stationary: 0,
        ground: false,
        lastTick: 0 as Epoch,
        receiveNewPoints: false,

        // Setup logging
        log,

        messages: []
    };

    const interimQueue: any[] = [];

    const dayMidday = new Date(fromDateCode(datecode)).getTime() / 1000 + 12 * 3600;
    const since = competitionStartTs(tzoffset, dayMidday);
    const until = since + 24 * 3600;

    for (const id of [...new Set(glider.trackers)]) {
        console.log('load tracker', glider.compno, id);
        for await (const msg of loadPoints({flarmId: id, since, until})) {
            const m = msg as any;
            if (typeof m.d === 'number' && m.d > 1200) continue;
            m.c = compno;
            interimQueue.push(m);
        }
    }
    interimQueue.sort((a, b) => a.t - b.t);

    log(`${className}/${compno}: fetched ${interimQueue.length} rows of trackpoints (getInitialTrackPoints)`);

    const iterative = false;
    let getNow = () => Math.trunc(Date.now() / 1000) as Epoch;

    const task = await getTask(className, datecode, 100);
    if (!task) {
        return;
    }

    task.preparedLegs = task.legs.map((_leg, i) => new PreparedTurnpoint(task.legs, i));

    // Debug: print task geometry for first invocation
    if (argv.compno && !argv.compno.includes(',')) {
        console.log(`\n=== Task Rules ===`);
        console.log(`  grandprixstart: ${task.rules.grandprixstart}, nostartutc: ${task.rules.nostartutc} (type: ${typeof task.rules.nostartutc})`);
        console.log(`  aat: ${task.rules.aat}, type: ${task.details.type}`);
        for (const [i, leg] of task.legs.entries()) {
            const pl = task.preparedLegs[i];
            console.log(`  leg ${i}: type=${leg.type} dir=${leg.direction} a1=${leg.a1} a12=${leg.a12} r1=${leg.r1} r2=${leg.r2} a2=${leg.a2}`);
            console.log(`    brNP=${pl.brNP?.toFixed(2)} brPP=${pl.brPP?.toFixed(2)} approachMid=${pl.approachMid.toFixed(2)} departureMid=${pl.departureMid.toFixed(2)}`);
            if (leg.type === 'line') {
                console.log(`    lineBearing=${pl.lineBearing.toFixed(2)} lineHalfLenM=${pl.lineHalfLenM} lineNormalSign=${pl.lineNormalSign}`);
                console.log(`    lineEndA=${JSON.stringify(pl.lineEndA)} lineEndB=${JSON.stringify(pl.lineEndB)}`);
            }
        }
        console.log(`===\n`);
    }

    // Enable line crossing debug for single pilot
    if (argv.compno && !argv.compno.includes(',')) {
        PreparedTurnpoint.debugLine = true;
    }

    const simplifiedQueue: any[] = [];
    glider.messages = interimQueue;
    glider.channel = {
        postMessage: (a) => simplifiedQueue.push({...a, _: false})
    } as any;

    await processMessageQueue(glider);
    if (simplifiedQueue.length) {
        simplifiedQueue.at(-1)._ = true;
    }

    console.log(`${glider.compno}: queue simplified from ${interimQueue.length} to ${simplifiedQueue.length}`);

    const start = process.hrtime.bigint();
    const inorder = bindChannelForInOrderPackets(className, datecode, compno as Compno, simplifiedQueue, iterative, !iterative);

    // Optional flight statistics — opt in via FLIGHTSTATS=1 or argv.flightstats
    const flightstats = !!(argv as any).flightstats || process.env.FLIGHTSTATS === '1';
    const stats = flightstats ? createFlightStatistics(compno as Compno, log) : null;

    // 0. Check if we are flying etc
    const epg = enrichedPositionGenerator(location, inorder(getNow), log);
    const observed = stats ? stats.observer(epg) : epg;

    // 1. Figure out where in the task we are
    const tpg = taskPositionGenerator(task, 0 as Epoch, observed, log);

    // 2. Figure out what that means for leg distances
    const distances = task.rules.aat // what kind of scoring do we do
        ? assignedAreaScoringGenerator(task, tpg, log)
        : racingScoringGenerator(task, tpg, log);

    // 3. Once we have distances we can calculate task lengths
    //    and therefore speeds
    const rawScores = taskScoresGenerator(task, compno as Compno, handicap, distances, log);
    const scores = stats ? stats.attacher(rawScores) : rawScores;

    let lastScore: PilotScore | undefined;
    let numberOfScores = 0;
    for await (const value of scores) {
        if (argv.verbose && lastScore !== undefined) {
            console.log(`${compno}: #${numberOfScores} - latest ${value.t} ${new Date(value.t * 1000).toUTCString()} ${lastScore?.actual?.taskDistance?.toFixed(0)}km, ${lastScore?.currentLeg}`);
        }
        lastScore = value;
        numberOfScores++;
        if (value.live) {
            break;
        }
    }
    const end = process.hrtime.bigint();

    const ms = Number(end - start) / 1e6;
    const points = simplifiedQueue.length;
    const avgUs = points ? (ms * 1000) / points : 0;
    const cps = points ? points / (ms / 1000) : 0;

    log(`${compno}: done, ${printDate(lastScore?.utcStart)} -${printDate(lastScore?.utcFinish)}` + `${lastScore?.actual?.taskDistance || 0}km, ${lastScore?.actual?.taskSpeed}kph`);
    log(`${compno}: ${numberOfScores} scores output, ${ms.toFixed(2)}ms -> avgUs: ${avgUs.toFixed(1)}, ${cps.toFixed(0)}/sec`);

    // Detailed output when running a single compno
    if (argv.compno && !argv.compno.includes(',') && lastScore) {
        console.log(`\n=== ${compno} Final Score Details ===`);
        console.log(`  start: ${printDate(lastScore.utcStart)} (${lastScore.utcStart})`);
        console.log(`  finish: ${lastScore.utcFinish ? printDate(lastScore.utcFinish) + ' (' + lastScore.utcFinish + ')' : 'NONE'}`);
        console.log(`  flightStatus: ${PositionStatusText[lastScore.flightStatus ?? PositionStatus.Unknown]}`);
        console.log(`  currentLeg: ${lastScore.currentLeg}`);
        console.log(`  taskDuration: ${lastScore.taskDuration}s (${lastScore.taskDuration ? (lastScore.taskDuration / 3600).toFixed(2) + 'h' : '-'})`);
        console.log(`  taskTimeRemaining: ${lastScore.taskTimeRemaining}s`);
        console.log(`  actual.taskDistance: ${lastScore.actual?.taskDistance}`);
        console.log(`  actual.taskSpeed: ${lastScore.actual?.taskSpeed}`);
        console.log(`  actual.distanceRemaining: ${lastScore.actual?.distanceRemaining}`);
        console.log(`  actual.minPossible: ${lastScore.actual?.minPossible}`);
        console.log(`  actual.maxPossible: ${lastScore.actual?.maxPossible}`);
        console.log(`  inSector: ${lastScore.inSector}, inPenalty: ${lastScore.inPenalty}`);
        console.log(`  task.rules: grandprix=${task.rules.grandprixstart}, aat=${task.rules.aat}, nostartutc=${task.rules.nostartutc}`);
        console.log(`  task.details.type: ${task.details.type}, durationsecs: ${task.details.durationsecs}`);
        console.log(`  Legs:`);
        for (const [legno, leg] of Object.entries(lastScore.legs)) {
            console.log(`    leg ${legno}: dist=${leg.actual?.distance}, taskDist=${leg.actual?.taskDistance}, speed=${leg.actual?.legSpeed}, time=${leg.time ? printDate(leg.time) : '-'}, dur=${leg.duration}s`);
        }
        console.log(`  home: dist=${lastScore.home?.distanceRemaining?.toFixed(1)}, gr=${lastScore.home?.grRemaining}`);
        console.log('===\n');
    }

    return {
        compno,
        totalPoints: interimQueue.length,
        points,
        numberOfScores,
        ms,
        avgUs,
        cps,
        start: lastScore?.utcStart ? new Date(lastScore.utcStart * 1000).toISOString().substring(11, 19) : '-',
        finish: lastScore?.utcFinish ? new Date(lastScore.utcFinish * 1000).toISOString().substring(11, 19) : '-',
        taskDistance: lastScore?.actual?.taskDistance,
        taskSpeed: lastScore?.actual?.taskSpeed,
        status: PositionStatusText[lastScore?.flightStatus ?? PositionStatus.Unknown]
    };
}

const printDate = (x) => new Date(x * 1000).toUTCString();

// Get the details for the task
const getTask = async (className: ClassName, datecode: Datecode, maxHandicap: number) => {
    const taskdetails = ((await mysql.query<any[]>(escape`
        SELECT
            tasks.*,
            time_to_sec (tasks.duration) durationsecs,
            c.grandprixstart,
            c.handicapped,
            c.Dm,
            cd.calendardate,
            cd.status,
            cd.info,
            0 AS distance,
            CASE
                WHEN COALESCE(nostart, '00:00:00') = '00:00:00' THEN 0
                ELSE UNIX_TIMESTAMP (
                    CONCAT(${fromDateCode(datecode)}, ' ', nostart)
                ) - (
                    SELECT
                        tzoffset
                    FROM
                        competition
                )
            END nostartutc
        FROM
            tasks,
            classes c,
            contestday cd
        WHERE
            tasks.datecode = ${datecode}
            AND tasks.class = c.class
            AND cd.class = c.class
            AND cd.datecode = ${datecode}
            AND tasks.class = ${className}
            AND tasks.flown = 'Y'
    `)) || {})[0];

    if (!taskdetails || !taskdetails.type) {
        console.log(`${className}/${datecode}: no active task`, taskdetails);
        return null;
    }

    const taskid = taskdetails.taskid;

    const tasklegs = await mysql.query<any[]>(escape`
        SELECT
            taskleg.*,
            nname name
        FROM
            taskleg
        WHERE
            taskleg.taskid = ${taskid}
        ORDER BY
            legno
    `);

    if (tasklegs.length < 2) {
        console.log(`${className}: task ${taskid} is invalid - too few turnpoints`);
        return null;
    }

    let task: Task = {
        rules: {
            grandprixstart: taskdetails.type == 'G' || taskdetails.type == 'E' || taskdetails.grandprixstart == 'Y',
            nostartutc: taskdetails.nostartutc,
            aat: taskdetails.type == 'A',
            dh: taskdetails.type == 'D' || taskdetails.handicapped == 'D',
            dm: taskdetails.Dm ?? undefined,
            handicapped: taskdetails.handicapped == 'Y' || taskdetails.type == 'D' || taskdetails.handicapped == 'D',
            maxHandicap
        },
        details: taskdetails,
        legs: tasklegs
    };
    calculateTask(task);
    return task;
};
