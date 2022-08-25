import {PositionMessage, Compno, ClassName, Datecode, AirfieldLocation, Epoch, Task} from '../lib/types';

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

import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';

import * as dotenv from 'dotenv';

// Where is the comp based
const error = dotenv.config({path: '.env.local'}).error;

if (error) {
    console.log(error);
}

const db = mysql({
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

var argv = require('yargs/yargs')(process.argv.slice(2)).argv;

runScore((argv.datecode || '28K') as Datecode, (argv.class || 'standard') as ClassName, (argv.compno || '') as Compno, 100);

async function runScore(datecode, className, compno: Compno, handicap) {
    let location: AirfieldLocation = (await db.query('SELECT name, lt as lat,lg as lng,tz FROM competition LIMIT 1'))[0];
    location.point = point([location.lng, location.lat]);
    location.officialDelay = parseInt(process.env.NEXT_PUBLIC_COMPETITION_DELAY || '0') as Epoch;

    //
    // Now we will fetch the points for the pilots
    const rawpoints: PositionMessage[] = await db.query(escape`SELECT compno c, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s, 0 as l
                                              FROM trackpoints
                                             WHERE datecode=${datecode} AND class=${className} AND (${compno}='' OR compno = ${compno})
                                             ORDER BY t ASC`);

    console.log(`${className}: fetched ${rawpoints.length} rows of trackpoints (getInitialTrackPoints)`);

    // AND compno='LS3'

    const start = Date.now();
    const rbase = 1660924503 - 3600;
    //    let getNow = () => Math.trunc((Date.now() - start) / 1000) * 45 + rbase;
    const iterative = false;
    let getNow = () => Math.trunc(Date.now() / 1000);

    const groupedPoints: Record<Compno, PositionMessage[]> = _groupby(rawpoints, 'c');

    const log =
        compno != ''
            ? console.log
            : () => {
                  /*noop*/
              };

    const task = await updateTasks(className, datecode);

    for (const compno in groupedPoints) {
        console.log(compno, groupedPoints[compno].length);

        const inorder = bindChannelForInOrderPackets(className, compno as Compno, groupedPoints[compno], iterative, !iterative);

        // 0. Check if we are flying etc
        const epg = enrichedPositionGenerator(location, inorder(getNow), log);

        // 1. Figure out where in the task we are
        const tpg = taskPositionGenerator(task, epg, log);

        // 2. Figure out what that means for leg distances
        const distances = task.rules.aat // what kind of scoring do we do
            ? assignedAreaScoringGenerator(task, tpg, log)
            : racingScoringGenerator(task, tpg, log);

        // 3. Once we have distances we can calculate task lengths
        //    and therefore speeds
        const scores = taskScoresGenerator(task, compno as Compno, handicap, distances, log);

        let lastScore = null;
        let numberOfScores = 0;
        for await (const value of scores) {
            if (argv.verbose) {
                console.log(`${compno}: #${numberOfScores} - latest ${value.t} ${new Date(value.t * 1000).toUTCString()} ${lastScore?.actual?.taskDistance?.toFixed(0)}km, ${lastScore?.currentLeg}`);
            }
            lastScore = value;
            numberOfScores++;
        }

        console.log(`${compno}: done, ${printDate(lastScore.utcStart)} -${printDate(lastScore.utcFinish)}` + `${lastScore.actual?.taskDistance || 0}km, ${lastScore.actual?.taskSpeed}kph`);
        //        console.log(JSON.stringify(lastScore));
    }
}

const printDate = (x) => new Date(x * 1000).toUTCString();

async function updateTasks(className: ClassName, datecode: Datecode): Promise<Task | null> {
    // Get the details for the task
    const taskdetails = ((await db.query(escape`
         SELECT tasks.*, time_to_sec(tasks.duration) durationsecs, c.grandprixstart, c.handicapped,
               CASE WHEN nostart ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(fdcode(${datecode}),' ',nostart))-(SELECT tzoffset FROM competition)
               END nostartutc
          FROM tasks, classes c
          WHERE tasks.datecode= ${datecode}
             AND tasks.class = c.class 
             AND tasks.class= ${className} and tasks.flown='Y'
    `)) || {})[0];

    if (!taskdetails || !taskdetails.type) {
        console.log(`${className}: no active task`, taskdetails);
        return null;
    }

    const taskid = taskdetails.taskid;

    const tasklegs = (await db.query(escape`
      SELECT taskleg.*, nname name
        FROM taskleg
       WHERE taskleg.taskid = ${taskid}
      ORDER BY legno
`)) as any[];

    if (tasklegs.length < 2) {
        console.log(`${className}: task ${taskid} is invalid - too few turnpoints`);
        return null;
    }

    // These are invalid
    delete taskdetails.hdistance;
    delete taskdetails.distance;
    delete taskdetails.maxmarkingdistance;

    let task = {
        rules: {
            grandprixstart: taskdetails.type == 'G' || taskdetails.type == 'E' || taskdetails.grandprixstart == 'Y',
            nostartutc: taskdetails.nostartutc,
            aat: taskdetails.type == 'A',
            dh: taskdetails.type == 'D',
            handicapped: taskdetails.handicapped == 'Y'
        },
        details: taskdetails,
        legs: tasklegs
    };

    calculateTask(task);
    return task;
}
