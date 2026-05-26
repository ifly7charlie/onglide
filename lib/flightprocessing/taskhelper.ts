import along from '@turf/along';
import {buffer} from '@turf/buffer';

import type {Feature, LineString, Polygon, MultiPolygon, Position} from 'geojson';

//import type {Feature, LineString, Position} from 'geojson';
import {lineString, point as turfPoint} from '@turf/helpers';
import lineChunk from '@turf/line-chunk';
import {coordReduce} from '@turf/meta';
import {} from '@turf/helpers';

import type {FeatureCollection} from 'geojson';
import {DistanceKM, As, Task, TaskLeg, Bearing, BasePositionMessage, NearestSectorPoint, EnrichedPosition} from '../types';

import {PreparedTurnpoint} from './preparedTurnpoint';

//
// Generate the geoJSON objects and length and everything else need to be ready for processing
export function calculateTask(task: Task) {
    task.preparedLegs = [];

    for (const leg of task.legs) {
        preprocessSector(leg);
        const pl = (task.preparedLegs[leg.legno] = new PreparedTurnpoint(task.legs, leg.legno));

        let feature: Feature<Polygon | LineString | MultiPolygon> = pl.toGeoJSON();

        if (feature.geometry?.type === 'LineString') {
            feature = buffer(feature.geometry, 100, {units: 'meters'});
        }

        if (feature.geometry?.type === 'MultiPolygon') {
            console.error(`Unable to process turnpoint ${leg.legno} as geometry type unknown`, JSON.stringify(feature));
            return;
        }

        leg.geoJSON = feature.geometry;
        const coords: Position[] = coordReduce(
            leg.type === 'line' // logic is different line vs sector
                ? lineChunk(lineString(pl.toGeoJSON().geometry.coordinates as Position[]), 0.5) //
                : lineChunk(lineString(leg.geoJSON.coordinates[0] as Position[]), 2.5),
            (prev: Position[], current: Position) => {
                prev.push(current);
                return prev;
            },
            [] as Position[]
        );
        const isSame = (a: Position, b: Position) => Math.trunc(a[0] * 100000) == Math.trunc(b[0] * 100000) && Math.trunc(a[1] * 100000) == Math.trunc(b[1] * 100000);
        const deduped: Position[] = [];
        for (const c of coords) {
            if (!deduped.some((d) => isSame(c, d))) deduped.push(c);
        }
        leg.coordinates = deduped;
    }

    task.details.distance = calculateTaskLength(task.legs);
}

export function taskGeoJSON(task: Task) {
    task.preparedLegs = task.legs.map((_leg, i) => new PreparedTurnpoint(task.legs, i));
    const geoJSON: FeatureCollection = {
        type: 'FeatureCollection',
        features: task.legs.reduce(
            (features, leg) => [
                ...features,
                {
                    type: 'Feature',
                    properties: {leg: leg.legno, trigraph: leg.ntrigraph, name: leg.name, altitude: leg.altitude, r1: leg.r1},
                    geometry: leg.geoJSON
                }
            ],
            []
        )
    };

    const trackLineGeoJSON: FeatureCollection = {
        type: 'FeatureCollection',
        features: task.legs.reduce<Feature[]>((accumulate, leg, index) => {
            if (index + 1 < task.legs.length) {
                accumulate.push({
                    type: 'Feature',
                    properties: {leg: leg.legno + 1, length: leg.length},
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [leg.nlng, leg.nlat],
                            [task.legs[index + 1].nlng, task.legs[index + 1].nlat]
                        ]
                    }
                });
            }
            return accumulate;
        }, [])
    };

    const taskPath = lineString(task.legs.map((leg) => [leg.nlng, leg.nlat]));
    const Dm = task.rules.dm && !task.rules.aat ? {Dm: along(taskPath, task.rules.dm)} : {};

    return {tp: geoJSON, track: trackLineGeoJSON, ...Dm};
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
    return (Math.round(legs.reduce((s, l) => s + (l.length ?? 0), 0) * 10) / 10) as DistanceKM;
}

export function preprocessSector(tp: TaskLeg) {
    // Save the point in GeoJSON ordering and calculate maximum radius
    tp.point = [tp.nlng, tp.nlat];
    tp.maxR = Math.max(tp.r1, tp.r2) as DistanceKM;

    // some sanity checking - we should really report this
    if (tp.r2 > tp.r1) {
        tp.r2 = tp.r1;
    }

    if (tp.a1 > 180) {
        tp.a1 = 180 as Bearing;
    }

    if (tp.a2 > 180) {
        tp.a2 = 180 as Bearing;
    }

    // A sector cylinder (start/finish ring, or a fixed turnpoint) is encoded
    // with a zero apex angle but a non-zero radius. a1 == 180 is the full-circle
    // marker used everywhere else (analytic crossing, quickSector, finish-ring
    // length adjustment), so normalise the zero-angle form to it.
    if (tp.type == 'sector' && tp.a1 == 0 && tp.r1 > 0 && !tp.r2) {
        tp.a1 = 180 as Bearing;
    }

    // Help speed up turnpoint checking
    if (tp.type == 'sector' && tp.a1 == 180 && !tp.a12 && !tp.r2) {
        tp.quickSector = true;
    }
}

export function calcHandicap(dist, leg, handicap) {
    return (100.0 * dist) / Math.max(handicap + leg.Hi, 25);
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
export function distHaversine(p1: {lat: number; lng: number}, p2: {lat: number; lng: number}): DistanceKM {
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

export function distHaversineRaw(p1: number[], p2: number[]): DistanceKM {
    const p1lat = p1[1] * d2r;
    const p2lat = p2[1] * d2r;
    const p1long = p1[0] * d2r;
    const p2long = p2[0] * d2r;

    var R = 6371; // earth's mean radius in km
    var dLat = p2lat - p1lat;
    var dLong = p2long - p1long;

    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(p1lat) * Math.cos(p2lat) * Math.sin(dLong / 2) * Math.sin(dLong / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var d = R * c;

    return d as DistanceKM;
}
// Sum up the shortest/longest path
export function sumPath(
    path: BasePositionMessage[], //
    startLeg: number = 0,
    legs: PreparedTurnpoint[],
    lda: boolean,
    saveLeg: Function = (_leg: number, _distance: DistanceKM, _point?: BasePositionMessage): void => {}
): DistanceKM {
    let previousPoint: BasePositionMessage | null = null;
    let distance = 0;
    let leg = startLeg;
    for (const point of path) {
        if (leg < 0) {
            continue;
        }
        if (leg >= legs.length) {
            break;
        }
        if (previousPoint) {
            const legDistanceAdjust = legs[leg].leg?.legDistanceAdjust ?? 0;
            if (lda && legDistanceAdjust) {
                // if the point is the turnpoint then we need to adjust for the distance
                const legRemaining = Math.max((legs[leg].fromSector(point) ?? 0) + legDistanceAdjust, 0);
                const newPoint = legs[leg].scoredPointRemaining(legRemaining as DistanceKM);
                const legDistance = Math.max(Math.round(legs[leg].interpointDistance(previousPoint, newPoint) * 20) / 20, 0);
                saveLeg(leg, legDistance, {...newPoint, t: point.t, lda: true});
                distance += legDistance;
            } else {
                const legDistance = Math.max(Math.round(legs[leg].interpointDistance(previousPoint, point) * 20) / 20, 0);
                saveLeg(leg, legDistance, point);
                distance += legDistance;
            }
        } else {
            saveLeg(leg, 0 /*legDistance*/, point);
        }
        leg++;
        previousPoint = point;
    }
    while (leg < legs.length) {
        saveLeg(leg, 0, undefined);
        leg++;
    }
    return (Math.round(distance * 10) / 10) as DistanceKM;
}

const tostrip = {
    points: (v) => v.length,
    penaltyPoints: (v) => v.length,
    convexHull: (v) => v.length / 2,
    geoJSON: (v) => {
        'geoJSON';
    }
};
export function stripPoints(k, v) {
    return tostrip[k] ? tostrip[k](v) : v;
}
