/*
 * Start sectors are the same for all types of tasks
 *
 * Although not all competitions use start sectors at present Onglide only supports sectors and when the task
 * is loaded from SoaringSpot it will convert a line into a sector. This isn't a perfect optimization but simplifies
 * in or out of sector calculation. Turf appears to do intersect so may be easier to fix this than it was using
 * goole maps
 *
 */

import {
    setTimeout,
} from 'timers/promises';

import LatLong from './LatLong.js';

import { checkIsInTP, checkIsInStartSector } from './taskhelper.js';
import { timeToText } from './timehelper.js';


// POINTS ARRAY IS OLDEST TO NEWEST
export default async function findStart( tracker, state, task, points )
{
    // make sure we have enough points to make it worthwhile
    if( ! points || points.length < 3 ) {
        return 0;
    }

	const legs = task.legs;
	const rules = task.rules;

	// Generate log function as it's quite slow to read environment all the time
	const log = (tracker.compno == (process.env.NEXT_PUBLIC_COMPNO||'')) ?
				function log() { console.log(tracker.compno, ...arguments ); } :
				function log() {};

    log( state );
    log( tracker );

    // POINTS ARRAY IS OLDEST TO NEWEST
    // Note we start looking from the start at the newest point! this
    // is so we find the most recent start
    var t = 0;
    var p = points.length-2;
    var compno = tracker.compno; // logging

	// If there is supposed to be a grandprix start then we assume it is, we don't
	// actually check they started
	if( rules.grandprixstart && task.task.nostart != '00:00:00' && task.task.nostartutc < (points[0]?.t||0)) {
		log( "grandprixstart" );
		tracker.utcstart = task.task.nostartutc;
		tracker.start = timeToText(tracker.utcstart);
		tracker.dbstatus = 'S';
		tracker.startFound = true;
		return;
	}

	// If there has been a time put into soaringspot then use that
	if( tracker.manualstart ) {
		log( "manual start from db" );
		tracker.utcstart = tracker.manualstart;
        tracker.start = timeToText(tracker.utcstart);
		tracker.dbstatus = 'S';
		tracker.startFound = true;
		return;
	}

	// Otherwise if there are scores
    if( tracker.datafromscoring == 'Y' ) {
        if( tracker.utcstart ) {
			log( "start from results" );
            tracker.startFound = true;
			tracker.dbstatus = 'S';
        }
        return;
    }

    // Make sure we don't do this too often as it's not fantastically efficient
    // when decoupled from rest of scoring
    if( state.lastCheckforStart ) {

        // Check every two minutes
        let threshold = 120;

        // If it has been started for more than 30 minutes then check every 15 minutes
        if( points[0].t - tracker.utcstart < 30*60 ) {
            threshold = 15*60;
        }

        // If we haven't hit the threshold then don't check again for a while
        if( state.lastCheckforStart + threshold > points[0].t ) {
            return undefined;
        }
    }
		
    // We are checking now so cache away the time
    state.lastCheckforStart = points[0].t;

    // Helper to save us slicing all the time
    // just take first two turnpoints
    let actualTurnpoints = legs.slice(1,2);

    // state for the search
    var insector = 0;
    var wasinsector = 0;
    var laststarttime = 0;

    // Shortcut to the startline which is expected to always be the first point
    var startLine = legs[0];

    if( startLine.type !== 'sector' ) {
        log( "please write line cross stuff!" );
        return 0;
    }

    log( "---[ "+compno+"* start ] ------------------------------------------------------------" );

    do {
        insector = 0;

        if( p < 0 || !(points[p].lat) || ! points[p].ll ) {
            console.log( `weird points problem ${compno}, p:${p}, points[p]:${points[p]}, points.length: ${points.length}, ll:${points[p].ll}`);
        }

        // check if we are in the sector - skip on tps that don't have sectors...
        if( points[p].inStartSector || checkIsInStartSector( startLine, points[p] ) ) {
            insector = 1;
            wasinsector = 1;
			points[p].inStartSector = true;

            // If we are in the start sector this is now wrong
            laststarttime = tracker.utcstart = undefined;
            tracker.startFound = undefined;
            log("in start sector "+points[p].t);
        }

        // We have left the start sector, remember we are going forward in time
        if( wasinsector && ! insector ) {
            laststarttime = tracker.utcstart = points[p+1].t;
            tracker.start = timeToText(laststarttime);
            tracker.startFound = true;
            tracker.dbstatus = 'S';
            wasinsector = 0;
        }

        // And we keep going until we hit the first turn point then we can stop looking
        // (or within 3 km of it)
        // This means once you have turned one turn you can't easily restart but ensures
        // that flying back over the start doesn't cause a restart
        if( ! (insector in points[p]) || !(sectornumber in points[p]) ) {
            actualTurnpoints.some( (tp) => {
                if( checkIsInTP( tp, points[p] ) + 3 >= 0 ) {
                    points[p].insector = 1;
                    points[p].sectornumber = tp.legno;
					return true;
                }
                return false;
            });
        }

        if( points[p].insector && points[p].sectornumber > 0 ) {
            insector = 1;
            log( compno + "* in tp sector at " + timeToText(points[p].t) );
            break;
        }

        // Make sure we yield regularily
        if( (p%50) == 0 ) {
            await setTimeout(0);
        }

        p--;

    } while ( p > 0 );

    if( wasinsector ) {
        log( compno + "* oops.. still insector at " + timeToText(points[p].t));
    }

    // set the last updated time...
    if( laststarttime ) {
        log( "* start found at " + laststarttime + ", " + timeToText(laststarttime) );
    }

	// Don't start before we are supposed to, simply don't check till
	// we have a point after the start time (give 10 second buffer even though rules don't).
	if( task.task.nostart != '00:00:00' && tracker.utcstart < (task.task.nostartutc-10) ) {
		tracker.utcstart = undefined;
        tracker.start = '00:00:00';
        tracker.startFound = false;
        tracker.dbstatus = 'G';
		log( "start time not yet reached" );
	}

	// If GP start then once the time has passed they have started regardless
	if( (task.task.type == 'G' || rules?.grandprixstart == 'Y') && points[0].t > task.task.nostartutc ) {
		tracker.utcstart = task.task.nostartutc;
        tracker.start = timeToText(laststarttime);
        tracker.startFound = true;
        tracker.dbstatus = 'S';
		log( "start time not yet reached" );
	}

    return laststarttime;

}
