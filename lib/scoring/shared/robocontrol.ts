// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// robocontrol — a competition's ground-control system publishes a small
// JSON feed mapping each competition number (CN) to its current FLARM
// id(s). Onglide polls it as a side-channel to keep the `tracker` table
// fresh between pilot scrapes.
//
// It is deliberately NOT a ScoringSource: it carries no pilots, tasks or
// results, so the scoring scheduler's cadence (local-time gates, task
// states) is meaningless for it. It is driven on a plain timer by the
// entry binaries instead — but, like every other scoring-source row, it
// is keyed per competition: each `scoringsource` row of type
// 'robocontrol' names the compid it feeds. The feed itself only carries
// a CN, and a CN is unique within a competition, so the class is
// resolved via compid + compno before the (class, compno)-scoped
// tracker update.
//

import escape from 'sql-template-strings';

import {updateTracker} from './trackers';

type Log = (msg: string, ...args: unknown[]) => void;

//
// fetchRobocontrol — poll every configured robocontrol feed and apply
// the tracker ids it reports. One feed per `scoringsource` row of type
// 'robocontrol'; an env override (ROBOCONTROL_URL + COMP_ID) is
// supported for dev/testing.
//
export async function fetchRobocontrol(db: any, log: Log): Promise<void> {
    let sources: {compid: string; url: string}[] = [];
    if (process.env.ROBOCONTROL_URL) {
        sources = [{compid: process.env.COMP_ID ?? '', url: process.env.ROBOCONTROL_URL}];
    } else {
        try {
            const rows = (await db.query(escape`
                SELECT
                    compid,
                    url
                FROM
                    scoringsource
                WHERE
                    type = 'robocontrol'
            `)) as {compid: string; url: string}[];
            sources = (rows ?? []).filter((r) => r.url);
        } catch (e) {
            log('robocontrol: scoringsource read failed:', e);
            return;
        }
    }

    for (const source of sources) {
        if (!source.compid) {
            log(`robocontrol: skipping ${source.url} — no compid (set COMP_ID for env mode)`);
            continue;
        }
        try {
            await fetchRobocontrolOne(db, log, source.compid, source.url);
        } catch (e) {
            log(`robocontrol: failed for compid=${source.compid}:`, e);
        }
    }
}

export async function fetchRobocontrolOne(db: any, log: Log, compid: string, url: string): Promise<void> {
    log(`robocontrol: polling ${url} for compid=${compid}`);

    const res = await fetch(url);
    if (res.status != 200) {
        log(`robocontrol: ${url} returned ${res.status}`);
        return;
    }

    const data: any = await res.json();
    const entries: any[] = Array.isArray(data) ? data : data?.message ?? [];

    for (const p of entries) {
        if (!p?.flarm?.length) continue;
        // The feed only carries a CN, not a class. A pilot is unique
        // within a competition, so resolve the class via compid + compno.
        const classid = await classIdForCompno(db, compid, p.cn);
        if (!classid) {
            log(`robocontrol: no pilot "${p.cn}" in compid=${compid}, skipping`);
            continue;
        }
        await updateTracker(db, log, classid, p.cn, p.flarm.join(','), 'robocontrol');
    }
}

//
// classIdForCompno — resolve a competition number to its globally-unique
// classid within one competition. Returns null when the pilot isn't
// registered for that competition.
//
async function classIdForCompno(db: any, compid: string, compno: string): Promise<string | null> {
    if (!compid || !compno) return null;
    try {
        const row = (
            await db.query(escape`
                SELECT
                    p.class
                FROM
                    pilots p
                    JOIN classes c ON c.class = p.class
                WHERE
                    c.compid = ${compid}
                    AND p.compno = ${compno}
                LIMIT
                    1
            `)
        )?.[0];
        return row?.class ?? null;
    } catch {
        return null;
    }
}
