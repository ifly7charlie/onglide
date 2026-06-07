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
import {scoreSignals, computeMargins, summarisePrior, crossingScore, contentionPenalty, physicalMatchScore, type Signals, type ScoreBreakdown, type Margins} from '../lib/scoring/shared/trackerScore';
import {loadMergedDDB, gliderEquivalent, isBlocked, type DDBEntry} from '../lib/ddb';
import {
    fingerprintFromPilot,
    pilotKey,
    hasPilotEvidence,
    flarmidIsIcao,
    resolveCountries,
    resolvePilotCountry,
    xcEvidenceScore,
    type IdentityFacets,
    type PilotEvidence,
    type PerCompEvidence,
    type XcEvidence
} from '../lib/scoring/shared/identity';
import {DEFAULT_LEDGER_MIN_NATS, DEFAULT_AUTO_MARGIN_NATS, DEFAULT_SCORE_MIN_NATS, IDENTITY_EXPIRY_MONTHS} from '../lib/constants';

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
    trackingconsent: string; // competition.trackingconsent ('Y' overrides DDB tracked=N)
    countrycode: string; // competition.countrycode — fallback country for cross-comp identity
}

type JobGroup = Job[]; // all classes for one (compid, datecode)

interface ClassMatches {
    job: Job;
    results: OfficialResult[];
    matches: TrackerMatch[];
    scoreMap: ScoreMap;
    // Per-pilot cross-comp identity fingerprint (empty when identity disabled).
    // Built in pass 1 and reused for collection in pass 3.
    candidateFacets: Map<Compno, IdentityFacets>;
}

// A flarmid → pilots that produced a clean (within-tolerance, non-ambiguous)
// phase-1 match in any class of the same (compid, datecode). Used to surface
// "this assigned tracker actually matches a pilot in another class" — the
// case where a flarm unit was moved between gliders during a comp.
interface CrossClassHit {
    className: ClassName;
    classDisplay: string;
    compno: Compno;
    name: string;
    deltaStart: number | null;
    deltaFinish: number | null;
    /** This flarmid is currently in the other-class pilot's trackerid list. */
    assigned: boolean;
    /** Score breakdown for this (compno, flarmid) in the other class, including prior evidence. */
    score: ScoreBreakdown;
    margins: Margins;
    pilotContested: boolean;
    flarmidContested: boolean;
    xcFacets: string[];
    /** Total was negated by the contention guard (flarmid confidently held by another glider in that class). */
    demoted: boolean;
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

    // Housekeeping: drop cross-comp identity evidence not reconfirmed in 18mo.
    await purgeExpiredIdentity();

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

        // Score map (including multi-day prior evidence) is built here in
        // pass 1 so pass 2 can copy the breakdown for each cross-class hit
        // onto the CrossClassHit record — the "also matches K in class X"
        // line needs to show K's score in class X, not D01607's in this class.
        const priorMap = await loadPriorEvidence(datecode, className);
        if (priorMap.size) console.log(`  loaded ${priorMap.size} prior pair-score${priorMap.size === 1 ? '' : 's'} from earlier task days`);

        // Cross-comp identity: build each pilot's privacy-preserving
        // fingerprint and load what we've previously associated with the
        // candidate flarmids in OTHER comps. Disabled (empty) without a secret.
        const candidateFacets = buildCandidateFacets(results, job);
        const priorAircraft = await loadPriorAircraft(
            matches.map((m) => m.flarmid),
            job.compid
        );
        if (priorAircraft.size) console.log(`  loaded cross-comp identity for ${priorAircraft.size} flarmid${priorAircraft.size === 1 ? '' : 's'}`);

        const scoreMap = computeScoreMap(matches, results, ddb, priorMap, candidateFacets, priorAircraft);

        classMatches.push({job, results, matches, scoreMap, candidateFacets});
    }

    // Pass 2 — flarmid → unambiguous within-tolerance hits across the group.
    // Stash the breakdown/margins for the (compno, flarmid) pair from the
    // hit's own class so we can render quality info on the cross-class line.
    const crossClass: CrossClassMap = new Map();
    for (const cm of classMatches) {
        for (const m of cm.matches) {
            if (!m.withinTolerance || m.ambiguous) continue;
            const scored = cm.scoreMap.get(scoreKey(m.compno, m.flarmid));
            if (!scored) continue;
            const arr = crossClass.get(m.flarmid) ?? [];
            arr.push({
                className: cm.job.className,
                classDisplay: cm.job.classDisplay,
                compno: m.compno,
                name: m.name,
                deltaStart: m.deltaStart,
                deltaFinish: m.deltaFinish,
                assigned: m.assigned,
                score: scored.score,
                margins: scored.margins,
                pilotContested: scored.pilotContested,
                flarmidContested: scored.flarmidContested,
                xcFacets: scored.xcFacets,
                demoted: scored.demoted
            });
            crossClass.set(m.flarmid, arr);
        }
    }

    // Task-twin classes (same comp/day, identical turnpoint sequence): a
    // cross-class hit between them for the same compno is the same glider,
    // not a "moved glider" conflict. Computed once for the whole group.
    const twinMap =
        classMatches.length > 1
            ? await loadTaskTwins(
                  classMatches.map((cm) => cm.job.className),
                  classMatches[0].job.datecode
              )
            : new Map<ClassName, Set<ClassName>>();

    // Pass 3 — per-class results and proposals.
    const summary: GroupSummary = {pilots: 0, matched: 0, ambiguous: 0, proposed: 0, applied: 0};
    const multi = classMatches.length > 1;
    for (const cm of classMatches) {
        const {job, results, matches, scoreMap} = cm;
        const {className, datecode} = job;

        if (multi) {
            const classLabel = job.classDisplay ? `${job.classDisplay} [${className}]` : className;
            console.log(`\n--- ${classLabel} / ${datecode} — results ---`);
        }

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
            if (identityEnabled && !identityTablesUnavailable) {
                const idCount = countGoodMatches(matches, scoreMap, ddb, job.trackingconsent);
                if (idCount > 0) console.log(`  identity-evidence: ${idCount} association${idCount === 1 ? '' : 's'} would be collected`);
            }
            continue;
        }

        const proposals = computeProposals(matches, scoreMap, crossClass, className, twinMap.get(className) ?? new Set<ClassName>());
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
        // Cross-comp identity: collect aircraft/pilot evidence from confident
        // matches only (never DDB-blocked devices). Persists across comps.
        await writeAircraftEvidence(job, matches, scoreMap, accepted, cm.candidateFacets, ddb);
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
    const rows = await mysql.query<{class: ClassName; classname: string; compname: string; datecode: Datecode; trackingconsent: string; countrycode: string}[]>(
        escape`
        SELECT DISTINCT cl.class             AS class,
                        COALESCE(cl.classname, '') AS classname,
                        COALESCE(c.name, '')       AS compname,
                        COALESCE(c.trackingconsent, 'N') AS trackingconsent,
                        COALESCE(c.countrycode, '')      AS countrycode,
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
    return rows.map((r) => ({compid, compName: r.compname, className: r.class, classDisplay: r.classname, datecode: r.datecode, trackingconsent: r.trackingconsent, countrycode: r.countrycode}));
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
    //
    // Pre-09:00 local starts are treated as unknown — scoring occasionally
    // emits a bogus early-morning pr.start (often near 00:00) when the
    // upstream scorer hasn't reconciled the day yet. Including those produces
    // delta_start values in the tens of thousands of seconds that overflow
    // the trackerhistory column and contaminate the score map. Soaring tasks
    // don't start before 09:00 local in practice, so this filter is safe.
    const rows = await mysql.query<
        {
            compno: Compno;
            firstname: string;
            lastname: string;
            startUtc: number;
            finishUtc: number | null;
            trackerid: string;
            glidertype: string;
            homeclub: string;
            country: string;
            fai: number;
            greg: string;
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
               COALESCE(p.glidertype, '')                                   AS glidertype,
               COALESCE(p.homeclub, '')                                     AS homeclub,
               COALESCE(p.country, '')                                      AS country,
               COALESCE(p.fai, 0)                                           AS fai,
               COALESCE(p.greg, '')                                         AS greg
          FROM pilotresult pr
          JOIN pilots      p  ON p.class   = pr.class AND p.compno = pr.compno
          JOIN classes     cl ON cl.class  = pr.class
          JOIN competition c  ON c.compid  = cl.compid
          LEFT JOIN tracker t ON t.class   = pr.class AND t.compno = pr.compno
         WHERE pr.class    = ${className}
           AND pr.datecode = ${datecode}
           AND pr.start    IS NOT NULL AND pr.start  <> '00:00:00'
           AND pr.start    >= '09:00:00'
    `);
    return rows.map((r) => ({
        compno: r.compno,
        name: `${r.firstname} ${r.lastname}`.trim() || String(r.compno),
        trackerid: r.trackerid,
        startUtc: Number(r.startUtc) as Epoch,
        finishUtc: r.finishUtc === null ? null : (Number(r.finishUtc) as Epoch),
        glidertype: r.glidertype,
        homeclub: r.homeclub,
        country: r.country,
        fai: Number(r.fai) || 0,
        greg: r.greg
    }));
}

// Load prior evidence for one (class, datecode), keyed by
// `${compno}|${flarmid}`. The prior signal is built ONLY from each prior
// day's start/finish line crossings (`delta_start` / `delta_finish`) via
// `crossingScore` — never from the composite score, margin, or any ddb /
// flarm_* identity evidence (all of which are recomputed live each run, so
// persisting them into the prior would double-count and stale). Each task
// day contributes at most MAX_PRIOR_PER_DAY_NATS and a day with no crossing
// contributes 0, so repeated confirmations of the same pair accumulate while
// a single shaky day can't dominate. Decay is on the *task-day* timeline
// (not calendar days) so weather/rest days don't erode priors. The prior is
// therefore ≥0; a pair's total is only driven negative later, by the
// contention guard, when a different glider confidently holds the flarmid.
//
// The task-day ordering is derived from the distinct datecodes that
// actually carry evidence in `trackerhistory` for this class (plus the
// day being scanned). It is NOT taken from `tasks`: by design `tasks`
// holds only the current day's task per class, so it can never supply
// the prior days' ranks — using it dropped every prior. Days that left
// no evidence (rest/weather days) simply don't appear in the ordering,
// which is exactly the task-day-not-calendar-day decay we want.
// Datecodes are hex-ish and sort chronologically as plain strings.
//
// Scope is per-class. `class` is the only key here; the comp is implied
// because every datecode for a given class belongs to one competition
// and tracks the same physical glider.
type PriorMap = Map<string, number>;
let priorEvidenceUnavailable = false; // latched after first schema failure so we don't spam the log
async function loadPriorEvidence(currentDatecode: Datecode, className: ClassName): Promise<PriorMap> {
    if (priorEvidenceUnavailable) return new Map();
    let priorRows: {compno: Compno; flarmid: string; datecode: string; delta_start: number | null; delta_finish: number | null; method: string}[] = [];
    try {
        priorRows = await mysql.query<
            {
                compno: Compno;
                flarmid: string;
                datecode: string;
                delta_start: number | null;
                delta_finish: number | null;
                method: string;
            }[]
        >(escape`
            SELECT compno, flarmid, datecode, delta_start, delta_finish, method
            FROM trackerhistory
            WHERE class = ${className}
              AND datecode IS NOT NULL
              AND datecode <> ${String(currentDatecode)}
              AND method NOT IN ('ogn-blocked','flarmnet-blocked','ddb-blocked','none')
        `);
    } catch (e: any) {
        // If the migration hasn't been applied yet, the `class` /
        // `datecode` / `delta_*` columns on trackerhistory don't exist
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
    // Rank the evidence-bearing datecodes (current day included) by string
    // order so taskDaysAgo counts task days, not calendar days.
    const days = new Set<string>([String(currentDatecode)]);
    for (const r of priorRows) days.add(String(r.datecode));
    const taskDayIndex = new Map<string, number>();
    [...days].sort().forEach((d, i) => taskDayIndex.set(d, i));
    const currentRank = taskDayIndex.get(String(currentDatecode))!; // always present — seeded above

    const grouped = new Map<string, {scoreNats: number; taskDaysAgo: number}[]>();
    for (const r of priorRows) {
        const rowRank = taskDayIndex.get(String(r.datecode));
        if (rowRank === undefined) continue; // not a task day for this comp
        const taskDaysAgo = currentRank - rowRank;
        if (taskDaysAgo < 0) continue;
        const key = `${String(r.compno)}|${r.flarmid}`;
        const arr = grouped.get(key) ?? [];
        // Prior is crossing-only: that day's Δstart/Δfinish, capped per day.
        arr.push({scoreNats: crossingScore(r.delta_start === null ? null : Number(r.delta_start), r.delta_finish === null ? null : Number(r.delta_finish)), taskDaysAgo});
        grouped.set(key, arr);
    }

    const out: PriorMap = new Map();
    for (const [key, rows] of grouped) {
        out.set(key, summarisePrior(rows));
    }
    return out;
}

// ---- Cross-competition identity evidence --------------------------------
// Collection + scoring use the privacy-preserving fingerprint store in
// lib/scoring/shared/identity.ts, keyed on the flarmid (= the aircraft).
// Disabled entirely when IDENTITY_HMAC_SECRET is unset — we won't hash names
// without a salt; the scan still runs, just without xc* signals.
// identityTablesUnavailable latches after the first missing-table error so an
// unmigrated DB doesn't spam the log (mirrors priorEvidenceUnavailable).
const identityEnabled = !!process.env.IDENTITY_HMAC_SECRET;
let identityWarned = false;
let identityTablesUnavailable = false;
function warnIdentityDisabledOnce(): void {
    if (identityWarned) return;
    identityWarned = true;
    console.warn('  (IDENTITY_HMAC_SECRET unset — cross-comp identity signals disabled this run)');
}
// ONLY a genuinely-absent table counts as "not migrated yet" (a legitimate
// silent skip until the migration is applied). A column mismatch — e.g. the
// flarm_* tables exist but predate the fai→fai_hash change — is a real bug we
// must NOT swallow; it falls through and is reported by main().catch.
function isMissingTable(e: any): boolean {
    const msg = String(e?.code ?? e?.message ?? e);
    return /ER_NO_SUCH_TABLE|no such table|doesn't exist/i.test(msg);
}

// Per-flarmid cross-comp evidence: one PerCompEvidence per OTHER competition the
// aircraft flew in (the current comp is excluded at load time).
type PriorAircraftMap = Map<FlarmID, PerCompEvidence[]>;

// Build each pilot's cross-comp fingerprint for one class. Resolves the
// country once across the roster (comp-country fallback when >90% single-
// country or no pilot states a country). Empty map when identity is disabled.
function buildCandidateFacets(results: OfficialResult[], job: Job): Map<Compno, IdentityFacets> {
    const out = new Map<Compno, IdentityFacets>();
    if (!identityEnabled) {
        warnIdentityDisabledOnce();
        return out;
    }
    const resolution = resolveCountries(
        results.map((r) => r.country),
        job.countrycode
    );
    for (const r of results) {
        const country = resolvePilotCountry(r.country, resolution, job.countrycode);
        out.set(
            r.compno,
            fingerprintFromPilot({
                name: r.name,
                homeclub: r.homeclub || null,
                glidertype: r.glidertype || null,
                country,
                fai: r.fai || null,
                greg: r.greg || null,
                compno: String(r.compno)
            })
        );
    }
    return out;
}

// Bulk-load prior cross-comp evidence for the candidate flarmids, grouped per
// source competition. EXCLUDES the current comp (`currentCompid`) so the comp's
// own earlier days can't reinforce its pilots — that within-comp continuity is
// the separate trackerhistory `prior`. Also excludes evidence older than the
// retention window.
async function loadPriorAircraft(flarmids: FlarmID[], currentCompid: string): Promise<PriorAircraftMap> {
    const out: PriorAircraftMap = new Map();
    if (!identityEnabled || identityTablesUnavailable || !flarmids.length) return out;
    const ids = Array.from(new Set(flarmids.map((f) => String(f).toUpperCase())));
    try {
        const aircraftRows = await mysql.query<{flarmid: string; compid: string; glider_key: string | null; greg: string | null; country: string | null; compno: string | null; is_icao_id: string | null; match_score: number | null; last_seen_ms: number}[]>(
            escape`SELECT flarmid, compid, glider_key, greg, country, compno, is_icao_id, match_score,
                          UNIX_TIMESTAMP(last_seen) * 1000 AS last_seen_ms
                     FROM flarm_aircraft
                    WHERE flarmid IN (${ids}) AND compid <> ${currentCompid}
                      AND last_seen >= DATE_SUB(NOW(), INTERVAL ${IDENTITY_EXPIRY_MONTHS} MONTH)`
        );
        const pilotRows = await mysql.query<{flarmid: string; pilot_key: string; compid: string; club_hash: string | null; fai_hash: string | null}[]>(
            escape`SELECT flarmid, pilot_key, compid, club_hash, fai_hash
                     FROM flarm_pilot
                    WHERE flarmid IN (${ids}) AND compid <> ${currentCompid}
                      AND last_seen >= DATE_SUB(NOW(), INTERVAL ${IDENTITY_EXPIRY_MONTHS} MONTH)`
        );
        // Tokens are name-derived (comp-independent), keyed by (flarmid, pilot_key).
        const tokenRows = await mysql.query<{flarmid: string; pilot_key: string; token_hash: string}[]>(escape`SELECT flarmid, pilot_key, token_hash FROM flarm_pilot_nametoken WHERE flarmid IN (${ids})`);

        const tokensByPilot = new Map<string, string[]>(); // `${flarmid}|${pilot_key}` → tokens
        for (const t of tokenRows) {
            const k = `${t.flarmid}|${t.pilot_key}`;
            const arr = tokensByPilot.get(k) ?? [];
            arr.push(t.token_hash);
            tokensByPilot.set(k, arr);
        }
        // pilot clues, keyed (flarmid, compid) → pilot_key → evidence.
        const pilotsByComp = new Map<string, PilotEvidence[]>(); // `${flarmid}|${compid}`
        for (const p of pilotRows) {
            const k = `${p.flarmid}|${p.compid}`;
            const arr = pilotsByComp.get(k) ?? [];
            arr.push({tokenHashes: tokensByPilot.get(`${p.flarmid}|${p.pilot_key}`) ?? [], clubHash: p.club_hash, faiHash: p.fai_hash});
            pilotsByComp.set(k, arr);
        }
        for (const a of aircraftRows) {
            const fid = a.flarmid.toUpperCase() as FlarmID;
            const arr = out.get(fid) ?? [];
            arr.push({
                compid: a.compid,
                aircraft: {gliderKey: a.glider_key, greg: a.greg, country: a.country, compno: a.compno, isIcaoId: a.is_icao_id === 'Y'},
                pilots: pilotsByComp.get(`${a.flarmid}|${a.compid}`) ?? [],
                matchScore: a.match_score === null ? null : Number(a.match_score),
                lastSeenMs: Number(a.last_seen_ms)
            });
            out.set(fid, arr);
        }
    } catch (e) {
        if (isMissingTable(e)) {
            console.warn(`  (cross-comp identity tables don't exist yet — skipping identity this run. Apply conf/sql/migrations/20260601_flarm_aircraft.sql to enable.)`);
            identityTablesUnavailable = true;
            return new Map();
        }
        throw e;
    }
    return out;
}

// Forget cross-comp evidence not reconfirmed within IDENTITY_EXPIRY_MONTHS.
// Run once per invocation (not per class). Delete the expired per-comp pilot
// clues and aircraft rows FIRST, then garbage-collect name tokens that no
// surviving clue references — tokens are shared across a pilot's per-comp rows
// (comp-independent), so they must be reference-counted, not deleted by the
// expired-row set (which would strip tokens from a same-pilot clue that's still
// live in another comp). Idempotent — after the first sweep nothing's left.
async function purgeExpiredIdentity(): Promise<void> {
    if (!identityEnabled || identityTablesUnavailable || argv['dry-run']) return;
    try {
        const t = mysql.transaction();
        t.query(escape`DELETE FROM flarm_pilot   WHERE last_seen < DATE_SUB(NOW(), INTERVAL ${IDENTITY_EXPIRY_MONTHS} MONTH)`);
        t.query(escape`DELETE FROM flarm_aircraft WHERE last_seen < DATE_SUB(NOW(), INTERVAL ${IDENTITY_EXPIRY_MONTHS} MONTH)`);
        t.query(escape`
            DELETE tok FROM flarm_pilot_nametoken tok
             WHERE NOT EXISTS (
                   SELECT 1 FROM flarm_pilot p
                    WHERE p.flarmid = tok.flarmid AND p.pilot_key = tok.pilot_key)
        `);
        const res: any = await t.commit();
        const pilots = Number(res?.[0]?.affectedRows ?? 0);
        const aircraft = Number(res?.[1]?.affectedRows ?? 0);
        const tokens = Number(res?.[2]?.affectedRows ?? 0);
        if (aircraft || pilots || tokens) console.log(`identity-evidence: expired ${aircraft} aircraft / ${pilots} pilot clue${pilots === 1 ? '' : 's'} / ${tokens} orphaned token${tokens === 1 ? '' : 's'} (not reconfirmed in ${IDENTITY_EXPIRY_MONTHS} months)`);
    } catch (e) {
        if (isMissingTable(e)) {
            identityTablesUnavailable = true;
            return;
        }
        throw e;
    }
}

// Cross-comp identity evidence for one match's (pilot, flarmid): the single
// confidence-scaled, age-decayed best prior comp. Empty when the candidate has
// no fingerprint (identity disabled) or the flarmid has no prior-comp evidence.
const EMPTY_XC: XcEvidence = {nats: 0, facets: [], compid: null};
function computeXcBlock(m: TrackerMatch, candidateFacets: Map<Compno, IdentityFacets>, priorAircraft: PriorAircraftMap, nowMs: number): XcEvidence {
    const cand = candidateFacets.get(m.compno);
    const perComp = priorAircraft.get(m.flarmid);
    if (!cand || !perComp || !perComp.length) return EMPTY_XC;
    return xcEvidenceScore(cand, perComp, nowMs);
}

// A (pilot, flarmid) pair confident enough to seed cross-comp evidence. Either
// an applied startmatch this run, or a clean within-tolerance, non-ambiguous
// pair clearing the auto-apply gates (deliberately tighter than the evidence-
// ledger floor — these rows persist and influence other comps).
function isGoodMatch(m: TrackerMatch, scored: {score: ScoreBreakdown; margins: Margins} | undefined, acceptedPairs: Set<string>): boolean {
    if (acceptedPairs.has(scoreKey(m.compno, m.flarmid))) return true;
    if (!scored) return false;
    if (m.ambiguous || !m.withinTolerance) return false;
    return scored.score.total >= DEFAULT_SCORE_MIN_NATS && scored.margins.margin >= DEFAULT_AUTO_MARGIN_NATS;
}

// Count distinct, non-blocked good (pilot, flarmid) pairs — for --dry-run.
function countGoodMatches(matches: TrackerMatch[], scoreMap: ScoreMap, ddb: Record<string, DDBEntry> | null, trackingconsent: string): number {
    const seen = new Set<string>();
    for (const m of matches) {
        const key = scoreKey(m.compno, m.flarmid);
        if (seen.has(key)) continue;
        if (!isGoodMatch(m, scoreMap.get(key), new Set())) continue;
        if (isBlocked(ddbLookup(ddb, m.flarmid), trackingconsent)) continue;
        seen.add(key);
    }
    return seen.size;
}

// Collect cross-comp identity evidence from this class's confident matches.
// Aircraft attributes (glider/greg/country/compno) upsert per flarmid; pilot
// clues (name tokens, club, fai) accumulate per distinct identity. DDB-blocked
// devices are skipped entirely — no aircraft row, no pilot clue, no tokens.
async function writeAircraftEvidence(job: Job, matches: TrackerMatch[], scoreMap: ScoreMap, accepted: Proposal[], candidateFacets: Map<Compno, IdentityFacets>, ddb: Record<string, DDBEntry> | null): Promise<number> {
    if (!identityEnabled || identityTablesUnavailable) return 0;
    const acceptedPairs = new Set<string>();
    for (const p of accepted) for (const id of p.addedIds) acceptedPairs.add(scoreKey(p.compno, id));

    // The physical-track match confidence (nats) we store as this comp's
    // evidence strength — never the prior/identity-inflated total (see
    // physicalMatchScore), so evidence can't feed back on itself across comps.
    const good = new Map<string, {compno: Compno; flarmid: FlarmID; matchScore: number}>();
    for (const m of matches) {
        const key = scoreKey(m.compno, m.flarmid);
        if (good.has(key)) continue;
        const scored = scoreMap.get(key);
        if (!isGoodMatch(m, scored, acceptedPairs)) continue;
        good.set(key, {compno: m.compno, flarmid: m.flarmid, matchScore: scored ? physicalMatchScore(scored.score) : 0});
    }
    if (!good.size) return 0;

    const compid = job.compid;
    const t = mysql.transaction();
    let n = 0;
    for (const {compno, flarmid, matchScore} of good.values()) {
        // Never collect blocked devices, nor any detail about their pilots.
        if (isBlocked(ddbLookup(ddb, flarmid), job.trackingconsent)) continue;
        const facets = candidateFacets.get(compno);
        if (!facets) continue;
        const fid = String(flarmid).toUpperCase();
        const isIcao = flarmidIsIcao(fid) ? 'Y' : 'N';
        // GREATEST keeps the best confidence the comp ever produced for this
        // pair — "updates as the competition goes on" without ever regressing.
        t.query(escape`
            INSERT INTO flarm_aircraft
                (flarmid, compid, glider_key, greg, country, compno, is_icao_id, match_score, observations, first_seen, last_seen)
            VALUES
                (${fid}, ${compid}, ${facets.gliderKey}, ${facets.greg}, ${facets.country}, ${facets.compno}, ${isIcao}, ${matchScore}, 1, now(), now())
            ON DUPLICATE KEY UPDATE
                observations = observations + 1,
                last_seen    = now(),
                match_score  = GREATEST(COALESCE(match_score, 0), VALUES(match_score)),
                glider_key   = COALESCE(VALUES(glider_key), glider_key),
                greg         = COALESCE(VALUES(greg), greg),
                country      = COALESCE(VALUES(country), country),
                compno       = COALESCE(VALUES(compno), compno),
                is_icao_id   = VALUES(is_icao_id)
        `);
        if (hasPilotEvidence(facets)) {
            const pk = pilotKey(facets);
            t.query(escape`
                INSERT INTO flarm_pilot
                    (flarmid, pilot_key, compid, club_hash, fai_hash, match_score, observations, first_seen, last_seen)
                VALUES
                    (${fid}, ${pk}, ${compid}, ${facets.clubHash}, ${facets.faiHash}, ${matchScore}, 1, now(), now())
                ON DUPLICATE KEY UPDATE
                    observations = observations + 1,
                    last_seen    = now(),
                    match_score  = GREATEST(COALESCE(match_score, 0), VALUES(match_score)),
                    club_hash    = COALESCE(VALUES(club_hash), club_hash),
                    fai_hash     = COALESCE(VALUES(fai_hash), fai_hash)
            `);
            for (const th of facets.nameTokenHashes) {
                t.query(escape`INSERT IGNORE INTO flarm_pilot_nametoken (flarmid, pilot_key, token_hash) VALUES (${fid}, ${pk}, ${th})`);
            }
        }
        n++;
    }
    if (!n) return 0;
    try {
        await t.commit();
    } catch (e) {
        if (isMissingTable(e)) {
            console.warn(`  (cross-comp identity tables don't exist yet — collection skipped. Apply conf/sql/migrations/20260601_flarm_aircraft.sql to enable.)`);
            identityTablesUnavailable = true;
            return 0;
        }
        throw e;
    }
    console.log(`  identity-evidence: collected ${n} aircraft/pilot association${n === 1 ? '' : 's'}`);
    return n;
}

// Two classes in the same comp/day are "task twins" when their flown task
// has the same ordered turnpoint sequence (by legno). That happens when one
// physical fleet is scored under two class definitions (e.g. a combined and
// a handicap class) — the same glider legitimately flies in both, under the
// same compno. A flarmid matching that pilot in a twin class is therefore
// NOT a cross-class "moved glider" conflict and must not drive removal of
// the (correct) assignment. The task `hash` column can't be used to detect
// this — it includes free-text comments — so we compare the ntrigraph
// sequence directly. Returns className → set of its twin classNames.
//
// Scope is one (compid, datecode) group: we query taskleg by datecode, then
// keep only the classes in this group, so twins are never matched across
// competitions even if a datecode is shared.
async function loadTaskTwins(classNames: ClassName[], datecode: Datecode): Promise<Map<ClassName, Set<ClassName>>> {
    const twins = new Map<ClassName, Set<ClassName>>();
    if (classNames.length < 2) return twins;
    const inGroup = new Set<string>(classNames.map(String));
    const rows = await mysql.query<{class: ClassName; sig: string | null}[]>(escape`
        SELECT tl.class AS class,
               GROUP_CONCAT(tl.ntrigraph ORDER BY tl.legno) AS sig
        FROM taskleg tl
        JOIN tasks t ON t.taskid = tl.taskid AND t.flown = 'Y'
        WHERE tl.datecode = ${String(datecode)}
        GROUP BY tl.class, tl.taskid
    `);
    const bySig = new Map<string, ClassName[]>();
    for (const r of rows) {
        if (r.sig === null || !inGroup.has(String(r.class))) continue;
        const arr = bySig.get(r.sig) ?? [];
        arr.push(r.class);
        bySig.set(r.sig, arr);
    }
    for (const classes of bySig.values()) {
        if (classes.length < 2) continue;
        for (const c of classes) {
            const set = twins.get(c) ?? new Set<ClassName>();
            for (const other of classes) if (other !== c) set.add(other);
            twins.set(c, set);
        }
    }
    return twins;
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

function crossClassHitsFor(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined): CrossClassHit[] {
    if (!crossClass) return [];
    const all = crossClass.get(flarmid);
    if (!all) return [];
    return all.filter((h) => h.className !== thisClass);
}

// Cross-class hits that represent a genuine "moved glider" conflict — i.e.
// excluding hits to a task-twin class for the *same* compno, which are just
// the same glider scored in two classes (see loadTaskTwins). A hit to a twin
// class under a *different* compno is still a real conflict and kept.
function conflictingCrossClassHits(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined, twinClasses: Set<ClassName>, compno: Compno): CrossClassHit[] {
    return crossClassHitsFor(flarmid, thisClass, crossClass).filter((h) => !(twinClasses.has(h.className) && h.compno === compno));
}

/**
 * Short one-liner per cross-class hit. Used in proposal `reason` strings
 * (which get joined into a single-line CSV-friendly log entry).
 */
function describeCrossClass(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined): string[] {
    return crossClassHitsFor(flarmid, thisClass, crossClass).map((h) => {
        const classLabel = h.classDisplay ? `${h.classDisplay} [${h.className}]` : h.className;
        const tag = h.assigned ? ' [their assigned ID]' : '';
        return `also matches ${String(h.compno).trim()} in class ${classLabel}${tag}`;
    });
}

/**
 * Multi-line printout per cross-class hit: header + Δstart/Δfinish + the
 * other class's score breakdown (S, margins, contribs including any prior
 * evidence). Used only in the per-pilot report, not in proposal reasons.
 */
function describeCrossClassDetailed(flarmid: FlarmID, thisClass: ClassName, crossClass: CrossClassMap | undefined): string[][] {
    return crossClassHitsFor(flarmid, thisClass, crossClass).map((h) => {
        const classLabel = h.classDisplay ? `${h.classDisplay} [${h.className}]` : h.className;
        const tag = h.assigned ? ' [their assigned ID]' : '';
        const compno = String(h.compno).trim();
        const deltas = `Δstart ${fmtDelta(h.deltaStart)}, Δfinish ${fmtDelta(h.deltaFinish)}`;
        return [`also matches ${compno} in class ${classLabel}${tag}: ${deltas}`, `  ${fmtScore(h.score, h.margins, h.pilotContested, h.flarmidContested, h.xcFacets, h.demoted)}`];
    });
}

/**
 * Multi-line printout per *same-class* contender: other pilots in this class
 * whose track also matches this flarmid. The cross-class annotation only
 * covers other classes, so without this a tracker that two same-class pilots
 * both claim (e.g. near-simultaneous starters) shows no hint that the flarmid
 * already belongs to — and strongly matches — another pilot. Flags the peer's
 * assigned ID and shows its score so the stronger claim is obvious.
 */
function describeSameClassDetailed(m: TrackerMatch, byFlarmid: Map<FlarmID, TrackerMatch[]>, scoreMap?: ScoreMap): string[][] {
    const peers = (byFlarmid.get(m.flarmid) ?? []).filter((p) => p.compno !== m.compno);
    return peers.map((p) => {
        const compno = String(p.compno).trim();
        const tag = p.assigned ? ' [their assigned ID]' : '';
        const deltas = `Δstart ${fmtDelta(p.deltaStart)}, Δfinish ${fmtDelta(p.deltaFinish)}`;
        const lines = [`also matches ${compno} in this class${tag}: ${deltas}`];
        const scored = scoreMap?.get(scoreKey(p.compno, p.flarmid));
        if (scored) lines.push(`  ${fmtScore(scored.score, scored.margins, scored.pilotContested, scored.flarmidContested, scored.xcFacets, scored.demoted)}`);
        return lines;
    });
}

type ScoreMap = Map<string, {score: ScoreBreakdown; margins: Margins; pilotContested: boolean; flarmidContested: boolean; deltaStart: number | null; deltaFinish: number | null; xcFacets: string[]; demoted: boolean}>;
const scoreKey = (compno: Compno, flarmid: FlarmID) => `${compno}|${flarmid}`;

// Build per-pair scores and two-sided margins from the matches we already
// have. Since the candidate set is bounded by what `findTrackerMatches`
// returns (within-tolerance + assigned), margins here are best-vs-next-best
// among reported candidates only — true joint optimisation comes later.
function computeScoreMap(
    matches: TrackerMatch[],
    results: OfficialResult[],
    ddb: Record<string, DDBEntry> | null,
    priorMap: PriorMap,
    candidateFacets: Map<Compno, IdentityFacets> = new Map(),
    priorAircraft: PriorAircraftMap = new Map()
): ScoreMap {
    if (!matches.length) return new Map();
    const earliestPilotStartUtc = results.reduce((m, r) => Math.min(m, r.startUtc), Number.POSITIVE_INFINITY);
    const resultByCompno = new Map<Compno, OfficialResult>();
    for (const r of results) resultByCompno.set(r.compno, r);

    const breakdownByKey = new Map<string, ScoreBreakdown>();
    const xcFacetsByKey = new Map<string, string[]>();
    const nowMs = Date.now();

    // Pass 1: score every pair. Record each pair's baseline (operator
    // assignment) flag so the contention guard can prefer protecting an
    // existing good assignment.
    const pairs: {compno: Compno; flarmid: FlarmID; total: number; baseline: boolean}[] = [];
    for (const m of matches) {
        const r = resultByCompno.get(m.compno);
        const ddbEntry = ddbLookup(ddb, m.flarmid);
        const link = ddbLinkFor(ddbEntry, m.compno, r?.glidertype ?? '');
        const priorNats = priorMap.get(scoreKey(m.compno, m.flarmid)) ?? 0;
        const xc = computeXcBlock(m, candidateFacets, priorAircraft, nowMs);
        const sig = signalsFromMatch(m, earliestPilotStartUtc, link, priorNats, xc);
        const breakdown = scoreSignals(sig);
        breakdownByKey.set(scoreKey(m.compno, m.flarmid), breakdown);
        xcFacetsByKey.set(scoreKey(m.compno, m.flarmid), xc.facets);
        pairs.push({compno: m.compno, flarmid: m.flarmid, total: breakdown.total, baseline: m.assigned});
    }

    // Contention guard: once a flarmid is confidently held by one glider,
    // negate every weaker contender's (prior + current) total so a poor match
    // can't displace a likely-good one. Apply BEFORE margins/peer arrays so the
    // negated totals flow through to the two-sided margins.
    const penalised = contentionPenalty(
        pairs.map((p) => ({compno: String(p.compno), flarmid: String(p.flarmid), total: p.total, baseline: p.baseline})),
        (compno, flarmid) => `${compno}|${flarmid}`
    );
    for (const key of penalised) {
        const b = breakdownByKey.get(key);
        if (b) b.total = -b.total;
    }

    // Pass 2: build peer arrays from the (possibly negated) totals.
    const scoreByPilot = new Map<Compno, number[]>();
    const scoreByFlarmid = new Map<FlarmID, number[]>();
    for (const m of matches) {
        const total = breakdownByKey.get(scoreKey(m.compno, m.flarmid))!.total;
        const arrP = scoreByPilot.get(m.compno) ?? [];
        arrP.push(total);
        scoreByPilot.set(m.compno, arrP);
        const arrF = scoreByFlarmid.get(m.flarmid) ?? [];
        arrF.push(total);
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
            deltaFinish: m.deltaFinish,
            xcFacets: xcFacetsByKey.get(scoreKey(m.compno, m.flarmid)) ?? [],
            demoted: penalised.has(scoreKey(m.compno, m.flarmid))
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

function signalsFromMatch(m: TrackerMatch, earliestPilotStartUtc: number, link: DdbLink, priorNats: number, xc: XcEvidence): Signals {
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
        priorNats,
        xcNats: xc.nats
    };
}

function printMatches(results: OfficialResult[], matches: TrackerMatch[], tolerance: number, scoreMap: ScoreMap, crossClass?: CrossClassMap, thisClass?: ClassName): void {
    if (!matches.length) {
        console.log(`  (no matches, no assigned-tracker reports)`);
        return;
    }
    // Group by compno; also by flarmid so a candidate can be annotated with
    // the other same-class pilots that match the same tracker.
    const byPilot = new Map<Compno, TrackerMatch[]>();
    const byFlarmid = new Map<FlarmID, TrackerMatch[]>();
    for (const m of matches) {
        const arr = byPilot.get(m.compno) ?? [];
        arr.push(m);
        byPilot.set(m.compno, arr);
        const arrF = byFlarmid.get(m.flarmid) ?? [];
        arrF.push(m);
        byFlarmid.set(m.flarmid, arrF);
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
        printPilotMatches(compno, byPilot.get(compno)!, results, tolerance, scoreMap, crossClass, thisClass, byFlarmid);
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

function printPilotMatches(
    compno: Compno,
    arr: TrackerMatch[],
    results: OfficialResult[],
    tolerance: number,
    scoreMap?: ScoreMap,
    crossClass?: CrossClassMap,
    thisClass?: ClassName,
    byFlarmid?: Map<FlarmID, TrackerMatch[]>
): void {
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
        if (scored) console.log(`         · ${fmtScore(scored.score, scored.margins, scored.pilotContested, scored.flarmidContested, scored.xcFacets, scored.demoted)}`);
        if (byFlarmid) {
            for (const lines of describeSameClassDetailed(m, byFlarmid, scoreMap)) {
                for (const [i, line] of lines.entries()) {
                    console.log(`         ${i === 0 ? '↳' : ' '} ${line}`);
                }
            }
        }
        if (thisClass) {
            for (const lines of describeCrossClassDetailed(m.flarmid, thisClass, crossClass)) {
                for (const [i, line] of lines.entries()) {
                    console.log(`         ${i === 0 ? '↳' : ' '} ${line}`);
                }
            }
        }
    }
}

function fmtScore(score: ScoreBreakdown, margins: Margins, pilotContested: boolean, flarmidContested: boolean, xcFacets: string[] = [], demoted = false): string {
    const parts: string[] = [];
    parts.push(`S=${score.total.toFixed(2)}${demoted ? ' (demoted: flarmid confidently held elsewhere)' : ''}`);
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
    // Single cross-comp identity contribution, with the facets that fired in the
    // chosen prior comp (xcEvidenceScore already excluded the current comp).
    if (score.xc > 0) contribs.push(`xc=${score.xc.toFixed(2)}${xcFacets.length ? ` [${xcFacets.join(',')}]` : ''}`);
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
    // Start/finish crossing deltas for the chosen flarmid (the addedId, or the
    // assigned flarmid being removed when there's no addedId). These are the
    // ONLY score context persisted on the applied trackerhistory row — the next
    // day's prior loader rebuilds its crossing score from them. Everything else
    // (composite score, margin, ddb link) is derivable live and is not stored.
    deltaStart: number | null;
    deltaFinish: number | null;
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

function computeProposals(matches: TrackerMatch[], scoreMap: ScoreMap, crossClass: CrossClassMap, thisClass: ClassName, twinClasses: Set<ClassName>): Proposal[] {
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
            const crossClassHit = conflictingCrossClassHits(m.flarmid, thisClass, crossClass, twinClasses, compno).length > 0;
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

        // Pull the crossing deltas for the flarmid we're acting on. Prefer the
        // addedId (the new chosen flarmid), else the assigned flarmid being
        // removed. Null when that flarmid never produced a tracked crossing.
        const focusFlarmid = addId ?? Array.from(removeIds)[0];
        const focusMatch = focusFlarmid ? rows.find((m) => m.flarmid === focusFlarmid) : undefined;
        out.push({
            compno,
            name: first.name,
            currentTrackerid: first.currentTrackerid,
            newTrackerid,
            addedIds: addId ? [addId] : [],
            removedIds: Array.from(removeIds),
            reason,
            deltaStart: focusMatch?.deltaStart ?? null,
            deltaFinish: focusMatch?.deltaFinish ?? null
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

    // Built from the full match set so the per-proposal view (which filters
    // to one pilot) can still annotate same-class contenders for a flarmid.
    const byFlarmid = new Map<FlarmID, TrackerMatch[]>();
    for (const m of matches) {
        const arrF = byFlarmid.get(m.flarmid) ?? [];
        arrF.push(m);
        byFlarmid.set(m.flarmid, arrF);
    }

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
            thisClass,
            byFlarmid
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
                     delta_start, delta_finish)
                VALUES
                    (${p.compno}, now(), ${String(flarmid)}, 'startmatch', ${className}, ${String(datecode)},
                     ${p.deltaStart}, ${p.deltaFinish})
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
    const writes: {compno: Compno; flarmid: FlarmID; deltaStart: number | null; deltaFinish: number | null}[] = [];
    for (const [key, v] of scoreMap) {
        if (v.score.total < DEFAULT_LEDGER_MIN_NATS) continue;
        if (appliedKeys.has(key)) continue;
        const [compno, flarmid] = key.split('|') as [Compno, FlarmID];
        // Persist only the crossing deltas — the prior is rebuilt from these.
        writes.push({compno, flarmid, deltaStart: v.deltaStart, deltaFinish: v.deltaFinish});
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
                 delta_start, delta_finish)
            VALUES
                (${w.compno}, now(), ${w.flarmid}, 'evidence', ${className}, ${String(datecode)},
                 ${w.deltaStart}, ${w.deltaFinish})
        `);
    }
    await t.commit();
    if (writes.length) console.log(`  Wrote ${writes.length} evidence row${writes.length === 1 ? '' : 's'}.`);
    return writes.length;
}
