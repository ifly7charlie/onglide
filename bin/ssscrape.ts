#!/usr/bin/env node

// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {createHash, randomBytes, createHmac} from 'crypto';

import {Tabletojson} from 'tabletojson'; // tabletojson = require('tabletojson').Tabletojson;

import * as htmlparser from 'htmlparser2';
//const htmlparser = require('htmlparser2');

import {findOne, findAll, existsOne, removeElement, getChildren, getInnerHTML, getOuterHTML, textContent, getAttributeValue} from 'domutils';

import {Element} from 'domhandler';

// Datecode helpers
import {fromDateCode, toDateCode} from '../lib/datecode';

// Helper
const fetcher = (url) => fetch(url).then((res) => res.json());
const https = require('node:https');

// We use these to get IGCs from SoaringSpot streaming
import {point} from '@turf/helpers';
import distance from '@turf/distance';
import bearing from '@turf/bearing';
import {getElevationOffset} from '../lib/getelevationoffset';
// handle unkownn gliders
import {capturePossibleLaunchLanding, processIGC, checkForOGNMatches} from '../lib/flightprocessing/launchlanding';

import _groupby from 'lodash.groupby';
import _forEach from 'lodash.foreach';

// DB access
//const db = require('../db')
import escape from 'sql-template-strings';
const mysql = require('serverless-mysql');
let mysql_db = undefined;

let cnhandicaps = {};

// Fix the turpoint types from SoaringSpot to what we know
const oz_types = {
    symmetric: 'symmetrical',
    next: 'np',
    previous: 'pp',
    fixed: 'fixed',
    start: 'sp'
};

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

    mysql_db = mysql({
        config: {
            host: process.env.MYSQL_HOST || 'db',
            database: process.env.MYSQL_DATABASE || 'ogn',
            user: process.env.MYSQL_USER || 'ogn',
            password: process.env.MYSQL_PASSWORD
        }
    });

    // Now get data from soaringspot
    ssscrape();
    roboControl();

    console.log('Background download from soaring spot enabled');
    setInterval(function () {
        ssscrape();
    }, 5 * 60 * 1000);
    setInterval(function () {
        roboControl();
    }, 3 * 60 * 60 * 1000);
}

main().then(() => {
    console.log('exiting');
});

async function roboControl() {
    // Allow the use of environment variables to configure the soaring spot endpoint
    // rather than it being in the database
    let url = null;
    let overwrite = false;
    if (process.env.ROBOCONTROL_URL) {
        url = process.env.ROBOCONTROL_URL;
    }

    if (!url) {
        // Get the soaring spot keys from database
        const row = (
            await mysql_db.query(escape`
              SELECT url, overwrite
                FROM scoringsource where type='robocontrol'`)
        )[0] ?? {url:null, overwrite:true};
        url = row.url;
        overwrite = row.overwrite ?? true;
    }

    if (!url) {
        return;
    }

    fetch(url)
        .then((res) => {
            if (res.status != 200) {
                console.log(` ${url}: ${res}`);
                return {};
            } else {
                return res.json();
            }
        })
        .then((data: any[] | any) => {
            let location = data;
            if (data?.message) {
                location = data.message;
            }
            for (const p of location || []) {
                if (p.flarm?.length) {
                    console.log(`updating tracker ${p.cn} to ${p.flarm.join(',')}`);
                    if( overwrite ) {
                        mysql_db.query(escape`UPDATE tracker SET trackerid = ${p.flarm.join(',')} WHERE compno = ${p.cn}`);
                    }
                    else {
                        mysql_db.query(escape`UPDATE tracker SET trackerid = ${p.flarm.join(',')} WHERE compno = ${p.cn} and trackerid='unknown'`);
                    }
                    mysql_db.query(escape`INSERT INTO trackerhistory VALUES ( ${p.cn}, now(), ${p.flarm.join(',')}, '', null, 'robocontrol' )`);
                }
            }
        });
}

async function ssscrape(deep = false) {
    // Get the soaring spot keys from database
    let keys: any = {};

    if (process.env.SOARINGSPOT_URL) {
        keys.url = process.env.SOARINGSPOT_URL;
        keys.overwrite = process.env.SOARINGSPOT_OVERWRITE || 1;
        keys.actuals = process.env.SOARINGSPOT_ACTUALS || 1;
        console.log('environment variable', keys);
    } else {
        keys = (
            await mysql_db.query(escape`
              SELECT *
                FROM scoringsource WHERE type='soaringspotscrape'`)
        )[0];
    }

    if (!keys) {
        console.log('no soaringspot keys configured');
        return {
            error: 'no soaringspot keys configured'
        };
    }

    console.log(
        'competition',
        await mysql_db.query(escape`SELECT *
                FROM competition`)
    );

    await fetch(keys.url + '/pilots')
        .then((res) => res.text())
        .then((body) => {
            let dom = htmlparser.parseDocument(body);
            console.log(dom);
            const contestInfo = findOne((x) => x.name == 'div' && x.attribs?.class != 'contest-title', dom?.children);

            console.log(contestInfo);

            const name = textContent(findOne((x) => x.name == 'h1', contestInfo?.children)).trim();
            const site = textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'location', contestInfo.children)).trim();
            const dates = textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'date', contestInfo.children)).trim();

            update_contest(name, dates, site, keys.url);

            // Now extract the pilots list
            console.log('***********');
            //			const pilots = tabfindAll( (test) => (test.name == 'tr' && test.parent?.name == 'tbody' ),
            const pilots = Tabletojson.convert(getOuterHTML(findOne((x) => x.attribs?.class == 'pilot footable toggle-arrow-tiny', dom.children)));
            update_pilots(pilots[0]);

            console.log(`found ${pilots[0].length} pilots`);
            console.log(name);
            console.log(site);
            console.log(dates);
            console.log(`looking for competition ${keys.contest_name}`);
        })
        .catch((err) => {
            console.log('ummm', err);
        });

    const extractTask = new RegExp(/taskNormalize\((\{.+\}), \[.*\)/);

    await fetch(keys.url + '/results')
        .then((res) => res.text())
        .then(async function (body) {
            let dom = htmlparser.parseDocument(body);
            let competitionnames = [];

            const allresults = findAll((x) => x.name == 'table' && x.attribs?.class == 'result-overview', dom.children);

            for (const result of allresults) {
                const nameRaw = textContent(findOne((x) => x.name == 'th', result.children)).trim();
                // Name for URLs and Database
                const classid = nameRaw
                    .replace(/\s*(class|klasse)/gi, '')
                    .replace(/[^A-Z0-9]/gi, '')
                    .substring(0, 14);

                const className = nameRaw.replace(/[_]/gi, ' ');

                console.log(className);

                // Add to the database
                await mysql_db.query(escape`
             INSERT INTO classes (class, classname, description, type )
                   VALUES ( ${classid}, ${className.substr(0, 29)}, ${className}, 'club' )
                    ON DUPLICATE KEY UPDATE classname=values(classname), description=values(description),
                                            type=values(type) `);

                await mysql_db.query(escape`insert ignore into compstatus (class) values ( ${classid} )`);

                // Make sure we have rows for each day and that compstatus is correct
                //    await mysql_db.query( escape`call contestdays()`);
                await mysql_db.query(escape`update compstatus set status=':', datecode=${toDateCode()}`);

                const dates = findAll((x) => x.name == 'tr' && x.parent?.nodeType == 1 && x.parent?.name == 'tbody', result.children);

                for (const day of dates) {
                    const keys = findAll((x) => x.name == 'td', day.children);

                    if (!keys?.length || keys?.length < 2) {
                        console.log('no dates yet');
                        continue;
                    }

                    const daynumber = textContent(keys[1])?.trim();
                    if (daynumber == 'No task') {
                        console.log('no task yet');
                        continue;
                    }

                    const dateGB = textContent(keys[0])?.match(/([0-9]{2})\/([0-9]{2})\/([0-9]{4})/);
                    if (!dateGB) {
                        console.log('no task yet');
                        continue;
                    }

                    const date = dateGB[3] + '-' + dateGB[2] + '-' + dateGB[1];

                    const url = getAttributeValue(toElement(keys[1].children[1]), 'href');

                    console.log(date, daynumber, url);
                    await fetch('https://www.soaringspot.com' + url)
                        .then((res) => res.text())
                        .then((body) => {
                            const task = body.match(extractTask);
                            if (task) {
                                const taskJSON = JSON.parse(task[1]);
                                process_day_task(taskJSON, classid, className);
                            }
                        });

                    const rurl = getAttributeValue(toElement(keys[3].children[1]), 'href');

                    console.log(date, daynumber, rurl);
                    await fetch('https://www.soaringspot.com' + rurl)
                        .then((res) => res.text())
                        .then((body) => {
                            var dom = htmlparser.parseDocument(body);
                            const classTable = new RegExp(/result-daily/);
                            const result_table_fragment = getOuterHTML(findOne((x) => (x.attribs?.class?.match(classTable) ? true : false), dom.children));
                            const results_html = Tabletojson.convert(result_table_fragment, {
                                stripHtmlFromCells: false
                            });
                            process_day_results(classid, className, date, daynumber, results_html);
                        });
                }
            }
        });
}

async function update_class(className, data, dataHtml) {
    // Get the name of the class, if not set use the type
    const nameRaw = className;

    // Name for URLs and Database
    const classid = nameRaw
        .replace(/\s*(class|klasse)/gi, '')
        .replace(/[^A-Z0-9]/gi, '')
        .substring(0, 14);

    const name = nameRaw.replace(/[_]/gi, ' ');

    // Add to the database
    await mysql_db.query(escape`
             INSERT INTO classes (class, classname, description, type )
                   VALUES ( ${classid}, ${name.substr(0, 29)}, ${name}, 'club' )
                    ON DUPLICATE KEY UPDATE classname=values(classname), description=values(description),
                                            type=values(type) `);

    await mysql_db.query(escape`insert ignore into compstatus (class) values ( ${classid} )`);

    // Make sure we have rows for each day and that compstatus is correct
    //    await mysql_db.query( escape`call contestdays()`);
    await mysql_db.query(escape`update compstatus set status=':', datecode=${toDateCode()}`);

    // Now add details of pilots
    await update_pilots(data['Piloter']);

    // Import the results
    //    await process_class_tasks_and_results(classid, className, dataHtml);
}

//
// generate pilot entries and results for each pilot, this needs to be done before we
// download the scores
async function update_pilots(data) {
    let unknowncompno = 0;
    let pilotnumber = 0;

    // Start a transaction for updating pilots
    let t = mysql_db.transaction();

    for (const pilot of data) {
        // Make sure it has a comp number
        if (!pilot.CN || pilot.CN == '') {
            pilot.contestant_number = -unknowncompno++;
            console.log('Skipping pilot as no registration', pilot);
            continue;
        }

        // And change handicaps to BGA style
        const greg = '';
        const compno = pilot.CN;
        const handicap = correct_handicap(pilot.Handicap);

        // Name for URLs and Database
        const classid = pilot.Class.replace(/\s*(class|klasse)/gi, '')
            .replace(/[^A-Z0-9]/gi, '')
            .substring(0, 14);

        function gravatar(x) {
            const y = createHash('md5')
                .update((x + '@comps.onglide.com').replace(/\s/g, '').toLowerCase())
                .digest('hex');
            console.log(y);
            return y;
        }

        pilotnumber = pilotnumber + 1;
        await t.query(escape`
             INSERT INTO pilots (class,firstname,lastname,homeclub,username,fai,country,email,
                                 compno,participating,glidertype,greg,handicap,registered,registereddt)
                  VALUES ( ${classid},
                           ${pilot.Contestant}, ${''}, ${pilot.Club}, null,
                           ${pilotnumber}, '',
                           ${gravatar(pilot.Contestant)},
                           ${compno},
                           'Y',
                           ${pilot.Glider},
                           ${greg},
                           ${handicap}, 'Y', NOW() )
                  ON DUPLICATE KEY UPDATE
                           class=values(class), firstname=values(firstname), lastname=values(lastname),
                           homeclub=values(homeclub), fai=values(fai), country=values(country), email=values(email),
                           participating=values(participating), handicap=values(handicap),
                           glidertype=values(glidertype), greg=values(greg), registereddt=NOW()`);
    }

    // remove any old pilots as they aren't needed, they may not go immediately but it will be soon enough
    await t
        .query(escape`DELETE FROM pilots WHERE registereddt < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`)

        // Trackers needs a row for each pilot so fill any missing, perhaps we should
        // also remove unwanted ones
        .query('INSERT IGNORE INTO tracker ( class, compno, type, trackerid ) select class, compno, "flarm", "unknown" from pilots')
        //  .query( 'DELETE FROM tracker where concat(class,compno) not in (select concat(class,compno) from pilots)' );

        // And update the pilots picture to the latest one in the image table - this should be set by download_picture
        //   .query( 'UPDATE PILOTS SET image=(SELECT filename FROM images WHERE keyid=compno AND width IS NOT NULL ORDER BY added DESC LIMIT 1)' );

        .rollback((e) => {
            console.log('rollback');
        })
        .commit();
}

//
// Store the task in the MYSQL
async function process_day_task(day, classid, classname) {
    let rows = 0;
    let date = day.task_date;
    let dateCode = toDateCode(date);

    let script = '';
    let status = day.result_status; //.replace(/^([a-z])/\U1/; I think this uppercases first letter? but perl

    // extract UK meta data from it (this is from UK scoring script and allows for windicapping
    let windspeed = 0;
    let winddir = 0;

    let tasktype = 'S';
    let duration = '00:00';
    if (day.task_type == 'assigned_area') {
        tasktype = 'A';
        duration = new Date(day.task_duration * 1000).toISOString().substr(11, 8);
    }

    // So we don't rebuild tasks if they haven't changed
    const hash = createHash('sha256').update(JSON.stringify(day)).digest('base64');
    const dbhashrow = await mysql_db.query(escape`SELECT hash FROM tasks WHERE datecode=${dateCode} AND class=${classid}`);

    if (dbhashrow && dbhashrow.length > 0 && hash == dbhashrow[0].hash) {
        console.log(`${classid} - ${date}: task unchanged`);
        console.log(hash, dbhashrow[0]);
        return;
    } else {
        console.log(`${classid} - ${date}: task changed`);
    }

    // Do this as one block so we don't end up with broken tasks
    await mysql_db
        .transaction()

        // If it is the current day and we have a start time we save it
        .query(
            escape`
            UPDATE compstatus SET starttime = COALESCE(${convert_to_mysql(day.no_start)},starttime)
              WHERE datecode = ${dateCode}`
        )

        // remove any old crud
        .query(escape`DELETE FROM tasks WHERE datecode=${dateCode} AND class=${classid} AND task='B'`)

        // and add a new one
        .query(
            escape`
          INSERT INTO tasks (datecode, class, flown, description, distance, hdistance, duration, type, task, hash )
             VALUES ( ${dateCode}, ${classid},
                      'N', ${day.task_type},
                      ${day.task_distance / 1000},
                      ${day.task_distance / 1000},
                      ${duration}, ${tasktype}, 'B', ${hash} )`
        )

        // This query is a built one as we have to have it all as one string :( darn transactions

        .query((r) => {
            const taskid = r.insertId;
            if (!taskid) {
                console.log(`${classid} - ${date}: unable to insert task!`);
                return null;
            }

            let values = [];
            let query = 'INSERT INTO taskleg ( class, datecode, taskid, legno, ' + 'length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12 ) ' + 'VALUES ';

            let previousPoint = null;
            let currentPoint = null;
            for (const tp of day.task_points.sort((a, b) => a.point_index - b.point_index)) {
                console.log(tp);

                // We don't handle multiple starts at all so abort
                if (tp.multiple_start != 0) {
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
                console.log(tpname, toDeg(tp.longitude), toDeg(tp.latitude));
                currentPoint = point([toDeg(tp.longitude), toDeg(tp.latitude)]);

                const leglength = previousPoint ? distance(previousPoint, currentPoint) : 0;
                const bearingDeg = previousPoint ? (bearing(previousPoint, currentPoint) + 360) % 360 : 0;
                let hi = 0; // only used when windicapping

                query = query + "( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sector', ?, ?, ?, ?, ?, ? ),";

                values = values.concat([classid, dateCode, taskid, tp.point_index, leglength, bearingDeg, toDeg(tp.latitude), toDeg(tp.longitude), hi, trigraph, tpname, oz_types[tp.oz_type], tp.oz_radius1 / 1000, tp.oz_line ? 90 : toDeg(tp.oz_angle1), tp.oz_radius2 / 1000, toDeg(tp.oz_angle2), tp.oz_type == 'fixed' ? toDeg(tp.oz_angle12) : 0]);
            }

            query = query.substring(0, query.length - 1);
            // This is done in the chaining
            return [query, values];
        })

        // Remove the old task and legs for this class and date
        .query((r, ro) => {
            const taskid = ro[ro.length - 2].insertId;
            return ['DELETE FROM tasks WHERE class=? AND taskid != ? AND datecode = ?', [classid, taskid, dateCode]];
        })
        .query((r, ro) => {
            const taskid = ro[ro.length - 3].insertId;
            return ['UPDATE tasks SET task="A", flown="Y" WHERE class=? AND taskid = ?', [classid, taskid]];
        })

        // redo the distance calculation, including calculating handicaps
        //        .query((r, ro) => {
        //          const taskid = ro[ro.length - 5].insertId;
        //         return escape`call wcapdistance_taskid( ${taskid} )`;
        //   })

        // make sure we have result placeholder for each day, we will fail to save scores otherwise
        .query(
            escape`INSERT IGNORE INTO pilotresult
               ( class, datecode, compno, status, start, finish, duration, distance, hdistance, speed, hspeed, igcavailable )
             SELECT ${classid}, ${dateCode},
               compno, '-', '00:00:00', '00:00:00', '00:00:00', 0, 0, 0, 0, 'N'
             FROM pilots WHERE pilots.class = ${classid}`
        )

        // And update the day with status and text etc
        .query(
            escape`INSERT INTO contestday (class, script, length, result_type, info, winddir, windspeed, daynumber, status,
                                                   notes, calendardate, datecode )
                                         VALUES ( ${classid}, LEFT(${script},60), ${Math.round(day.task_distance / 100) / 10},
                                                  ${status}, ${''}, winddir, windspeed, ${day.task_number}, 'Y',
                                                  ${day?.notes || ''}, ${date}, ${dateCode})
                                       ON DUPLICATE KEY
                                       UPDATE turnpoints = values(turnpoints), script = LEFT(values(script),60), length=values(length),
                                          result_type=values(result_type), info=values(info),
                                          winddir=values(winddir), windspeed=values(windspeed), daynumber=values(daynumber),
                                          status=values(status), notes=values(notes), calendardate=values(calendardate)`
        )

        // if it is today then set the briefing status properly, this is an update so does nothing
        // if they are marked as flying etc. If the day is cancelled we want that updated here as well
        // Status not used at present but a way of keeping track of if they are flying etc.
        .query(() => {
            if (day.result_status != 'cancelled') return ["UPDATE compstatus SET status='B' WHERE class=? AND datecode=? AND status NOT IN ( 'L', 'S', 'R', 'H', 'Z' )", [classid, dateCode]];
            else return ["UPDATE compstatus SET status='Z' WHERE class=? AND datecode=?", [classid, dateCode]];
        })

        // If it was cancelled then mark it as not flown, this will stop the UI from displaying it
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE tasks SET flown="N" WHERE class=? AND datecode=?', [classid, dateCode]];
            else return null;
        })
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE contestday SET status="N" WHERE class=? AND datecode=?', [classid, dateCode]];
            else return null;
        })
        // Combine results
        //  .query( escape`update pilotresult pr1 left outer join pilotresult pr2
        //               on pr1.compno = pr2.compno and pr2.datecode = todcode(date_sub(fdcode(pr1.datecode),interval 1 day))
        //               set pr1.prevtotalrank = coalesce(pr2.totalrank,pr2.prevtotalrank)` )

        // Update the last date for results
        .query(
            escape`UPDATE compstatus SET resultsdatecode = GREATEST(${dateCode},COALESCE(resultsdatecode,${dateCode}))
                       WHERE class=${classid}`
        )
        .query(
            escape`UPDATE competition SET lt = (select nlat from taskleg order by legno desc limit 1), 
                                               lg = (select nlng from taskleg order by legno desc limit 1) WHERE lt is null or lt = 0`
        )
        .rollback((e) => {
            console.log('rollback');
        })
        .commit();

    // and some logging
    console.log(`${classname}: processed task ${date}`);
}

async function process_day_results(classid, className, date, day_number, results) {
    let rows = 0;
    let doCheckForOGNMatches = false;
    let dateCode = toDateCode(date);

    if (!results || results[0].length < 0) {
        console.log(`${className}: ${date} - no results`);
        return;
    }

    const igcRe = new RegExp(/a href=&quot;.(en_gb.download-contest-flight.+=1)&quot;/i, 'i');
    const cnRe = new RegExp(/([A-Z0-9]+)\s*<.a>\s*$/i, 'i');
    const flagRe = new RegExp(/class="flag.*title="([a-z]+)"/i, 'i');

    // It's a big long list of results ;)
    for (const row of results[0]) {
        if (row['#'] == 'DNF') {
            continue;
        }

        let pilotExtractor = row.CN.match(cnRe);
        if (!pilotExtractor) {
            console.log(`${date} ${className} ${row.CN} - no CN found!`);
            continue;
        }

        let urlExtractor = row.CN.match(igcRe);
        if (!urlExtractor) {
            console.log(`${row.CN}: no IGC file at all!`);
        }
        const pilot = pilotExtractor[1];
        const url = urlExtractor && urlExtractor[1] ? 'https://www.soaringspot.com/' + urlExtractor[1] : undefined;

        // Update the pilots flag
        const flagExtractor = row.Contestant.match(flagRe);
        if (flagExtractor && day_number == 'Task 1') {
            const flag = flagExtractor[1].toUpperCase();
            mysql_db.query(escape`UPDATE pilots SET country = ${flag} where compno=${pilot} and class=${className}`);
        }

        function cDate(d) {
            if (d == undefined) {
                return undefined;
            }
            let x = new Date();
            const p = d.match(/([0-9]{2}):([0-9]{2}):([0-9]{2})/);
            x.setHours(p[1]);
            x.setMinutes(p[2]);
            x.setSeconds(p[3]);
            return x;
        }

        function cHour(d) {
            if (d == undefined) {
                return undefined;
            }
            const p = d.match(/^([0-9]{0,2}):*([0-9]{2}):([0-9]{2})/);
            if (!p) {
                return undefined;
            }
            return parseInt(p[1]) + parseInt(p[2]) / 60 + parseInt(p[3]) / 3600;
        }

        const rStart = row.Start != '' ? row.Start : null;
        const rFinish = row.Finish != '' ? row.Finish : null;
        const start = row.Start ? cDate(row.Start).getTime() / 1000 : 0;
        const finish = row.Time != '' ? cDate(row.Finish).getTime() / 1000 : 0;
        const duration = finish && start ? cHour(row.Time) : 0;

        // for the bga scoring script that includes handicapped in the decimals
        // it's a special case, but could be used by other competitions if they want to
        const actuals = parseFloat(row.Speed);
        const actuald = parseFloat(row.Distance);
        const handicap = correct_handicap(row.Handicap);

        let scoredvals = {
            as: duration ? actuald / duration : 0,
            ad: actuald,
            hs: duration ? actuald / (handicap / 100) / duration : 0,
            hd: actuald / (handicap / 100)
        };

        const finished = actuals > 0;

        // If there is data from scoring then process it into the database
        if ((row['#'] != 'DNF' && row['#'] != 'DNS') || finished) {
            const r = await mysql_db.query(escape`
                           UPDATE pilotresult
                           SET
                             start=TIME(COALESCE(${rStart},start)),
                             finish=TIME(COALESCE(${rFinish},finish)),
                             duration=COALESCE(TIMEDIFF(${rFinish},${rStart}),duration),
                             scoredstatus= ${finished ? 'F' : 'H'},
                             status = (CASE WHEN ((status = "-" or status = "S" or status="G") and ${finished} != "") THEN "F"
                                        WHEN   ((status = "-" or status = "S" or status="G") and ${row.Finish} != "") THEN "H"
                                        ELSE status END),
                             datafromscoring = "Y",
                             speed=${scoredvals.as}, distance=${scoredvals.ad},
                             hspeed=${scoredvals.hs}, hdistance=${scoredvals.hd},
                             daypoints=${parseInt(row.Points.replace(',', ''))}, dayrank=${parseInt(row['#'].replace('.', ''))}, totalpoints=${0}, totalrank=${0}, penalty=${0}
                          WHERE datecode=${dateCode} AND compno=${pilot} and class=${classid}`);

            //          console.log(`${pilot}: ${handicap} (${duration} H) ${scoredvals.ad} ${scoredvals.hd}` );
            rows += r.affectedRows;

            // check the file to check tracking details
            let {igcavailable} = (
                await mysql_db.query(escape`SELECT igcavailable FROM pilotresult
                                                              WHERE datecode=${dateCode} and compno=${pilot} and class=${classid}`)
            )[0] || {igcavailable: false};
            if ((igcavailable || 'Y') == 'N' && url) {
                await processIGC(classid, pilot, location, date, url, https, mysql, () => {});
                doCheckForOGNMatches = true;
            }
        }
    }

    // If we processed an IGC file we should check to see if we have an OGN launch/landing match
    if (doCheckForOGNMatches) {
        checkForOGNMatches(classid, date, mysql_db);
    }

    // Did anything get updated?
    if (rows) {
        await mysql_db.query(escape`UPDATE contestday SET results_uploaded=NOW()
                                 WHERE class=${classid} AND datecode=${dateCode} and STATUS != "Z"`);
    }

    // rescore the day, but only for preliminary results
    //    const status = day.result_status.toLowerCase();
    //    if( status == 'preliminary' ) {
    //        await db.query( escape`call daypoints(${classid})` );
    //    }
}

//
// We will now update the competition object, this isn't a new object
// as you will possibly want to tweak values in it!
//
async function update_contest(contest_name, dates, site_name, url) {
    // Add a row if we need to
    const count = await mysql_db.query('SELECT COUNT(*) cnt FROM competition');
    if (!count || !count[0] || !count[0].cnt) {
        console.log('Empty competition, pre-populating');
        await mysql_db.query(escape`INSERT IGNORE INTO competition ( tz, tzoffset, mainwebsite ) VALUES ( "Europe/London", 3600, ${url} )`);
    }

    console.log(dates);

    const matches = dates.match(/([0-9A-Z ,]+) – ([0-9A-Z ,]+)/i);
    if (matches) {
        console.log(matches);
        console.log(Date.parse(matches[1] + ' UTC'));

        //
        // Make sure the dates are copied across
        await mysql_db.query(escape`
         UPDATE competition SET start = from_unixtime(${Date.parse(matches[1] + ' UTC') / 1000}),
                                  end = from_unixtime(${Date.parse(matches[2] + ' UTC') / 1000}),
                                  countrycode = 'UK',
                                  name = ${contest_name}`);
    }

    // If we have a location then update
    const ssLocation = undefined;
    //	if( ssLocation && ssLocation.latitude ) {
    //      const lat = toDeg(ssLocation.latitude);
    //  //    const lng = toDeg(ssLocation.longitude);
    //        await mysql_db.query( escape`UPDATE competition SET lt = ${lat}, lg = ${lng},
    //                                                  sitename = ${ssLocation.name}`);
    location = (await mysql_db.query(escape`SELECT lt, lg FROM competition`))[0];

    if (location.lt) {
        // Save four our use
        location.point = point([location.lt, location.lg]);

        // Calculate elevation so we can do launch calculations from the IGC files
        getElevationOffset(location.lt, location.lg, (agl) => {
            location.altitude = agl;
            console.log('SITE Altitude:' + agl, location);
        });
    }

    if (0) {
        //keys.deep ) {
        // clear it all down, we will load all of this from soaring spot
        // NOTE: this should not be cleared every time, even though at present it is
        // TBD!!
        await mysql_db
            .transaction()
            .query(escape`delete from classes`)
            .query(escape`delete from logindetails where type="P"`)
            .query(escape`delete from pilots`)
            .query(escape`delete from pilotresult`)
            .query(escape`delete from contestday`)
            .query(escape`delete from compstatus`)
            .query(escape`delete from taskleg`)
            .query(escape`delete from tasks`)
            .commit();
        console.log('deep update requested, deleted everything');
    }
}

// Get rid of the T at the front...
function convert_to_mysql(jsontime) {
    return jsontime ? jsontime.replace(/^.*T/, '') : jsontime;
}

// From radians
function toDeg(a) {
    return (a / Math.PI) * 180;
}

//
// All the bizarre forms of handicap that have been spotted in scoring spot
function correct_handicap(handicap) {
    return !handicap ? 100 : handicap < 2 ? handicap * 100 : handicap > 140 ? handicap / 10 : handicap;
}

function toElement(x) {
    return x.nodeType == 1 ? (x as Element) : null;
}
