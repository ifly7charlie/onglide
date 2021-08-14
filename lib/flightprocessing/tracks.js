
import _foreachright  from 'lodash.foreachright'

import { mergePoint } from './incremental.mjs';

const historyLength = 600;
const gapLength = 300;

//
// Generate GeoJSON tracks, full and partial and markers for the class specified in data
export function generateGeoJSONs( data, tOffset )
{
	// Zap it as we are making new ones
	data.geoJSON = { tracks:{}, fulltracks:{}, locations:{} };
	data.deck = {};

	// And then loop through all the pilots, and then from oldest to newest their points
	_foreachright( data.points, (ppoints,cn) => {
		_foreachright( ppoints, (p,i) => mergePoint( p, data, i==0 ))
	});
}
