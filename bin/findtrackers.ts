//
// findtrackers — CLI wrapper around lib/scoring/shared/findtrackers.
//
// For one or more competitions, replay the day's APRS log against each
// flown task's start and finish lines and report flarm IDs whose crossing
// times match a pilot's pilotresult.start/finish to within `--tolerance`.
//
// After reporting, prompts the operator to associate / disassociate
// trackers for any pilot whose assigned tracker is out of tolerance, or
// who has an unambiguous within-tolerance alternative — same y/n/a/q
// flow as bin/matchtrackers. Pass `--dry-run` to skip prompts entirely.
//

import type {Compno, ClassName, Datecode, Epoch, FlarmID, Task} from '../lib/types';
import {calculateTask} from '../lib/flightprocessing/taskhelper';
import {fromDateCode} from '../lib/datecode';
import {findTrackerMatches, type OfficialResult, type TrackerMatch, type TrackerDiag} from '../lib/scoring/shared/findtrackers';

import prompts from 'prompts';
import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

dotenv.config({path: '.env.local'});

const argv = yargs(hideBin(process.argv))
    .scriptName('findtrackers')
    .usage('$0 [--compid <id> | --all] [--datecode <dc>] [--class <cls>] [--tolerance <sec>] [--dry-run | --yes]')
    .option('compid', {type: 'string', describe: 'single competition id'})
    .option('all', {type: 'boolean', describe: 'every active competition (start ≤ today ≤ end)'})
    .option('datecode', {type: 'string', describe: 'limit to one datecode'})
    .option('class', {type: 'string', describe: 'limit to one class'})
    .option('tolerance', {type: 'number', default: 5, describe: 'max |Δstart| and |Δfinish| in seconds'})
    .option('max-gap', {type: 'number', describe: 'override max-gap (s) between consecutive points; pairs wider than this are skipped (default 60)'})
    .option('reorder-window', {type: 'number', describe: 'override per-flarmid reorder-buffer / stale-drop window (s) (default 20)'})
    .option('debug-flarmid', {type: 'string', array: true, default: [], describe: 'trace one or more flarmids through the scan (repeatable)'})
    .option('debug-compno', {type: 'string', array: true, default: [], describe: 'trace the assigned trackerid(s) of one or more compnos (repeatable)'})
    .option('dry-run', {type: 'boolean', default: false, describe: 'report only — never prompt or write to the DB'})
    .option('yes', {type: 'boolean', default: false, describe: 'apply every proposed change without prompting'})
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

type JobGroup = Job[]; // all classes for one (compid, datecode)

interface ClassMatches {
    job: Job;
    results: OfficialResult[];
    matches: TrackerMatch[];
}

// A flarmid → pilots that produced a clean (within-tolerance, non-ambiguous)
// phase-1 match in any class of the same (compid, datecode). Used to surface
// "this assigned tracker actually matches a pilot in another class" — the
// case where a flarm unit was moved between gliders during a comp.
interface CrossClassHit {
    className: ClassName;
    compno: Compno;
    name: string;
}
type CrossClassMap = Map<FlarmID, CrossClassHit[]>;

interface GroupSummary {
    pilots: number;
    matched: number;
    ambiguous: number;
    proposed: number;
    applied: number;
}

function groupJobs(jobs: Job[]): JobGroup[] {
    const map = new Map<string, JobGroup>();
    for (const j of jobs) {
        const key = `${j.compid}|${j.datecode}`;
        const arr = map.get(key) ?? [];
        arr.push(j);
        map.set(key, arr);
    }
    return Array.from(map.values());
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

    const interactive = !argv['dry-run'] && !argv.yes;
    if (argv['dry-run']) console.log('(--dry-run: no prompts, no DB writes)');
    else if (argv.yes) console.log('(--yes: every proposed change will be applied without prompting)');

    let totalPilots = 0,
        totalMatched = 0,
        totalAmbiguous = 0,
        totalProposed = 0,
        totalApplied = 0;

    for (const group of groupJobs(jobs)) {
        const s = await processGroup(group, debugFlarmidsArg, debugCompnosArg, tolerance, interactive);
        totalPilots += s.pilots;
        totalMatched += s.matched;
        totalAmbiguous += s.ambiguous;
        totalProposed += s.proposed;
        totalApplied += s.applied;
    }

    console.log(`\n=== Total: ${totalPilots} pilots, ${totalMatched} matched, ${totalAmbiguous} ambiguous, ${totalProposed} change${totalProposed === 1 ? '' : 's'} proposed, ${totalApplied} applied ===`);
    await mysql.end();
    process.exit(0);
}

// Run scans for every class in a (compid, datecode) group, then build the
// cross-class flarmid map and do per-class print/proposal in a second pass.
// Two-pass is required: a flarmid that's been moved from class A to class B
// only gets flagged as cross-class once both classes have been scanned.
async function processGroup(group: JobGroup, debugFlarmidsArg: Set<string>, debugCompnosArg: Set<string>, tolerance: number, interactive: boolean): Promise<GroupSummary> {
    // Pass 1 — scan each class.
    const classMatches: ClassMatches[] = [];
    for (const job of group) {
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

        classMatches.push({job, results, matches});
    }

    // Pass 2 — flarmid → unambiguous within-tolerance hits across the group.
    const crossClass: CrossClassMap = new Map();
    for (const cm of classMatches) {
        for (const m of cm.matches) {
            if (!m.withinTolerance || m.ambiguous) continue;
            const arr = crossClass.get(m.flarmid) ?? [];
            arr.push({className: cm.job.className, compno: m.compno, name: m.name});
            crossClass.set(m.flarmid, arr);
        }
    }

    // Pass 3 — per-class results and proposals.
    const summary: GroupSummary = {pilots: 0, matched: 0, ambiguous: 0, proposed: 0, applied: 0};
    const multi = classMatches.length > 1;
    for (const cm of classMatches) {
        const {job, results, matches} = cm;
        const {className, datecode} = job;

        if (multi) console.log(`\n--- ${className} / ${datecode} — results ---`);

        if (!interactive) printMatches(results, matches, crossClass, className);

        const matchedCompnos = new Set(matches.filter((m) => m.withinTolerance && !m.ambiguous).map((m) => m.compno));
        const ambiguousCompnos = new Set(matches.filter((m) => m.ambiguous).map((m) => m.compno));
        summary.pilots += results.length;
        summary.matched += matchedCompnos.size;
        summary.ambiguous += ambiguousCompnos.size;
        console.log(`  Summary: ${results.length} pilots, ${matchedCompnos.size} matched, ${ambiguousCompnos.size} ambiguous`);

        if (argv['dry-run']) continue;

        const proposals = computeProposals(matches, crossClass, className);
        if (!proposals.length) continue;
        summary.proposed += proposals.length;

        const accepted = interactive //
            ? await reviewProposals(proposals, matches, results, crossClass, className)
            : proposals;
        if (!accepted.length) continue;

        const applied = await applyProposals(className, accepted);
        summary.applied += applied;
    }
    return summary;
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
    const rows = await mysql.query<{class: ClassName; datecode: Datecode}[]>(
        escape`
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
    `
            .append(filterClass)
            .append(filterDc)
            .append(escape` ORDER BY t.datecode DESC, cl.class ASC`)
    );
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

function fmtUtcHms(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(11, 19);
}

function fmtDiag(diag: TrackerDiag): string {
    if (diag.inBboxPackets === 0 && diag.bboxRejectedPackets === 0) {
        return 'not seen in scan window';
    }
    const parts: string[] = [];
    if (diag.inBboxPackets === 0) {
        parts.push(`${diag.bboxRejectedPackets} packets all outside task area`);
    } else if (diag.bboxRejectedPackets > 0) {
        parts.push(`${diag.inBboxPackets} in-area + ${diag.bboxRejectedPackets} outside`);
    } else {
        parts.push(`${diag.inBboxPackets} packets in-area`);
    }
    if (diag.minDistanceKm !== null) parts.push(`closest ${diag.minDistanceKm.toFixed(1)} km from TP`);
    if (diag.avgGapSec !== null) {
        const max = diag.maxGapSec !== null ? `, max ${diag.maxGapSec}s` : '';
        parts.push(`avg gap ${diag.avgGapSec.toFixed(0)}s${max}`);
    }
    if (diag.firstSeenT !== null && diag.lastSeenT !== null) {
        parts.push(`span ${fmtUtcHms(diag.firstSeenT)}-${fmtUtcHms(diag.lastSeenT)}`);
    }
    if (diag.gapAroundStartSec !== null) parts.push(`gap @ start: ${diag.gapAroundStartSec}s`);
    if (diag.gapAroundFinishSec !== null) parts.push(`gap @ finish: ${diag.gapAroundFinishSec}s`);
    return parts.join('  |  ');
}

function rowTag(m: TrackerMatch): string {
    if (m.confidence === null) {
        if (m.bboxOnly) return '[assigned, all packets outside task area — wrong tracker]';
        if (m.skipped) return '[assigned, skipped: out-of-area]';
        return '[assigned, no crossings]';
    }
    if (m.assigned && m.withinTolerance) return '[assigned ✓]';
    if (m.assigned) return '[assigned, outside tolerance]';
    if (m.withinTolerance) return '[match]';
    return '';
}

function pilotHeaderTag(rows: TrackerMatch[]): string {
    const flags: string[] = [];
    const assignedRow = rows.find((m) => m.assigned);
    if (assignedRow && !assignedRow.withinTolerance) {
        if (assignedRow.bboxOnly) flags.push('assigned ID flying outside task area (wrong tracker)');
        else if (assignedRow.skipped) flags.push('assigned ID skipped (first sighting out of task area)');
        else if (assignedRow.confidence === null) flags.push('assigned ID has no crossings');
        else flags.push('assigned ID outside tolerance');
    }
    const altMatch = rows.find((m) => m.withinTolerance && !m.assigned);
    if (assignedRow && !assignedRow.withinTolerance && altMatch) flags.push('alternative match found');
    if (rows.some((m) => m.ambiguous)) flags.push('ambiguous');
    return flags.length ? `   ⚠ ${flags.join('; ')}` : '';
}

function describeCrossClass(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined): string[] {
    if (!crossClass) return [];
    const all = crossClass.get(flarmid);
    if (!all) return [];
    return all
        .filter((h) => h.className !== thisClass)
        .map((h) => `also matches ${String(h.compno).trim()} ${h.name}`.trim() + ` in class ${h.className}`);
}

function printMatches(results: OfficialResult[], matches: TrackerMatch[], crossClass?: CrossClassMap, thisClass?: ClassName): void {
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
        printPilotMatches(compno, byPilot.get(compno)!, results, crossClass, thisClass);
    }
}

function printPilotMatches(compno: Compno, arr: TrackerMatch[], results: OfficialResult[], crossClass?: CrossClassMap, thisClass?: ClassName): void {
    if (!arr.length) return;
    const r = results.find((x) => x.compno === compno);
    const name = arr[0].name || (r?.name ?? '');
    console.log(`  ${String(compno).padEnd(4)} ${name}${pilotHeaderTag(arr)}`);
    for (const m of arr) {
        const tag = rowTag(m);
        const tagPart = tag ? `   ${tag}` : '';
        console.log(`       flarmid: ${m.flarmid}   Δstart: ${fmtDelta(m.deltaStart)}   Δfinish: ${fmtDelta(m.deltaFinish)}   confidence: ${fmtConfidence(m.confidence)}${tagPart}`);
        if (m.diag) console.log(`         · ${fmtDiag(m.diag)}`);
        if (thisClass) {
            for (const line of describeCrossClass(m.flarmid, thisClass, crossClass)) {
                console.log(`         ↳ ${line}`);
            }
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

interface Proposal {
    compno: Compno;
    name: string;
    currentTrackerid: string;
    newTrackerid: string;
    addedIds: FlarmID[];
    removedIds: FlarmID[];
    reason: string;
}

function parseCurrentIds(raw: string): FlarmID[] {
    const out: FlarmID[] = [];
    if (!raw) return out;
    for (const part of raw.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const lc = t.toLowerCase();
        if (lc === 'unknown' || lc === 'blocked') continue;
        out.push(t as FlarmID);
    }
    return out;
}

function computeProposals(matches: TrackerMatch[], crossClass: CrossClassMap, thisClass: ClassName): Proposal[] {
    const byPilot = new Map<Compno, TrackerMatch[]>();
    for (const m of matches) {
        const arr = byPilot.get(m.compno) ?? [];
        arr.push(m);
        byPilot.set(m.compno, arr);
    }

    const out: Proposal[] = [];
    for (const [compno, rows] of byPilot) {
        // Already-good assignment: leave alone even if alternatives exist.
        if (rows.some((m) => m.assigned && m.withinTolerance)) continue;

        // Pilot is structurally ambiguous (concurrent-times group, multi
        // candidate, or multi pilot per flarmid) — every diagnosis is
        // unsafe, including "remove the assigned tracker". Skip entirely.
        if (rows.some((m) => m.ambiguous)) continue;

        const altMatches = rows.filter((m) => !m.assigned && m.withinTolerance && !m.ambiguous);
        const assignedBad = rows.filter((m) => m.assigned && !m.withinTolerance);
        if (!altMatches.length && !assignedBad.length) continue;
        // Multiple non-assigned candidates within tolerance — can't pick one safely.
        if (altMatches.length > 1) continue;

        const first = rows[0];
        const currentIds = parseCurrentIds(first.currentTrackerid);
        const removeIds = new Set<FlarmID>(assignedBad.map((m) => m.flarmid));
        const addId: FlarmID | null = altMatches[0]?.flarmid ?? null;

        const newIds: FlarmID[] = [];
        for (const id of currentIds) if (!removeIds.has(id)) newIds.push(id);
        if (addId && !newIds.includes(addId)) newIds.push(addId);

        const newTrackerid = newIds.length ? newIds.join(',') : 'unknown';
        if (newTrackerid === first.currentTrackerid) continue;

        const baseReason = addId //
            ? assignedBad.length
                ? 'switch to within-tolerance alternative'
                : 'associate within-tolerance match'
            : 'assigned tracker outside tolerance, no alternative match';

        // Annotate the reason with any cross-class hits for the flarmids
        // we're removing — strong evidence the tracker is now flying with
        // a pilot in another class.
        const crossInfo: string[] = [];
        for (const id of removeIds) {
            for (const line of describeCrossClass(id, thisClass, crossClass)) {
                crossInfo.push(`${id} ${line}`);
            }
        }
        const reason = crossInfo.length ? `${baseReason}; ${crossInfo.join('; ')}` : baseReason;

        out.push({
            compno,
            name: first.name,
            currentTrackerid: first.currentTrackerid,
            newTrackerid,
            addedIds: addId ? [addId] : [],
            removedIds: Array.from(removeIds),
            reason
        });
    }
    out.sort((a, b) => a.compno.localeCompare(b.compno));
    return out;
}

function summariseProposal(p: Proposal): string {
    const cur = p.currentTrackerid || '(none)';
    const parts = [`${p.compno} ${p.name}`.trim(), `trackerid: ${cur} → ${p.newTrackerid}`];
    if (p.addedIds.length) parts.push(`+${p.addedIds.join(',')}`);
    if (p.removedIds.length) parts.push(`−${p.removedIds.join(',')}`);
    parts.push(`(${p.reason})`);
    return parts.join('  |  ');
}

async function reviewProposals(proposals: Proposal[], matches: TrackerMatch[], results: OfficialResult[], crossClass: CrossClassMap, thisClass: ClassName): Promise<Proposal[]> {
    if (!proposals.length) return [];
    console.log(`\n  ${proposals.length} proposed change${proposals.length === 1 ? '' : 's'} (y=apply, n=skip, a=accept-all-remaining, q=quit review):`);

    const accepted: Proposal[] = [];
    let acceptAll = false;
    for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        console.log(`\n  [${i + 1}/${proposals.length}] ${summariseProposal(p)}`);
        printPilotMatches(
            p.compno,
            matches.filter((m) => m.compno === p.compno),
            results,
            crossClass,
            thisClass
        );

        if (acceptAll) {
            accepted.push(p);
            console.log('    → accepted (all)');
            continue;
        }

        const {choice} = await prompts(
            {
                type: 'select',
                name: 'choice',
                message: 'Apply?',
                choices: [
                    {title: 'yes — apply this', value: 'y'},
                    {title: 'no — skip this', value: 'n'},
                    {title: 'accept all remaining', value: 'a'},
                    {title: 'quit review', value: 'q'}
                ],
                initial: 0
            },
            {
                onCancel: () => {
                    console.log('  *** cancelled');
                    process.exit(0);
                }
            }
        );

        if (choice === 'q') break;
        if (choice === 'a') {
            acceptAll = true;
            accepted.push(p);
        } else if (choice === 'y') {
            accepted.push(p);
        }
    }
    return accepted;
}

async function applyProposals(className: ClassName, proposals: Proposal[]): Promise<number> {
    if (!proposals.length) return 0;
    const t = mysql.transaction();
    for (const p of proposals) {
        t.query(escape`
            INSERT IGNORE INTO tracker (class, compno, type, trackerid)
            VALUES (${className}, ${p.compno}, 'flarm', 'unknown')
        `);
        t.query(escape`
            UPDATE tracker
               SET trackerid = ${p.newTrackerid}
             WHERE class = ${className} AND compno = ${p.compno}
        `);
        t.query(escape`
            INSERT INTO trackerhistory (compno, changed, flarmid, method)
            VALUES (${p.compno}, now(), ${p.newTrackerid}, 'startmatch')
        `);
    }
    await t.commit();
    console.log(`  Wrote ${proposals.length} change${proposals.length === 1 ? '' : 's'}.`);
    return proposals.length;
}
