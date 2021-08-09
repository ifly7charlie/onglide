/*
 *
 * This will return a GeoJSON object for the task with taskid specified
 *
 */

import { query } from '../../../lib/react/db';
import escape from 'sql-template-strings';

import { useRouter } from 'next/router'
import _groupby  from 'lodash.groupby'
import _mapvalues  from 'lodash.mapvalues'

// How far back in time to do we want to show
const historyLength = 600;
const gapLength = 300;

export default async function geoTracks( req, res) {
    const {
        query: { className },
    } = req;

    if( !className ) {
        console.log( "no className" );
        res.status(404).json({error: "missing parameter(s)"});
        return;
    }
	
	const datecode = (await query(escape`
      SELECT datecode
      FROM compstatus cs
      WHERE cs.class = ${className}
    `))[0].datecode;

	if( ! datecode ) {
		console.log( `can't find datecode for ${className}` );
        res.status(404).json({error: "class not configured correctly"});
		return;
	}

	// And see if we have an adjustment, also used to establish 0 point for coordinates
	let tOffset = parseInt(process.env.NEXT_PUBLIC_TOFFSET)||0;
	if( tOffset <= 0 ) { tOffset += (Date.now())/1000 };
	
    // Get the points, last
    let points = await query(escape`
            SELECT tp.compno, lat, lng, t, altitude a, agl g FROM trackpoints tp
             WHERE t > ${tOffset-historyLength} AND t < ${tOffset} AND tp.datecode=${datecode} AND tp.class=${className}
             ORDER by t DESC `);

    // Group them by comp number, this is quicker than multiple sub queries from the DB
    const grouped = _groupby( points, 'compno' );

    const collection = _mapvalues( grouped, (points) => {
	if( points.length > 1 ) {
	    const pilotGeoJSON = {
		'type': 'LineString',
		'properties': { 'c': points[0].compno, 't': points[0].t },
		'coordinates': points.map( (p) => { return [ p.lng, p.lat ]; } ) ,
	    };   
	    return pilotGeoJSON;
	    //geoJSON.features = [].concat( geoJSON.features, [{ 'type': 'Feature', properties: {}, geometry: pilotGeoJSON }] );
	}
	return null;
    });


    //
    // Generate the track
    let trackJSON = {
	"type": "FeatureCollection",
	"features": []
    };

    Object.keys(collection).forEach( (key) => {
	const pilot = collection[key];
	if( pilot && pilot.coordinates ) {
	    trackJSON.features = [].concat( trackJSON.features,
					    [{ 'type': 'Feature', properties: { 'c': key },
					       geometry: pilot }] );
	}
    });

    //
    // Generate the icon
    let locationJSON = {
	"type": "FeatureCollection",
	"features": []
    };

    // Get the latest ones
    Object.keys(grouped).forEach( (key) => {
	const points = grouped[key];
	if( points && points.length > 0 ) {
	    locationJSON.features = [].concat( locationJSON.features,
					       [{ 'type': 'Feature',
						  properties: { 'i': 'dot',
								'c': key,
								'v':(tOffset-points[0].t>gapLength?'grey':'black'),
								'x': points[0].a + 'm (' + points[0].g + 'm agl)',
								't': points[0].t,
							      },
						  geometry: { 'type': 'Point',
							      'coordinates': [points[0].lng,points[0].lat]
							    }
						}] );
	}
    });
				   
    // How long should it be cached
    res.setHeader('Cache-Control','max-age=1');
				     
    res.status(200)
	.json({tracks:trackJSON,locations:locationJSON});
}
