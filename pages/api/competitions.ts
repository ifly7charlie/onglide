import {query, mysqlEnd} from '../../lib/react/db';
import escape from 'sql-template-strings';
import {classDisplayStatus, type CompetitionDisplayStatus} from '../../lib/react/competition-status';
import {toDateCode} from '../../lib/datecode';

//
// Returns every competition that should be shown on the globe landing page.
// A competition appears only while its end date is today or in the future
// (upcoming or in-progress). Comps whose end has passed are filtered out.
//
// For each competition we aggregate its per-class compstatus and derive a
// single `displayStatus` for the globe markers and the side panel pills.
// Status meanings live in lib/react/competition-status.ts.
//
export type ClassDisplayStatus = CompetitionDisplayStatus;

type ClassRow = {
    class: string;
    classname: string;
    status: string;
    pilotCount: number;
    statusDatecode: string | null;
    displayStatus: ClassDisplayStatus;
};

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
            cs.datecode AS statusDatecode,
            (
                SELECT
                    COUNT(*)
                FROM
                    pilots p
                WHERE
                    p.class = cl.class
            ) AS pilotCount
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
    // compstatus stores its current-day pointer as a 3-char datecode, so
    // we compare against the datecode forms of `todayIso`/`yesterdayIso`
    // to decide whether the row's `status` reflects today's activity, is
    // a one-day-stale leftover (yesterday) we can label nicely, or older
    // than that — in which case the status field is treated as empty.
    const todayDatecode = toDateCode(new Date(todayIso));
    const yesterdayDatecode = toDateCode(new Date(yesterdayIso));

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
                classes: [] as ClassRow[]
            });
        }
        const comp = byCompid.get(r.compid);
        const statusDatecode = r.statusDatecode ? String(r.statusDatecode).toUpperCase() : null;
        comp.classes.push({
            class: r.classid,
            classname: r.classname,
            status: r.status,
            pilotCount: Number(r.pilotCount) || 0,
            statusDatecode,
            // displayStatus is filled in below once we know inWindow.
            displayStatus: 'upcoming'
        });
    }

    const competitions1 = Array.from(byCompid.values())
        // Drop comps whose end date has already passed; they have nothing
        // live to show. Comps with no end date are kept (open-ended).
        .filter((comp) => {
            if (!comp.end) return true;
            return comp.end >= todayIso;
        });

    const competitions = competitions1.map((comp) => {
        const inWindow = comp.start && comp.end && comp.start <= todayIso && todayIso <= comp.end;

        // Annotate each class with its own displayStatus. compstatus.status
        // is sticky — if a class flew days ago and was never updated, the
        // row still says 'L'/'S'/'H'. So only trust the status when its
        // datecode matches today. Anything older is 'notask' (so a missed
        // landing report from two days ago doesn't look like 'racing'),
        // with 'yesterday' as a one-day-stale label.
        for (const cls of comp.classes as ClassRow[]) {
            if (cls.statusDatecode && cls.statusDatecode < todayDatecode) {
                cls.displayStatus = cls.statusDatecode === yesterdayDatecode ? 'yesterday' : 'notask';
            } else {
                cls.displayStatus = classDisplayStatus(cls.status, inWindow);
            }
        }
        const classDisplayStatuses = (comp.classes as ClassRow[]).map((c) => c.displayStatus);
        // Roll-up only counts classes whose compstatus is from today. Stale
        // rows already became 'notask'/'yesterday' above and shouldn't drag
        // the comp marker into 'started' just because nobody updated them.
        const statuses: string[] = (comp.classes as ClassRow[])
            .filter((c) => c.statusDatecode === todayDatecode)
            .map((c) => c.status)
            .filter(Boolean);

        let displayStatus: ClassDisplayStatus;
        const anyFinishing = statuses.some((s) => s === 'F');
        const anyStarted = statuses.some((s) => s === 'S');
        const anyLaunching = statuses.some((s) => s === 'L');
        const allHome = statuses.length > 0 && statuses.every((s) => s === 'H');
        const anyTaskReady = statuses.some((s) => s === 'B' || s === 'P' || s === 'G');

        if (anyFinishing) {
            displayStatus = 'finishing';
        } else if (anyStarted) {
            displayStatus = 'started';
        } else if (anyLaunching) {
            displayStatus = 'launching';
        } else if (allHome) {
            displayStatus = 'home';
        } else if (inWindow && anyTaskReady) {
            displayStatus = 'task_set';
        } else if (inWindow) {
            displayStatus = 'notask';
        } else {
            displayStatus = 'upcoming';
        }

        // If no class has today's data but at least one was on yesterday's,
        // the comp is "still on yesterday". Other classes that didn't fly
        // yesterday keep their own per-class status and don't block the
        // comp-level label.
        if (statuses.length === 0 && (comp.classes as ClassRow[]).some((c) => c.statusDatecode === yesterdayDatecode)) {
            displayStatus = 'yesterday';
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
