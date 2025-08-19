import {PositionMessage, Compno, ClassName, Datecode, AirfieldLocation, Epoch, Task, PilotScore, FlarmID} from '../lib/types';

import {groupBy as _groupby, cloneDeep as _clonedeep, isEqual as _isEqual} from 'lodash';

import {bindChannelForInOrderPackets} from '../lib/webworkers/inordergenerator';

import {point} from '@turf/helpers';

import {calculateTask} from '../lib/flightprocessing/taskhelper';

// Scoring types
import {assignedAreaScoringGenerator} from '../lib/webworkers/assignedAreaScoringGenerator';
import {racingScoringGenerator} from '../lib/webworkers/racingScoringGenerator';
import {enrichedPositionGenerator} from '../lib/webworkers/enrichedPositionGenerator';

// Figure out where in the task we are and produce status around that - no speeds or scores
import {taskPositionGenerator} from '../lib/webworkers/taskpositiongenerator';
import {taskScoresGenerator} from '../lib/webworkers/taskScoresGenerator';

import type {Aircraft, Tracker} from '../lib/webworkers/aprs';
import {loadPointsForTracker, initDB, processMessageQueue} from '../lib/webworkers/aprs';

import {fromDateCode} from '../lib/datecode';

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
        password: process.env.MYSQL_PASSWORD
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
    .strict()
    .help()
    .parseSync();

runScore(argv.datecode as Datecode, argv.className as ClassName, argv.compno as Compno);

async function runScore(datecode: Datecode, className: ClassName, compno: Compno) {
    let location: AirfieldLocation = ((await mysql.query('SELECT name, lt as lat,lg as lng,tz FROM competition LIMIT 1')) as any)[0];
    location.point = point([location.lng, location.lat]);
    location.officialDelay = parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') as Epoch;
    const internalName = location.name.replace(/[^a-z]/gi, '').substring(0, 10);

    console.log(datecode, className, compno, location);

    const trackerDb: string = (
        await mysql.query(escape`
            SELECT
                trackerid
            FROM
                tracker
            WHERE
                class = ${className}
                AND compno = ${compno}
        `)
    )?.[0]?.trackerid;

    console.table(
        await mysql.query(escape`
            SELECT
                trackerid
            FROM
                tracker
            WHERE
                class = ${className}
                AND compno = ${compno}
        `)
    );
    console.log(trackerDb);

    const handicap: string = (
        await mysql.query(escape`
            SELECT
                handicap
            FROM
                pilots
            WHERE
                class = ${className}
                AND compno = ${compno}
        `)
    )?.[0]?.handicap;

    if (!trackerDb) {
        console.error('no trackers found for pilot');
        process.exit(1);
    }

    const glider: Aircraft = {
        compno,
        className: className,
        trackers: trackerDb.split(',') as FlarmID[],

        // Not had a message
        stationary: 0,
        ground: false,
        lastTick: 0 as Epoch,
        receiveNewPoints: false,

        // Setup logging
        log: argv.log
            ? function log() {
                  console.log(compno, ...arguments);
              }
            : function log() {},

        messages: []
    };

    // Make sure we have the latest datecode for the database
    const db = await initDB(datecode, internalName);

    const interimQueue: any[] = [];

    // Link the tracker(s) in
    const trackerList = glider.trackers;
    const trackers: Tracker[] = [];
    let index = 0;
    for (const id of [...new Set(trackerList)]) {
        console.log('load tracker', glider.compno, id);
        if (trackers[id]) {
            trackers[id].aircraftList.push(glider);
            trackers[id].receiveNewPoints = trackers[id].receiveNewPoints;
        } else {
            trackers[id] = {
                id: id as FlarmID,
                index: index++,
                aircraftList: [glider],
                receiveNewPoints: true,
                db: db?.sublevel(id, {})
            };
        }
        await loadPointsForTracker(glider, trackers[id], interimQueue);
    }

    console.log(`${className}: fetched ${interimQueue.length} rows of trackpoints (getInitialTrackPoints)`);

    const iterative = false;
    let getNow = () => Math.trunc(Date.now() / 1000) as Epoch;

    const log = argv.log
        ? console.log
        : () => {
              /*noop*/
          };

    const task = await getTask(className, datecode, 100);
    if (!task) {
        return;
    }

    glider.channel = {
        postMessage: (a) => interimQueue.push({...a, _: false})
    } as any;

    await processMessageQueue(glider);

    const inorder = bindChannelForInOrderPackets(className, datecode, compno as Compno, interimQueue, iterative, !iterative);

    // 0. Check if we are flying etc
    const epg = enrichedPositionGenerator(location, inorder(getNow), log);

    // 1. Figure out where in the task we are
    const tpg = taskPositionGenerator(task, 0 as Epoch, epg, log);

    // 2. Figure out what that means for leg distances
    const distances = task.rules.aat // what kind of scoring do we do
        ? assignedAreaScoringGenerator(task, tpg, log)
        : racingScoringGenerator(task, tpg, log);

    // 3. Once we have distances we can calculate task lengths
    //    and therefore speeds
    const scores = taskScoresGenerator(task, compno as Compno, parseFloat(handicap), distances, log);

    let lastScore: PilotScore | undefined;
    let numberOfScores = 0;
    for await (const value of scores) {
        if (argv.verbose && lastScore !== undefined) {
            console.log(`${compno}: #${numberOfScores} - latest ${value.t} ${new Date(value.t * 1000).toUTCString()} ${lastScore?.actual?.taskDistance?.toFixed(0)}km, ${lastScore?.currentLeg}`);
        }
        lastScore = value;
        numberOfScores++;
    }

    console.log(`${compno}: done, ${printDate(lastScore?.utcStart)} -${printDate(lastScore?.utcFinish)}` + `${lastScore?.actual?.taskDistance || 0}km, ${lastScore?.actual?.taskSpeed}kph`);
    //        console.log(JSON.stringify(lastScore));
    process.exit();
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
