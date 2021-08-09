/*
 *
 * This will return a GeoJSON object for the task with taskid specified
 *
 */

const db = require('../../../lib/react/db')
const escape = require('sql-template-strings')

import { useRouter } from 'next/router'
import _foreach  from 'lodash.foreach'

import scoreTask from './scoreTask.js';

import { useKVs } from '../../../lib/kv.js';
let kvs = useKVs();

const historyLength = 600;

export default async function taskHandler( req, res ) {
    const {
        query: { className },
    } = req;

    if( !className ) {
        console.log( "no className" );
        res.status(404).json({error: "missing parameter(s)"});
        return;
    }

	console.log( "pilotsGeoTrack,js" );

	let { previousPoints } = (kvs.get(`${className}_scoring`)) || { trackers: {}, state: {}, previousPoints: {}};
    if( ! Object.keys(previousPoints).length ) {
		await scoreTask(req);
		previousPoints = ((kvs.get(`${className}_scoring`)) || { trackers: {}, state: {}, previousPoints: {}}).previousPoints;
	}

	let resultJSON = {
	};

	_foreach( previousPoints, (ppoints,compno) => {
		resultJSON[compno] = {
			"type": "FeatureCollection",
			"features": []
		};
		let tLastPoint = 0;
		let lastSegment = []; // array of points
		let trackJSON = resultJSON[compno];
		
        _foreach( ppoints, (p) => {
			// If there is a gap (seconds)
			if( tLastPoint - p.t > 300 ) {
				
				// If we only had one point then we will make it into a segment
				// by duplicating the point
				if( lastSegment.length == 1 ) {
					lastSegment.push([lastSegment[0][0]+0.0005,lastSegment[0][1]+0.0005]);
				}
				
				// Add to the list
				trackJSON.features.push(
					{ 'type': 'Feature',
					  'properties': {},
					  'geometry': {
						  "type": "LineString",
						  "coordinates": lastSegment
					  }
					}
				);
				lastSegment = [];
			}
			
			// Add the point and save the time
			lastSegment.push( [p.lng,p.lat] );
			tLastPoint = p.t;
		});
			
		// Catch the trailing segment
		if( lastSegment.length > 1 ) {
			trackJSON.features.push(
				{ 'type': 'Feature',
				  'properties': {},
				  'geometry': {
					  "type": "LineString",
					  "coordinates": lastSegment
				  }
				}
			);
		}
	});

    res.setHeader('Cache-Control','no-cache');
    res.status(200)
	   .json({fulltracks:resultJSON});

	console.log( resultJSON );
}
