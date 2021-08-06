
const tDistance = (require( '@turf/distance' )).default;
const tBearing = (require( '@turf/bearing' )).default;
import _clonedeep from 'lodash.clonedeep';
import _foreach from 'lodash.foreach';


//
// this script will process an IGC file, and determine statistics on it
// initial version will have no concept of anything other than the flight
// it needs to have a start and end time provided (will extract from the
// database based on the compno & day)
//
// this will also (at the same time... emit the XML necessary to do snail trails)
//

// Wind calculation concept from: https://github.com/kflog-project/Cumulus/
// simplified and tweaked to work with OGN data

const tolerances = 3;
const MINCIRCLEDEGREES = [60,90,220];    // in degrees, last turn > MINCD to trigger thermal
const MINSTRAIGHTDISTANCE = [0.4,0.7,1.5]; // in KM, shortest acceptable straight, normal thermal is .1 to .3 wide so leave a bit of width for recentering
const MINSTRAIGHTTIME = [10,15,22];      // need to go straight for 22 seconds for it to count (normal thermal turn is about 20)
const MINSTRAIGHTRATIO = 0.7;    // 70% of the end/end distance for per point distance

const toffset = 0;//-7200;//17M,IZ:1626950127; //17M,ZR:1626950990; //17M,BR:1626949467;

let log = () => {}

function twoffset(d) {
	const nd = new Date((d-toffset)*1000);
	return nd.toISOString().substring(11,11+8);
}

function printStateStack(stack, log) {
	stack.forEach( (now,index) => {
		const elapsed = now.lasttime - now.time;
		log( `${now.state}  ${twoffset(now.time)} ${now.time}-${now.lasttime} ${now.alt}m   ${elapsed}s  ${now.turncount.toFixed(0)} ${now.distance.toFixed(2)}km vs ${tDistance(now.geoJSON,stack[index+1]?.geoJSON||now.geoJSON,{ units: 'kilometers' }).toFixed(2)}km  +${now.heightgain-now.heightloss}m (${((now.heightgain-now.heightloss)/elapsed).toFixed(1)} m/s) [td:${now.direction}] ${(now.maxdelay/elapsed).toFixed(1)}% ${(elapsed/now.packets).toFixed(0)}sec/pkts` );
		if( now?.wind?.speed ) {
			log( `    wind: ${now.wind.direction.toFixed(0)}, ${now.wind.speed.toFixed(0)} kph` );
		}
	});
}

////////////////////////////////////////////////////////////////////
//
// Process a tracker and it's points to generate flight statistics
//
////////////////////////////////////////////////////////////////////
export default function generateStatistics( tracker, state, points ) {

	const compno = tracker.compno;

	if( ! points || ! tracker.utcstart ) {
		return;
	}

	if( tracker.compno == (process.env.NEXT_PUBLIC_COMPNO||'') ) {
		log = function() { console.log(tracker.compno, ...arguments );} 
	}
	else {
		log = function () {};
	}


	// empty any previous states
	let state_stack = [];

	log( tracker.firstOldPoint );
	if( tracker.firstOldPoint == undefined ) {
		log( "no new points, ignoring" );
		return;
	}
	
	// skip all points before the 60s before the start as we don't care about them
	// was 120 in perl
	// also resume from where we left off
    let p = Math.min( tracker.firstOldPoint == undefined ? (points.length-2) : tracker.firstOldPoint, points.length-2 );
    while( p >= 0 && points[p].t < tracker.utcstart ) {
        p--;
	}

	if( p < 0 ) {
		log( "no points found" );
		return undefined;
	}
	log( "p.t:", points[p].t );
	
	if( state?.stats?.state?.lasttime == points[p].t ) {
		log( "last point already processed" );
		return undefined;
	}

	// If we don't have a state then we need to initialise one
	if( ! state.stats ) {
		state.stats = {
			stack: [],
			state: {
				geoJSON: points[p+1].geoJSON,
				previousbearing: 0,
				lasttime: points[p+1].t,
				mode: 'start',
				alt: points[p+1].a,
			},
		};
	}

	// make sure the time is off the even minute for everybody... won't
	// matter as we interpolate results
	log( `starting at ${points[p].t} [${p}/${points.length}] after using ${tracker.utcstart} and ${state.stats.state.lasttime} to skip` );
	while( p >= 0 && (tracker.utcfinish == undefined || points[p].t < tracker.utcfinish)) {

		if( points[p].t - state.stats.state.lasttime > 30 ) {
			log( `warning for stats as gap too long ${points[p].t - state.stats.state.lasttime}s` );
		}
		
		// finaly we need to add records for each step in time
		addPoint( state.stats.stack, state.stats.state, points[p], false );

		// So we don't have to reprocess everything
		p--;
	}

	if( p >= 0 ) {
		addPoint( state.stats.stack, state.stats.state, points[p], true );
	}

	function normalizeAngle(a) {
		return  a < 0 ? a+360 : (a >= 360 ? a-360 : a);
	}



	printStateStack( state.stats.stack, log );
	log("------------------------");

	// zap anything we don't need any longer, not done iteratively like the previous step
	const stack = coalesceStack(state.stats.stack);
	log("------------------------");

	if( ! stack.length ) {
		log( "no state stack generated" );
	}

	// Lets do wind stuff before coalescing just to see
	stack.forEach( (now,index) => {
		let windspeed = undefined;
		if( now.state == 'thermal' ) {
			now.wind = {};
			now.ws.history.forEach( (circle) => {
				// This calculates the math confirming that the wind is within a valid range
				// and recording it if it is
				const angleDifference = Math.abs(((circle.max.angle-circle.min.angle) + 180) % 360 - 180);
				const quality = 5 - (Math.abs(180 - angleDifference))/8;
				const maxAngleInverted = (circle.max.angle+180)%360;
				const absAngleDifference = Math.abs(maxAngleInverted-circle.min.angle);
				const [ bisector, base ] = absAngleDifference > 180 ? [(360 - absAngleDifference)/2,circle.min.angle] :
																[absAngleDifference/2,maxAngleInverted];
				const windAngle = normalizeAngle(maxAngleInverted <= circle.min.angle ? base + bisector : base - bisector);
				const windSpeed = (circle.max.speed - circle.min.speed)/2;
				if( quality >= 3 && quality <= 5 ) {
					now.wind.speed = ((now.wind?.speed||windSpeed) + windSpeed)/2;
					now.wind.direction = ((now.wind?.direction||windAngle) + windAngle)/2;
				}
			});
		}
	});

	state.stats.stack = stack;

	// when we finish we need to dump the statestack
	printStateStack( stack, log );
}



//
// State machine for processing glider states
function addPoint( state_stack, state, point, lastpoint ) {


	function mergeTop() {
		let nxt = state_stack[ state_stack.length-2 ];
		const existing = state_stack.pop();
		nxt.heightgain += existing.heightgain;
		nxt.heightloss += existing.heightloss;
		nxt.distance += existing.distance;
		nxt.lasttime = existing.lasttime;
//		nxt.geoJSON = existing.geoJSON;
		// To count as mixed it needs to be more than a full turn total
		if( (Math.abs(existing.turncount)+Math.abs(nxt.turncount)) > 360 ) {
			if( Math.sign(nxt.turncount) != Math.sign(existing.turncount) ) {
				nxt.mixedthermal++;
			}
			// In this case we count total turns
			nxt.turncount = (Math.abs(existing.turncount)+Math.abs(nxt.turncount)) * Math.sign(nxt.direction||existing.direction);
		}
		else {
			// If it is less then they can cancel if in opposite directions??
			nxt.turncount += existing.turncount;
		}
		
		nxt.ws.history.push( ...existing.ws.history );
		nxt.mixedthermal += existing.mixedthermal;
		nxt.direction += existing.direction;
		nxt.packets += existing.packets;
		nxt.maxdelay = Math.max(nxt.maxdelay,existing.maxdelay);
		nxt.points = nxt.points.concat( existing.points );
		log( ` --> ${twoffset(existing.time)} added to ${twoffset(nxt.time)}` );
	}
	 
	//
	// change state will check the previous item in the stack to make sure it qualifies
	// if it does then it leaves
	// otherwise it will pop it and not push a new state (as the previous one must be
	// the same type)
	function changeState( newmode, current ) {
		current.state = newmode;
		state.mode = newmode;
		
		let top = state_stack[ state_stack.length-1 ];
		let prev = state_stack[ state_stack.length-2 ];
		if( top && prev && prev.state == newmode ) {
			if( newmode == 'thermal' && top.state == 'straight' && (top.lasttime - top.time) < 20 ) {
				log( `short straight, dropping ${twoffset(top.time)} and joining to ${twoffset(prev.time)}` );
				mergeTop();
				state_stack.push( current );
				mergeTop();
				return;
			}
		}
		state_stack.push( current );
	}

	// how many seconds have elapsed
	const timedif = point.t - state.lasttime;
	log( `${timedif}, ${state.lasttime}` );

	function bAvg( bearing ) {
//		const maxAvgTime = 5; // seconds
//		const multiplier = Math.max(1-((state.b?timedif:maxAvgTime)/maxAvgTime),0);
		//		return state.b = ((state.b||0)*multiplier)+((1-multiplier)*bearing);
		state.b = bearing;
		return  state.pa = ((state.b||bearing) + bearing)/2;
	}

	// how much did the bearing change (+/-) we normalize to 360 as old code did that, may be
	// unneeded as check below changes values
	// use the bearing and speed from OGN if it's there as it's more accurate than the
	// ones we calculate
	const bearing = ((point.b||tBearing( state.geoJSON, point.geoJSON ))+360)%360;
	const distance = tDistance( state.geoJSON, point.geoJSON, { units: 'kilometers' } );
	const speed = point.s||(3600*distance/timedif); //(kph)
	
	let bearingchange = (bearing - (state.previousbearing)) % 360;

	if( Math.abs(bearingchange) > 210 ) {
		bearingchange = (360-Math.abs(bearingchange))%360;
	}

	// Complete change
	const obearingchange = bearingchange;

	// adjust so it's time relative in case we are missing points
	// also we wil average to help smooth out thermals, average
	// only used in thermals but always calculated
	bearingchange = bearingchange/timedif;

	if( state.mode == 'thermal' ) {
		if( timedif > 5 && timedif < 20 &&
			Math.round((((state.pa||0) * timedif + state.previousbearing) % 360)/10) == Math.round(bearing/10) ) {
			log( ` -> forecast bearing at previous rate of turn is close enough assuming this` );
			bearingchange = state.pa;
		}
		else {
			bearingchange = bAvg( bearingchange );
		}
	}
	
	let tdirection = 0;
	// check for increasing or decreasing
	if( bearingchange > 2 ) {
		tdirection = 1;
	} else if( bearingchange < -2 ) {
		tdirection = -1;
	}

	log( `${point.t}/${twoffset(point.t)}/: ${timedif} cur:${state.mode} bearing: ${Math.round(bearing)} ${Math.round(bearingchange)} speed ${speed.toFixed(2)}` );

	function emptyWs(starttime,history) { 
		return { min: { speed: 999999 }, max: { speed: 0 }, cumulative: 0, packets: 0, time:starttime, history: history||[]  }
	};
	
	// this will get pushed into the stack, and updated as things go on... ie, we always update the
	// top one... it will be checked to see if it's valid and if not then discarded
	let current = { geoJSON: point.geoJSON,
					alt: point.a,
					time: point.t,
					lasttime: point.t,
					turncount: 0,
					distance: 0, heightgain : 0, heightloss : 0,
					packets:0, maxdelay:0, mixed: false,
					ws: emptyWs(point.t),
					direction: tdirection, points: [point.geoJSON] };

	// If it's a big gap then we ditch the info from the last section
	// gaps don't get consolidated, but we will switch before the accumulate
	// so the accumulation ends up on our state
	// it will auto switch back to 'start' so next point will start the correct
	// new state
	if( timedif > 60 ) {
		let stackEnd = state_stack.length > 0 ? state_stack[ state_stack.length-1 ] : undefined;
		if( stackEnd && stackEnd.time == stackEnd.lasttime ) {
			stackEnd.state = 'gap';
		}
		else {
			if( stackEnd ) {
				current.time = stackEnd.lasttime;
			}
			changeState( "gap", current );
		}
	}
	// if we have a previous state we need to add the deltas we have just calculated to it
	let stackEnd = state_stack[ state_stack.length-1 ];
	if( stackEnd ) {
		stackEnd.distance += distance;			
		if( point.a > state.alt ) {
			stackEnd.heightgain += (point.a - state.alt);
		} else {
			stackEnd.heightloss += (state.alt - point.a);
		}
		stackEnd.turncount += obearingchange;//Math.abs(bearingchange);
		stackEnd.lasttime = point.t;
		stackEnd.direction += tdirection;
		stackEnd.packets++;
		stackEnd.maxdelay = Math.max(stackEnd.maxdelay,timedif);
		stackEnd.points.push(point.geoJSON);

		// Wind speed calculations are pretty easy, we just need
		// to know the bearing and speed of the fastest and slowest
		// segment in the thermal. Assuming they are 180 degrees apart
		// then the difference is twice the windspeed and the slowest
		// bearing is the direction most into wind
		if( speed < stackEnd.ws.min.speed ) {
			stackEnd.ws.min = { speed: speed, angle: bearing };
		}
		if( speed > stackEnd.ws.max.speed ) {
			stackEnd.ws.max = { speed: speed, angle: bearing };
		}
		stackEnd.ws.cumulative += obearingchange;
		stackEnd.ws.packets++;
		if( stackEnd.ws.cumulative < -361 || stackEnd.ws.cumulative > 361 ) {
			stackEnd.ws.history.push( {min: _clonedeep(stackEnd.ws.min), max: _clonedeep(stackEnd.ws.max),
									   cumulative: stackEnd.ws.cumulative, packets: stackEnd.ws.packets, endAltitude: point.a, startTime: twoffset(stackEnd.ws.time)} );
			stackEnd.ws = emptyWs( point.t, stackEnd.ws.history );
		}
	}


	//
	// state machine logic
	if( lastpoint ) {
		changeState( "end", current );
	}
	else if( state.mode == "start" ) {
		// fairly good indicator we may be in a thermal
		if( Math.abs(bearingchange) > 360/60 ) {
			changeState( "thermal", current );
		}
		else {
			changeState( "straight", current );
		}
	}
	else if( state.mode == "straight" ) {
		// we need to keep looking for a constantly altering deviation > 45 seconds

		// fairly good indicator we may be entering a thermal
		if( Math.abs(bearingchange) > 360/60 ) {
			changeState( "thermal", current );
		}
	}
	else if( state.mode == "thermal" ) {

		// if we haven't turned by enough then we try being a straight again
		if( Math.abs(bearingchange) < 15/4 )	{
			changeState( "straight", current );			
		}
		
	}
	else if(state.mode == 'gap' ) {
		state.mode = 'start';
	}
	
	

	// used to calculate bearings
	state.geoJSON = point.geoJSON;
	state.alt = point.a;
	state.previousbearing = bearing;
	state.lasttime = point.t;
}

//
// go through all the entries on the stack and determine if they should
// actually be there
//
// logic: 1) remove short straights as they are likely to simply be thermal adjustments
//        2) remove short thermals as they are likely to be course adjustments or tps
//
function coalesceStack( source_state_stack ) {

	function logState(current,action,dist) {log( `${current.time} (${twoffset(current.time)}): ${action} ${current.state} ${current.alt}m   ${current.lasttime - current.time}s  ${Math.round(current.turncount)} ${Math.round(current.distance*10)/10}km  +${current.heightgain-current.heightloss}m [${current.direction}] =${dist||''}` ); };


	// We are going to tweak this so make a deep copy to return
	let state_stack = _clonedeep( source_state_stack );
	let adjustments = false;
	let tolerance = 0;
	
	// go through the stack and check the lengths of each straight segment
	// if it isn't long enough then zap it... DUMMY landing in the stack at the
	// end just in case
	do {

		adjustments = false;
		log("***");

		function merge( current, nxt, i,dist ) {
			nxt.heightgain += current.heightgain;
			nxt.heightloss += current.heightloss;
			nxt.distance += current.distance;
			nxt.time = current.time;
			nxt.geoJSON = current.geoJSON;
			// To count as mixed it needs to be more than a full turn total
			if( (Math.abs(current.turncount)+Math.abs(nxt.turncount)) > 360 ) {
				if( Math.sign(nxt.turncount) != Math.sign(current.turncount) ) {
					nxt.mixedthermal++;
				}
				// In this case we count total turns
				nxt.turncount = (Math.abs(current.turncount)+Math.abs(nxt.turncount)) * Math.sign(nxt.direction||current.direction);
			}
			else {
				// If it is less then they can cancel if in opposite directions??
				nxt.turncount += current.turncount;
			}

			nxt.ws.history.push( ...current.ws.history );
			nxt.mixedthermal += current.mixedthermal;
			nxt.direction += current.direction;
			nxt.packets += current.packets;
			nxt.maxdelay = Math.max(nxt.maxdelay,current.maxdelay);
			nxt.points = current.points.concat( nxt.points );
			
			// zap it, and the item afterwads as well as we're actually still in the preceeding straight ;)
			state_stack.splice( i, 1 );
			adjustments = true;
			log( `${current.time} (${twoffset(current.time)}): push ${current.state} forwards into ${nxt.state} bearing: ${current.turncount.toFixed(0)}=>${nxt.turncount.toFixed(0)} (d:${current.distance.toFixed(1)}km =>${nxt.distance.toFixed(1)}km), ${current.direction}/${nxt.direction} =${dist||''}`);
			log( ` ws -> ${nxt.ws.history.length} ` );
		}

		log( `tolerances: ${tolerance} [MinStraightTime:${MINSTRAIGHTTIME[tolerance]}, MinStraightdDistance:${MINSTRAIGHTDISTANCE[tolerance]}] [MinCircleDegrees:${MINCIRCLEDEGREES[tolerance]}]`);

		// Two passes, one remove short straights as they can occur in middle of thermals
		// then remove short thermals in straights
		for( let i = 0; i < state_stack.length-1;)
		{
			const current = state_stack[ i ];		
			let nxt = state_stack[ i+1 ];

			// We can never pull forward a state other than a gap into a gap
			// so the following 'elses' won't apply
			if( nxt.state == 'gap' ) {
				if( current.state == 'gap' ) {
					merge( current, nxt, i );
					continue;
				}
			}
			else if( current.state == 'straight' )
			{
				// if must be a straight if we are switching to a thermal
				// does it qualify?
				// NOTE: this is from start of us to start of next, the distance in the state
				//       is between the points
				const dist = tDistance( nxt.geoJSON, current.geoJSON, { units: 'kilometers' } );
				const elapsed = nxt.time - current.time;

				if( nxt.state == current.state ||
					(elapsed < MINSTRAIGHTTIME[tolerance] && dist < MINSTRAIGHTDISTANCE[tolerance]) )
				{
					merge( current, nxt, i, dist );
					if( i > 1 ) { // we should re-evaluate the previous state, why only for straights??
						i--;
					}
					continue;
				}
				logState(current,'keep',dist);
			}
			else if( current.state == "thermal" )
			{
				// if it's too short then oops, it's gone :)
				if( Math.abs(current.turncount) < MINCIRCLEDEGREES[tolerance] || (nxt.time - current.time) < 6 || nxt.state == current.state )
				{
					merge( current, nxt, i );
					continue;
				}
				logState(current,'keep');
			}
			else {
				logState(current,'skip');
			}
			i++;
		}

		if( tolerance < tolerances-1 ) {
			tolerance++
		}
		
	} while( adjustments );
	
	return state_stack;
}
