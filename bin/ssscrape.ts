#!/usr/bin/env node

// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

//
// ssscrape — entry binary for the scoring scraper. The scheduling and
// fetching code now lives in lib/scoring/* (scheduler + per-source
// adapters); this file's job is:
//
//   1. Boot: load .env.local, open the mysql pool, register adapters.
//   2. Daemon mode (no flags): scheduler heartbeat + roboControl loop.
//   3. CLI one-shot mode: `node dist/bin/ssscrape.js --url <u> [--compid <c>]`
//      — upsert the scoringsource row, run the SoaringSpotScrape adapter
//      end-to-end (metadata + pilots + tasks + results), and exit.
//   4. CLI filter mode: `--compid <c> --class <classid-or-name> --datecode <dc>`
//      — narrow scrape: skips scoringsource upsert / ensureMetadata /
//      fetchPilots, and only re-imports the task + results for that
//      single (class, datecode). URL is looked up from scoringsource
//      unless --url is also supplied. Bypasses the today-only safety
//      check so past datecodes work.
//
// All of the parsing/upsert logic that used to live here is now in
// lib/scoring/sources/soaringspotscrape.ts (parsing) and the shared
// helpers under lib/scoring/shared/* (DB writes, FAI gating, image
// cache, class diff, old-day prune, dead-comp cleanup). To add another
// source (e.g. RST, SoaringSpot OAuth API), drop a new adapter into
// lib/scoring/sources/ and registry.register() it below.
//

import escape from 'sql-template-strings';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {runScheduler, SourceRegistry, dumpSchedulerState} from '../lib/scoring/scheduler';
import {SoaringSpotScrapeSource} from '../lib/scoring/sources/soaringspotscrape';
import {SgpSource} from '../lib/scoring/sources/sgp';
import {SgpaeroSource} from '../lib/scoring/sources/sgpaero';
import {SoaringSpotApiSource} from '../lib/scoring/sources/soaringspot';
import {RobocontrolSource} from '../lib/scoring/sources/robocontrol';
import {RstSource} from '../lib/scoring/sources/rst';
import type {ScoringSource, SourceCtx} from '../lib/scoring/source';
import {regeocodeMissingCompetitions} from '../lib/scoring/shared/contestLocation';

const mysql = require('serverless-mysql');
const dotenv = require('dotenv');

let mysql_db: any;

//
// Derive a URL-safe compid from a SoaringSpot URL. Takes the final
// meaningful path segment and sanitises it to lowercase [a-z0-9-],
// truncated to 40 chars.
//   https://www.soaringspot.com/en_gb/lasham-regionals-2026/results
//      → 'lasham-regionals-2026'
//
function deriveCompIdFromUrl(urlString: string): string | null {
    try {
        const u = new URL(urlString);
        const segments = u.pathname.split('/').filter(Boolean);
        const generic = new Set(['results', 'pilots', 'tasks', 'contestants', 'daily']);
        while (segments.length && generic.has(segments[segments.length - 1])) {
            segments.pop();
        }
        const candidate = segments[segments.length - 1];
        if (!candidate) return null;
        const slug = candidate
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 40);
        return slug || null;
    } catch {
        return null;
    }
}

//
// Both CLI one-shot paths (filter/scrape and refetch) build a SourceCtx and
// then mirror the same competition fields onto it. Keep the skeleton and the
// tz/countrycode/cylinderstarts query in one place each so they can't drift.
//
function makeSourceCtx(db: any, compid: string, url: string, raw: Record<string, any>): SourceCtx {
    return {
        compid,
        url,
        tz: 'Europe/London', // overridden by applyCompFields / ensureMetadata
        countrycode: null,
        cylinderstarts: false,
        db,
        log: (msg, ...a) => console.log(`[${compid}] ${msg}`, ...a),
        raw
    };
}

async function readCompFields(db: any, compid: string): Promise<{tz: string | null; countrycode: string | null; cylinderstarts: boolean}> {
    const row = (await db.query(escape`SELECT tz, countrycode, cylinderstarts FROM competition WHERE compid = ${compid}`))?.[0];
    return {tz: row?.tz ?? null, countrycode: row?.countrycode ?? null, cylinderstarts: row?.cylinderstarts == 'Y'};
}

function applyCompFields(ctx: SourceCtx, f: {tz: string | null; countrycode: string | null; cylinderstarts: boolean}): void {
    if (f.tz) ctx.tz = f.tz; // keep the ctx default when the row has no tz yet
    ctx.countrycode = f.countrycode ?? ctx.countrycode;
    ctx.cylinderstarts = f.cylinderstarts;
}

async function main(): Promise<void> {
    if (dotenv.config({path: '.env.local'}).error) {
        console.log('New install: no configuration found, or script not being run in the root directory');
        process.exit();
    }

    mysql_db = mysql({
        config: {
            host: process.env.MYSQL_HOST || 'db',
            database: process.env.MYSQL_DATABASE || 'ogn',
            user: process.env.MYSQL_USER || 'ogn',
            password: process.env.MYSQL_PASSWORD,
            decimalNumbers: true,
            // Disable CLIENT_FOUND_ROWS so UPDATE.affectedRows counts
            // rows actually changed, not rows matched. Callers across
            // this codebase rely on that semantics (see
            // lib/scoring/shared/trackers.ts:updateTracker).
            flags: ['-FOUND_ROWS']
        }
    });

    const registry = new SourceRegistry();
    registry.register(new SoaringSpotScrapeSource());
    registry.register(new SgpSource());
    registry.register(new SgpaeroSource());
    registry.register(new SoaringSpotApiSource());
    registry.register(new RobocontrolSource());
    registry.register(new RstSource());

    const args = yargs(hideBin(process.argv))
        .scriptName('ssscrape')
        .usage('$0 (daemon)\n$0 --url <u> [--compid <c>]                            # full one-shot scrape (soaringspotscrape)\n$0 --compid <c> --class <c> --datecode <d> [--url <u>]   # filter mode: task+results only\n$0 --refetch <compid>                                    # one-shot end-to-end refetch using the configured source type')
        .option('url', {type: 'string', describe: 'soaringspot competition URL'})
        .option('compid', {type: 'string', describe: 'competition id (derived from url if omitted)'})
        .option('class', {type: 'string', describe: 'filter mode: classid or display name'})
        .option('datecode', {type: 'string', describe: 'filter mode: 3-char datecode (e.g. 6A5)', coerce: (v?: string) => v?.toUpperCase()})
        .option('refetch', {type: 'string', requiresArg: true, describe: 'compid to refetch using whatever source type is configured for it (value required)'})
        .check((a) => {
            const filterMode = !!(a.class || a.datecode);
            if (filterMode && (!a.class || !a.datecode)) throw new Error('--class and --datecode must be supplied together');
            if (a.datecode && !/^[0-9][0-9A-Z][0-9A-Z]$/.test(a.datecode)) throw new Error(`--datecode=${a.datecode} doesn't look like a datecode (3 chars: digit + base36 month + base36 day)`);
            if (filterMode && !a.compid && !a.url) throw new Error('filter mode needs --compid (or --url to derive one)');
            if (a.refetch && (a.url || a.class || a.datecode)) throw new Error('--refetch cannot be combined with --url/--class/--datecode');
            return true;
        })
        .strict()
        .help()
        .parseSync();

    if (args.refetch) {
        await runOneShotRefetch(args.refetch, registry, mysql_db);
        setTimeout(() => process.exit(0), 5000);
        return;
    }

    const filterMode = !!(args.class && args.datecode);
    if (args.url || filterMode) {
        let url = args.url;
        let compid = args.compid || (url ? deriveCompIdFromUrl(url) : null);
        if (!compid) {
            console.log('unable to derive a compid — pass --compid explicitly');
            process.exit(1);
        }

        if (filterMode && !url) {
            const row = (
                await mysql_db.query(escape`
                    SELECT url FROM scoringsource
                    WHERE compid = ${compid} AND type = 'soaringspotscrape'
                    LIMIT 1
                `)
            )[0];
            if (!row?.url) {
                console.log(`no scoringsource row found for compid=${compid} — pass --url explicitly`);
                process.exit(1);
            }
            url = row.url;
        }

        console.log(`one-shot scrape: compid=${compid} url=${url}${filterMode ? ` filter=class:${args.class} datecode:${args.datecode}` : ''}`);

        if (!filterMode) {
            await mysql_db.query(escape`
                DELETE FROM scoringsource
                WHERE compid = ${compid} AND type = 'soaringspotscrape'
            `);
            await mysql_db.query(escape`
                INSERT INTO scoringsource (compid, type, url)
                VALUES (${compid}, 'soaringspotscrape', ${url})
            `);
        }

        try {
            const adapter = new SoaringSpotScrapeSource();
            // tz / countrycode / cylinderstarts are filled below from the
            // competition row (filter mode) or by ensureMetadata (else branch).
            const ctx = makeSourceCtx(mysql_db, compid, url!, {compid, url, type: 'soaringspotscrape'});

            if (filterMode) {
                // Skip ensureMetadata — the contest row already exists and
                // hitting /pilots+/results+/ on SoaringSpot adds latency
                // we don't need here. Pull tz / countrycode / cylinderstarts
                // straight from the DB.
                applyCompFields(ctx, await readCompFields(mysql_db, compid));

                // Resolve the class arg — either a 15-hex classid or the
                // display name from `classes.classname`.
                const classRow = (
                    await mysql_db.query(escape`
                        SELECT class FROM classes
                        WHERE compid = ${compid}
                          AND (class = ${args.class} OR classname = ${args.class})
                        LIMIT 1
                    `)
                )[0];
                if (!classRow) {
                    console.log(`no class matching "${args.class}" found for compid=${compid}`);
                    process.exit(1);
                }
                const targetClass = classRow.class;
                const targetDatecode = args.datecode!;
                console.log(`filter resolved: class=${targetClass} datecode=${targetDatecode}`);
                const filterSkipDay = (classid: string, dateCode: string) => classid !== targetClass || dateCode !== targetDatecode;
                await adapter.fetchResultsAndTasks(ctx, filterSkipDay, {forceResults: true});
            } else {
                await adapter.ensureMetadata(ctx);
                applyCompFields(ctx, await readCompFields(mysql_db, compid));
                await adapter.fetchPilots(ctx);
                await adapter.fetchResultsAndTasks(ctx, () => false);
            }
            console.log(`scrape complete for compid=${compid}`);
        } catch (e) {
            console.log('scrape failed:', e);
            process.exit(1);
        }
        // Give any fire-and-forget fetches (pilot photos etc.) a moment
        // to land before exiting.
        setTimeout(() => process.exit(0), 5000);
        return;
    }

    // Daemon mode: scheduler heartbeat drives everything — robocontrol
    // is registered as a tracker-only ScoringSource above and runs on
    // the same per-competition cadence as the other adapters.
    console.log('Background scoring scraper enabled');

    // SIGUSR1 — on-demand scheduler state dump for troubleshooting.
    //   kill -USR1 <pid>
    // prints the per-comp / per-source next-due timestamps, observations,
    // and sticky flags to the daemon log so "why isn't X firing" can be
    // answered without restarting.
    process.on('SIGUSR1', () => {
        try {
            dumpSchedulerState(console.log);
        } catch (e) {
            console.log('dumpSchedulerState threw:', e);
        }
    });

    // One-shot sweep at boot: any competition rows whose lt/lg are still
    // NULL/0 get re-geocoded from `sitename`. Fire-and-forget so we don't
    // block the scheduler from starting; failures inside log per-row.
    regeocodeMissingCompetitions(mysql_db, (msg, ...args) => console.log(msg, ...args)).catch((e) => console.log('regeocodeMissingCompetitions failed:', e));

    runScheduler({
        db: mysql_db,
        registry
    }).catch((e) => console.log('runScheduler failed:', e));
}

//
// runOneShotRefetch — `--refetch <compid>` end-to-end pass. Picks the
// adapter from whatever scoringsource row exists for the compid:
// when both a 'soaringspotkey' and 'soaringspotscrape' row exist, the
// API wins (matches the scheduler's OVERRIDE_SOURCE_TYPE behaviour).
// Runs ensureMetadata → fetchPilots → fetchResultsAndTasks once, with
// `forceResults` so a manual refetch can also reimport an off-cycle day.
//
async function runOneShotRefetch(compid: string, registry: SourceRegistry, db: any): Promise<void> {
    const rows = (await db.query(escape`
        SELECT * FROM scoringsource WHERE compid = ${compid}
    `)) as any[];
    if (!rows?.length) {
        console.log(`no scoringsource rows for compid=${compid}`);
        process.exit(1);
    }

    // Prefer the OAuth API row when present — same precedence the
    // scheduler enforces via OVERRIDE_SOURCE_TYPE.
    const order = ['soaringspotkey', 'soaringspotscrape', 'sgp', 'sgpaero'];
    const sorted = [...rows].sort((a, b) => {
        const ai = order.indexOf(a.type);
        const bi = order.indexOf(b.type);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const src = sorted.find((r) => !!registry.get(r.type));
    if (!src) {
        console.log(`no registered adapter for any of: ${sorted.map((r) => r.type).join(', ')}`);
        process.exit(1);
    }

    const adapter: ScoringSource = registry.get(src.type)!;
    const ctx = makeSourceCtx(db, compid, src.url ?? '', src);

    // ensureMetadata creates/refreshes the competition row (and its tz /
    // countrycode); read the fields onto ctx afterwards. No adapter's
    // ensureMetadata reads these ctx fields, so there's no need to pre-read.
    console.log(`one-shot refetch: compid=${compid} type=${src.type}`);
    try {
        await adapter.ensureMetadata(ctx);
        applyCompFields(ctx, await readCompFields(db, compid));
        await adapter.fetchPilots(ctx);
        await adapter.fetchResultsAndTasks(ctx, () => false, {forceResults: true});
        console.log(`refetch complete for compid=${compid}`);
    } catch (e) {
        console.log('refetch failed:', e);
        process.exit(1);
    }
}

main().then(() => {
    console.log('main returned');
});
