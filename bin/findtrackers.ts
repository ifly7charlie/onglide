//
// findtrackers — CLI wrapper around lib/scoring/shared/findtrackers.
//
// For one or more competitions, replay the day's APRS log against each
// flown task's start and finish lines and report flarm IDs whose crossing
// times match a pilot's pilotresult.start/finish to within `--tolerance`.
//
// Read-only: never writes to the DB.
//

import type {Compno, ClassName, Datecode, Epoch, FlarmID, Task} from '../lib/types';
import {calculateTask} from '../lib/flightprocessing/taskhelper';
import {fromDateCode} from '../lib/datecode';
import {findTrackerMatches, type OfficialResult, type TrackerMatch} from '../lib/scoring/shared/findtrackers';

import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

dotenv.config({path: '.env.local'});

const argv = yargs(hideBin(process.argv))
    .scriptName('findtrackers')
    .usage('$0 [--compid <id> | --all] [--datecode <dc>] [--class <cls>] [--tolerance <sec>]')
    .option('compid', {type: 'string', describe: 'single competition id'})
    .option('all', {type: 'boolean', describe: 'every active competition (start ≤ today ≤ end)'})
    .option('datecode', {type: 'string', describe: 'limit to one datecode'})
    .option('class', {type: 'string', describe: 'limit to one class'})
    .option('tolerance', {type: 'number', default: 5, describe: 'max |Δstart| and |Δfinish| in seconds'})
    .option('max-gap', {type: 'number', describe: 'override max-gap (s) between consecutive points; pairs wider than this are skipped (default 60)'})
    .option('reorder-window', {type: 'number', describe: 'override per-flarmid reorder-buffer / stale-drop window (s) (default 20)'})
    .option('debug-flarmid', {type: 'string', array: true, default: [], describe: 'trace one or more flarmids through the scan (repeatable)'})
    .option('debug-compno', {type: 'string', array: true, default: [], describe: 'trace the assigned trackerid(s) of one or more compnos (repeatable)'})
    .check((a) => {
        if (!a.compid && !a.all) throw new Error('specify --compid <id> or --all');
        if (a.compid && a.all) throw new Error('--compid and --all are mutually exclusive');
        return true;
    })
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
    onError: (e: unknown) => console.error(e),
    onConnectError: (x: unknown) => console.error('mysql connect error', x),
    maxRetries: 2,
    connUtilization: 0.2
});

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

interface Job {
    compid: string;
    className: ClassName;
    datecode: Datecode;
}

async function main() {
    const tolerance = Number(argv.tolerance) || 5;
    const debugFlarmidsArg = new Set<string>();
    for (const id of (argv['debug-flarmid'] as string[]) || []) {
        for (const part of String(id).split(',')) {
            const t = part.trim();
            if (t) debugFlarmidsArg.add(t);
        }
    }
    const debugCompnosArg = new Set<string>();
    for (const c of (argv['debug-compno'] as string[]) || []) {
        for (const part of String(c).split(',')) {
            const t = part.trim();
            if (t) debugCompnosArg.add(t.toUpperCase());
        }
    }

    const compids = await pickCompetitions();
    if (!compids.length) {
        console.error('No competitions matched.');
        process.exit(1);
    }

    const jobs: Job[] = [];
    for (const compid of compids) {
        for (const j of await listJobs(compid)) jobs.push(j);
    }
    if (!jobs.length) {
        console.error('No (class, datecode) pairs with a flown task and pilotresult start+finish.');
        process.exit(1);
    }

    let totalPilots = 0,
        totalMatched = 0,
        totalAmbiguous = 0;

    for (const job of jobs) {
        const {compid, className, datecode} = job;
        console.log(`\n=== ${className} / ${datecode}   (compid ${compid}, ${fromDateCode(datecode)}) ===`);

        const task = await getTask(className, datecode);
        if (!task) {
            console.log(`  (no task — skipped)`);
            continue;
        }

        const results = await loadOfficialResults(className, datecode);
        if (!results.length) {
            console.log(`  (no pilotresult rows with start+finish — skipped)`);
            continue;
        }

        const debugFlarmids = new Set<FlarmID>(debugFlarmidsArg as Set<FlarmID>);
        for (const r of results) {
            if (!debugCompnosArg.has(String(r.compno).toUpperCase())) continue;
            for (const id of r.trackerid.split(',')) {
                const t = id.trim();
                const lc = t.toLowerCase();
                if (!t || lc === 'unknown' || lc === 'blocked') continue;
                debugFlarmids.add(t as FlarmID);
            }
        }
        if (debugFlarmids.size) console.log(`  debug flarmids for this scan: ${Array.from(debugFlarmids).join(', ')}`);

        const matches = await findTrackerMatches({
            task,
            results,
            toleranceSec: tolerance,
            maxGapSec: argv['max-gap'] != null ? Number(argv['max-gap']) : undefined,
            reorderWindowSec: argv['reorder-window'] != null ? Number(argv['reorder-window']) : undefined,
            log: (m) => console.log(`  ${m}`),
            debugFlarmids: debugFlarmids.size ? debugFlarmids : undefined
        });

        printMatches(results, matches);

        const matchedCompnos = new Set(matches.filter((m) => m.withinTolerance && !m.ambiguous).map((m) => m.compno));
        const ambiguousCompnos = new Set(matches.filter((m) => m.ambiguous).map((m) => m.compno));
        totalPilots += results.length;
        totalMatched += matchedCompnos.size;
        totalAmbiguous += ambiguousCompnos.size;
        console.log(`  Summary: ${results.length} pilots, ${matchedCompnos.size} matched, ${ambiguousCompnos.size} ambiguous`);
    }

    console.log(`\n=== Total: ${totalPilots} pilots, ${totalMatched} matched, ${totalAmbiguous} ambiguous ===`);
    await mysql.end();
    process.exit(0);
}

async function pickCompetitions(): Promise<string[]> {
    if (argv.compid) return [String(argv.compid)];
    const rows = await mysql.query<{compid: string}[]>(escape`
        SELECT compid FROM competition
        WHERE (start IS NULL OR start <= CURDATE())
          AND (end   IS NULL OR end   >= CURDATE())
        ORDER BY start DESC, compid ASC
    `);
    return rows.map((r) => r.compid);
}

async function listJobs(compid: string): Promise<Job[]> {
    const filterClass = argv.class ? escape` AND cl.class = ${argv.class}` : escape``;
    const filterDc = argv.datecode ? escape` AND t.datecode = ${argv.datecode}` : escape``;
    const rows = await mysql.query<{class: ClassName; datecode: Datecode}[]>(escape`
        SELECT DISTINCT cl.class AS class, t.datecode AS datecode
          FROM tasks t
          JOIN classes cl ON cl.class = t.class
         WHERE cl.compid = ${compid}
           AND t.flown = 'Y'
           AND EXISTS (
               SELECT 1 FROM pilotresult pr
                WHERE pr.class    = cl.class
                  AND pr.datecode = t.datecode
                  AND pr.start  IS NOT NULL AND pr.start  <> '00:00:00'
                  AND pr.finish IS NOT NULL AND pr.finish <> '00:00:00'
           )
    `.append(filterClass).append(filterDc).append(escape` ORDER BY t.datecode DESC, cl.class ASC`));
    return rows.map((r) => ({compid, className: r.class, datecode: r.datecode}));
}

// Lifted from bin/exporttrack.ts:240. Returns a fully-prepared Task.
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

    if (!taskdetails || !taskdetails.type) return null;

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

async function loadOfficialResults(className: ClassName, datecode: Datecode): Promise<OfficialResult[]> {
    const date = fromDateCode(datecode);
    const rows = await mysql.query<
        {
            compno: Compno;
            firstname: string;
            lastname: string;
            startUtc: number;
            finishUtc: number;
            trackerid: string;
        }[]
    >(escape`
        SELECT pr.compno                                                    AS compno,
               COALESCE(p.firstname, '')                                    AS firstname,
               COALESCE(p.lastname,  '')                                    AS lastname,
               UNIX_TIMESTAMP(CONCAT(${date}, ' ', pr.start))  - c.tzoffset AS startUtc,
               UNIX_TIMESTAMP(CONCAT(${date}, ' ', pr.finish)) - c.tzoffset AS finishUtc,
               COALESCE(t.trackerid, '')                                    AS trackerid
          FROM pilotresult pr
          JOIN pilots      p  ON p.class   = pr.class AND p.compno = pr.compno
          JOIN classes     cl ON cl.class  = pr.class
          JOIN competition c  ON c.compid  = cl.compid
          LEFT JOIN tracker t ON t.class   = pr.class AND t.compno = pr.compno
         WHERE pr.class    = ${className}
           AND pr.datecode = ${datecode}
           AND pr.start    IS NOT NULL AND pr.start  <> '00:00:00'
           AND pr.finish   IS NOT NULL AND pr.finish <> '00:00:00'
    `);
    return rows.map((r) => ({
        compno: r.compno,
        name: `${r.firstname} ${r.lastname}`.trim() || String(r.compno),
        trackerid: r.trackerid,
        startUtc: Number(r.startUtc) as Epoch,
        finishUtc: Number(r.finishUtc) as Epoch
    }));
}

function fmtDelta(d: number | null): string {
    if (d === null) return '   n/a';
    const sign = d >= 0 ? '+' : '−';
    return `${sign}${Math.abs(d).toFixed(1)}s`;
}

function fmtConfidence(c: number | null): string {
    return c === null ? 'n/a' : `${c.toFixed(1)}s`;
}

function rowTag(m: TrackerMatch): string {
    if (m.confidence === null) return m.skipped ? '[assigned, skipped: out-of-area]' : '[assigned, no crossings]';
    if (m.assigned && m.withinTolerance) return '[assigned ✓]';
    if (m.assigned) return '[assigned, outside tolerance]';
    if (m.withinTolerance) return '[match]';
    return '';
}

function pilotHeaderTag(rows: TrackerMatch[]): string {
    const flags: string[] = [];
    const assignedRow = rows.find((m) => m.assigned);
    if (assignedRow && !assignedRow.withinTolerance) {
        if (assignedRow.skipped) flags.push('assigned ID skipped (first sighting out of task area)');
        else if (assignedRow.confidence === null) flags.push('assigned ID has no crossings');
        else flags.push('assigned ID outside tolerance');
    }
    const altMatch = rows.find((m) => m.withinTolerance && !m.assigned);
    if (assignedRow && !assignedRow.withinTolerance && altMatch) flags.push('alternative match found');
    if (rows.some((m) => m.ambiguous)) flags.push('ambiguous');
    return flags.length ? `   ⚠ ${flags.join('; ')}` : '';
}

function printMatches(results: OfficialResult[], matches: TrackerMatch[]): void {
    if (!matches.length) {
        console.log(`  (no matches, no assigned-tracker reports)`);
        return;
    }
    // Group by compno
    const byPilot = new Map<Compno, TrackerMatch[]>();
    for (const m of matches) {
        const arr = byPilot.get(m.compno) ?? [];
        arr.push(m);
        byPilot.set(m.compno, arr);
    }

    // Sort compnos: pilots needing attention (assigned-outside-tolerance,
    // ambiguous, no-crossings-for-assigned) first; within each bucket by
    // best within-tolerance confidence ascending.
    const compnos = Array.from(byPilot.keys()).sort((a, b) => {
        const ra = bucket(byPilot.get(a)!);
        const rb = bucket(byPilot.get(b)!);
        if (ra !== rb) return ra - rb;
        const ca = bestConfidence(byPilot.get(a)!);
        const cb = bestConfidence(byPilot.get(b)!);
        return ca - cb;
    });

    for (const compno of compnos) {
        const arr = byPilot.get(compno)!;
        const r = results.find((x) => x.compno === compno);
        const name = arr[0].name || (r?.name ?? '');
        console.log(`  ${String(compno).padEnd(4)} ${name}${pilotHeaderTag(arr)}`);
        for (const m of arr) {
            const tag = rowTag(m);
            const tagPart = tag ? `   ${tag}` : '';
            console.log(`       flarmid: ${m.flarmid}   Δstart: ${fmtDelta(m.deltaStart)}   Δfinish: ${fmtDelta(m.deltaFinish)}   confidence: ${fmtConfidence(m.confidence)}${tagPart}`);
        }
    }
}

function bucket(rows: TrackerMatch[]): number {
    // 0 = needs attention (assigned outside tolerance, or ambiguous)
    // 1 = unknown pilot with a within-tolerance match
    // 2 = clean (assigned ✓ only)
    const hasAssigned = rows.some((m) => m.assigned);
    const assignedBad = rows.some((m) => m.assigned && !m.withinTolerance);
    const anyAmbig = rows.some((m) => m.ambiguous);
    if (anyAmbig || assignedBad) return 0;
    if (!hasAssigned) return 1;
    return 2;
}

function bestConfidence(rows: TrackerMatch[]): number {
    let best = Infinity;
    for (const m of rows) if (m.confidence !== null && m.confidence < best) best = m.confidence;
    return best;
}
