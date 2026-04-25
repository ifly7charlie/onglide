import {query, mysqlEnd} from '../../lib/react/db';
import escape from 'sql-template-strings';

//
// Returns every competition that should be shown on the globe landing page.
// A competition appears if its last task was within the past 24 hours, OR if
// the competition's end date is in the future (upcoming/in-progress).
//
// For each competition we aggregate its per-class compstatus and derive a
// single `displayStatus` that the globe uses for marker styling:
//
//   started      — at least one class has crossed the start line (status S)
//   before_start — at least one class is launched but none have started (L)
//   landed       — all classes have landed (R/H/O); recently-finished comps
//                  also fall here for the rest of the 24h display window
//   task_set     — window is open today, at least one class has a task set
//                  (status B/P), pre-launch
//   notask       — window is open today, but no class has a task configured
//                  yet (all classes in ':'/'?' or all scrubbed 'Z')
//   upcoming     — competition starts tomorrow or later
//
// We also return per-class info so the list panel can show a dot per class
// when classes have diverged (e.g. Open flying, 15m still briefing).
//
export type ClassDisplayStatus = 'task_set' | 'before_start' | 'started' | 'landed' | 'notask' | 'upcoming';

type ClassRow = {
    class: string;
    classname: string;
    status: string;
    pilotCount: number;
    displayStatus: ClassDisplayStatus;
};

// Derive a per-class displayStatus from its compstatus.status + the
// competition window. Same semantics as the competition-wide rollup, but
// applied to a single class row. `endPast` short-circuits the "upcoming"
// fallback when the competition's end date has already passed — without
// it, a finished comp with a blank class status would keep showing as
// "upcoming" until the scheduler's dead-comp cleanup removes it.
function classDisplayStatus(status: string, inWindow: boolean, endPast: boolean): ClassDisplayStatus {
    if (status === 'S') return 'started';
    if (status === 'L') return 'before_start';
    if (status === 'R' || status === 'H' || status === 'O') return 'landed';
    if (inWindow && (status === 'B' || status === 'P')) return 'task_set';
    if (inWindow) return 'notask';
    if (endPast) return 'landed';
    return 'upcoming';
}

export default async function competitionsHandler(_req, res) {
    // Query returns one row per class so we can build the per-class list.
    // The competition-level aggregation is then done in JS. pilotCount is
    // a per-class COUNT(pilots) subquery — scalar subqueries are cheap for
    // the row counts we're dealing with and keep the top-level GROUP BY
    // simple.
    const rows = await query(escape`
        SELECT
            c.compid,
            c.name,
            c.sitename,
            c.lt,
            c.lg,
            DATE_FORMAT (c.start, '%Y-%m-%d') start,
            DATE_FORMAT (c.end, '%Y-%m-%d') AS endDate,
            c.countrycode,
            c.tz,
            c.tzoffset,
            c.mainwebsite,
            cl.class AS classid,
            cl.classname,
            COALESCE(cs.status, '') AS status,
            (
                SELECT
                    COUNT(*)
                FROM
                    pilots p
                WHERE
                    p.class = cl.class
            ) AS pilotCount,
            (
                SELECT
                    MAX(cd2.calendardate)
                FROM
                    contestday cd2
                WHERE
                    cd2.class = cl.class
                    AND cd2.status = 'Y'
            ) AS lastTaskDate
        FROM
            competition c
            JOIN classes cl ON cl.compid = c.compid
            LEFT JOIN compstatus cs ON cs.class = cl.class
        ORDER BY
            c.start,
            c.compid,
            cl.classname
    `);

    // Compute today's date once so every row compares against the same value.
    // We compare as YYYY-MM-DD strings rather than JS Date objects because
    // the start/end columns are already formatted that way and DST/TZ
    // quirks won't bite us.
    const todayIso = new Date().toISOString().substring(0, 10);
    const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().substring(0, 10);

    // Bucket class rows by compid so we can do per-competition aggregation.
    const byCompid = new Map<string, any>();
    for (const r of rows || []) {
        if (!byCompid.has(r.compid)) {
            byCompid.set(r.compid, {
                compid: r.compid,
                name: r.name,
                sitename: r.sitename,
                lt: r.lt,
                lg: r.lg,
                start: r.start,
                end: r.endDate,
                countrycode: r.countrycode,
                tz: r.tz,
                tzoffset: r.tzoffset,
                mainwebsite: r.mainwebsite,
                classes: [] as ClassRow[],
                maxLastTaskDate: null as string | null
            });
        }
        const comp = byCompid.get(r.compid);
        comp.classes.push({
            class: r.classid,
            classname: r.classname,
            status: r.status,
            pilotCount: Number(r.pilotCount) || 0,
            // displayStatus is filled in below once we know inWindow.
            displayStatus: 'upcoming'
        });
        if (r.lastTaskDate) {
            const d = r.lastTaskDate instanceof Date ? r.lastTaskDate.toISOString().substring(0, 10) : String(r.lastTaskDate).substring(0, 10);
            if (!comp.maxLastTaskDate || d > comp.maxLastTaskDate) {
                comp.maxLastTaskDate = d;
            }
        }
    }

    console.log(JSON.stringify([...byCompid.values()]));

    const competitions1 = Array.from(byCompid.values())
        // Apply the "still interesting enough to show" filter here rather
        // than in HAVING, so the per-class query can stay simple.
        .filter((comp) => {
            if (!comp.maxLastTaskDate && !comp.end) return true;
            if (comp.maxLastTaskDate && comp.maxLastTaskDate >= yesterdayIso) return true;
            if (comp.end && comp.end >= yesterdayIso) return true;
            return false;
        });

    //    console.table(competitions1);

    const competitions = competitions1.map((comp) => {
        const inWindow = comp.start && comp.end && comp.start <= todayIso && todayIso <= comp.end;
        const endPast = !!(comp.end && comp.end < todayIso);

        // Annotate each class with its own displayStatus.
        for (const cls of comp.classes as ClassRow[]) {
            cls.displayStatus = classDisplayStatus(cls.status, inWindow, endPast);
        }
        const classDisplayStatuses = (comp.classes as ClassRow[]).map((c) => c.displayStatus);
        const statuses: string[] = (comp.classes as ClassRow[]).map((c) => c.status).filter(Boolean);

        let displayStatus: ClassDisplayStatus;
        const anyStarted = statuses.some((s) => s === 'S');
        const anyBeforeStart = statuses.some((s) => s === 'L');
        const allDone = statuses.length > 0 && statuses.every((s) => s === 'R' || s === 'H' || s === 'O');
        const anyTaskReady = statuses.some((s) => s === 'B' || s === 'P');

        if (anyStarted) {
            displayStatus = 'started';
        } else if (anyBeforeStart) {
            displayStatus = 'before_start';
        } else if (allDone) {
            displayStatus = 'landed';
        } else if (inWindow && anyTaskReady) {
            displayStatus = 'task_set';
        } else if (inWindow) {
            displayStatus = 'notask';
        } else if (endPast) {
            displayStatus = 'landed';
        } else {
            displayStatus = 'upcoming';
        }

        // Do the classes all agree? If so the list panel can collapse
        // the per-class dots into a single one. Cheap to compute here
        // and saves the client having to do the same comparison.
        const classStatusesDiffer = new Set(classDisplayStatuses).size > 1;

        return {
            compid: comp.compid,
            name: comp.name,
            sitename: comp.sitename,
            lat: comp.lt,
            lng: comp.lg,
            start: comp.start,
            end: comp.end,
            countrycode: comp.countrycode,
            tz: comp.tz,
            tzoffset: comp.tzoffset,
            mainwebsite: comp.mainwebsite,
            classCount: comp.classes.length,
            classes: comp.classes,
            classStatusesDiffer,
            displayStatus
        };
    });

    //    console.log(JSON.stringify(competitions));

    // Refresh every minute so the globe picks up status changes during a flying day
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');
    res.status(200).json({competitions});

    mysqlEnd();
}
