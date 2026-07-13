// Copyright 2020- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// RstSource — `ScoringSource` adapter for the RST-Online (rst-online.se)
// Swedish club-competition results website. Replaces the legacy standalone
// bin/rst.ts daemon: the HTTP fetch + HTML parsing live here, every DB
// write goes through the shared helpers in lib/scoring/shared/* the other
// adapters use. The scheduler picks this up by registering an instance
// against `type = 'rst'`.
//
// Like SGP, RST serves the whole competition — every class, its pilots,
// and all days' tasks + results — from a single page (scoringsource.url).
// That page can host several competitions in tabbed panels;
// scoringsource.contest_name is a case-insensitive regex that selects the
// panel(s) belonging to this comp and (via its first capture group) yields
// the per-class name. Each of the three entry points fetches + parses the
// page independently via loadCompetition() — no cross-method memoisation,
// matching the SGP fetch-per-method approach.
//
// RST has no live tracker feed, so there is no fetchTrackers (the scheduler
// logs `trackers:no-adapter` and no-ops). RST refetches on the framework's
// default SoaringSpot-scrape cadence — it deliberately does NOT set the
// tight activeTasksCadenceMs SGP uses.
//
// Notable RST-specific behaviour preserved verbatim from the legacy daemon
// (RST is the authoritative scorer for these club comps, unlike the
// SoaringSpot scrape which defers scoring to the OGN engine):
//   - per-pilot day points / rank come straight off the RST results table
//     (daypoints/dayrank), not a downstream recompute;
//   - RST publishes start/finish times in UTC, so they are converted to
//     competition-local time (+tzoffset) before being stored in
//     pilotresult.start/finish (which hold local time-of-day);
//   - task turnpoint geometry is carried over unchanged (a line is encoded
//     as a sector with a1=90; RST sectors carry a1=0) — see loadCompetition.
//
// IGC download (processIGC / checkForOGNMatches) is intentionally NOT ported
// — it is disabled in the sibling soaringspotscrape adapter too; RST tracker
// association relies on OGN findtrackers/matchtrackers instead.
//

import * as htmlparser from 'htmlparser2';
import {Tabletojson} from 'tabletojson';
import {findOne, findAll, getChildren, getOuterHTML, removeElement, textContent} from 'domutils';
import escape from 'sql-template-strings';

import {makeClassId} from '../../classid';
import {toDateCode} from '../../datecode';
import {localDatecode} from '../shared/timezone';
import {upsertClass, syncClassHandicapFlag} from '../shared/classes';
import {PilotFetchAccumulator, upsertPilot, pruneUnseenPilots, correctHandicap, type PilotRecord} from '../shared/pilots';
import {upsertTaskAndLegs} from '../shared/tasks';

import type {ClassId, CompNo, FetchPilotsOptions, FetchPilotsResult, FetchResultsOptions, FetchResultsResult, ScoringSource, SkipDayPredicate, SourceCtx} from '../source';

// A request that takes longer than this is far more useful as a
// timeout-with-error than as a heartbeat-blocking await (mirrors SGP).
const RST_FETCH_TIMEOUT_MS = 30_000;

const RST_MAIN_WEBSITE = 'http://www.rst-online.se/RSTmain.php?main=excup&cmd=list&excup=list&sub=EX';

function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

// Parse an RST DMS coordinate string ("N57:12:34" / "E018:03:00") into
// signed decimal degrees. Lifted verbatim from bin/rst.ts:toDeg().
function dmsToDeg(a: string | undefined | null): number | undefined {
    const s = String(a ?? '');
    const lt = s.match(/([NS])([0-9]{2}):([0-9]{2}):([0-9]{2})/);
    if (lt) {
        return (lt[1] == 'S' ? -1 : 1) * (parseInt(lt[2]) + parseInt(lt[3]) / 60 + parseInt(lt[4]) / 3600);
    }
    const lg = s.match(/([EW])([0-9]{2,3}):([0-9]{2}):([0-9]{2})/);
    if (lg) {
        return (lg[1] == 'W' ? -1 : 1) * (parseInt(lg[2]) + parseInt(lg[3]) / 60 + parseInt(lg[4]) / 3600);
    }
    return undefined;
}

// "HH:MM" / "H:MM" / "HH:MM:SS" → whole seconds (for AAT minimum time).
function hhmmToSeconds(v: string | undefined | null): number {
    const p = String(v ?? '').match(/([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?/);
    if (!p) return 0;
    return parseInt(p[1]) * 3600 + parseInt(p[2]) * 60 + (p[3] ? parseInt(p[3]) : 0);
}

//
// Parsed shapes returned by loadCompetition. RST-specific — the adapter
// methods convert these into the shared helpers' inputs.
//
interface RstPilot {
    compno: CompNo;
    greg: string;
    fullName: string;
    club: string | null;
    glider: string | null;
    handicap: number;
}

interface RstDay {
    dayNumber: number;
    dayInfo: any[]; // day_info table rows (distance / minimum time)
    taskInfo: any[]; // turnpoint table rows
    results: any[]; // per-pilot results table rows
}

interface RstClass {
    classid: ClassId;
    className: string;
    pilots: RstPilot[];
    days: RstDay[];
}

interface RstCompetition {
    info: any[] | null; // the "Info" section's first table's rows
    classes: RstClass[];
}

//
// Fetch and parse the whole RST page for this competition. Returns the
// matched panels (one RstClass per panel whose heading matches
// contest_name) plus the comp-level Info rows. Called fresh by each entry
// point.
//
async function loadCompetition(ctx: SourceCtx): Promise<RstCompetition> {
    const contestName: string = ctx.raw?.contest_name ?? '';
    if (!contestName) {
        ctx.log(`no contest_name configured on the scoringsource row — cannot select a panel; skipping`);
        return {info: null, classes: []};
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RST_FETCH_TIMEOUT_MS);
    let body: string;
    try {
        const res = await fetch(ctx.url, {signal: ac.signal});
        if (!res.ok) {
            ctx.log(`RST fetch ${ctx.url} → ${res.status} ${res.statusText}`);
            return {info: null, classes: []};
        }
        // RST pages are latin1-encoded — decode explicitly rather than
        // letting res.text() assume UTF-8 (which mangles å/ä/ö).
        body = Buffer.from(await res.arrayBuffer()).toString('latin1');
    } catch (e) {
        if ((e as any)?.name === 'AbortError') {
            ctx.log(`RST fetch timed out after ${RST_FETCH_TIMEOUT_MS} ms for ${ctx.compid} (${ctx.url})`);
        } else {
            ctx.log(`RST fetch failed for ${ctx.compid}:`, e);
        }
        return {info: null, classes: []};
    } finally {
        clearTimeout(timer);
    }

    const dom = htmlparser.parseDocument(body);

    // Competition/class tab headings, index-aligned with the panels below.
    const competitionNames: string[] = [];
    const headings = findAll(
        (li: any) => li.name === 'li' && li?.attribs?.class == 'TabbedPanelsTab' && li?.parent?.parent?.attribs?.id == 'TabbedPanelsIHcup',
        findAll((tab: any) => tab.name == 'div' && tab?.attribs?.id == 'TabbedPanelsIHcup', dom.children)
    );
    for (const h of headings) {
        competitionNames.push(textContent(h));
    }

    // Global glider registration → handicap coefficient map (koeff=NNN).
    const hcaps: Record<string, number> = {};
    const gliders = findOne((li: any) => li.attribs?.id == 'id_idglider_fk', dom.children);
    if (gliders) {
        for (const g of getChildren(gliders)) {
            const m = textContent(g).match(/^([A-Z0-9]+[ -][A-Z0-9]+)\s.*koeff=([0-9]+)/);
            if (m) {
                hcaps[m[1]] = parseInt(m[2]);
            }
        }
    }

    const panels = findAll((test: any) => test.name == 'div' && !!test?.attribs?.id?.match(/TabbedPanelsIHcup[0-9]+/), dom.children);
    ctx.log(`RST: ${panels.length} competition(s) on page; matching against contest_name=/${contestName}/i`);

    const contestRe = new RegExp(contestName, 'i');
    const classes: RstClass[] = [];
    let info: any[] | null = null;

    let panelIndex = 0;
    for (const panel of panels) {
        const heading = competitionNames[panelIndex] ?? '';
        panelIndex++;

        const identity = heading.match(contestRe);
        if (!identity) {
            continue;
        }
        const className = identity[1] || contestName;
        const classid = makeClassId(ctx.compid, className) as ClassId;

        // Strip the nested <select> widgets so Tabletojson doesn't choke.
        for (const sel of findAll((test: any) => test.name == 'select', panel.children)) {
            removeElement(sel);
        }

        const sectionHeaders = findAll((test: any) => test.name == 'li' && test.attribs?.class == 'TabbedPanelsTab', panel.children);
        const sections = findAll((test: any) => test.name == 'div' && test.attribs?.class == 'TabbedPanelsContent', panel.children);

        const mapped: Record<string, any[]> = {};
        for (let i = 0; i < sectionHeaders.length; i++) {
            const sh = textContent(sectionHeaders[i]);
            mapped[sh] = Tabletojson.convert(getOuterHTML(sections[i]), {stripHtmlFromCells: true});
        }

        if (!info && mapped['Info']) {
            info = mapped['Info'][0] ?? null;
        }

        // Pilots — parse Reg into greg + compno and resolve the handicap.
        const pilots: RstPilot[] = [];
        const pilotRows: any[] = mapped['Piloter']?.[0] ?? [];
        for (const pilot of pilotRows) {
            if (!pilot.Reg || pilot.Reg == '') {
                ctx.log(`RST ${className}: skipping pilot with no registration`, pilot.Pilot ?? '');
                continue;
            }
            let regsplit = pilot.Reg.match(/^([A-Z0-9]+[- ][A-Z0-9]+)\s+([A-Z0-9]+)$/);
            if (!regsplit) {
                regsplit = pilot.Reg.match(/^([A-Z0-9]+)[- ]([A-Z0-9]+)$/);
                if (!regsplit) {
                    ctx.log(`RST ${className}: can't match registration "${pilot.Reg}"`);
                    continue;
                }
                regsplit[1] = regsplit[1] + '-' + regsplit[2];
            }
            const greg = regsplit[1];
            const compno = regsplit[2] as CompNo;
            pilots.push({
                compno,
                greg,
                fullName: pilot.Pilot,
                club: pilot.Klubb ?? null,
                glider: pilot.Segelflygplan ?? null,
                handicap: correctHandicap(hcaps[greg])
            });
        }

        // Days — sections named "Dag N"; each holds day_info / task_info /
        // results tables (in that order).
        const days: RstDay[] = [];
        for (const key of Object.keys(mapped)) {
            const m = key.match(/Dag ([0-9]+)$/i);
            if (!m) {
                continue;
            }
            const dayData = mapped[key];
            days.push({
                dayNumber: parseInt(m[1]),
                dayInfo: dayData[0] ?? [],
                taskInfo: dayData[1] ?? [],
                results: dayData[2] ?? []
            });
        }

        classes.push({classid, className, pilots, days});
    }

    return {info, classes};
}

//
// updateContest — competition-row upsert. Inlined (there is no shared
// competition-metadata helper) and mirrors the legacy bin/rst.ts
// update_contest, minus the location/elevation and dead deep-reset blocks.
// RST is Swedish: tz/countrycode are fixed rather than geocoded.
//
async function updateContest(db: any, log: (msg: string, ...args: unknown[]) => void, compid: string, contestName: string, info: any[] | null): Promise<void> {
    const count = await db.query(escape`SELECT COUNT(*) cnt FROM competition WHERE compid = ${compid}`);
    if (!count || !count[0] || !count[0].cnt) {
        log(`Empty competition for compid=${compid}, pre-populating`);
        await db.query(escape`
            INSERT IGNORE INTO competition (compid, tz, tzoffset, mainwebsite)
            VALUES (${compid}, 'Europe/Stockholm', 7200, ${RST_MAIN_WEBSITE})
        `);
    }

    if (!info) {
        return;
    }

    // The date range lives in the Info table's "Max antal deltagare" cell
    // as "YYYY-MM-DD till YYYY-MM-DD".
    for (const i of info) {
        const v = i['Max antal deltagare'];
        const matches = String(v ?? '').match(/([0-9]{4}-[0-9]{2}-[0-9]{2}) till ([0-9]{4}-[0-9]{2}-[0-9]{2})/);
        if (matches) {
            await db.query(escape`
                UPDATE competition
                SET
                    start = ${matches[1]},
                    END = ${matches[2]},
                    countrycode = 'SE',
                    name = ${contestName.substring(0, 59)}
                WHERE compid = ${compid}
            `);
        }
    }
}

//
// processDayResults — port of bin/rst.ts process_class_results, minus the
// IGC download. Writes scored pilotresult rows for one (class, day). RST
// publishes actual speed/distance and its own day points/rank; handicapped
// speed/distance are derived (actual / (handicap/100)). Times are UTC and
// converted to local before storage.
//
async function processDayResults(ctx: SourceCtx, classid: ClassId, className: string, date: string, results: any[], handicapByCompno: Map<string, number>): Promise<void> {
    const {db, log, compid} = ctx;
    if (!results || results.length === 0) {
        log(`RST ${className}: ${date} - no results`);
        return;
    }
    const dateCode = toDateCode(date);
    let rows = 0;

    // Build an epoch (seconds, UTC) for a "HH:MM:SS" time-of-day on the
    // day's calendar date. Mirrors the legacy cDate().
    const cDate = (d: string | undefined): number => {
        const p = String(d ?? '').match(/([0-9]{2}):([0-9]{2}):([0-9]{2})/);
        if (!p) return 0;
        const x = new Date(date);
        x.setUTCHours(parseInt(p[1]), parseInt(p[2]), parseInt(p[3]), 0);
        return x.getTime() / 1000;
    };

    for (const row of results) {
        if (row.Pos == 'DNF') {
            continue;
        }

        const pilot = String(row.CN ?? '').trim();
        if (!pilot) {
            log(`RST ${date} ${className}: results row with no CN`, row);
            continue;
        }
        const handicap = correctHandicap(handicapByCompno.get(pilot));

        const start = row.Start ? cDate(row.Start) : 0;
        const finish = row.Tid != '' ? cDate(row['Mål']) : 0;
        const duration = finish && start ? finish - start : 0;

        const actuals = parseFloat(row.Hastighet);
        const actuald = parseFloat(row.Distans);

        const scoredvals = {
            as: actuals,
            ad: actuald,
            hs: actuals / (handicap / 100),
            hd: actuald / (handicap / 100)
        };

        const finished = parseFloat(row.Hastighet) > 0;
        const hasFinishTime = (row['Mål'] ?? '') != '';

        if (hasFinishTime || finished) {
            const r = await db.query(escape`
                UPDATE pilotresult
                SET
                    start = TIME(
                        from_unixtime (${start} + (SELECT tzoffset FROM competition WHERE compid = ${compid}))
                    ),
                    finish = TIME(
                        from_unixtime (${finish} + (SELECT tzoffset FROM competition WHERE compid = ${compid}))
                    ),
                    duration = TIME(
                        from_unixtime (${duration})
                    ),
                    scoredstatus = ${finished ? 'F' : 'H'},
                    status = (
                        CASE
                            WHEN ((status = '-' OR status = 'S' OR status = 'G') AND ${finished ? 1 : 0} = 1) THEN 'F'
                            WHEN ((status = '-' OR status = 'S' OR status = 'G') AND ${hasFinishTime ? 1 : 0} = 1) THEN 'H'
                            ELSE status
                        END
                    ),
                    datafromscoring = 'Y',
                    speed = ${scoredvals.as},
                    distance = ${scoredvals.ad},
                    hspeed = ${scoredvals.hs},
                    hdistance = ${scoredvals.hd},
                    daypoints = ${String(row['Poäng'] ?? '').replace(' ', '')},
                    dayrank = ${row.Pos},
                    totalpoints = ${0},
                    totalrank = ${0},
                    penalty = ${0}
                WHERE
                    datecode = ${dateCode}
                    AND compno = ${pilot}
                    AND class = ${classid}
            `);
            rows += r.affectedRows ?? 0;
        }
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
// RstSource — implementation of `ScoringSource` for the RST-Online scraper.
//
export class RstSource implements ScoringSource {
    readonly type = 'rst';

    async ensureMetadata(ctx: SourceCtx): Promise<void> {
        try {
            const {info} = await loadCompetition(ctx);
            await updateContest(ctx.db, ctx.log, ctx.compid, ctx.raw?.contest_name ?? '', info);
        } catch (e) {
            ctx.log(`ensureMetadata failed for ${ctx.compid}:`, e);
        }
    }

    async fetchPilots(ctx: SourceCtx, options?: FetchPilotsOptions): Promise<FetchPilotsResult> {
        const accumulator = new PilotFetchAccumulator();
        const synthetic = {n: 0};
        const todayDatecode = localDatecode(ctx.tz);

        try {
            const {classes} = await loadCompetition(ctx);
            for (const cls of classes) {
                await upsertClass(ctx.db, ctx.log, ctx.compid, cls.classid, cls.className, todayDatecode);

                for (const p of cls.pilots) {
                    const record: PilotRecord = {
                        classid: cls.classid,
                        className: cls.className,
                        compno: p.compno,
                        fullName: p.fullName,
                        club: p.club,
                        country: 'SE',
                        glider: p.glider,
                        greg: p.greg,
                        handicap: p.handicap
                    };
                    await upsertPilot(ctx.db, ctx.log, record, accumulator, synthetic);
                }
            }

            if (!options?.skipPrune) {
                await pruneUnseenPilots(ctx.db, ctx.log, accumulator);
                for (const classid of accumulator.observed.keys()) {
                    await syncClassHandicapFlag(ctx.db, ctx.log, classid);
                }
            }
        } catch (e) {
            ctx.log(`fetchPilots failed for ${ctx.compid}:`, e);
        }

        return {observed: accumulator.observed};
    }

    async fetchResultsAndTasks(ctx: SourceCtx, skipDay: SkipDayPredicate, options?: FetchResultsOptions): Promise<FetchResultsResult> {
        const tasksOnly = options?.tasksOnly === true;
        const resultsOnly = options?.resultsOnly === true;
        const forceResults = options?.forceResults === true;
        const acceptYesterday = options?.acceptYesterday === true;
        const observedClasses = new Set<ClassId>();
        const todayDatecode = localDatecode(ctx.tz);
        const yesterdayDatecode = acceptYesterday ? localDatecode(ctx.tz, Date.now() - 24 * 60 * 60 * 1000) : null;

        try {
            const {classes} = await loadCompetition(ctx);

            for (const cls of classes) {
                observedClasses.add(cls.classid);
                await upsertClass(ctx.db, ctx.log, ctx.compid, cls.classid, cls.className, todayDatecode);

                // Handicap lookup for the results path (compno → handicap),
                // built from the same page's pilot table.
                const handicapByCompno = new Map<string, number>();
                for (const p of cls.pilots) {
                    handicapByCompno.set(p.compno, p.handicap);
                }

                for (const day of cls.days) {
                    // Calendar date = competition.start + (dayNumber-1) days.
                    const dateRow = await ctx.db.query(escape`
                        SELECT DATE_FORMAT(DATE_ADD(start, INTERVAL ${day.dayNumber - 1} DAY), '%Y-%m-%d') date
                        FROM competition
                        WHERE compid = ${ctx.compid}
                    `);
                    const date: string | null = dateRow?.[0]?.date ?? null;
                    if (!date) {
                        ctx.log(`RST ${cls.className}: Dag ${day.dayNumber} - competition.start not set yet; skipping`);
                        continue;
                    }
                    const dateCode = toDateCode(date);

                    if (skipDay(cls.classid, dateCode, date)) {
                        ctx.log(`RST: skipping old day ${date} for class ${cls.classid}`);
                        continue;
                    }

                    // Only today (or yesterday, when the scheduler set
                    // acceptYesterday) is worth touching on the daemon
                    // cadence. forceResults (CLI one-shot / refetch)
                    // bypasses the gate so past days can be reimported.
                    const isToday = dateCode === todayDatecode;
                    const isYesterdayWindow = yesterdayDatecode != null && dateCode === yesterdayDatecode;
                    if (!forceResults && !isToday && !isYesterdayWindow) {
                        continue;
                    }

                    // Task install (skipped on a results-only tick).
                    if (!resultsOnly) {
                        const dayObject = buildDayObject(date, day);
                        if (dayObject) {
                            await upsertTaskAndLegs(ctx.db, ctx.log, cls.classid, cls.className, dayObject);
                        }
                    }

                    // Results (skipped on a tasks-only tick).
                    if (!tasksOnly) {
                        await processDayResults(ctx, cls.classid, cls.className, date, day.results, handicapByCompno);
                    }
                }
            }
        } catch (e) {
            ctx.log(`fetchResultsAndTasks failed for ${ctx.compid}:`, e);
        }

        return {observedClasses};
    }
}

//
// buildDayObject — reshape an RST parsed day into the `day` object
// upsertTaskAndLegs consumes (the same shape SoaringSpot/SGP produce).
// Returns null when there are no turnpoints (the helper needs >=2 anyway).
//
// task_distance is fed in METRES (RST publishes km); the helper divides by
// 1000 for contestday.length. task_points lat/lng are in RADIANS (the
// helper round-trips via its own toDeg for storage + leg geometry).
//
// Turnpoint geometry is preserved from the legacy daemon exactly: every
// point is emitted as oz_line=false (so taskleg.type='sector'), with a
// "line" turnpoint distinguished by oz_angle1=90° (the helper stores a1=90)
// and a plain sector carrying a1=0. oz_radius1 is RST's Radie (km) scaled
// to metres so the helper's /1000 recovers the original km value.
//
function buildDayObject(date: string, day: RstDay): any | null {
    if (!day.taskInfo || day.taskInfo.length === 0) {
        return null;
    }

    const dayInfo = day.dayInfo ?? [];
    let taskType = 'racing';
    let taskDurationSec = 0;
    // task_distance (km) — dayInfo[0] carries either a straight Distans or,
    // for an AAT, a Minimitid (minimum distance); dayInfo[1].Minimitid is
    // the AAT minimum time.
    const taskDistanceKm = parseFloat(dayInfo[0]?.Minimitid || dayInfo[0]?.Distans || '0') || 0;
    if (dayInfo[1]?.Minimitid) {
        taskType = 'assigned_area';
        taskDurationSec = hhmmToSeconds(dayInfo[1].Minimitid);
    }

    const taskPoints = day.taskInfo.map((tp: any, i: number) => {
        const isLine = tp.Typ == 'Line';
        return {
            point_index: i,
            multiple_start: 0,
            name: tp.Brytpunkt,
            latitude: toRad(dmsToDeg(tp.Latitud) ?? 0),
            longitude: toRad(dmsToDeg(tp.Longitud) ?? 0),
            oz_line: false,
            oz_type: i === 0 ? 'next' : 'symmetric',
            oz_radius1: (parseFloat(tp.Radie) || 0) * 1000,
            oz_angle1: isLine ? toRad(90) : 0,
            oz_radius2: 0,
            oz_angle2: 0,
            oz_angle12: 0
        };
    });

    return {
        task_date: date,
        task_type: taskType,
        task_number: day.dayNumber,
        task_distance: taskDistanceKm * 1000,
        task_duration: taskDurationSec,
        no_start: '',
        result_status: '',
        notes: '',
        task_points: taskPoints
    };
}
