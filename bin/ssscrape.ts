#!/usr/bin/env node

// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence but please if you find bugs send pull request to github

import {createHash, randomBytes, createHmac} from 'crypto';

import {Tabletojson} from 'tabletojson'; // tabletojson = require('tabletojson').Tabletojson;

import * as htmlparser from 'htmlparser2';
//const htmlparser = require('htmlparser2');

import {findOne, findAll, find, isTag, existsOne, removeElement, getChildren, getInnerHTML, getOuterHTML, textContent, getAttributeValue} from 'domutils';

import getCountryISO3 from 'country-iso-2-to-3';

import {Element} from 'domhandler';

// Datecode helpers
import {fromDateCode, toDateCode} from '../lib/datecode';
import {makeClassId} from '../lib/classid';

// Coordinate -> IANA timezone lookup. Pulled in to derive competition.tz/
// tzoffset/countrycode without depending on a network call. Ported from the
// scrape-soaringspot stash.
const {find: findTz} = require('geo-tz');

// Helper
const fetcher = (url) => fetch(url).then((res) => res.json());
const https = require('node:https');

// We use these to get IGCs from SoaringSpot streaming
import {point, Coord} from '@turf/helpers';
import distance from '@turf/distance';
import bearing from '@turf/bearing';
import {getElevationOffset} from '../lib/getelevationoffset';
// handle unkownn gliders
import {processIGC, checkForOGNMatches} from '../lib/flightprocessing/launchlanding';

import {groupBy as _groupby, forEach as _forEach} from 'lodash';

// DB access
//const db = require('../db')
import escape from 'sql-template-strings';
const mysql = require('serverless-mysql');
let mysql_db;

let cnhandicaps = {};

// Fix the turpoint types from SoaringSpot to what we know
const oz_types = {
    symmetric: 'symmetrical',
    next: 'np',
    previous: 'pp',
    fixed: 'fixed',
    start: 'sp'
};

// Load the current file
const dotenv = require('dotenv');

// Location information, fetched from DB
var location;

// Set up background fetching of the competition
//
// Derive a URL-safe compid from a SoaringSpot URL. Takes the final meaningful
// path segment and sanitises it to lowercase [a-z0-9-], truncated to 40 chars.
// e.g. https://www.soaringspot.com/en_gb/lasham-regionals-2026/results
//   -> 'lasham-regionals-2026'
//
// Approximate site location returned by Mapbox geocoding. We use this to
// seed the competition row with coordinates, country, and timezone before
// any tasks have been scraped (taskleg coords later refine the timezone).
interface ApproximateContestLocation {
    lt: number;
    lg: number;
    countrycode: string;
    timezone: {
        name: string;
        offset: number;
    };
}

// Geocode a free-text location string (e.g. "Prievidza, Slovakia") via the
// Mapbox Places API and derive coords + country code + IANA timezone.
// Returns a safe fallback on any failure so the scrape can still proceed.
async function findApproximateContestLocation(location: string): Promise<ApproximateContestLocation> {
    const referrer = 'https://' + (process.env.NEXT_PUBLIC_SITEURL || '') + '/';
    const accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

    if (!accessToken) {
        console.log('NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN not set, skipping geocode');
        return {lt: 0, lg: 0, countrycode: '', timezone: {name: 'Europe/London', offset: 0}};
    }

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json?limit=1&access_token=${accessToken}`;

    return fetch(url, {headers: {Referer: referrer}})
        .then((res) => {
            if (res.status != 200) {
                console.log(` ${url}: ${res.status}`);
                throw new Error('mapbox error:' + res.status);
            }
            return res.json();
        })
        .then((r: any) => {
            const features = r.features?.[0];
            if (!features || !features.center) {
                throw new Error('no features found');
            }
            console.log(features);

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
            console.log('findApproximateContestLocation failed:', e);
            return {lt: 0, lg: 0, countrycode: '', timezone: {name: 'Europe/London', offset: 0}};
        });
}

// Wrapper around geo-tz: returns the IANA timezone name for a lat/lng.
// geo-tz returns an array (in case the point is on a boundary); we take
// the first match.
function findTimezoneFromLocation(lat: number, lng: number): string {
    const result = findTz(lat, lng);
    return Array.isArray(result) ? result[0] : result;
}

// Convert an IANA timezone name into the UTC offset in seconds. Uses
// Intl.DateTimeFormat to format "GMT+01:00" / "GMT-05:00" style strings,
// then parses the trailing offset.
function getTzOffset(tzname: string): number {
    const parts = Intl.DateTimeFormat('ia', {
        timeZoneName: 'short',
        timeZone: tzname
    }).formatToParts();
    const tzPart = parts.find((i) => i.type === 'timeZoneName');
    if (!tzPart) return 0;
    const offset = tzPart.value.slice(3); // strip "GMT"
    if (!offset) return 0;

    const matchData = offset.match(/([+-])(\d+)(?::(\d+))?/);
    if (!matchData) {
        console.log(`cannot parse timezone offset: ${tzPart.value}`);
        return 0;
    }
    const [, sign, hour, minute] = matchData;
    let result = parseInt(hour) * 60 * 60;
    if (minute) result += parseInt(minute) * 60;
    if (sign === '-') result *= -1;
    return result;
}

// Normalize a SoaringSpot class label into a canonical form that hashes
// identically whether it came from the /results `<th>` (usually bare, e.g.
// "Open") or the /pilots table's Class column (may have a "Class"/"Klasse"
// suffix, extra whitespace, or varying case). Both call sites MUST run the
// input through this before calling makeClassId(), otherwise the pilots
// rows won't share a classid with the classes row and nothing joins.
function normalizeClassName(raw: string): string {
    return (raw || '')
        .replace(/\s*(class|klasse)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function deriveCompIdFromUrl(urlString: string): string | null {
    try {
        const u = new URL(urlString);
        const segments = u.pathname.split('/').filter(Boolean);
        // Skip trailing known-generic segments like /results, /pilots, /tasks
        const generic = new Set(['results', 'pilots', 'tasks', 'contestants', 'daily']);
        while (segments.length && generic.has(segments[segments.length - 1])) {
            segments.pop();
        }
        // SoaringSpot paths start with a locale (en_gb), then the contest slug;
        // take the last remaining segment.
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

async function main() {
    if (dotenv.config({path: '.env.local'}).error) {
        console.log('New install: no configuration found, or script not being run in the root directory');
        process.exit();
    }

    mysql_db = mysql({
        config: {
            host: process.env.MYSQL_HOST || 'db',
            database: process.env.MYSQL_DATABASE || 'ogn',
            user: process.env.MYSQL_USER || 'ogn',
            password: process.env.MYSQL_PASSWORD
        }
    });

    //
    // One-shot CLI mode:
    //   node dist/bin/ssscrape.js <soaringspot-url> [compid]
    //
    // If a URL is given on the command line we upsert a scoringsource row for
    // it and scrape just that one competition, then exit. compid can be passed
    // explicitly as a second arg; otherwise it's derived from the URL slug.
    //
    const cliArgs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
    const urlArg = cliArgs.find((a) => /^https?:\/\//i.test(a));
    if (urlArg) {
        const compidArg = cliArgs.find((a) => a !== urlArg);
        const compid = compidArg || deriveCompIdFromUrl(urlArg);
        if (!compid) {
            console.log(`unable to derive a compid from ${urlArg} — pass one explicitly as the second argument`);
            process.exit(1);
        }

        console.log(`one-shot scrape: compid=${compid} url=${urlArg}`);

        // Upsert the scoringsource row so subsequent daemon runs pick it up
        // too. There's no unique constraint on (compid, type) so do a delete
        // + insert for that specific pair.
        await mysql_db.query(escape`
            DELETE FROM scoringsource
            WHERE compid = ${compid} AND type = 'soaringspotscrape'
        `);
        await mysql_db.query(escape`
            INSERT INTO scoringsource (compid, type, url)
            VALUES (${compid}, 'soaringspotscrape', ${urlArg})
        `);

        try {
            await ssscrape({compid, url: urlArg});
            console.log(`scrape complete for compid=${compid}`);
        } catch (e) {
            console.log('scrape failed:', e);
            process.exit(1);
        }
        // Give any fire-and-forget fetches (pilot photos etc.) a moment to
        // land before exiting, then bail out — we don't want the daemon
        // setInterval loops in CLI mode.
        setTimeout(() => process.exit(0), 5000);
        return;
    }

    // Daemon mode: iterate every configured scoringsource row on a schedule
    ssscrapeAll();
    roboControl();

    console.log('Background scraping from soaring spot enabled');
    setInterval(
        function () {
            ssscrapeAll();
        },
        5 * 60 * 1000
    );
    setInterval(
        function () {
            roboControl();
        },
        3 * 60 * 60 * 1000
    );
}

main().then(() => {
    console.log('exiting');
});

async function roboControl() {
    // Allow the use of environment variables to configure the soaring spot endpoint
    // rather than it being in the database
    let url: string | null = null;
    let overwrite = false;
    if (process.env.ROBOCONTROL_URL) {
        url = process.env.ROBOCONTROL_URL;
    }

    if (!url) {
        // Get the soaring spot keys from database
        const row = (
            await mysql_db.query(escape`
                SELECT
                    url,
                    overwrite
                FROM
                    scoringsource
                WHERE
                    type = 'robocontrol'
            `)
        )[0] ?? {url: null, overwrite: true};
        url = row.url;
        overwrite = row.overwrite ?? true;
    }

    if (!url) {
        return;
    }

    console.log(`robocontrol url ${url} configured`);

    fetch(url)
        .then((res) => {
            if (res.status != 200) {
                console.log(` ${url}: ${res}`);
                return {};
            } else {
                return res.json();
            }
        })
        .then((data: any[] | any) => {
            let location = data;
            if (data?.message) {
                location = data.message;
            }
            for (const p of location || []) {
                if (p.flarm?.length) {
                    console.log(`updating tracker ${p.cn} to ${p.flarm.join(',')}`);
                    if (overwrite) {
                        mysql_db.query(escape`
                            UPDATE tracker
                            SET
                                trackerid = ${p.flarm.join(',')}
                            WHERE
                                compno = ${p.cn}
                        `);
                    } else {
                        mysql_db.query(escape`
                            UPDATE tracker
                            SET
                                trackerid = ${p.flarm.join(',')}
                            WHERE
                                compno = ${p.cn}
                                AND trackerid = 'unknown'
                        `);
                    }
                    mysql_db.query(escape`
                        INSERT INTO
                            trackerhistory
                        VALUES
                            (
                                ${p.cn},
                                now(),
                                ${p.flarm.join(',')},
                                '',
                                NULL,
                                'robocontrol'
                            )
                    `);
                }
            }
        });
}

async function ssscrapeAll(deep = false) {
    // Env-var fallback for single-competition dev/test; compid must be supplied
    if (process.env.SOARINGSPOT_URL && process.env.COMP_ID) {
        await ssscrape(
            {
                compid: process.env.COMP_ID,
                url: process.env.SOARINGSPOT_URL,
                overwrite: process.env.SOARINGSPOT_OVERWRITE || 1,
                actuals: process.env.SOARINGSPOT_ACTUALS || 1
            },
            deep
        );
        return;
    }

    const allKeys = (await mysql_db.query(escape`
        SELECT
            *
        FROM
            scoringsource
        WHERE
            type = 'soaringspotscrape'
    `)) as any[];

    if (!allKeys?.length) {
        console.log('no soaringspotscrape keys configured');
        return;
    }

    for (const keys of allKeys) {
        if (!keys.url || !keys.compid) {
            console.log('skipping soaringspotscrape row: missing compid/url');
            continue;
        }
        try {
            await ssscrape(keys, deep);
        } catch (e) {
            console.log(`ssscrape failed for compid=${keys.compid}:`, e);
        }
    }
}

async function ssscrape(keys: any, _deep = false) {
    console.log(
        'competition',
        await mysql_db.query(escape`
            SELECT
                *
            FROM
                competition
            WHERE compid = ${keys.compid}
        `)
    );

    await fetch(keys.url + '/pilots')
        .then((res) => res.text())
        .then(async (body) => {
            let dom = htmlparser.parseDocument(body);
            console.log(dom);
            const contestInfo = findOne((x) => x.name == 'div' && x.attribs?.class != 'contest-title', dom?.children);

            console.log(contestInfo);

            // textContent returns the raw inner text including newlines and
            // pretty-printing indentation from the SoaringSpot HTML, so .trim()
            // alone leaves embedded runs of whitespace inside the string.
            // Collapse internal whitespace and strip trailing punctuation —
            // SoaringSpot's location span comes through as e.g.
            // "Prievidza, Slovakia,\n   " which we want as "Prievidza, Slovakia".
            const cleanText = (s: string) =>
                (s || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .replace(/[\s,;.]+$/, '');
            const name = cleanText(textContent(findOne((x) => x.name == 'h1', contestInfo?.children)));
            const site = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'location', contestInfo.children)));
            const dates = cleanText(textContent(findOne((x) => x.name == 'span' && x.attribs?.class == 'date', contestInfo.children)));

            await update_contest(keys.compid, name, dates, site, keys.url);

            // Now extract the pilots list
            console.log('***********');
            //			const pilots = tabfindAll( (test) => (test.name == 'tr' && test.parent?.name == 'tbody' ),
            const pilots = Tabletojson.convert(getOuterHTML(findOne((x) => x.attribs?.class == 'pilot footable toggle-arrow-tiny', dom.children)));
            // MUST await — update_pilots builds a transaction and commits at
            // the end. Without await, the outer fetch chain resolved while
            // the transaction's queries were still queued, and the connection
            // could close before .commit() ran → no rows.
            await update_pilots(keys.compid, pilots[0]);

            console.log(`found ${pilots[0].length} pilots`);
            console.log(name);
            console.log(site);
            console.log(dates);
            console.log(`looking for competition ${keys.contest_name}`);
        })
        .catch((err) => {
            console.log('ummm', err);
        });

    const extractTask = new RegExp(/taskNormalize\((\{.+\}), \[.*\)/);

    await fetch(keys.url + '/results')
        .then((res) => res.text())
        .then(async function (body) {
            let dom = htmlparser.parseDocument(body);
            let competitionnames = [];

            const allresults = findAll((x) => x.name == 'table' && x.attribs?.class == 'result-overview', dom.children);

            for (const result of allresults) {
                const nameRaw = textContent(findOne((x) => x.name == 'th', result.children)).trim();
                // Normalize before hashing so update_pilots (which sees
                // pilot.Class with a possibly different "class"/"klasse"
                // suffix) lands on the same classid.
                const normalizedName = normalizeClassName(nameRaw);
                // Globally-unique class identifier: hash of compid + normalized name
                const classid = makeClassId(keys.compid, normalizedName);

                const className = normalizedName.replace(/[_]/gi, ' ');

                console.log(className);

                // Add to the database
                await mysql_db.query(escape`
                    INSERT INTO
                        classes (class, compid, classname, description, type)
                    VALUES
                        (
                            ${classid},
                            ${keys.compid},
                            ${className.substr(0, 29)},
                            ${className},
                            'club'
                        ) ON DUPLICATE KEY
                    UPDATE compid =
                    VALUES
                        (compid),
                        classname =
                    VALUES
                        (classname),
                        description =
                    VALUES
                        (description),
                        type =
                    VALUES
                        (type)
                `);

                await mysql_db.query(escape`
                    insert ignore INTO compstatus (class)
                    VALUES
                        (${classid})
                `);

                // Make sure we have rows for each day and that compstatus is correct
                //    await mysql_db.query( escape`call contestdays()`);
                await mysql_db.query(escape`
                    UPDATE compstatus
                    SET
                        status = ':',
                        datecode = ${toDateCode()}
                    WHERE class = ${classid}
                `);

                const dates = findAll((x) => x.name == 'tr' && x.parent?.nodeType == 1 && x.parent?.name == 'tbody', result.children);

                for (const day of dates) {
                    const keys = findAll((x) => x.name == 'td', day.children);

                    if (!keys?.length || keys?.length < 2) {
                        console.log('no dates yet');
                        continue;
                    }

                    const daynumber = textContent(keys[1])?.trim();
                    if (daynumber == 'No task') {
                        console.log('no task yet');
                        continue;
                    }

                    const dateGB = textContent(keys[0])?.match(/([0-9]{2})\/([0-9]{2})\/([0-9]{4})/);
                    if (!dateGB) {
                        console.log('no task yet');
                        continue;
                    }

                    const date = dateGB[3] + '-' + dateGB[2] + '-' + dateGB[1];

                    const url = getAttributeValue(toElement(keys[1].children[1]), 'href');

                    console.log(date, daynumber, url);
                    await fetch('https://www.soaringspot.com' + url)
                        .then((res) => res.text())
                        .then(async (body) => {
                            const task = body.match(extractTask);
                            if (task) {
                                const taskJSON = JSON.parse(task[1]);
                                // MUST await — process_day_task runs a
                                // transaction chain that populates taskleg
                                // and backfills competition.lt/lg from it.
                                // Without await, CLI mode exits before the
                                // commit lands.
                                await process_day_task(taskJSON, classid, className);
                            }
                        });

                    const rurl = getAttributeValue(toElement(keys[3].children[1]), 'href');

                    console.log(date, daynumber, rurl);
                    await fetch('https://www.soaringspot.com' + rurl)
                        .then((res) => res.text())
                        .then(async (body) => {
                            var dom = htmlparser.parseDocument(body);
                            const classTable = new RegExp(/result-daily/);
                            const result_table_fragment = getOuterHTML(findOne((x) => (x.attribs?.class?.match(classTable) ? true : false), dom.children));
                            const results_html = Tabletojson.convert(result_table_fragment, {
                                stripHtmlFromCells: false
                            });
                            await process_day_results(classid, className, date, daynumber, results_html);
                        });
                }
            }
        });
}
import render from 'dom-serializer';

async function findPilot(lastname: string, countrycode: string, classid: string, compno: string) {
    const names = lastname.split(' ').reverse();

    console.log(`checking ranking list for ${lastname} from ${countrycode}`);

    for (const name of names) {
        const possible = await fetch(`https://rankingdata.fai.org/SGP_SearchResults.php?surname=${name}&nationality=${getCountryISO3(countrycode) ?? ''}`)
            .then((res) => res.text())
            .then((body) => {
                let dom = htmlparser.parseDocument(body);

                const nameTable = findOne((x) => x.attribs?.class == 'RL_table_innerTable', dom.children);
                if (nameTable) {
                    const matches = find((x) => isTag(x) && x.name == 'a', nameTable.children, true, 100).map(toElement);

                    const potentials = matches
                        .map((match) => ({id: getAttributeValue(match, 'href')?.match(/pilotid=([0-9]+)/)?.[1], name: textContent(match)})) //
                        .filter((m) => m.id && m.name && m.name != 'No image');

                    console.log('***** potentials ****');
                    console.table(potentials);

                    const filteredByName = potentials.filter((p) => names.every((n) => p.name!.match(new RegExp(`(^${n}| +${n})`, 'i'))));

                    if (filteredByName.length == 1 && filteredByName[0]?.id) {
                        const img = matches
                            .filter((match) => match && getAttributeValue(match, 'href')?.match(/pilotid=([0-9]+)/)?.[1] == filteredByName[0].id)
                            .map((row) => row && findOne((x) => isTag(x) && x.name == 'img', row.children))
                            .map((img) => img && getAttributeValue(img, 'src'))
                            .filter((src) => !!src);

                        console.log(`-> found using ${name} fai id: ${filteredByName[0].id}, ${img}`);
                        if (img.length && img[0]) {
                            /*await*/ downloadPicture('https://rankingdata.fai.org/' + img[0], classid, compno);
                        }
                        return parseInt(filteredByName[0].id);
                    }
                    return undefined;
                }
            });
        if (possible) {
            return possible;
        }
    }
}

async function update_class(compid: string, className: string, data: any, dataHtml: any) {
    // Get the name of the class, if not set use the type
    const nameRaw = className;

    // Globally-unique class identifier: hash of compid + raw name
    const classid = makeClassId(compid, nameRaw);

    const name = nameRaw.replace(/[_]/gi, ' ');

    // Add to the database
    await mysql_db.query(escape`
        INSERT INTO
            classes (class, compid, classname, description, type)
        VALUES
            (
                ${classid},
                ${compid},
                ${name.substr(0, 29)},
                ${name},
                'club'
            ) ON DUPLICATE KEY
        UPDATE compid =
        VALUES
            (compid),
            classname =
        VALUES
            (classname),
            description =
        VALUES
            (description),
            type =
        VALUES
            (type)
    `);

    await mysql_db.query(escape`
        insert ignore INTO compstatus (class)
        VALUES
            (${classid})
    `);

    // Make sure we have rows for each day and that compstatus is correct
    //    await mysql_db.query( escape`call contestdays()`);
    await mysql_db.query(escape`
        UPDATE compstatus
        SET
            status = ':',
            datecode = ${toDateCode()}
        WHERE class = ${classid}
    `);

    // Now add details of pilots
    await update_pilots(compid, data['Piloter']);

    // Import the results
    //    await process_class_tasks_and_results(classid, className, dataHtml);
}

//
// generate pilot entries and results for each pilot, this needs to be done before we
// download the scores
async function update_pilots(compid: string, data: any) {
    let unknowncompno = 0;
    let pilotnumber = 0;
    let insertedCount = 0;

    console.log(`update_pilots: compid=${compid} rows=${data?.length ?? 0}`);

    for (const pilot of data) {
        // Make sure it has a comp number
        if (!pilot.CN || pilot.CN == '') {
            pilot.contestant_number = -unknowncompno++;
            console.log('Skipping pilot as no registration', pilot);
            continue;
        }

        // And change handicaps to BGA style
        const greg = '';
        const compno = pilot.CN;
        const handicap = correct_handicap(pilot.Handicap);

        // Compute the globally-unique class id the same way update_class
        // does for the /results flow. Both sides run the raw label through
        // normalizeClassName() first so "Open", "Open Class", "open "
        // all hash to the same classid.
        const normalizedClass = normalizeClassName(pilot.Class);
        if (!normalizedClass) {
            console.log(`skipping pilot ${compno}: no class label on row`, pilot);
            continue;
        }
        const classid = makeClassId(compid, normalizedClass);

        function gravatar(x) {
            const y = createHash('md5')
                .update((x + '@comps.onglide.com').replace(/\s/g, '').toLowerCase())
                .digest('hex');
            console.log(y);
            return y;
        }

        const existing =
            (await mysql_db.query(escape`
                SELECT
                    fai,
                    country
                FROM
                    pilots
                WHERE
                    compno = ${compno}
                    AND class = ${classid}
            `)) ?? [];
        console.log('====>', compno, existing);

        let fainumber = existing[0]?.fai;
        if (!existing?.length || !fainumber || fainumber > 3000000) {
            fainumber = existing.length && fainumber < 3003000 ? await findPilot(pilot.Contestant, existing[0].country, classid, compno) : 0;
            if (!fainumber) {
                fainumber = existing[0]?.fai ? existing[0].fai : 3000000 + ++pilotnumber;
            }
        }
        await download_picture(
            compno,
            classid, //
            {igc_id: fainumber, compno: pilot.Contestant, class: classid, greg: pilot.Glider?.substring(0, 8)?.trim()}
        );

        try {
            await mysql_db.query(escape`
                INSERT INTO
                    pilots (
                        class,
                        firstname,
                        lastname,
                        homeclub,
                        username,
                        fai,
                        country,
                        email,
                        compno,
                        participating,
                        glidertype,
                        greg,
                        handicap,
                        registered,
                        registereddt
                    )
                VALUES
                    (
                        ${classid},
                        ${pilot.Contestant},
                        ${''},
                        ${pilot.Club},
                        NULL,
                        ${fainumber},
                        '',
                        ${gravatar(pilot.Contestant)},
                        ${compno},
                        'Y',
                        ${pilot.Glider},
                        ${greg},
                        ${handicap},
                        'Y',
                        NOW()
                    ) ON DUPLICATE KEY
                UPDATE class =
                VALUES
                    (class),
                    firstname =
                VALUES
                    (firstname),
                    lastname =
                VALUES
                    (lastname),
                    homeclub =
                VALUES
                    (homeclub),
                    fai =
                VALUES
                    (fai),
                    country =
                VALUES
                    (country),
                    email =
                VALUES
                    (email),
                    participating =
                VALUES
                    (participating),
                    handicap =
                VALUES
                    (handicap),
                    glidertype =
                VALUES
                    (glidertype),
                    greg =
                VALUES
                    (greg),
                    registereddt = NOW()
            `);
            insertedCount++;
        } catch (e) {
            console.log(`pilot INSERT failed ${compno} ${classid}:`, e);
        }
    }

    console.log(`update_pilots: inserted/updated ${insertedCount}/${data?.length ?? 0}`);

    // remove any old pilots as they aren't needed, they may not go immediately but it will be soon enough
    await mysql_db.query(escape`
        DELETE FROM pilots
        WHERE registereddt < DATE_SUB (NOW(), INTERVAL 15 MINUTE)
    `);

    // Trackers needs a row for each pilot so fill any missing
    await mysql_db.query('INSERT IGNORE INTO tracker ( class, compno, type, trackerid ) select class, compno, "flarm", "unknown" from pilots');
}

//
// Store the task in the MYSQL
async function process_day_task(day, classid, classname) {
    let rows = 0;
    let date = day.task_date;
    let dateCode = toDateCode(date);

    let script = '';
    let status = day.result_status; //.replace(/^([a-z])/\U1/; I think this uppercases first letter? but perl

    // extract UK meta data from it (this is from UK scoring script and allows for windicapping
    let windspeed = 0;
    let winddir = 0;

    let tasktype = 'S';
    let duration = '00:00';
    if (day.task_type == 'assigned_area') {
        tasktype = 'A';
        duration = new Date(day.task_duration * 1000).toISOString().substr(11, 8);
    }

    // So we don't rebuild tasks if they haven't changed
    // Promote compstatus to 'B' (briefed) unconditionally whenever we see
    // a task for this class, including on re-runs where the task hash is
    // unchanged and the transaction chain below short-circuits. Doing it
    // here as a plain awaited query (rather than inside the chain) also
    // side-steps the flaky transaction-chain commit behaviour that's left
    // earlier updates queued but uncommitted. The status NOT IN (...)
    // guard still protects airborne/landed/scrubbed classes.
    if (day.result_status != 'cancelled') {
        await mysql_db.query(escape`
            UPDATE compstatus
            SET status = 'B', datecode = ${dateCode}
            WHERE class = ${classid}
              AND status NOT IN ('L', 'S', 'R', 'H', 'Z')
        `);
    } else {
        await mysql_db.query(escape`
            UPDATE compstatus
            SET status = 'Z', datecode = ${dateCode}
            WHERE class = ${classid}
        `);
    }

    const hash = createHash('sha256').update(JSON.stringify(day)).digest('base64');
    const dbhashrow = await mysql_db.query(escape`
        SELECT
            hash
        FROM
            tasks
        WHERE
            datecode = ${dateCode}
            AND class = ${classid}
    `);

    if (dbhashrow && dbhashrow.length > 0 && hash == dbhashrow[0].hash) {
        console.log(`${classid} - ${date}: task unchanged`);
        console.log(hash, dbhashrow[0]);
        return;
    } else {
        console.log(`${classid} - ${date}: task changed`);
    }

    for (const tp of day.task_points) {
        tp.altitude = await new Promise((resolve) => getElevationOffset(toDeg(tp.latitude), toDeg(tp.longitude), resolve));
    }

    // Do this as one block so we don't end up with broken tasks
    await mysql_db
        .transaction()

        // If it is the current day and we have a start time we save it
        .query(escape`
            UPDATE compstatus
            SET
                starttime = COALESCE(${convert_to_mysql(day.no_start)}, starttime)
            WHERE
                datecode = ${dateCode}
                AND class = ${classid}
        `)

        // remove any old crud
        .query(escape`
            DELETE FROM tasks
            WHERE
                datecode = ${dateCode}
                AND class = ${classid}
                AND task = 'B'
        `)

        // and add a new one
        .query(escape`
            INSERT INTO
                tasks (
                    datecode,
                    class,
                    flown,
                    description,
                    duration,
                    type,
                    task,
                    nostart,
                    hash
                )
            VALUES
                (
                    ${dateCode},
                    ${classid},
                    'N',
                    ${day.task_type},
                    ${duration},
                    ${tasktype},
                    'B',
                    '00:00:00',
                    ${hash}
                )
        `)

        // This query is a built one as we have to have it all as one string :( darn transactions

        .query((r) => {
            const taskid = r.insertId;
            if (!taskid) {
                console.log(`${classid} - ${date}: unable to insert task!`);
                return null;
            }

            let values: (string | number)[] = [];
            let query = 'INSERT INTO taskleg ( class, datecode, taskid, legno, ' + 'length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12, altitude ) ' + 'VALUES ';

            let previousPoint: Coord | null = null;
            let currentPoint: Coord | null = null;
            for (const tp of day.task_points.sort((a, b) => a.point_index - b.point_index)) {
                console.log(tp);

                // We don't handle multiple starts at all so abort
                if (tp.multiple_start != 0) {
                    continue;
                }

                // can we extract a number off the leading part of the turnpoint name, if so treat it as a trigraph
                // it must be leading, and 3 or 4 digits long and we will then strip it from the name
                let tpname = tp.name;
                let trigraph = tpname.substr(0, 3);
                if (tpname && ([trigraph] = tpname.match(/^([0-9]{1,4})/) || [trigraph])) {
                    tpname = tpname.replace(/^([0-9]{1,4})/, '').trim();
                }

                // So we can calculate distances etc
                previousPoint = currentPoint;
                console.log(tpname, toDeg(tp.longitude), toDeg(tp.latitude));
                currentPoint = point([toDeg(tp.longitude), toDeg(tp.latitude)]);

                const leglength = previousPoint ? distance(previousPoint, currentPoint) : 0;
                const bearingDeg = previousPoint ? (bearing(previousPoint, currentPoint) + 360) % 360 : 0;
                let hi = 0; // only used when windicapping

                query = query + "( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sector', ?, ?, ?, ?, ?, ?,? ),";

                values = values.concat([
                    classid, //
                    dateCode,
                    taskid,
                    tp.point_index,
                    leglength,
                    bearingDeg,
                    toDeg(tp.latitude),
                    toDeg(tp.longitude),
                    hi,
                    trigraph,
                    tpname,
                    oz_types[tp.oz_type],
                    tp.oz_radius1 / 1000,
                    tp.oz_line ? 90 : toDeg(tp.oz_angle1),
                    tp.oz_radius2 / 1000,
                    toDeg(tp.oz_angle2),
                    tp.oz_type == 'fixed' ? toDeg(tp.oz_angle12) : 0,
                    tp.altitude
                ]);
            }

            query = query.substring(0, query.length - 1);
            // This is done in the chaining
            return [query, values];
        })

        // Remove the old task and legs for this class and date
        .query((r, ro) => {
            const taskid = ro[ro.length - 2].insertId;
            return ['DELETE FROM tasks WHERE class=? AND taskid != ? AND datecode = ?', [classid, taskid, dateCode]];
        })
        .query((r, ro) => {
            const taskid = ro[ro.length - 3].insertId;
            return ['UPDATE tasks SET task="A", flown="Y" WHERE class=? AND taskid = ?', [classid, taskid]];
        })

        // redo the distance calculation, including calculating handicaps
        //        .query((r, ro) => {
        //          const taskid = ro[ro.length - 5].insertId;
        //         return escape`call wcapdistance_taskid( ${taskid} )`;
        //   })

        // make sure we have result placeholder for each day, we will fail to save scores otherwise
        .query(escape`
            INSERT IGNORE INTO pilotresult (
                class,
                datecode,
                compno,
                status,
                start,
                finish,
                duration,
                distance,
                hdistance,
                speed,
                hspeed,
                igcavailable
            )
            SELECT
                ${classid},
                ${dateCode},
                compno,
                '-',
                '00:00:00',
                '00:00:00',
                '00:00:00',
                0,
                0,
                0,
                0,
                'N'
            FROM
                pilots
            WHERE
                pilots.class = ${classid}
        `)

        // And update the day with status and text etc
        .query(escape`
            INSERT INTO
                contestday (
                    class,
                    script,
                    length,
                    result_type,
                    info,
                    winddir,
                    windspeed,
                    daynumber,
                    status,
                    notes,
                    calendardate,
                    datecode
                )
            VALUES
                (
                    ${classid},
                    LEFT(${script}, 60),
                    ${Math.round(day.task_distance / 100) / 10},
                    ${status},
                    ${''},
                    winddir,
                    windspeed,
                    ${day.task_number},
                    'Y',
                    ${day?.notes || ''},
                    ${date},
                    ${dateCode}
                ) ON DUPLICATE KEY
            UPDATE turnpoints =
            VALUES
                (turnpoints),
                script = LEFT(
                    VALUES
                        (script),
                        60
                ),
                length =
            VALUES
                (length),
                result_type =
            VALUES
                (result_type),
                info =
            VALUES
                (info),
                winddir =
            VALUES
                (winddir),
                windspeed =
            VALUES
                (windspeed),
                daynumber =
            VALUES
                (daynumber),
                status =
            VALUES
                (status),
                notes =
            VALUES
                (notes),
                calendardate =
            VALUES
                (calendardate)
        `)

        // (compstatus promotion moved out of this transaction chain to
        // an unconditional awaited UPDATE at the top of process_day_task
        // — see comment there for rationale.)

        // If it was cancelled then mark it as not flown, this will stop the UI from displaying it
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE tasks SET flown="N" WHERE class=? AND datecode=?', [classid, dateCode]];
            else return null;
        })
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE contestday SET status="N" WHERE class=? AND datecode=?', [classid, dateCode]];
            else return null;
        })
        // Combine results
        //  .query( escape`update pilotresult pr1 left outer join pilotresult pr2
        //               on pr1.compno = pr2.compno and pr2.datecode = todcode(date_sub(fdcode(pr1.datecode),interval 1 day))
        //               set pr1.prevtotalrank = coalesce(pr2.totalrank,pr2.prevtotalrank)` )

        // Update the last date for results
        .query(escape`
            UPDATE compstatus
            SET
                resultsdatecode = GREATEST(
                    ${dateCode},
                    COALESCE(
                        resultsdatecode,
                        ${dateCode}
                    )
                )
            WHERE
                class = ${classid}
        `)
        .query(escape`
            UPDATE competition
            SET
                lt = (
                    SELECT
                        nlat
                    FROM
                        taskleg
                    WHERE taskleg.class = ${classid}
                    ORDER BY
                        legno DESC
                    LIMIT
                        1
                ),
                lg = (
                    SELECT
                        nlng
                    FROM
                        taskleg
                    WHERE taskleg.class = ${classid}
                    ORDER BY
                        legno DESC
                    LIMIT
                        1
                )
            WHERE
                (lt IS NULL OR lt = 0)
                AND compid = (SELECT compid FROM classes WHERE class = ${classid})
        `)
        .rollback((e) => {
            console.log('rollback');
        })
        .commit();

    // After the transaction commits, the competition row may have just been
    // backfilled with lt/lg from taskleg. Re-run the IANA tz lookup against
    // those (more accurate) coordinates and refresh tz/tzoffset if needed.
    // Wrapped in try/catch so a tz failure doesn't break the scrape.
    try {
        const compRow = (
            await mysql_db.query(escape`
                SELECT compid, lt, lg, tz
                FROM competition
                WHERE compid = (SELECT compid FROM classes WHERE class = ${classid})
            `)
        )?.[0];
        if (compRow?.lt && compRow?.lg) {
            const tz = findTimezoneFromLocation(compRow.lt, compRow.lg);
            if (tz && tz !== compRow.tz) {
                const tzoffset = getTzOffset(tz);
                console.log(`${classname}: refining tz from ${compRow.tz} -> ${tz} (${tzoffset}s) based on taskleg (${compRow.lt}, ${compRow.lg})`);
                await mysql_db.query(escape`
                    UPDATE competition SET tz = ${tz}, tzoffset = ${tzoffset}
                    WHERE compid = ${compRow.compid}
                `);
            }
        }
    } catch (e) {
        console.log('post-task tz refinement failed:', e);
    }

    // and some logging
    console.log(`${classname}: processed task ${date}`);
}

async function process_day_results(classid, className, date, day_number, results) {
    let rows = 0;
    let doCheckForOGNMatches = false;
    let dateCode = toDateCode(date);

    if (!results || results[0].length < 0) {
        console.log(`${className}: ${date} - no results`);
        return;
    }

    const igcRe = new RegExp(/a href=&quot;.(en_gb.download-contest-flight.+=1)&quot;/i, 'i');
    const cnRe = new RegExp(/([A-Z0-9]+)\s*<.a>\s*$/i, 'i');
    const flagRe = new RegExp(/class="flag.*title="([a-z]+)"/i, 'i');

    // It's a big long list of results ;)
    for (const row of results[0]) {
        if (row['#'] == 'DNF') {
            continue;
        }

        let pilotExtractor = row.CN.match(cnRe);
        if (!pilotExtractor) {
            console.log(`${date} ${className} ${row.CN} - no CN found!`);
            continue;
        }

        let urlExtractor = row.CN.match(igcRe);
        if (!urlExtractor) {
            console.log(`${row.CN}: no IGC file at all!`);
        }
        const pilot = pilotExtractor[1];
        const url = urlExtractor && urlExtractor[1] ? 'https://www.soaringspot.com/' + urlExtractor[1] : undefined;

        // Update the pilots flag
        const flagExtractor = row.Contestant.match(flagRe);
        if (flagExtractor && day_number == 'Task 1') {
            const flag = flagExtractor[1].toUpperCase();
            mysql_db.query(escape`
                UPDATE pilots
                SET
                    country = ${flag}
                WHERE
                    compno = ${pilot}
                    AND class = ${className}
            `);
        }

        function cDate(d: string | undefined) {
            if (d == undefined) {
                return undefined;
            }
            let x = new Date();
            const p = d.match(/([0-9]{2}):([0-9]{2}):([0-9]{2})/);
            if (!p) {
                return undefined;
            }
            x.setHours(parseInt(p[1]));
            x.setMinutes(parseInt(p[2]));
            x.setSeconds(parseInt(p[3]));
            return x;
        }

        function cHour(d) {
            if (d == undefined) {
                return undefined;
            }
            const p = d.match(/^([0-9]{0,2}):*([0-9]{2}):([0-9]{2})/);
            if (!p) {
                return undefined;
            }
            return parseInt(p[1]) + parseInt(p[2]) / 60 + parseInt(p[3]) / 3600;
        }

        const rStart = row.Start != '' ? row.Start : null;
        const rFinish = row.Finish != '' ? row.Finish : null;
        const start = row.Start ? cDate(row.Start).getTime() / 1000 : 0;
        const finish = row.Time != '' ? cDate(row.Finish).getTime() / 1000 : 0;
        const duration = finish && start ? cHour(row.Time) : 0;

        // for the bga scoring script that includes handicapped in the decimals
        // it's a special case, but could be used by other competitions if they want to
        const actuals = parseFloat(row.Speed);
        const actuald = parseFloat(row.Distance);
        const handicap = correct_handicap(row.Handicap);

        let scoredvals = {
            as: duration ? actuald / duration : 0,
            ad: actuald,
            hs: duration ? actuald / (handicap / 100) / duration : 0,
            hd: actuald / (handicap / 100)
        };

        const finished = actuals > 0;
        const scoredStatus = finished ? 'F' : actuald > 0 ? 'H' : 'S';

        // If there is data from scoring then process it into the database
        if ((row['#'] != 'DNF' && row['#'] != 'DNS') || finished) {
            const r = await mysql_db.query(escape`
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

            //          console.log(`${pilot}: ${handicap} (${duration} H) ${scoredvals.ad} ${scoredvals.hd}` );
            rows += r.affectedRows;

            // check the file to check tracking details
            let {igcavailable, trackerid} = (
                await mysql_db.query(escape`
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
            if ((igcavailable || 'Y') == 'N' && url && (trackerid ?? 'unknown') == 'unknown') {
                await processIGC(classid, pilot, location, date, url, https, mysql_db, () => undefined);
                doCheckForOGNMatches = true; //
            }
        }
    }

    // If we processed an IGC file we should check to see if we have an OGN launch/landing match
    if (doCheckForOGNMatches) {
        checkForOGNMatches(classid, date, mysql_db);
    }

    // Did anything get updated?
    if (rows) {
        await mysql_db.query(escape`
            UPDATE contestday
            SET
                results_uploaded = NOW()
            WHERE
                class = ${classid}
                AND datecode = ${dateCode}
                AND STATUS != "Z"
        `);
    }

    // rescore the day, but only for preliminary results
    //    const status = day.result_status.toLowerCase();
    //    if( status == 'preliminary' ) {
    //        await db.query( escape`call daypoints(${classid})` );
    //    }
}

//
// We will now update the competition object, this isn't a new object
// as you will possibly want to tweak values in it!
//
async function update_contest(compid: string, contest_name: string, dates: string, site_name: string, url: string) {
    // Make sure a competition row exists for this compid
    const count = await mysql_db.query(escape`SELECT COUNT(*) cnt FROM competition WHERE compid = ${compid}`);
    if (!count || !count[0] || !count[0].cnt) {
        console.log(`Empty competition for compid=${compid}, pre-populating`);
        await mysql_db.query(escape`
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

    console.log(dates);

    const matches = dates.match(/([0-9A-Z ,]+) – ([0-9A-Z ,]+)/i);
    if (matches) {
        console.log(matches);
        console.log(Date.parse(matches[1] + ' UTC'));

        //
        // Make sure the dates are copied across (countrycode is set later
        // by the geocoder if we get a hit; leave it untouched otherwise)
        await mysql_db.query(escape`
            UPDATE competition
            SET
                start = from_unixtime (${Date.parse(matches[1] + ' UTC') / 1000}),
                END = from_unixtime (${Date.parse(matches[2] + ' UTC') / 1000}),
                name = ${contest_name.substring(0, 40)}
            WHERE compid = ${compid}
        `);
    }

    // Look up the competition row to see whether we already have coordinates.
    location = (
        await mysql_db.query(escape`
            SELECT
                lt,
                lg
            FROM
                competition
            WHERE compid = ${compid}
        `)
    )[0];

    // First-pass geocoding: if we don't have coordinates yet, hand the
    // SoaringSpot venue string to Mapbox. We get back coarse coords plus
    // country code plus an IANA tz derived from those coords. The lat/lng
    // gets refined later when process_day_task backfills from taskleg.
    if ((!location || !location.lt) && site_name) {
        console.log(`geocoding site "${site_name}" for compid=${compid}`);
        const acl = await findApproximateContestLocation(site_name);
        console.log(acl);
        if (acl.lt && acl.lg) {
            await mysql_db.query(escape`
                UPDATE competition
                SET
                    tz = ${acl.timezone.name},
                    tzoffset = ${acl.timezone.offset},
                    countrycode = ${acl.countrycode || null},
                    lt = ${acl.lt},
                    lg = ${acl.lg},
                    sitename = ${site_name.substring(0, 40)}
                WHERE compid = ${compid}
            `);
            location = {lt: acl.lt, lg: acl.lg};
        }
    }

    // Second-pass tz refinement: now that we (may) have coordinates from
    // either the geocoder above OR a previous task backfill, derive the IANA
    // tz from the actual point and update if it differs from what's stored.
    // This catches cases where the geocoder snapped to a city centre in a
    // neighbouring tz than the airfield.
    if (location?.lt && location?.lg) {
        try {
            const tz = findTimezoneFromLocation(location.lt, location.lg);
            const tzoffset = getTzOffset(tz);
            await mysql_db.query(escape`
                UPDATE competition
                SET tz = ${tz}, tzoffset = ${tzoffset}
                WHERE compid = ${compid}
                  AND (tz IS NULL OR tz != ${tz})
            `);
        } catch (e) {
            console.log('tz refinement failed:', e);
        }
    }

    if (location?.lt) {
        // Save four our use
        location.point = point([location.lt, location.lg]);

        // Calculate elevation so we can do launch calculations from the IGC files
        getElevationOffset(location.lt, location.lg, (agl) => {
            location.altitude = agl;
            console.log('SITE Altitude:' + agl, location);
        });
    }

    if (0) {
        //keys.deep ) {
        // clear it all down, we will load all of this from soaring spot
        // NOTE: this should not be cleared every time, even though at present it is
        // TBD!!
        // All scoped to compid so one competition's deep reset does not touch other competitions.
        await mysql_db
            .transaction()
            .query(escape`DELETE FROM pilots WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM pilotresult WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM contestday WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM compstatus WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM taskleg WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM tasks WHERE class IN (SELECT class FROM classes WHERE compid = ${compid})`)
            .query(escape`DELETE FROM classes WHERE compid = ${compid}`)
            .query(escape`
                DELETE FROM logindetails
                WHERE
                    type = "P"
            `)
            .commit();
        console.log(`deep update requested, deleted everything for compid=${compid}`);
    }
}

// Fetch the picture from FAI rankings
async function download_picture(compno, classid, context) {
    // Check when it was last checked
    const lastUpdated = (
        await mysql_db.query(escape`
            SELECT
                updated
            FROM
                images
            WHERE
                class = ${classid}
                AND compno = ${compno}
                AND image IS NOT NULL
                AND unix_timestamp () - updated < 86400
        `)
    )[0];

    if (lastUpdated) {
        console.log(`not updating ${compno} picture`);
        return;
    }

    // Find all the updater urls
    const urls = (await mysql_db.query(escape`
        SELECT
            url
        FROM
            scoringsource
        WHERE
            type = 'pictureurl'
    `)) as {url: string}[];
    let success = false;

    for (const u of urls) {
        const url = u.url.replace(/\{([A-Z_]+)\}/gi, function (_, v) {
            return v in context ? context[v] : '';
        });

        console.log(`downloading picture for ${classid}:${compno} from ${url}`);
        if (await downloadPicture(url, classid, compno)) {
            success = true;
            break;
        }
    }

    if (!success) {
        console.log(` ${classid}:${compno}: image update failed`);
        await mysql_db.query(escape`
            INSERT INTO
                images (class, compno, image, updated)
            VALUES
                (
                    ${classid},
                    ${compno},
                    NULL,
                    unix_timestamp ()
                ) ON DUPLICATE KEY
            UPDATE image = NULL,
            updated =
            VALUES
                (updated)
        `);
    }
}

async function downloadPicture(url: string, classid: string, compno: string) {
    console.log(`downloading picture for ${classid}:${compno} from ${url}`);

    const res = await fetch(url, {headers: {Referer: 'https://' + process.env.NEXT_PUBLIC_SITEURL + '/'}});

    if (res.status != 200) {
        console.log(` ${classid}:${compno}: website returns ${res.status}: ${res.statusText}`);
        return false;
    }

    const data = Buffer.from(await res.arrayBuffer());
    if (data) {
        await mysql_db.query(escape`
            INSERT INTO
                images (class, compno, image, updated)
            VALUES
                (
                    ${classid},
                    ${compno},
                    ${data},
                    unix_timestamp ()
                ) ON DUPLICATE KEY
            UPDATE image =
            VALUES
                (image),
                updated =
            VALUES
                (updated)
        `);
        return true;
    } else {
        console.log('no data');
        return false;
    }
}

// Get rid of the T at the front...
function convert_to_mysql(jsontime) {
    return jsontime ? jsontime.replace(/^.*T/, '') : jsontime;
}

// From radians
function toDeg(a) {
    return (a / Math.PI) * 180;
}

//
// All the bizarre forms of handicap that have been spotted in scoring spot
function correct_handicap(handicap) {
    return !handicap ? 100 : handicap < 2 ? handicap * 100 : handicap > 140 ? handicap / 10 : handicap;
}

function toElement(x) {
    return x.nodeType == 1 ? (x as Element) : null;
}
