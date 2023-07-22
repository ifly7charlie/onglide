#!/usr/bin/env node

// Copyright 2020 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {createHash, randomBytes, createHmac} from 'crypto';

import {Tabletojson} from 'tabletojson'; // tabletojson = require('tabletojson').Tabletojson;

import * as htmlparser from 'htmlparser2';
//const htmlparser = require('htmlparser2');

import {findOne, findAll, existsOne, removeElement, getChildren, getInnerHTML, getOuterHTML, textContent, getAttributeValue} from 'domutils';

// Helper
const fetcher = (url) => fetch(url).then((res) => res.json());

// We use these to get IGCs from SoaringSpot streaming
import readline from 'readline';
import https from 'https';
import {point} from '@turf/helpers';
import distance from '@turf/distance';
import bearing from '@turf/bearing';
import {getElevationOffset} from '../lib/getelevationoffset.js';

// handle unkownn gliders
import {capturePossibleLaunchLanding, processIGC, checkForOGNMatches} from '../lib/flightprocessing/launchlanding.js';

import _groupby from 'lodash.groupby';
import _forEach from 'lodash.foreach';
import _reduce from 'lodash.reduce';

// DB access
import escape from 'sql-template-strings';
import mysql from 'serverless-mysql';
let mysql_db = undefined;
//import fetch from 'node-fetch';

let cnhandicaps = {};

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

    if (dotenv.error) {
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
    rst();

    console.log('Background download from rst enabled');
    setInterval(function () {
        rst();
    }, 5 * 60 * 1000);
}

main();

async function rst(deep = false) {
    // Get the soaring spot keys from database
    let keys: any = {};

    if (process.env.RST_URL) {
        keys.url = process.env.RST_URL;
        console.log('environment variable', keys);
    } else {
        keys = (
            await mysql_db.query(escape`
              SELECT *
                FROM scoringsource where type='rst'`)
        )[0];
    }

    if (!keys) {
        console.log('no rst key configured');
        return {
            error: 'no rst key configured'
        };
    }

    let hcaps = {};

    await fetch(keys.url)
        .then((res) => res.arrayBuffer())
        .then((buffer) => {
            console.log(buffer);
            const body = Buffer.from(buffer).toString('latin1');
            var dom = htmlparser.parseDocument(body);
            var competitionnames = [];
            const headings = findAll(
                (li: any) => li.name === 'li' && li?.attribs?.class == 'TabbedPanelsTab' && li?.parent?.parent?.attribs?.id == 'TabbedPanelsIHcup',
                findAll((tab) => tab.name == 'div' && tab?.attribs?.id == 'TabbedPanelsIHcup', dom.children)
            );

            for (const h of headings) {
                competitionnames.push(textContent(h));
            }

            // Get the handicaps from the result
            const gliders = findOne((li) => li.attribs?.id == 'id_idglider_fk', dom.children);
            for (const g of getChildren(gliders)) {
                const matches = textContent(g).match(/^([A-Z0-9]+[ -][A-Z0-9]+)\s.*koeff=([0-9]+)/);
                if (matches) {
                    hcaps[matches[1]] = parseInt(matches[2]);
                }
            }

            // Now extract the competitions
            console.log('***********');
            const matches = findAll((test) => {
                return test.name == 'div' && !!test?.attribs?.id?.match(/TabbedPanelsIHcup[0-9]+/);
            }, dom.children);

            console.log(`found ${matches.length} competitions on RST`);
            console.log(competitionnames);
            console.log(`looking for competition ${keys.contest_name}`);

            let mnumber = 0;
            for (const m of matches) {
                // Check to see if it is our configured competition, if it is then we will also extract the className from the name
                // it's considered to be anything after the competition name excluding leading whitespace
                const identity = competitionnames[mnumber].match(new RegExp(keys.contest_name, 'i'));
                //				const identity = competitionnames[mnumber].match( keys.contest_name, 'i' );
                if (identity) {
                    const className = identity[1] || keys.contest_name;
                    console.log('processing', className);

                    const removes = findAll((test) => test.name == 'select', m.children);
                    for (const r of removes) {
                        removeElement(r);
                    }

                    // Array of section headers
                    const sectionHeaders = findAll((test) => test.name == 'li' && test.attribs?.class == 'TabbedPanelsTab', m.children);

                    // Array of the sections themselves
                    const sections = findAll((test) => test.name == 'div' && test.attribs?.class == 'TabbedPanelsContent', m.children);

                    let mapped = {};
                    let mappedHtml = {};

                    for (let i = 0; i < sectionHeaders.length; i++) {
                        const sh = textContent(sectionHeaders[i]);
                        mapped[sh] = Tabletojson.convert(getInnerHTML(sections[i]), {stripHtmlFromCells: true});
                        mappedHtml[sh] = Tabletojson.convert(getInnerHTML(sections[i]), {stripHtmlFromCells: false});
                    }

                    update_contest(keys.contest_name, mapped['Info']);

                    // Put data into the database
                    update_class(className, mapped, mappedHtml, hcaps);
                    console.log('===');
                }
                mnumber = mnumber + 1;
            }
            console.log('done.');
        });
}

async function update_class(className, data, dataHtml, hcaps) {
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
    await mysql_db.query(escape`update compstatus set status=':', datecode=todcode(now())`);

    // Now add details of pilots
    console.log('--- pilots ---');
    console.log(data['Piloter']);
    await update_pilots(classid, data['Piloter'], hcaps);

    // Import the results
    await process_class_tasks_and_results(classid, className, dataHtml);
}

//
// generate pilot entries and results for each pilot, this needs to be done before we
// download the scores
async function update_pilots(classid, data, hcaps) {
    let unknowncompno = 0;
    let pilotnumber = 0;

    // Start a transaction for updating pilots
    let t = mysql_db.transaction();

    for (const pilot of data[0]) {
        // Make sure it has a comp number
        if (!pilot.Reg || pilot.Reg == '') {
            pilot.contestant_number = -unknowncompno++;
            console.log('Skipping pilot as no registration', pilot);
            continue;
        }

        let regsplit = pilot.Reg.match(/^([A-Z0-9]+[- ][A-Z0-9]+)\s+([A-Z0-9]+)$/);
        if (!regsplit) {
            regsplit = pilot.Reg.match(/^([A-Z0-9]+)[- ]([A-Z0-9]+)$/);
            if (!regsplit) {
                console.log("can't match registration", pilot.Reg);
                continue;
            }
            regsplit[1] = regsplit[1] + '-' + regsplit[2];
        }

        // And change handicaps to BGA style
        const greg = regsplit[1];
        const compno = regsplit[2];
        const handicap = correct_handicap(hcaps[greg]);
        cnhandicaps[classid + '_' + compno] = handicap;

        const gravatar = (pilot) => {
            return createHash('md5')
                .update((pilot.Pilot + '@comps.onglide.com').replace(/\s/g, '').toLowerCase())
                .digest('hex');
        };

        pilotnumber = pilotnumber + 1;
        await t.query(escape`
             INSERT INTO pilots (class,firstname,lastname,homeclub,username,fai,country,email,
                                 compno,participating,glidertype,greg,handicap,registered,registereddt)
                  VALUES ( ${classid},
                           ${pilot.Pilot}, ${pilot.Copilot}, ${pilot.Klubb}, null,
                           ${pilotnumber}, 'SE',
                           ${gravatar(pilot)},
                           ${compno},
                           'Y',
                           ${pilot.Segelflygplan},
                           ${greg},
                           ${handicap}, 'Y', NOW() )
                  ON DUPLICATE KEY UPDATE
                           class=values(class), firstname=values(firstname), lastname=values(lastname),
                           homeclub=values(homeclub), fai=values(fai), country=values(country),
                           participating=values(participating), handicap=values(handicap),
                           glidertype=values(glidertype), greg=values(greg), registereddt=NOW()`);
    }

    // remove any old pilots as they aren't needed, they may not go immediately but it will be soon enough
    t.query(escape`DELETE FROM pilots WHERE class=${classid} AND registereddt < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`)

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
// for a given class update all the tasks
async function process_class_tasks_and_results(classid, className, data) {
    let rows = 0;
    //    let date = day.task_date;
    for (const day of Object.keys(data)) {
        const matches = day.match(/Dag ([0-9]+)$/i);
        if (matches) {
            const day_number = parseInt(matches[1]);
            const day_data = data[day];

            const dbdate = await mysql_db.query(escape`SELECT DATE_ADD(start, INTERVAL ${day_number - 1} DAY) date FROM competition`);
            const date = dbdate[0].date;

            const day_info = day_data[0];
            const task_info = day_data[1];
            const results = day_data[2];

            process_class_task(classid, className, date, day_number, day_info, task_info);
            process_class_results(classid, className, date, day_number, results);
        }
    }
}

async function process_class_task(classid, className, date, day_number, day_info, task_info) {
    let script = '';
    let info = '';
    let status = '';

    // extract UK meta data from it (this is from UK scoring script and allows for windicapping
    let windspeed = 0;
    let winddir = 0;
    let tasktype = 'S';
    let tasktype_long = 'Speed';
    let duration = '00:00';
    let task_distance = 0;

    if (day_info) {
        info = [day_info[0]?.Distans, day_info[0]?.Minimitid, day_info[1]?.Minimitid].join(' ');

        task_distance = parseFloat(day_info[0]?.Minimitid || day_info[0]?.Distans);

        // Check for AAT
        if (day_info[1]?.Minimitid) {
            duration = day_info[1]?.Minimitid;
            tasktype = 'A';
            tasktype_long = 'AAT';
        }
    }

    if (task_info) {
        const tps = _reduce(
            task_info,
            function (text, v) {
                return [text, v.Label, v.Brytpunkt, v.Radie].join('_');
            },
            ''
        );
        const hash = createHash('sha256').update(info).update(tps).digest('base64');
        const dbhashrow = await mysql_db.query(escape`SELECT hash FROM tasks WHERE datecode=todcode(${date}) AND class=${classid}`);
        if (dbhashrow && dbhashrow.length > 0 && hash == dbhashrow[0].hash) {
            return;
        } else {
            console.log(`${classid} - ${date}: task changed`);
            console.log(tps);
        }
        for (const tp of task_info) {
            tp.altitude = await new Promise((resolve) => getElevationOffset(toDeg(tp.latitude), toDeg(tp.longitude), resolve));
        }

        // Do this as one block so we don't end up with broken tasks
        await mysql_db
            .transaction()

            // If it is the current day and we have a start time we save it
            //        .query( escape`
            //          UPDATE compstatus SET starttime = COALESCE(${convert_to_mysql(task_details.no_start)},starttime)
            //          WHERE datecode = todcode(${date})` )

            // remove any old crud
            .query(escape`DELETE FROM tasks WHERE datecode=todcode(${date}) AND class=${classid} AND task='B'`)

            // and add a new one
            .query(
                escape`
          INSERT INTO tasks (datecode, class, flown, description, distance, hdistance, duration, type, task, hash )
             VALUES ( todcode(${date}), ${classid},
                      'N', ${tasktype_long},
                      ${task_distance},
                      ${task_distance},
                      ${duration}, ${tasktype}, 'B', ${hash} )`
            )

            // This query is a built one as we have to have it all as one string :( darn transactions

            .query((r) => {
                const taskid = r.insertId;
                if (!taskid) {
                    console.log(`${classid} - ${date}: unable to insert task!`);
                    return null;
                }
                if (!task_info.length) {
                    console.log(`${classid} - ${date}: no turnpoints for task`);
                    throw 'oops';
                    return null;
                }

                let values = [];
                let query = 'INSERT INTO taskleg ( class, datecode, taskid, legno, ' + 'length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12, altitude ) ' + 'VALUES ';

                let previousPoint = null;
                let currentPoint = null;

                let point_index = 0;
                for (const tp of task_info) {
                    // can we extract a number off the leading part of the turnpoint name, if so treat it as a trigraph
                    // it must be leading, and 3 or 4 digits long and we will then strip it from the name
                    let tpname = tp.Brytpunkt;
                    let trigraph = tpname?.substr(0, 3);
                    if (tpname && ([trigraph] = tpname.match(/^([0-9]{3,4})/) || [])) {
                        tpname = tpname.replace(/^([0-9]{3,4})/, '');
                    }

                    // So we can calculate distances etc
                    previousPoint = currentPoint;
                    currentPoint = point([toDeg(tp.Longitud), toDeg(tp.Latitud)]);

                    const leglength = previousPoint ? distance(previousPoint, currentPoint) : 0;
                    const bearingDeg = previousPoint ? (bearing(previousPoint, currentPoint) + 360) % 360 : 0;
                    let hi = 0;

                    query = query + "( ?, todcode(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sector', ?, ?, ?, ?, ?, ?, ? ),";

                    values = values.concat([classid, date, taskid, point_index, leglength, bearingDeg, toDeg(tp.Latitud), toDeg(tp.Longitud), hi, trigraph, tpname, point_index > 0 ? 'symmetrical' : 'np', parseFloat(tp.Radie), tp.Typ == 'Line' ? 90 : 0, 0, 0, 0, tp.altitude]);

                    point_index++;
                }

                query = query.substring(0, query.length - 1);
                // This is done in the chaining
                return [query, values];
            })

            // Remove the old task and legs for this class and date
            .query((r, ro) => {
                const taskid = ro[1].insertId;
                return ['DELETE FROM tasks WHERE class=? AND taskid != ? AND datecode = todcode(?)', [classid, taskid, date]];
            })
            .query((r, ro) => {
                const taskid = ro[1].insertId;
                return ['DELETE FROM taskleg WHERE class=? AND taskid != ? AND datecode = todcode(?)', [classid, taskid, date]];
            })
            .query((r, ro) => {
                const taskid = ro[1].insertId;
                return ['UPDATE tasks SET task="A", flown="Y" WHERE class=? AND taskid = ?', [classid, taskid]];
            })

            // redo the distance calculation, including calculating handicaps
            //			.query( (r,ro) => { const taskid = ro[1].insertId;
            //								console.log( "WCAP DIS", taskid, ro );
            //								return ['call wcapdistance_taskid( ? )', [taskid]]; })

            // make sure we have result placeholder for each day, we will fail to save scores otherwise
            .query(
                escape`INSERT IGNORE INTO pilotresult
               ( class, datecode, compno, status, start, finish, duration, distance, hdistance, speed, hspeed, igcavailable )
             SELECT ${classid}, todcode(${date}),
               compno, '-', '00:00:00', '00:00:00', '00:00:00', 0, 0, 0, 0, 'N'
             FROM pilots WHERE pilots.class = ${classid}`
            )

            // And update the day with status and text etc
            .query(
                escape`INSERT INTO contestday (class, script, length, result_type, info, winddir, windspeed, daynumber, status,
                                                   notes, calendardate, datecode )
                                         VALUES ( ${classid}, LEFT(${script},60), ${task_distance},
                                                  ${status}, ${info.substring(0, 250)}, winddir, windspeed, ${day_number}, 'Y',
                                                  '', ${date}, todcode(${date}))
                                       ON DUPLICATE KEY
                                       UPDATE turnpoints = values(turnpoints), script = LEFT(values(script),60), length=values(length),
                                          result_type=values(result_type), info=values(info),
                                          winddir=values(winddir), windspeed=values(windspeed), daynumber=values(daynumber),
                                          status=values(status), notes=values(notes), calendardate=values(calendardate)`
            )

            // if it is today then set the briefing status properly, this is an update so does nothing
            // if they are marked as flying etc. If the day is cancelled we want that updated here as well
            // Status not used at present but a way of keeping track of if they are flying etc.
            //			.query( () => {
            //				if( day.result_status != "cancelled" )
            //					return ["UPDATE compstatus SET status='B' WHERE class=? AND datecode=todcode(?) AND status NOT IN ( 'L', 'S', 'R', 'H', 'Z' )", [classid,date]];
            //				else
            //					return ["UPDATE compstatus SET status='Z' WHERE class=? AND datecode=todcode(?)", [classid,date]];
            //			})

            // If it was cancelled then mark it as not flown, this will stop the UI from displaying it
            //			.query( () => {
            //				if( day.result_status == "cancelled" )
            //					return [ 'UPDATE tasks SET flown="N" WHERE class=? AND datecode=todcode(?)', [classid,date]];
            //				else
            //					return null;
            //			})
            //			.query( () => {
            //				if( day.result_status == "cancelled" )
            //					return [ 'UPDATE contestday SET status="N" WHERE class=? AND datecode=todcode(?)', [classid,date]];
            //				else
            //					return null;
            //			})
            // Combine results
            //  .query( escape`update pilotresult pr1 left outer join pilotresult pr2
            //               on pr1.compno = pr2.compno and pr2.datecode = todcode(date_sub(fdcode(pr1.datecode),interval 1 day))
            //               set pr1.prevtotalrank = coalesce(pr2.totalrank,pr2.prevtotalrank)` )

            // Update the last date for results
            .query(
                escape`UPDATE compstatus SET resultsdatecode = GREATEST(todcode(${date}),COALESCE(resultsdatecode,todcode(${date})))
                       WHERE class=${classid}`
            )

            .rollback((e) => {
                console.log('rollback');
            })
            .commit();

        // and some logging
        console.log(`${classid}: processed task ${date}`);
    }
}

async function process_class_results(classid, className, date, day_number, results_info) {
    let rows = 0;
    let doCheckForOGNMatches = false;

    if (!results_info || results_info.length < 0) {
        console.log(`${className}: ${date} - no results`);
        return;
    }

    // It's a big long list of results ;)
    for (const row of results_info) {
        if (row.Pos == 'DNF') {
            continue;
        }

        let pilotExtractor = row.CN.match(/^<a .*href="([^"]+)">.*?([A-Z0-9]+)<.a>$/, 'i');
        if (!pilotExtractor) {
            console.log(`${date} ${className} ${row.CN} - no IGC file available`);
            pilotExtractor = [undefined, row.CN];
        }

        const pilot = pilotExtractor[2];
        const url = pilotExtractor[1] ? 'http://www.rst-online.se/' + pilotExtractor[1] : undefined;
        const handicap = correct_handicap(cnhandicaps[classid + '_' + pilot]);

        function cDate(d) {
            if (d == undefined) {
                return undefined;
            }
            let x = new Date(date);
            const p = d.match(/([0-9]{2}):([0-9]{2}):([0-9]{2})/);
            x.setUTCHours(p[1]);
            x.setUTCMinutes(p[2]);
            x.setUTCSeconds(p[3]);
            return x;
        }

        function cHour(d) {
            if (d == undefined) {
                return undefined;
            }
            const p = d.match(/([0-9]{2}):([0-9]{2}):([0-9]{2})/);
            return parseInt(p[1]) + parseInt(p[2]) / 60 + parseInt(p[3]) / 3600;
        }
        console.log(row);
        const start = row.Start ? cDate(row.Start).getTime() / 1000 : 0;
        const finish = row.Tid != '' ? cDate(row['Mål']).getTime() / 1000 : 0;
        const duration = finish && start ? finish - start : 0;

        //		console.log( pilot, start, finish, duration );

        // for the bga scoring script that includes handicapped in the decimals
        // it's a special case, but could be used by other competitions if they want to
        const actuals = parseFloat(row.Hastighet);
        const actuald = parseFloat(row.Distans);

        let scoredvals: any = {};
        scoredvals.as = actuals;
        scoredvals.ad = actuald;
        scoredvals.hs = actuals / (handicap / 100);
        scoredvals.hd = actuald / (handicap / 100);
        //		console.log( pilot, date, scoredvals, actuals, actuald, duration );

        const finished = parseFloat(row.Hastighet) > 0;

        // If there is data from scoring then process it into the database
        // NOTE THE TIMES ARE UTC not local so we to convert back to local
        if (row['Mål'] != '' || finished) {
            const r = await mysql_db.query(escape`
                           UPDATE pilotresult
                           SET
		                     start=TIME(from_unixtime(${start}+(SELECT tzoffset FROM competition))),
		                     finish=TIME(from_unixtime(${finish}+(SELECT tzoffset FROM competition))),
                             duration=TIME(from_unixtime(${duration})),
                             scoredstatus= ${finished ? 'F' : 'H'},
                             status = (CASE WHEN ((status = "-" or status = "S" or status="G") and ${finished} != "") THEN "F"
                                        WHEN   ((status = "-" or status = "S" or status="G") and ${row['M�l']} != "") THEN "H"
                                        ELSE status END),
                             datafromscoring = "Y",
                             speed=${scoredvals.as}, distance=${scoredvals.ad},
                             hspeed=${scoredvals.hs}, hdistance=${scoredvals.hd},
                             daypoints=${row['Poäng'].replace(' ', '')}, dayrank=${row.Pos}, totalpoints=${0}, totalrank=${0}, penalty=${0}
                          WHERE datecode=todcode(${date}) AND compno=${pilot} and class=${classid}`);

            //          console.log(`${pilot}: ${handicap} (${duration} H) ${scoredvals.ad} ${scoredvals.hd}` );
            rows += r.affectedRows;

            // check the file to check tracking details
            let {igcavailable} = (
                await mysql_db.query(escape`SELECT igcavailable FROM pilotresult
                                                              WHERE datecode=todcode(${date}) and compno=${pilot} and class=${classid}`)
            )[0] || {igcavailable: false};
            if ((igcavailable || 'Y') == 'N' && url) {
                console.log(date, pilot, igcavailable);
                await processIGC(classid, pilot, location, date, url, https, mysql);
                doCheckForOGNMatches = true;
            }
        }
    }

    // If we processed an IGC file we should check to see if we have an OGN launch/landing match
    if (doCheckForOGNMatches) {
        checkForOGNMatches(classid, date, mysql);
    }

    // Did anything get updated?
    if (rows) {
        await mysql_db.query(escape`UPDATE contestday SET results_uploaded=NOW()
                                 WHERE class=${classid} AND datecode=todcode(${date}) and STATUS != "Z"`);
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
async function update_contest(contest_name, info) {
    // All we know is what date range we have
    console.log(info[0]);

    // Add a row if we need to
    const count = await mysql_db.query('SELECT COUNT(*) cnt FROM competition');
    if (!count || !count[0] || !count[0].cnt) {
        console.log('Empty competition, pre-populating');
        mysql_db.query('INSERT IGNORE INTO competition ( tz, tzoffset, mainwebsite ) VALUES ( "Europe/Stockholm", 7200, "http://www.rst-online.se/RSTmain.php?main=excup&cmd=list&excup=list&sub=EX" )');
    }

    for (const i of info[0]) {
        //		for( const v of i ) {
        {
            const v = i['Max antal deltagare'];
            const matches = v.match(/([0-9]{4}-[0-9]{2}-[0-9]{2}) till ([0-9]{4}-[0-9]{2}-[0-9]{2})/);
            if (matches) {
                //
                // Make sure the dates are copied across
                await mysql_db.query(escape`
         UPDATE competition SET start = ${matches[1]},
                                  end = ${matches[2]},
                                  countrycode = 'SE'`);
            }
        }
    }

    // If we have a location then update
    const ssLocation = undefined;
    location = (await mysql_db.query(escape`SELECT lt, lg FROM competition`))[0];

    if (location && location.lt && location.lg) {
        // Save four our use
        location.point = point([location.lt, location.lg]);

        // Calculate elevation so we can do launch calculations from the IGC files
        getElevationOffset(location.lt, location.lg, (agl) => {
            location.altitude = agl;
            console.log('SITE Altitude:' + agl);
        });
    }

    if (0) {
        //keys.deep ) {
        // clear it all down, we will load all of this from soaring spot
        // NOTE: this should not be cleared every time, even though at present it is
        // TBD!!
        mysql_db
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
    const lt = a.match(/([NS])([0-9]{2}):([0-9]{2}):([0-9]{2})/);
    if (lt) {
        return (lt[1] == 'S' ? -1 : 1) * parseInt(lt[2]) + parseInt(lt[3]) / 60 + parseInt(lt[4]) / 3600;
    }
    const lg = a.match(/([EW])([0-9]{2,3}):([0-9]{2}):([0-9]{2})/);
    if (lg) {
        return (lg[1] == 'W' ? -1 : 1) * parseInt(lg[2]) + parseInt(lg[3]) / 60 + parseInt(lg[4]) / 3600;
    }
    return undefined;
}

//
// All the bizarre forms of handicap that have been spotted in scoring spot
function correct_handicap(handicap) {
    return !handicap ? 100 : handicap < 2 ? handicap * 100 : handicap > 140 ? handicap / 10 : handicap;
}
