
import _find  from 'lodash.find'
import _foreach  from 'lodash.foreach'

const gapLength = 300;

//
// This goes through all the pilots in data and marks the ones that are overdue as 'grey'
export function checkGrey( pilotsGeoJSON, timestamp )
{
	for( f of pilotsGeoJSON.locations.features ) {
		f.properties.v = ( timestamp - f.properties.t > gapLength ) ? 'grey' : 'black'; console.log( f.properties.c, f.properties.v );
	}				
}

//
//
// This merges the point into all the associated GeoJSON and Scoring metadata
// used on both client and server
//
export function mergePoint( point, data, latest = true, now = Date.now()/1000 )
{
    if( ! data.geoJSON.tracks ) { // || ! Object.keys(data.geoJSON.fulltracks).length ) {
		console.log( "umm" );
        return false;
    }

    // We need to do a deep clone for the change detection to work
    const compno = point.c;
    const p = data.trackers; 
    const newPoint = [Math.round(point.lng*10000)/10000,Math.round(point.lat*10000)/10000];
	let wasGrey = false;
	
	if( latest )
	{
		let pLocation = _find( data.geoJSON.locations.features, (f) => { return (f.properties.c == compno); } );
		if( ! pLocation ) {
			pLocation = { 'type': 'Feature',
						  properties: { 'i': 'dot',
										'c': compno,
										'v': ((now - point.t) > gapLength) ? 'grey' : 'black',
										's': 0,
										't': point.t,
									  },
						  geometry: { 'type': 'Point',
									  'coordinates': newPoint
									}
						};
			if( data.geoJSON.locations?.features ) {
				data.geoJSON.locations.features.push ( pLocation );
			}
			else {
				data.geoJSON.locations = {
					"type": "FeatureCollection",
					"features": [
						pLocation
					]};
			}
				
		}
		else {
			wasGrey = (pLocation.properties.v == 'grey');
			// Update the location of the point
			pLocation.properties.t = point.t;
			pLocation.properties.v = 'black';
			pLocation.geometry.coordinates = newPoint;
		}
			
	}
	else {
		// Check how long the gap has been
		if( point.t - (data.state[compno]?.mergePoint||point.t) > gapLength ) {
			wasGrey = true;
		}
	}

	data.state[compno].mergePoint = point.t;

	if( ! data.trackers[compno].utcstart || point.t > data.trackers[compno].utcstart )
	{

	// Update the full track
	let features = data.geoJSON.fulltracks[ compno ]?.features;

	if( ! features ) {
		data.geoJSON.fulltracks[compno] = {
			"type": "FeatureCollection",
			properties: { 't': point.t },
			"features": [
				{ 'type': 'Feature',
				  'properties': {},
				  'geometry': {
					  "type": "LineString",
					  "coordinates": [ newPoint, newPoint ],
				  }
				}
			],
		};
		features = data.geoJSON.fulltracks[ compno ].features;
	}
	else {
	
		if( wasGrey ) {
			features.unshift(
				{ 'type': 'Feature',
				  'properties': {},
				  'geometry': {
					  "type": "LineString",
					  "coordinates": [ newPoint, newPoint ],
				  }
				}
			);
		}
		else {
			features[0].geometry.coordinates.unshift( newPoint );
		}
	}


	if( now - point.t < gapLength )
	{
		// Now we need to add a point to the track and remove an old one
		// and create it all if it doesn't exist
		let pTrack = _find( data.geoJSON.tracks.features, (f) => { return (f.properties.c == compno) } );
		if( ! pTrack ) {
			if( ! Object.keys(data.geoJSON.tracks).length ) {
				data.geoJSON.tracks = {
					"type": "FeatureCollection",
					"features": []
				};
			}
			data.geoJSON.tracks.features = [].concat( data.geoJSON.tracks.features,
													  [ pTrack = { 'type': 'Feature', properties: { 'c': compno },
																   geometry: { type: "LineString", coordinates: [newPoint,newPoint] } }] );
			
		}

		if( latest ) {
			// If it had been out of coverage we will drop the points, need one to shift second onto
			// so we are actually a line
			if( wasGrey ) {
				pTrack.geometry.coordinates = [newPoint,newPoint];
			}
			else {
				pTrack.geometry.coordinates.unshift( newPoint );
				pTrack.geometry.coordinates.pop(); // this is wrong as the points are not equally spaced in time...
			}
		}
		else {
			pTrack.geometry.coordinates.unshift( newPoint );
		}
	}
	}

	if( point.v && latest && p ) {
		// Update the altitude and height AGL for the pilot
		// Mutate the vario and altitude back into SWR
		const cp = p[compno];
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
