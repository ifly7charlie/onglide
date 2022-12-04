// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {createHash, randomBytes, createHmac} from 'crypto';

// Helper
const fetcher = (url) => fetch(url).then((res) => res.json());
const https = require('node:https');
//import https from 'node:https';

// We use these to get IGCs from SoaringSpot streaming
import {point} from '@turf/helpers';
import distance from '@turf/distance';
import bearing from '@turf/bearing';
import {getElevationOffset} from '../lib/getelevationoffset';
// handle unkownn gliders
import {capturePossibleLaunchLanding, processIGC, checkForOGNMatches} from '../lib/flightprocessing/launchlanding';

import getCountryISO2 from 'country-iso-3-to-2';

import _groupby from 'lodash.groupby';
import _forEach from 'lodash.foreach';

// DB access
//const db = require('../db')
import escape from 'sql-template-strings';
const mysql = require('serverless-mysql');

let mysql_db = undefined;
//const fetch = require('node:fetch');

// Fix the turpoint types so we draw the sectors right
const oz_types = {Turnpoint: 'symmetrical', Finish: 'pp', Start: 'np'};

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
            host: process.env.MYSQL_HOST,
            database: process.env.MYSQL_DATABASE,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD
        }
    });

    // Now get data from soaringspot
    SGP();

    console.log('Background download from SGP enabled');
    setInterval(function () {
        SGP();
    }, 5 * 60 * 1000);
}

main().then(() => 'exiting');

//
// Function to score any type of task - checks the task type field in the database
// to decide how to delegate to the various different kinds of tasks
async function SGP(deep = false) {
    console.log('Checking SGP @ ' + new Date().toString());

    // Get the soaring spot keys from database
    let keys = (
        await mysql_db.query(escape`
              SELECT *
                FROM scoringsource where type='sgp'`)
    )[0];

    if (!keys?.url) {
        console.log('no SGP url configured', keys);
        return {
            error: 'no SGP url configured'
        };
    }

    // If we should clean everything out or just update
    keys.deep = keys.overwrite || deep;

    // It's an enumerate API so we start at the top.  Use HTTPS, the rest of the
    // links in this code are HTTP because that is how they are returned in the JSON
    // HOWEVER! All fetches will be https because the enumeration links are all https
    fetch(keys.url)
        .then((res) => {
            if (res.status == 200) {
                return res.json();
            }
            console.log(`Unable to fetch task ${res.statusText}`);
            return null;
        })
        .then((res) => {
            if (res) {
                update_class();
                update_task(res.task);
                update_pilots(res.tracks);
            }
        })
        .catch((err) => {
            console.log(err);
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

async function update_class() {
    // Add to the database
    await mysql_db.query(escape`
             INSERT INTO classes (class, classname, description, type )
                   VALUES ( 'sgp', 'SGP', 'SGP', 'grandprix' )
                    ON DUPLICATE KEY UPDATE classname=values(classname), description=values(description),
                                            type=values(type) `);

    await mysql_db.query(escape`insert ignore into compstatus (class) values ( 'sgp' )`);

    // Make sure we have rows for each day and that compstatus is correct
    //    await mysql.query( escape`call contestdays()`);
    await mysql_db.query(escape`update compstatus set status=':', datecode=todcode(now())`);
}

//
// generate pilot entries and results for each pilot, this needs to be done before we
// download the scores
async function update_pilots(pilots) {
    // Start a transaction for updating pilots
    let t = mysql_db.transaction();

    for (const pilot of pilots) {
        // Make sure it has a comp number
        if (!pilot.competitionId || pilot.competitionId == '' || !!pilot.competitionId.match(/(TBA|TBD)/)) {
            continue;
        }

        // And change handicaps to BGA style
        pilot.handicap = 100;

        const igcid = -1; // (pilot.portraitUrl.match(/([0-9]+).(jpg|png)/i)?.[1])||-1;
        //		if( ! igcid ) {
        //			console.warn("skipping pilot due to no fai id in filename for picture", pilot );
        //			continue;
        //		}

        const flarmIds = pilot.trackId.match(/[0-9A-F]{6}$/gi) || ['unknown'];

        const gravatar = (pilot) => {
            return createHash('md5')
                .update((pilot.pilotName.replace(/\s+/g, '') + '@comps.onglide.com').replace(/\s/g, '').toLowerCase())
                .digest('hex');
        };

        await t.query(escape`
             INSERT INTO pilots (class,firstname,lastname,homeclub,username,fai,country,email,
                                 compno,participating,glidertype,greg,handicap,registered,registereddt)
                  VALUES ( 'sgp',
                           ${pilot.pilotName?.substring(0, 30) || ''}, '', '', null,
                           ${igcid}, ${getCountryISO2(pilot.country?.substring(0, 3)) || ''},
                           ${gravatar(pilot)},
                           ${pilot.competitionId.substring(0, 4)},
                           'Y',
                           ${pilot.aircraft.substring(0, 30) || ''},
                           ${pilot.registration?.substring(0, 8) || ''},
                           100, 'Y', NOW() )
                  ON DUPLICATE KEY UPDATE
                           class=values(class), firstname=values(firstname), lastname=values(lastname),
                           homeclub=values(homeclub), fai=values(fai), country=values(country), email=values(email),
                           participating=values(participating), handicap=values(handicap),
                           glidertype=values(glidertype), greg=values(greg), registereddt=NOW()`);

        if (pilot.ognTrackerPaired) {
            flarmIds.push(pilot.ognTrackerPaired.match(/[0-9A-F]{6}$/gi));
        }

        t.query(escape`
              INSERT INTO tracker ( class, compno, type, trackerid ) 
                  VALUES ( 'sgp', ${pilot.competitionId.substring(0, 4)}, 'flarm', ${flarmIds.filter((d) => d?.length).join(',')} )
                ON DUPLICATE KEY UPDATE trackerid=values(trackerid)`);

        // Download pictures
        if (pilot.portraitUrl) {
            download_picture(pilot.portraitUrl, pilot.competitionId.substring(0, 4), 'sgp', mysql);
        }
    }

    // remove any old pilots as they aren't needed, they may not go immediately but it will be soon enough
    t.query(escape`DELETE FROM pilots WHERE class='sgp' AND registereddt < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`)

        // Trackers needs a row for each pilot so fill any missing, perhaps we should
        // also remove unwanted ones
        .query('INSERT IGNORE INTO tracker ( class, compno, type, trackerid ) select class, compno, "flarm", "unknown" from pilots')
        .query('DELETE FROM tracker where concat(class,compno) not in (select concat(class,compno) from pilots)')

        // And update the pilots picture to the latest one in the image table - this should be set by download_picture
        //   .query( 'UPDATE PILOTS SET image=(SELECT filename FROM images WHERE keyid=compno AND width IS NOT NULL ORDER BY added DESC LIMIT 1)' );

        .rollback((e) => {
            console.log('rollback');
        })
        .commit();
}

// Fetch the picture from FAI rankings
async function download_picture(url, compno, classid, mysql) {
    // Check when it was last checked
    const lastUpdated = (await mysql_db.query(escape`SELECT updated FROM images WHERE class=${classid} AND compno=${compno} AND unix_timestamp()-updated < 86400`))[0];

    if (lastUpdated) {
        console.log(`not updating ${compno} picture`);
        return;
    }

    console.log(`downloading picture for ${classid}:${compno}`);
    fetch(url, {headers: {Referer: 'https://' + process.env.NEXT_PUBLIC_SITEURL + '/'}})
        .then((res) => {
            if (res.status != 200) {
                console.log(` ${classid}:${compno}: FAI website returns ${res.status}: ${res.statusText}`);
                if (res.status == 404 || res.status == 403) {
                    return undefined;
                }
                throw `FAI website returns ${res.status}: ${res.statusText}`;
            } else {
                return res.arrayBuffer();
            }
        })
        .then((ab) => {
            const data = ab ? Buffer.from(ab) : null;
            if (data) {
                mysql_db.query(escape`INSERT INTO images (class,compno,image,updated) VALUES ( ${classid}, ${compno}, ${data}, unix_timestamp() )
                                  ON DUPLICATE KEY UPDATE image=values(image), updated=values(updated)`);
                mysql_db.query(escape`UPDATE pilots SET image = 'Y' WHERE  class=${classid} AND compno=${compno}`);
            }
        });
}

//
// Store the task in the MYSQL
async function update_task(task) {
    let rows = 0;
    let [date] = typeof task.startOpenTs == 'string' ? task.startOpenTs.match(/^[0-9-]{10}/) : [new Date(task.startOpenTs).toISOString()];

    if (!date) {
        console.warn('no date found in task', task.startOpenTs);
        return;
    }

    const classid = 'sgp';
    let tasktype = 'S';

    // So we don't rebuild tasks if they haven't changed
    const hash = createHash('sha256').update(JSON.stringify(task)).digest('base64');
    const dbhashrow = await mysql_db.query(escape`SELECT hash FROM tasks WHERE datecode=todcode(${convert_to_mysql_datetime(date)}) AND class=${classid}`);

    if (dbhashrow && dbhashrow.length > 0 && hash == dbhashrow[0].hash) {
        console.log(`${classid} - ${date}: task unchanged`);
        console.log(hash, dbhashrow[0]);
        return;
    } else {
        console.log(`${classid} - ${date}: task changed`);
    }

    // Do this as one block so we don't end up with broken tasks
    mysql_db
        .transaction()

        // If it is the current day and we have a start time we save it
        .query(
            escape`
            UPDATE compstatus SET starttime = COALESCE(${convert_to_mysql_time(date)},starttime)
              WHERE datecode = todcode(${convert_to_mysql_datetime(date)})`
        )

        // remove any old crud
        .query(escape`DELETE FROM tasks WHERE datecode=todcode(${convert_to_mysql_datetime(date)}) AND class=${classid} AND task='B'`)

        // and add a new one
        .query(
            escape`
          INSERT INTO tasks (datecode, class, flown, description, distance, hdistance, duration, type, task, nostart, hash )
             VALUES ( todcode(${convert_to_mysql_datetime(date)}), ${classid},
                      'N', ${task.taskName},
                      0, 0, '00:00:00',
                      ${tasktype}, 'B', ${convert_to_mysql_time(date)}, ${hash} )`
        )

        // This query is a built one as we have to have it all as one string :( darn transactions

        .query((r) => {
            const taskid = r.insertId;
            if (!taskid) {
                console.log(`${classid} - ${date}: unable to insert task!`);
                return null;
            }

            let values = [];
            let query =
                'INSERT INTO taskleg ( class, datecode, taskid, legno, ' + //
                'length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12 ) ' +
                'VALUES ';

            let previousPoint = null;
            let currentPoint = null;
            let i = 0;
            for (const tp of task.turnpoints) {
                // can we extract a number off the leading part of the turnpoint name, if so treat it as a trigraph
                // it must be leading, and 3 or 4 digits long and we will then strip it from the name
                let tpname = tp.name.replace(/^TP[0-9]+-/, '');
                let trigraph = tpname.substr(0, 3);
                if (tpname && ([trigraph] = tpname.match(/^([0-9]{1,4})/) || [trigraph])) {
                    tpname = tpname.replace(/^([0-9]{1,4})/, '');
                }
                if (tpname && ([trigraph] = tpname.match(/^(TP[0-9]{1,4})/) || [trigraph])) {
                    tpname = tpname.replace(/^([0-9]{1,4})/, '');
                }

                // So we can calculate distances etc
                previousPoint = currentPoint;
                currentPoint = point([tp.longitude, tp.latitude]);

                const leglength = previousPoint ? distance(previousPoint, currentPoint) : 0;
                const bearingDeg = previousPoint ? (bearing(previousPoint, currentPoint) + 360) % 360 : 0;
                let hi = 0; // only used when windicapping
                query =
                    query +
                    '( ?, todcode(?), ?, ?, ' + //
                    " ?,?, ?, ?, 0, ?, ?, 'sector', ?, ?, ?, ?, ?, ? ),";

                values = values.concat([
                    'sgp',
                    convert_to_mysql_datetime(date),
                    taskid,
                    i, //
                    leglength,
                    bearingDeg,
                    tp.latitude,
                    tp.longitude,
                    trigraph,
                    tpname,
                    oz_types[tp.type],
                    tp.radius / 1000,
                    tp.type != 'Turnpoint' ? 90 : 360,
                    0,
                    0,
                    0
                ]);

                i++;
            }

            query = query.substring(0, query.length - 1);
            // This is done in the chaining
            return [query, values];
        })

        // Remove the old task and legs for this class and date
        .query((r, ro) => {
            const taskid = ro[ro.length - 2].insertId;
            return ['DELETE FROM tasks WHERE class=? AND taskid != ? AND datecode = todcode(?)', [classid, taskid, convert_to_mysql_datetime(date)]];
        })
        .query((r, ro) => {
            const taskid = ro[ro.length - 3].insertId;
            return ['UPDATE tasks SET task="A", flown="Y" WHERE class=? AND taskid = ?', [classid, taskid]];
        })

        // redo the distance calculation, including calculating handicaps
        .query((r, ro) => {
            const taskid = ro[ro.length - 5].insertId;
            return escape`call wcapdistance_taskid( ${taskid} )`;
        })

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
                                         VALUES ( 'sgp', LEFT('Sailplane Grand Prix',60), 0, 
                                                  '', '', 0, 0, 1, 'Y', '', ${convert_to_mysql_datetime(date)}, todcode(${convert_to_mysql_datetime(date)}))
                                       ON DUPLICATE KEY
                                       UPDATE turnpoints = values(turnpoints), script = LEFT(values(script),60), length=values(length),
                                          result_type=values(result_type), info=values(info),
                                          winddir=values(winddir), windspeed=values(windspeed), daynumber=values(daynumber),
                                          status=values(status), notes=values(notes), calendardate=values(calendardate)`
        )

        // Update the last date for results
        .query(
            escape`UPDATE compstatus SET resultsdatecode = GREATEST(todcode(${convert_to_mysql_datetime(date)}),COALESCE(resultsdatecode,todcode(${convert_to_mysql_datetime(date)})))
                       WHERE class=${classid}`
        )

        .rollback((e) => {
            console.log('rollback');
        })
        .commit();

    // and some logging
    console.log(`${classid}: processed task ${date}`);
}

// Get rid of the T at the front...
function convert_to_mysql_time(jsontime) {
    if (jsontime && jsontime.match(/T.*Z/)) {
        return jsontime.replace(/^.*T/, '').replace(/[Z]/, '');
    } else {
        return '00:00:00';
    }
}

function convert_to_mysql_datetime(jsontime) {
    return jsontime ? jsontime.replace(/[TZ]/g, ' ') : jsontime;
}

//
// All the bizarre forms of handicap that have been spotted in scoring spot
function correct_handicap(handicap) {
    return !handicap ? 100 : handicap < 2 ? handicap * 100 : handicap > 140 ? handicap / 10 : handicap;
}

// From radians
function toDeg(a) {
    return (a / Math.PI) * 180;
}

function toRad(a) {
    return (a * Math.PI) / 180;
}

// Update the DDB cache
async function findAirfield(iatacode: string) {
    console.log('updating ddb');
    /*
    return fetch('https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv')
        .then((res) => res.text())
        .then((text) => {
            // {"devices":[{"device_type":"F","device_id":"000000","aircraft_model":"HPH 304CZ-17","registration":"OK-7777","cn":"KN","tracked":"Y","identified":"Y"},
            if (!ddbraw.devices) {
                console.log('no devices in ddb');
                return;
            }

            // Update the cache with the ids by device_id
            ddb = keyBy(ddbraw.devices, 'device_id');

            // remove the unknown characters from the registration
            forEach(ddb, function (entry) {
                entry.registration = entry?.registration?.replace(/[^A-Z0-9]/i, '');
            });
        })
        .catch((e) => {
            console.log('unable to fetch ddb', e);
        });*/
}
