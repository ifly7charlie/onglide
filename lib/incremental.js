
const _find  = require('lodash/find')
const _foreach = require('lodash/foreach')

const gapLength = 300;

//
// This goes through all the pilots in data and marks the ones that are overdue as 'grey'
function checkGrey( pilotsGeoJSON, timestamp )
{
    _foreach( pilotsGeoJSON.locations.features,
			  (f) => { f.properties.v = ( timestamp - f.properties.t > gapLength ) ? 'grey' : 'black';} );
}

//
//
// This merges the point into all the associated GeoJSON and Scoring metadata
// used on both client and server
//
function mergePoint( point, data )
{

    if( ! data.pilots || ! data.pilotsGeoJSON.tracks || ! Object.keys(data.pilotsFullGeoJSON).length ) {
        return false;
    }

    // We need to do a deep clone for the change detection to work
    const compno = point.c;
    const p = data.pilots; //_clonedeep(data.pilots);
    const newPoint = [point.lng,point.lat];

    let pLocation = _find( data.pilotsGeoJSON.locations.features, (f) => { return (f.properties.c == compno); } );
    if( ! pLocation ) {
		data.pilotsGeoJSON.locations.features.push ( pLocation = 
			{ 'type': 'Feature',
			  properties: { 'i': 'dot',
							'c': compno,
							'v': 'black',
							't': point.t,
			  },
			  geometry: { 'type': 'Point',
						  'coordinates': newPoint
			  }
		});
    }
	
    const wasGrey = (pLocation.properties.v == 'grey');
	
    // Update the location of the point
    pLocation.properties.t = point.t;
    pLocation.properties.v = 'black';
    pLocation.geometry.coordinates = newPoint;

	// Update the full track
	let features = data.pilotsFullGeoJSON[ compno ]?.features;

	if( ! features ) {
		data.pilotsFullGeoJSON[compno] = {
			"type": "FeatureCollection",
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
		features = data.pilotsFullGeoJSON[ compno ].features;
	}

	if( wasGrey ) {
		features.shift(
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

	    // Now we need to add a point to the track and remove an old one
    let pTrack = _find( data.pilotsGeoJSON.tracks.features, (f) => { return (f.geometry.properties.c == compno) } );
    if( ! pTrack ) {
        console.log( "unknown track for pilot "+point.g );
        return;
    }
	
    // If it had been out of coverage we will drop the points, need one to shift second onto
    // so we are actually a line
    if( wasGrey ) {
        pTrack.geometry.coordinates = [newPoint,newPoint];
    }
	else {
		pTrack.geometry.coordinates.unshift( newPoint );
		pTrack.geometry.coordinates.pop(); // this is wrong as the points are not equally spaced in time...
	}


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

	return true;
}

exports.checkGrey = checkGrey;
exports.mergePoint = mergePoint;
