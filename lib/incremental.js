
const _find  = require('lodash.find')
const _foreach = require('lodash.foreach')

import { gapLength, maxPoints, maxSegments } from './constants.js';

// Helper fro resizing TypedArrays so we don't end up with them being huge
function resize( a, b ) {
	let c = new a.constructor( b );
	c.set( a );
	return c;
}

//
//
// This merges the point into all the associated GeoJSON and Scoring metadata
// used on both client and server
//
function mergePoint( point, data )
{
    const compno = point.c;
	
	if( ! data.trackData?.[compno] ) {
		if( ! data.trackData ) { data.trackData = {} };
		data.trackData[compno] = { compno: compno,
								   positions: new Float32Array(maxPoints*3),
								   indices: new Uint32Array(maxSegments),
								   agl: new Int16Array(maxPoints),
								   t: new Uint32Array(maxPoints),
								   recentIndices: new Uint32Array(2),
								   climbRate: new Int8Array(maxPoints),
								   posIndex: 0, segmentIndex: 0 };
	}

	// Now we will work with this data
	const deck = data.trackData[compno];

	if( deck.posIndex >= deck.t.length ) {
		const newLength = deck.posIndex + maxPoints;
		deck.positions = resize( deck.positions, newLength*3 );
		deck.t = resize( deck.t, newLength );
		deck.agl = resize( deck.agl, newLength );
		deck.climbRate = resize( deck.climbRate, newLength );
	}

	if( deck.segmentIndex+2 >= deck.indices.length ) {
		deck.indices = resize( deck.indices, ( deck.segmentIndex + maxSegments ));
	}


	// Set the new positions
	function pushPoint( lng, lat, a, g, t ) {
		deck.positions.set( [lng, lat, a], deck.posIndex*3 );
		deck.t[deck.posIndex] = t;
		deck.agl[deck.posIndex] = g;
//		deck.colours.set( [ 64, 64, 64 ], deck.posIndex*3 );
		deck.posIndex++;
		// Also the indicies array needs to be terminated
		deck.indices[ deck.segmentIndex ] = deck.posIndex;
	}	

	// Start the first segment
	if( deck.posIndex == 0 ) {
		deck.indices[ deck.segmentIndex++ ] = 0;
	}
	else {
		const lastTime = deck.t[deck.posIndex-1];

		// If we already have a point at this time then we will skip this one, this can
		// happen when points are buffered to be sent but a full binary track has just been
		// sent. We can't dump the buffered points as only new client will receive that
		if( point.t == lastTime ) {
			return;
		}
		
		// If the gap is too long then we need to start the next segment as well
		if( point.t - lastTime > gapLength ) {

			// If we have only one point in the previous segment then we should duplicate it
			const previousSegmentStart = deck.indices[deck.segmentIndex-1];
			if( previousSegmentStart == deck.posIndex ) {
				
				// add it to the previous segment so there are two points in it, it's not a line
				// without two points
				pushPoint( ... deck.positions.subarray( previousSegmentStart * 3, (previousSegmentStart+1)*3 ),
						   deck.agl[ previousSegmentStart ], deck.t[ previousSegmentStart ] );
			}

			// Start a new segment, on the next point (which has not yet been pushed)
			deck.segmentIndex++;
		}
		else {
			deck.climbRate[ deck.posIndex ] = Math.trunc( (point.a - deck.positions[(deck.posIndex-1)*3+2])/(point.t-lastTime) );
		}
	}

	// Push the new point into the data array
	pushPoint( point.lng, point.lat, point.a, point.g, point.t );

	// Generate the recent track for the glider
	let recentOldest = deck.recentIndices[0];
	while( point.t - deck.t[ recentOldest ] > gapLength && recentOldest < deck.posIndex ) {
		recentOldest++;
	}
	deck.recentIndices[0] = recentOldest;
	deck.recentIndices[1] = deck.posIndex;

	// Update the altitude and height AGL for the pilot
    // Mutate the vario and altitude back into SWR
    const cp = data.pilots[compno];
	if( cp ) {
		cp.altitude = point.a;
		cp.agl = point.g;
		cp.lat = point.lat;
		cp.lng = point.lng;
		
		var min, max;
		
		[ cp.lossXsecond,
		  cp.gainXsecond,
		  cp.total,
		  cp.average,
		  cp.Xperiod,
		  min,
		  max ] =  point.v.split(',');
		
		cp.min = Math.min(min,cp.min);
		cp.max = Math.max(max,cp.max);
	}
	return true;
}

module.exports.mergePoint = mergePoint;
