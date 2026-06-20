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
import {scoreSignals, computeMargins, summarisePrior, crossingScore, negCrossScore, applyContentionPenalties, physicalMatchScore, type Signals, type ScoreBreakdown, type Margins} from '../lib/scoring/shared/trackerScore';
import {computeProposals, applyPathSimilarityToProposals, liftSameFlightDemotions, scoreKey, parseCurrentIds, crossClassHitsFor, type Proposal, type ScoreMap, type CrossClassMap} from '../lib/scoring/shared/proposals';
import {runPathComparison, resolveSameFlight, formatPathSimilarity, pathPriorKey, type PathSimilarityResult, type PathPriorMap} from '../lib/scoring/shared/pathSimilarity';
import {loadMergedDDB, gliderEquivalent, isBlocked, type DDBEntry} from '../lib/ddb';
import {
    fingerprintFromPilot,
    pilotKey,
    hasPilotEvidence,
    flarmidIsIcao,
    resolveCountries,
    resolvePilotCountry,
    samePilotName,
    xcEvidenceScore,
    type IdentityFacets,
    type PilotEvidence,
    type PerCompEvidence,
    type XcEvidence
} from '../lib/scoring/shared/identity';
import {DEFAULT_LEDGER_MIN_NATS, DEFAULT_AUTO_MARGIN_NATS, DEFAULT_SCORE_MIN_NATS, IDENTITY_EXPIRY_MONTHS, MAX_PRIOR_PER_DAY_NATS} from '../lib/constants';

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
    excludeStart: boolean;
    priorMap: PriorMap;
    priorAircraft: PriorAircraftMap;
    // Per-pilot cross-comp identity fingerprint (empty when identity disabled).
    // Built in pass 1a and reused for collection in pass 3.
    candidateFacets: Map<Compno, IdentityFacets>;
    // Most recent authoritative trackerhistory method per `${compno}|${flarmid}`.
    // Used to suppress the baseline signal when the assignment was auto-sourced
    // from ognddb (which already contributes via ddbCn, making baseline a double-count).
    assignmentMethodMap: Map<string, string>;
    // Filled in pass 1c — scoring needs the group-level twin-pilot evidence
    // from pass 1b, so it can't happen during the per-class scan.
    scoreMap: ScoreMap;
    // Filled in pass 1d — path similarity results for ambiguous same-pilot pairs.
    sameFlightMap: Map<Compno, PathSimilarityResult>;
    // Prior path-similarity evidence from earlier task days for this class.
    pathPriorMap: PathPriorMap;
    // Same-compno+name pilots whose other class flies a DIFFERENT task —
    // printed once at the top of this class's results block.
    twinWarnings: string[];
}

interface GroupSummary {
    pilots: number;
    matched: number;
    ambiguous: number;
    proposed: number;
    applied: number;
}

// A set of entries (one per class) that all refer to the same physical pilot
// (same compno AND samePilotName). The identification decision made in any
// one class is propagated to the others in the twin-pilot sync pass.
interface TwinPilotGroup {
    compno: Compno;
    name: string;
    entries: Array<{cm: ClassMatches; result: OfficialResult}>;
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

        // Grand-prix / regatta start: when the class is grandprix-scored AND
        // every pilot shares one common start time, the start-line crossing is
        // identical for everyone and so carries no information for telling
        // pilots apart. Exclude the start signal (live and in the prior) from
        // scoring; the finish crossing still discriminates.
        const sameStartForAll = new Set(results.map((r) => r.startUtc)).size === 1;
        const excludeStart = results[0].grandprixstart && sameStartForAll;
        if (excludeStart) console.log(`  grandprix start with a single common start time — excluding start-line crossing from scoring`);

        // Prior evidence and cross-comp identity load here in pass 1a;
        // scoring waits for pass 1c so it can include the group-level
        // twin-pilot evidence built in pass 1b.
        const priorMap = await loadPriorEvidence(datecode, className, excludeStart);
        if (priorMap.size) console.log(`  loaded ${priorMap.size} prior crossing-score${priorMap.size === 1 ? '' : 's'} from earlier task days`);

        const assignmentMethodMap = await loadAssignmentMethods(className);

        // Cross-comp identity: build each pilot's privacy-preserving
        // fingerprint and load what we've previously associated with the
        // candidate flarmids in OTHER comps. Disabled (empty) without a secret.
        const candidateFacets = buildCandidateFacets(results, job);
        const priorAircraft = await loadPriorAircraft(
            matches.map((m) => m.flarmid),
            job.compid
        );
        if (priorAircraft.size) console.log(`  loaded cross-comp identity for ${priorAircraft.size} flarmid${priorAircraft.size === 1 ? '' : 's'}`);

        classMatches.push({job, results, matches, excludeStart, priorMap, priorAircraft, candidateFacets, assignmentMethodMap, scoreMap: new Map(), sameFlightMap: new Map(), pathPriorMap: new Map(), twinWarnings: []});
    }

    // Pass 1b — group-level maps.
    //
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

    // Twin-pilot groups: pilots (same compno+name) in 2+ classes of this
    // (compid, datecode). Used in pass 3 to propagate the identification
    // decision across classes — one physical aircraft, one decision.
    const twinPilotGroups: TwinPilotGroup[] = [];
    if (classMatches.length > 1) {
        const byCompno = new Map<Compno, Array<{cm: ClassMatches; result: OfficialResult}>>();
        for (const cm of classMatches) {
            for (const r of cm.results) {
                const arr = byCompno.get(r.compno) ?? [];
                arr.push({cm, result: r});
                byCompno.set(r.compno, arr);
            }
        }
        for (const [compno, entries] of byCompno) {
            if (entries.length < 2) continue;
            // Group by name using samePilotName (accent/case-normalised token-set compare).
            const nameGroups: Array<Array<{cm: ClassMatches; result: OfficialResult}>> = [];
            for (const entry of entries) {
                let placed = false;
                for (const ng of nameGroups) {
                    if (samePilotName(entry.result.name, ng[0].result.name)) {
                        ng.push(entry);
                        placed = true;
                        break;
                    }
                }
                if (!placed) nameGroups.push([entry]);
            }
            for (const ng of nameGroups) {
                if (ng.length < 2) continue;
                twinPilotGroups.push({compno, name: ng[0].result.name, entries: ng});
            }
        }
        // Warn once per (pilot, class) pair when the twin classes fly different tasks.
        for (const tpg of twinPilotGroups) {
            for (const {cm, result} of tpg.entries) {
                const thisClassTwins = twinMap.get(cm.job.className) ?? new Set<ClassName>();
                for (const {cm: otherCm} of tpg.entries) {
                    if (otherCm === cm) continue;
                    if (!thisClassTwins.has(otherCm.job.className)) {
                        const otherLabel = otherCm.job.classDisplay ? `${otherCm.job.classDisplay} [${otherCm.job.className}]` : String(otherCm.job.className);
                        cm.twinWarnings.push(`⚠ ${String(result.compno).trim()} (${result.name}) also appears in class ${otherLabel} with a different task — identification will be synced`);
                    }
                }
            }
        }
    }

    // Pass 1c — score each class independently (no twin signal — the
    // identification decision is shared in pass 3, not pre-empted here).
    for (const cm of classMatches) {
        cm.scoreMap = computeScoreMap(cm.matches, cm.results, ddb, cm.priorMap, cm.candidateFacets, cm.priorAircraft, cm.excludeStart, cm.assignmentMethodMap);
    }

    // Pass 1d — path similarity for ambiguous same-pilot pairs.
    // Runs after scoring so pilot-side demotions can be lifted before proposals.
    for (const cm of classMatches) {
        const {results, matches, scoreMap, job} = cm;

        // Collect compnos where 2+ within-tolerance candidates exist for the same pilot.
        // Filter to ≥2 per compno: the ambiguous flag also fires for "same flarmid,
        // multiple pilots" — in that case each pilot ends up with only 1 candidate here.
        const ambiguousByPilot = new Map<Compno, TrackerMatch[]>();
        for (const m of matches) {
            if (!m.ambiguous || !m.withinTolerance) continue;
            const arr = ambiguousByPilot.get(m.compno) ?? [];
            arr.push(m);
            ambiguousByPilot.set(m.compno, arr);
        }
        for (const [compno, arr] of ambiguousByPilot) {
            if (arr.length < 2) ambiguousByPilot.delete(compno);
        }

        if (!ambiguousByPilot.size) continue;

        // Compute the scan window for loadStream: 2h before earliest start to
        // 1h after latest finish (same data the findTrackerMatches scan used).
        const allStarts = results.map((r) => r.startUtc);
        const allFinishes = results.flatMap((r) => (r.finishUtc !== null ? [r.finishUtc] : []));
        const minStart = Math.min(...allStarts);
        const maxFinish = allFinishes.length ? Math.max(...allFinishes) : Math.max(...allStarts) + 4 * 3600;
        const pathSince = minStart - 2 * 3600;
        const pathUntil = maxFinish + 3600;

        cm.pathPriorMap = await loadPriorPathSimilarity(job.datecode, job.className);
        if (cm.pathPriorMap.size) console.log(`  loaded path-similarity history for ${cm.pathPriorMap.size} pair${cm.pathPriorMap.size === 1 ? '' : 's'}`);

        const comparisonJobs: Promise<void>[] = [];
        for (const [compno, candidates] of ambiguousByPilot) {
            const pilot = results.find((r) => r.compno === compno);
            if (!pilot) continue;
            if (candidates.length > 2) console.log(`  ⚠ ${String(compno)} has ${candidates.length} ambiguous candidates — comparing top 2 by score`);
            const sorted = [...candidates].sort((a, b) => {
                const sa = scoreMap.get(scoreKey(a.compno, a.flarmid))?.score.total ?? -Infinity;
                const sb = scoreMap.get(scoreKey(b.compno, b.flarmid))?.score.total ?? -Infinity;
                return sb - sa;
            });
            const [mA, mB] = sorted;
            comparisonJobs.push(
                runPathComparison(mA.flarmid, mB.flarmid, pathSince, pathUntil, pilot.startUtc)
                    .then((r) => {
                        cm.sameFlightMap.set(compno, r);
                    })
                    .catch((e) => console.error(`  path comparison ${mA.flarmid}/${mB.flarmid} for ${String(compno)} failed:`, e))
            );
        }
        if (comparisonJobs.length) {
            console.log(`  running path similarity for ${comparisonJobs.length} ambiguous pilot${comparisonJobs.length === 1 ? '' : 's'}…`);
            await Promise.all(comparisonJobs);
        }

        // Lift pilot-side demotion for confirmed same-flight pairs (subject to
        // prior-evidence veto) so computeProposals can generate a join.
        liftSameFlightDemotions(scoreMap, cm.sameFlightMap, cm.pathPriorMap);
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
                demoted: scored.demoted,
                demotedReason: scored.demotedReason
            });
            crossClass.set(m.flarmid, arr);
        }
    }

    // Pass 3 — per-class results and proposals.
    const summary: GroupSummary = {pilots: 0, matched: 0, ambiguous: 0, proposed: 0, applied: 0};
    const multi = classMatches.length > 1;

    // Pass 3a — compute all proposals before reviewing any, so the
    // twin-pilot sync (3b) can see the full picture before any are applied.
    const proposalsByClass = new Map<ClassName, Proposal[]>();
    if (!argv['dry-run']) {
        for (const cm of classMatches) {
            const proposals = computeProposals(cm.matches, cm.scoreMap, crossClass, cm.job.className, twinMap.get(cm.job.className) ?? new Set<ClassName>(), cm.results);
            applyPathSimilarityToProposals(proposals, cm.sameFlightMap, cm.pathPriorMap, cm.matches, cm.results);
            proposalsByClass.set(cm.job.className, proposals);
        }
        // Pass 3b — twin-pilot sync: propagate the strongest identification
        // decision for a twin pilot to all other classes they appear in.
        if (twinPilotGroups.length > 0) {
            syncTwinPilotProposals(proposalsByClass, twinPilotGroups);
            syncDisplacementProposals(proposalsByClass, twinPilotGroups);
        }
    }

    // Pass 3c — print, review, apply per class.
    for (const cm of classMatches) {
        const {job, results, matches, scoreMap} = cm;
        const {className, datecode} = job;

        if (multi) {
            const classLabel = job.classDisplay ? `${job.classDisplay} [${className}]` : className;
            console.log(`\n--- ${classLabel} / ${datecode} — results ---`);
        }
        for (const w of cm.twinWarnings) console.log(`  ${w}`);

        // Always print the full report. The score breakdown is useful even
        // for clean pilots (operator can see what's holding the assignment
        // up). Per-proposal printPilotMatches in reviewProposals is the
        // focused review view atop this.
        printMatches(results, matches, tolerance, scoreMap, crossClass, className, cm.sameFlightMap, cm.pathPriorMap);

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

        const proposals = proposalsByClass.get(className) ?? [];
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
        const diagMap = new Map(matches.map((m) => [scoreKey(m.compno, m.flarmid), m.diag]));
        await writeEvidence(className, datecode, scoreMap, accepted, diagMap);
        await writePathSimilarityEvidence(className, datecode, cm.sameFlightMap);
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
            grandprixstart: 'Y' | 'N';
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
               COALESCE(p.greg, '')                                         AS greg,
               COALESCE(cl.grandprixstart, 'N')                             AS grandprixstart
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
        greg: r.greg,
        grandprixstart: r.grandprixstart === 'Y'
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
// Latched after the first missing-column error for the new dist/gap columns
// (conf/sql/migrations/*_trackerhistory_neg_signals.sql not yet applied).
// When true, prior evidence still uses the existing delta_start/delta_finish.
let negEvidenceUnavailable = false;

async function loadPriorEvidence(currentDatecode: Datecode, className: ClassName, excludeStart = false): Promise<PriorMap> {
    if (priorEvidenceUnavailable) return new Map();
    type FullRow = {compno: Compno; flarmid: string; datecode: string; delta_start: number | null; delta_finish: number | null; method: string; dist_at_start: number | null; gap_around_start: number | null; dist_at_finish: number | null; gap_around_finish: number | null};
    let priorRows: FullRow[] = [];
    let fetchedRows = false;

    if (!negEvidenceUnavailable) {
        try {
            priorRows = await mysql.query<FullRow[]>(escape`
                SELECT compno, flarmid, datecode, delta_start, delta_finish, method,
                       dist_at_start, gap_around_start, dist_at_finish, gap_around_finish
                FROM trackerhistory
                WHERE class = ${className}
                  AND datecode IS NOT NULL
                  AND datecode <> ${String(currentDatecode)}
                  AND method NOT IN ('ogn-blocked','flarmnet-blocked','ddb-blocked','none')
            `);
            fetchedRows = true;
        } catch (e: any) {
            const msg = String(e?.code ?? e?.message ?? e);
            if (/Unknown column|BAD_FIELD_ERROR|ER_BAD_FIELD/i.test(msg)) {
                negEvidenceUnavailable = true;
                console.warn(`  (negative-evidence schema not applied yet — prior will use crossing deltas only. Apply conf/sql/migrations/*_trackerhistory_neg_signals.sql to enable.)`);
            } else {
                throw e;
            }
        }
    }

    if (!fetchedRows) {
        // Migration for dist/gap columns not yet applied — fall back to crossing deltas only.
        type BaseRow = {compno: Compno; flarmid: string; datecode: string; delta_start: number | null; delta_finish: number | null; method: string};
        try {
            const base = await mysql.query<BaseRow[]>(escape`
                SELECT compno, flarmid, datecode, delta_start, delta_finish, method
                FROM trackerhistory
                WHERE class = ${className}
                  AND datecode IS NOT NULL
                  AND datecode <> ${String(currentDatecode)}
                  AND method NOT IN ('ogn-blocked','flarmnet-blocked','ddb-blocked','none')
            `);
            priorRows = base.map((r) => ({...r, dist_at_start: null, gap_around_start: null, dist_at_finish: null, gap_around_finish: null}));
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
        // For a grandprix common-start class the start crossing is excluded
        // (identical for everyone), so the prior is finish-only.
        const ds = excludeStart || r.delta_start === null ? null : Number(r.delta_start);
        const df = r.delta_finish === null ? null : Number(r.delta_finish);
        const pos = crossingScore(ds, df);
        const neg = negEvidenceUnavailable
            ? 0
            : negCrossScore(
                  ds,
                  r.gap_around_start === null ? null : Number(r.gap_around_start),
                  r.dist_at_start === null ? null : Number(r.dist_at_start),
                  df,
                  r.gap_around_finish === null ? null : Number(r.gap_around_finish),
                  r.dist_at_finish === null ? null : Number(r.dist_at_finish)
              );
        // Cap the combined per-day contribution symmetrically at ±MAX_PRIOR_PER_DAY_NATS
        // so a single bad day can't dominate the prior in either direction.
        const scoreNats = Math.max(-MAX_PRIOR_PER_DAY_NATS, Math.min(MAX_PRIOR_PER_DAY_NATS, pos + neg));
        arr.push({scoreNats, taskDaysAgo});
        grouped.set(key, arr);
    }

    const out: PriorMap = new Map();
    for (const [key, rows] of grouped) {
        out.set(key, summarisePrior(rows));
    }
    return out;
}

// Most recent authoritative trackerhistory method per `${compno}|${flarmid}`.
// Used to suppress the `baseline` signal when assignment came from ognddb, which
// already contributes via ddbCn=1.5 (double-counting the same DDB source).
// Returns empty map when the class column is unavailable (priorEvidenceUnavailable).
async function loadAssignmentMethods(className: ClassName): Promise<Map<string, string>> {
    if (priorEvidenceUnavailable) return new Map(); // class column not in schema
    const rows = await mysql.query<{compno: string; flarmid: string; method: string}[]>(escape`
        SELECT compno, flarmid, method
        FROM trackerhistory
        WHERE class = ${className}
          AND method NOT IN ('evidence', 'ogn-blocked', 'flarmnet-blocked', 'ddb-blocked', 'none')
        ORDER BY changed DESC
    `);
    // Most-recent-first due to ORDER BY; take first seen per (compno, flarmid).
    const out = new Map<string, string>();
    for (const r of rows) {
        const k = `${String(r.compno)}|${r.flarmid}`;
        if (!out.has(k)) out.set(k, r.method);
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
        const aircraftRows = await mysql.query<
            {flarmid: string; compid: string; glider_key: string | null; greg: string | null; country: string | null; compno: string | null; is_icao_id: string | null; match_score: number | null; last_seen_ms: number}[]
        >(
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
        if (aircraft || pilots || tokens)
            console.log(
                `identity-evidence: expired ${aircraft} aircraft / ${pilots} pilot clue${pilots === 1 ? '' : 's'} / ${tokens} orphaned token${tokens === 1 ? '' : 's'} (not reconfirmed in ${IDENTITY_EXPIRY_MONTHS} months)`
            );
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
        return [`also matches ${compno} in class ${classLabel}${tag}: ${deltas}`, `  ${fmtScore(h.score, h.margins, h.pilotContested, h.flarmidContested, h.xcFacets, h.demoted, h.demotedReason)}`];
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
        if (scored) lines.push(`  ${fmtScore(scored.score, scored.margins, scored.pilotContested, scored.flarmidContested, scored.xcFacets, scored.demoted, scored.demotedReason)}`);
        return lines;
    });
}

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
    priorAircraft: PriorAircraftMap = new Map(),
    excludeStart = false,
    assignmentMethodMap: Map<string, string> = new Map()
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
        // Suppress baseline when the assignment came from ognddb — that method already
        // contributes via ddbCn=1.5, so baseline=1.0 would double-count the same source.
        // For external assignments (robocontrol, soaringspotscrape, sgp, startmatch),
        // baseline is independent evidence and is kept.
        const baselineMatch = m.assigned && assignmentMethodMap.get(scoreKey(m.compno, m.flarmid)) !== 'ognddb';
        const sig = signalsFromMatch(m, earliestPilotStartUtc, link, priorNats, xc, excludeStart, baselineMatch);
        const breakdown = scoreSignals(sig);
        breakdownByKey.set(scoreKey(m.compno, m.flarmid), breakdown);
        xcFacetsByKey.set(scoreKey(m.compno, m.flarmid), xc.facets);
        // Consistent with baselineMatch above: ognddb assignments don't count as
        // baseline holders in the contention penalty (same DDB source as ddbCn,
        // so they shouldn't block better-evidenced replacements from competing).
        pairs.push({compno: m.compno, flarmid: m.flarmid, total: breakdown.total, baseline: m.assigned && assignmentMethodMap.get(scoreKey(m.compno, m.flarmid)) !== 'ognddb'});
    }

    // Contention guards: once a flarmid is confidently held by one glider
    // (flarm side), or a pilot confidently holds one flarmid (pilot side),
    // negate every weaker competing claim so a poor match can't displace a
    // likely-good one. Both sets are computed from the same pre-penalty
    // totals, then each pair is negated once. Apply BEFORE margins/peer
    // arrays so the negated totals flow through to the two-sided margins.
    const {penalised, reason: demotedReasonByKey} = applyContentionPenalties(
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
            demoted: penalised.has(scoreKey(m.compno, m.flarmid)),
            demotedReason: demotedReasonByKey.get(scoreKey(m.compno, m.flarmid))
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

function signalsFromMatch(m: TrackerMatch, earliestPilotStartUtc: number, link: DdbLink, priorNats: number, xc: XcEvidence, excludeStart = false, baselineMatch = m.assigned): Signals {
    const d = m.diag;
    // Grandprix common-start: the start crossing is identical for every pilot,
    // so drop it (and its distance) to null — scoreSignals then contributes 0
    // for both, leaving the finish crossing to do the discriminating.
    // Note: gapAroundStartSec and distAtStartKm are also nulled so the
    // negStart signal (confirmed-positional-absence) does not fire either —
    // there's no useful per-pilot start-line evidence in this mode.
    return {
        deltaStart: excludeStart ? null : m.deltaStart,
        deltaFinish: m.deltaFinish,
        distAtStartKm: excludeStart ? null : (d?.distAtStartKm ?? null),
        gapAroundStartSec: excludeStart ? null : (d?.gapAroundStartSec ?? null),
        distAtFinishKm: d?.distAtFinishKm ?? null,
        gapAroundFinishSec: d?.gapAroundFinishSec ?? null,
        inBboxPackets: d?.inBboxPackets ?? 0,
        bboxRejectedPackets: d?.bboxRejectedPackets ?? 0,
        firstSeenT: d?.firstSeenT ?? null,
        earliestPilotStartUtc,
        ddbCnMatch: link.cn,
        ddbGliderMatch: link.glider,
        baselineMatch,
        priorNats,
        xcNats: xc.nats,
        ambiguous: m.ambiguous
    };
}

function printMatches(
    results: OfficialResult[],
    matches: TrackerMatch[],
    tolerance: number,
    scoreMap: ScoreMap,
    crossClass?: CrossClassMap,
    thisClass?: ClassName,
    sameFlightMap?: Map<Compno, PathSimilarityResult>,
    pathPriorMap?: PathPriorMap
): void {
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
        printPilotMatches(compno, byPilot.get(compno)!, results, tolerance, scoreMap, crossClass, thisClass, byFlarmid, sameFlightMap, pathPriorMap);
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
    byFlarmid?: Map<FlarmID, TrackerMatch[]>,
    sameFlightMap?: Map<Compno, PathSimilarityResult>,
    pathPriorMap?: PathPriorMap
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
        if (scored) console.log(`         · ${fmtScore(scored.score, scored.margins, scored.pilotContested, scored.flarmidContested, scored.xcFacets, scored.demoted, scored.demotedReason)}`);
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
    const simResult = sameFlightMap?.get(compno);
    if (simResult) {
        const decision = resolveSameFlight(simResult, pathPriorMap?.get(pathPriorKey(compno, simResult.flarmidA, simResult.flarmidB)));
        for (const line of formatPathSimilarity(simResult, decision)) console.log(line);
    }
}

const DEMOTED_TEXT: Record<'flarm' | 'pilot' | 'both', string> = {
    flarm: 'flarmid confidently held elsewhere',
    pilot: 'pilot confidently holds another flarmid',
    both: 'flarmid confidently held elsewhere AND pilot confidently holds another flarmid'
};

function fmtScore(score: ScoreBreakdown, margins: Margins, pilotContested: boolean, flarmidContested: boolean, xcFacets: string[] = [], demoted = false, demotedReason?: 'flarm' | 'pilot' | 'both'): string {
    const parts: string[] = [];
    parts.push(`S=${score.total.toFixed(2)}${demoted ? ` (demoted: ${DEMOTED_TEXT[demotedReason ?? 'flarm']})` : ''}`);
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
    if (score.negStart < 0) contribs.push(`negS=${score.negStart.toFixed(2)}`);
    if (score.negFinish < 0) contribs.push(`negF=${score.negFinish.toFixed(2)}`);
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

// Propagate the strongest identification decision for a twin pilot to all other
// classes they appear in. If class A's per-class scoring confidently identifies
// flarmid X for pilot P, and class B (same pilot, same comp day) has no such
// proposal, add a matching proposal to class B using class B's own scan data
// for crossing deltas (so the trackerhistory prior is anchored correctly).
// Conflicts (different flarmids proposed in two classes) are logged and left
// for the operator — we don't guess which is right.
function syncTwinPilotProposals(proposalsByClass: Map<ClassName, Proposal[]>, twinPilotGroups: TwinPilotGroup[]): void {
    for (const tpg of twinPilotGroups) {
        // Find the highest-scoring "add" proposal across all classes.
        let bestFlarmid: FlarmID | null = null;
        let bestScore = -Infinity;
        let bestClassLabel = '';
        for (const {cm} of tpg.entries) {
            const proposals = proposalsByClass.get(cm.job.className) ?? [];
            const pilotProposal = proposals.find((p) => p.compno === tpg.compno && p.addedIds.length > 0);
            if (!pilotProposal) continue;
            const flarmid = pilotProposal.addedIds[0] as FlarmID;
            const total = cm.scoreMap.get(scoreKey(tpg.compno, flarmid))?.score.total ?? 0;
            if (total > bestScore) {
                bestScore = total;
                bestFlarmid = flarmid;
                bestClassLabel = cm.job.classDisplay || String(cm.job.className);
            }
        }
        if (!bestFlarmid) continue;

        for (const {cm, result} of tpg.entries) {
            const proposals = proposalsByClass.get(cm.job.className) ?? [];
            // Already has an add-proposal for this flarmid — nothing to add.
            if (proposals.some((p) => p.compno === tpg.compno && p.addedIds.includes(bestFlarmid!))) continue;
            // Conflict: a different flarmid was proposed in this class — warn
            // and skip rather than overwrite, so the operator can review.
            const conflicting = proposals.find((p) => p.compno === tpg.compno && p.addedIds.length > 0);
            if (conflicting) {
                console.log(
                    `  ⚠ twin-pilot conflict: ${String(tpg.compno).trim()} (${tpg.name}) — class ${cm.job.classDisplay || String(cm.job.className)} proposes ${conflicting.addedIds[0]} but twin class ${bestClassLabel} proposes ${bestFlarmid}`
                );
                continue;
            }
            // Already in current trackerid — nothing to do.
            const currentIds = parseCurrentIds(result.trackerid);
            if (currentIds.includes(bestFlarmid!)) continue;
            // Use this class's own match data for the crossing deltas so the
            // trackerhistory prior row is anchored to this class's task times.
            const ownMatch = cm.matches.find((m) => m.compno === tpg.compno && m.flarmid === bestFlarmid);
            const newIds = [...currentIds.filter((id) => id !== bestFlarmid), bestFlarmid!];
            const newTrackerid = newIds.join(',') || 'unknown';
            proposals.push({
                compno: tpg.compno,
                name: tpg.name,
                currentTrackerid: result.trackerid,
                newTrackerid,
                addedIds: [bestFlarmid!],
                removedIds: [],
                reason: `twin-pilot: identified as ${bestFlarmid} in class ${bestClassLabel}`,
                deltaStart: ownMatch?.deltaStart ?? null,
                deltaFinish: ownMatch?.deltaFinish ?? null
            });
            proposalsByClass.set(cm.job.className, proposals);
        }
    }
}

// Propagate displacement proposals to twin classes. If pilot P loses flarmid F
// in Class A, any other class where P currently holds F must also drop it —
// the physical tracker belongs to someone else in all contexts.
function syncDisplacementProposals(proposalsByClass: Map<ClassName, Proposal[]>, twinPilotGroups: TwinPilotGroup[]): void {
    for (const tpg of twinPilotGroups) {
        // Collect all flarmids being displaced for this pilot across any class.
        const displacedInClass = new Map<FlarmID, string>(); // flarmid → originating class label
        for (const {cm} of tpg.entries) {
            const proposals = proposalsByClass.get(cm.job.className) ?? [];
            const label = cm.job.classDisplay || String(cm.job.className);
            for (const p of proposals) {
                if (p.compno !== tpg.compno) continue;
                for (const id of p.displacedIds ?? []) {
                    if (!displacedInClass.has(id)) displacedInClass.set(id, label);
                }
            }
        }
        if (displacedInClass.size === 0) continue;

        // Propagate to every other class where this pilot still holds the flarmid.
        for (const {cm, result} of tpg.entries) {
            const proposals = proposalsByClass.get(cm.job.className) ?? [];
            const currentIds = parseCurrentIds(result.trackerid);
            const toDisplace = [...displacedInClass.keys()].filter((id) => currentIds.includes(id));
            if (toDisplace.length === 0) continue;
            // Skip classes that already have a displacement proposal covering all these IDs.
            const alreadyDisplaced = proposals.find((p) => p.compno === tpg.compno)?.displacedIds ?? [];
            const stillNeeded = toDisplace.filter((id) => !alreadyDisplaced.includes(id));
            if (stillNeeded.length === 0) continue;

            const reasonSuffix = stillNeeded.map((id) => `${id} displaced in class ${displacedInClass.get(id)}`).join(', ');
            const existing = proposals.find((p) => p.compno === tpg.compno);
            if (existing) {
                for (const id of stillNeeded) {
                    if (!existing.removedIds.includes(id)) {
                        existing.removedIds.push(id);
                        const stripped = parseCurrentIds(existing.newTrackerid).filter((t) => t !== id);
                        existing.newTrackerid = stripped.length ? stripped.join(',') : 'unknown';
                    }
                    if (!existing.displacedIds) existing.displacedIds = [];
                    existing.displacedIds.push(id);
                }
                existing.reason += `; ${reasonSuffix}`;
            } else {
                const keptIds = currentIds.filter((id) => !stillNeeded.includes(id as FlarmID));
                proposals.push({
                    compno: tpg.compno,
                    name: tpg.name,
                    currentTrackerid: result.trackerid,
                    newTrackerid: keptIds.length ? keptIds.join(',') : 'unknown',
                    addedIds: [],
                    removedIds: [...stillNeeded],
                    displacedIds: [...stillNeeded],
                    reason: reasonSuffix,
                    deltaStart: null,
                    deltaFinish: null
                });
                proposalsByClass.set(cm.job.className, proposals);
            }
        }
    }
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
               SET trackerid = ${p.newTrackerid}, feedid = 'findtracker'
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
        // Displacement records: a separate trackerhistory row for each flarmid
        // actively taken by another pilot so future runs know this association
        // was explicitly broken. Deltas are null — the prior contribution is 0,
        // so this is an audit record only, not positive scoring evidence.
        for (const flarmid of p.displacedIds ?? []) {
            t.query(escape`
                INSERT INTO trackerhistory
                    (compno, changed, flarmid, method, class, datecode,
                     delta_start, delta_finish)
                VALUES
                    (${p.compno}, now(), ${String(flarmid)}, 'displaced', ${className}, ${String(datecode)},
                     NULL, NULL)
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
async function writeEvidence(className: ClassName, datecode: Datecode, scoreMap: ScoreMap, applied: Proposal[], diagMap: Map<string, TrackerDiag | undefined> = new Map()): Promise<number> {
    // Covers every flarmid an apply just wrote a startmatch row for — so a
    // multi-add proposal doesn't get a duplicate evidence row for the same
    // pair on the same day.
    const appliedKeys = new Set<string>();
    for (const p of applied) {
        for (const id of p.addedIds) appliedKeys.add(`${String(p.compno)}|${String(id)}`);
    }
    const writes: {
        compno: Compno;
        flarmid: FlarmID;
        deltaStart: number | null;
        deltaFinish: number | null;
        distAtStart: number | null;
        gapAroundStart: number | null;
        distAtFinish: number | null;
        gapAroundFinish: number | null;
    }[] = [];
    for (const [key, v] of scoreMap) {
        if (v.score.total < DEFAULT_LEDGER_MIN_NATS) continue;
        if (appliedKeys.has(key)) continue;
        const [compno, flarmid] = key.split('|') as [Compno, FlarmID];
        const diag = diagMap.get(key);
        writes.push({
            compno,
            flarmid,
            deltaStart: v.deltaStart,
            deltaFinish: v.deltaFinish,
            distAtStart: diag?.distAtStartKm ?? null,
            gapAroundStart: diag?.gapAroundStartSec ?? null,
            distAtFinish: diag?.distAtFinishKm ?? null,
            gapAroundFinish: diag?.gapAroundFinishSec ?? null
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
                 delta_start, delta_finish,
                 dist_at_start, gap_around_start, dist_at_finish, gap_around_finish)
            VALUES
                (${w.compno}, now(), ${w.flarmid}, 'evidence', ${className}, ${String(datecode)},
                 ${w.deltaStart}, ${w.deltaFinish},
                 ${w.distAtStart}, ${w.gapAroundStart}, ${w.distAtFinish}, ${w.gapAroundFinish})
        `);
    }
    await t.commit();
    if (writes.length) console.log(`  Wrote ${writes.length} evidence row${writes.length === 1 ? '' : 's'}.`);
    return writes.length;
}

// ---- Path similarity: DB persistence (decision/display logic lives in
// lib/scoring/shared/pathSimilarity.ts; proposal joins in proposals.ts) ----

// Latched after the first "table doesn't exist" error on trackerhistory_paths.
let pathEvidenceUnavailable = false;

async function loadPriorPathSimilarity(currentDatecode: Datecode, className: ClassName): Promise<PathPriorMap> {
    if (pathEvidenceUnavailable) return new Map();
    type Row = {compno: Compno; flarmid_a: string; flarmid_b: string; kind: string};
    let rows: Row[] = [];
    try {
        rows = await mysql.query<Row[]>(escape`
            SELECT compno, flarmid_a, flarmid_b, kind
            FROM trackerhistory_paths
            WHERE class = ${className}
              AND datecode <> ${String(currentDatecode)}
        `);
    } catch (e: any) {
        if (isMissingTable(e)) {
            pathEvidenceUnavailable = true;
            console.warn(`  (trackerhistory_paths table missing — apply conf/sql/migrations/20260620_trackerhistory_paths.sql to enable path-similarity history)`);
            return new Map();
        }
        throw e;
    }
    const out: PathPriorMap = new Map();
    for (const r of rows) {
        const key = pathPriorKey(r.compno as Compno, r.flarmid_a as FlarmID, r.flarmid_b as FlarmID);
        const entry = out.get(key) ?? {sameFlightDays: 0, differentFlightDays: 0};
        if (r.kind === 'same_flight') entry.sameFlightDays++;
        else if (r.kind === 'different_flight') entry.differentFlightDays++;
        out.set(key, entry);
    }
    return out;
}

async function writePathSimilarityEvidence(
    className: ClassName,
    datecode: Datecode,
    sameFlightMap: Map<Compno, PathSimilarityResult>
): Promise<void> {
    if (pathEvidenceUnavailable || !sameFlightMap.size) return;
    const t = mysql.transaction();
    let written = 0;
    for (const [compno, sim] of sameFlightMap) {
        const [fa, fb] = [String(sim.flarmidA), String(sim.flarmidB)].sort();
        const report = sim.fullReport ?? sim.quickReport;
        try {
            t.query(escape`
                INSERT INTO trackerhistory_paths
                    (compno, class, datecode, flarmid_a, flarmid_b,
                     kind, classification, p95_pos_km, alt_bias_m, lag_sec, overlap_sec, aborted_after_quick, changed)
                VALUES
                    (${String(compno)}, ${className}, ${String(datecode)}, ${fa}, ${fb},
                     ${sim.kind}, ${report?.classification.kind ?? null},
                     ${report?.deltaPosP95Km ?? null}, ${report?.altBiasM ?? null},
                     ${report?.lag.lag ?? null}, ${report?.overlapSec ?? null},
                     ${sim.abortedAfterQuick ? 1 : 0}, NOW())
                ON DUPLICATE KEY UPDATE
                    kind = VALUES(kind), classification = VALUES(classification),
                    p95_pos_km = VALUES(p95_pos_km), alt_bias_m = VALUES(alt_bias_m),
                    lag_sec = VALUES(lag_sec), overlap_sec = VALUES(overlap_sec),
                    aborted_after_quick = VALUES(aborted_after_quick), changed = NOW()
            `);
            written++;
        } catch (e: any) {
            if (isMissingTable(e)) {
                pathEvidenceUnavailable = true;
                console.warn(`  (trackerhistory_paths missing mid-run — path evidence not written)`);
                return;
            }
            throw e;
        }
    }
    await t.commit();
    if (written) console.log(`  Wrote ${written} path-similarity row${written === 1 ? '' : 's'}.`);
}
