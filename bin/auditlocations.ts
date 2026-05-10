//
// Audit competition.lt/lg by re-running the sitename geocode + airfield
// matcher and comparing against what's stored. Read-only by default;
// pass --fix (or --apply) to write the recomputed point back where the
// matcher snaps to a name-matching OSM aerodrome and the move is more
// than --min-move km from what's stored.
//
// Use cases:
//   - Find rows that were geocoded before the airfield-refinement step
//     existed (locked at the town because regeocodeMissingCompetitions
//     only retries NULL/0).
//   - Spot rows where Overpass timed out on the original geocode and
//     the row fell back to the town point.
//   - Sanity-check the matcher across the existing competition set.
//
// Flags:
//   --fix / --apply        write changes back (default: dry run)
//   --min-move <km>        only apply when |new − stored| > km (default 0.5)
//   --compid <id>          restrict to one competition row
//   --only-mismatches      hide rows where computed == stored
//

import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';
import distance from '@turf/distance';
import {point} from '@turf/helpers';

import {findApproximateContestLocation, type ApproximateContestLocation} from '../lib/scoring/shared/contestLocation';

dotenv.config({path: '.env.local'});

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD
    }
});

interface CompetitionRow {
    compid: string;
    sitename: string | null;
    lt: number | null;
    lg: number | null;
    tz: string | null;
    countrycode: string | null;
}

interface Args {
    apply: boolean;
    minMoveKm: number;
    compid: string | null;
    onlyMismatches: boolean;
}

function parseArgs(argv: string[]): Args {
    const out: Args = {apply: false, minMoveKm: 0.5, compid: null, onlyMismatches: false};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--fix' || a === '--apply') out.apply = true;
        else if (a === '--only-mismatches') out.onlyMismatches = true;
        else if (a === '--min-move') out.minMoveKm = parseFloat(argv[++i]);
        else if (a === '--compid') out.compid = argv[++i];
        else if (a === '--help' || a === '-h') {
            console.log('usage: auditlocations [--fix|--apply] [--min-move <km>] [--compid <id>] [--only-mismatches]');
            process.exit(0);
        } else {
            console.error(`unknown arg: ${a}`);
            process.exit(2);
        }
    }
    return out;
}

function fmtCoord(lt: number | null, lg: number | null): string {
    if (lt == null || lg == null) return '          (null)         ';
    return `(${lt.toFixed(2).padStart(6)}, ${lg.toFixed(2).padStart(7)})`;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    // Only audit active or upcoming comps — finished competitions don't
    // need fresh geocoding and we don't want to disturb their stored
    // values. NULL end is kept so partially-scraped placeholder rows
    // don't silently disappear.
    const where = args.compid
        ? escape`WHERE compid = ${args.compid}`
        : escape`WHERE sitename IS NOT NULL AND sitename != '' AND (end IS NULL OR end >= CURDATE())`;
    const rows = await mysql.query<CompetitionRow[]>(
        escape`
        SELECT compid, sitename, lt, lg, tz, countrycode
        FROM competition
        `
            .append(where)
            .append(escape`
        ORDER BY compid
    `)
    );

    if (!rows.length) {
        console.log(args.compid ? `no row for compid=${args.compid}` : 'no competitions with a sitename');
        await mysql.end();
        return;
    }

    console.log(`auditing ${rows.length} competition row(s)${args.apply ? ' [--fix MODE]' : ' [dry run — pass --fix to apply]'}`);
    console.log('');

    let unchanged = 0;
    let withinThreshold = 0;
    let wouldChange = 0;
    let applied = 0;
    let geocodeFailed = 0;

    for (const row of rows) {
        if (!row.sitename) {
            geocodeFailed++;
            continue;
        }

        const log = (_msg: string, ..._args: unknown[]) => {
            // suppress per-row Nominatim/Overpass chatter; surface only
            // the audit summary line below
        };
        let acl: ApproximateContestLocation;
        try {
            acl = await findApproximateContestLocation(log, row.sitename);
        } catch (e) {
            console.log(`${row.compid.padEnd(48)} sitename="${row.sitename}"  geocode threw: ${e instanceof Error ? e.message : e}`);
            geocodeFailed++;
            continue;
        }

        if (!acl.lt || !acl.lg) {
            console.log(`${row.compid.padEnd(48)} sitename="${row.sitename}"  no geocode result`);
            geocodeFailed++;
            continue;
        }

        const storedLt = row.lt ?? 0;
        const storedLg = row.lg ?? 0;
        const moveKm = storedLt && storedLg ? distance(point([storedLg, storedLt]), point([acl.lg, acl.lt])) : Infinity;

        const same = Math.abs(storedLt - acl.lt) < 0.005 && Math.abs(storedLg - acl.lg) < 0.005;
        if (same) {
            unchanged++;
            if (!args.onlyMismatches) {
                console.log(`${row.compid.padEnd(48)} sitename="${row.sitename}"  stored=${fmtCoord(storedLt, storedLg)} computed=${fmtCoord(acl.lt, acl.lg)}  unchanged`);
            }
            continue;
        }

        if (moveKm < args.minMoveKm) {
            withinThreshold++;
            if (!args.onlyMismatches) {
                console.log(`${row.compid.padEnd(48)} sitename="${row.sitename}"  stored=${fmtCoord(storedLt, storedLg)} computed=${fmtCoord(acl.lt, acl.lg)}  Δ=${moveKm.toFixed(2)}km (< ${args.minMoveKm}km, ignored)`);
            }
            continue;
        }

        wouldChange++;
        const tag = args.apply ? 'APPLY' : 'WOULD CHANGE';
        console.log(`${row.compid.padEnd(48)} sitename="${row.sitename}"  stored=${fmtCoord(storedLt, storedLg)} → computed=${fmtCoord(acl.lt, acl.lg)}  Δ=${moveKm.toFixed(2)}km  tz=${acl.timezone.name}  cc=${acl.countrycode || '?'}  [${tag}]`);

        if (args.apply) {
            await mysql.query(escape`
                UPDATE competition
                SET
                    lt = ${acl.lt},
                    lg = ${acl.lg},
                    tz = ${acl.timezone.name},
                    tzoffset = ${acl.timezone.offset},
                    countrycode = ${acl.countrycode || row.countrycode || null}
                WHERE compid = ${row.compid}
            `);
            applied++;
        }
    }

    console.log('');
    console.log(`summary: ${rows.length} row(s) audited`);
    console.log(`  unchanged           : ${unchanged}`);
    console.log(`  within ${args.minMoveKm.toFixed(2)}km threshold: ${withinThreshold}`);
    console.log(`  ${args.apply ? 'applied            ' : 'would change       '}: ${args.apply ? applied : wouldChange}`);
    if (geocodeFailed) console.log(`  geocode failed     : ${geocodeFailed}`);

    await mysql.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
