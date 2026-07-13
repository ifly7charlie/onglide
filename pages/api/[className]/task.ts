import {query, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

import {toDateCode, fromDateCode, competitionStartTs} from '../../../lib/datecode';
import {assembleTask, TaskDetailsRow} from '../../../lib/flightprocessing/taskhelper';
import type {TaskLegsTableRow} from '../../../lib/types';
import type {API_ClassName_Task} from '../../../lib/rest-api-types';

// Serve the current comp-day task for a class as raw pre-calculateTask JSON —
// the IGC viewer loads it with /viewer?className=<class> and scores uploaded
// files against it instead of their declared tasks.
export default async function taskHandler(req, res) {
    const {
        query: {className}
    } = req;

    if (!className) {
        console.log('api/task no class', className);
        res.status(404).end();
        return;
    }

    const classrow = await query(escape`
        SELECT
            comp.tzoffset
        FROM
            classes c,
            competition comp
        WHERE
            c.class = ${className}
            AND comp.compid = c.compid
    `);

    if (classrow?.error) {
        console.log(`api/task: class lookup failed for ${className}:`, classrow.error);
        res.status(500).end();
        return;
    }
    if (!classrow?.length) {
        console.log(`api/task: unknown class ${className}`);
        res.status(404).end();
        return;
    }

    // Same "current comp day" the OGN daemon uses for its channels — the most
    // recent 10:00 local flip (getDCode in bin/ogn.ts)
    const datecode = toDateCode(new Date(competitionStartTs(classrow[0].tzoffset) * 1000));

    // This SQL is mirrored from getTask in bin/ogn.ts (updateTasks) — keep them in step
    const taskdetailsResult = await query(escape`
        SELECT
            tasks.*,
            time_to_sec (tasks.duration) durationsecs,
            c.grandprixstart,
            c.handicapped,
            c.Dm,
            c.classname,
            cd.calendardate,
            cd.status,
            cd.info,
            0 AS distance,
            CASE
                WHEN COALESCE(nostart, '00:00:00') = '00:00:00' THEN 0
                ELSE UNIX_TIMESTAMP (
                    CONCAT(${fromDateCode(datecode)}, ' ', nostart)
                ) - comp.tzoffset
            END nostartutc
        FROM
            tasks,
            classes c,
            contestday cd,
            competition comp
        WHERE
            tasks.datecode = ${datecode}
            AND tasks.class = c.class
            AND cd.class = c.class
            AND cd.datecode = ${datecode}
            AND tasks.class = ${className}
            AND tasks.flown = 'Y'
            AND comp.compid = c.compid
    `);

    if (taskdetailsResult?.error) {
        console.log(`api/task: task lookup failed for ${className}/${datecode}:`, taskdetailsResult.error);
        res.status(500).end();
        return;
    }

    const taskdetails: TaskDetailsRow = taskdetailsResult?.[0];
    if (!taskdetails || !taskdetails.type) {
        console.log(`api/task: ${className}/${datecode}: no active task`);
        res.setHeader('Cache-Control', 'max-age=30');
        res.status(204).end();
        return;
    }

    const tasklegs = await query(escape`
        SELECT
            taskleg.*,
            nname name
        FROM
            taskleg
        WHERE
            taskleg.taskid = ${taskdetails.taskid}
        ORDER BY
            legno
    `);

    if (tasklegs?.error) {
        console.log(`api/task: taskleg lookup failed for ${className}/${datecode} task ${taskdetails.taskid}:`, tasklegs.error);
        res.status(500).end();
        return;
    }
    if (!tasklegs || tasklegs.length < 2) {
        console.log(`api/task: ${className}: task ${taskdetails.taskid} is invalid - too few turnpoints`);
        res.setHeader('Cache-Control', 'max-age=30');
        res.status(204).end();
        return;
    }

    // Highest handicap in the class — mirrors the daemon's in-memory max over gliders
    const maxHandicapRow = await query(escape`
        SELECT
            COALESCE(MAX(handicap), 100) maxHandicap
        FROM
            pilots
        WHERE
            class = ${className}
    `);

    if (maxHandicapRow?.error) {
        console.log(`api/task: maxHandicap lookup failed for ${className}:`, maxHandicapRow.error);
        res.status(500).end();
        return;
    }

    // Tasks change at briefing so don't cache for long
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');

    const response: API_ClassName_Task = {task: assembleTask(taskdetails, tasklegs as TaskLegsTableRow[], maxHandicapRow[0].maxHandicap)};
    res.status(200).json(response);
    mysqlEnd();
}
