/*
 * The first of our scoring functions, this will process the points array for each pilot and produce a score
 * and make it available
 *
 */
const db = require('../../../lib/db')
const escape = require('sql-template-strings')
import { useRouter } from 'next/router'


import LatLong from '../../../lib/LatLong';
import { point,lineString } from '@turf/helpers';
import { useKVs } from '../../../lib/kv.js';

import _groupby  from 'lodash.groupby'
import _map  from 'lodash.map'
import _foreach  from 'lodash.foreach'
import _clone  from 'lodash.clone'
import _maxby  from 'lodash.maxby'
import _unionby  from 'lodash.unionby'

// Helpers to deal with sectors and tasks etc.
import { preprocessSector, sectorGeoJSON, checkIsInTP } from '../../../lib/taskhelper.js';
import findStart from '../../../lib/scorefindstart.js';

//import scoreSpeedTask = '../../../lib/scorespeedtask'

// Different scoring techniques
import scoreAssignedAreaTask from '../../../lib/scoreassignedareatask'
import scoreSpeedTask from '../../../lib/scorespeedtask'
import scoreDistanceHandicapTask from '../../../lib/scoredistancehandicaptask'

// Helper
const fetcher = url => fetch(url).then(res => res.json());

// We want to keep track of what we have scored before as this algo has always been
// iterative. We expect them to have some values so initialise them correctly
// NOTE: *trackers* is what is returned, it is an amalgam of the database data
//         and the scored data (mergeDB to get DB and then scoring updates)
//       *state* is internal calculation and wil depend on the type of task
//         eg for AAT it stores the djikstra working set
//       *tasks* is the task data
let kvs = useKVs();

//
// Function to score any type of task - checks the task type field in the database
// to decide how to delegate to the various different kinds of tasks
export default async function scoreTask( req, res ) {
    const {
        query: { className },
    } = req;

    if( !className ) {
        console.log( "no class" );
        res.status(404).json({error: "missing parameter(s)"});
        return;
    }


    const now = Date.now();
    const startProfiling = process.hrtime();

    // Fetch the tasks, legs, competition rules etc.  Needed for scoring
    // try cache
    let { task, pilots } = (kvs.get(className+'_task_pilots'))||{task:undefined,pilots:undefined};
    if( !task || !pilots) {
		console.log( `Fetching task and raw pilots for ${className}`);

        // and if it's stale then get from the api
        task = await fetcher('http://'+process.env.API_HOSTNAME+'/api/'+className+'/task')
        if( ! task || ! task.task || ! task.task.type ) {
            console.log( 'no task for class: ' + className );
            res.status(404).json({error:'no task for class: ' + className});
            return;
        }

        const rawpilots = await fetcher('http://'+process.env.API_HOSTNAME+'/api/'+className+'/pilots')
        if( ! rawpilots || ! rawpilots.pilots || ! rawpilots.pilots.length ) {
            console.log( 'no pilots for class: ' + className );
            res.status(404).json({error:'no pilots for class: ' + className});
            return;
        }
		
		pilots = _groupby( rawpilots.pilots, 'compno' );

		// Decorate the tasks so we have sectors in geoJSON format, we need this
		// for point in polygon etc, 
		// geoJSON probably is but tidier to just redo it here than confirm and not very expensive
		task.legs.forEach( (leg) => preprocessSector(leg) );
		task.legs.forEach( (leg) => sectorGeoJSON( task.legs, leg.legno ) );
		
		// We want to keep track of what we have scored before as this algo has always been
		// iterative. We expect them to have some values so initialise them correctly
		// The cache is per class as each class has different scoring and we need to be
		// able to do them all at once.
		//
		// NOTE: *trackers* is what is returned, it is an amalgam of the database data
		//         and the scored data (mergeDB to get DB and then scoring updates)
		//       *state* is internal calculation and wil depend on the type of task
		//         eg for AAT it stores the djikstra working set
		//       *tasks* is the task data
        // Store what we have received so we don't need to query till it expires
        // which is handled below
        kvs.set(className+'_task_pilots',{task:task, pilots:pilots}, 600);
    }
	
	// last point we fetched
	const { lastPoint, cachedTaskId } = kvs.get(`${className}_last`)||{lastPoint:0,cachedTaskId:0};

	let tOffset = parseInt(process.env.NEXT_PUBLIC_TOFFSET)||0;
	if( tOffset < 0 ) { tOffset += (Date.now())/1000 };

    // Next up we will fetch a list of the pilots and their complete tracks
    // This is going to be a big query
    let rawpoints = await db.query(escape`
            SELECT compno, t, round(lat,10) lat, round(lng,10) lng, altitude a, agl g, bearing b, speed s
              FROM trackpoints
             WHERE datecode=${task.contestday.datecode} AND class=${className} AND t >= ${lastPoint} 
               AND ( ${tOffset} = 0 OR t < ${tOffset} )
            ORDER BY t DESC`);

    // Group them by comp number, this is quicker than multiple sub queries from the DB
    let newPoints = _groupby( rawpoints, 'compno' );

    // We need to make sure our cache is valid - this is both to confirm it hasn't
    // gone back in time more than our check interval (for running sample site)
    // and that the taskid hasn't changed (eg from a new contest day)
	const newestPoint = (rawpoints[0]?.t||0);
    if( (lastPoint && lastPoint > newestPoint) || (cachedTaskId && cachedTaskId != task.task.taskid) ) {
        kvs.del( [ `${className}_task_pilots`, `${className}_last` ]);
        console.log(className + " stale cache, fail request");
        res.status(503)
            .json({error:'stale cache'});
        return;
    }
    kvs.set(`${className}_last`,{lastPoint:newestPoint,cachedTaskId:task.task.taskid})



	// Stored in one key with the points
    let { trackers, state, previousPoints } = (kvs.get(`${className}_scoring`)) || { trackers: {}, state: {}, previousPoints: {}};
    if( ! Object.keys(trackers).length ) {
		console.log( "no trackers, initialising" );
        _foreach( pilots, (undefined,compno) => { trackers[compno] = { min: 9999999999, max: 0 }; state[compno] = {}; previousPoints[compno] = [] } );
	}

    // Merge what we have on the pilot result from the database into the
    // tracker object.  This makes sure we know what scoring has reported
    // so when the pilot is scored we can display the actual scores on the screen
    _foreach( pilots, (pilot,compno) => {
        trackers[compno] = mergeDB(pilot[0],trackers[compno]);
        trackers[compno].taskduration = task.task.durationsecs;
    });

    // Generate LatLong and geoJSON objects for each new point for each pilot
    // Also record min and max alititude (metres)
    _foreach( newPoints, (ppoints,compno) => {
		var tracker = trackers[compno];
        if( ! tracker ) {
            console.log( compno + "missing" );
            return;
        }

        _foreach( ppoints, (p) => {
            p.ll = new LatLong( p.lat, p.lng );
            p.geoJSON = point([p.lng,p.lat]);
            tracker.min = Math.min(tracker.min,p.a);
            tracker.max = Math.max(tracker.max,p.a);
        })

		console.log( compno, tracker.min, tracker.max );

        // Enrich with the current status information
        if( ppoints.length > 0 ) {
			tracker.lat = ppoints[0].lat;
			tracker.lng = ppoints[0].lng;
            tracker.altitude = ppoints[0].a;
            tracker.agl = ppoints[0].g;
            tracker.lastUpdated = ppoints[0].t;
        }
    });

	// Reinstall the latlong as we need this ;)
//	_foreach( previousPoints, (ppoints,compno) => {
//        _foreach( ppoints, (p) => {
//            p.ll = new LatLong( p.lat, p.lng );
      //      p.geoJSON = point([p.lng,p.lat]);
//		})
//	});

	// from here we need to have a combined array of points, which means an intersection
	let points = {};
	_foreach( pilots, (pilot,compno) => {
		trackers[compno].firstOldPoint = undefined;
		if( previousPoints[compno]?.length && newPoints[compno]?.length ) {
			let oldest = newPoints[compno].length-1;
			const newestold = previousPoints[compno]?.[0]?.t||0;
			while( oldest >= 0 && newPoints[compno][oldest].t <= newestold ) {
				oldest--;
			}
			trackers[compno].firstOldPoint = oldest;
			if( oldest >= 0 ) {
				points[compno] = newPoints[compno].slice(0,oldest+1).concat(previousPoints[compno]);
				trackers[compno].firstOldPoint = oldest;
			}
			else {
				points[compno] = previousPoints[compno];
				console.log( `merge points ${compno} no new points found` );
			}
		}
		else {
			if( previousPoints[compno]?.length ) {
				points[compno] = previousPoints[compno];
			}
			else if( newPoints[compno]?.length ) {
				points[compno] = newPoints[compno];
				trackers[compno].firstOldPoint = newPoints[compno].length-1;
			}
		}
		function twoffset(d) {
			const nd = new Date((d)*1000);
			return nd.toISOString().substring(11,11+8);
		}
	});

    // Next step for all types of task is to confirm we have a valid start
    // Note that this happens throughout the flight regardless of how many turnpoints
    // have been flown, however to register as a new start the pilot must exit start sector and enter
    // 1st turn (or 3km near it). There is a restriction to stop it checking more than every 60 seconds
    _foreach( trackers, (pilot,compno) => findStart( trackers[compno], state[compno], task.legs, points[compno] ) );

    // Actually score the task
    switch( task.task.type ) {
    case 'A': // Assigned Area Task
        _map( points, (points,compno) => scoreAssignedAreaTask( task, trackers[compno], state[compno], points )  );
        //scoreAssignedAreaTask(task.legs, trackers['WO'], points['WO']);
        break;
    case 'S': // speed task
        _map( points, (points,compno) => scoreSpeedTask( task, trackers[compno], state[compno], points ) );
        break;
    case 'D': // distance handicapped task (needs to know the maximum handicap to score it properly)
        _map( points, (points,compno) => scoreDistanceHandicapTask( task, trackers[compno], state[compno], points, _maxby(trackers,'handicap') ));
        break;
    default:
        const error = 'no scoring function defined for task type: ' + task.task.type;
        console.log( error );
        res.status(404).json({error:error});
        return;
    }

    // Update the geoJSON with the scored trackline so we can easily display
    // what the pilot has been scored for
    _foreach( trackers, (pilot) => {
        if( pilot ) {
			// And form the line
            if( pilot.scoredpoints && pilot.scoredpoints.length>1 ) {
                pilot.scoredGeoJSON = lineString(pilot.scoredpoints,{})
            }
            else {
                delete pilot.scoredpoints;
            }
    }});

    // Update the vario
     _map( points, (points,compno) => calculateVario( trackers[compno], state[compno], points )  );

    // Store our calculations away, we don't need to wait for this to return
    // This means we won't need to reprocess every track point the next time
    // round
    kvs.set(`${className}_scoring`,{trackers:trackers, state:state, previousPoints:points});

    const profiled = process.hrtime(startProfiling);
    console.info(className+' * scored, time (elapsed): %d seconds', Math.round(1000*(profiled[0] + (profiled[1] / 1000000000)))/1000 );

    // How long should it be cached
    res.setHeader('Cache-Control','max-age=60');

    // Return the results, this returns basically the same as the pilot
    // API call except it will be enriched with results if we have any
    res.status(200)
        .json({pilots:trackers});
}


//
// Merge the DB record (pilot) into the local state (tracker)
///
function mergeDB( pilot, tracker )
{

    if( ! tracker || ! tracker.compno ) {
        tracker = _clone(pilot);       // by default use the db settings
        tracker.maxdistancedone = 0;   // how far, 0 isn't far
        tracker.min = 999999999999;    // heights
        tracker.max = 0;
        if( tracker.datafromscoring == 'N' ) {
            tracker.utcstart = undefined;
            tracker.start = '00:00:00';
            tracker.utcfinish = undefined;
        }
    }

    else {
        // Until we have scoring we will keep our internal calculations
        var copyKeys = [ 'dayrankordinal', 'lasttp', 'totalrank', 'prevtotalrank', 'lolat' ,'lolong', 'loreported', 'lonear',
                         'statustext', 'utctime', 'datafromscoring', 'lolat', 'lolng', 'looriginal',
                         'forcetp' ];

        copyKeys.forEach( function(value) {
            tracker[value] = pilot[value];
        } );

        // If it has been scored or has a finish time in the database then copy the rest of the data over
        if( pilot.datafromscoring == 'Y' || pilot.finish == 'Y' ) {
            var copyKeys = [ 'start', 'utcstart', 'finish', 'utcfinish', 'dbstatus', 'statustext', 'utctime', 'datafromscoring',
                             'hspeed', 'speed', 'hdistancedone', 'distancedone', 'forcetp' ];

            copyKeys.forEach( function(value) {
                tracker[value] = pilot[value];
            } );
        }
    }

    return tracker;
}


function calculateVario( tracker, state, points ) {

    // If we have a real score then we are not flying so don't report this...
    // same if no points
    if( tracker.datafromscoring == 'Y' || points.length < 1 ) {
        tracker.gainXsecond = undefined;
        tracker.lossXsecond = undefined;
        tracker.min = undefined;
        tracker.max = undefined;
        tracker.Xperiod = undefined;
        tracker.altitude = undefined;
        tracker.agl = undefined;
        return;
    }

    let p = 0;

    // How far are we scanning
    const firstTime = points[p].t;
    const endVarioTime = firstTime - 60;
    const endTime = Math.min(endVarioTime, (state.lastVarioTime ? state.lastVarioTime : points[points.length-1].t));

    // Save away our latest altitude
    tracker.altitude = points[0].a;
    tracker.agl = points[0].g;
    tracker.gainXsecond = 0;
    tracker.lossXsecond = 0;
    tracker.Xperiod = 0;

    while( p < points.length-1 && points[p].t > endTime) {
        const pt = points[p];

        tracker.min = Math.min(tracker.min,pt.a);
        tracker.max = Math.max(tracker.max,pt.a);

        if( pt.t > endVarioTime ) {
            var diff = pt.a - points[p+1].a;
            if( diff > 0 ) {
                tracker.gainXsecond += diff;
            }
            else {
                tracker.lossXsecond -= diff;
            }
            tracker.Xperiod = firstTime - points[p+1].t;
        }
        p++;
    }

    // So we know
    state.lastVarioTime = points[p].t;

    // So it doesn't display if we didn't record it
    var climbing = false;
    if( tracker.Xperiod && tracker.Xperiod < 90 ) {
        tracker.gainXsecond = Math.round(tracker.gainXsecond*10)/10;
        tracker.lossXsecond = Math.round(tracker.lossXsecond*10)/10;
        // 9.87 = feet/minute to knots
        // 60 = m/minute to m/sec
        tracker.average = Math.round(((tracker.gainXsecond + tracker.lossXsecond) / tracker.Xperiod )*10)/10;
        //        tracker.averager = Math.round(((tracker.gainXsecond + tracker.lossXsecond) / tracker.Xperiod) * 60 / (map.og_units?9.87:6))/10;
    }
    else {
        tracker.gainXsecond = undefined;
        tracker.lossXsecond = undefined;
        tracker.average = undefined;
        tracker.Xperiod = undefined;
    }
}
