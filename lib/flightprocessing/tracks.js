
import _foreachright  from 'lodash.foreachright'

import { mergePoint } from './incremental.mjs';

const historyLength = 600;
const gapLength = 300;

//
// Generate GeoJSON tracks, full and partial and markers for the class specified in data
export function generateGeoJSONs( data, tOffset )
{
	_foreachright( data.points, (ppoints) => {
		_foreachright( ppoints, (p,i) => mergePoint( p, data, i==0 ))
	});
}
