/* this is from original site, being taken to pieces */
/* Copyright(c)2007-2020, Melissa Jenkins.  All rights reserved */

import LatLong from './LatLong.js';

import { preprocessSector, sectorGeoJSON } from './taskhelper.js';
import scoreSpeedTask from './scorespeedtask.js'

import _clonedeep from 'lodash.clonedeep'
import _foreach from 'lodash.foreach';
import _zipobject from 'lodash.zipobject';

export default function scoreEglideTask( task, tracker, state, points, highesthandicap ) {

    // We need to adjust the task to have the correct characteristics for the current pilots
    // handicap
    let newTask = adjustTask( task, state, tracker.handicap, highesthandicap );

    // we can't clone functions, or load them from the cache so we need to repopulate
    // the one in scoreTask doesn't do it because the cache stores our adjustments
    newTask.legs.forEach( (leg) => preprocessSector(leg) );
    newTask.legs.forEach( (leg) => { sectorGeoJSON( newTask.legs, leg.legno ) });

	let geoJSON = {
        type: 'FeatureCollection',
        features: []
    };

	console.log( task );
	
    newTask.legs.forEach( (leg) => { geoJSON.features = [].concat( geoJSON.features,
																   [{ type: 'Feature',
																	  properties: { leg: leg.legno },
																	  geometry: leg.geoJSON }] ) } );

	newTask.geoJSON = JSON.stringify(geoJSON);

	// Once that is done it's normal scoring
    scoreSpeedTask( newTask, tracker, state, points );

	// Capture an alternative task for the pilot
	tracker.task = newTask.geoJSON; 
}


// Make a copy of the task reduced for the specified handicap
function adjustTask( task, state, handicap, highesthandicap ) {
	
    // pilot specific adjustments
    if( state.adjustments ) {
        return state.adjustments;
    }

	// If nothing from scoring then we don't know what to do so do nothing
	if( ! task.contestday.notes ) {
		console.log( "no contest notes" );
		return task;
	}
	
    // Make a new array for it
    var newTask = state.adjustments = _clonedeep(task);

	// I don't think this is needed as should be right in the task already...
	// DOESN
	const [,fixedTps,fixedRadius] = task.contestday.notes.match(/TP([0-9,]*) radius: ([0-9]+)m/mi)||[undefined,undefined];
	if( fixedTps && fixedRadius ) {
		_foreach( (fixedTps+",").split(','), (p) => {
			if( p ) {
				newTask.legs[p].r1 = parseFloat(fixedRadius)/1000;
			}
		});
	}

	let hcapAdjustments = {};
	const [,handicappedTps] = task.contestday.notes.match(/TP([0-9,]+)\sRadius\sin\smeters/im)||[undefined,undefined];
	if( handicappedTps ) {
		const [,hcapsS] = task.contestday.notes.match( /^hcap([^\r\n]*)/mi )||[undefined,undefined];
		const [,radiusS] = task.contestday.notes.match( /^radius([^\r\n]*)/mi )||[undefined,undefined];

		let hcaps = [], radius = [];
		if( hcapsS && radiusS ) {
			hcaps = hcapsS.split('│');
			radius = radiusS.split('│');
		}
		// Convert to km and remove noise
		_foreach( radius, (v,i) => { radius[i] = parseFloat(v)/1000 });
		_foreach( hcaps, (v,i) => { hcaps[i] = v.trim() });
		
			// Then make into a stucture we can use
		hcapAdjustments = _zipobject( hcaps, radius );
		if( Object.keys(hcapAdjustments).length == 0 ) {
			console.error( "no handicap adjustments found in notes" );
			return task;
		}
	}

	let R_hcap = 0.500;
	if( hcapAdjustments[handicap] ) {
		R_hcap = hcapAdjustments[handicap];
	}
	else {
		console.warn( `no handicap adjustment found for ${handicap}`, hcapAdjustments );
		return;
	}
	
	console.log( `adjustEglideTask ${handicap} -> ${R_hcap}` );

    // Now copy over the points reducing all symmetric
	_foreach( (handicappedTps?.split(',')||[]), (i) => {
		newTask.legs[i].r1 = R_hcap;
		newTask.legs[i].length -= (i > 0 && i < (newTask.legs.length-1)) ? R_hcap : (R_hcap*2);
	});

	newTask.distance = 0;
	_foreach( newTask.legs, (leg) => {
		newTask.distance += leg.length;
    });

    // For scoring this handicap we need to adjust our task distance as well
    return newTask;
}
