// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// SoaringSpotScrapeSource — `ScoringSource` adapter for the SoaringSpot
// public website (HTML scraping, no API key required). All the parsing
// code that used to live in bin/ssscrape.ts now lives here. Adapter
// concerns:
//   - HTTP fetch via global fetch()
//   - HTML/DOM parsing via htmlparser2/domutils
//   - SoaringSpot-specific table extraction via tabletojson
// Everything else (DB upserts, pruning, FAI gating, image cache, class
// diff) goes through the shared helpers in lib/scoring/shared/* so the
// RST adapter can reuse the exact same writes.
//

import * as htmlparser from 'htmlparser2';
import {Tabletojson} from 'tabletojson';
import {findOne, findAll, textContent, getAttributeValue, getOuterHTML} from 'domutils';
import {Element} from 'domhandler';
import escape from 'sql-template-strings';

import {makeClassId, normalizeClassName} from '../../classid';
import {toDateCode} from '../../datecode';
import {getElevationOffset} from '../../getelevationoffset';
import {processIGC, checkForOGNMatches} from '../../flightprocessing/launchlanding';

import type {ClassId, CompNo, DiscoverCtx, DiscoveredCompetition, FetchPilotsResult, FetchResultsOptions, FetchResultsResult, ScoringSource, SkipDayPredicate, SourceCtx} from '../source';
import {findTimezoneFromLocation, getTzOffset, localDatecode} from '../shared/timezone';
import {findApproximateContestLocation} from '../shared/contestLocation';
import {PilotFetchAccumulator, upsertPilot, pruneUnseenPilots, correctClassHandicaps, type PilotRecord} from '../shared/pilots';
import {enqueueFaiLookup} from '../shared/fai';
import {FAI_SYNTHETIC_FLOOR} from '../shared/faiApi';
import {upsertClass, syncClassHandicapFlag} from '../shared/classes';
import {upsertTaskAndLegs} from '../shared/tasks';
import {fetchSoaringSpot} from '../shared/soaringspotRateLimit';

const https = require('node:https');

function toElement(x: any): Element | null {
    return x?.nodeType == 1 ? (x as Element) : null;
}

//
// deriveSoaringspotCompId — turn a SoaringSpot URL into a URL-safe
// compid slug for use as the primary key in `competition` /
// `scoringsource`. Shared with bin/ssscrape.ts's CLI one-shot mode and
// with the daily discovery hook below.
//
//   https://www.soaringspot.com/en_gb/fcc2026/           → 'fcc2026'
//   https://www.soaringspot.com/en_gb/lasham-2026/pilots → 'lasham-2026'
//
export function deriveSoaringspotCompId(urlString: string): string | null {
    try {
        const u = new URL(urlString);
        const segments = u.pathname.split('/').filter(Boolean);
        const generic = new Set(['results', 'pilots', 'tasks', 'contestants', 'daily', 'en_gb', 'en', 'cs', 'de', 'fr', 'sl']);
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

// Tidy up free-text strings extracted from SoaringSpot HTML — collapse
// internal whitespace, trim, and strip trailing punctuation.
function cleanText(s: string): string {
    return (s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[\s,;.]+$/, '');
}

//
// updateContest — competition row + first-pass geocoding + tz
// refinement. Lifted from bin/ssscrape.ts:1457. Idempotent.
//
async function updateContest(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    compid: string,
    contestName: string,
    dates: string,
    siteName: string,
    url: string
): Promise<void> {
    const count = await db.query(escape`SELECT COUNT(*) cnt FROM competition WHERE compid = ${compid}`);
    if (!count || !count[0] || !count[0].cnt) {
        log(`Empty competition for compid=${compid}, pre-populating`);
        // Seed start/end with a sentinel date well in the past. The
        // UPDATE below replaces both with the parsed values as soon as
        // we actually scrape real dates. If the scrape never succeeds
        // — URL 404, broken page shape, etc. — the past `end` lets
        // dropDeadCompetition reap the row on its next hourly sweep,
        // so a dead scoringsource row doesn't keep hammering the URL.
        await db.query(escape`
            INSERT IGNORE INTO competition (compid, tz, tzoffset, mainwebsite, start, end)
            VALUES
                (
                    ${compid},
                    "Europe/London",
                    3600,
                    ${url},
                    DATE_SUB(CURDATE(), INTERVAL 30 DAY),
                    DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                )
        `);
    }

    const matches = dates.match(/([0-9A-Z ,]+) – ([0-9A-Z ,]+)/i);
    if (matches) {
        await db.query(escape`
            UPDATE competition
            SET
                start = from_unixtime (${Date.parse(matches[1] + ' UTC') / 1000}),
                END = from_unixtime (${Date.parse(matches[2] + ' UTC') / 1000}),
                name = ${contestName.substring(0, 40)}
            WHERE compid = ${compid}
        `);
    }

    // Grand-prix detection from the competition name. Catches "Grand
    // Prix", "GrandPrix" and "SGP" (case-insensitive, word-bounded so
    // "SGPS" or similar substrings don't false-match). One-way flip,
    // same as the per-day regatta-start detector — `grandprixstart <>
    // 'Y'` makes the UPDATE a no-op once any class has been promoted.
    // On a brand-new comp this UPDATE matches zero rows because classes
    // are upserted later in fetchResultsAndTasks; the next fetchPilots
    // call (which re-invokes updateContest) catches them.
    if (/\bgrand\s*prix\b|\bsgp\b/i.test(contestName)) {
        const r = await db.query(escape`
            UPDATE classes
            SET
                grandprixstart = 'Y'
            WHERE
                compid = ${compid}
                AND grandprixstart <> 'Y'
        `);
        if (r?.affectedRows) {
            log(`competition name "${contestName}" matched grand-prix pattern; set grandprixstart=Y on ${r.affectedRows} class(es)`);
        }
    }

    let location: any = (
        await db.query(escape`
            SELECT
                lt,
                lg
            FROM
                competition
            WHERE compid = ${compid}
        `)
    )[0];

    if ((!location || !location.lt) && siteName) {
        log(`geocoding site "${siteName}" for compid=${compid}`);
        const acl = await findApproximateContestLocation(log, siteName);
        if (acl.lt && acl.lg) {
            await db.query(escape`
                UPDATE competition
                SET
                    tz = ${acl.timezone.name},
                    tzoffset = ${acl.timezone.offset},
                    countrycode = ${acl.countrycode || null},
                    lt = ${acl.lt},
                    lg = ${acl.lg},
                    sitename = ${siteName.substring(0, 40)}
                WHERE compid = ${compid}
            `);
            location = {lt: acl.lt, lg: acl.lg};
        }
    }

    if (location?.lt && location?.lg) {
        try {
            const tz = findTimezoneFromLocation(location.lt, location.lg);
            const tzoffset = getTzOffset(tz);
            await db.query(escape`
                UPDATE competition
                SET tz = ${tz}, tzoffset = ${tzoffset}
                WHERE compid = ${compid}
                  AND (tz IS NULL OR tz != ${tz})
            `);
        } catch (e) {
            log('tz refinement failed:', e);
        }
    }

    if (location?.lt) {
        getElevationOffset(location.lt, location.lg, (agl: number) => {
            log(`SITE Altitude:${agl}`);
        });
    }
}

//
// processDayResults — parse the daily results table and update
// pilotresult rows. Lifted from the old process_day_results(). Kept in
// this adapter because the column names ('CN', 'Speed', 'Distance', …)
// and the embedded IGC-href regex are SoaringSpot-specific.
//
async function processDayResults(
    ctx: SourceCtx, //
    classid: ClassId,
    className: string,
    date: string,
    results: any
): Promise<void> {
    const {db, log, countrycode} = ctx;
    let rows = 0;
    // let doCheckForOGNMatches = false; // disabled — IGC download check is gated off below
    const dateCode = toDateCode(date);

    // Grand-prix detection: in a regatta-start (Sailplane Grand Prix)
    // class every starter shares one start time, whereas a normal racing
    // class has starts spread across many seconds/minutes. We tally
    // distinct non-empty start strings during this row loop and, if the
    // whole field collapsed to a single value, set classes.grandprixstart
    // = 'Y' once at the end. One-way flip — a single odd day shouldn't
    // unset a confirmed GP class, so no auto-revert.
    const distinctStarts = new Set<string>();
    let startersWithTime = 0;

    if (!results || !results[0]) {
        log(`${className}: ${date} - no results`);
        return;
    }

    const igcRe = /a href=&quot;.(en_gb.download-contest-flight.+=1)&quot;/i;
    // Extract the visible CN text via the DOM rather than a naive
    // <[^>]*> strip. The cell's anchor carries a data-content="..."
    // popover whose value contains literal '<' and '>' (the inner IGC
    // link, with only quotes entity-encoded), which broke the regex
    // approach — '<[^>]*>' would consume the opening <a …> plus part of
    // the data-content value and never recover the "EBO"/"BN"/… text.
    const cnRe = /^([A-Z0-9]+)/i;
    const extractCN = (cellHtml: string): string => textContent(htmlparser.parseDocument(cellHtml)).trim();
    const flagRe = /class="flag.*title="([a-z]+)"/i;

    const convertHandicap = correctClassHandicaps(
        (results[0] as any[]).map((r) => r.Handicap),
        countrycode,
        (msg, ...args) => log(`${className}: ${msg}`, ...args)
    );

    for (const row of results[0]) {
        const pilotExtractor = extractCN(row.CN).match(cnRe);
        if (!pilotExtractor) {
            log(`${date} ${className} ${row.CN} - no CN found!`);
            continue;
        }

        const urlExtractor = row.CN.match(igcRe);
        const pilot = pilotExtractor[1];
        const url = urlExtractor && urlExtractor[1] ? 'https://www.soaringspot.com/' + urlExtractor[1] : undefined;

        const flagExtractor = row.Contestant.match(flagRe);
        if (flagExtractor) {
            const flag = flagExtractor[1].toUpperCase();
            // Pull the current FAI/country before we update so we can
            // detect the "we now know the country" transition that
            // unlocks a previously-ambiguous FAI lookup.
            const before = await db.query(escape`
                SELECT firstname, country, fai
                FROM pilots
                WHERE compno = ${pilot}
                  AND class = ${classid}
            `);
            await db.query(escape`
                UPDATE pilots
                SET
                    country = ${flag}
                WHERE
                    compno = ${pilot}
                    AND class = ${classid}
            `);
            // If the first-pass FAI search couldn't disambiguate (we
            // stored a synthetic id) and the flag we just learned is
            // new information, re-run the lookup — country usually
            // narrows the ranking-list candidates down to a unique
            // match.
            const row0 = before?.[0];
            if (row0 && row0.fai >= FAI_SYNTHETIC_FLOOR && row0.country !== flag && row0.firstname) {
                enqueueFaiLookup({
                    db,
                    log,
                    fullName: row0.firstname,
                    country: flag,
                    classid,
                    className,
                    compno: pilot as CompNo
                });
            }
        }

        function cDate(d: string | undefined): Date | undefined {
            if (d == undefined) return undefined;
            const x = new Date();
            const p = d.match(/([0-9]{2}):([0-9]{2}):([0-9]{2})/);
            if (!p) return undefined;
            x.setHours(parseInt(p[1]));
            x.setMinutes(parseInt(p[2]));
            x.setSeconds(parseInt(p[3]));
            return x;
        }

        function cHour(d: string | undefined): number | undefined {
            if (d == undefined) return undefined;
            const p = d.match(/^([0-9]{0,2}):*([0-9]{2}):([0-9]{2})/);
            if (!p) return undefined;
            return parseInt(p[1]) + parseInt(p[2]) / 60 + parseInt(p[3]) / 3600;
        }

        const rStart = row.Start?.trim() || null;
        const rFinish = row.Finish != '' ? row.Finish : null;

        if (rStart) {
            distinctStarts.add(rStart);
            startersWithTime++;
        }
        const start = row.Start ? (cDate(row.Start)?.getTime() ?? 0) / 1000 : 0;
        const finish = row.Time != '' ? (cDate(row.Finish)?.getTime() ?? 0) / 1000 : 0;
        const duration = finish && start ? (cHour(row.Time) ?? 0) : 0;

        const actuals = parseFloat(row.Speed);
        const actuald = parseFloat(row.Distance);
        const handicap = convertHandicap(row.Handicap);

        const scoredvals = {
            as: duration ? actuald / duration : 0,
            ad: actuald,
            hs: duration ? actuald / (handicap / 100) / duration : 0,
            hd: actuald / (handicap / 100)
        };

        const finished = actuals > 0;
        const scoredStatus = finished ? 'F' : actuald > 0 ? 'H' : 'S';

        if ((row['#'] != 'DNF' && row['#'] != 'DNS') || finished) {
            const r = await db.query(escape`
                UPDATE pilotresult
                SET
                    start = TIME(
                        COALESCE(${rStart}, start)
                    ),
                    finish = TIME(
                        COALESCE(${rFinish}, finish)
                    ),
                    duration = COALESCE(
                        TIMEDIFF (
                            ${rFinish},
                            ${rStart}
                        ),
                        duration
                    ),
                    statuschanged = (
                        CASE
                            WHEN (scoredstatus = ${scoredStatus}) THEN statuschanged
                            ELSE NOW()
                        END
                    ),
                    datafromscoring = "Y",
                    scoredstatus = ${scoredStatus},
                    speed = ${scoredvals.as},
                    distance = ${scoredvals.ad},
                    hspeed = ${scoredvals.hs},
                    hdistance = ${scoredvals.hd}
                WHERE
                    datecode = ${dateCode}
                    AND compno = ${pilot}
                    AND class = ${classid}
            `);
            rows += r.affectedRows ?? 0;

            const pilotInfo = (
                await db.query(escape`
                        SELECT
                            igcavailable,
                            trackerid
                        FROM
                            pilotresult pr
                            LEFT JOIN tracker ON tracker.compno = pr.compno
                            AND tracker.class = pr.class
                        WHERE
                            datecode = ${dateCode}
                            AND pr.compno = ${pilot}
                            AND pr.class = ${classid}
                    `)
            )[0] || {igcavailable: false, trackerid: 'unknown'};

            // IGC download checking disabled — leaving the pilotInfo
            // select above in place so re-enabling is a one-block flip.
            // if ((pilotInfo.igcavailable || 'Y') == 'N' && url && (pilotInfo.trackerid ?? 'unknown') == 'unknown') {
            //     // processIGC's signature is over-strict (branded
            //     // ClassName/Compno + a populated location). The legacy
            //     // call site passed in raw strings and a possibly-null
            //     // location and worked because the file was untyped — we
            //     // mirror that behaviour with a single any-cast rather
            //     // than pretend to know the real types here.
            //     await (processIGC as any)(classid, pilot, undefined, date, url, https, db, () => undefined);
            //     doCheckForOGNMatches = true;
            // }
        }
    }

    // if (doCheckForOGNMatches) {
    //     checkForOGNMatches(classid, date, db);
    // }

    if (rows) {
        await db.query(escape`
            UPDATE contestday
            SET
                results_uploaded = NOW()
            WHERE
                class = ${classid}
                AND datecode = ${dateCode}
                AND STATUS != "Z"
        `);
    }

    if (startersWithTime >= 2 && distinctStarts.size === 1) {
        const r = await db.query(escape`
            UPDATE classes
            SET
                grandprixstart = 'Y'
            WHERE
                class = ${classid}
                AND grandprixstart <> 'Y'
        `);
        if (r?.affectedRows) {
            const startTime = distinctStarts.values().next().value;
            log(`${className}: regatta start detected (${startersWithTime} pilots @ ${startTime}); set grandprixstart=Y`);
        }
    }
}

//
// SoaringSpotScrapeSource — implementation of `ScoringSource` for the
// SoaringSpot HTML scraper. Each method does *only* the HTTP+parse work;
// every DB write goes through a shared helper.
//
export class SoaringSpotScrapeSource implements ScoringSource {
    readonly type = 'soaringspotscrape';

    async ensureMetadata(ctx: SourceCtx): Promise<void> {
        // Try each tab in turn — every SoaringSpot contest page (pilots,
        // results, root) carries the same contest-title header, so any
        // one of them is enough to learn name/site/dates. /pilots is the
        // historical first choice; the fallbacks cover the observed case
        // where SoaringSpot's /pilots returns 200 but a body that lacks
        // the header (no public root cause yet — the body-length log
        // below is here to capture evidence next time it happens).
        //
        // updateContest ALWAYS runs at the end, even on full failure.
        // With empty inputs the date regex misses and the UPDATE is
        // skipped — but the INSERT IGNORE still plants a placeholder
        // row so dropDeadCompetition can reap URLs that never scrape.
        let name = '';
        let site = '';
        let dates = '';
        const candidates = ['/pilots', '/results', ''];
        for (const suffix of candidates) {
            const target = ctx.url + suffix;
            try {
                console.log(target);
                const res = await fetchSoaringSpot(target);
                if (!res.ok) {
                    ctx.log(`ensureMetadata: ${target} returned ${res.status}`);
                    continue;
                }
                const body = await res.text();
                const dom = htmlparser.parseDocument(body);
                const contestInfo = findOne((x) => x.name == 'div' && x.attribs?.class == 'contest-title', dom?.children ?? []);
                if (!contestInfo) {
                    ctx.log(`ensureMetadata: no contest-title div at ${target} (body=${body.length}B)${body.length < 2000 ? ` snippet=${JSON.stringify(body.slice(0, 200))}` : ''}`);
                    continue;
                }
                const children = contestInfo.children ?? [];
                name = cleanText(textContent(findOne((x) => x.name == 'h1', children) ?? []));
                site = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'location', children) ?? []));
                dates = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'date', children) ?? []));
                if (suffix !== '/pilots') {
                    ctx.log(`ensureMetadata: extracted header from fallback ${target}`);
                }
                break;
            } catch (e) {
                ctx.log(`ensureMetadata fetch failed for ${target}:`, e);
            }
        }
        try {
            await updateContest(ctx.db, ctx.log, ctx.compid, name, dates, site, ctx.url);
        } catch (e) {
            ctx.log(`updateContest failed for ${ctx.compid}:`, e);
        }
    }

    async fetchPilots(ctx: SourceCtx): Promise<FetchPilotsResult> {
        const accumulator = new PilotFetchAccumulator();
        const synthetic = {n: 0};

        try {
            console.log(ctx.url + '/pilots');
            const body = await fetchSoaringSpot(ctx.url + '/pilots').then((res) => res.text());
            const dom = htmlparser.parseDocument(body);

            // Refresh competition metadata while we have the page in hand.
            const contestInfo = findOne((x) => x.name == 'div' && x.attribs?.class == 'contest-title', dom?.children ?? []);
            if (contestInfo) {
                const children = contestInfo.children ?? [];
                const name = cleanText(textContent(findOne((x) => x.name == 'h1', children) ?? []));
                const site = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'location', children) ?? []));
                const dates = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'date', children) ?? []));
                await updateContest(ctx.db, ctx.log, ctx.compid, name, dates, site, ctx.url);
            }

            const pilotsTable = findOne((x) => x.attribs?.class == 'pilot footable toggle-arrow-tiny', dom.children);
            if (!pilotsTable) {
                ctx.log(`fetchPilots: no pilots table found at ${ctx.url}/pilots`);
                return {observed: accumulator.observed};
            }

            const parsed = Tabletojson.convert(getOuterHTML(pilotsTable));
            const pilotsList: any[] = parsed[0] ?? [];
            ctx.log(`fetchPilots: ${pilotsList.length} pilot row(s) for ${ctx.compid}`);

            // Pre-scan to bucket raw handicaps by class so we can build a
            // per-class converter — Polish comps need H = fsm/fs across
            // the class, so we need every raw handicap in the class
            // before normalising any single pilot.
            const handicapsByClass = new Map<ClassId, any[]>();
            for (const raw of pilotsList) {
                if (!raw.CN || raw.CN == '') {
                    continue;
                }
                const nc = normalizeClassName(raw.Class);
                if (!nc) {
                    continue;
                }
                const cid = makeClassId(ctx.compid, nc) as ClassId;
                if (!handicapsByClass.has(cid)) {
                    handicapsByClass.set(cid, []);
                }
                handicapsByClass.get(cid)!.push(raw.Handicap);
            }
            const convertersByClass = new Map<ClassId, (raw: any) => number>();
            for (const [cid, handicaps] of handicapsByClass) {
                convertersByClass.set(
                    cid,
                    correctClassHandicaps(handicaps, ctx.countrycode, (msg, ...args) => ctx.log(`${cid}: ${msg}`, ...args))
                );
            }

            for (const raw of pilotsList) {
                if (!raw.CN || raw.CN == '') {
                    continue;
                }
                const compno = raw.CN as CompNo;
                const normalizedClass = normalizeClassName(raw.Class);
                if (!normalizedClass) {
                    ctx.log(`skipping pilot ${compno}: no class label`, raw);
                    continue;
                }
                const classid = makeClassId(ctx.compid, normalizedClass) as ClassId;
                const handicap = convertersByClass.get(classid)!(raw.Handicap);
                const className = normalizedClass.replace(/[_]/gi, ' ');

                const pilot: PilotRecord = {
                    classid,
                    className,
                    compno,
                    fullName: raw.Contestant,
                    club: raw.Club ?? null,
                    country: null,
                    glider: raw.Glider ?? null,
                    greg: null,
                    handicap
                };

                await upsertPilot(ctx.db, ctx.log, pilot, accumulator, synthetic);
            }

            await pruneUnseenPilots(ctx.db, ctx.log, accumulator);

            for (const classid of accumulator.observed.keys()) {
                await syncClassHandicapFlag(ctx.db, ctx.log, classid);
            }
        } catch (e) {
            ctx.log(`fetchPilots failed for ${ctx.compid}:`, e);
        }

        return {observed: accumulator.observed};
    }

    async fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate, options?: FetchResultsOptions): Promise<FetchResultsResult> {
        const tasksOnly = options?.tasksOnly === true;
        const forceResults = options?.forceResults === true;
        const acceptYesterday = options?.acceptYesterday === true;
        const observedClasses = new Set<ClassId>();
        const extractTask = /taskNormalize\((\{.+\}), \[.*\)/;
        // Datecode "today in the competition's local tz" — we always
        // compute per-day state in competition-local time so competitions
        // that straddle UTC midnight don't tag briefings under yesterday's
        // datecode.
        const todayDatecode = localDatecode(ctx.tz);
        // Yesterday's local datecode — only consulted when the scheduler
        // sets acceptYesterday (first results fetch of the new local
        // day) so late-settling results from yesterday land before the
        // front-end's visible datecode rolls over.
        const yesterdayDatecode = acceptYesterday ? localDatecode(ctx.tz, Date.now() - 24 * 60 * 60 * 1000) : null;

        try {
            console.log(ctx.url + '/results');
            const body = await fetchSoaringSpot(ctx.url + '/results').then((res) => res.text());
            const dom = htmlparser.parseDocument(body);

            const allresults = findAll((x) => x.name == 'table' && x.attribs?.class == 'result-overview', dom.children);

            // Suspiciously short body or empty table set usually means
            // SoaringSpot rate-limited or returned an error stub
            // (typical real /results body is tens of KB). Surface the
            // first 200 chars so the cause is diagnosable from the log.
            if (allresults.length === 0 && body.length < 2000) {
                ctx.log(`fetchResultsAndTasks: no result-overview tables (body=${body.length}B) snippet=${JSON.stringify(body.slice(0, 200))}`);
            }

            for (const result of allresults) {
                const nameRaw = textContent(findOne((x) => x.name == 'th', result.children) ?? []).trim();
                const normalizedName = normalizeClassName(nameRaw);
                const classid = makeClassId(ctx.compid, normalizedName) as ClassId;
                observedClasses.add(classid);

                const className = normalizedName.replace(/[_]/gi, ' ');

                await upsertClass(ctx.db, ctx.log, ctx.compid, classid, className, todayDatecode);

                const dates = findAll((x) => x.name == 'tr' && x.parent?.nodeType == 1 && (x.parent as any)?.name == 'tbody', result.children);
                ctx.log(`DEBUG ${classid}: found ${dates.length} date row(s) in result-overview`);

                for (const day of dates) {
                    const cells = findAll((x) => x.name == 'td', day.children);
                    const cell0 = cells[0] ? textContent(cells[0])?.trim() : '<no-cell0>';
                    const cell1 = cells[1] ? textContent(cells[1])?.trim() : '<no-cell1>';
                    ctx.log(`DEBUG ${classid}: row cells=${cells?.length ?? 0} cell0="${cell0}" cell1="${cell1}"`);
                    if (!cells?.length || cells.length < 2) {
                        ctx.log('no dates yet');
                        continue;
                    }

                    const daynumber = textContent(cells[1])?.trim() ?? '';
                    // Find the task anchor anywhere inside cells[1] — the
                    // old `cells[1].children[1]` index-lookup was fragile
                    // when SoaringSpot changed wrapping whitespace.
                    const taskAnchor = findOne((x) => x.name == 'a', cells[1].children ?? []);
                    if (!taskAnchor) {
                        ctx.log(`DEBUG ${classid}: no task anchor in cell1 — skipping row`);
                        // "No task" / "—" / any row with no task link at
                        // all. Skip; there's nothing to scrape or cancel.
                        continue;
                    }

                    const dateGB = textContent(cells[0])?.match(/([0-9]{2})\/([0-9]{2})\/([0-9]{4})/);
                    if (!dateGB) {
                        ctx.log(`DEBUG ${classid}: cell0 did not match dd/mm/yyyy: "${cell0}"`);
                        continue;
                    }

                    const date = dateGB[3] + '-' + dateGB[2] + '-' + dateGB[1];
                    const dateCode = toDateCode(date);

                    if (skipDay(classid, dateCode, date)) {
                        ctx.log(`skipping old day ${date} for class ${classid}`);
                        continue;
                    }

                    // Hard gate before any per-day fetch: only today (or
                    // yesterday when the scheduler set acceptYesterday)
                    // is worth touching. Past days won't have their
                    // results written (the results-page guard below
                    // refuses them anyway), and re-installing their
                    // tasks just burns SoaringSpot bandwidth and churns
                    // the tasks.hash row on every tick. forceResults
                    // (CLI one-shot) still bypasses the gate.
                    const isToday = dateCode === todayDatecode;
                    const isYesterdayWindow = yesterdayDatecode != null && dateCode === yesterdayDatecode;
                    if (!forceResults && !isToday && !isYesterdayWindow) {
                        ctx.log(`${classid}: ${date}/${dateCode} - skipDay returned false but not today/yesterday (today=${todayDatecode}${yesterdayDatecode ? `, yesterday=${yesterdayDatecode}` : ''}) - skipping`);
                        continue;
                    }

                    // Task fetch. A cancelled day is flagged two ways on
                    // the overview row: either the cell text mentions
                    // "cancelled" (e.g. "Task 1 cancelled"), or the task
                    // <td> carries class="cancelled" while its text is
                    // still a plain "Task N". Trust either signal,
                    // regardless of whatever result_status the task JSON
                    // ships — some sources show cancelled on the overview
                    // row but still serve a normal task JSON.
                    const cancelled = /cancell?ed|scrubbed/i.test(daynumber) || /cancell?ed|scrubbed/i.test(getAttributeValue(cells[1] as any, 'class') ?? '');
                    const taskUrlAttr = getAttributeValue(taskAnchor as any, 'href');
                    if (taskUrlAttr) {
                        try {
                            console.log('https://www.soaringspot.com' + taskUrlAttr);
                            const taskBody = await fetchSoaringSpot('https://www.soaringspot.com' + taskUrlAttr).then((res) => res.text());
                            const task = taskBody.match(extractTask);
                            if (task) {
                                const taskJSON = JSON.parse(task[1]);
                                if (cancelled) taskJSON.result_status = 'cancelled';
                                // Pull the "Task notes" <p> out of the page
                                // body. taskNormalize(...) doesn't carry it,
                                // but downstream (upsertTaskAndLegs) needs
                                // it to spot tags like "distance handicapped",
                                // "grand prix", "regatta", "e-glide" that
                                // drive tasks.type.
                                const taskDom = htmlparser.parseDocument(taskBody);
                                const notesH3 = findOne((x) => x.name === 'h3' && /task notes/i.test(textContent(x) ?? ''), taskDom.children);
                                if (notesH3) {
                                    let sib: any = (notesH3 as any).next;
                                    while (sib && sib.name !== 'p') sib = sib.next;
                                    const notesText = sib ? textContent(sib).trim() : '';
                                    if (notesText) {
                                        taskJSON.notes = taskJSON.notes ? `${taskJSON.notes}\n${notesText}` : notesText;
                                    }
                                }
                                await upsertTaskAndLegs(ctx.db, ctx.log, classid, className, taskJSON);
                            }
                        } catch (e) {
                            ctx.log(`task fetch failed for ${classid} ${date}:`, e);
                        }
                    }

                    // A cancelled task has no daily results, so don't even
                    // try to chase the (usually-missing) results link.
                    if (cancelled) continue;

                    // Results fetch — skipped on a tasks-only tick: no
                    // class has a task today on this cadence, so there
                    // are no results to chase anyway, and we want to
                    // keep upstream load light while we wait for a
                    // briefing to publish.
                    const resultsAnchor = !tasksOnly && cells[3] ? findOne((x) => x.name == 'a', cells[3].children ?? []) : null;
                    const resultUrlAttr = resultsAnchor ? getAttributeValue(resultsAnchor as any, 'href') : null;
                    if (resultUrlAttr) {
                        try {
                            console.log('https://www.soaringspot.com' + resultUrlAttr);
                            const resBody = await fetchSoaringSpot('https://www.soaringspot.com' + resultUrlAttr).then((res) => res.text());
                            const resDom = htmlparser.parseDocument(resBody);
                            const classTable = /result-daily/;
                            const resultTableNode = findOne((x) => (x.attribs?.class?.match(classTable) ? true : false), resDom.children);
                            if (resultTableNode) {
                                const fragment = getOuterHTML(resultTableNode);
                                const resultsHtml = Tabletojson.convert(fragment, {stripHtmlFromCells: false});
                                await processDayResults(ctx, classid, className, date, resultsHtml);
                            }
                        } catch (e) {
                            ctx.log(`results fetch failed for ${classid} ${date}:`, e);
                        }
                    }
                }
            }
        } catch (e) {
            ctx.log(`fetchResultsAndTasks failed for ${ctx.compid}:`, e);
        }

        return {observedClasses};
    }

    //
    // discoverCompetitions — pull the SoaringSpot public index and return
    // every competition currently listed under "Competitions in progress"
    // or "Upcoming competitions". The scheduler diffs these against the
    // existing `scoringsource` rows and inserts any newcomers so the
    // normal heartbeat will start tracking them on the next tick.
    //
    // We deliberately skip the "Recent competitions" section — those have
    // already ended and would only add dead comps the dead-comp cleanup
    // would immediately reap.
    //
    async discoverCompetitions(ctx: DiscoverCtx): Promise<DiscoveredCompetition[]> {
        const INDEX_URL = 'https://www.soaringspot.com/en_gb/';
        const discovered: DiscoveredCompetition[] = [];
        const seen = new Set<string>();

        try {
            console.log(INDEX_URL);
            const body = await fetchSoaringSpot(INDEX_URL).then((res) => res.text());
            const dom = htmlparser.parseDocument(body);

            // One <div class="contest-list"> per section; each contains an
            // <h2> heading + <ul><li><h3><a href="/en_gb/<slug>/">…</a>.
            const contestLists = findAll(
                (x) => x.name == 'div' && x.attribs?.class == 'contest-list', //
                dom.children
            );
            const wantedHeading = /(in progress|upcoming)/i;

            for (const list of contestLists) {
                const h2 = findOne((x) => x.name == 'h2', list.children ?? []);
                const heading = h2 ? textContent(h2).trim() : '';
                if (!wantedHeading.test(heading)) continue;

                const anchors = findAll(
                    (x) => x.name == 'a' && (x.parent as any)?.name == 'h3', //
                    list.children ?? []
                );

                for (const a of anchors) {
                    const href = getAttributeValue(a as any, 'href');
                    if (!href || !href.startsWith('/en_gb/')) continue;
                    // Strip any trailing slash so compid derivation sees
                    // a clean final path segment.
                    const fullUrl = ('https://www.soaringspot.com' + href).replace(/\/$/, '');
                    const compid = deriveSoaringspotCompId(fullUrl);
                    if (!compid || seen.has(compid)) continue;
                    seen.add(compid);
                    discovered.push({compid, url: fullUrl});
                }
            }
            ctx.log(`discoverCompetitions[soaringspotscrape]: found ${discovered.length} competition(s) across in-progress + upcoming`);
        } catch (e) {
            ctx.log(`discoverCompetitions[soaringspotscrape] failed:`, e);
        }

        return discovered;
    }
}
