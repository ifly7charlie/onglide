/*
 * The first of our scoring functions, this will process the points array for each pilot and produce a score
 * and make it available
 *
 */
import db from '../react/db.js';
import escape from 'sql-template-strings';


import LatLong from './LatLong.js';
import { point,lineString } from  '@turf/helpers';
import useKVs from '../kv.js';

import _groupby  from 'lodash.groupby'
import _map  from 'lodash.map'
import _foreach  from 'lodash.foreach'
import _clone  from 'lodash.clone'
import _maxby  from 'lodash.maxby'
import _unionby  from 'lodash.unionby'

// Helpers to deal with sectors and tasks etc.
import { preprocessSector, sectorGeoJSON, checkIsInTP } from './taskhelper.js';
import findStart from './scorefindstart.js';
import generateStatistics from './igcstatistics.js';

//import scoreSpeedTask = '../lib/scorespeedtask'

// Different scoring techniques
import scoreAssignedAreaTask from './scoreassignedareatask.js'
import scoreSpeedTask from './scorespeedtask.js'
import scoreDistanceHandicapTask from './scoredistancehandicaptask.js'
import scoreEglideTask from './scoreeglidetask.js'

// Helper
import fetch from 'node-fetch';
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
// data is { tracker, state and points }
export default async function scorePilot( className, compno, data ) {

    if( !className ) {
        console.log( "no class" );
        res.status(404).json({error: "missing parameter(s)"});
        return;
    }

    const now = Date.now();

	// Get out of the cache
	let [ task, pilots ] = (await fetchTaskAndPilots( className ));

	// Make sure we have initialised the tracker array from the database, they are similar but not
	// identical
    if( ! Object.keys(data.trackers).length ) {
		console.log( "no trackers, initialising" );
        _foreach( pilots, (undefined,compno) => { data.trackers[compno] = { min: 9999999999, max: 0 }; data.state[compno] = {}; data.points[compno] = []; } );
	}

	// Merge what we have on the pilot result from the database into the
    // tracker object.  This makes sure we know what scoring has reported
    // so when the pilot is scored we can display the actual scores on the screen
    _foreach( pilots, (pilot,compno) => {
        data.trackers[compno] = mergeDB(pilot[0],data.trackers[compno]);
        data.trackers[compno].taskduration = task?.task.durationsecs || 0;
    });

	// Make sure we have a task!
	if( ! task?.legs ) {
		return false;
	}

	// Now we need to work on the specific tracker
	let tracker = data.trackers[compno];
	if( ! tracker ) {
		return false;
	}
	
	if( tracker.outOfOrder ) {
//		console.log( tracker.compno, "OOO:", tracker.outOfOrder );
	}

	if( ! tracker.firstOldPoint ) {
//		console.log( tracker.compno, "nothing to rescore" );
//		tracker.firstOldPoint = points.length-1;
		return false;
	}

    // Generate LatLong and geoJSON objects for each new point for each pilot
    // Also record min and max alititude (metres)
	let points = data.points[compno];
	for( let i = Math.min(points.length-1,(tracker.oldestMerge||tracker.firstOldPoint)); i >= 0; i-- ) {
		let p = points[i];
		p.ll = new LatLong( p.lat, p.lng );
        p.geoJSON = point([p.lng,p.lat]);
        tracker.min = Math.min(tracker.min,p.a);
        tracker.max = Math.max(tracker.max,p.a);
	}

    // Enrich with the current status information
    if( points.length > 0 ) {
		tracker.lat = points[0].lat;
		tracker.lng = points[0].lng;
        tracker.altitude = points[0].a;
        tracker.agl = points[0].g;
        tracker.lastUpdated = points[0].t;
    }
			
    // Next step for all types of task is to confirm we have a valid start
    // Note that this happens throughout the flight regardless of how many turnpoints
    // have been flown, however to register as a new start the pilot must exit start sector and enter
	// 1st turn (or 3km near it). There is a restriction to stop it checking more than every 60 seconds
	//    _foreach( trackers, (pilot,compno) => findStart( trackers[compno], state[compno], task.legs, points[compno] ) );
    findStart( tracker, data.state[compno], task, data.points[compno] );

    // Actually score the task
    switch( task.task.type ) {
    case 'A': // Assigned Area Task
        scoreAssignedAreaTask( task, tracker, data.state[compno], data.points[compno] );
        //scoreAssignedAreaTask(task.legs, trackers['WO'], points['WO']);
        break;
    case 'X': // speed task
        scoreSpeedTask( task, tracker, data.state[compno], data.points[compno] );
        break;
    case 'D': // distance handicapped task (needs to know the maximum handicap to score it properly)
        scoreDistanceHandicapTask( task, tracker, data.state[compno], data.points[compno], _maxby(trackers,'handicap') );
		break;
	case 'S':
		scoreEglideTask( task, tracker, data.state[compno], data.points[compno] );
		break;
    default:
        const error = 'no scoring function defined for task type: ' + task.task.type;
        console.log( error );
        return;
    }

    // generate statistics for the flight so far
	generateStatistics( tracker, data.state[compno], data.points[compno] );

    // Update the vario
    calculateVario( tracker, data.state[compno], data.points[compno] );

	tracker.oldestMerge = undefined;
	tracker.firstOldPoint = undefined;

	return tracker;
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
        var copyKeys = [ 'dayrankordinal', 'totalrank', 'prevtotalrank', 
                         'statustext', 'utctime', 'datafromscoring', 
                         'forcetp' ];

        copyKeys.forEach( function(value) {
            tracker[value] = pilot[value];
        } );

		if( pilot.utcstart && pilot.start != '00:00:00' ) {
			tracker.manualstart = pilot.utcstart;
		}

        // If it has been scored or has a finish time in the database then copy the rest of the data over
        if( pilot.datafromscoring == 'Y' || pilot.finish == 'Y' ) {
            var copyKeys = [ 'start', 'utcstart', 'finish', 'utcfinish', 'dbstatus', 'statustext', 'utctime', 'datafromscoring', 'duration',
                             'hspeed', 'speed', 'hdistancedone', 'distancedone' ];

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
    const endTime = Math.min(endVarioTime, (state?.lastVarioTime ? state.lastVarioTime : points[points.length-1].t));

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


async function fetchTaskAndPilots(className) {
	// Fetch the tasks, legs, competition rules etc.  Needed for scoring
    // try cache
    let { task, pilots } = (kvs.get(className+'_task_pilots'))||{task:undefined,pilots:undefined};
    if( !task || !pilots) {
		console.log( `Fetching task and raw pilots for ${className}`);

        // and if it's stale then get from the api
        task = await fetcher('http://'+process.env.API_HOSTNAME+'/api/'+className+'/task')
        if( ! task || ! task.task || ! task.task.type ) {
            console.log( 'no task for class: ' + className );
        }
        let rules = await fetcher('http://'+process.env.API_HOSTNAME+'/api/'+className+'/rules')
        if( ! rules || ! rules[0]?.name ) {
            console.log( 'no rules for class: ' + className );
        }

        const rawpilots = await fetcher('http://'+process.env.API_HOSTNAME+'/api/'+className+'/pilots')
        if( ! rawpilots || ! rawpilots.pilots || ! rawpilots.pilots.length ) {
            console.log( 'no pilots for class: ' + className );
        }
		
		pilots = rawpilots ? _groupby( rawpilots.pilots, 'compno' ) : undefined;

		// Decorate the tasks so we have sectors in geoJSON format, we need this
		// for point in polygon etc, 
		// geoJSON probably is but tidier to just redo it here than confirm and not very expensive
		if( task.legs ) {
			task.legs.forEach( (leg) => preprocessSector(leg) );
			task.legs.forEach( (leg) => sectorGeoJSON( task.legs, leg.legno ) );
		}
		else {
			task = undefined;
		}

		if( task ) {
			task.rules = rules[0] || {};
		}
		
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
	return [ task, pilots ];
}
		
