//
// findtrackers — CLI wrapper around lib/scoring/shared/findtrackers.
//
// For one or more competitions, replay the day's APRS log against each
// flown task's start and finish lines and report flarm IDs whose crossing
// times match a pilot's pilotresult.start/finish to within `--tolerance`.
//
// Read-only: never writes to the DB.
//

import type {Compno, ClassName, Datecode, Epoch, Task, FlarmID} from '../lib/types';
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
    .usage('$0 [--compid <id> | --all] [--datecode <dc>] [--class <cls>] [--tolerance <sec>] [--include-known]')
    .option('compid', {type: 'string', describe: 'single competition id'})
    .option('all', {type: 'boolean', describe: 'every active competition (start ≤ today ≤ end)'})
    .option('datecode', {type: 'string', describe: 'limit to one datecode'})
    .option('class', {type: 'string', describe: 'limit to one class'})
    .option('tolerance', {type: 'number', default: 5, describe: 'max |Δstart| and |Δfinish| in seconds'})
    .option('include-known', {type: 'boolean', default: false, describe: 'also match pilots whose tracker.trackerid is already set (sanity check)'})
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
    const includeKnown = !!argv['include-known'];

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

        const excludeFlarmids = includeKnown ? new Set<FlarmID>() : await loadKnownTrackers(className);

        const matches = await findTrackerMatches({
            task,
            results,
            toleranceSec: tolerance,
            excludeFlarmids,
            log: (m) => console.log(`  ${m}`)
        });

        printMatches(results, matches);

        const matchedCompnos = new Set(matches.filter((m) => !m.ambiguous).map((m) => m.compno));
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

async function loadKnownTrackers(className: ClassName): Promise<Set<FlarmID>> {
    const rows = await mysql.query<{trackerid: string}[]>(escape`
        SELECT trackerid FROM tracker
         WHERE class = ${className}
           AND trackerid IS NOT NULL
           AND trackerid <> ''
           AND trackerid <> 'unknown'
           AND trackerid <> 'blocked'
    `);
    const out = new Set<FlarmID>();
    for (const r of rows) {
        // tracker.trackerid is comma-separated for backup units
        for (const id of r.trackerid.split(',')) {
            const t = id.trim();
            if (t) out.add(t as FlarmID);
        }
    }
    return out;
}

function fmtDelta(d: number): string {
    const sign = d >= 0 ? '+' : '−';
    return `${sign}${Math.abs(d).toFixed(1)}s`;
}

function printMatches(results: OfficialResult[], matches: TrackerMatch[]): void {
    if (!matches.length) {
        console.log(`  (no matches)`);
        return;
    }
    // Group by compno so we can print all candidates for an ambiguous pilot together.
    const byPilot = new Map<Compno, TrackerMatch[]>();
    for (const m of matches) {
        const arr = byPilot.get(m.compno) ?? [];
        arr.push(m);
        byPilot.set(m.compno, arr);
    }

    // Sort compnos by best confidence
    const compnos = Array.from(byPilot.keys()).sort((a, b) => {
        const ba = Math.min(...byPilot.get(a)!.map((x) => x.confidence));
        const bb = Math.min(...byPilot.get(b)!.map((x) => x.confidence));
        return ba - bb;
    });

    for (const compno of compnos) {
        const arr = byPilot.get(compno)!.sort((a, b) => a.confidence - b.confidence);
        const r = results.find((x) => x.compno === compno);
        const name = arr[0].name || (r?.name ?? '');
        const ambTag = arr[0].ambiguous ? `   (ambiguous: ${arr.length} candidate${arr.length === 1 ? '' : 's'})` : '';
        console.log(`  ${String(compno).padEnd(4)} ${name}${ambTag}`);
        for (const m of arr) {
            const cur = m.currentTrackerid && m.currentTrackerid !== 'unknown' ? `   (current trackerid: ${m.currentTrackerid})` : m.currentTrackerid === 'unknown' ? `   (current trackerid: unknown)` : '';
            console.log(`       flarmid: ${m.flarmid}   Δstart: ${fmtDelta(m.deltaStart)}   Δfinish: ${fmtDelta(m.deltaFinish)}   confidence: ${m.confidence.toFixed(1)}s${cur}`);
        }
    }
}
