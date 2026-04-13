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

import type {ClassId, CompNo, FetchPilotsResult, FetchResultsResult, ScoringSource, SkipDayPredicate, SourceCtx} from '../source';
import {findTimezoneFromLocation, getTzOffset} from '../shared/timezone';
import {PilotFetchAccumulator, upsertPilot, pruneUnseenPilots, correctHandicap, type PilotRecord} from '../shared/pilots';
import {upsertClass} from '../shared/classes';
import {upsertTaskAndLegs} from '../shared/tasks';

const https = require('node:https');

function toElement(x: any): Element | null {
    return x?.nodeType == 1 ? (x as Element) : null;
}

// Approximate site location returned by Mapbox geocoding. Used to seed
// competition.lt/lg before any tasks have been scraped (taskleg coords
// later refine the timezone).
interface ApproximateContestLocation {
    lt: number;
    lg: number;
    countrycode: string;
    timezone: {
        name: string;
        offset: number;
    };
}

// Geocode a free-text location string (e.g. "Prievidza, Slovakia") via
// the Mapbox Places API and derive coords + country code + IANA tz.
// Returns a safe fallback on any failure so the scrape can still proceed.
async function findApproximateContestLocation(
    log: (msg: string, ...args: unknown[]) => void, //
    location: string
): Promise<ApproximateContestLocation> {
    const referrer = 'https://' + (process.env.NEXT_PUBLIC_SITEURL || '') + '/';
    const accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

    if (!accessToken) {
        log('NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN not set, skipping geocode');
        return {lt: 0, lg: 0, countrycode: '', timezone: {name: 'Europe/London', offset: 0}};
    }

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json?limit=1&access_token=${accessToken}`;

    return fetch(url, {headers: {Referer: referrer}})
        .then((res) => {
            if (res.status != 200) {
                log(` ${url}: ${res.status}`);
                throw new Error('mapbox error:' + res.status);
            }
            return res.json();
        })
        .then((r: any) => {
            const features = r.features?.[0];
            if (!features || !features.center) {
                throw new Error('no features found');
            }

            const timeZone = findTimezoneFromLocation(features.center[1], features.center[0]);

            return {
                lt: Math.round(features.center[1] * 100 + 50) / 100,
                lg: Math.round(features.center[0] * 100 + 50) / 100,
                countrycode: features.context?.reduce((result: string | undefined, value: any) => {
                    if (value.id?.match(/^country/)) {
                        return value.short_code?.toUpperCase();
                    }
                    return result;
                }, undefined),
                timezone: {
                    name: timeZone,
                    offset: getTzOffset(timeZone)
                }
            };
        })
        .catch((e) => {
            log('findApproximateContestLocation failed:', e);
            return {lt: 0, lg: 0, countrycode: '', timezone: {name: 'Europe/London', offset: 0}};
        });
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
        await db.query(escape`
            INSERT IGNORE INTO competition (compid, tz, tzoffset, mainwebsite)
            VALUES
                (
                    ${compid},
                    "Europe/London",
                    3600,
                    ${url}
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
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    classid: ClassId,
    className: string,
    date: string,
    dayNumber: string,
    results: any
): Promise<void> {
    let rows = 0;
    let doCheckForOGNMatches = false;
    const dateCode = toDateCode(date);

    if (!results || !results[0]) {
        log(`${className}: ${date} - no results`);
        return;
    }

    const igcRe = /a href=&quot;.(en_gb.download-contest-flight.+=1)&quot;/i;
    const cnRe = /([A-Z0-9]+)\s*<.a>\s*$/i;
    const flagRe = /class="flag.*title="([a-z]+)"/i;

    for (const row of results[0]) {
        if (row['#'] == 'DNF') continue;

        const pilotExtractor = row.CN.match(cnRe);
        if (!pilotExtractor) {
            log(`${date} ${className} ${row.CN} - no CN found!`);
            continue;
        }

        const urlExtractor = row.CN.match(igcRe);
        const pilot = pilotExtractor[1];
        const url = urlExtractor && urlExtractor[1] ? 'https://www.soaringspot.com/' + urlExtractor[1] : undefined;

        const flagExtractor = row.Contestant.match(flagRe);
        if (flagExtractor && dayNumber == 'Task 1') {
            const flag = flagExtractor[1].toUpperCase();
            db.query(escape`
                UPDATE pilots
                SET
                    country = ${flag}
                WHERE
                    compno = ${pilot}
                    AND class = ${classid}
            `);
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

        const rStart = row.Start != '' ? row.Start : null;
        const rFinish = row.Finish != '' ? row.Finish : null;
        const start = row.Start ? (cDate(row.Start)?.getTime() ?? 0) / 1000 : 0;
        const finish = row.Time != '' ? (cDate(row.Finish)?.getTime() ?? 0) / 1000 : 0;
        const duration = finish && start ? cHour(row.Time) ?? 0 : 0;

        const actuals = parseFloat(row.Speed);
        const actuald = parseFloat(row.Distance);
        const handicap = correctHandicap(row.Handicap);

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

            const pilotInfo =
                (
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

            if ((pilotInfo.igcavailable || 'Y') == 'N' && url && (pilotInfo.trackerid ?? 'unknown') == 'unknown') {
                // processIGC's signature is over-strict (branded
                // ClassName/Compno + a populated location). The legacy
                // call site passed in raw strings and a possibly-null
                // location and worked because the file was untyped — we
                // mirror that behaviour with a single any-cast rather
                // than pretend to know the real types here.
                await (processIGC as any)(classid, pilot, undefined, date, url, https, db, () => undefined);
                doCheckForOGNMatches = true;
            }
        }
    }

    if (doCheckForOGNMatches) {
        checkForOGNMatches(classid, date, db);
    }

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
}

//
// SoaringSpotScrapeSource — implementation of `ScoringSource` for the
// SoaringSpot HTML scraper. Each method does *only* the HTTP+parse work;
// every DB write goes through a shared helper.
//
export class SoaringSpotScrapeSource implements ScoringSource {
    readonly type = 'soaringspotscrape';

    async ensureMetadata(ctx: SourceCtx): Promise<void> {
        // Pull the same /pilots page used by fetchPilots, but only
        // consume the contest-info header (name, site, dates) so we can
        // populate the `competition` row before anything else fires.
        try {
            const body = await fetch(ctx.url + '/pilots').then((res) => res.text());
            const dom = htmlparser.parseDocument(body);
            const contestInfo = findOne((x) => x.name == 'div' && x.attribs?.class != 'contest-title', dom?.children);
            const name = cleanText(textContent(findOne((x) => x.name == 'h1', contestInfo?.children)));
            const site = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'location', contestInfo?.children)));
            const dates = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'date', contestInfo?.children)));
            await updateContest(ctx.db, ctx.log, ctx.compid, name, dates, site, ctx.url);
        } catch (e) {
            ctx.log(`ensureMetadata failed for ${ctx.compid}:`, e);
        }
    }

    async fetchPilots(ctx: SourceCtx): Promise<FetchPilotsResult> {
        const accumulator = new PilotFetchAccumulator();
        const synthetic = {n: 0};

        try {
            const body = await fetch(ctx.url + '/pilots').then((res) => res.text());
            const dom = htmlparser.parseDocument(body);

            // Refresh competition metadata while we have the page in hand.
            const contestInfo = findOne((x) => x.name == 'div' && x.attribs?.class != 'contest-title', dom?.children);
            if (contestInfo) {
                const name = cleanText(textContent(findOne((x) => x.name == 'h1', contestInfo.children)));
                const site = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'location', contestInfo.children)));
                const dates = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'date', contestInfo.children)));
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

            for (const raw of pilotsList) {
                if (!raw.CN || raw.CN == '') {
                    ctx.log(`skipping pilot row with no CN`, raw);
                    continue;
                }
                const compno = raw.CN as CompNo;
                const normalizedClass = normalizeClassName(raw.Class);
                if (!normalizedClass) {
                    ctx.log(`skipping pilot ${compno}: no class label`, raw);
                    continue;
                }
                const classid = makeClassId(ctx.compid, normalizedClass) as ClassId;
                const handicap = correctHandicap(raw.Handicap);

                const pilot: PilotRecord = {
                    classid,
                    compno,
                    fullName: raw.Contestant,
                    club: raw.Club ?? null,
                    country: '',
                    glider: raw.Glider ?? null,
                    greg: raw.Glider ? String(raw.Glider).substring(0, 8).trim() : null,
                    handicap
                };

                await upsertPilot(ctx.db, ctx.log, pilot, accumulator, synthetic);
            }

            await pruneUnseenPilots(ctx.db, ctx.log, accumulator);
        } catch (e) {
            ctx.log(`fetchPilots failed for ${ctx.compid}:`, e);
        }

        return {observed: accumulator.observed};
    }

    async fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate): Promise<FetchResultsResult> {
        const observedClasses = new Set<ClassId>();
        const extractTask = /taskNormalize\((\{.+\}), \[.*\)/;

        try {
            const body = await fetch(ctx.url + '/results').then((res) => res.text());
            const dom = htmlparser.parseDocument(body);

            const allresults = findAll((x) => x.name == 'table' && x.attribs?.class == 'result-overview', dom.children);

            for (const result of allresults) {
                const nameRaw = textContent(findOne((x) => x.name == 'th', result.children)).trim();
                const normalizedName = normalizeClassName(nameRaw);
                const classid = makeClassId(ctx.compid, normalizedName) as ClassId;
                observedClasses.add(classid);

                const className = normalizedName.replace(/[_]/gi, ' ');

                await upsertClass(ctx.db, ctx.log, ctx.compid, classid, className);

                const dates = findAll((x) => x.name == 'tr' && x.parent?.nodeType == 1 && (x.parent as any)?.name == 'tbody', result.children);

                for (const day of dates) {
                    const cells = findAll((x) => x.name == 'td', day.children);
                    if (!cells?.length || cells.length < 2) {
                        ctx.log('no dates yet');
                        continue;
                    }

                    const daynumber = textContent(cells[1])?.trim();
                    if (daynumber == 'No task') {
                        continue;
                    }

                    const dateGB = textContent(cells[0])?.match(/([0-9]{2})\/([0-9]{2})\/([0-9]{4})/);
                    if (!dateGB) continue;

                    const date = dateGB[3] + '-' + dateGB[2] + '-' + dateGB[1];
                    const dateCode = toDateCode(date);

                    if (skipDay(classid, dateCode, date)) {
                        ctx.log(`skipping old day ${date} for class ${classid}`);
                        continue;
                    }

                    // Task fetch
                    const taskUrlAttr = getAttributeValue(toElement(cells[1].children[1]) as any, 'href');
                    if (taskUrlAttr) {
                        try {
                            const taskBody = await fetch('https://www.soaringspot.com' + taskUrlAttr).then((res) => res.text());
                            const task = taskBody.match(extractTask);
                            if (task) {
                                const taskJSON = JSON.parse(task[1]);
                                await upsertTaskAndLegs(ctx.db, ctx.log, classid, className, taskJSON);
                            }
                        } catch (e) {
                            ctx.log(`task fetch failed for ${classid} ${date}:`, e);
                        }
                    }

                    // Results fetch
                    const resultUrlAttr = getAttributeValue(toElement(cells[3]?.children?.[1]) as any, 'href');
                    if (resultUrlAttr) {
                        try {
                            const resBody = await fetch('https://www.soaringspot.com' + resultUrlAttr).then((res) => res.text());
                            const resDom = htmlparser.parseDocument(resBody);
                            const classTable = /result-daily/;
                            const resultTableNode = findOne((x) => (x.attribs?.class?.match(classTable) ? true : false), resDom.children);
                            if (resultTableNode) {
                                const fragment = getOuterHTML(resultTableNode);
                                const resultsHtml = Tabletojson.convert(fragment, {stripHtmlFromCells: false});
                                await processDayResults(ctx.db, ctx.log, classid, className, date, daynumber, resultsHtml);
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
}
