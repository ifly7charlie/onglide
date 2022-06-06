/* this is from original site, being taken to pieces */
/* Copyright(c)2007-2020, Melissa Jenkins.  All rights reserved */

import LatLong from './LatLong.js';

import { checkIsInTP } from './taskhelper.js';
import { timeToText, durationToText } from './timehelper.js';

import {lineString} from '@turf/helpers';
import length from '@turf/length';
import distance from '@turf/distance';
import along from '@turf/along';

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
	console.log( tracker.start, tracker.utcstart );
	if( ! tracker.utcstart || tracker.start == '00:00:00') {
		log( "no start found" );
		return;
	}

    // Shortcut
    let legs = task.legs;
	

	// Check for restart
	if( (state.lastProcessedTime||0) < tracker.utcstart+1 || state.lastStartTime != tracker.utcstart ) {
		console.log( 'reset state', state );
		// Always start at start for speed scored task
		tracker.scoredpoints = [ [ legs[0].ll.dlong(), legs[0].ll.dlat() ]];
		tracker.legs = [];

		// Empty old info from state excepting the stuff we might want
		// can't assign empty as then we write out state to temporary object
		// referenced by the input parameter rather than the one passed in...
		for( const removeProp in state ) {
			if( removeProp != 'lastVarioTime' && removeProp != 'lastCheckforStart' ) {
				delete state[removeProp];
			}
		}
		state.compno = tracker.compno;
		state.lastStartTime = tracker.utcstart; 

		state.lastProcessedTime = tracker.utcstart+1;
        // skip to the first point after the start, we don't want to capture that point
        // as it will update pointsByTime and that will change where the scoring line is
        // drawn.
    }

	let t = state?.t || 0;

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
				leg: 1,
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

	// Current progress from state
    let distancedone = state?.distancedone || 0;
    let hdistancedone = state?.hdistancedone || 0;
    let maxdistancedone = state?.maxdistancedone || 0;
	let closesttonext = state?.closesttonext || 99999; // how close to the next tp have we got, only used for last leg

	// Shortcut for readability
    const finishLeg = legs.length-1;

	// Does the database indicate a manual next turnpoint selection?
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

    log( "------------------------------------------------------------" );
    while( p >= 0 && t < legs.length ) {

		// The point before us
		var pprev = p+1;
		var ptime = points[pprev].t;

		// Find what point would be closest
		let nearestSectorPoint = { geometry: {} };

		// Check if the point is in the next turnpoint and save away the closest point on that sector in case we need it
		const _isinsector = checkIsInTP( legs[t], points[p], nearestSectorPoint );

		// Confirm if the point is actually in the sector (distance positive)
		const insector = (_isinsector >= 0);
		
		// If this point is closer to the sector than the last one then save it away so we can
		// check for doglegs
		if( !closesttonext || (!insector  && ((-_isinsector) < closesttonext)) ) {
			closesttonext = -_isinsector;
			nearestSectorPoint.properties.p = p;
			state.closestpointonsector = nearestSectorPoint;
		}
		
        // If we are longer than the leg we are on then we are not on the leg or something odd, assume we
        // are at the beginning of it - this should stop negative numbers.  Note we adjust by r1 only if we are
        // not an AAT.  AATs deal with this differently!  This adjustment is mostly needed for the distance handicapped
        // task
        const curdist = Math.max(-_isinsector,0);
        let advancetp = false;
		let estimatedturn = false;

//        log( ` ${insector?'in sector':'not in sector'} (${t}) @${points[p].t} ${points[p].t - ptime} elapsed, distance ${curdist.toFixed(2)}, closest ${closesttonext.toFixed(2)}` );

        // If we have a point in the sector then we should advance on this
        if( insector ) {	
			// Check for the finish, if it is then only one point counts and we can stop tracking
			if( t == finishLeg ) {
				log( "* found a finish @ " + points[p].t );
				tracker.utcfinish = points[p].t;
				tracker.dbstatus = 'F';
				tracker.finish = timeToText( tracker.utcfinish );
			}
			else {
				log( "* next tp:" + t + "/"+insector );
			}
            advancetp = true;
        }

        // Allow for a dog leg - ie closer and then further
        // most recent two point may be the departure rather than
        // the entry so we need to look back an extra one
		// We need to have a closest point and not be the finish leg (expectation is good coverage
		// of finish area)
        else if ( t !== finishLeg ) { 
			
			// A gap but a closest point is known and check if we could do it
			if( (points[p].t - ptime) > 20 ) {
				
				const interpointDistance =
					distance( points[p].geoJSON, points[pprev].geoJSON );

				// Make sure that they have actually moved between the two points, 300m should be enough
				// as it's a bit more than a thermal circle. This should stop us picking up a jump when
				// they are stationary with a gap
				if( interpointDistance > 0.3 ) {
				
					// How far from previous point, to closest point on sector to current point
					// NOTE: this is closest point from most recent not from previous which is
					//       slightly wrong as you turn a turnpoint on entry not departure
					//       but we are just making sure they could have put a point in the
					//       sector so I'm not sure it matters
					const distanceNeeded =
						length( lineString( [ points[p].geoJSON.geometry.coordinates,
											  nearestSectorPoint.geometry.coordinates,
											  points[pprev].geoJSON.geometry.coordinates ] ));
					
					
					const elapsedTime = points[p].t - points[pprev].t;
					const neededSpeed = distanceNeeded / (elapsedTime / 3600); // kph
					const ld = (points[pprev].a - points[p].a)/distanceNeeded;
					
					// What kind of speeds do we accept?
					// >10 minutes -> 160kph
					// >2  minutes -> 200kph
					// <2  minutes -> 330kph (final glide - should we confirm height loss?)
					// accept 50% higher with current LD for the glide in the 10 to 35 range - perhaps
					// this should be LD to finish but we don't calculate that till end of points as it's around turnpoints...
					const possibleSpeed = (elapsedTime > 600 ? 160 : ((ld > 10 && ld < 35)?1.5:1)*(elapsedTime < 120 ? 330 : 200));
					
					// Make sure we meet the constrants
					if( neededSpeed < possibleSpeed ) {
						log( `* dog leg ${t}, ${distanceNeeded.toFixed(1)} km needed, gap length ${elapsedTime} seconds` +
							 ` could have achieved distance in the time: ${neededSpeed.toFixed(1)} kph < ${possibleSpeed} kph (between ${points[pprev].t} and ${points[p].t}) (ld: ${ld})` );
						state.possibleadvance = {
							elapsedTime: elapsedTime,
							avgSpeed: neededSpeed,
							estimatedturntime: Math.round(((nearestSectorPoint.properties.dist / distanceNeeded) * elapsedTime) + points[pprev].t),
							rewindto: p
						}
					}
					else {
						log( `- no dog log possible ${neededSpeed.toFixed(1)} kph over ${distanceNeeded.toFixed(1)} km (ld: ${ld}) is too fast` );
					}
				}
				else {
					log( `- no dog leg, insufficient distance between previous point and this ${interpointDistance.toFixed(2)} km < 0.3 km`);
				}

				log( 'distance to next tp:', checkIsInTP( legs[t+1], points[p] ));
			}
			
			// Or are they are further away now, 
			if( curdist > (closesttonext + (Math.min(legs[t+1].length*0.10,2))) ) {
				// but the closest point was in the penalty area for the sector
				// this DOES NOT correctly place the change of TP
				if( closesttonext < 0.5 ) {
					advancetp = true;

					// Backtrack to the closest point
					p = state.closestpointonsector.properties.p;
					log( `* penalty volume distance ${closesttonext.toFixed(1)} to tp ${t}, assuming next turnpoint was at ${p}` );
				}
				else if( state.possibleadvance ) {
					log( `* using previously identified dogleg advance for sector, estimating turn @ ${state.possibleadvance.estimatedturntime} and backtracking` );
					// backtrack to immediately after the dogleg so we don't miss new sectors if the gap finishes inside the sector or
					// there is only one point between them
					p = state.possibleadvance.rewindto; 
					advancetp = true;
					estimatedturn = true; // this insert an estimated point based on the dogleg calculations above
				}
			}
		}
		
        // We met a criteria for TP advancement (point in sector, dog leg or penalty volume)
		// so we capture the point and advance our search for the next TP
        if( advancetp ) {
			
            if( t != legs.length-1 ) {
                tracker.scoredpoints.push( [ legs[t].ll.dlong(), legs[t].ll.dlat() ] );
			}
			// If we found a gap then we will retroactively use that to advance the turn
			const turnedat = estimatedturn ? state.possibleadvance.estimatedturntime : points[p].t;
			const duration = (turnedat-tracker.legs[t].time);

			// These are all based on the eg so easy enough to calculate as leg based
			const r = remainingDistance( 0, t+1 );
			const hleg = calcHandicap( legs[t].length, legs[t] );
			tracker.legs[t] = { ...tracker.legs[t],
								leg: t, 
								lat:round(legs[t].ll.dlat(),5), lng:round(legs[t].ll.dlong(),5),
								duration: duration,
								estimatedend: estimatedturn,
								actual: {
									distance: round(legs[t].length,1),
									distancedone: round(task.task.distance - r.remainingdistance,1),
									legspeed: round( legs[t].length / (duration/3600), 1),
									taskspeed: round( (task.task.distance - r.remainingdistance) / ((turnedat-tracker.utcstart)/3600), 1),
								},
								handicapped: {
									distance: round(hleg,1),
									distancedone: round(state.htaskdistance - r.hremainingdistance,1),
									legspeed: round( hleg / (duration/3600), 1 ),
									taskspeed: round( (state.htaskdistance - r.hremainingdistance) / ((turnedat-tracker.utcstart)/3600), 1),
								}
			};

			// Setup for next leg, if we estimated then we don't know altitude so don't capture it
            t++;
			tracker.legs[t] = {
				time: turnedat,
				leg: t,
				estimatedstart: estimatedturn,
				alt: estimatedturn ? undefined : points[p].a,
				agl: estimatedturn ? undefined : points[p].g,
			}
			closesttonext = 99999;
			state.closestpointonsector = undefined;
			state.possibleadvance = undefined;
        }

        p--;
    }

    log( tracker.compno + "* leg t" + t + " length " + legs.length);

    ///////////////////////////////////////////
    // Output the information about how the task is going here
    ///////////////////////////////////////////
    let lasttp = tracker.lasttp || undefined;

    if( t == legs.length ) {
        log( tracker.compno + "* finished" );
        tracker.status = "finished";
		delete tracker.legs[t];

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
        const scoredTo = along( lineString( [legs[lasttp-1].point, legs[lasttp].point] ),
								Math.max(legs[lasttp].length - nextdist,0) );

        tracker.scoredpoints.push( scoredTo.geometry.coordinates );
		// Calculate the leg, to get here we are p < 0
		const distance = legs[t].length-nextdist;
		const hdistance = calcHandicap( distance, legs[t] );
		const duration = points[0].t-tracker.legs[t].time;
		tracker.legs[t] = {
			...tracker.legs[t],
			lat:round(scoredTo.geometry.coordinates[1],5), lng:round(scoredTo.geometry.coordinates[0],5),
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
	state.distancedone = distancedone;
	state.hdistancedone = hdistancedone;
	state.maxdistancedone = maxdistancedone;
	state.closesttonext = closesttonext;
	state.lastProcessedTime = (p>0?points[p]?.t:points[0]?.t)||0;
	state.t = lasttp;
//	console.log( tracker.compno, state );
}


function round(n,e) {
	const p = Math.pow(10,e);
	return Math.round( n * p )/p;
}

