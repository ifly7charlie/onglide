
import LatLong from './LatLong.js';
import _sumby from 'lodash.sumby';

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import {point,polygon} from '@turf/helpers';

import pointToLineDistance from '@turf/point-to-line-distance'
import polygonToLine from '@turf/polygon-to-line';

var _2pi = Math.PI*2;

// Between LEGS!
export function calculateTaskLength( legs ) {

    // This is one place where the leg length does matter
    let i = 1;
    for( i = 1; i < legs.length; i++ ) {
        //        console.log( "leg "+i+" db length:"+legs[i].length+", length haversine: " + LatLong.distHaversine(legs[i-1].ll,legs[i].ll ) +", length vincenty: " + LatLong.distVincenty(legs[i-1].ll,legs[i].ll ));
        legs[i].length = legs[i].lengthCenter = LatLong.distVincenty( new LatLong(legs[i-1].nlat,legs[i-1].nlng), new LatLong(legs[i].nlat,legs[i].nlng) );
    }

    // If it is the last point then we need to reduce it by the radius of the finish ring
    if( legs[i-1].type == 'sector' && legs[i-1].a1 ==180 ) {
        //        console.log( "reducing last leg by radius of finish ring" +legs[i-1].r1);
        legs[i-1].length -= legs[i-1].r1;
    }

    // Return the length of the task
    return Math.round(_sumby( legs, 'length' )*10)/10;
}

export function preprocessSector( tp ) {

    // Save the point in GeoJSON ordering and calculate maximum radius
    tp.point = [ tp.nlng, tp.nlat ];
    tp.maxR = Math.max(tp.r1,tp.r2);

    // Help speed up turnpoint checking
    if( tp.type == 'sector' && tp.a1 == 180 && ! tp.a12 && !tp.r2 ) {
        tp.quickSector = 1;
    }

    tp.ll = new LatLong( tp.nlat, tp.nlng );
}


export function sectorGeoJSON( task, tpno ) {

    var polypoints = [];
    var turnpoint = task[tpno];

    var symmetric = 0;
    var np = 9999;
    var pp = 9999;

    var ltlg = turnpoint.ll;

    var a1 = -1, a2 = -1;
    if( tpno < task.length-1 ) {
        var ltlgn = task[tpno+1].ll;
        np = a1 = LatLong.radToDBrng(LatLong.bearing( ltlg, ltlgn ));
    }

    if( tpno >= 1 ) {
        var ltlgp = task[tpno-1].ll;
        pp = a2 = LatLong.radToDBrng(LatLong.bearing( ltlg, ltlgp ));
        //        console.log( "2b) pp=" + pp );

    }


    if( np == 9999 ) {
        np = pp;
    }

    if( pp == 9999 ) {
        pp = np;
    }

    var center = 0;
    switch( turnpoint.direction ) {
    case "symmetrical":
        if( a1 != -1 && a2 != -1 ) {
            var x1 = a1-a2;
            if( x1 < 0 ) {
                x1 += _2pi;
            }
            var x2 = a2-a1;
            if( x2 < 0 ) {
                x2 += _2pi;
            }
            var minAngle = Math.min(x1,x2);
            if( (a1+minAngle)%_2pi == a2 ) {
                center = (a1+minAngle/2+Math.PI)%_2pi;
            }
            else {
                center = (a2+minAngle/2+Math.PI)%_2pi;
            }
        }
        break;
    case "np":
        center = (np + Math.PI) % (2*Math.PI);
        break;
    case "pp":
        center = (pp + Math.PI) % (2*Math.PI);
        break;
    case "fixed":
        if( typeof turnpoint.a12 !== 'undefined' && ! isNaN(turnpoint.a12) && turnpoint.a12 !== '') {
            center = ((turnpoint.a12*Math.PI/180) + Math.PI) % (2*Math.PI);
            //            center = ((turnpoint.a12*Math.PI/180)) % (2*Math.PI);
        } else {
            //            console.log( 'No A12 specified' );
        }
        break;
    default:
        //        console.log( turnpoint.direction + " not implemented yet" );
        break;
    }

    // some sanity checking - we should really report this
    if( turnpoint.r2 > turnpoint.r1 ) {
        turnpoint.r2 = turnpoint.r1;
    }

    if( turnpoint.a1 > 180 ) {
        turnpoint.a1 = 180;
    }

    if( turnpoint.a2 > 180 ) {
        turnpoint.a2 = 180;
    }

    turnpoint.centerAngle = (center + 2*Math.PI)%(2*Math.PI);;
    turnpoint.centerAngleRaw = center;

    // Needed for both line and sectors
    var a1rad = turnpoint.a1*Math.PI/180;
    var from = (2*Math.PI+(center - a1rad))%(2*Math.PI);
    var to = (2*Math.PI+(center + a1rad))%(2*Math.PI);

    switch( turnpoint.type )
    {
        case "line":
        //        console.log( "line: from:" + from + ", to:" + to + ", r1:"+turnpoint.r1  );

        var dltlg = ltlg.destPointRad( from, turnpoint.r1 );
        polypoints = [].concat( polypoints, [ dltlg.dlong(), dltlg.dlat() ] );
        dltlg = ltlg.destPointRad( to, turnpoint.r1 );
        polypoints = [].concat( polypoints, [ dltlg.dlong(), dltlg.dlat() ] );
        turnpoint.geoJSONtype = 'LineString';
        break;

        case "sector":
        //        console.log( "sector: from:" + from + ", to:" + to + ", r1:"+turnpoint.r1 + ",r2:"+turnpoint.r2 );

        if( turnpoint.a1 != 180 ) {
            //      console.log('!180');
            polypoints.push( [ ltlg.dlong(), ltlg.dlat() ] );
        }

        polypoints = [].concat( polypoints, addArc( from, to, ltlg, turnpoint.r1, turnpoint.r2 ) );

        // something has been configured for turnpoint a2
        //turnpoint a2 has been configured and has a radius
        if( turnpoint.a2 != 0 && ! isNaN( turnpoint.a2 ) && ! isNaN( turnpoint.r2 ) &&
            Math.round(Math.abs(turnpoint.a2)) == Math.round(Math.abs(turnpoint.a1)) && turnpoint.r1 != turnpoint.r2  &&
            turnpoint.r2 != 0 ) {

            //            console.log( "(neg) a1:"+turnpoint.a1, ", a2:"+turnpoint.a2 );

            polypoints = [].concat( polypoints, addArc( center + (turnpoint.a1*Math.PI/180),
                                                        center - (turnpoint.a1/180*Math.PI),
                                                        ltlg, turnpoint.r2, 1 ));
        }
        else if( turnpoint.a2 != 0 && ! isNaN( turnpoint.a2 ) && ! isNaN( turnpoint.r2 ) &&
                 turnpoint.a1 != turnpoint.a2 &&
                 turnpoint.r1 != turnpoint.r2 ) {

            //            console.log( "! a1:"+turnpoint.a1, ", a2:"+turnpoint.a2 );

            polypoints = [].concat( polypoints, addArc( center + (turnpoint.a1*Math.PI/180),
                                                        center + (turnpoint.a2/180*Math.PI),
                                                        ltlg, turnpoint.r2 ) );

            if( turnpoint.a2 != 180 ) {
                polypoints.push( [ ltlg.dlong(), ltlg.dlat() ] );
            }

            polypoints = [].concat( polypoints, addArc( center - (turnpoint.a2/180*Math.PI),
                                                        center - (turnpoint.a1*Math.PI/180),
                                                        ltlg, turnpoint.r2 ) );

        }
        //turnpoint a2 has been configured and has a radius
        else if( turnpoint.a2 == 0 && turnpoint.r1 != turnpoint.r2  &&
                 turnpoint.r2 != 0 ) {

            polypoints = [].concat( polypoints, addArc( center + (turnpoint.a1*Math.PI/180),
                                                        center - (turnpoint.a1/180*Math.PI),
                                                        ltlg, turnpoint.r2, 0 ));
        }
        else if( turnpoint.a1 != 180 ) {
            //      console.log('180');
            polypoints.push( [ ltlg.dlong(), ltlg.dlat() ] );
        }

        turnpoint.geoJSONtype='Polygon';
        break;
    }

    // Reduce precision
    polypoints.forEach( (p) => { p[0] = Math.round(100000*p[0])/100000; p[1] = Math.round(100000*p[1])/100000; } );

    // Generate the line list
    turnpoint.geoJSON = {
        'type': turnpoint.geoJSONtype,
        'coordinates': [ polypoints ],
    };
    return turnpoint.geoJSON;
}

// Iterate over an arc adding the appropriate points
function addArc( startAngle, endAngle, ltlg, radius, backwards ) {

    // accumulate the points and return them
    let points = [];

    if( Math.round(((2*Math.PI+startAngle)%(Math.PI*2))*20) == Math.round(((2*Math.PI+endAngle)%(Math.PI*2))*20) ) {
        for( var i = 2*Math.PI, adj = Math.PI/40; i >= 0; i -= adj ) {
            var dltlg = ltlg.destPointRad( i % (2*Math.PI), radius);
            points.push( [ dltlg.dlong(), dltlg.dlat() ] );
        }
        points.push( pointAtRadius( ltlg, 2*Math.PI, radius ) );
    }
    else if( 0 ) {
        if( startAngle < endAngle )    {
            for( var i = startAngle, adj = (endAngle-startAngle)/40, ea = Math.round(endAngle*100); Math.round(i*100) <= ea; i -= adj ) {
                var dltlg = ltlg.destPointRad( i, radius );
                points.push( [ dltlg.dlong(), dltlg.dlat() ] );
            }

        }
        else {
            for( var i = startAngle, adj = ((_2pi+(startAngle - endAngle))%(_2pi))/40, ea = Math.round(endAngle*100); i >= startAngle || Math.round(i*100) <= ea ; i = roundRad(i +adj) ) {
                var dltlg = ltlg.destPointRad( i, radius );
                points.push( [ dltlg.dlong(), dltlg.dlat() ] );
            }
        }
    }
    else if( startAngle < endAngle ) {
        for( var i = startAngle, adj = (endAngle-startAngle)/40, ea = Math.round(endAngle*100); Math.round(i*100) <= ea; i += adj ) {
            var dltlg = ltlg.destPointRad( i, radius );
            points.push( [ dltlg.dlong(), dltlg.dlat() ] );
        }

    }
    else {
        for( var i = startAngle, adj = ((_2pi+(startAngle - endAngle))%(_2pi))/40, ea = Math.round(endAngle*100); i >= startAngle || Math.round(i*100) <= ea ; i = roundRad(i +adj) ) {
            var dltlg = ltlg.destPointRad( i, radius );
            points.push( [ dltlg.dlong(), dltlg.dlat() ] );
        }
    }

    return points;
}

// Check ti see if the turn point contains the point,
// check radius before checking the geoJSON sub object as often radius is enough
export function checkIsInTP( turnpoint, p ) {

    // Quick check to see if it is plausible
    var x = LatLong.distHaversine(p.ll,turnpoint.ll);
    if( x < ( turnpoint.maxR + 0.5)) {

        // If we are inside the radius and the sector is just a circle then we are done
        if( turnpoint.quickSector ) {
            return +x;
        }

        // Otherwise confirm if it is inside the polygon
        return booleanPointInPolygon( p.geoJSON, turnpoint.geoJSON ) ? +x :
			  -distanceToTPPolygon( turnpoint, p );
    }
    return -x;
}

export function timeToText( laststarttime ) {
    var cT = new Date(0); cT.setUTCSeconds( laststarttime );
    var mins = cT.getMinutes();
    if( mins < 10 ) {
        mins = "0"+mins;
    }
    var secs = cT.getSeconds();
    if( secs < 10 ) {
        secs = "0"+secs;
    }
    return cT.getHours() + ":" + mins + ":" + secs;
}

export function durationToText( elapsed ) {
    var hours = Math.trunc(elapsed/3600);
    var mins = Math.trunc((elapsed/60)%60);
    var secs = (elapsed%60);
    if( mins < 10 ) {
        mins = "0"+mins;
    }
    if( secs < 10 ) {
        secs = "0"+secs;
    }
    return hours + ":" + mins + ":" + secs;
    //    return String.format("%d:%02d:%02d",hours,mins,secs);
    //    return elapsed;
}


function pointAtRadius( ltlg, radians, radius ) {
    var dltlg = radius ? ltlg.destPointRad( radians, radius ) : ltlg;
    return [ dltlg.dlong(), dltlg.dlat() ];
}

// Make sure we have a round number
function roundRad( i ) {
    return (_2pi+i)%_2pi;
}


// Returns distance in kilometers (negative values for points inside) from a point to the edges of a polygon
// doesn't differentiate between inside or outside so should only be used on outside.
// SRC: https://github.com/Turfjs/turf/issues/1743
export function distanceToTPPolygon( tp, point ) {
	return distanceToPolygon( { polygon: tp.geoJSON, point: point.geoJSON } );
}
function distanceToPolygon( { point, polygon }) {
	if (polygon.type === "Feature") { polygon = polygon.geometry }
	let distance;
	if (polygon.type === "MultiPolygon") {
		distance = polygon.coordinates
						  .map(coords => distanceToPolygon({ point, polygon: polygon(coords).geometry }))
						  .reduce((smallest, current) => (current < smallest ? current : smallest));
	} else {
		if (polygon.coordinates.length > 1) {
			// Has holes
			const [exteriorDistance, ...interiorDistances] = polygon.coordinates.map(coords =>
				distanceToPolygon({ point, polygon: polygon([coords]).geometry })
			);
			if (exteriorDistance < 0) {
				// point is inside the exterior polygon shape
				const smallestInteriorDistance = interiorDistances.reduce(
					(smallest, current) => (current < smallest ? current : smallest)
				);
				if (smallestInteriorDistance < 0) {
					// point is inside one of the holes (therefore not actually inside this shape)
					distance = smallestInteriorDistance * -1;
				} else {
					// find which is closer, the distance to the hole or the distance to the edge of the exterior, and set that as the inner distance.
					distance = smallestInteriorDistance < exteriorDistance * -1
														? smallestInteriorDistance * -1
														: exteriorDistance;
				}
			} else {
				distance = exteriorDistance;
			}
		} else {
			// The actual distance operation - on a normal, hole-less polygon (converted to meters)
			distance = pointToLineDistance(point, polygonToLine(polygon));
//			if (booleanPointInPolygon(point, polygon)) { // MJ: We know it's not in the polygon as we checked that before calling this function
//				distance = distance * -1;
//			}
		}
	}
	return distance
}

export function calcHandicap(dist,leg,handicap) {
    return ((100.0*dist)/Math.max(handicap+leg.Hi,25))
}
