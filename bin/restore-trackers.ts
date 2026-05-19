#!/usr/bin/env node

// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// restore-trackers — interactive helper to undo erroneous SoaringSpot
// trackerid clobbers.
//
// When `bin/soaringspot.ts` updateTrackers() runs without a classid it
// matches `tracker` on compno alone, so a SoaringSpot sync overwrites that
// compno's trackerid in *every* competition that shares the compno — even
// non-SoaringSpot ones. Each such overwrite leaves a `method = 'soaringspot'`
// row in trackerhistory.
//
// This script walks every compno touched by a soaringspot trackerhistory row
// and, per (class, compno), offers to restore the trackerid to the most
// recent confirmed match recorded before that soaringspot change. A
// restore is only offered when:
//   - a confirmed prior match exists for that (class, compno);
//   - the current tracker.trackerid differs from that match (i.e. the
//     soaringspot sync actually changed it); and
//   - the class's competition has no `soaringspotkey` scoring source — a
//     SoaringSpot-fed competition would just re-apply its own value.
//
// On restore the trackerid is set back and feedid is cleared to NULL.
//

import escape from 'sql-template-strings';
import * as readline from 'node:readline/promises';

const mysql = require('serverless-mysql');
const dotenv = require('dotenv');

// trackerhistory.method values that represent a confirmed FLARM<->pilot match.
const CONFIRMED_MATCH_METHODS = ['startmatch', 'startmatch-swap', 'evidence', 'ognddb', 'pilot'];

let mysql_db;

interface Candidate {
    compno: string;
    classid: string;
    classname: string;
    compid: string;
    currentTrackerId: string | null;
    currentFeedId: string | null;
    restoreTo: string;
    matchMethod: string;
    matchChanged: string;
    ssChanged: string;
}

async function main() {
    if (dotenv.config({path: '.env.local'}).error) {
        console.log('No .env.local found — run this from the repo root');
        process.exit(1);
    }

    mysql_db = mysql({
        config: {
            host: process.env.MYSQL_HOST || 'db',
            database: process.env.MYSQL_DATABASE || 'ogn',
            user: process.env.MYSQL_USER || 'ogn',
            password: process.env.MYSQL_PASSWORD,
            decimalNumbers: true
        }
    });

    // Every compno touched by a soaringspot trackerhistory row, with the most
    // recent such change as the cutoff for "previous" matches.
    const ssRows = await mysql_db.query(escape`
        SELECT compno, MAX(changed) AS cutoff
        FROM trackerhistory
        WHERE method = 'soaringspot'
        GROUP BY compno
    `);

    if (!ssRows.length) {
        console.log('No soaringspot trackerhistory rows found — nothing to restore.');
        await mysql_db.end();
        process.exit(0);
    }

    const candidates: Candidate[] = [];

    for (const ss of ssRows) {
        // The soaringspot row often carries no class, so consider every
        // competition's tracker row for this compno and let the soaringspotkey
        // guard below exclude the ones that legitimately belong to SoaringSpot.
        const trackers = await mysql_db.query(escape`
            SELECT t.class, t.compno, t.trackerid, t.feedid, cl.compid, cl.classname
            FROM tracker t
            JOIN classes cl ON cl.class = t.class
            WHERE t.compno = ${ss.compno}
        `);

        for (const tr of trackers) {
            // A SoaringSpot-fed competition would just re-clobber any restore.
            const [{n}] = await mysql_db.query(escape`
                SELECT COUNT(*) AS n
                FROM scoringsource
                WHERE compid = ${tr.compid} AND type = 'soaringspotkey'
            `);
            if (n > 0) continue;

            // Most recent confirmed match for this (class, compno) recorded
            // before the soaringspot change.
            const [match] = await mysql_db.query(escape`
                SELECT flarmid, method, changed
                FROM trackerhistory
                WHERE compno = ${ss.compno}
                  AND class = ${tr.class}
                  AND method IN (${CONFIRMED_MATCH_METHODS})
                  AND flarmid IS NOT NULL
                  AND flarmid <> ''
                  AND changed < ${ss.cutoff}
                ORDER BY changed DESC
                LIMIT 1
            `);
            if (!match) continue;

            // Confirm the soaringspot sync actually changed this tracker —
            // if it already holds the match value there is nothing to restore.
            if ((tr.trackerid ?? '').trim() === (match.flarmid ?? '').trim()) continue;

            candidates.push({
                compno: tr.compno,
                classid: tr.class,
                classname: tr.classname,
                compid: tr.compid,
                currentTrackerId: tr.trackerid,
                currentFeedId: tr.feedid,
                restoreTo: match.flarmid,
                matchMethod: match.method,
                matchChanged: '' + match.changed,
                ssChanged: '' + ss.cutoff
            });
        }
    }

    if (!candidates.length) {
        console.log(`Found ${ssRows.length} soaringspot-touched compno(s), but none have a restorable confirmed match.`);
        await mysql_db.end();
        process.exit(0);
    }

    console.log(`\n${candidates.length} restore candidate(s):\n`);

    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    let restored = 0;
    let quit = false;

    for (let i = 0; i < candidates.length && !quit; i++) {
        const c = candidates[i];
        console.log(`[${i + 1}/${candidates.length}] ${c.compno} in class ${c.classname} (${c.classid}) — competition ${c.compid}`);
        console.log(`    current trackerid : ${c.currentTrackerId ?? 'NULL'}   (feedid: ${c.currentFeedId ?? 'NULL'})`);
        console.log(`    soaringspot change: ${c.ssChanged}`);
        console.log(`    restore to        : ${c.restoreTo}   (from '${c.matchMethod}' match at ${c.matchChanged})`);

        const answer = (await rl.question('    Restore? [y]es / [n]o / [q]uit: ')).trim().toLowerCase();

        if (answer === 'q' || answer === 'quit') {
            quit = true;
        } else if (answer === 'y' || answer === 'yes') {
            const res = await mysql_db.query(escape`
                UPDATE tracker
                SET trackerid = ${c.restoreTo}, feedid = NULL
                WHERE class = ${c.classid} AND compno = ${c.compno}
            `);
            if (res.affectedRows) {
                console.log('    -> restored\n');
                restored++;
            } else {
                console.log('    -> no row changed (tracker may have moved since this scan)\n');
            }
        } else {
            console.log('    -> skipped\n');
        }
    }

    rl.close();
    console.log(`Done. ${restored} tracker(s) restored.`);
    await mysql_db.end();
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
