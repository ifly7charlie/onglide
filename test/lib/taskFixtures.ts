/**
 * Synthetic AAT task factory for testing.
 *
 * Builds a fully-formed Task object (with preparedLegs, rules, details, leg
 * geometry) from plain parameters so tests never touch a database.
 */
import type {Task, TaskLeg, Epoch, DistanceKM, Bearing, ClassName, Datecode, TaskId, AltitudeAMSL} from '../../lib/types';
import {PreparedTurnpoint} from '../../lib/flightprocessing/preparedTurnpoint';
import {preprocessSector, calculateTaskLength, distHaversine} from '../../lib/flightprocessing/taskhelper';
import {lineString} from '@turf/helpers';
import lineChunk from '@turf/line-chunk';
import {coordReduce} from '@turf/meta';
import {buffer} from '@turf/buffer';
import type {Feature, LineString, Polygon, MultiPolygon, Position} from 'geojson';

// ── public types ──────────────────────────────────────────────────────────

export interface SectorDef {
    lat: number;
    lng: number;
    /** Sector type. Default 'sector'. */
    type?: 'sector' | 'line';
    /** Departure radius (km). Required. */
    r1: number;
    /** Approach radius (km). Default 0. */
    r2?: number;
    /** Departure half-angle (degrees). Default 180 (circle). */
    a1?: number;
    /** Approach half-angle (degrees). Default 0. */
    a2?: number;
    /** Fixed bearing for sector (degrees). Default 0. */
    a12?: number;
    /** Direction mode. Default 'symmetrical'. */
    direction?: 'symmetrical' | 'np' | 'pp' | 'fixed';
    /** Altitude of the turnpoint (meters AMSL). Default 0. */
    altitude?: number;
}

export interface AATTaskOptions {
    /** Start / finish location. */
    startLat: number;
    startLng: number;
    /** Altitude of start/finish (AMSL). */
    startAltitude?: number;
    /** Assigned areas in order (excluding start/finish). */
    sectors: SectorDef[];
    /** Minimum task time in seconds. */
    minTimeSecs: number;
    /** UTC epoch for the start gate opening. */
    startTime: Epoch;
    /** Start geometry. Default: line, r1 = 5 km. */
    startRadius?: number;
    /** Start type. Default 'line'; 'cylinder' builds a full-circle sector start. */
    startType?: 'line' | 'cylinder';
    /** IGC cylinder (PEV) start — sets rules.pevStart and skips the start-ring length adjustment. */
    pevStart?: boolean;
    /** Finish geometry. Default: line, r1 = 3 km. */
    finishRadius?: number;
    /** Finish location (defaults to start location). */
    finishLat?: number;
    finishLng?: number;
    /** Handicap setting. Default not handicapped. */
    handicapped?: boolean;
}

// ── helpers ───────────────────────────────────────────────────────────────

function makeLeg(legno: number, def: SectorDef, overrides: Partial<TaskLeg> = {}): TaskLeg {
    return {
        // DB row stubs
        datecode: '2026-03-28' as Datecode,
        class: 'test' as ClassName,
        taskid: 1 as TaskId,
        ntrigraph: `TP${legno}`,
        name: `Turnpoint ${legno}`,
        bearing: 0,
        Hi: 0,

        // Geometry
        legno,
        type: def.type ?? 'sector',
        nlat: def.lat,
        nlng: def.lng,
        r1: (def.r1 ?? 0) as DistanceKM,
        r2: (def.r2 ?? 0) as DistanceKM,
        a1: (def.a1 ?? 180) as Bearing,
        a2: (def.a2 ?? 0) as Bearing,
        a12: (def.a12 ?? 0) as Bearing,
        direction: def.direction ?? 'symmetrical',
        altitude: def.altitude as AltitudeAMSL,
        length: 0 as DistanceKM, // computed below

        ...overrides
    } as TaskLeg;
}

function computeLegLengths(legs: TaskLeg[]): void {
    for (let i = 1; i < legs.length; i++) {
        legs[i].length = distHaversine(
            {lat: legs[i - 1].nlat, lng: legs[i - 1].nlng, t: 0 as Epoch, a: 0},
            {lat: legs[i].nlat, lng: legs[i].nlng, t: 0 as Epoch, a: 0}
        );
    }
}

function buildCoordinates(leg: TaskLeg, pl: PreparedTurnpoint): void {
    let feature: Feature<Polygon | LineString | MultiPolygon> = pl.toGeoJSON();

    if (feature.geometry?.type === 'LineString') {
        feature = buffer(feature.geometry, 50, {units: 'meters'});
    }

    if (feature.geometry?.type === 'MultiPolygon') {
        // fallback to empty
        leg.geoJSON = undefined;
        leg.coordinates = [];
        return;
    }

    leg.geoJSON = feature.geometry;

    try {
        const coords: Position[] = coordReduce(
            leg.type === 'line'
                ? lineChunk(lineString(pl.toGeoJSON().geometry.coordinates as Position[]), 0.5)
                : lineChunk(lineString(leg.geoJSON!.coordinates[0] as Position[]), 2.5),
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
    } catch {
        // If coordinate generation fails (e.g. tiny sectors), use a simple ring
        leg.coordinates = [[leg.nlng, leg.nlat]];
    }
}

// ── main factory ──────────────────────────────────────────────────────────

/**
 * Build a fully prepared AAT Task suitable for feeding into the scoring chain.
 */
export function makeAATTask(opts: AATTaskOptions): Task {
    const startR = opts.startRadius ?? 5;
    const finishR = opts.finishRadius ?? 3;

    // Build legs array: start + sectors + finish
    const legs: TaskLeg[] = [];

    // Leg 0 — start (line type by default, or a full-circle cylinder)
    const cylinderStart = opts.startType === 'cylinder';
    legs.push(
        makeLeg(0, {
            lat: opts.startLat,
            lng: opts.startLng,
            type: cylinderStart ? 'sector' : 'line',
            r1: startR,
            a1: cylinderStart ? 180 : 90,
            direction: cylinderStart ? 'symmetrical' : 'np',
            altitude: opts.startAltitude
        })
    );

    // Middle legs — assigned areas
    for (let i = 0; i < opts.sectors.length; i++) {
        legs.push(makeLeg(i + 1, opts.sectors[i]));
    }

    // Last leg — finish line (direction pp = toward previous point)
    legs.push(
        makeLeg(opts.sectors.length + 1, {
            lat: opts.finishLat ?? opts.startLat,
            lng: opts.finishLng ?? opts.startLng,
            type: 'line',
            r1: finishR,
            a1: 90,
            direction: 'pp',
            altitude: opts.startAltitude
        })
    );

    // Compute inter-leg distances
    computeLegLengths(legs);

    // Preprocess each leg (point, maxR, quickSector, etc.)
    for (const leg of legs) {
        preprocessSector(leg);
    }

    // Build PreparedTurnpoints and coordinates
    const preparedLegs: PreparedTurnpoint[] = [];
    for (const leg of legs) {
        const pl = new PreparedTurnpoint(legs, leg.legno);
        preparedLegs[leg.legno] = pl;
        buildCoordinates(leg, pl);
    }

    // Apply start/finish ring adjustments and sum task length
    const taskDistance = calculateTaskLength(legs, opts.pevStart);

    const task: Task = {
        rules: {
            grandprixstart: false,
            nostartutc: opts.startTime,
            aat: true,
            pevStart: opts.pevStart,
            handicapped: opts.handicapped ?? false,
            dm: 0,
            maxHandicap: 100
        },
        details: {
            datecode: '2026-03-28' as Datecode,
            class: 'test' as ClassName,
            taskid: 1 as TaskId,
            task: 'Test AAT',
            flown: 'Y',
            description: 'Test AAT Task',
            type: 'A',
            distance: taskDistance,
            duration: '02:00' as any,
            nostart: '12:00:00' as any,
            hash: 'test',
            durationsecs: opts.minTimeSecs,
            nostartutc: opts.startTime,

            // ClassesTableRow stubs
            classname: 'Test Class',
            handicapped: 'N',
            grandprixstart: 'N',
            Dm: null,

            // ContestDayTableRow stubs
            calendardate: '2026-03-28',
            info: '',
            status: 'Y'
        } as any,
        legs,
        preparedLegs
    };

    return task;
}

/**
 * Build a simple racing task (non-AAT) for comparison testing.
 */
export function makeRacingTask(opts: Omit<AATTaskOptions, 'minTimeSecs'> & {minTimeSecs?: number}): Task {
    const task = makeAATTask({...opts, minTimeSecs: opts.minTimeSecs ?? 0});
    task.rules.aat = false;
    task.details.type = 'S';

    // Racing tasks use 500m observation zones by default for turnpoints
    // (already handled by the sector definitions passed in)
    return task;
}
