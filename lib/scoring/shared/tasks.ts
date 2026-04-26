// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Task / taskleg / contestday / pilotresult upsert helpers, plus the
// rule-1 cleanup helpers (`pruneOldDays`, `dropDeadCompetition`). All the
// SQL the source-specific scrapers used to inline lives here so adapters
// can stay focused on parsing.
//

import {createHash} from 'crypto';
import escape from 'sql-template-strings';

import {toDateCode} from '../../datecode';
import {getElevationOffset} from '../../getelevationoffset';
import type {ClassId} from '../source';
import {findTimezoneFromLocation, getTzOffset} from './timezone';
import {cascadeDeleteClass} from './classes';

import {point, Coord} from '@turf/helpers';
import distance from '@turf/distance';
import bearing from '@turf/bearing';

// Soaringspot uses these labels for its sector centring strategy; the
// taskleg.direction enum uses different ones. Lifted from the old
// ssscrape.ts.
const oz_types: Record<string, string> = {
    symmetric: 'symmetrical',
    next: 'np',
    previous: 'pp',
    fixed: 'fixed',
    start: 'sp'
};

function toDeg(a: number): number {
    return (a / Math.PI) * 180;
}

function convertToMysqlTime(jsontime: string | undefined | null): string | null {
    if (!jsontime) return null;
    return jsontime.replace(/^.*T/, '');
}

//
// Hash a parsed task json so we can short-circuit re-inserts when the
// upstream hasn't changed it. Same algorithm the old ssscrape used so
// historical hashes still match.
//
export function hashDayPayload(day: any): string {
    return createHash('sha256').update(JSON.stringify(day)).digest('base64');
}

//
// upsertTaskAndLegs — full transactional task install. Mirrors the old
// `process_day_task()` body verbatim, just parameterised on the parsed
// `day` object so adapters don't need to know about transaction shape.
//
// Returns false if the task hash matched (no work done). Returns true if
// the task was inserted/updated. Throws on hard errors.
//
export async function upsertTaskAndLegs(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    classid: ClassId,
    classname: string,
    day: any
): Promise<boolean> {
    const date: string = day.task_date;
    const dateCode = toDateCode(date);

    let tasktype: 'S' | 'A' = 'S';
    let duration = '00:00';
    if (day.task_type == 'assigned_area') {
        tasktype = 'A';
        duration = new Date(day.task_duration * 1000).toISOString().substring(11, 19);
    }

    // Promote compstatus to 'B' (briefed) unconditionally whenever we see
    // a task for this class — including on re-runs where the hash matches
    // and the transaction below short-circuits. Done as an awaited
    // standalone query (rather than inside the chain) to side-step the
    // flaky transaction-chain commit behaviour. The status NOT IN guard
    // protects airborne/landed classes from being demoted; 'Z' (scrubbed)
    // is intentionally allowed so a new task on a later day overrides a
    // stale scrubbed status from a previous datecode.
    if (day.result_status != 'cancelled') {
        await db.query(escape`
            UPDATE compstatus
            SET status = 'B', datecode = ${dateCode}
            WHERE class = ${classid}
              AND status NOT IN ('L', 'S', 'R', 'H')
        `);
    } else {
        await db.query(escape`
            UPDATE compstatus
            SET status = 'Z', datecode = ${dateCode}
            WHERE class = ${classid}
        `);
    }

    const hash = hashDayPayload(day);
    const dbhashrow = await db.query(escape`
        SELECT
            hash
        FROM
            tasks
        WHERE
            datecode = ${dateCode}
            AND class = ${classid}
    `);

    if (dbhashrow && dbhashrow.length > 0 && hash == dbhashrow[0].hash) {
        log(`${classid} - ${date}: task unchanged`);
        return false;
    }
    log(`${classid} - ${date}: task changed`);

    for (const tp of day.task_points) {
        tp.altitude = await new Promise((resolve) => getElevationOffset(toDeg(tp.latitude), toDeg(tp.longitude), resolve as any));
    }

    const status = day.result_status;
    const script = '';

    await db
        .transaction()
        .query(escape`
            UPDATE compstatus
            SET
                starttime = COALESCE(${convertToMysqlTime(day.no_start)}, starttime)
            WHERE
                datecode = ${dateCode}
                AND class = ${classid}
        `)
        .query(escape`
            DELETE FROM tasks
            WHERE
                datecode = ${dateCode}
                AND class = ${classid}
                AND task = 'B'
        `)
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
        .query((r: any) => {
            const taskid = r.insertId;
            if (!taskid) {
                log(`${classid} - ${date}: unable to insert task!`);
                return null;
            }

            let values: (string | number)[] = [];
            let query = 'INSERT INTO taskleg ( class, datecode, taskid, legno, ' + 'length, bearing, nlat, nlng, Hi, ntrigraph, nname, type, direction, r1, a1, r2, a2, a12, altitude ) ' + 'VALUES ';

            let previousPoint: Coord | null = null;
            let currentPoint: Coord | null = null;

            for (const tp of day.task_points.sort((a: any, b: any) => a.point_index - b.point_index)) {
                if (tp.multiple_start != 0) {
                    continue;
                }

                let tpname: string = tp.name;
                let trigraph = tpname.substring(0, 3);
                if (tpname && ([trigraph] = tpname.match(/^([0-9]{1,4})/) || [trigraph])) {
                    tpname = tpname.replace(/^([0-9]{1,4})/, '').trim();
                }

                previousPoint = currentPoint;
                currentPoint = point([toDeg(tp.longitude), toDeg(tp.latitude)]);

                const leglength = previousPoint ? distance(previousPoint, currentPoint) : 0;
                const bearingDeg = previousPoint ? (bearing(previousPoint, currentPoint) + 360) % 360 : 0;
                const hi = 0;

                query += '( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,? ),';

                values = values.concat([
                    classid,
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
                    tp.oz_line ? 'line' : 'sector',
                    oz_types[tp.oz_type],
                    tp.oz_radius1 / 1000,
                    tp.oz_line ? 90 : toDeg(tp.oz_angle1),
                    tp.oz_radius2 / 1000,
                    // SoaringSpot/SeeYou encode "full inner cylinder" as
                    // oz_angle2 = π/2 (apex 180°); the renderer treats
                    // a2 = 180 as the full-circle marker.
                    toDeg(tp.oz_angle2) >= 90 - 1e-6 ? 180 : toDeg(tp.oz_angle2),
                    tp.oz_type == 'fixed' ? toDeg(tp.oz_angle12) : 0,
                    tp.altitude
                ]);
            }

            query = query.substring(0, query.length - 1);
            return [query, values];
        })
        .query((_r: any, ro: any) => {
            const taskid = ro[ro.length - 2].insertId;
            return ['DELETE FROM tasks WHERE class=? AND taskid != ? AND datecode = ?', [classid, taskid, dateCode]];
        })
        .query((_r: any, ro: any) => {
            const taskid = ro[ro.length - 3].insertId;
            return ['UPDATE tasks SET task="A", flown="Y" WHERE class=? AND taskid = ?', [classid, taskid]];
        })
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
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE tasks SET flown="N" WHERE class=? AND datecode=?', [classid, dateCode]];
            else return null;
        })
        .query(() => {
            if (day.result_status == 'cancelled') return ['UPDATE contestday SET status="N" WHERE class=? AND datecode=?', [classid, dateCode]];
            else return null;
        })
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
                compid = (SELECT compid FROM classes WHERE class = ${classid})
        `)
        .rollback((_e: any) => {
            log(`task transaction rolled back for ${classid} - ${date}`);
        })
        .commit();

    // After the transaction commits, the competition row may have just
    // been backfilled with lt/lg from taskleg. Re-run the IANA tz lookup
    // against those (more accurate) coordinates and refresh tz/tzoffset
    // if needed. Wrapped in try/catch so a tz failure doesn't break the
    // scrape.
    try {
        const compRow = (
            await db.query(escape`
                SELECT compid, lt, lg, tz
                FROM competition
                WHERE compid = (SELECT compid FROM classes WHERE class = ${classid})
            `)
        )?.[0];
        if (compRow?.lt && compRow?.lg) {
            const tz = findTimezoneFromLocation(compRow.lt, compRow.lg);
            if (tz && tz !== compRow.tz) {
                const tzoffset = getTzOffset(tz);
                log(`${classname}: refining tz from ${compRow.tz} -> ${tz} (${tzoffset}s) based on taskleg (${compRow.lt}, ${compRow.lg})`);
                await db.query(escape`
                    UPDATE competition SET tz = ${tz}, tzoffset = ${tzoffset}
                    WHERE compid = ${compRow.compid}
                `);
            }
        }
    } catch (e) {
        log('post-task tz refinement failed:', e);
    }

    log(`${classname}: processed task ${date}`);
    return true;
}

//
// pruneOldDays — rule 1 cleanup. For each class of `compid`, drop the
// per-day rows for any datecode strictly before `todayDatecode`. Called
// at most once per heartbeat; the caller decides whether the
// "10am-or-task-exists" gate has fired. We drop tasks/taskleg/
// pilotresult/contestday for those days but leave classes/compstatus
// intact (those describe the class itself, not a particular day).
//
export async function pruneOldDays(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    compid: string,
    todayDatecode: string
): Promise<void> {
    let classRows: {class: ClassId}[] = [];
    try {
        classRows = (await db.query(escape`
            SELECT class FROM classes WHERE compid = ${compid}
        `)) as {class: ClassId}[];
    } catch (e) {
        log(`pruneOldDays: class lookup failed for compid=${compid}:`, e);
        return;
    }

    for (const row of classRows ?? []) {
        const classid = row.class;
        try {
            // Pull the set of distinct datecodes that have any per-day
            // data for this class. We'll prune anything strictly before
            // today.
            const datecodes = (await db.query(escape`
                SELECT DISTINCT datecode FROM (
                    SELECT datecode FROM tasks WHERE class = ${classid}
                    UNION
                    SELECT datecode FROM taskleg WHERE class = ${classid}
                    UNION
                    SELECT datecode FROM contestday WHERE class = ${classid}
                    UNION
                    SELECT datecode FROM pilotresult WHERE class = ${classid}
                ) d
            `)) as {datecode: string}[];

            for (const d of datecodes ?? []) {
                if (!d.datecode || d.datecode >= todayDatecode) continue;
                // Datecodes are 3 chars and lex-sortable WITHIN a single
                // year/decade, but compare equality is exact and that's
                // all we need for "is this old". A more robust
                // implementation would convert via fromDateCode, but the
                // cadence here is once-per-day so a string compare with
                // the current dc is sufficient.
                await db.query(escape`DELETE FROM taskleg WHERE class = ${classid} AND datecode = ${d.datecode}`);
                await db.query(escape`DELETE FROM tasks WHERE class = ${classid} AND datecode = ${d.datecode}`);
                await db.query(escape`DELETE FROM pilotresult WHERE class = ${classid} AND datecode = ${d.datecode}`);
                await db.query(escape`DELETE FROM contestday WHERE class = ${classid} AND datecode = ${d.datecode}`);
                log(`pruned old day ${d.datecode} from class ${classid}`);
            }
        } catch (e) {
            log(`pruneOldDays: class ${classid} prune failed:`, e);
        }
    }
}

//
// dropDeadCompetition — rule 1 final cleanup. If `competition.end` is
// in the past AND there are no remaining tasks/contestday/pilotresult
// rows for any of its classes, hard-delete the competition (cascade
// every classid + remove the competition + scoringsource rows).
//
// The cascade reuses cascadeDeleteClass so we don't duplicate the table
// list.
//
export async function dropDeadCompetition(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    compid: string
): Promise<boolean> {
    let comp: any;
    try {
        comp = (
            await db.query(escape`
                SELECT compid, end FROM competition WHERE compid = ${compid}
            `)
        )?.[0];
    } catch (e) {
        log(`dropDeadCompetition: read competition failed:`, e);
        return false;
    }
    if (!comp) return false;
    if (!comp.end) return false;
    const endDate = new Date(comp.end);
    if (isNaN(endDate.getTime())) return false;
    // `end` is inclusive — the comp still runs on the end day — so only
    // treat it as over once that full day has passed.
    if (endDate.getTime() + 24 * 60 * 60 * 1000 >= Date.now()) return false;

    // Are there any per-day rows left across all classes? If so, the
    // competition is "in past" but still has results we want to keep.
    let leftover = 0;
    try {
        const r = (
            await db.query(escape`
                SELECT
                    (
                        (SELECT COUNT(*) FROM tasks t JOIN classes c ON c.class = t.class WHERE c.compid = ${compid})
                      + (SELECT COUNT(*) FROM contestday cd JOIN classes c ON c.class = cd.class WHERE c.compid = ${compid})
                      + (SELECT COUNT(*) FROM pilotresult pr JOIN classes c ON c.class = pr.class WHERE c.compid = ${compid})
                    ) AS leftover
            `)
        )?.[0];
        leftover = Number(r?.leftover ?? 0);
    } catch (e) {
        log(`dropDeadCompetition: leftover count failed:`, e);
        return false;
    }
    if (leftover > 0) return false;

    log(`competition ${compid} is past with no per-day rows; cascade deleting`);

    let classRows: {class: ClassId}[] = [];
    try {
        classRows = (await db.query(escape`SELECT class FROM classes WHERE compid = ${compid}`)) as {class: ClassId}[];
    } catch (e) {
        log(`dropDeadCompetition: class enum failed:`, e);
    }
    for (const row of classRows ?? []) {
        await cascadeDeleteClass(db, log, row.class);
    }

    try {
        await db.query(escape`DELETE FROM competition WHERE compid = ${compid}`);
        await db.query(escape`DELETE FROM scoringsource WHERE compid = ${compid}`);
    } catch (e) {
        log(`dropDeadCompetition: top-level delete failed:`, e);
    }
    return true;
}
