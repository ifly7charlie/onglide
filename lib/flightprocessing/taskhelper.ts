import LatLong from './LatLong.js';
import _sumby from 'lodash.sumby';

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import along from '@turf/along';
import distance from '@turf/distance';

import {lineString, point as turfPoint} from '@turf/helpers';
import lineChunk from '@turf/line-chunk';
import {coordReduce} from '@turf/meta';
import {uniqWith as _uniqWith} from 'lodash';

import {DistanceKM, As, Task, TaskLeg, Bearing, BasePositionMessage} from '../types';

let hit = 0;
let miss = 0;

type Radian = number & As<'Radian'>;

const steps = process.env.NEXT_RUNTIME ? 40 : 15;
const scoring = !(process.env.NEXT_RUNTIME || false);

var _2pi: Radian = (Math.PI * 2) as Radian;

//
// Generate the geoJSON objects and length and everything else need to be ready for processing
export function calculateTask(task: Task) {
    task.details.distance = calculateTaskLength(task.legs);

    for (const leg of task.legs) {
        preprocessSector(leg);
        sectorGeoJSON(task.legs, leg.legno);
    }
}

// Between LEGS, less finish/start rings!
export function calculateTaskLength(legs: TaskLeg[]): DistanceKM {
    const first = legs[0];
    if (first.type == 'sector' && first.a1 == 180) {
        first.legDistanceAdjust = first.r1;
        first.length = (first.length - first.legDistanceAdjust) as DistanceKM;
    }

    const last = legs[legs.length - 1];

    if (last.type == 'sector' && last.a1 == 180) {
        last.legDistanceAdjust = last.r1;
        last.length = (last.length - last.legDistanceAdjust) as DistanceKM;
    }
    last.finish = true;

    // Return the length of the task
    return (Math.round(_sumby(legs, 'length') * 10) / 10) as DistanceKM;
}

export function preprocessSector(tp: TaskLeg) {
    // Save the point in GeoJSON ordering and calculate maximum radius
    tp.point = [tp.nlng, tp.nlat];
    tp.maxR = Math.max(tp.r1, tp.r2) as DistanceKM;

    // Help speed up turnpoint checking
    if (tp.type == 'sector' && tp.a1 == 180 && !tp.a12 && !tp.r2) {
        tp.quickSector = true;
    }
}

export function sectorGeoJSON(task: TaskLeg[], tpno: number) {
    var polypoints = [];
    var turnpoint = task[tpno];

    //    var symmetric = 0;
    var np = 9999;
    var pp = 9999;
    let geoJSONtype = '';

    const tp = task[tpno];
    const ltlg = new LatLong(tp.nlat, tp.nlng);

    var a1 = -1,
        a2 = -1;
    if (tpno < task.length - 1) {
        var ltlgn = new LatLong(task[tpno + 1].nlat, task[tpno + 1].nlng);
        np = a1 = LatLong.radToDBrng(LatLong.bearing(ltlg, ltlgn));
    }

    if (tpno >= 1) {
        var ltlgp = new LatLong(task[tpno - 1].nlat, task[tpno - 1].nlng);
        pp = a2 = LatLong.radToDBrng(LatLong.bearing(ltlg, ltlgp));
        //        console.log( "2b) pp=" + pp );
    }

    if (np == 9999) {
        np = pp;
    }

    if (pp == 9999) {
        pp = np;
    }

    var center: Radian = 0 as Radian;
    switch (turnpoint.direction) {
        case 'symmetrical':
            if (a1 != -1 && a2 != -1) {
                var x1 = a1 - a2;
                if (x1 < 0) {
                    x1 += _2pi;
                }
                var x2 = a2 - a1;
                if (x2 < 0) {
                    x2 += _2pi;
                }
                var minAngle = Math.min(x1, x2);
                if ((a1 + minAngle) % _2pi == a2) {
                    center = ((a1 + minAngle / 2 + Math.PI) % _2pi) as Radian;
                } else {
                    center = ((a2 + minAngle / 2 + Math.PI) % _2pi) as Radian;
                }
            }
            break;
        case 'np':
            center = ((np + Math.PI) % _2pi) as Radian;
            break;
        case 'pp':
            center = ((pp + Math.PI) % _2pi) as Radian;
            break;
        case 'fixed':
            if (typeof turnpoint.a12 !== 'undefined' && !isNaN(turnpoint.a12)) {
                center = (((turnpoint.a12 * Math.PI) / 180 + Math.PI) % _2pi) as Radian;
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
    if (turnpoint.r2 > turnpoint.r1) {
        turnpoint.r2 = turnpoint.r1;
    }

    if (turnpoint.a1 > 180) {
        turnpoint.a1 = 180 as Bearing;
    }

    if (turnpoint.a2 > 180) {
        turnpoint.a2 = 180 as Bearing;
    }

    //    turnpoint.centerAngle = ((center + _2pi) % _2pi) as Bearing;
    //  turnpoint.centerAngleRaw = center;

    // Needed for both line and sectors
    const a1rad = ((turnpoint.a1 * Math.PI) / 180) as Radian;
    const from = ((_2pi + (center - a1rad)) % _2pi) as Radian;
    const to = ((_2pi + (center + a1rad)) % _2pi) as Radian;

    switch (turnpoint.type) {
        case 'line':
            var dltlg = ltlg.destPointRad(from, turnpoint.r1);
            polypoints = [].concat(polypoints, [dltlg.dlong(), dltlg.dlat()]);
            dltlg = ltlg.destPointRad(to, turnpoint.r1);
            polypoints = [].concat(polypoints, [dltlg.dlong(), dltlg.dlat()]);
            geoJSONtype = 'LineString';
            break;

        case 'sector':
            if (turnpoint.a1 != 180) {
                polypoints.push([ltlg.dlong(), ltlg.dlat()]);
            }

            polypoints = [].concat(polypoints, addArc(from, to, ltlg, turnpoint.r1, !!turnpoint.r2));
            // TBD: !! -> this code was wrong in Javascript. assuming if r2 is set then go backwards but not confirmed

            // something has been configured for turnpoint a2
            //turnpoint a2 has been configured and has a radius
            if (turnpoint.a2 != 0 && !isNaN(turnpoint.a2) && !isNaN(turnpoint.r2) && Math.round(Math.abs(turnpoint.a2)) == Math.round(Math.abs(turnpoint.a1)) && turnpoint.r1 != turnpoint.r2 && turnpoint.r2 != 0) {
                //            console.log( "(neg) a1:"+turnpoint.a1, ", a2:"+turnpoint.a2 );

                polypoints = [].concat(polypoints, addArc((center + (turnpoint.a1 * Math.PI) / 180) as Radian, (center - (turnpoint.a1 / 180) * Math.PI) as Radian, ltlg, turnpoint.r2, true));
            } else if (turnpoint.a2 != 0 && !isNaN(turnpoint.a2) && !isNaN(turnpoint.r2) && turnpoint.a1 != turnpoint.a2 && turnpoint.r1 != turnpoint.r2) {
                //            console.log( "! a1:"+turnpoint.a1, ", a2:"+turnpoint.a2 );

                polypoints = [].concat(polypoints, addArc((center + (turnpoint.a1 * Math.PI) / 180) as Radian, (center + (turnpoint.a2 / 180) * Math.PI) as Radian, ltlg, turnpoint.r2, false));

                if (turnpoint.a2 != 180) {
                    polypoints.push([ltlg.dlong(), ltlg.dlat()]);
                }

                polypoints = [].concat(polypoints, addArc((center - (turnpoint.a2 / 180) * Math.PI) as Radian, (center - (turnpoint.a1 * Math.PI) / 180) as Radian, ltlg, turnpoint.r2, false));
            }
            //turnpoint a2 has been configured and has a radius
            else if (turnpoint.a2 == 0 && turnpoint.r1 != turnpoint.r2 && turnpoint.r2 != 0) {
                polypoints = [].concat(polypoints, addArc((center + (turnpoint.a1 * Math.PI) / 180) as Radian, (center - (turnpoint.a1 / 180) * Math.PI) as Radian, ltlg, turnpoint.r2, false));
            } else if (turnpoint.a1 != 180) {
                //      console.log('180');
                polypoints.push([ltlg.dlong(), ltlg.dlat()]);
            }

            geoJSONtype = 'Polygon';
            break;
    }

    // Reduce precision
    polypoints.forEach((p) => {
        p[0] = Math.round(100000.0 * p[0]) / 100000;
        p[1] = Math.round(100000.0 * p[1]) / 100000;
    });

    // Generate the line list
    turnpoint.geoJSON = {
        type: geoJSONtype,
        coordinates: [polypoints]
    };
    if (scoring) {
        turnpoint.coordinates = _uniqWith(
            coordReduce(
                lineChunk(lineString(polypoints), 2),
                (prev, current) => {
                    prev.push(current);
                    return prev;
                },
                []
            ),
            (a, b) => Math.trunc(a[0] * 100000) == Math.trunc(b[0] * 100000) && Math.trunc(a[1] * 100000) == Math.trunc(b[1] * 100000)
        );
    }
    turnpoint.lineString = lineString(polypoints);

    turnpoint.point = turfPoint([tp.nlng, tp.nlat]);
    return turnpoint.geoJSON;
}

//console.log(process.env);

// Iterate over an arc adding the appropriate points
function addArc(startAngle: Radian, endAngle: Radian, ltlg: LatLong, radius: DistanceKM, backwards: boolean) {
    // accumulate the points and return them
    let points = [];

    if (Math.round(((2 * Math.PI + startAngle) % (Math.PI * 2)) * steps) == Math.round(((2 * Math.PI + endAngle) % (Math.PI * 2)) * steps)) {
        for (var i = (2 * Math.PI) as Radian, adj = (Math.PI / steps) as Radian; i >= 0; i = (i - adj) as Radian) {
            var dltlg = ltlg.destPointRad(i % (2 * Math.PI), radius);
            points.push([dltlg.dlong(), dltlg.dlat()]);
        }
        points.push(pointAtRadius(ltlg, _2pi, radius));
    } else if (0) {
        if (startAngle < endAngle) {
            for (var i = startAngle, adj = ((endAngle - startAngle) / steps) as Radian, ea = Math.round(endAngle * 100); Math.round(i * 100) <= ea; i = (i - adj) as Radian) {
                var dltlg = ltlg.destPointRad(i, radius);
                points.push([dltlg.dlong(), dltlg.dlat()]);
            }
        } else {
            for (var i = startAngle, adj = (((_2pi + (startAngle - endAngle)) % _2pi) / steps) as Radian, ea = Math.round(endAngle * 100); i >= startAngle || Math.round(i * 100) <= ea; i = roundRad(i + adj)) {
                var dltlg = ltlg.destPointRad(i, radius);
                points.push([dltlg.dlong(), dltlg.dlat()]);
            }
        }
    } else if (startAngle < endAngle) {
        for (var i = startAngle, adj = ((endAngle - startAngle) / steps) as Radian, ea = Math.round(endAngle * 100); Math.round(i * 100) <= ea; i = (i + adj) as Radian) {
            var dltlg = ltlg.destPointRad(i, radius);
            points.push([dltlg.dlong(), dltlg.dlat()]);
        }
    } else {
        for (var i = startAngle, adj = (((_2pi + (startAngle - endAngle)) % _2pi) / steps) as Radian, ea = Math.round(endAngle * 100); i >= startAngle || Math.round(i * 100) <= ea; i = roundRad(i + adj)) {
            var dltlg = ltlg.destPointRad(i, radius);
            points.push([dltlg.dlong(), dltlg.dlat()]);
        }
    }

    return points;
}

// Check ti see if the turn point contains the point,
// check radius before checking the geoJSON sub object as often radius is enough
//
// returns: - is distance to run in km, any + is inside
// nearestPoint will be updated with closest point on sector boundary
//   if it is specified.
export function checkIsInTP(turnpoint: TaskLeg, p, nearestPoint = undefined): [boolean, boolean, DistanceKM] {
    // Quick check to see if it is plausible
    let distanceRemaining = distance(p.geoJSON, turnpoint.point) as DistanceKM;

    // If we are inside the radius and the sector is just a circle then we are done
    if (turnpoint.quickSector) {
        distanceRemaining = (distanceRemaining - turnpoint.maxR) as DistanceKM;
        const insidePenaltyVolume = !turnpoint.finish && distanceRemaining < 0.5; // no penalty volume on finish
        const insideSector = distanceRemaining < 0;

        // Accept penalty volume of 0.5km on each sector
        if (insidePenaltyVolume || insideSector) {
            return [insideSector, !insideSector && insidePenaltyVolume, (insideSector ? 0 : distanceRemaining) as DistanceKM];
        }

        // The are not in the sector and we have been asked for position
        if (nearestPoint) {
            const r = along(lineString([p.geoJSON, turnpoint.point]), distanceRemaining);
            nearestPoint.geometry = r.geometry;
            // set dist as it is set by distanceToTPPolygon
            nearestPoint.properties = {...r.properties, t: p.t, p: p, dist: distanceRemaining};
        }
        return [false, false, distanceRemaining as DistanceKM];
    }
    //
    // If it's not a circle then if we are outside possible penaltyVolume we
    // don't need to check if we are in the polygon
    if (distanceRemaining > turnpoint.maxR + (turnpoint.finish ? 0 : 0.5)) {
        distanceRemaining = distanceToTPPolygon(turnpoint, p, nearestPoint);
        return [false, !turnpoint.finish && distanceRemaining < 0.5, distanceRemaining as DistanceKM];
    }

    // Otherwise confirm if it is inside the polygon, here we do need
    // to do the distance remaining work as we can't guess distance
    // as could be a wedge etc.
    if (booleanPointInPolygon(p.geoJSON, turnpoint.geoJSON)) {
        return [true, false, 0 as DistanceKM];
    }

    distanceRemaining = distanceToTPPolygon(turnpoint, p, nearestPoint);
    return [false, !turnpoint.finish && distanceRemaining < 0.5, distanceRemaining as DistanceKM];
}

export function checkIsInStartSector(turnpoint: TaskLeg, p): boolean {
    // Quick check to see if it is plausible
    const distanceRemaining = distance(p.geoJSON, turnpoint.point) as DistanceKM;
    const possiblyInsidePenaltyVolume = distanceRemaining < turnpoint.maxR + 0.5;

    // If we are inside the radius and the sector is just a circle then we are done
    if (turnpoint.quickSector) {
        // Accept penalty volume of 0.5km on each sector
        return possiblyInsidePenaltyVolume;
    }

    // If it's not a circle then if we are outside possible penaltyVolume we
    // don't need to check if we are in the polygon
    // as we can't be
    if (distanceRemaining > turnpoint.maxR) {
        return false;
    }

    // Otherwise confirm if it is inside the polygon, here we do need
    // to do the distance remaining work as we can't guess distance
    // as could be a wedge etc.
    return booleanPointInPolygon(p.geoJSON, turnpoint.geoJSON);
}

function pointAtRadius(ltlg: LatLong, radians: Radian, radius: DistanceKM) {
    var dltlg = radius ? ltlg.destPointRad(radians, radius) : ltlg;
    return [dltlg.dlong(), dltlg.dlat()];
}

// Make sure we have a round number
function roundRad(i: Radian | number): Radian {
    return ((_2pi + i) % _2pi) as Radian;
}

// Find the nearest point on the sector - note we have a simple line polygon
// with no holes so nothing fancy required
export function distanceToTPPolygon(tp, point, nearestPoint): DistanceKM {
    try {
        const r = nearestPointOnLine(tp.lineString, point.geoJSON);
        if (nearestPoint) {
            nearestPoint.geometry = r.geometry;
            nearestPoint.properties = {...r.properties, t: point.t, p: point};
        }
        return r.properties.dist as DistanceKM;
    } catch (e) {
        throw new Error(JSON.stringify(tp) + JSON.stringify(point));
    }
}

export function calcHandicap(dist, leg, handicap) {
    return (100.0 * dist) / Math.max(handicap + leg.Hi, 25);
}

export function stats() {
    console.log(`in tp cache ratio ${((100 * hit) / miss).toFixed(1)}%}`);
    hit = miss = 0;
}

//  * (C) 2002-2005 Chris Veness, www.movable-type.co.uk (From LatLong.js)
/*
 * Calculate distance (in km) between two points specified by latitude/longitude with Haversine formula
 *
 * from: Haversine formula - R. W. Sinnott, "Virtues of the Haversine",
 *       Sky and Telescope, vol 68, no 2, 1984
 *       http://www.census.gov/cgi-bin/geo/gisfaq?Q5.1
 */
const d2r = Math.PI / 180;
export function distHaversine(p1: BasePositionMessage, p2: BasePositionMessage): DistanceKM {
    const p1lat = p1.lat * d2r;
    const p2lat = p2.lat * d2r;
    const p1long = p1.lng * d2r;
    const p2long = p2.lng * d2r;

    var R = 6371; // earth's mean radius in km
    var dLat = p2lat - p1lat;
    var dLong = p2long - p1long;

    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(p1lat) * Math.cos(p2lat) * Math.sin(dLong / 2) * Math.sin(dLong / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var d = R * c;

    return d as DistanceKM;
}

// Sum up the shortest/longest path
export function sumPath(path: BasePositionMessage[], startLeg: number = 0, legs: TaskLeg[], saveLeg: Function = (_leg: number, _distance: DistanceKM, _point?: BasePositionMessage): void => {}): DistanceKM {
    let previousPoint: BasePositionMessage | null = null;
    let distance = 0;
    let leg = startLeg;
    for (const point of path) {
        const legDistance = Math.max((previousPoint !== null ? Math.round(distHaversine(previousPoint, point) * 20) / 20 : 0) - (legs[leg]?.legDistanceAdjust || 0), 0);
        saveLeg(leg, legDistance, point);
        distance += legDistance;
        leg++;
        previousPoint = point;
    }
    return (Math.round(distance * 10) / 10) as DistanceKM;
}

export function stripPoints(k, v) {
    return k == 'points' || k == 'penaltyPoints' ? (v || []).length : v;
}
