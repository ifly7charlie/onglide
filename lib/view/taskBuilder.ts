import type {Task, TaskLeg, Epoch, DistanceKM, Bearing, Datecode, ClassName, TaskId} from '../types';
import type {IGCData, OZParams} from './igcParser';

import {calculateTask, taskGeoJSON} from '../flightprocessing/taskhelper';

import turfBearing from '@turf/bearing';
import turfDistance from '@turf/distance';
import {point as turfPoint} from '@turf/helpers';

const styleToDirection: Record<number, TaskLeg['direction']> = {
    0: 'fixed',
    1: 'symmetrical',
    2: 'np',
    3: 'pp'
};

export function buildTask(igcData: IGCData): {task: Task; geoJSON: ReturnType<typeof taskGeoJSON>} | null {
    const {taskDeclaration, ozParams, taskParams, date} = igcData;

    if (!taskDeclaration || taskDeclaration.length < 2) {
        return null;
    }

    const isAAT = Array.from(ozParams.values()).some((oz) => oz.aat) || (taskParams.taskTimeSecs != null && taskParams.taskTimeSecs > 0);

    // Build TaskLeg array from C records + LSEEYOU OZ params
    const legs: TaskLeg[] = taskDeclaration.map((tp, index) => {
        // OZ index mapping: OZ=-1 is start (legno 0), OZ=0 is first TP (legno 1), etc.
        const ozIndex = index - 1;
        const oz: OZParams | undefined = ozParams.get(ozIndex);

        const isStart = index === 0;
        const isFinish = index === taskDeclaration.length - 1;

        // Defaults when LSEEYOU lines are missing
        let r1: number, a1: number, r2: number, a2: number;
        let type: 'line' | 'sector';
        let direction: TaskLeg['direction'];

        if (oz) {
            r1 = oz.r1 / 1000; // metres to km
            a1 = oz.line ? 90 : oz.a1; // lines are always 90° (perpendicular to bearing)
            r2 = oz.r2 / 1000;
            a2 = oz.a2;
            type = oz.line ? 'line' : 'sector';
            direction = styleToDirection[oz.style] ?? 'symmetrical';
        } else if (isStart) {
            // Default start line: 5km, 90° half-angle
            r1 = 5;
            a1 = 90;
            r2 = 0;
            a2 = 0;
            type = 'line';
            direction = 'np';
        } else if (isFinish) {
            // Default finish: 3km ring
            r1 = 3;
            a1 = 180;
            r2 = 0;
            a2 = 0;
            type = 'sector';
            direction = 'pp';
        } else {
            // Default TP: FAI sector (20km, 90°)
            r1 = 20;
            a1 = 90;
            r2 = 0;
            a2 = 0;
            type = 'sector';
            direction = 'symmetrical';
        }

        // Compute bearing and length FROM previous turnpoint (matching soaringspot convention)
        let bearing = 0;
        let length = 0;
        if (index > 0) {
            const prev = taskDeclaration[index - 1];
            const from = turfPoint([prev.lng, prev.lat]);
            const to = turfPoint([tp.lng, tp.lat]);
            bearing = Math.round((turfBearing(from, to) + 360) % 360);
            length = turfDistance(from, to); // km
        }

        const trigraph = tp.name.substring(0, 3).toUpperCase() || `T${index}`;

        return {
            legno: index,
            ntrigraph: trigraph,
            name: tp.name || `TP${index}`,
            nlat: tp.lat,
            nlng: tp.lng,
            r1: r1 as DistanceKM,
            a1: a1 as Bearing,
            r2: r2 as DistanceKM,
            a2: a2 as Bearing,
            a12: (oz?.a12 ?? 0) as Bearing, // from LSEEYOU A12, or computed by PreparedTurnpoint from direction
            type,
            direction,
            length: length as DistanceKM,
            bearing,
            Hi: 0,
            // Required by TaskLegsTableRow
            datecode: 'view' as Datecode,
            class: 'View' as ClassName,
            taskid: 1 as TaskId
        } as TaskLeg;
    });

    // Compute nostartutc from LSEEYOU TSK NoStart + date epoch base
    // NoStart is in local time, so subtract the timezone offset to get UTC
    const tzOffsetSecs = igcData.tzOffset * 3600;
    let nostartutc = date.epochBase as Epoch;
    if (taskParams.noStartUTC) {
        const parts = taskParams.noStartUTC.split(':');
        nostartutc = (date.epochBase + parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + (parts[2] ? parseInt(parts[2]) : 0) - tzOffsetSecs) as Epoch;
    }

    const durationsecs = taskParams.taskTimeSecs ?? 0;
    const durationHours = Math.floor(durationsecs / 3600);
    const durationMins = Math.floor((durationsecs % 3600) / 60);

    const task: Task = {
        rules: {
            grandprixstart: false,
            nostartutc,
            aat: isAAT,
            dh: false,
            handicapped: false,
            dm: undefined,
            maxHandicap: 100
        },
        details: {
            datecode: 'view' as Datecode,
            class: 'View' as ClassName,
            taskid: 1 as TaskId,
            task: 'IGC Task',
            flown: 'Y',
            description: taskDeclaration.map((tp) => tp.name).join(' - '),
            type: isAAT ? 'A' : 'S',
            duration: `${durationHours.toString().padStart(2, '0')}:${durationMins.toString().padStart(2, '0')}:00` as any,
            nostart: taskParams.noStartUTC ?? '00:00:00' as any,
            hash: 'igc',
            nostartutc,
            durationsecs,
            distance: 0 as DistanceKM,
            // ClassesTableRow
            classname: 'IGC Viewer',
            handicapped: 'N',
            grandprixstart: 'N',
            Dm: null,
            // ContestDayTableRow
            calendardate: `${igcData.date.year + (igcData.date.year < 80 ? 2000 : 1900)}-${igcData.date.month.toString().padStart(2, '0')}-${igcData.date.day.toString().padStart(2, '0')}`,
            info: '',
            status: 'Y'
        } as Task['details'],
        legs
    };

    // calculateTask computes geoJSON, preparedLegs, and task distance
    calculateTask(task);

    // Generate the GeoJSON for Redux/map display
    const geoJSONData = taskGeoJSON(task);

    return {task, geoJSON: geoJSONData};
}
