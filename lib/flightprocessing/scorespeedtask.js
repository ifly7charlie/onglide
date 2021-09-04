/* this is from original site, being taken to pieces */
/* Copyright(c)2007-2020, Melissa Jenkins.  All rights reserved */

import LatLong from './LatLong.js';

import { checkIsInTP, closestPointInSector } from './taskhelper.js';
import { timeToText, durationToText } from './timehelper.js';

import _sumby from 'lodash.sumby';

export default function scoreSpeedTask( task, tracker, state, points ) {

    // If we have a handicap distance task then we need to
    // adjust it for our handicap
    // apart from that we treat it exactly the same as a normal speed task
    const handicap = tracker.handicap;
    function calcHandicap(dist,leg) {
        return ((100.0*dist)/Math.max(handicap+leg.Hi,25))
    }

	// Generate log function as it's quite slow to read environment all the time
	const log = (tracker.compno == (process.env.NEXT_PUBLIC_COMPNO||'')) ?
				function log() { console.log(tracker.compno, ...arguments ); } :
				function log() {};

	// We don't score if there is no start, this stops weird things like doglegs when the
	// tracker is off getting ready ;)
	if( ! tracker.utcstart ) {
		log( "no start found" );
		return;
	}

    // Shortcut
    let legs = task.legs;

    // Always start at start for speed scored task
    tracker.scoredpoints = [ [ legs[0].ll.dlong(), legs[0].ll.dlat() ]];
	tracker.legs = [];

    let t = state?.t || 0;

	// Check for restart
	if( (state.lastProcessedTime||0) < tracker.utcstart+1 ) {
		state.lastProcessedTime = tracker.utcstart+1;
        // skip to the first point after the start, we don't want to capture that point
        // as it will update pointsByTime and that will change where the scoring line is
        // drawn.
    }
    log( `number of points: ${points.length}, lastprocessedimte:${state.lastProcessedTime}` );

    // Skip all the points we have processed
    let p = points.length-2;
    if( state.lastProcessedTime !== undefined ) {
        while( p >= 0 && points[p].t < state.lastProcessedTime ) {
            p--;
        }
    }

	// Setup the leg structure for the start
	if(  t == 0 ) {
		t = 1;
		state.distancedone = 0;
		state.hdistancedone = 0;
		state.maxdistancedone = 0;
		tracker.lasttp = 0;
		tracker.legs = {
			1: {
				time: tracker.utcstart,
				alt:points[p>0?p:0].a, agl:points[p>0?p:0].g,
			}
		}
	}


	// Add up how much distance is left
	function remainingDistance( nextdist, t) {
		let remainingdistance = nextdist;
        let hremainingdistance = t < legs.length ? calcHandicap(nextdist,legs[t]) : 0; // Accumulate the handicapped distance

        for(let tx = t; tx < legs.length;tx++ ) {
            remainingdistance += legs[tx].length;
            hremainingdistance += calcHandicap(legs[tx].length,legs[tx]); // Accumulate the handicapped distance
        }
		return { remainingdistance: remainingdistance, hremainingdistance: hremainingdistance }
	}

	

    let prevdist = Math.round(LatLong.distHaversine( points[p+1].ll, legs[t].ll )*10)/10;
    let prevdistances = [];
    let prevtime = [];
    let sectorpoints = 0;
    let maxpoint = 0; // AAT: last point used for scoring
    let insector = 0;

    let distancedone = state?.distancedone || 0;
    let hdistancedone = state?.hdistancedone || 0;
    let maxdistancedone = state?.maxdistancedone || 0;
//    let hremainingdistance = 0;
//    let remainingdistance = 0;
    let lasttp = tracker.lasttp || undefined;
	let closesttonext = state?.closesttonext || 99999; // how close to the next tp have we got, only used for last leg

    const finishLeg = legs.length-1;

    if( tracker.forcetp && tracker.forcetp != '' ) {
        log( tracker.compno + "* forcetp: " + tracker.forcetp );
        tracker.forcetp = parseInt(tracker.forcetp);

        while( t < tracker.forcetp ) {
            distancedone += legs[t].length;
            hdistancedone += calcHandicap(legs[t].length,legs[t]); // Accumulate the handicapped distance
            tracker.scoredpoints.push( [ legs[t].ll.dlong(), legs[t].ll.dlat() ] );
			tracker.legs.push( {leg: t} );
            t++;
        }
    }

    // Calculate handicapped task distance if there isn't one already calculated
    if( ! state.htaskdistance ) {
        state.htaskdistance = _sumby(legs, (leg) => calcHandicap(leg.length,leg));
        log( tracker.compno+ "* handicap "+handicap+", task distance:"+state.htaskdistance );
    }

    var wasinsector = 0;
	var _wasinsector = -1;

    log( "------------------------------------------------------------" );
    while( p >= 0 && t < legs.length ) {

        // Skip over points that are too close in distance, this should ignore thermalling
        // we really want about a 2.5 k jump
        let forward = p+1;
        let accumulated = 0;
        let skipmore = 0;

		var pprev = p+1;
		var ptime = points[p+1].t;
        const minDistance = 0.150; // 150m
		
		var _isinsector = checkIsInTP( legs[t], points[p] );
		while( p > 0 &&
			   LatLong.distHaversine( points[p].ll, points[pprev].ll ) < minDistance /* at least a total movement */ &&
			   (points[p].t-ptime) < 90 /* no more than every 90 seconds */ &&
			   Math.sign(_wasinsector) == Math.sign(_isinsector) /* change of sector state on this scan */ &&
			   _isinsector < -1 /* and we are more than 1km away */ ) {
			p--;
			_isinsector = checkIsInTP( legs[t], points[p] );
			closesttonext = Math.min( -_isinsector, closesttonext||(-_isinsector) );
		}

		if( _isinsector >= 0 )  {
			sectorpoints++;
            insector = 1;
            log( tracker.compno + "* in sector " + t + " at " + timeToText(points[p].t));
		}
        else {
            insector=0;
        }

        // If we are longer than the leg we are on then we are not on the leg or something odd, assume we
        // are at the beginning of it - this should stop negative numbers.  Note we adjust by r1 only if we are
        // not an AAT.  AATs deal with this differently!  This adjustment is mostly needed for the distance handicapped
        // task
        const curdist = Math.max(-_isinsector,0);// LatLong.distHaversine( points[p].ll, legs[t].ll);
        let advancetp = 0;

        // Store these and only keep previous 3
        prevdistances.push( curdist );
        prevtime.push( points[p].t );

        if( prevdistances.length > 3 ) {
            prevdistances.shift();
            prevtime.shift();
        }
        log( ` ${insector?'in sector':'not in sector'} @ t ${t}, distance ${curdist}, closest ${closesttonext}` );

        // If we have a point in the sector then we should advance on this
        if( insector ) {	
			// Check for the finish, if it is then only one point counts and we can stop tracking
			if( t == finishLeg ) {
				log( tracker.compno + "* found a finish " + points[p].t );
				tracker.utcfinish = points[p].t;
				tracker.dbstatus = 'F';
				tracker.finish = timeToText( tracker.utcfinish );
			}
			else {
				log( tracker.compno + "* next tp:" + t + "/"+insector + ",sp:"+sectorpoints );
			}
            advancetp = 1;
        }

        // If we don't have 3 previous distances then skip this point
		if( prevdistances.length == 3 ) {
			
            // Allow for a dog leg - ie closer and then further
            // most recent two point may be the departure rather than
            // the entry so we need to look back an extra one
            if ( t !== finishLeg && curdist > prevdistances[1] ) {

				// Did we have a tracking glitch?
				const timeTaken = (prevtime[2] - prevtime[0]);
				const achievedSpeed = ((prevdistances[0] + prevdistances[2]) / timeTaken );
				const possibleSpeed = (timeTaken > 600 ? 120 : 180)/3600;
				if( timeTaken > 40 && achievedSpeed < possibleSpeed ) {
					log( tracker.compno + "* dog leg "+t+", "+ (prevdistances[0]+prevdistances[2]) + "km in " + timeTaken +
						 "seconds, but could have achieved distance in the time: "+ achievedSpeed +" < "+ possibleSpeed );
					advancetp = 1;
				}

				// Or are they in the penalty area for the sector, only works with circles!
				else if( Math.min( ...prevdistances ) < 0.5 ) {
					log( `* penalty volume distance ${Math.min( ...prevdistances )} to tp ${t}, assuming next turnpoint` );
					advancetp = 1;
				}
            }
		}
		
        // Next task turn point and distance to it
        if( advancetp ) {
			
            if( t != legs.length-1 ) {
                tracker.scoredpoints.push( [ legs[t].ll.dlong(), legs[t].ll.dlat() ] );
			}

			const r = remainingDistance( 0, t+1 );
			const duration = (points[p].t-tracker.legs[t].time);
			const hleg = calcHandicap( legs[t].length, legs[t] );
			tracker.legs[t] = { ...tracker.legs[t],
								leg: t, 
								lat:round(legs[t].ll.dlat(),5), lng:round(legs[t].ll.dlong(),5),
								duration: duration,
								actual: {
									distance: round(legs[t].length,1),
									distancedone: round(task.task.distance - r.remainingdistance,1),
									legspeed: round( legs[t].length / (duration/3600), 1),
									taskspeed: round( (task.task.distance - r.remainingdistance) / ((points[p].t-tracker.utcstart)/3600), 1),
								},
								handicapped: {
									distance: round(hleg,1),
									distancedone: round(state.htaskdistance - r.hremainingdistance,1),
									legspeed: round( hleg / (duration/3600), 1 ),
									taskspeed: round( (state.htaskdistance - r.hremainingdistance) / ((points[p].t-tracker.utcstart)/3600), 1),
								}
			};
			
            t++;
			tracker.legs[t] = {
				time: points[p].t,
				alt:points[p].a, agl:points[p].g,
			}
            insector = 0;
            sectorpoints = 0;
			closesttonext = 99999;
			
			// If we have gone round a TP then the previous stuff is irrelevant as it was to previous tp
			prevdistances = [];
			prevtime = [];
        }

        prevdist = curdist;
        p--;
    }

    log( tracker.compno + "* leg t" + t + " length " + legs.length);

    ///////////////////////////////////////////
    // Output the information about how the task is going here
    ///////////////////////////////////////////

    if( t == legs.length ) {
        log( tracker.compno + "* finished" );
        tracker.status = "finished";

		// We always decrement in the loop above but actually we want first point in finish not second
		p++;
		
        // Store away our finish
        if( ! tracker.capturedfinishtime && tracker.datafromscoring == 'N' ) {
            tracker.dbstatus = 'F';
            tracker.utcfinish = tracker.capturedfinishtime = points[p>0?p:0].t;
            tracker.finish = timeToText( tracker.utcfinish );
            tracker.utcduration = tracker.utcfinish - tracker.utcstart;
            tracker.duration = durationToText( tracker.utcduration );
            log( tracker.compno + "* captured finish time: "+timeToText(tracker.utcfinish));
        }

        // not relevant on a finished task
        tracker.remainingdistance = undefined;
        tracker.hremainingdistance = undefined;
        tracker.grremaining = undefined;
        tracker.hgrremaining = undefined;

        // We figure this out because we score to the edge of the sector not to the
        // tp center - note this is calculated on the task track not on the pilots track!
        tracker.lasttp = lasttp = t-1;
        log( tracker.compno+ "* final leg " + (lasttp-1) + "," + legs[lasttp].length );
        const scoredTo = LatLong.intermediatePoint(legs[lasttp-1].ll,legs[lasttp].ll,
                                                   (legs[lasttp].lengthCenter)/6371,(legs[lasttp].length/legs[lasttp].lengthCenter));
        tracker.scoredpoints.push( [ scoredTo.dlong(), scoredTo.dlat() ] );

        // pass onwards as the reference numbers rather than any calculations
        maxdistancedone = task.task.distance;
        hdistancedone = state.htaskdistance;

		// Finish ring removal
		tracker.legs[t-1].lat = round(scoredTo.dlat(),5);
		tracker.legs[t-1].lng = round(scoredTo.dlong(),5);
		tracker.legs[t-1].y = 1;
		
        log( tracker );
    }
    else {

        // We haven't finished but want to calculate everything properly

        // Distance from current point to next turnpoint...
        // Make sure we aren't further than the next leg is long
        const nextdist = round(Math.min(closesttonext,legs[t].length),1);
		// Math.round(Math.min(LatLong.distVincenty( points[0].ll, legs[t].ll),legs[t].length)*10)/10


        // We will only report next turn point if it isn't the last turn point,
        // also doesn't mean much when we are inside the sector so slightly different display for that
        let nexttp = '';
        tracker.lasttp = lasttp = t;

        if ( t+1 < legs.length ) {
            tracker.status = `${nextdist} km to tp #${t}, ${legs[t].trigraph?legs[t].trigraph+':':''}${legs[t].name}`;
        }
        else {
            tracker.status = nextdist + " km to finish";
        }

        // add rest of task to outstanding distance
		const r = remainingDistance( nextdist, t+1 );

        // These are the only differences for the display between the two
        // last point and task distance calculations
        maxdistancedone = Math.max( task.task.distance - r.remainingdistance, 0);
        hdistancedone = Math.max( state.htaskdistance - r.hremainingdistance, 0);

        log('not finished yet> dd:'+maxdistancedone+', hdd:'+hdistancedone);

        // And draw to where it has been scored
        const scoredTo = LatLong.intermediatePoint(legs[lasttp-1].ll,legs[lasttp].ll,
                                                   legs[lasttp].length/6371,1-(nextdist/legs[lasttp].lengthCenter));

        tracker.scoredpoints.push( [ scoredTo.dlong(), scoredTo.dlat() ] );
		// Calculate the leg, to get here we are p < 0
		const distance = legs[t].length-nextdist;
		const hdistance = calcHandicap( distance, legs[t] );
		const duration = points[0].t-tracker.legs[t].time;
		tracker.legs[t] = {
			...tracker.legs[t],
			lat:round(scoredTo.dlat(),5), lng:round(scoredTo.dlong(),5),
			duration: duration,
			actual: { 
				distance: round(distance,1),
				distancetonext: round(nextdist,1),
				distancedone: round(maxdistancedone,1),
				remainingdistance: tracker.remainingdistance = round(r.remainingdistance,1),
				grremaining: tracker.grremaining = (points[0].g > 100 ? round((r.remainingdistance*1000)/(points[0].g),0) : undefined),
				legspeed: t > 0 ? round( (legs[t].length-nextdist) / ((duration)/3600), 1) : 0,
				taskspeed: round( maxdistancedone / ((points[0].t-tracker.utcstart)/3600), 1),
			},
			handicapped: {
				distance: round(hdistance,1),
				distancetonext: round(calcHandicap(nextdist,legs[t]),1),
				distancedone: round(hdistancedone,1),
				remainingdistance: tracker.hremainingdistance = round(r.hremainingdistance,1),
				grremaining: tracker.hgrremaining = (points[0].g > 100 ? round((r.hremainingdistance*1000)/(points[0].g),0) : undefined),
				legspeed: t > 0 ? round( hdistance / (duration/3600), 1 ) : 0,
				taskspeed: round( hdistancedone / ((points[0].t-tracker.utcstart)/3600), 1),
			}
		}
	}

    log( tracker.compno + "* start: " + tracker.start + ", finish "+ tracker.finish);

    // establish distance flown and speed
    if( tracker.utcstart && tracker.datafromscoring != 'Y') {

        let elapsed = ((tracker.utcfinish ? tracker.utcfinish : points[0].t) - tracker.utcstart)/3600;
        if( elapsed < 0 ) {
            elapsed = 1000000000000000;
        }
        log( tracker.compno + "* elapsed:"+elapsed+", utcs:"+tracker.utcstart+", utcf:"+tracker.capturedfinishtime );
        log( tracker.compno + "* h distance done:"+hdistancedone+", distance done:"+maxdistancedone );

        tracker.hdistancedone = hdistancedone;
        tracker.distancedone = maxdistancedone;
        tracker.lasttp = lasttp;

        const speed = Math.round( (maxdistancedone * 10) / elapsed )/10; // kph
        const hspeed = Math.round( (hdistancedone * 10) / elapsed )/10; // kph
        if( maxdistancedone > 0 ) {
            tracker.speed = speed;
            tracker.hspeed = hspeed;
        }

        // make sure we aren't too fast and that we have been past start for a few minutes (x/60)
        if( tracker.speed > 180 || tracker.hspeed > 180 || elapsed < (5/60) ) {
            tracker.speed = undefined;
            tracker.hspeed = undefined;
        }
        log( tracker.compno + "* speed:"+tracker.speed+", hspeed:"+tracker.hspeed);
    }

    if( tracker.datafromscoring == 'Y' ) {
        tracker.utcduration = tracker.utcfinish - tracker.utcstart;
        tracker.duration = tracker.utcduration ? durationToText( tracker.utcduration ) : '';
        tracker.remainingdistance = tracker.hremainingdistance = 0;
        tracker.grremaining = tracker.hgrremaining = 0;
    }

	// Record the state in the tracker object
	state = { ...state,
			  distancedone: distancedone,
			  hdistancedone: hdistancedone,
			  maxdistancedone: maxdistancedone,
			  closesttonext: closesttonext,
			  lastProcessedTime: points[p]?.t||points[0]?.t||0,
			  t: lasttp
	};
}


function round(n,e) {
	const p = Math.pow(10,e);
	return Math.round( n * p )/p;
}

