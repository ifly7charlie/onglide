#!/usr/bin/env node

// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {createHash, randomBytes, createHmac} from 'crypto';

// Helper
const fetcher = (url) => fetch(url).then((res) => res.json());
const https = require('node:https');
//import https from 'node:https';

// We use these to get IGCs from SoaringSpot streaming
import {point, Coord} from '@turf/helpers';
import distance from '@turf/distance';
import bearing from '@turf/bearing';
import {getElevationOffset} from '../lib/getelevationoffset';
// handle unkownn gliders
import {processIGC, checkForOGNMatches} from '../lib/flightprocessing/launchlanding';

import {toDateCode} from '../lib/datecode';
import {makeClassId} from '../lib/classid';

import {groupBy as _groupby, forEach as _forEach} from 'lodash';

// DB access
//const db = require('../db')
import escape from 'sql-template-strings';
const mysql = require('serverless-mysql');

let mysql_db;
//const fetch = require('node:fetch');

// Fix the turpoint types from SoaringSpot to what we know
const oz_types = {symmetric: 'symmetrical', next: 'np', previous: 'pp', fixed: 'fixed', start: 'sp'};

// Load the current file
const dotenv = require('dotenv');

// Location information, fetched from DB
var location;

// Set up background fetching of the competition
async function main() {
    if (dotenv.config({path: '.env.local'}).error) {
        console.log('New install: no configuration found, or script not being run in the root directory');
        process.exit();
    }

    console.error('HELLO');
    console.log(JSON.stringify(process.env));

    mysql_db = mysql({
        config: {
            host: process.env.MYSQL_HOST || 'db',
            database: process.env.MYSQL_DATABASE || 'ogn',
            user: process.env.MYSQL_USER || 'ogn',
            password: process.env.MYSQL_PASSWORD,
            decimalNumbers: true
        }
    });

    // Now get data from soaringspot
    soaringSpotAll();
    roboControl();

    console.log('Background api download from soaring spot enabled');
    setInterval(
        function () {
            soaringSpotAll();
        },
        5 * 60 * 1000
    );
    setInterval(
        function () {
            roboControl();
        },
        3 * 60 * 60 * 1000
    );
}

main();

async function roboControl() {
    // Allow the use of environment variables to configure the soaring spot endpoint
    // rather than it being in the database
    let robocontrol_url: string | null = null;
    let overwrite = false;
    if (process.env.ROBOCONTROL_URL) {
        robocontrol_url = process.env.ROBOCONTROL_URL;
    }

    if (!robocontrol_url) {
        // Get the soaring spot keys from database
        const row = (
            await mysql_db.query(escape`
                SELECT
                    url
                FROM
                    scoringsource
                WHERE
                    type = 'robocontrol'
            `)
        )[0] ?? {url: null, overwrite: true};
        robocontrol_url = row.url;
    }

    if (!robocontrol_url) {
        return;
    }

    console.log(`robocontrol url ${robocontrol_url} configured`);

    await fetch(robocontrol_url)
        .then((res) => {
            if (res.status != 200) {
                console.log(` ${robocontrol_url}: ${res}`);
                return {};
            } else {
                return res.json();
            }
        })
        .then(async (data: any[] | any) => {
            let location = data;
            if (data?.message) {
                location = data.message;
            }
            for (const p of location || []) {
                if (p.flarm?.length) {
                    updateTrackers(p.cn, p.flarm.join(','), 'robocontrol');
                }
            }
        });
}

async function updateTrackers(compno: string, trackerIds: string, feedType: 'robocontrol' | 'soaringspot') {
    let success = !!(
        await mysql_db.query(escape`
            UPDATE tracker
            SET
                trackerid = ${trackerIds},
                feedid = ${feedType}
            WHERE
                compno = ${compno}
                AND (
                    feedid = ${feedType}
                    OR feedid IS NULL
                )
        `)
    ).affectedRows;
    if (success) {
        console.log(`${feedType}: updated tracker ${compno} to ${trackerIds}`);
    }
    await mysql_db.query(escape`
        INSERT INTO
            trackerhistory
        VALUES
            (
                ${compno},
                now(),
                ${trackerIds},
                '',
                NULL,
                ${feedType}
            )
    `);
}

//
// Iterate every soaringspotkey row in scoringsource and process each competition.
async function soaringSpotAll(deep = false) {
    console.log('Checking SoaringSpot @ ' + new Date().toString());

    // Allow single-competition env var mode for dev/testing; compid must be supplied
    if (process.env.SOARINGSPOT_CLIENT_ID && process.env.SOARINGSPOT_SECRET && process.env.COMP_ID) {
        const keys: any = {
            compid: process.env.COMP_ID,
            client_id: process.env.SOARINGSPOT_CLIENT_ID,
            secret: process.env.SOARINGSPOT_SECRET,
            overwrite: parseInt(process.env.SOARINGSPOT_OVERWRITE || '0'),
            actuals: parseInt(process.env.SOARINGSPOT_ACTUALS || '1')
        };
        await soaringSpot(keys, deep);
        return;
    }

    // Fetch every configured soaringspotkey source and process each one independently
    const allKeys = (await mysql_db.query(escape`
        SELECT
            *
        FROM
            scoringsource
        WHERE
            type = 'soaringspotkey'
    `)) as any[];

    if (!allKeys?.length) {
        console.log('no soaringspot keys configured');
        return;
    }

    for (const keys of allKeys) {
        if (!keys.client_id || !keys.secret || !keys.compid) {
            console.log(`skipping soaringspotkey row: missing compid/client_id/secret`);
            continue;
        }
        try {
            await soaringSpot(keys, deep);
        } catch (e) {
            console.log(`soaringspot failed for compid=${keys.compid}:`, e);
        }
    }
}

//
// Function to score any type of task - checks the task type field in the database
// to decide how to delegate to the various different kinds of tasks
async function soaringSpot(keys: any, deep = false) {
    console.log(`Checking SoaringSpot for compid=${keys.compid} @ ${new Date().toString()}`);

    // If we should clean everything out or just update
    keys.deep = keys.overwrite || deep;

    // It's an enumerate API so we start at the top.  Use HTTPS, the rest of the
    // links in this code are HTTP because that is how they are returned in the JSON
    // HOWEVER! All fetches will be https because the enumeration links are all https
    const contests = (await sendSoaringSpotRequest('https://api.soaringspot.com/v1/', keys)) as any;
    if (!contests) {
        console.log('unable to fetch contest');
        return;
    }

    // loop through all, there probably is only one but API spec implies more than one.
    await contests._embedded['http://api.soaringspot.com/rel/contests'].forEach(async function (contest) {
        // If there are many you can filter on name in the soaringspotkey database, if that is
        // empty than accept all of then?!
        console.log(contest.name);
        if (!keys?.contest_name || contest.name == keys.contest_name || keys.contest_name == '') {
            // Update the competition global values
            await update_contest(contest, keys);

            // Update each class in the competition
            for (const cclass of contest._embedded['http://api.soaringspot.com/rel/classes'].map((c) => ({...c, order: Math.random()})).sort((a, b) => a.order - b.order)) {
                await new Promise((r) => setTimeout(r, 10000));
                await update_class(cclass, keys);
            }
        }
    });
}
/*

//      # get any url for flarm results
//    $flarmurl = $mysql->selectrow_array("select flarmcsvurl from competition");
elsif( flarmurl ) {
fetch_flarm_csv(flarmurl,'remote');
}


# shut down and wait
mysql->disconnect();

# we only do this once per run, no point doing it more and it could break the UI
overwrites{hostname} = 0;
}
*/

async function update_class(compClass, keys) {
    // Get the name of the class, if not set use the type
    const nameRaw = compClass.name ? compClass.name : compClass.type;

    // Globally-unique class identifier: hash of compid + raw name so two
    // competitions running the same SoaringSpot class ("Club", "Standard", ...)
    // never collide.
    const classid = makeClassId(keys.compid, nameRaw);

    const name = nameRaw.replace(/[_]/gi, ' ');

    const Dms = {
        unknown: null,
        club: 100,
        '15_meter': 120,
        standard: 120,
        '20_meter': 120,
        '18_meter': 140,
        open: 140
    };
    const handicapped = {
        unknown: 'N',
        club: 'Y',
        '15_meter': 'N',
        standard: 'N',
        '20_meter': 'Y',
        '18_meter': 'N',
        open: 'N'
    };
    const isHandicapped = handicapped[compClass.type?.toLowerCase() ?? 'unknown'] ?? handicapped['unknown'];
    const dm = Dms[compClass.type?.toLowerCase() ?? 'unknown'] ?? Dms['unknown'];

    // Add to the database
    await mysql_db.query(escape`
        INSERT INTO
            classes (
                class,
                compid,
                classname,
                description,
                type,
                handicapped,
                Dm
            )
        VALUES
            (
                ${classid},
                ${keys.compid},
                ${name.substr(0, 29)},
                ${name},
                ${compClass.type},
                ${isHandicapped},
                ${dm}
            ) ON DUPLICATE KEY
        UPDATE compid =
        VALUES
            (compid),
            classname =
        VALUES
            (classname),
            description =
        VALUES
            (description),
            type =
        VALUES
            (type),
            handicapped =
        VALUES
            (handicapped),
            Dm =
        VALUES
            (Dm)
    `);

    await mysql_db.query(escape`
        insert ignore INTO compstatus (class)
        VALUES
            (${classid})
    `);

    // Make sure we have rows for each day and that compstatus is correct
    //    await mysql.query( escape`call contestdays()`);
    //    await mysql_db.query(escape`update compstatus set status=':', datecode=todcode(now())`);

    // Now add details of pilots
    await update_pilots(compClass._links.self.href, classid, name, keys);
    await new Promise((r) => setTimeout(r, 15000));

    // Import the results
    await process_class_tasks(compClass._links.self.href, classid, name, keys);
    await new Promise((r) => setTimeout(r, 15000));
    await process_class_results(compClass._links.self.href, classid, name, keys);
}

//
// generate pilot entries and results for each pilot, this needs to be done before we
// download the scores
async function update_pilots(class_url, classid, classname, keys) {
    let unknowncompno = 0;

    // Fetch the list of pilots
    const results = await sendSoaringSpotRequest(class_url + '/contestants', keys);
    if (!results) {
        console.log(classid, 'unable to fetch contestants');
        return;
    }

    // Start a transaction for updating pilots
    let t = mysql_db.transaction();

    for (const pilot of results._embedded['http://api.soaringspot.com/rel/contestants']) {
        // Make sure it has a comp number
        if (!pilot.contestant_number || pilot.contestant_number == '' || !!pilot.contestant_number.match(/(TBA|TBD)/)) {
            continue;
        }

        // And change handicaps to BGA style
        pilot.handicap = correct_handicap(pilot.handicap);

        // Get nested data more easily
        const epilot = pilot._embedded['http://api.soaringspot.com/rel/pilot'][0];
        const compno = pilot.contestant_number.substring(0, 4);

        const flarmIds = pilot.live_track_id || 'unknown'; //(list of flarm ids)

        const gravatar = (pilot) => {
            if (pilot.email) {
                return createHash('md5').update(pilot.email.trim().toLowerCase()).digest('hex');
            } else {
                return createHash('md5')
                    .update((pilot.first_name + pilot.last_name + '@comps.onglide.com').replace(/\s/g, '').toLowerCase())
                    .digest('hex');
            }
        };

        await t.query(escape`
            INSERT INTO
                pilots (
                    class,
                    firstname,
                    lastname,
                    homeclub,
                    username,
                    fai,
                    country,
                    email,
                    compno,
                    participating,
                    glidertype,
                    greg,
                    handicap,
                    registered,
                    registereddt
                )
            VALUES
                (
                    ${classid},
                    ${pilot.name?.substring(0, 30) || ''},
                    '',
                    ${pilot.club?.substring(0, 80) || ''},
                    NULL,
                    ${epilot.civl_id ? epilot.civl_id : epilot.igc_id},
                    ${epilot.nationality?.substring(0, 2) || ''},
                    ${gravatar(epilot)},
                    ${compno},
                    ${pilot.not_competing ? 'N' : 'Y'},
                    ${pilot.aircraft_model.substring(0, 30) || ''},
                    ${pilot.aircraft_registration?.substring(0, 8) || ''},
                    ${pilot.handicap},
                    'Y',
                    NOW()
                ) ON DUPLICATE KEY
            UPDATE class =
            VALUES
                (class),
                firstname =
            VALUES
                (firstname),
                lastname =
            VALUES
                (lastname),
                homeclub =
            VALUES
                (homeclub),
                fai =
            VALUES
                (fai),
                country =
            VALUES
                (country),
                email =
            VALUES
                (email),
                participating =
            VALUES
                (participating),
                handicap =
            VALUES
                (handicap),
                glidertype =
            VALUES
                (glidertype),
                greg =
            VALUES
                (greg),
                registereddt = NOW()
        `);

        // Make a list of the IDs, stripping anything but last 6 characters
        const flarms = flarmIds
            .split(/[,:]/)
            .map((id) => id.match(/([a-f0-9]{6})$/i)?.[1])
            .filter((id) => !!id);

        if (flarms.length) {
            updateTrackers(compno, flarms.join(','), 'soaringspot');
        }

        // Download pictures, sometime in the next 2 minutes
        if (epilot.igc_id) {
            setTimeout(
                () => {
                    download_picture(
                        pilot.contestant_number.substring(0, 4),
                        classid,
                        mysql, //
                        {igc_id: epilot.igc_id, compno: pilot.contestant_number?.substring(0, 4)?.trim(), class: classid, greg: pilot.aircraft_registration?.substring(0, 8)?.trim(), civil_id: epilot.civl_id}
                    );
                },
                Math.random() * 120_000 + 60_000
            );
        }
    }

    // remove any old pilots as they aren't needed, they may not go immediately but it will be soon enough
    await t
        .query(escape`
            DELETE FROM pilots
            WHERE
                class = ${classid}
                AND registereddt < DATE_SUB (NOW(), INTERVAL 15 MINUTE)
        `)

        // Trackers needs a row for each pilot so fill any missing, perhaps we should
        // also remove unwanted ones
        .query('INSERT IGNORE INTO tracker ( class, compno, type, trackerid ) select class, compno, "flarm", "unknown" from pilots')
        //  .query( 'DELETE FROM tracker where concat(class,compno) not in (select concat(class,compno) from pilots)' );

        // And update the pilots picture to the latest one in the image table - this should be set by download_picture
        .query('UPDATE pilots SET image=CASE ' + '   WHEN (SELECT count(*) FROM images i WHERE i.compno=pilots.compno AND i.class = pilots.class AND i.image IS NOT NULL) > 0 THEN "Y" ' + '   ELSE "N" END')

        // Remove any old trackers
        .query(escape`
            DELETE FROM tracker
            WHERE
                class = ${classid}
                AND compno NOT IN (
                    SELECT
                        compno
                    FROM
                        pilots
                    WHERE
                        class = ${classid}
                )
        `)

        .rollback((e) => {
            console.log('update pilots rollback', e);
        })
        .commit();
}

// Fetch the picture from FAI rankings
async function download_picture(compno, classid, mysql, context) {
    // Check when it was last checked
    const lastUpdated = (
        await mysql_db.query(escape`
            SELECT
                updated
            FROM
                images
            WHERE
                class = ${classid}
                AND compno = ${compno}
                AND (
                    image IS NOT NULL
                    OR unix_timestamp () - updated < 86400
                )
        `)
    )[0];

    if (lastUpdated) {
        console.log(`not updating ${compno} picture`);
        return;
    }

    // Find all the updater urls
    const urls = (await mysql_db.query(escape`
        SELECT
            url
        FROM
            scoringsource
        WHERE
            type = 'pictureurl'
        ORDER BY
            overwrite ASC
    `)) as {url: string}[];
    let success = false;

    for (const u of urls) {
        const url = u.url.replace(/\{([A-Z_]+)\}/gi, function (_, v) {
            return v in context ? context[v] : '';
        });

        console.log(`downloading picture for ${classid}:${compno} from ${url}`);

        const res = await fetch(url, {headers: {Referer: 'https://' + process.env.NEXT_PUBLIC_SITEURL + '/'}});

        if (res.status != 200) {
            console.log(` ${classid}:${compno}: website returns ${res.status}: ${res.statusText}`);
            continue;
        }

        const data = Buffer.from(await res.arrayBuffer());
        if (data) {
            await mysql_db.query(escape`
                INSERT INTO
                    images (class, compno, image, updated)
                VALUES
                    (
                        ${classid},
                        ${compno},
                        ${data},
                        unix_timestamp ()
                    ) ON DUPLICATE KEY
                UPDATE image =
                VALUES
                    (image),
                    updated =
                VALUES
                    (updated)
            `);
            success = true;
            break;
        } else {
            console.log('no data');
        }
    }

    if (!success) {
        console.log(` ${classid}:${compno}: image update failed`);
        await mysql_db.query(escape`
            INSERT INTO
                images (class, compno, image, updated)
            VALUES
                (
                    ${classid},
                    ${compno},
                    NULL,
                    unix_timestamp ()
                ) ON DUPLICATE KEY
            UPDATE image = NULL,
            updated =
            VALUES
                (updated)
        `);
    }
}

//
// for a given class update all the tasks
async function process_class_tasks(class_url, classid, classname, keys) {
    const tasks = await sendSoaringSpotRequest(class_url + '/tasks', keys);
    if (!tasks || 'code' in tasks || !('_embedded' in tasks)) {
        console.log(`${classname}: unable to fetch tasks ${tasks?.message}`);
        return 0;
    }
    const day = tasks._embedded['http://api.soaringspot.com/rel/tasks'].sort((a, b) => a.task_date.localeCompare(b.task_date)).at(-1);
    // Download the task and prep pilotresult table
    if (day) {
        console.log(`${classname}: date.task_date: task checks scheduled`);
        await process_day_task(day, classid, classname, keys);
    } else {
        console.log(`${classname}: no dates? `);
    }
}

//
// for a given class update all the results
async function process_class_results(class_url, classid, classname, keys) {
    const results = await sendSoaringSpotRequest(class_url + '/results', keys);
    if (!results || 'code' in results || !('_embedded' in results)) {
        console.log(`${classname}: no results: ${results?.message}`);
        return 0;
    }

    let dates: string[] = [];
    const day = results._embedded['http://api.soaringspot.com/rel/class_results'].sort((a, b) => a.task_date.localeCompare(b.task_date)).at(-1);
    if (day) {
        console.log(`${classname}: ${day.task_date}: result checks scheduled`);
        // Update the scores for the task
        await process_day_scores(day, classid, classname, keys);
    } else {
        console.log(`${classname}: no result dates? `);
    }
}

//
// Store the task in the MYSQL
async function process_day_task(day, classid, classname, keys) {
    let rows = 0;
    let date = day.task_date;

    const task_details = await sendSoaringSpotRequest(day._links.self.href, keys);

    if (!task_details || !task_details._links['http://api.soaringspot.com/rel/points']) {
        console.log(classid + '/' + date + ': no details for task');
        return;
    }

    let script = '';
    let info = task_details.info;
    let status = day.result_status; //.replace(/^([a-z])/\U1/; I think this uppercases first letter? but perl

    // extract UK meta data from it (this is from UK scoring script and allows for windicapping
    let windspeed = 0;
    let winddir = 0;
    if (info.match(/^UK/) && info.match(/Contest Wind.*deg.*kts/i)) {
        let info1, info2;
        [script, info1, info2] = task_details.info.split(',');
        info = (info1 + ',' + info2).replace(/^\s+/g, '');
        [windspeed, winddir] = info.match(/Contest Wind ([0-9]+) degs\/([0-9]+) kts/i);
    }

    let tasktype = 'S';
    let duration = '00:00';
    let W = 0;
    if (task_details.task_type == 'assigned_area') {
        tasktype = 'A';
        duration = new Date(task_details.task_duration * 1000).toISOString().substr(11, 8);
    }

    // Identify a distance handicap task, or an eglide one
    if (info.match(/distance handicapping/i)) {
        tasktype = 'D';
        if (task_details.notes.match(/kwh/i)) {
            tasktype = 'E';
        }
    } else if (winddir && windspeed) {
        const {contestWindDivisionFactor} = (
            await mysql_db.query(escape`
                SELECT
                    contestWindDivisionFactor
                FROM
                    global.comprules,
                    classes,
                    competition
                WHERE
                    classes.class = ${classid}
                    AND classes.type = comprules.name
                    AND comprules.country = competition.countrycode
            `)
        )[0];

        // calculate wind according to new rules
        // if the factor is not set or it is distance handicap then no windicapping
        W = contestWindDivisionFactor != 0 ? Math.min(windspeed / contestWindDivisionFactor, 30) : 0;

        console.log(classid, 'UK Windicapping Check, wddir=', winddir, ',W=', W);
    }

    // If there are no turnpoints then it isn't a valid task
    const turnpoints = await sendSoaringSpotRequest(task_details._links['http://api.soaringspot.com/rel/points'].href, keys);
    if (!turnpoints || !turnpoints._embedded || !turnpoints._embedded['http://api.soaringspot.com/rel/points'] || turnpoints._embedded['http://api.soaringspot.com/rel/points'].length < 2) {
        console.log(`${classid} - ${date}: no turnpoints defined`);
        return;
    }

    // Less likely to change for no reason
    const safeTask = {...task_details, ...(W ? {W, winddir} : {})};
    for (const t of ['_links', '_embedded', 'info', 'notes', 'qnh', 'task_value', 'task_name']) {
        delete safeTask[t];
    }

    // So we don't rebuild tasks if they haven't changed
    const hash = createHash('sha256').update(JSON.stringify(turnpoints._embedded['http://api.soaringspot.com/rel/points'])).update(JSON.stringify(safeTask)).digest('base64');
    const dbhashrow = await mysql_db.query(escape`
        SELECT
            hash
        FROM
            tasks
        WHERE
            datecode = ${toDateCode(date)}
            AND class = ${classid}
    `);

    if (dbhashrow && dbhashrow.length > 0 && hash == dbhashrow[0].hash) {
        console.log(`${classid} - ${date}: task unchanged`, hash, dbhashrow[0]?.hash);
        return;
    } else {
        console.log(`${classid} - ${date}: task changed`, hash, dbhashrow[0]?.hash);
    }

    // Get the height of the tp
    for (const tp of turnpoints._embedded['http://api.soaringspot.com/rel/points'].sort((a, b) => a.point_index - b.point_index)) {
        tp.altitude = await new Promise((resolve) => getElevationOffset(toDeg(tp.latitude), toDeg(tp.longitude), resolve));
    }

    // Do this as one block so we don't end up with broken tasks
    await mysql_db
        .transaction()

        // Advance the datecode and clear the status on day rollover.
        // Yesterday's L/S/R/F/H is meaningless to today's state machine,
        // and the status='B' update further down (or the 'Z' cancelled
        // path) will set the correct value if there's a task — ':' isn't
        // in its preserve list so it'll be overwritten cleanly. If no task
        // exists yet, ':' is the right "no task" state.
        .query(escape`
            UPDATE compstatus
            SET
                datecode = ${toDateCode(date)},
                status = ':'
            WHERE
                (
                    datecode < ${toDateCode(date)}
                    OR datecode IS NULL
                )
                AND class = ${classid}
        `)

        // If it is the current day and we have a start time we save it
        .query(
            task_details.no_start && !task_details.no_start.endsWith('00:00:00')
                ? escape`
                      UPDATE compstatus
                      SET
                          starttime = COALESCE(${convert_to_mysql(task_details.no_start)}, starttime)
                      WHERE
                          datecode = ${toDateCode(date)}
                          AND class = ${classid}
                  `
                : escape`
                      SELECT
                          1
                  `
        )

        // remove any old crud
        .query(escape`
            DELETE FROM tasks
            WHERE
                datecode = ${toDateCode(date)}
                AND class = ${classid}
                AND task = 'B'
        `)

        // and add a new one
        .query(escape`
            INSERT INTO
                tasks (
                    datecode,
                    class,
                    flown,
                    description,
                    duration,
                    type,
                    task,
                    nostart,
                    hash
                )
            VALUES
                (
                    ${toDateCode(date)},
                    ${classid},
                    'N',
                    ${task_details.task_type},
                    ${duration},
                    ${tasktype},
                    'B',
                    ${convert_to_mysql(task_details.no_start)},
                    ${hash}
                )
        `)

        // This query is a built one as we have to have it all as one string :( darn transactions

        .query((r) => {
            const taskid = r.insertId;
            if (!taskid) {
                console.log(`${classid} - ${date}: unable to insert task!`);
                return null;
            }
            if (!turnpoints || !turnpoints._embedded || !turnpoints._embedded['http://api.soaringspot.com/rel/points'] || turnpoints._embedded['http://api.soaringspot.com/rel/points'].length < 2) {
                console.log(`${classid} - ${date}: no turnpoints for task`);
                throw 'oops';
                return null;
            }

            let values: any[] = [];
            let query = 'INSERT INTO taskleg ( class, datecode, taskid, legno, ' + 'length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12, altitude ) ' + 'VALUES ';

            let previousPoint: Coord | null = null;
            let currentPoint: Coord | null = null;

            for (const tp of turnpoints._embedded['http://api.soaringspot.com/rel/points'].sort((a, b) => a.point_index - b.point_index)) {
                // We don't handle multiple starts at all so abort
                if (tp.multiple_start != 0) {
                    console.log(`${classid} - ${date}: multiple start not supported`);
                    continue;
                }

                // can we extract a number off the leading part of the turnpoint name, if so treat it as a trigraph
                // it must be leading, and 3 or 4 digits long and we will then strip it from the name
                let tpname = tp.name;
                let trigraph = tpname.substr(0, 3);
                if (tpname && ([trigraph] = tpname.match(/^([0-9]{1,4})/) || [trigraph])) {
                    tpname = tpname.replace(/^([0-9]{1,4})/, '').trim();
                }

                // So we can calculate distances etc
                previousPoint = currentPoint;
                currentPoint = point([toDeg(tp.longitude), toDeg(tp.latitude)]);

                const leglength = previousPoint ? distance(previousPoint, currentPoint) : 0;
                const bearingDeg = previousPoint ? (bearing(previousPoint, currentPoint) + 360) % 360 : 0;
                let hi = 0; // only used when windicapping

                // If we have windicapping then calculate the effect of the wind on the handicap
                if (W) {
                    //  theta & stuff
                    const radbear = toRad(bearingDeg);
                    const WdirRAD = toRad(winddir);
                    const theta = radbear - WdirRAD > Math.PI ? 2 * Math.PI - radbear + WdirRAD : radbear - WdirRAD;

                    // calcute the bearing & Hi
                    hi = 100 * (Math.sqrt(1 - (W / 46) * (W / 46) * Math.sin(theta) * Math.sin(theta)) - (1 + (W / 46) * Math.cos(theta)));
                    console.log(tp.point_index, ':theta=', theta, ',radbear=', radbear, ',hi=', hi, ',dist=', leglength, ',wdirrad', WdirRAD);
                }

                //            let query = "INSERT INTO taskleg ( class, datecode, taskid, legno, "+
                //              "length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12 ) "+
                //            "VALUES ";
                query = query + "( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sector', ?, ?, ?, ?, ?, ?, ? ),";
                values = values.concat([
                    classid, //
                    toDateCode(date),
                    taskid,
                    tp.point_index,
                    leglength,
                    bearingDeg,
                    toDeg(tp.latitude),
                    toDeg(tp.longitude),
                    hi,
                    trigraph,
                    tpname,
                    oz_types[tp.oz_type],
                    tp.oz_radius1 / 1000,
                    tp.oz_line ? 90 : toDeg(tp.oz_angle1),
                    tp.oz_radius2 / 1000,
                    toDeg(tp.oz_angle2),
                    tp.oz_type == 'fixed' ? toDeg(tp.oz_angle12) : 0,
                    tp.altitude
                ]);
            }

            // If we don't have any valid turnpoints then don't try and downloadthem!
            if (!query.length || !previousPoint) {
                return null;
            }

            query = query.substring(0, query.length - 1);
            // This is done in the chaining
            return [query, values];
        })

        // Remove the old task and legs for this class and date
        .query((r, ro) => {
            const taskid = ro[ro.length - 2].insertId;
            return ['DELETE FROM tasks WHERE class=? AND taskid != ? AND datecode = ?', [classid, taskid, toDateCode(date)]];
        })
        .query((r, ro) => {
            const taskid = ro[ro.length - 3].insertId;
            return ['UPDATE tasks SET task="A", flown="Y" WHERE class=? AND taskid = ?', [classid, taskid]];
        })

        // redo the distance calculation, including calculating handicaps
        //        .query( (r,ro) => { const taskid = ro[ro.length-5].insertId;
        //                          return escape`call wcapdistance_taskid( ${taskid} )` })

        // make sure we have result placeholder for each day, we will fail to save scores otherwise
        .query(escape`
            INSERT IGNORE INTO pilotresult (
                class,
                datecode,
                compno,
                status,
                start,
                finish,
                duration,
                distance,
                hdistance,
                speed,
                hspeed,
                igcavailable
            )
            SELECT
                ${classid},
                ${toDateCode(date)},
                compno,
                '-',
                '00:00:00',
                '00:00:00',
                '00:00:00',
                0,
                0,
                0,
                0,
                'N'
            FROM
                pilots
            WHERE
                pilots.class = ${classid}
        `)

        // And update the day with status and text etc
        .query(escape`
            INSERT INTO
                contestday (
                    class,
                    script,
                    length,
                    result_type,
                    info,
                    winddir,
                    windspeed,
                    daynumber,
                    status,
                    notes,
                    calendardate,
                    datecode
                )
            VALUES
                (
                    ${classid},
                    LEFT(${script}, 60),
                    ${Math.round(day.task_distance / 100) / 10},
                    ${status},
                    ${info.substring(0, 250)},
                    winddir,
                    windspeed,
                    ${day.task_number},
                    'Y',
                    ${task_details.notes},
                    ${date},
                    ${toDateCode(date)}
                ) ON DUPLICATE KEY
            UPDATE turnpoints =
            VALUES
                (turnpoints),
                script = LEFT(
                    VALUES
                        (script),
                        60
                ),
                length =
            VALUES
                (length),
                result_type =
            VALUES
                (result_type),
                info =
            VALUES
                (info),
                winddir =
            VALUES
                (winddir),
                windspeed =
            VALUES
                (windspeed),
                daynumber =
            VALUES
                (daynumber),
                status =
            VALUES
                (status),
                notes =
            VALUES
                (notes),
                calendardate =
            VALUES
                (calendardate)
        `)

        // if it is today then set the briefing status properly, this is an update so does nothing
        // if they are marked as flying etc. If the day is cancelled we want that updated here as well
        // Status not used at present but a way of keeping track of if they are flying etc.
        .query(() => {
            if (day.result_status != 'cancelled') return ["UPDATE compstatus SET status='B' WHERE class=? AND datecode=? AND status NOT IN ( 'L', 'S', 'R', 'F', 'H', 'Z' )", [classid, toDateCode(date)]];
            else return ["UPDATE compstatus SET status='Z' WHERE class=? AND datecode=?", [classid, toDateCode(date)]];
        })

        // If it was cancelled then mark it as not flown, this will stop the UI from displaying it
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE tasks SET flown="N" WHERE class=? AND datecode=?', [classid, toDateCode(date)]];
            else return null;
        })
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE contestday SET status="N" WHERE class=? AND datecode=?', [classid, toDateCode(date)]];
            else return null;
        })
        // Combine results
        //  .query( escape`update pilotresult pr1 left outer join pilotresult pr2
        //               on pr1.compno = pr2.compno and pr2.datecode = todcode(date_sub(fdcode(pr1.datecode),interval 1 day))
        //               set pr1.prevtotalrank = coalesce(pr2.totalrank,pr2.prevtotalrank)` )

        // Update the last date for results
        .query(escape`
            UPDATE compstatus
            SET
                resultsdatecode = GREATEST(
                    ${toDateCode(date)},
                    COALESCE(
                        resultsdatecode,
                        ${toDateCode(date)}
                    )
                )
            WHERE
                class = ${classid}
        `)

        .rollback((e) => {
            console.log('rollback', date, classid);
        })
        .commit();

    // and some logging
    console.log(`${classname}: processed task ${date}`);
}

async function process_day_scores(day, classid, classname, keys) {
    let rows = 0;
    let date = day.task_date;

    // It's a big long list of results ;)
    for (const row of day._embedded['http://api.soaringspot.com/rel/results']) {
        const pilot = row._embedded['http://api.soaringspot.com/rel/contestant'].contestant_number?.substring(0, 4);
        const handicap = correct_handicap(row._embedded['http://api.soaringspot.com/rel/contestant'].handicap);

        const start = row.scored_start ? new Date(row.scored_start).getTime() / 1000 : 0;
        const finish = row.scored_finish ? new Date(row.scored_finish).getTime() / 1000 : 0;
        const duration = finish && start ? (finish - start) / 3600 : 0;

        // Make sure it has a comp number
        if (!pilot || pilot == '' || !!pilot.match(/(TBA|TBD)/)) {
            continue;
        }

        let scoredvals: {as?: number; ad?: number; hd?: number; hs?: number} = {};
        if (keys.actuals < 0) {
            // for the bga scoring script that includes handicapped in the decimals
            // it's a special case, but could be used by other competitions if they want to
            let [hcapds, actualds] = ('' + row.scored_distance).split('.');
            const hcapd = hcapds ? parseInt(hcapds) : 0;
            while (actualds && actualds.length < 7) {
                actualds += '0';
            }
            const actuald = actualds ? parseInt(actualds) : 0;

            if (duration && row.scored_distance) {
                scoredvals.as = actuald / 1000 / duration / 3.6;
                scoredvals.ad = actuald;
                scoredvals.hs = row.scored_speed; //(hcapd / 10000 / duration) * 3.6);
                scoredvals.hd = hcapd;
            } else {
                scoredvals.as = scoredvals.hs = 0;
                scoredvals.ad = actuald;
                scoredvals.hd = hcapd;
            }
        } else if (keys.actuals) {
            // actuals on soaring spot (fai probably)
            scoredvals.as = row.scored_speed;
            scoredvals.ad = row.scored_distance;
            scoredvals.hs = duration ? row.scored_distance / (handicap / 100) / duration / 3600 : 0;
            scoredvals.hd = row.scored_distance / (handicap / 100);
        } else {
            //handicap on soaring spot
            scoredvals.as = duration ? (row.scored_distance * (handicap / 100)) / duration / 3600 : 0;
            scoredvals.ad = row.scored_distance * (handicap / 100);
            scoredvals.hs = row.scored_speed;
            scoredvals.hd = row.scored_distance;
        }

        const finished = row.scored_speed > 0;
        //        const scoredStatus = finished ? 'F' : row.igc_file ? 'H' : 'S';
        const scoredStatus = finished ? 'F' : row.scored_distance > 0 ? 'H' : 'S';

        // If there is data from scoring then process it into the database
        if (row.status_evaluated) {
            // check the file to check tracking details
            let {igcavailable, trackerid} = (
                await mysql_db.query(escape`
                    SELECT
                        igcavailable,
                        trackerid
                    FROM
                        pilotresult pr
                        LEFT OUTER JOIN tracker t ON t.class = pr.class
                        AND t.compno = pr.compno
                    WHERE
                        pr.datecode = ${toDateCode(date)}
                        AND pr.compno = ${pilot}
                        AND pr.class = ${classid}
                `)
            )?.[0] || {igcavailable: 'Y', trackerid: 'unknown'};

            const r = await mysql_db.query(escape`
                UPDATE pilotresult
                SET
                    start = TIME(
                        COALESCE(${convert_to_mysql(row.scored_start)}, start)
                    ),
                    finish = TIME(
                        COALESCE(${convert_to_mysql(row.scored_finish)}, finish)
                    ),
                    duration = COALESCE(
                        TIMEDIFF (
                            ${convert_to_mysql(row.scored_finish)},
                            ${convert_to_mysql(row.scored_start)}
                        ),
                        duration
                    ),
                    statuschanged = (
                        CASE
                            WHEN (scoredstatus = ${scoredStatus}) THEN statuschanged
                            ELSE NOW()
                        END
                    ),
                    datafromscoring = "Y",
                    igcavailable = "N",
                    scoredstatus = ${scoredStatus},
                    status = (
                        CASE
                            WHEN (
                                (
                                    status = "-"
                                    OR status = "S"
                                    OR status = "G"
                                )
                                AND ${row.scored_finish} != ""
                            ) THEN "F"
                            WHEN (
                                (
                                    status = "-"
                                    OR status = "S"
                                    OR status = "G"
                                )
                                AND ${row.igc_file} != ""
                            ) THEN "H"
                            ELSE status
                        END
                    ),
                    speed = ${scoredvals.as! * 3.6},
                    distance = ${scoredvals.ad! / 1000},
                    hspeed = ${scoredvals.hs! * 3.6},
                    hdistance = ${scoredvals.hd! / 1000},
                    daypoints = ${row.points},
                    dayrank = ${row.rank},
                    totalpoints = ${row.points_total},
                    totalrank = ${row.rank_total},
                    penalty = ${row.penalty}
                WHERE
                    datecode = ${toDateCode(date)}
                    AND compno = ${pilot}
                    AND class = ${classid}
            `);

            //          console.log(`${pilot}: ${handicap} (${duration} H) ${scoredvals.ad} ${scoredvals.hd}` );
            rows += r.affectedRows;

            console.log('igc:', pilot, row?._links, trackerid, igcavailable);

            if ((igcavailable || 'Y') == 'N' && trackerid == 'unknown' && row?._links?.['http://api.soaringspot.com/rel/flight']) {
                console.log(date, pilot, igcavailable, 'scheduling check for IGC');

                setTimeout(
                    () => {
                        console.log('checking IGC file for launch times', classid, date, pilot);
                        processIGC(
                            classid,
                            pilot,
                            location,
                            date,
                            row._links['http://api.soaringspot.com/rel/flight']['href'], // url for the download
                            https,
                            mysql_db,
                            () => soaringSpotAuthHeaders(keys)
                        );
                    },
                    10000 * Math.random() + 0 * randomEarlyMorningTimeDelay()
                );
            }
        }

        // if somebody has manually put the start times into SeeYou then capture it
        else if (row.scored_start) {
            await mysql_db.query(escape`
                UPDATE pilotresult
                SET
                    start = TIME(
                        COALESCE(${convert_to_mysql(row.scored_start)}, start)
                    )
                WHERE
                    datecode = ${toDateCode(date)}
                    AND compno = ${pilot}
                    AND class = ${classid}
            `);
        }

        // we will capture the total if it is there but not update the scored status as
        // that would block preliminary scoring
        if (row.points_total || row.rank_total) {
            await mysql_db.query(escape`
                UPDATE pilotresult
                SET
                    totalpoints = ${row.points_total},
                    totalrank = ${row.rank_total}
                WHERE
                    datecode = ${toDateCode(date)}
                    AND compno = ${pilot}
                    AND class = ${classid}
            `);
        }
    }

    // Did anything get updated?
    if (rows) {
        await mysql_db.query(escape`
            UPDATE contestday
            SET
                results_uploaded = NOW()
            WHERE
                class = ${classid}
                AND datecode = ${toDateCode(date)}
                AND STATUS != "Z"
        `);
    }
}

function randomEarlyMorningTimeDelay() {
    return new Date().setHours(0, 0, 0) - Date.now() + (24 + Math.random()) * 6 * 3600 * 1000;
}

//
// We will now update the competition object, this isn't a new object
// as you will possibly want to tweak values in it!
//
async function update_contest(contest, keys) {
    const compid = keys.compid;

    if (keys.deep) {
        // clear it all down, we will load all of this from soaring spot
        // NOTE: this should not be cleared every time, even though at present it is
        // TBD!!
        // All of these are scoped to compid so one competition's deep reset
        // does not touch other competitions' data.
        await mysql_db
            .transaction()
            .query(escape`DELETE FROM pilots WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM pilotresult WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM contestday WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM compstatus WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM taskleg WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM tasks WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM classes WHERE compid = ${compid}`)
            .query(escape`
                DELETE FROM logindetails
                WHERE
                    type = "P"
            `)
            .commit();
        console.log(`deep update requested, deleted everything for compid=${compid}`);
    }

    // Make sure a competition row exists for this compid
    const count = await mysql_db.query(escape`SELECT COUNT(*) cnt FROM competition WHERE compid = ${compid}`);
    if (!count || !count[0] || !count[0].cnt) {
        console.log(`Empty competition for compid=${compid}, pre-populating`);
        await mysql_db.query(escape`
            INSERT IGNORE INTO competition (compid, tz, tzoffset)
            VALUES (${compid}, 'Europe/Stockholm', 7200)
        `);
    }

    //
    // Make sure the dates are copied across
    await mysql_db.query(escape`
        UPDATE competition
        SET
            start = ${contest.start_date},
            END = ${contest.end_date},
            countrycode = ${contest.country},
            name = ${contest.name.substring(0, 59)}
        WHERE compid = ${compid}
    `);

    // If we have a location then update
    const ssLocation = contest._embedded['http://api.soaringspot.com/rel/location'];
    if (ssLocation && ssLocation.latitude) {
        const lat = toDeg(ssLocation.latitude);
        const lng = toDeg(ssLocation.longitude);
        await mysql_db.query(escape`
            UPDATE competition
            SET
                lt = ${lat},
                lg = ${lng},
                sitename = ${ssLocation.name}
            WHERE compid = ${compid}
        `);

        // Save four our use
        location = {
            lt: lat,
            lg: lng,
            point: point([lng, lat])
        };
        // Calculate elevation so we can do launch calculations from the IGC files
        getElevationOffset(location.lt, location.lg, (agl) => {
            location.altitude = agl;
            console.log('SITE Altitude:' + agl);
        });
    }

    //
    // We need to save timezone and calculate the offset from UTC
    const dbtz = (
        await mysql_db.query(escape`
            SELECT
                time_to_sec (
                    TIMEDIFF (
                        CONVERT_TZ (
                            NOW(),
                            '+00:00',
                            ${contest.time_zone}
                        ),
                        NOW()
                    )
                ) tzoffset
            FROM
                competition
            WHERE compid = ${compid}
        `)
    )[0];

    if (dbtz && dbtz.tzoffset) {
        await mysql_db.query(escape`
            UPDATE competition
            SET
                tz = ${contest.time_zone},
                tzoffset = ${dbtz.tzoffset}
            WHERE compid = ${compid}
        `);
    } else {
        console.log('TZ table not installed in mysql Please Correct (https://dev.mysql.com/doc/refman/8.0/en/mysql-tzinfo-to-sql.html)');
        process.exit();
    }

    // And fix the URL to whatever is configured in soaringspot
    let url = ('' + contest._links['http://api.soaringspot.com/rel/www'].href).match(/(http[^']*)/)?.[0];
    if (url) {
        await mysql_db.query(escape`
            UPDATE competition
            SET
                mainwebsite = ${url}
            WHERE compid = ${compid}
        `);
    }
}

//
// Calculate the SoaringSpot API keys
function soaringSpotAuthHeaders(keys) {
    // This is used to confirm all is fine
    const nonce = randomBytes(30).toString('base64');

    // Form the message
    const dt = new Date().toISOString();
    const message = nonce + dt + keys.client_id;

    // And hash it
    const hash = createHmac('sha256', keys.secret).update(message).digest('base64');
    const auth_header = 'http://api.soaringspot.com/v1/hmac/v1 ClientID="' + keys.client_id + '", Signature="' + hash + '", Nonce="' + nonce + '", Created="' + dt + '"';

    return {
        headers: {
            Authorization: auth_header
        }
    };
}

//
// Fetch values from the soaringpot api
//
async function sendSoaringSpotRequest(url, keys): Promise<any> {
    return fetch(url, soaringSpotAuthHeaders(keys))
        .then(async (res) => {
            if (!res.ok) {
                console.log('Error with soaring spot', url, res.status);
                console.log(await res.text());
                return null;
            }
            return res.json();
        })
        .catch((e) => {
            console.error(e);
            return null;
        });
}

// Get rid of the T at the front...
function convert_to_mysql(jsontime) {
    return jsontime ? jsontime.replace(/^.*T/, '') : jsontime;
}

// From radians
function toDeg(a) {
    return (a / Math.PI) * 180;
}

function toRad(a) {
    return (a * Math.PI) / 180;
}

//
// All the bizarre forms of handicap that have been spotted in scoring spot
function correct_handicap(handicap) {
    return !handicap ? 100 : handicap < 2 ? handicap * 100 : handicap > 140 ? handicap / 10 : handicap;
}
