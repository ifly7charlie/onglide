//
// trackshape — CLI wrapper around lib/flightprocessing/trackshape.
//
// For each pilot in a class (or all classes of a competition) on a given
// datecode, compare the two trackers registered against `tracker.trackerid`
// (CSV of flarm IDs) by replaying their point logs and reporting how their
// position / altitude / time line up — matching, consistent offset (the
// expected case under competition.delayseconds anti-cheat delay), or
// diverged (one tracker is on a different flight, or stopped reporting
// mid-day and a different unit took over).
//

import type {ClassName, Compno, Datecode, FlarmID} from '../lib/types';
import {fromDateCode, competitionStartForDatecode} from '../lib/datecode';
import {compareShapes, loadStream, fmtUtcHms, type ShapeReport} from '../lib/flightprocessing/trackshape';

import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

dotenv.config({path: '.env.local'});

const argv = yargs(hideBin(process.argv))
    .scriptName('trackshape')
    .usage('$0 (--compid <id> | --classid <id>) --datecode <dc> [--compno <NNNN>] [--lag <sec>] [--lag-search <sec>]')
    .option('compid', {type: 'string', describe: 'competition id (scope all classes)'})
    .option('classid', {type: 'string', describe: 'class id (15-char hash; scope a single class)'})
    .option('datecode', {type: 'string', demandOption: true, describe: 'contest datecode (required)'})
    .option('compno', {type: 'string', describe: 'limit to a single pilot within scope'})
    .option('lag', {type: 'number', describe: 'override auto-detected lag (seconds); B is delayed by this much relative to A'})
    .option('lag-search', {type: 'number', describe: 'override lag-search half-width (seconds; default = max(120, 2 × delayseconds))'})
    .check((a) => {
        if (!a.compid && !a.classid) throw new Error('specify --compid or --classid');
        if (a.compid && a.classid) throw new Error('--compid and --classid are mutually exclusive');
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

const DEFAULT_DELAY_FALLBACK = Number(process.env.NEXT_PUBLIC_COMPETITION_DELAY) || 10;

interface Job {
    compid: string;
    compName: string;
    className: ClassName;
    classDisplay: string;
    delayseconds: number;
    tzoffsetSec: number;
}

interface PilotRow {
    compno: Compno;
    name: string;
    trackerIds: FlarmID[];
}

interface Tally {
    matching: number;
    offset: number;
    divAbrupt: number;
    divSlow: number;
    different: number;
    failed: number;
    insufficient: number;
    skipped: number;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

async function main() {
    const datecode = String(argv.datecode).toUpperCase() as Datecode;
    const baseDateStr = fromDateCode(datecode);

    const jobs = await resolveJobs();
    if (!jobs.length) {
        console.error('No classes matched the requested scope.');
        await mysql.end();
        process.exit(1);
    }

    const grand: Tally = newTally();

    for (const job of jobs) {
        const lagSearchHalfWidth =
            argv['lag-search'] != null
                ? Number(argv['lag-search'])
                : Math.max(120, 2 * (job.delayseconds || DEFAULT_DELAY_FALLBACK));

        // Flying window: 10:00 comp-local on the datecode to 00:00 comp-local
        // the next day (14h). competitionStartForDatecode anchors on midday of
        // the calendar day so the start is robust regardless of when this runs.
        const since = competitionStartForDatecode(datecode, job.tzoffsetSec);
        const until = since + 14 * 3600;

        const pilots = await loadPilotsForClass(job.className, argv.compno as Compno | undefined);
        const classLabel = job.classDisplay ? `${job.classDisplay} [${job.className}]` : job.className;
        const compLabel = job.compName ? `${job.compName} [${job.compid}]` : job.compid;
        console.log(`\n=== ${classLabel} / ${datecode} ${baseDateStr}  (${compLabel}) ===`);
        console.log(
            `    flying window ${fmtUtcHms(since)}-${fmtUtcHms(until)} UTC (10:00-00:00 local, tz ${signed(job.tzoffsetSec / 3600, 1)}h), delayseconds=${job.delayseconds}s, lag-search ±${lagSearchHalfWidth}s${argv.lag != null ? `, --lag ${argv.lag}s forced` : ''}`
        );

        type Row = {pilot: PilotRow; report: ShapeReport | null; reason?: string};
        const rows: Row[] = [];

        for (const pilot of pilots) {
            if (pilot.trackerIds.length < 2) {
                rows.push({pilot, report: null, reason: `skipped: single tracker (${pilot.trackerIds[0] ?? 'none'})`});
                continue;
            }
            const [idA, idB] = pilot.trackerIds;
            const [a, b] = await Promise.all([loadStream(idA, since, until), loadStream(idB, since, until)]);
            const aEmpty = a.points.length === 0;
            const bEmpty = b.points.length === 0;
            if (aEmpty && bEmpty) {
                rows.push({pilot, report: null, reason: `no data for either tracker (${idA}, ${idB})`});
                continue;
            }
            if (aEmpty || bEmpty) {
                const empty = aEmpty ? idA : idB;
                const populated = aEmpty ? idB : idA;
                const populatedPts = aEmpty ? b.points.length : a.points.length;
                rows.push({pilot, report: null, reason: `tracker ${empty} has no points in window (other tracker ${populated} has ${populatedPts})`});
                continue;
            }
            const report = compareShapes(a, b, {
                forcedLag: argv.lag != null ? Number(argv.lag) : undefined,
                lagSearchHalfWidth
            });
            rows.push({pilot, report});
        }

        sortRows(rows);

        const tally = newTally();
        for (const r of rows) {
            if (!r.report) {
                console.log(`  ${r.pilot.compno}  ${r.reason}`);
                tally.skipped++;
                continue;
            }
            printReport(r.pilot, r.report, job.delayseconds);
            bumpTally(tally, r.report.classification.kind);
        }

        printPerClassSummary(rows.length, tally);
        mergeTally(grand, tally);
    }

    if (jobs.length > 1) {
        const totalPilots = grand.matching + grand.offset + grand.divAbrupt + grand.divSlow + grand.different + grand.failed + grand.insufficient + grand.skipped;
        printGrandTotal(totalPilots, grand);
    }

    await mysql.end();
    process.exit(0);
}

function sortRows(rows: {pilot: PilotRow; report: ShapeReport | null}[]) {
    const order: Record<string, number> = {
        very_different: 0,
        alignment_failed: 1,
        diverged_abrupt: 2,
        diverged_slow: 3,
        insufficient_overlap: 4,
        consistent_offset: 5,
        matching: 6
    };
    rows.sort((a, b) => {
        const ka = a.report ? (order[a.report.classification.kind] ?? 99) : 100;
        const kb = b.report ? (order[b.report.classification.kind] ?? 99) : 100;
        if (ka !== kb) return ka - kb;
        return a.pilot.compno < b.pilot.compno ? -1 : 1;
    });
}

function printReport(pilot: PilotRow, report: ShapeReport, delayseconds: number) {
    console.log(`  ${pilot.compno}  ${report.classification.summary}`);
    console.log(`       trackers: ${report.aId} vs ${report.bId}`);
    if (report.classification.kind === 'insufficient_overlap' || report.classification.kind === 'alignment_failed') {
        if (report.lag.failed) {
            console.log(`       lag:      alignment failed (xcorr σ ${report.lag.confidenceSigma.toFixed(2)}, search ±${report.lag.searchHalfWidth}s)`);
        } else if (report.overlapSec >= 0) {
            console.log(`       overlap:  ${report.overlapSec}s (below ${report.sampleCount > 0 ? 'classify' : 'lag'}-threshold)`);
        }
        return;
    }
    const h = Math.floor(report.overlapSec / 3600);
    const m = Math.floor((report.overlapSec % 3600) / 60);
    const sSec = report.overlapSec % 60;
    const span = h > 0 ? `${h}h ${m}m` : `${m}m ${sSec}s`;
    console.log(`       overlap:  ${report.overlapSec}s (${span}), ${report.gapsOver60} gaps >60s, ${report.gapsOver300} gaps >5min`);
    console.log(`       Δposition: p50 ${report.deltaPosP50Km.toFixed(3)} km   p95 ${report.deltaPosP95Km.toFixed(3)} km   max ${report.deltaPosMaxKm.toFixed(3)} km`);
    console.log(
        `       Δaltitude: bias ${signed(report.altBiasM, 0)} m   p95 |dev| ${report.altDevP95M.toFixed(0)} m   max |dev| ${report.altDevMaxM.toFixed(0)} m`
    );
    const cleanTag = report.tResidMaxSec <= 1 ? '(clean — no per-point residual after lag)' : '(non-zero residual — possible mismatch)';
    console.log(`       Δt_resid: max ${report.tResidMaxSec.toFixed(0)}s ${cleanTag}`);
    const sigmaPart = report.lag.forced ? 'manual --lag' : `xcorr σ=${report.lag.confidenceSigma.toFixed(1)}`;
    const featPart =
        report.lag.featureCount > 0 && report.lag.featureMedianResidual != null
            ? `feature pts n=${report.lag.featureCount} residual ${signed(report.lag.featureMedianResidual, 1)}s`
            : 'no feature pts';
    console.log(`       lag:      ${signed(report.lag.lag, 0)}s (expected ~${signed(delayseconds, 0)}s; ${sigmaPart}, ${featPart})`);
    if (report.classification.kind === 'diverged_abrupt' && report.classification.divergenceAtUtc != null) {
        console.log(
            `       divergence: onset ${fmtUtcHms(report.classification.divergenceAtUtc)} UTC  pre ${report.classification.divergencePreKm?.toFixed(2)} km  post ${report.classification.divergencePostKm?.toFixed(2)} km`
        );
    }
}

function signed(n: number, digits: number): string {
    const s = digits > 0 ? n.toFixed(digits) : String(Math.round(n));
    return n >= 0 ? '+' + s : s;
}

function newTally(): Tally {
    return {matching: 0, offset: 0, divAbrupt: 0, divSlow: 0, different: 0, failed: 0, insufficient: 0, skipped: 0};
}

function bumpTally(t: Tally, kind: string) {
    switch (kind) {
        case 'matching':
            t.matching++;
            break;
        case 'consistent_offset':
            t.offset++;
            break;
        case 'diverged_abrupt':
            t.divAbrupt++;
            break;
        case 'diverged_slow':
            t.divSlow++;
            break;
        case 'very_different':
            t.different++;
            break;
        case 'alignment_failed':
            t.failed++;
            break;
        case 'insufficient_overlap':
            t.insufficient++;
            break;
    }
}

function mergeTally(into: Tally, from: Tally) {
    into.matching += from.matching;
    into.offset += from.offset;
    into.divAbrupt += from.divAbrupt;
    into.divSlow += from.divSlow;
    into.different += from.different;
    into.failed += from.failed;
    into.insufficient += from.insufficient;
    into.skipped += from.skipped;
}

function tallyLine(t: Tally, total: number): string {
    const diverged = t.divAbrupt + t.divSlow;
    const different = t.different + t.failed;
    return `${total} pilots, ${t.matching} matching, ${t.offset} offset, ${diverged} diverged, ${different} different, ${t.insufficient} insufficient, ${t.skipped} skipped`;
}

function printPerClassSummary(total: number, t: Tally) {
    console.log(`\n  Summary: ${tallyLine(t, total)}`);
}

function printGrandTotal(total: number, t: Tally) {
    console.log(`\n=== Total: ${tallyLine(t, total)} ===`);
}

interface JobRow {
    class: ClassName;
    classname: string;
    compid: string;
    compname: string;
    delayseconds: number | null;
    tzoffset: number | null;
}

async function resolveJobs(): Promise<Job[]> {
    if (argv.classid) {
        const rows = await mysql.query<JobRow[]>(escape`
            SELECT cl.class AS class,
                   COALESCE(cl.classname, '') AS classname,
                   cl.compid AS compid,
                   COALESCE(c.name, '') AS compname,
                   c.delayseconds AS delayseconds,
                   c.tzoffset AS tzoffset
              FROM classes cl
              JOIN competition c ON c.compid = cl.compid
             WHERE cl.class = ${argv.classid}
             LIMIT 1
        `);
        return rows.map(asJob);
    }
    const rows = await mysql.query<JobRow[]>(escape`
        SELECT cl.class AS class,
               COALESCE(cl.classname, '') AS classname,
               cl.compid AS compid,
               COALESCE(c.name, '') AS compname,
               c.delayseconds AS delayseconds,
               c.tzoffset AS tzoffset
          FROM classes cl
          JOIN competition c ON c.compid = cl.compid
         WHERE cl.compid = ${argv.compid}
         ORDER BY cl.class
    `);
    return rows.map(asJob);
}

function asJob(r: JobRow): Job {
    return {
        compid: r.compid,
        compName: r.compname,
        className: r.class,
        classDisplay: r.classname,
        delayseconds: r.delayseconds != null ? Number(r.delayseconds) : DEFAULT_DELAY_FALLBACK,
        tzoffsetSec: r.tzoffset != null ? Number(r.tzoffset) : 0
    };
}

async function loadPilotsForClass(className: ClassName, restrictCompno?: Compno): Promise<PilotRow[]> {
    const filterCompno = restrictCompno ? escape` AND p.compno = ${restrictCompno}` : escape``;
    const rows = await mysql.query<{compno: Compno; firstname: string; lastname: string; trackerid: string | null}[]>(
        escape`
        SELECT p.compno AS compno,
               COALESCE(p.firstname, '') AS firstname,
               COALESCE(p.lastname, '')  AS lastname,
               COALESCE(t.trackerid, '') AS trackerid
          FROM pilots p
          LEFT JOIN tracker t ON t.class = p.class AND t.compno = p.compno
         WHERE p.class = ${className}
        `
            .append(filterCompno)
            .append(escape` ORDER BY p.compno`)
    );
    return rows.map((r) => ({
        compno: r.compno,
        name: `${r.firstname} ${r.lastname}`.trim() || String(r.compno),
        trackerIds: parseTrackerIds(r.trackerid)
    }));
}

function parseTrackerIds(raw: string | null): FlarmID[] {
    const out: FlarmID[] = [];
    if (!raw) return out;
    for (const part of raw.split(',')) {
        const t = part.trim().toUpperCase();
        if (!t) continue;
        const lc = t.toLowerCase();
        if (lc === 'unknown' || lc === 'blocked') continue;
        out.push(t as FlarmID);
    }
    return out;
}
