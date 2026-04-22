import {Compno, ClassName, Datecode, Epoch, Task, FlarmID} from '../lib/types';

import {calculateTask} from '../lib/flightprocessing/taskhelper';

import type {Aircraft} from '../lib/webworkers/aprs';
import {processMessageQueue} from '../lib/webworkers/aprs';
import {loadPoints} from '../lib/webworkers/pointlog';

import {fromDateCode, competitionStartTs} from '../lib/datecode';

import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';

import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config({path: '.env.local'});

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
    .scriptName('exporttrack')
    .usage('$0 --datecode <dc> --className <cls> --compno <cn> [--output <file>]')
    .option('datecode', {type: 'string', demandOption: true, describe: 'datecode'})
    .option('className', {type: 'string', demandOption: true, describe: 'Class'})
    .option('compno', {type: 'string', demandOption: true, describe: 'competition number'})
    .option('output', {type: 'string', describe: 'output .kml file (default: stdout)'})
    .option('simplify', {type: 'boolean', describe: 'run through simplification (as scoring sees it)'})
    .option('gap', {type: 'number', default: 60, describe: 'break track at gaps longer than N seconds'})
    .strict()
    .help()
    .parseSync();

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        decimalNumbers: true
    },
    onError: (e) => console.error(e),
    onConnectError: (x) => console.error('mysql connect error', x),
    maxRetries: 2,
    connUtilization: 0.2
});

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

async function main() {
    const datecode = argv.datecode as Datecode;
    const className = argv.className as ClassName;
    const compno = argv.compno as Compno;

    // Get tracker + timezone for this pilot's competition
    const pilots = await mysql.query<{compno: Compno; trackerid: string; tzoffset: number}[]>(escape`
        SELECT pilots.compno, trackerid, c.tzoffset
        FROM pilots
        LEFT JOIN tracker ON pilots.class = tracker.class AND pilots.compno = tracker.compno
        JOIN classes cl ON pilots.class = cl.class
        JOIN competition c ON cl.compid = c.compid
        WHERE pilots.class = ${className} AND pilots.compno = ${compno}
    `);

    if (!pilots.length || !pilots[0].trackerid) {
        console.error(`No tracker found for ${className}/${compno}`);
        process.exit(1);
    }

    // Load task
    const task = await getTask(className, datecode);
    if (!task) {
        console.error(`No task found for ${className}/${datecode}`);
        process.exit(1);
    }

    const tzoffset = Number(pilots[0].tzoffset) || 0;
    // Anchor on the datecode's 10am-local-time (via fromDateCode → reference
    // timestamp that falls inside the desired day). competitionStartTs then
    // returns the UTC epoch for that 10am boundary.
    const dayMidday = new Date(fromDateCode(datecode)).getTime() / 1000 + 12 * 3600;
    const since = competitionStartTs(tzoffset, dayMidday);
    const until = since + 24 * 3600;
    const messageQueue: any[] = [];

    const glider: Aircraft = {
        compno,
        className,
        trackers: pilots[0].trackerid.split(',') as any[],
        datecode,
        tzoffset,
        stationary: 0,
        ground: false,
        lastTick: 0 as Epoch,
        receiveNewPoints: false,
        log: () => {},
        messages: []
    };

    const trackerList = [...new Set(glider.trackers)];
    for (const id of trackerList) {
        for await (const msg of loadPoints({flarmId: id as FlarmID, since, until})) {
            const m = msg as any;
            if (typeof m.d === 'number' && m.d > 1200) continue;
            m.c = compno;
            messageQueue.push(m);
        }
    }

    console.error(`Loaded ${messageQueue.length} track points for ${compno}`);

    // Sort by time
    messageQueue.sort((a, b) => a.t - b.t);

    let trackPoints = messageQueue;

    if (argv.simplify) {
        const simplifiedQueue: any[] = [];
        glider.messages = messageQueue;
        glider.channel = {
            postMessage: (a) => simplifiedQueue.push({...a, _: false})
        } as any;
        await processMessageQueue(glider);
        if (simplifiedQueue.length) {
            simplifiedQueue.at(-1)._ = true;
        }
        console.error(`Simplified ${messageQueue.length} -> ${simplifiedQueue.length} points`);
        trackPoints = simplifiedQueue;
    }

    // Build KML
    const kml = buildKML(task, trackPoints, compno, className, datecode, argv.gap);

    if (argv.output) {
        fs.writeFileSync(argv.output, kml);
        console.error(`Written to ${argv.output}`);
    } else {
        process.stdout.write(kml);
    }

    await mysql.end();
    process.exit(0);
}

/** Split a sorted point array into segments at time gaps > maxGap seconds. */
function splitAtGaps(points: any[], maxGap: number): any[][] {
    if (!points.length) return [];
    const segments: any[][] = [[points[0]]];
    for (let i = 1; i < points.length; i++) {
        if (points[i].t - points[i - 1].t > maxGap) {
            segments.push([]);
        }
        segments.at(-1)!.push(points[i]);
    }
    return segments;
}

function buildKML(task: Task, points: any[], compno: Compno, className: ClassName, datecode: Datecode, maxGap: number = 60): string {
    const lines: string[] = [];

    lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    lines.push(`<kml xmlns="http://www.opengis.net/kml/2.2">`);
    lines.push(`<Document>`);
    lines.push(`<name>${esc(className)} ${esc(compno)} - ${esc(datecode)}</name>`);

    // Styles
    lines.push(`<Style id="track"><LineStyle><color>ff0000ff</color><width>2</width></LineStyle></Style>`);
    lines.push(`<Style id="taskline"><LineStyle><color>ff00ffff</color><width>2</width></LineStyle></Style>`);
    lines.push(`<Style id="sector"><LineStyle><color>ff00ff00</color><width>1</width></LineStyle><PolyStyle><color>4000ff00</color></PolyStyle></Style>`);
    lines.push(`<Style id="line_oz"><LineStyle><color>ffff00ff</color><width>3</width></LineStyle></Style>`);
    lines.push(`<Style id="tp"><IconStyle><scale>0.8</scale></IconStyle></Style>`);

    // --- Task folder ---
    lines.push(`<Folder><name>Task</name>`);

    // Task course line
    const coursePts = task.legs.map((l) => `${l.nlng},${l.nlat},0`).join(' ');
    lines.push(`<Placemark><name>Course</name><styleUrl>#taskline</styleUrl>`);
    lines.push(`<LineString><tessellate>1</tessellate><coordinates>${coursePts}</coordinates></LineString></Placemark>`);

    // Turnpoint placemarks + observation zones
    for (const [i, leg] of task.legs.entries()) {
        // TP marker
        lines.push(`<Placemark><name>TP${i} ${esc(leg.name || leg.ntrigraph || '')}</name><styleUrl>#tp</styleUrl>`);
        lines.push(`<Point><coordinates>${leg.nlng},${leg.nlat},0</coordinates></Point></Placemark>`);

        // OZ geometry from PreparedTurnpoint
        const pl = task.preparedLegs?.[i];
        if (pl) {
            const gj = pl.toGeoJSON();
            if (gj.geometry.type === 'LineString') {
                const coords = gj.geometry.coordinates.map((c) => `${c[0]},${c[1]},0`).join(' ');
                lines.push(`<Placemark><name>Line ${i}</name><styleUrl>#line_oz</styleUrl>`);
                lines.push(`<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>`);
            } else if (gj.geometry.type === 'Polygon') {
                const ring = gj.geometry.coordinates[0].map((c) => `${c[0]},${c[1]},0`).join(' ');
                lines.push(`<Placemark><name>Sector ${i}</name><styleUrl>#sector</styleUrl>`);
                lines.push(`<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
            }
        }
    }
    lines.push(`</Folder>`);

    // --- Track folder ---
    lines.push(`<Folder><name>Track ${esc(compno)}</name>`);

    const segments = splitAtGaps(points, maxGap);
    for (const [si, seg] of segments.entries()) {
        const label = segments.length > 1 ? ` seg${si + 1}` : '';
        const trackCoords = seg.map((p) => `${p.lng},${p.lat},${p.a || 0}`).join(' ');
        lines.push(`<Placemark><name>${esc(compno)}${label}</name><styleUrl>#track</styleUrl>`);
        lines.push(`<LineString><altitudeMode>absolute</altitudeMode><coordinates>${trackCoords}</coordinates></LineString></Placemark>`);

        // Time-annotated track (gx:Track) for timeline scrubbing
        lines.push(`<Placemark><name>${esc(compno)}${label} timed</name>`);
        lines.push(`<gx:Track xmlns:gx="http://www.google.com/kml/ext/2.2">`);
        lines.push(`<altitudeMode>absolute</altitudeMode>`);
        for (const p of seg) {
            lines.push(`<when>${new Date(p.t * 1000).toISOString()}</when>`);
        }
        for (const p of seg) {
            lines.push(`<gx:coord>${p.lng} ${p.lat} ${p.a || 0}</gx:coord>`);
        }
        lines.push(`</gx:Track></Placemark>`);
    }

    lines.push(`</Folder>`);
    lines.push(`</Document></kml>`);
    return lines.join('\n');
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getTask(className: ClassName, datecode: Datecode): Promise<Task | null> {
    const taskdetails = ((await mysql.query<any[]>(escape`
        SELECT
            tasks.*,
            time_to_sec(tasks.duration) durationsecs,
            c.grandprixstart, c.handicapped, c.Dm,
            cd.calendardate, cd.status, cd.info,
            0 AS distance,
            CASE
                WHEN COALESCE(nostart, '00:00:00') = '00:00:00' THEN 0
                ELSE UNIX_TIMESTAMP(CONCAT(${fromDateCode(datecode)}, ' ', nostart))
                     - (SELECT tzoffset FROM competition)
            END nostartutc
        FROM tasks, classes c, contestday cd
        WHERE tasks.datecode = ${datecode}
            AND tasks.class = c.class
            AND cd.class = c.class AND cd.datecode = ${datecode}
            AND tasks.class = ${className}
            AND tasks.flown = 'Y'
    `)) || {})[0];

    if (!taskdetails || !taskdetails.type) {
        return null;
    }

    const tasklegs = await mysql.query<any[]>(escape`
        SELECT taskleg.*, nname name FROM taskleg
        WHERE taskleg.taskid = ${taskdetails.taskid}
        ORDER BY legno
    `);

    if (tasklegs.length < 2) return null;

    const task: Task = {
        rules: {
            grandprixstart: taskdetails.type == 'G' || taskdetails.type == 'E' || taskdetails.grandprixstart == 'Y',
            nostartutc: taskdetails.nostartutc,
            aat: taskdetails.type == 'A',
            dh: taskdetails.type == 'D' || taskdetails.handicapped == 'D',
            dm: taskdetails.Dm ?? undefined,
            handicapped: taskdetails.handicapped == 'Y' || taskdetails.type == 'D' || taskdetails.handicapped == 'D',
            maxHandicap: 100
        },
        details: taskdetails,
        legs: tasklegs
    };
    calculateTask(task);
    return task;
}
