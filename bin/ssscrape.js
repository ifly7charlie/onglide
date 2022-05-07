#!/usr/bin/env node

// Copyright 2020 (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

const crypto = require('crypto');

const tabletojson = require('tabletojson').Tabletojson;
const htmlparser = require('htmlparser2');

const { findOne, findAll, existsOne, 
		removeElement,
		getChildren,
		getInnerHTML, getOuterHTML, textContent, getAttributeValue } = require('domutils');


// Helper
const fetcher = url => fetch(url).then(res => res.json());

// We use these to get IGCs from SoaringSpot streaming
var readline = require('readline');
var https = require('https');
var http = require('http');
const { point } = require ( '@turf/helpers' );
const distance = (require( '@turf/distance' )).default;
const { getElevationOffset } = require('../lib/getelevationoffset.js');
// handle unkownn gliders
const { capturePossibleLaunchLanding, checkForOGNMatches, processIGC } = require('../lib/launchlanding.js');


const _groupby = require('lodash.groupby');
const _forEach = require('lodash.foreach');
const _reduce = require('lodash.reduce');

// DB access
//const db = require('../db')
const escape = require('sql-template-strings')
const mysql = require('serverless-mysql')();
const fetch = require('node-fetch');

let cnhandicaps = {};

// Fix the turpoint types from SoaringSpot to what we know
const oz_types = { 'symmetric': 'symmetrical',
                   'next':  'np',
                   'previous':  'pp',
                   'fixed':  'fixed',
                   'start':  'sp' }

// Load the current file
const dotenv = require('dotenv').config({ path: '.env.local' })
const config = dotenv.parsed;

// Location information, fetched from DB
var location;

// Set up background fetching of the competition
async function main() {

    if (dotenv.error) {
        console.log( "New install: no configuration found, or script not being run in the root directory" );
        process.exit();
    }

    mysql.config({
        host: config.MYSQL_HOST,
        database: config.MYSQL_DATABASE,
        user: config.MYSQL_USER,
        password: config.MYSQL_PASSWORD
    });

	console.log(config);

	// Now get data from soaringspot
    rst();

    console.log( "Background download from soaring spot enabled" );
    setInterval( function() {
        rst();
    }, 5*60*1000 );
}


main()
    .then("exiting");

async function rst(deep = false) {

	// Get the soaring spot keys from database
    let keys = (await mysql.query(escape`
              SELECT *
                FROM scoringsource`))[0];

    if( ! keys ) {
        console.log( 'no soaringspot keys configured' );
        return {
            error:'no soaringspot keys configured'
        };
    }

	let hcaps = {};
	
	await fetch( keys.url + "/pilots" )
		.then( res => res.text() )
		.then( body => {
			let dom = htmlparser.parseDocument(body);
			const contestInfo = findOne( (x) => (x.name == 'div' && x.attribs?.class != 'contest-title' ), dom.children);

			const name = textContent( findOne( (x) => (x.name == 'h1'), contestInfo.children )).trim();
			const site = textContent( findOne( (x) => (x.name == 'span' && x.attribs?.class == 'location'), contestInfo.children )).trim();
			const dates = textContent( findOne( (x) => (x.name == 'span' && x.attribs?.class == 'date'), contestInfo.children )).trim();

			update_contest( name, dates, site, keys.url);

			// Now extract the pilots list
			console.log( "***********" );
//			const pilots = tabfindAll( (test) => (test.name == 'tr' && test.parent?.name == 'tbody' ),
			const pilots = tabletojson.convert( getOuterHTML(findOne( (x) => (x.attribs?.class =='pilot footable toggle-arrow-tiny'), dom.children )));
			update_pilots( pilots[0] );

			console.log( `found ${pilots[0].length} pilots` );
			console.log( name );
			console.log( site );
			console.log( dates );
			console.log( `looking for competition ${keys.contest_name}` );
		})
		.catch( err => {
			console.log( "ummm", err );
		});

	const extractTask = new RegExp( /taskNormalize\((\{.+\}), \[.*\)/ );

	await fetch( keys.url + "/results" )
		.then( res => res.text() )
		.then( async function (body)  {
			var dom = htmlparser.parseDocument(body);
			var competitionnames = [];

			const allresults = findAll( (x) => (x.name == 'table' && x.attribs?.class == 'result-overview' ), dom.children);

			for( const result of allresults ) {
				
				const nameRaw = textContent( findOne( (x) => (x.name == 'th'), result.children )).trim();
				// Name for URLs and Database
				const classid = nameRaw
					  .replace(/\s*(class|klasse)/gi,'')
					  .replace(/[^A-Z0-9]/gi,'')
					  .substring(0,14);
				
				const className = nameRaw
					  .replace(/[_]/gi, ' ');

				console.log( className );


				// Add to the database
				await mysql.query( escape`
             INSERT INTO classes (class, classname, description, type )
                   VALUES ( ${classid}, ${className.substr(0,29)}, ${className}, 'club' )
                    ON DUPLICATE KEY UPDATE classname=values(classname), description=values(description),
                                            type=values(type) `);

				await mysql.query( escape`insert ignore into compstatus (class) values ( ${classid} )` );
				
				// Make sure we have rows for each day and that compstatus is correct
				//    await mysql.query( escape`call contestdays()`);
				await mysql.query( escape`update compstatus set status=':', datecode=todcode(now())`);


				const dates = findAll( (x) => (x.name == 'tr' && x.parent?.name == 'tbody'), result.children );

				for( const day of dates ) {
					const keys = findAll( (x) => (x.name == 'td'), day.children );

					const dateGB = textContent(keys[0]).match(/([0-9]{2})\/([0-9]{2})\/([0-9]{4})/);
					const date = dateGB[3] + '-' + dateGB[2] + '-' + dateGB[1];

					const daynumber = textContent(keys[1]).trim();
					if( daynumber == 'No task' ) {
						continue;
					}
					console.log( keys[1].children );
					const url = getAttributeValue( keys[1].children[1], 'href' );

					console.log( date, daynumber, url );
					await fetch( 'https://www.soaringspot.com'+url )
						.then( res => res.text() )
						.then( body => {
							const task = body.match( extractTask );
							if( task ) {
								taskJSON = JSON.parse(task[1]);
								process_day_task (taskJSON,classid,className);
							}
						});

					const rurl = getAttributeValue( keys[3].children[1], 'href' );

					console.log( date, daynumber, rurl );
					await fetch( 'https://www.soaringspot.com'+rurl )
						.then( res => res.text() )
						.then( body => {
							var dom = htmlparser.parseDocument(body);
							const classTable = new RegExp(/result-daily/);
							const result_table_fragment = getOuterHTML(findOne( (x) =>
								(x.attribs?.class?.match(classTable)), dom.children ));
							const results_html = tabletojson.convert( result_table_fragment, { stripHtmlFromCells: false});
							process_day_results (classid,className,date,daynumber,results_html);

						});

				}
			}
			
		});
};


async function update_class(className, data, dataHtml, hcaps ) {

    // Get the name of the class, if not set use the type
    const nameRaw = className

    // Name for URLs and Database
    const classid = nameRaw
          .replace(/\s*(class|klasse)/gi,'')
          .replace(/[^A-Z0-9]/gi,'')
          .substring(0,14);

	const name = nameRaw
		  .replace(/[_]/gi, ' ');

    // Add to the database
    await mysql.query( escape`
             INSERT INTO classes (class, classname, description, type )
                   VALUES ( ${classid}, ${name.substr(0,29)}, ${name}, 'club' )
                    ON DUPLICATE KEY UPDATE classname=values(classname), description=values(description),
                                            type=values(type) `);

    await mysql.query( escape`insert ignore into compstatus (class) values ( ${classid} )` );

    // Make sure we have rows for each day and that compstatus is correct
    //    await mysql.query( escape`call contestdays()`);
    await mysql.query( escape`update compstatus set status=':', datecode=todcode(now())`);

    // Now add details of pilots
    await update_pilots( classid, data[ 'Piloter' ], hcaps );

    // Import the results
    await process_class_tasks_and_results( classid, className, dataHtml );
}


//
// generate pilot entries and results for each pilot, this needs to be done before we
// download the scores
async function update_pilots(data ) {

    let unknowncompno = 0;
	let pilotnumber = 0;

    // Start a transaction for updating pilots
    let t = mysql.transaction();

    for ( const pilot of data ) {

        // Make sure it has a comp number
        if( ! pilot.CN || pilot.CN == '' ) {
            pilot.contestant_number = -(unknowncompno++);
			console.log( "Skipping pilot as no registration", pilot );
			continue;
        }

		// And change handicaps to BGA style
		const greg = '';
		const compno = pilot.CN;
		const handicap = correct_handicap( pilot.Handicap );
		
		// Name for URLs and Database
		const classid = pilot.Class
			  .replace(/\s*(class|klasse)/gi,'')
			  .replace(/[^A-Z0-9]/gi,'')
			  .substring(0,14);
		
		pilotnumber = pilotnumber+1;
		t.query( escape`
             INSERT INTO pilots (class,firstname,lastname,homeclub,username,fai,country,email,
                                 compno,participating,glidertype,greg,handicap,registered,registereddt)
                  VALUES ( ${classid},
                           ${pilot.Contestant}, ${''}, ${pilot.Club}, null,
                           ${pilotnumber}, '',
                           null,
                           ${compno},
                           'Y',
                           ${pilot.Glider},
                           ${greg},
                           ${handicap}, 'Y', NOW() )
                  ON DUPLICATE KEY UPDATE
                           class=values(class), firstname=values(firstname), lastname=values(lastname),
                           homeclub=values(homeclub), fai=values(fai), country=values(country),
                           participating=values(participating), handicap=values(handicap),
                           glidertype=values(glidertype), greg=values(greg), registereddt=NOW()`);
	}

    // remove any old pilots as they aren't needed, they may not go immediately but it will be soon enough
    t.query( escape`DELETE FROM pilots WHERE registereddt < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`)


    // Trackers needs a row for each pilot so fill any missing, perhaps we should
    // also remove unwanted ones
        .query( 'INSERT IGNORE INTO tracker ( class, compno, type, trackerid ) select class, compno, "flarm", "unknown" from pilots' )
    //  .query( 'DELETE FROM tracker where concat(class,compno) not in (select concat(class,compno) from pilots)' );

    // And update the pilots picture to the latest one in the image table - this should be set by download_picture
    //   .query( 'UPDATE PILOTS SET image=(SELECT filename FROM images WHERE keyid=compno AND width IS NOT NULL ORDER BY added DESC LIMIT 1)' );

        .rollback( e => { console.log("rollback") } )
        .commit();
}

//
// Store the task in the MYSQL
async function process_day_task (day,classid,classname) {
    let rows = 0;
    let date = day.task_date;


    let script = '';
    let status = day.result_status;//.replace(/^([a-z])/\U1/; I think this uppercases first letter? but perl

    // extract UK meta data from it (this is from UK scoring script and allows for windicapping
    let windspeed = 0;
    let winddir = 0;
//    if( info.match( /^UK/ ) && info.match(/Contest Wind.*deg.*kts/i) ) {
 //       let info1, info2;
  //      [script,info1,info2] = task_details.info.split( ',' );
    //    info = (info1+','+info2).replace(/^\s+/g,'');
     //   [windspeed,winddir] = info.match(/Contest Wind ([0-9]+) degs\/([0-9]+) kts/i );
   // }

    let tasktype = 'S';
    let duration = '00:00';
    if( day.task_type == 'assigned_area' ) {
        tasktype = 'A';
        duration = new Date(day.task_duration * 1000).toISOString().substr(11, 8);
    }

    // So we don't rebuild tasks if they haven't changed
    const hash = crypto.createHash('sha256').update(JSON.stringify(day)).digest('base64');
    const dbhashrow = (await mysql.query( escape`SELECT hash FROM tasks WHERE datecode=todcode(${date}) AND class=${classid}` ));

    if( (dbhashrow && dbhashrow.length > 0) && hash == dbhashrow[0].hash ) {
        return;
    }
    else {
        console.log( `${classid} - ${date}: task changed` );
    }

    // Do this as one block so we don't end up with broken tasks
    mysql.transaction()

    // If it is the current day and we have a start time we save it
        .query( escape`
            UPDATE compstatus SET starttime = COALESCE(${convert_to_mysql(day.no_start)},starttime)
              WHERE datecode = todcode(${date})` )

    // remove any old crud
        .query( escape`DELETE FROM tasks WHERE datecode=todcode(${date}) AND class=${classid} AND task='B'` )

    // and add a new one
        .query( escape`
          INSERT INTO tasks (datecode, class, flown, description, distance, hdistance, duration, type, task, hash )
             VALUES ( todcode(${date}), ${classid},
                      'N', ${day.task_type},
                      ${day.task_distance/1000},
                      ${day.task_distance/1000},
                      ${duration}, ${tasktype}, 'B', ${hash} )`)

    // This query is a built one as we have to have it all as one string :( darn transactions

        .query( (r) => {
            const taskid = r.insertId;
            if( ! taskid ) {
                console.log( `${classid} - ${date}: unable to insert task!` );
                return null;
            }

            let values = [];
            let query = "INSERT INTO taskleg ( class, datecode, taskid, legno, "+
                "length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12 ) "+
                "VALUES ";

            for ( const tp of day.task_points ) {

				console.log( tp );

                // We don't handle multiple starts at all so abort
                if( tp.multiple_start != 0 ) {
                    next;
                }

                // can we extract a number off the leading part of the turnpoint name, if so treat it as a trigraph
                // it must be leading, and 3 or 4 digits long and we will then strip it from the name
                let tpname = tp.name;
                let trigraph = tpname.substr(0,3);
                if( tpname && ([trigraph] = (tpname.match( /^([0-9]{3,4})/)||[]))) {
                    tpname = tpname.replace( /^([0-9]{3,4})/, '');
                }

                // we will save away the original name for contest day info
                //        tplist[ tp.point_index ] = tp.name;

                // Add the turnpoint.  The leg length etc is from the point to the previous one
                // so start point will have 0's
                /*let inner = escape`(
                  ${classid}, todcode(${date}), ${taskid}, ${tp.point_index},
                  0, 0,
                  ${toDeg(tp.latitude)},${toDeg(tp.longitude)},
                  0, ${trigraph}, ${tpname},
                  'sector',
                  ${oz_types[tp.oz_type]},
                  ${tp.oz_radius1/1000},
                  ${(tp.oz_line?90:toDeg(tp.oz_angle1))},
                  ${tp.oz_radius2/1000},
                  ${toDeg(tp.oz_angle2)},
                  ${tp.oz_type == 'fixed' ? toDeg(tp.oz_angle12) : 0} ),`; */

                query = query + "( ?, todcode(?), ?, ?, 0,0, ?, ?, 0, ?, ?, 'sector', ?, ?, ?, ?, ?, ? ),";

                values = values.concat( [
                    classid, date, taskid, tp.point_index,
                    toDeg(tp.latitude),toDeg(tp.longitude),
                    trigraph, tpname,
                    oz_types[tp.oz_type],
                    tp.oz_radius1/1000,
                    (tp.oz_line?90:toDeg(tp.oz_angle1)),
                    tp.oz_radius2/1000,
                    toDeg(tp.oz_angle2),
                    tp.oz_type == 'fixed' ? toDeg(tp.oz_angle12) : 0 ]);

            }

            query = query.substring(0,query.length-1);
            // This is done in the chaining
            return [ query, values ];
        })

    // Remove the old task and legs for this class and date
        .query( (r,ro) => { const taskid = ro[ro.length-2].insertId;
                            return ['DELETE FROM tasks WHERE class=? AND taskid != ? AND datecode = todcode(?)', [classid,taskid,date]]; })
        .query( (r,ro) => { const taskid = ro[ro.length-3].insertId;
                            return ['UPDATE tasks SET task="A", flown="Y" WHERE class=? AND taskid = ?',[classid,taskid]]; })

    // redo the distance calculation, including calculating handicaps
        .query( (r,ro) => { const taskid = ro[ro.length-5].insertId;
                            return escape`call wcapdistance_taskid( ${taskid} )` })

    // make sure we have result placeholder for each day, we will fail to save scores otherwise
        .query( escape`INSERT IGNORE INTO pilotresult
               ( class, datecode, compno, status, lonotes, start, finish, duration, distance, hdistance, speed, hspeed, igcavailable, turnpoints )
             SELECT ${classid}, todcode(${date}),
               compno, '-', '', '00:00:00', '00:00:00', '00:00:00', 0, 0, 0, 0, 'N', -2
             FROM pilots WHERE pilots.class = ${classid}`)

    // And update the day with status and text etc
        .query( escape`INSERT INTO contestday (class, script, length, result_type, info, winddir, windspeed, daynumber, status,
                                                   notes, calendardate, datecode )
                                         VALUES ( ${classid}, LEFT(${script},60), ${Math.round(day.task_distance/100)/10},
                                                  ${status}, ${''}, winddir, windspeed, ${day.task_number}, 'Y',
                                                  ${day?.notes||''}, ${date}, todcode(${date}))
                                       ON DUPLICATE KEY
                                       UPDATE turnpoints = values(turnpoints), script = LEFT(values(script),60), length=values(length),
                                          result_type=values(result_type), info=values(info),
                                          winddir=values(winddir), windspeed=values(windspeed), daynumber=values(daynumber),
                                          status=values(status), notes=values(notes), calendardate=values(calendardate)`  )

    // if it is today then set the briefing status properly, this is an update so does nothing
    // if they are marked as flying etc. If the day is cancelled we want that updated here as well
    // Status not used at present but a way of keeping track of if they are flying etc.
        .query( () => {
            if( day.result_status != "cancelled" )
                return ["UPDATE compstatus SET status='B' WHERE class=? AND datecode=todcode(?) AND status NOT IN ( 'L', 'S', 'R', 'H', 'Z' )", [classid,date]];
            else
                return ["UPDATE compstatus SET status='Z' WHERE class=? AND datecode=todcode(?)", [classid,date]];
        })

    // If it was cancelled then mark it as not flown, this will stop the UI from displaying it
        .query( () => {
            if( day.result_status == "cancelled" )
                return [ 'UPDATE tasks SET flown="N" WHERE class=? AND datecode=todcode(?)', [classid,date]];
            else
                return null;
        })
        .query( () => {
            if( day.result_status == "cancelled" )
                return [ 'UPDATE contestday SET status="N" WHERE class=? AND datecode=todcode(?)', [classid,date]];
            else
                return null;
        })
    // Combine results
    //  .query( escape`update pilotresult pr1 left outer join pilotresult pr2
    //               on pr1.compno = pr2.compno and pr2.datecode = todcode(date_sub(fdcode(pr1.datecode),interval 1 day))
    //               set pr1.prevtotalrank = coalesce(pr2.totalrank,pr2.prevtotalrank)` )

    // Update the last date for results
        .query( escape`UPDATE compstatus SET resultsdatecode = GREATEST(todcode(${date}),COALESCE(resultsdatecode,todcode(${date})))
                       WHERE class=${classid}`)

        .rollback( (e) => { console.log( "rollback" ); } )
        .commit();

    // and some logging
    console.log( `${classname}: processed task ${date}` );
}

async function process_day_results (classid, className, date, day_number, results ) {
    let rows = 0;
	let doCheckForOGNMatches = false;

	if( ! results || results[0].length < 0 ) {
		console.log( `${className}: ${date} - no results` );
		return;
	}

	const igcRe = new RegExp(/a href=&quot;.(en_gb.download-contest-flight.+=1)&quot;/i, 'i' );
	const cnRe = new RegExp(/([A-Z0-9]+)\s*<.a>\s*$/i, 'i' );
	const flagRe = new RegExp(/class="flag.*title="([a-z]+)"/i, 'i' );

    // It's a big long list of results ;)
    for ( const row of results[0] ) {

		if( row['#'] == 'DNF' ) {
			continue;
		}

		let pilotExtractor = row.CN.match( cnRe );
		if( ! pilotExtractor ) {
			console.log( `${date} ${className} ${row.CN} - no CN found!` );
			continue;
		}

		let urlExtractor = row.CN.match( igcRe );
		if( ! urlExtractor ) {
			console.log( `${row.CN}: no IGC file at all!` );
		}
        const pilot = pilotExtractor[1];
		const url = urlExtractor && urlExtractor[1] ? 'https://www.soaringspot.com/' + urlExtractor[1] : undefined;

		// Update the pilots flag
		flagExtractor = row.Contestant.match( flagRe );
		if( flagExtractor && day_number == 'Task 1' ) {
			const flag = flagExtractor[1].toUpperCase();
			mysql.query( escape`UPDATE pilots SET country = ${flag} where compno=${pilot} and class=${className}` );
		}
			

		function cDate(d) {
			if( d == undefined ) {
				return undefined;
			}
			let x = new Date();
			const p = d.match(/([0-9]{2}):([0-9]{2}):([0-9]{2})/);
			x.setHours( p[1] );
			x.setMinutes( p[2] );
			x.setSeconds( p[3] );
			return x;
		}

		function cHour(d) {
			if( d == undefined ) {
				return undefined;
			}
			const p = d.match(/^([0-9]{0,2}):*([0-9]{2}):([0-9]{2})/);
			if( ! p ) {
				return undefined;
			}
			return parseInt(p[1]) + parseInt(p[2])/60 + parseInt(p[3])/3600;
		}

		const rStart = row.Start != '' ? row.Start : null;
		const rFinish = row.Finish != '' ? row.Finish : null;
        const start = row.Start ? (cDate(row.Start).getTime()/1000) : 0;
        const finish = row.Time != '' ? (cDate(row.Finish).getTime()/1000) : 0;
        const duration = finish && start ? cHour(row.Time) : 0;
		
            // for the bga scoring script that includes handicapped in the decimals
            // it's a special case, but could be used by other competitions if they want to
        const actuals = parseFloat( row.Speed );
		const actuald = parseFloat( row.Distance );
		const handicap = correct_handicap( row.Handicap );
		 
        let scoredvals = {};
		scoredvals.as = duration ? actuald/duration : 0;
        scoredvals.ad = actuald
        scoredvals.hs = duration ? actuald/(handicap/100)/duration : 0;
        scoredvals.hd = actuald/(handicap/100);

		const finished = actuals > 0;

        // If there is data from scoring then process it into the database
        if( (row['#'] != 'DNF' && row['#'] != 'DNS') || finished ) {
            const r = (await mysql.query( escape`
                           UPDATE pilotresult
                           SET
                             start=TIME(COALESCE(${rStart},start)),
                             finish=TIME(COALESCE(${rFinish},finish)),
                             duration=COALESCE(TIMEDIFF(${rFinish},${rStart}),duration),
                             scoredstatus= ${finished > 0 ? 'F' : 'H'},
                             status = (CASE WHEN ((status = "-" or status = "S" or status="G") and ${finished} != "") THEN "F"
                                        WHEN   ((status = "-" or status = "S" or status="G") and ${row.Finish} != "") THEN "H"
                                        ELSE status END),
                             datafromscoring = "Y",
                             speed=${scoredvals.as}, distance=${scoredvals.ad},
                             hspeed=${scoredvals.hs}, hdistance=${scoredvals.hd},
                             daypoints=${parseInt(row.Points.replace(",",""))}, dayrank=${parseInt(row['#'].replace('.',""))}, totalpoints=${0}, totalrank=${0}, penalty=${0}
                          WHERE datecode=todcode(${date}) AND compno=${pilot} and class=${classid}`));

            //          console.log(`${pilot}: ${handicap} (${duration} H) ${scoredvals.ad} ${scoredvals.hd}` );
            rows += r.affectedRows;

            // check the file to check tracking details
            let { igcavailable } = (await mysql.query( escape`SELECT igcavailable FROM pilotresult
                                                              WHERE datecode=todcode(${date}) and compno=${pilot} and class=${classid}` ))[0]||{igcavailable:false};
            if( (igcavailable||'Y') == 'N' && url ) {
				await processIGC( classid, pilot, location, date, url, https, mysql );
				doCheckForOGNMatches = true;
			}
		}
    }

	// If we processed an IGC file we should check to see if we have an OGN launch/landing match
	if( doCheckForOGNMatches ) {
		checkForOGNMatches( classid, date, mysql );
	}
		
    // Did anything get updated?
    if( rows ) {
        await mysql.query( escape`UPDATE contestday SET results_uploaded=NOW()
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
async function update_contest(contest_name, dates, site_name, url) {

    // Add a row if we need to
    const count = (await mysql.query( 'SELECT COUNT(*) cnt FROM competition' ));
    if( ! count || !count[0] || ! count[0].cnt ) {
        console.log( "Empty competition, pre-populating" );
        mysql.query( escape`INSERT IGNORE INTO competition ( tz, tzoffset, mainwebsite ) VALUES ( "Europe/London", 3600, ${url} )` );
    }

	console.log( dates );

	const matches = dates.match( /([0-9A-Z ,]+) – ([0-9A-Z ,]+)/i );
	if( matches ) {
		console.log( matches );
		console.log( Date.parse(matches[1]+' UTC') );
		
		//
		// Make sure the dates are copied across
		await mysql.query( escape`
         UPDATE competition SET start = from_unixtime(${Date.parse(matches[1]+' UTC')/1000}),
                                  end = from_unixtime(${Date.parse(matches[2]+' UTC')/1000}),
                                  countrycode = 'UK',
                                  name = ${contest_name}`);
	}

    // If we have a location then update
	const ssLocation = undefined;
//	if( ssLocation && ssLocation.latitude ) {
  //      const lat = toDeg(ssLocation.latitude);
  //  //    const lng = toDeg(ssLocation.longitude);
//        await mysql.query( escape`UPDATE competition SET lt = ${lat}, lg = ${lng},
    //                                                  sitename = ${ssLocation.name}`);
    location = (await mysql.query( escape`SELECT lt, lg FROM competition`))[0];

	if( location.lt ) {

		// Save four our use
		location.point = point( [location.lt, location.lg] );
		
		// Calculate elevation so we can do launch calculations from the IGC files
		getElevationOffset( config, location.lt, location.lg,
							(agl) => { location.altitude = agl;console.log('SITE Altitude:'+agl,location) });
	}

    if( 0 ) { //keys.deep ) {
        // clear it all down, we will load all of this from soaring spot
        // NOTE: this should not be cleared every time, even though at present it is
        // TBD!!
        mysql.transaction()
            .query( escape`delete from classes` )
            .query( escape`delete from logindetails where type="P"` )
            .query( escape`delete from pilots` )
            .query( escape`delete from pilotresult` )
            .query( escape`delete from contestday` )
            .query( escape`delete from compstatus` )
            .query( escape`delete from taskleg` )
            .query( escape`delete from tasks` )
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
    return a/Math.PI*180;
}

//
// All the bizarre forms of handicap that have been spotted in scoring spot
function correct_handicap(handicap) {
    return ( !handicap ? 100 : ( handicap<2 ? handicap*100 : ( handicap > 140 ? handicap/10 : handicap)));
}
