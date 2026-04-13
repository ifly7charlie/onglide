// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Class lifecycle helpers — upsert (idempotent on (compid, classid)),
// hard cascade delete, and the observed-vs-DB diff that drives rule 5
// (a class disappearing from the upstream means we delete every row that
// references its classid).
//

import escape from 'sql-template-strings';

import {toDateCode} from '../../datecode';
import type {ClassId} from '../source';

//
// upsertClass — idempotent INSERT … ON DUPLICATE KEY UPDATE for the
// classes row, plus the placeholder compstatus row. Mirrors the inline
// blocks the old ssscrape.ts ran for every parsed class.
//
// `displayName` is the human label (after _ → space conversion); the
// 30-char `classname` column gets truncated.
//
export async function upsertClass(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    compid: string,
    classid: ClassId,
    displayName: string
): Promise<void> {
    try {
        await db.query(escape`
            INSERT INTO
                classes (class, compid, classname, description, type)
            VALUES
                (
                    ${classid},
                    ${compid},
                    ${displayName.substring(0, 29)},
                    ${displayName},
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

        await db.query(escape`
            insert ignore INTO compstatus (class)
            VALUES
                (${classid})
        `);

        // Make sure compstatus has a current datecode so consumers don't
        // get tripped up by a NULL.
        await db.query(escape`
            UPDATE compstatus
            SET
                status = ':',
                datecode = ${toDateCode()}
            WHERE
                class = ${classid}
                AND status IN ('?', ':')
        `);
    } catch (e) {
        log(`upsertClass failed for ${compid}/${classid}:`, e);
    }
}

//
// cascadeDeleteClass — hard delete every row that references this
// classid. Used by both rule 5 (class disappeared from source) and the
// dead-competition cleanup in tasks.ts. Order matters only for tables
// with FK constraints; in this schema there aren't any, but we delete
// children first anyway so an interrupted delete leaves the system in a
// consistent state.
//
export async function cascadeDeleteClass(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    classid: ClassId
): Promise<void> {
    const stmts: [string, string][] = [
        ['pilotresult', 'DELETE FROM pilotresult WHERE class = ?'],
        ['taskleg', 'DELETE FROM taskleg WHERE class = ?'],
        ['tasks', 'DELETE FROM tasks WHERE class = ?'],
        ['contestday', 'DELETE FROM contestday WHERE class = ?'],
        ['images', 'DELETE FROM images WHERE class = ?'],
        ['tracker', 'DELETE FROM tracker WHERE class = ?'],
        ['pilots', 'DELETE FROM pilots WHERE class = ?'],
        ['compstatus', 'DELETE FROM compstatus WHERE class = ?'],
        ['classes', 'DELETE FROM classes WHERE class = ?']
    ];
    for (const [table, sql] of stmts) {
        try {
            await db.query(sql, [classid]);
        } catch (e) {
            log(`cascadeDeleteClass: ${table} failed for ${classid}:`, e);
        }
    }
    log(`cascade-deleted class ${classid}`);
}

//
// diffAndRemoveClasses — read every class currently in DB for this
// competition, subtract the set the upstream just reported, and cascade
// delete the difference. Idempotent and safe to call after every
// fetchResultsAndTasks() call.
//
// `observedClasses` may legitimately be empty if the upstream returned
// nothing parseable — in that case we DO NOT delete anything, since an
// empty observation is far more likely to be a transient HTML/parse
// glitch than the user removing every class at once.
//
export async function diffAndRemoveClasses(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void,
    compid: string,
    observedClasses: Set<ClassId>
): Promise<void> {
    if (observedClasses.size === 0) {
        log(`diffAndRemoveClasses: 0 classes observed for compid=${compid}; skipping prune`);
        return;
    }

    let dbClasses: {class: ClassId}[] = [];
    try {
        dbClasses = (await db.query(escape`
            SELECT class FROM classes WHERE compid = ${compid}
        `)) as {class: ClassId}[];
    } catch (e) {
        log(`diffAndRemoveClasses: read failed for compid=${compid}:`, e);
        return;
    }

    for (const row of dbClasses ?? []) {
        if (!observedClasses.has(row.class)) {
            log(`class ${row.class} no longer reported by source for compid=${compid}; cascade deleting`);
            await cascadeDeleteClass(db, log, row.class);
        }
    }
}
