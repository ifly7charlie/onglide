/*
 *
 * This will return a GeoJSON object for the task with taskid specified
 *
 */

import { query } from '../../../lib/react/db';
import escape from 'sql-template-strings';

// Helpers to deal with sectors and tasks etc.
import { preprocessSector, sectorGeoJSON } from '../../../lib/flightprocessing/taskhelper.js';

import bbox from '@turf/bbox';

import _reduce from 'lodash/reduce'

import { useRouter } from 'next/router'

export default async function taskHandler( req, res) {
    const {
        query: { className },
    } = req;

    if( !className ) {
        console.log( "no class" );
        res.status(404).json({error: "missing parameter(s)"});
        return;
    }

    let task = await query(escape`
      SELECT tasks.*
      FROM tasks, compstatus cs
      WHERE cs.class = ${className} AND tasks.class = cs.class
        AND cs.datecode = tasks.datecode AND tasks.flown = 'Y'
    `);

    if( ! task.length || ! task[0].taskid ) {
        console.log( task );
        res.status(404)
            .json({tp:'', track:''});
        return;
    }

    let tasklegs = await query(escape`
      SELECT taskleg.*, nname name, 0 altitude
      FROM taskleg
      WHERE taskleg.taskid = ${task[0].taskid}
      ORDER BY legno
    `);

    // Get the legs ready for handling
    tasklegs.forEach( (leg) => { preprocessSector(leg) } );

    // Prep names and look for duplicates
    let names = {};
    tasklegs[0].text = 'S'; tasklegs[tasklegs.length-1].text = 'F';
    tasklegs.map( (leg) => { if( !leg.text ) {leg.text = leg.legno; }
                             const n = leg.text;
                             if( ! names[leg.trigraph] ) {
                                 names[leg.trigraph] = { point: leg.point, name: n }
                             } else {
                                 names[leg.trigraph].name += '_' + n;
                             }
                           });

    // Check distances (not used at present)
    //    const taskLength = calculateTaskLength( tasklegs );

    // Now calculate the objects, they get added to each turnpoint
    tasklegs.forEach( (leg) => { sectorGeoJSON( tasklegs, leg.legno ) });


    let geoJSON = {
        type: 'FeatureCollection',
        features: []
    };

    tasklegs.forEach( (leg) => { geoJSON.features = [].concat( geoJSON.features,
															   [{ type: 'Feature',
																  properties: { leg: leg.legno },
																  geometry: leg.geoJSON }] ) } );

	let trackLineGeoJSON = {
		type: 'FeatureCollection',
		features: []
	};
	
	trackLineGeoJSON.features =
		_reduce( tasklegs, (accumulate,leg,index) => { if( index+1 < tasklegs.length ) {
			accumulate.push(
				{type:"Feature",
				 properties: { leg: leg.legno+1 },
				 geometry: {
					 type: "LineString",
					 coordinates: [[ leg.ll.dlong(), leg.ll.dlat() ],[ tasklegs[index+1].ll.dlong(), tasklegs[index+1].ll.dlat()]]
				 }
				});
		}
			return accumulate;
		}, []);

    // How long should it be cached
    res.setHeader('Cache-Control','max-age=600');

    // And we succeeded - here is the json
    res.status(200)
        .json({tp:geoJSON, track:trackLineGeoJSON});
}
