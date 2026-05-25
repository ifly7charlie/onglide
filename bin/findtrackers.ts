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
import {scoreSignals, computeMargins, summarisePrior, type Signals, type ScoreBreakdown, type Margins} from '../lib/scoring/shared/trackerScore';
import {loadMergedDDB, gliderEquivalent, type DDBEntry} from '../lib/ddb';
import {LEGACY_PRIOR_NATS, DEFAULT_LEDGER_MIN_NATS, DEFAULT_AUTO_MARGIN_NATS} from '../lib/constants';

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
        decimalNumbers: true,
        // affectedRows = changed rows, not matched rows.
        flags: ['-FOUND_ROWS']
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
    compName: string; // competition.name — friendly competition title for the report header
    className: ClassName; // the class id (15-char hash) — used as the key everywhere downstream
    classDisplay: string; // classes.classname — friendly class title for the report header
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
    // DDB is fetched once at script start and reused across every comp/class.
    // Returns null when both upstreams are unreachable AND no on-disk cache
    // exists; in that case the score loses its ddbCN/ddbGlider contributions
    // but everything else still works.
    const ddb = await loadMergedDDB();
    if (!ddb) console.warn('(DDB unavailable — ddbCN/ddbGlider signals will be 0 this run)');
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
        const s = await processGroup(group, debugFlarmidsArg, debugCompnosArg, tolerance, interactive, ddb);
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
async function processGroup(group: JobGroup, debugFlarmidsArg: Set<string>, debugCompnosArg: Set<string>, tolerance: number, interactive: boolean, ddb: Record<string, DDBEntry> | null): Promise<GroupSummary> {
    // Pass 1 — scan each class.
    const classMatches: ClassMatches[] = [];
    for (const job of group) {
        const {compid, compName, className, classDisplay, datecode} = job;
        const compLabel = compName ? `${compName} [${compid}]` : compid;
        const classLabel = classDisplay ? `${classDisplay} [${className}]` : className;
        console.log(`\n=== ${classLabel} / ${datecode} ${fromDateCode(datecode)}   (${compLabel}) ===`);

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

        // Position data is only retained for the live (most recent) day. If
        // the latest pilot start is older than 24h, the scan would chew
        // through bbox-rejected packets and find nothing — skip outright.
        const maxStartUtc = results.reduce((m, r) => Math.max(m, r.startUtc), 0);
        const ageHours = (Date.now() / 1000 - maxStartUtc) / 3600;
        if (ageHours > 24) {
            console.log(`  (latest pilot start ${ageHours.toFixed(1)}h ago — older than 24h live-data window; skipped)`);
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

        if (multi) {
            const classLabel = job.classDisplay ? `${job.classDisplay} [${className}]` : className;
            console.log(`\n--- ${classLabel} / ${datecode} — results ---`);
        }

        const priorMap = await loadPriorEvidence(datecode, className);
        if (priorMap.size) console.log(`  loaded ${priorMap.size} prior pair-score${priorMap.size === 1 ? '' : 's'} from earlier task days`);

        const scoreMap = computeScoreMap(matches, results, ddb, priorMap);

        // Always print the full report. The score breakdown is useful even
        // for clean pilots (operator can see what's holding the assignment
        // up). Per-proposal printPilotMatches in reviewProposals is the
        // focused review view atop this.
        printMatches(results, matches, tolerance, scoreMap, crossClass, className);

        const matchedCompnos = new Set(matches.filter((m) => m.withinTolerance && !m.ambiguous).map((m) => m.compno));
        const ambiguousCompnos = new Set(matches.filter((m) => m.ambiguous).map((m) => m.compno));
        summary.pilots += results.length;
        summary.matched += matchedCompnos.size;
        summary.ambiguous += ambiguousCompnos.size;
        console.log(`  Summary: ${results.length} pilots, ${matchedCompnos.size} matched, ${ambiguousCompnos.size} ambiguous`);

        if (argv['dry-run']) {
            const evidenceCount = countEvidenceRows(scoreMap);
            if (evidenceCount > 0) console.log(`  evidence-rows: ${evidenceCount} would be written`);
            continue;
        }

        const proposals = computeProposals(matches, scoreMap, crossClass, className);
        summary.proposed += proposals.length;

        const accepted = proposals.length //
            ? interactive
                ? await reviewProposals(proposals, matches, results, tolerance, scoreMap, crossClass, className)
                : proposals
            : [];

        const applied = accepted.length ? await applyProposals(className, datecode, accepted) : 0;
        summary.applied += applied;
        // Persist evidence rows for every (compno, flarmid) above the
        // ledger floor that wasn't covered by an applied startmatch row.
        // This is the multi-day fuel — written every run, not just on
        // proposal-driven changes.
        await writeEvidence(className, datecode, scoreMap, accepted);
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
    const rows = await mysql.query<{class: ClassName; classname: string; compname: string; datecode: Datecode}[]>(
        escape`
        SELECT DISTINCT cl.class             AS class,
                        COALESCE(cl.classname, '') AS classname,
                        COALESCE(c.name, '')       AS compname,
                        t.datecode           AS datecode
          FROM tasks t
          JOIN classes     cl ON cl.class  = t.class
          JOIN competition c  ON c.compid  = cl.compid
         WHERE cl.compid = ${compid}
           AND t.flown = 'Y'
           AND EXISTS (
               SELECT 1 FROM pilotresult pr
                WHERE pr.class    = cl.class
                  AND pr.datecode = t.datecode
                  AND pr.start  IS NOT NULL AND pr.start  <> '00:00:00'
           )
    `
            .append(filterClass)
            .append(filterDc)
            .append(escape` ORDER BY t.datecode DESC, cl.class ASC`)
    );
    return rows.map((r) => ({compid, compName: r.compname, className: r.class, classDisplay: r.classname, datecode: r.datecode}));
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
                ELSE UNIX_TIMESTAMP(CONCAT(${fromDateCode(datecode)}, ' ', nostart)) - comp.tzoffset
            END nostartutc
        FROM tasks, classes c, contestday cd, competition comp
        WHERE tasks.datecode = ${datecode}
            AND tasks.class = c.class
            AND cd.class = c.class AND cd.datecode = ${datecode}
            AND tasks.class = ${className}
            AND tasks.flown = 'Y'
            AND comp.compid = c.compid
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
            grandprixstart: taskdetails.grandprixstart == 'Y',
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
    // We want every pilot with a real official start, including landout
    // pilots (started but didn't complete the task → no finish time
    // recorded). Without them the start-scan window is computed only
    // over finishers, and the rest of the pipeline never sees the landout
    // pilot's flarmid as a candidate.
    const rows = await mysql.query<
        {
            compno: Compno;
            firstname: string;
            lastname: string;
            startUtc: number;
            finishUtc: number | null;
            trackerid: string;
            glidertype: string;
        }[]
    >(escape`
        SELECT pr.compno                                                    AS compno,
               COALESCE(p.firstname, '')                                    AS firstname,
               COALESCE(p.lastname,  '')                                    AS lastname,
               UNIX_TIMESTAMP(CONCAT(${date}, ' ', pr.start))  - c.tzoffset AS startUtc,
               CASE WHEN pr.finish IS NULL OR pr.finish = '00:00:00' THEN NULL
                    ELSE UNIX_TIMESTAMP(CONCAT(${date}, ' ', pr.finish)) - c.tzoffset
               END                                                          AS finishUtc,
               COALESCE(t.trackerid, '')                                    AS trackerid,
               COALESCE(p.glidertype, '')                                   AS glidertype
          FROM pilotresult pr
          JOIN pilots      p  ON p.class   = pr.class AND p.compno = pr.compno
          JOIN classes     cl ON cl.class  = pr.class
          JOIN competition c  ON c.compid  = cl.compid
          LEFT JOIN tracker t ON t.class   = pr.class AND t.compno = pr.compno
         WHERE pr.class    = ${className}
           AND pr.datecode = ${datecode}
           AND pr.start    IS NOT NULL AND pr.start  <> '00:00:00'
    `);
    return rows.map((r) => ({
        compno: r.compno,
        name: `${r.firstname} ${r.lastname}`.trim() || String(r.compno),
        trackerid: r.trackerid,
        startUtc: Number(r.startUtc) as Epoch,
        finishUtc: r.finishUtc === null ? null : (Number(r.finishUtc) as Epoch),
        glidertype: r.glidertype
    }));
}

// Load prior pair-score evidence for one (class, datecode), keyed by
// `${compno}|${flarmid}`. Decay is on the *task-day* timeline (not
// calendar days) so weather/rest days don't erode priors. Rows whose
// pair_score is NULL — typically legacy 'ognddb' / 'pilot' / 'startline'
// rows from before the score columns existed — get LEGACY_PRIOR_NATS as
// a fixed positive prior, then decay normally. The task-day list comes
// from the `tasks` table; rows whose datecode isn't in that list are
// silently dropped (they're not part of this class's task sequence).
//
// Scope is per-class. `tasks` and `trackerhistory` are both keyed by
// `class` (compid is reached via the `classes` join elsewhere) so we
// filter directly on class without joining classes here.
type PriorMap = Map<string, number>;
let priorEvidenceUnavailable = false; // latched after first schema failure so we don't spam the log
async function loadPriorEvidence(currentDatecode: Datecode, className: ClassName): Promise<PriorMap> {
    if (priorEvidenceUnavailable) return new Map();
    let taskDayRows: {datecode: Datecode}[] = [];
    let priorRows: {compno: Compno; flarmid: string; datecode: string; pair_score: number | null; method: string}[] = [];
    try {
        taskDayRows = await mysql.query<{datecode: Datecode}[]>(escape`
            SELECT DISTINCT datecode FROM tasks
            WHERE class = ${className} AND datecode IS NOT NULL
            ORDER BY datecode
        `);
        priorRows = await mysql.query<
            {
                compno: Compno;
                flarmid: string;
                datecode: string;
                pair_score: number | null;
                method: string;
            }[]
        >(escape`
            SELECT compno, flarmid, datecode, pair_score, method
            FROM trackerhistory
            WHERE class = ${className}
              AND datecode IS NOT NULL
              AND datecode <> ${String(currentDatecode)}
              AND method NOT IN ('ogn-blocked','flarmnet-blocked','ddb-blocked','none')
        `);
    } catch (e: any) {
        // If the migration hasn't been applied yet, the `class` /
        // `datecode` / `pair_score` columns on trackerhistory don't exist
        // — give up on priors for this run and keep going so the scan
        // still produces a useful report.
        const msg = String(e?.code ?? e?.message ?? e);
        if (/Unknown column|BAD_FIELD_ERROR|ER_BAD_FIELD/i.test(msg)) {
            console.warn(`  (prior-evidence schema not applied yet — skipping multi-day priors this run. Apply conf/sql/migrations/20260510_*.sql to enable.)`);
            priorEvidenceUnavailable = true;
            return new Map();
        }
        throw e;
    }
    const taskDayIndex = new Map<string, number>();
    taskDayRows.forEach((r, i) => taskDayIndex.set(String(r.datecode), i));
    const currentRank = taskDayIndex.get(String(currentDatecode));
    if (currentRank === undefined) return new Map();

    const grouped = new Map<string, {scoreNats: number | null; taskDaysAgo: number}[]>();
    for (const r of priorRows) {
        const rowRank = taskDayIndex.get(String(r.datecode));
        if (rowRank === undefined) continue; // not a task day for this comp
        const taskDaysAgo = currentRank - rowRank;
        if (taskDaysAgo < 0) continue;
        const key = `${String(r.compno)}|${r.flarmid}`;
        const arr = grouped.get(key) ?? [];
        arr.push({scoreNats: r.pair_score === null ? null : Number(r.pair_score), taskDaysAgo});
        grouped.set(key, arr);
    }

    const out: PriorMap = new Map();
    for (const [key, rows] of grouped) {
        out.set(key, summarisePrior(rows, LEGACY_PRIOR_NATS));
    }
    return out;
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
    // Always show both counts: it's the only way to distinguish "sparse but
    // clean coverage" (9 in / 0 out) from "mostly elsewhere" (9 in / 800 out).
    const total = diag.inBboxPackets + diag.bboxRejectedPackets;
    const ratioPct = total > 0 ? Math.round((diag.inBboxPackets / total) * 100) : 0;
    parts.push(`${diag.inBboxPackets} in-area + ${diag.bboxRejectedPackets} outside (${ratioPct}% in-area)`);
    if (diag.minDistanceKm !== null) parts.push(`closest ${diag.minDistanceKm.toFixed(2)} km to line`);
    if (diag.avgGapSec !== null) {
        const max = diag.maxGapSec !== null ? `, max ${diag.maxGapSec}s` : '';
        parts.push(`avg gap ${diag.avgGapSec.toFixed(0)}s${max}`);
    }
    if (diag.firstSeenT !== null && diag.lastSeenT !== null) {
        parts.push(`span ${fmtUtcHms(diag.firstSeenT)}-${fmtUtcHms(diag.lastSeenT)}`);
    }
    if (diag.gapAroundStartSec !== null) {
        const d = diag.distAtStartKm !== null ? `, ${diag.distAtStartKm.toFixed(2)} km from start` : '';
        parts.push(`gap @ start: ${diag.gapAroundStartSec}s${d}`);
    }
    if (diag.gapAroundFinishSec !== null) {
        const d = diag.distAtFinishKm !== null ? `, ${diag.distAtFinishKm.toFixed(2)} km from finish` : '';
        parts.push(`gap @ finish: ${diag.gapAroundFinishSec}s${d}`);
    }
    return parts.join('  |  ');
}

function rowTag(m: TrackerMatch): string {
    if (m.confidence === null) {
        if (m.bboxOnly) return '[assigned, all packets outside task area — wrong tracker]';
        if (m.skipped) return '[assigned, skipped: out-of-area]';
        if (m.deltaStart !== null && m.deltaFinish === null) return '[assigned, no finish crossing]';
        if (m.deltaStart === null && m.deltaFinish !== null) return '[assigned, no start crossing]';
        return '[assigned, no crossings]';
    }
    // Single-sided rows from Phase 1.5 — weaker than [match] (no second
    // line to disambiguate from pair-flying neighbours) but stronger than
    // nothing. Distinct from [assigned, outside tolerance] which means
    // both lines fired but timing didn't align.
    const oneSided = (m.deltaStart === null) !== (m.deltaFinish === null);
    if (m.assigned && oneSided) return m.deltaStart !== null ? '[assigned, start-only match]' : '[assigned, finish-only match]';
    if (oneSided) return m.deltaStart !== null ? '[start-only match]' : '[finish-only match]';
    if (m.assigned && m.withinTolerance) return '[assigned ✓]';
    if (m.assigned) return '[assigned, outside tolerance]';
    if (m.withinTolerance) return '[match]';
    return '';
}

function pilotHeaderTag(rows: TrackerMatch[]): string {
    const flags: string[] = [];
    const assignedRow = rows.find((m) => m.assigned);
    // Phase 1.5 single-sided rows carry withinTolerance=false by design
    // (the legacy gate requires both sides), but their available delta
    // IS within tolerance — the row tag says [assigned, start-only match]
    // and the side that fired is fine. Don't call it "outside tolerance"
    // in the header. We surface it as informational ("no finish crossing
    // today" / "no start crossing today") since the operator may want to
    // glance at it even though it's not a problem.
    const isOneSidedClean = (m: TrackerMatch) => m.confidence !== null && (m.deltaStart === null) !== (m.deltaFinish === null);
    if (assignedRow && !assignedRow.withinTolerance) {
        if (assignedRow.bboxOnly) flags.push('assigned ID flying outside task area (wrong tracker)');
        else if (assignedRow.skipped) flags.push('assigned ID skipped (first sighting out of task area)');
        else if (isOneSidedClean(assignedRow)) {
            flags.push(assignedRow.deltaStart !== null ? 'assigned ID has no finish crossing today' : 'assigned ID has no start crossing today');
        } else if (assignedRow.confidence === null) flags.push('assigned ID has no crossings');
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
        .map((h) => `also matches ${String(h.compno).trim()} in class ${h.className}`);
}

type ScoreMap = Map<string, {score: ScoreBreakdown; margins: Margins; pilotContested: boolean; flarmidContested: boolean; deltaStart: number | null; deltaFinish: number | null}>;
const scoreKey = (compno: Compno, flarmid: FlarmID) => `${compno}|${flarmid}`;

// Build per-pair scores and two-sided margins from the matches we already
// have. Since the candidate set is bounded by what `findTrackerMatches`
// returns (within-tolerance + assigned), margins here are best-vs-next-best
// among reported candidates only — true joint optimisation comes later.
function computeScoreMap(matches: TrackerMatch[], results: OfficialResult[], ddb: Record<string, DDBEntry> | null, priorMap: PriorMap): ScoreMap {
    if (!matches.length) return new Map();
    const earliestPilotStartUtc = results.reduce((m, r) => Math.min(m, r.startUtc), Number.POSITIVE_INFINITY);
    const resultByCompno = new Map<Compno, OfficialResult>();
    for (const r of results) resultByCompno.set(r.compno, r);

    const breakdownByKey = new Map<string, ScoreBreakdown>();
    const scoreByPilot = new Map<Compno, number[]>();
    const scoreByFlarmid = new Map<FlarmID, number[]>();

    for (const m of matches) {
        const r = resultByCompno.get(m.compno);
        const ddbEntry = ddbLookup(ddb, m.flarmid);
        const link = ddbLinkFor(ddbEntry, m.compno, r?.glidertype ?? '');
        const priorNats = priorMap.get(scoreKey(m.compno, m.flarmid)) ?? 0;
        const sig = signalsFromMatch(m, earliestPilotStartUtc, link, priorNats);
        const breakdown = scoreSignals(sig);
        breakdownByKey.set(scoreKey(m.compno, m.flarmid), breakdown);
        const arrP = scoreByPilot.get(m.compno) ?? [];
        arrP.push(breakdown.total);
        scoreByPilot.set(m.compno, arrP);
        const arrF = scoreByFlarmid.get(m.flarmid) ?? [];
        arrF.push(breakdown.total);
        scoreByFlarmid.set(m.flarmid, arrF);
    }

    const out: ScoreMap = new Map();
    for (const m of matches) {
        const breakdown = breakdownByKey.get(scoreKey(m.compno, m.flarmid))!;
        const peerPilot = scoreByPilot.get(m.compno)!;
        const peerFlarmid = scoreByFlarmid.get(m.flarmid)!;
        const margins = computeMargins({
            chosenScore: breakdown.total,
            bestOtherFlarmidForPilot: secondBest(peerPilot, breakdown.total),
            bestOtherPilotForFlarmid: secondBest(peerFlarmid, breakdown.total)
        });
        // `contested` flags say whether there's actually a competing
        // candidate on each side. Without competitors, the "margin" looks
        // wide but really just means "uncontested" — useful to distinguish
        // a confidently-ahead match from a single-candidate held row.
        out.set(scoreKey(m.compno, m.flarmid), {
            score: breakdown,
            margins,
            pilotContested: peerPilot.length > 1,
            flarmidContested: peerFlarmid.length > 1,
            deltaStart: m.deltaStart,
            deltaFinish: m.deltaFinish
        });
    }
    return out;
}

// Best score in `arr` other than `chosen`. If `chosen` is the only entry,
// the next-best is treated as 0 (no competing candidate seen at all).
function secondBest(arr: number[], chosen: number): number {
    let best = -Infinity;
    let chosenSeen = false;
    for (const v of arr) {
        if (!chosenSeen && v === chosen) {
            chosenSeen = true; // skip the first occurrence of chosen
            continue;
        }
        if (v > best) best = v;
    }
    return best === -Infinity ? 0 : best;
}

// Per-pair DDB facets: CN match (strong) and aircraft-model/glider match
// (weak). Reuses the same key-fallback chain matchtrackers.ts uses
// (`bin/matchtrackers.ts:414`) since DDB key casing varies between
// upstreams and the FlarmID type carries no guarantee of normalisation.
type DdbLink = {cn: boolean; glider: boolean; tag: 'none' | 'cn' | 'glider' | 'both'};
function ddbLookup(ddb: Record<string, DDBEntry> | null, f: FlarmID): DDBEntry | undefined {
    if (!ddb) return undefined;
    const s = String(f);
    return ddb[s] ?? ddb[s.toLowerCase()] ?? ddb[s.toUpperCase()];
}
function ddbLinkFor(ddb: DDBEntry | undefined, compno: Compno, glidertype: string): DdbLink {
    if (!ddb) return {cn: false, glider: false, tag: 'none'};
    const cn = !!ddb.cn && ddb.cn.trim().toUpperCase() === String(compno).trim().toUpperCase();
    const glider = !!ddb.aircraft_model && !!glidertype && gliderEquivalent(ddb.aircraft_model, glidertype);
    return {cn, glider, tag: cn && glider ? 'both' : cn ? 'cn' : glider ? 'glider' : 'none'};
}

// Recover the ddb_link enum from the scored breakdown. The breakdown
// stores weighted nats, not raw flags, so we infer from non-zero
// contributions. A score of 0 on either side indicates the flag wasn't
// set; this matches the schema enum exactly.
function ddbLinkFromBreakdown(b: ScoreBreakdown | undefined): 'none' | 'cn' | 'glider' | 'both' {
    if (!b) return 'none';
    const cn = b.ddbCn > 0;
    const glider = b.ddbGlider > 0;
    return cn && glider ? 'both' : cn ? 'cn' : glider ? 'glider' : 'none';
}

function signalsFromMatch(m: TrackerMatch, earliestPilotStartUtc: number, link: DdbLink, priorNats: number): Signals {
    const d = m.diag;
    return {
        deltaStart: m.deltaStart,
        deltaFinish: m.deltaFinish,
        distAtStartKm: d?.distAtStartKm ?? null,
        gapAroundStartSec: d?.gapAroundStartSec ?? null,
        distAtFinishKm: d?.distAtFinishKm ?? null,
        gapAroundFinishSec: d?.gapAroundFinishSec ?? null,
        inBboxPackets: d?.inBboxPackets ?? 0,
        bboxRejectedPackets: d?.bboxRejectedPackets ?? 0,
        firstSeenT: d?.firstSeenT ?? null,
        earliestPilotStartUtc,
        ddbCnMatch: link.cn,
        ddbGliderMatch: link.glider,
        baselineMatch: m.assigned,
        priorNats
    };
}

function printMatches(results: OfficialResult[], matches: TrackerMatch[], tolerance: number, scoreMap: ScoreMap, crossClass?: CrossClassMap, thisClass?: ClassName): void {
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
        printPilotMatches(compno, byPilot.get(compno)!, results, tolerance, scoreMap, crossClass, thisClass);
    }
}

// For each pilot, peers (signed Δ in seconds, peer − me) on each axis whose
// official time is within ±tolerance. A non-empty list on either axis means
// times alone can't disambiguate that pilot from those peers — useful
// alongside the [ambiguous] structural check, which only triggers when
// BOTH axes are within 2× tolerance.
function timePeers(me: OfficialResult, others: OfficialResult[], tolerance: number, axis: 'start' | 'finish'): {compno: Compno; name: string; dt: number}[] {
    const myT = axis === 'start' ? me.startUtc : me.finishUtc;
    if (myT === null) return []; // landout pilots have no finish-time peer set
    const out: {compno: Compno; name: string; dt: number}[] = [];
    for (const o of others) {
        if (o.compno === me.compno) continue;
        const oT = axis === 'start' ? o.startUtc : o.finishUtc;
        if (oT === null) continue;
        const dt = oT - myT;
        if (Math.abs(dt) <= tolerance) out.push({compno: o.compno, name: o.name, dt});
    }
    out.sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt));
    return out;
}

function fmtPeers(peers: {compno: Compno; name: string; dt: number}[]): string {
    const max = 4;
    const head = peers
        .slice(0, max)
        .map((p) => `${String(p.compno).trim()} (${p.dt >= 0 ? '+' : '−'}${Math.abs(p.dt)}s)`)
        .join(', ');
    return peers.length > max ? `${head}, +${peers.length - max} more` : head;
}

function printPilotMatches(compno: Compno, arr: TrackerMatch[], results: OfficialResult[], tolerance: number, scoreMap?: ScoreMap, crossClass?: CrossClassMap, thisClass?: ClassName): void {
    if (!arr.length) return;
    const r = results.find((x) => x.compno === compno);
    console.log(`  ${String(compno).padEnd(4)}${pilotHeaderTag(arr)}`);
    if (r) {
        const startPeers = timePeers(r, results, tolerance, 'start');
        const finishPeers = timePeers(r, results, tolerance, 'finish');
        if (startPeers.length) console.log(`       start time within ±${tolerance}s of: ${fmtPeers(startPeers)}`);
        if (finishPeers.length) console.log(`       finish time within ±${tolerance}s of: ${fmtPeers(finishPeers)}`);
    }
    for (const m of arr) {
        const tag = rowTag(m);
        const tagPart = tag ? `   ${tag}` : '';
        console.log(`       flarmid: ${m.flarmid}   Δstart: ${fmtDelta(m.deltaStart)}   Δfinish: ${fmtDelta(m.deltaFinish)}   confidence: ${fmtConfidence(m.confidence)}${tagPart}`);
        if (m.diag) console.log(`         · ${fmtDiag(m.diag)}`);
        const scored = scoreMap?.get(scoreKey(m.compno, m.flarmid));
        if (scored) console.log(`         · ${fmtScore(scored.score, scored.margins, scored.pilotContested, scored.flarmidContested)}`);
        if (thisClass) {
            for (const line of describeCrossClass(m.flarmid, thisClass, crossClass)) {
                console.log(`         ↳ ${line}`);
            }
        }
    }
}

function fmtScore(score: ScoreBreakdown, margins: Margins, pilotContested: boolean, flarmidContested: boolean): string {
    const parts: string[] = [];
    parts.push(`S=${score.total.toFixed(2)}`);
    if (!pilotContested && !flarmidContested) {
        parts.push(`uncontested (no competing candidate seen)`);
    } else {
        const p = pilotContested ? `p=${margins.pilotMargin.toFixed(2)}` : `p=— (no other f)`;
        const f = flarmidContested ? `f=${margins.flarmidMargin.toFixed(2)}` : `f=— (no other p)`;
        parts.push(`margin=${margins.margin.toFixed(2)} (${p}, ${f})`);
    }
    const contribs: string[] = [];
    if (score.deltaStart > 0) contribs.push(`Δs=${score.deltaStart.toFixed(2)}`);
    if (score.deltaFinish > 0) contribs.push(`Δf=${score.deltaFinish.toFixed(2)}`);
    if (score.distAtStart > 0) contribs.push(`distS=${score.distAtStart.toFixed(2)}`);
    if (score.distAtFinish > 0) contribs.push(`distF=${score.distAtFinish.toFixed(2)}`);
    if (score.inBbox > 0) contribs.push(`presence=${score.inBbox.toFixed(2)}`);
    if (score.preLaunch > 0) contribs.push(`pre=${score.preLaunch.toFixed(2)}`);
    if (score.ddbCn > 0) contribs.push(`ddbCN=${score.ddbCn.toFixed(2)}`);
    if (score.ddbGlider > 0) contribs.push(`ddbGlider=${score.ddbGlider.toFixed(2)}`);
    if (score.baseline > 0) contribs.push(`base=${score.baseline.toFixed(2)}`);
    if (score.prior !== 0) contribs.push(`prior=${score.prior.toFixed(2)}`);
    if (contribs.length) parts.push(`[${contribs.join(' ')}]`);
    return parts.join('  ');
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
    // Score context for the chosen flarmid (the addedId, or the assigned
    // flarmid being removed when there's no addedId). Persisted on the
    // applied trackerhistory row so the next day's prior loader can see it.
    pairScore: number | null;
    margin: number | null;
    deltaStart: number | null;
    deltaFinish: number | null;
    ddbLink: 'none' | 'cn' | 'glider' | 'both';
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

function computeProposals(matches: TrackerMatch[], scoreMap: ScoreMap, crossClass: CrossClassMap, thisClass: ClassName): Proposal[] {
    const byPilot = new Map<Compno, TrackerMatch[]>();
    const byFlarm = new Map<FlarmID, TrackerMatch[]>();
    for (const m of matches) {
        const arrP = byPilot.get(m.compno) ?? [];
        arrP.push(m);
        byPilot.set(m.compno, arrP);
        const arrF = byFlarm.get(m.flarmid) ?? [];
        arrF.push(m);
        byFlarm.set(m.flarmid, arrF);
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
        // Phase 1.5 single-sided alts — landout pilots and any pilot whose
        // tracker only crossed one of start/finish. Safe to propose only
        // when the flarmid isn't claimed elsewhere and there's no
        // competing single-sided candidate for the same flarmid or pilot.
        const isOneSided = (m: TrackerMatch) => m.confidence !== null && (m.deltaStart === null) !== (m.deltaFinish === null);
        const altSingleSided = rows.filter((m) => {
            if (m.assigned) return false;
            if (!isOneSided(m)) return false;
            const peers = byFlarm.get(m.flarmid) ?? [];
            // Phase 1 (both-sided) match for the same flarmid wins, regardless of pilot.
            if (peers.some((p) => p.withinTolerance)) return false;
            // Another pilot has a single-sided claim on this flarmid — but
            // only counts as competing if that peer actually prefers this
            // flarmid. A peer that strongly prefers a different candidate
            // of their own (pilotMargin ≤ -DEFAULT_AUTO_MARGIN_NATS on this
            // flarmid) isn't really in contention — their score is decisively
            // higher elsewhere. Ignore them and let the rightful claimant
            // take this flarmid. We require *strong* preference (not just
            // any negative margin) so thin score differences don't override
            // a peer's legitimate claim.
            const competingPeer = peers.some((p) => {
                if (p.compno === m.compno) return false;
                if (!isOneSided(p)) return false;
                const peerPilotMargin = scoreMap.get(scoreKey(p.compno, p.flarmid))?.margins.pilotMargin ?? 0;
                return peerPilotMargin > -DEFAULT_AUTO_MARGIN_NATS;
            });
            if (competingPeer) return false;
            return true;
        });

        const assignedBad = rows.filter((m) => m.assigned && !m.withinTolerance);
        if (!altMatches.length && !altSingleSided.length && !assignedBad.length) continue;

        // When multiple unassigned candidates compete for the same pilot,
        // pick the highest-scoring one — provided it strictly outscores the
        // runner-up. A tie is genuinely ambiguous, but a clear score
        // separation (e.g. one candidate with a DDB CN match, the other
        // without) shouldn't get treated the same way. Phase 1 (both-sided)
        // candidates win over Phase 1.5 (single-sided) for the same pilot;
        // within a phase, score breaks the tie.
        const pickBestByScore = (cands: TrackerMatch[]): TrackerMatch | null => {
            if (cands.length === 0) return null;
            if (cands.length === 1) return cands[0];
            const scored = cands.map((m) => ({m, s: scoreMap.get(scoreKey(compno, m.flarmid))?.score.total ?? 0}));
            scored.sort((a, b) => b.s - a.s);
            if (scored[0].s <= scored[1].s) return null; // genuine tie
            return scored[0].m;
        };
        const bestAlt = pickBestByScore(altMatches);
        const bestSingle = pickBestByScore(altSingleSided);
        // If altMatches was non-empty but tied on score, fall through to
        // single-sided rather than declaring the pilot ambiguous outright.
        if (altMatches.length > 1 && !bestAlt && altSingleSided.length === 0 && !assignedBad.length) continue;
        if (altMatches.length === 0 && altSingleSided.length > 1 && !bestSingle && !assignedBad.length) continue;

        const first = rows[0];
        const currentIds = parseCurrentIds(first.currentTrackerid);
        // Prefer Phase 1 (both-sided) over Phase 1.5 (single-sided) when
        // both exist for the same pilot.
        let addRow: TrackerMatch | null = bestAlt ?? bestSingle ?? null;
        let addId: FlarmID | null = addRow?.flarmid ?? null;

        // Score gate: only replace an assigned tracker when the proposed
        // alternative actually outscores it. Phase 1/1.5 categorisation is
        // a blunt instrument — on landout / one-sided days the assigned
        // tracker often ends up in `assignedBad` purely because Phase 1.5
        // carries withinTolerance=false, even when its score (Δstart, in-
        // area presence, DDB CN, base) clearly beats any contender. Drop
        // the add candidate in that case so the existing assignment stands.
        if (addId && assignedBad.length) {
            const addScore = scoreMap.get(scoreKey(compno, addId))?.score.total ?? 0;
            let bestAssignedScore = -Infinity;
            for (const m of assignedBad) {
                const s = scoreMap.get(scoreKey(compno, m.flarmid))?.score.total ?? 0;
                if (s > bestAssignedScore) bestAssignedScore = s;
            }
            if (addScore <= bestAssignedScore) {
                addRow = null;
                addId = null;
            }
        }

        // Only propose removing an assigned tracker if we have *positive*
        // evidence it's wrong. "Outside tolerance" alone can be poor FLARM
        // coverage, a DNF, or a no-finish landout — dropping the operator's
        // existing assignment in those cases loses information.
        //
        // Strong-negative signals that warrant removal:
        //   • a within-tolerance alternative exists for this pilot (`addId`)
        //     — we'd be replacing, not just clearing.
        //   • the assigned flarmid cleanly matches a pilot in another class
        //     today (cross-class hit) — "moved glider" signal.
        //   • `bboxOnly`: flarmid was active in the scan window but every
        //     packet was outside the task area.
        //   • `inBboxRatio` very low (≤0.1, some traffic): flarmid was
        //     overwhelmingly elsewhere — almost certainly a different
        //     comp's glider that briefly drifted into our bbox.
        const STRONG_NEGATIVE_RATIO = 0.1;
        const removeIds = new Set<FlarmID>();
        for (const m of assignedBad) {
            const crossClassHit = describeCrossClass(m.flarmid, thisClass, crossClass).length > 0;
            const total = (m.diag?.inBboxPackets ?? 0) + (m.diag?.bboxRejectedPackets ?? 0);
            const ratio = total > 0 ? (m.diag?.inBboxPackets ?? 0) / total : 0;
            const lowRatio = total > 0 && ratio <= STRONG_NEGATIVE_RATIO;
            if (addId || crossClassHit || m.bboxOnly || lowRatio) removeIds.add(m.flarmid);
        }
        // Nothing to do if we'd be neither adding nor removing.
        if (!addId && removeIds.size === 0) continue;

        const newIds: FlarmID[] = [];
        for (const id of currentIds) if (!removeIds.has(id)) newIds.push(id);
        if (addId && !newIds.includes(addId)) newIds.push(addId);

        const newTrackerid = newIds.length ? newIds.join(',') : 'unknown';
        if (newTrackerid === first.currentTrackerid) continue;

        const oneSidedAdd = addRow ? isOneSided(addRow) : false;
        const baseReason = addId //
            ? removeIds.size
                ? oneSidedAdd
                    ? 'switch to single-sided match (start- or finish-only)'
                    : 'switch to within-tolerance alternative'
                : oneSidedAdd
                  ? `associate single-sided match (${addRow!.deltaStart !== null ? 'start' : 'finish'}-only)`
                  : 'associate within-tolerance match'
            : 'assigned tracker has strong negative signal (out-of-area or other-class match)';

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

        // Pull score data for the flarmid we're acting on. Prefer the
        // addedId (the new chosen flarmid). Fall back to the matchRow we
        // were considering. Falls back to nulls if not in scoreMap.
        const focusFlarmid = addId ?? Array.from(removeIds)[0];
        const focusMatch = focusFlarmid ? rows.find((m) => m.flarmid === focusFlarmid) : undefined;
        const scored = focusFlarmid ? scoreMap.get(scoreKey(compno, focusFlarmid)) : undefined;
        out.push({
            compno,
            name: first.name,
            currentTrackerid: first.currentTrackerid,
            newTrackerid,
            addedIds: addId ? [addId] : [],
            removedIds: Array.from(removeIds),
            reason,
            pairScore: scored ? scored.score.total : null,
            margin: scored ? scored.margins.margin : null,
            deltaStart: focusMatch?.deltaStart ?? null,
            deltaFinish: focusMatch?.deltaFinish ?? null,
            ddbLink: ddbLinkFromBreakdown(scored?.score)
        });
    }
    out.sort((a, b) => a.compno.localeCompare(b.compno));
    return out;
}

function summariseProposal(p: Proposal): string {
    const cur = p.currentTrackerid || '(none)';
    const parts = [String(p.compno), `trackerid: ${cur} → ${p.newTrackerid}`];
    if (p.addedIds.length) parts.push(`+${p.addedIds.join(',')}`);
    if (p.removedIds.length) parts.push(`−${p.removedIds.join(',')}`);
    parts.push(`(${p.reason})`);
    return parts.join('  |  ');
}

async function reviewProposals(proposals: Proposal[], matches: TrackerMatch[], results: OfficialResult[], tolerance: number, scoreMap: ScoreMap, crossClass: CrossClassMap, thisClass: ClassName): Promise<Proposal[]> {
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
            tolerance,
            scoreMap,
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

async function applyProposals(className: ClassName, datecode: Datecode, proposals: Proposal[]): Promise<number> {
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
        // One trackerhistory row per ADDED flarmid (not per proposal). Multi-
        // flarmid pilots (e.g. "A12,B34") would otherwise produce a single
        // row with flarmid="A12,B34", which never re-attaches as a prior
        // since the loader keys on a singular flarmid. The score/margin
        // context applies to the chosen flarmid we already recorded on the
        // Proposal — write it on the row for that flarmid, and on any other
        // added flarmid the same row.
        const addedIds = p.addedIds.length ? p.addedIds : [];
        for (const flarmid of addedIds) {
            t.query(escape`
                INSERT INTO trackerhistory
                    (compno, changed, flarmid, method, class, datecode,
                     delta_start, delta_finish, pair_score, margin, ddb_link)
                VALUES
                    (${p.compno}, now(), ${String(flarmid)}, 'startmatch', ${className}, ${String(datecode)},
                     ${p.deltaStart}, ${p.deltaFinish}, ${p.pairScore}, ${p.margin}, ${p.ddbLink})
            `);
        }
        // Pure-removal proposals (e.g. bboxOnly forces a clear) leave no
        // positive trackerhistory entry — that's intentional. The tracker
        // table update is the record of the change; nothing to persist as
        // a future prior.
    }
    await t.commit();
    console.log(`  Wrote ${proposals.length} change${proposals.length === 1 ? '' : 's'}.`);
    return proposals.length;
}

// Count how many evidence rows we'd write for this scan — used by
// --dry-run to surface the would-be ledger volume without touching the DB.
function countEvidenceRows(scoreMap: ScoreMap): number {
    let n = 0;
    for (const v of scoreMap.values()) if (v.score.total >= DEFAULT_LEDGER_MIN_NATS) n++;
    return n;
}

// Persist daily evidence rows for every (compno, flarmid) pair above the
// ledger floor that didn't already get a 'startmatch' row from this run.
// Idempotent per-day: deletes the previous day's evidence rows for this
// (class, datecode) before inserting fresh ones, so re-runs don't
// accumulate.
async function writeEvidence(className: ClassName, datecode: Datecode, scoreMap: ScoreMap, applied: Proposal[]): Promise<number> {
    // Covers every flarmid an apply just wrote a startmatch row for — so a
    // multi-add proposal doesn't get a duplicate evidence row for the same
    // pair on the same day.
    const appliedKeys = new Set<string>();
    for (const p of applied) {
        for (const id of p.addedIds) appliedKeys.add(`${String(p.compno)}|${String(id)}`);
    }
    const writes: {compno: Compno; flarmid: FlarmID; deltaStart: number | null; deltaFinish: number | null; pairScore: number; margin: number; ddbLink: string}[] = [];
    for (const [key, v] of scoreMap) {
        if (v.score.total < DEFAULT_LEDGER_MIN_NATS) continue;
        if (appliedKeys.has(key)) continue;
        const [compno, flarmid] = key.split('|') as [Compno, FlarmID];
        writes.push({
            compno,
            flarmid,
            deltaStart: v.deltaStart,
            deltaFinish: v.deltaFinish,
            pairScore: v.score.total,
            margin: v.margins.margin,
            ddbLink: ddbLinkFromBreakdown(v.score)
        });
    }

    const t = mysql.transaction();
    t.query(escape`
        DELETE FROM trackerhistory
        WHERE class = ${className} AND datecode = ${String(datecode)} AND method = 'evidence'
    `);
    for (const w of writes) {
        t.query(escape`
            INSERT INTO trackerhistory
                (compno, changed, flarmid, method, class, datecode,
                 delta_start, delta_finish, pair_score, margin, ddb_link)
            VALUES
                (${w.compno}, now(), ${w.flarmid}, 'evidence', ${className}, ${String(datecode)},
                 ${w.deltaStart}, ${w.deltaFinish}, ${w.pairScore}, ${w.margin}, ${w.ddbLink})
        `);
    }
    await t.commit();
    if (writes.length) console.log(`  Wrote ${writes.length} evidence row${writes.length === 1 ? '' : 's'}.`);
    return writes.length;
}
