
import _foreachright  from 'lodash.foreachright'

import { mergePoint } from './incremental.mjs';

import {
    setTimeout,
} from 'timers/promises';

//
// Generate tracks, full and partial and markers for the class specified in data
export async function generatePilotTracks( data, tOffset )
{
	// Zap it as we are making new ones
	data.deck = {};

	const start = process.hrtime();

	// And then loop through all the pilots, and then from oldest to newest their points
	_foreachright( data.points, (ppoints,cn) => {
		_foreachright( ppoints, (p,i) => mergePoint( p, data, i==0 ))
	});

	const duration = process.hrtime(start);
	console.log( `generatePilotTracks ${(duration[0] * 1000 + duration[1] / 1000000).toFixed(0)} ms`);
}
