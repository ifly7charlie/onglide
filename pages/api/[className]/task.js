import {query, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

import {calculateTaskLength} from '../../../lib/flightprocessing/taskhelper';

export default async function taskHandler(req, res) {
    const {
        query: {className}
    } = req;

    if (!className) {
        console.log('no class');
        res.status(404).json({error: 'missing parameter(s)'});
        return;
    }

    const contestday = await query(escape`
         SELECT contestday.*, DATE_FORMAT( contestday.calendardate, "%a %D %M" ) displaydate
          FROM contestday, compstatus cs
          WHERE (((${process.env.REPLAY || ''}) = '' AND contestday.datecode= cs.datecode) OR (${process.env.REPLAY || ''} != '' AND contestday.datecode=todcode(from_unixtime(${process.env.REPLAY}))))
            AND cs.class = contestday.class and contestday.class= ${className}
          LIMIT 1
    `);

    if (!contestday || !contestday.length) {
        console.log('task.js: date not yet started', className, contestday);
        res.setHeader('Cache-Control', 's-maxage=300');
        res.status(204).end();
        mysqlEnd();
        return;
    }

    const datecode = contestday[0].datecode;

    const taskdetails = await query(escape`
         SELECT *, time_to_sec(tasks.duration) durationsecs, 
               CASE WHEN nostart ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(fdcode(${datecode}),' ',nostart))-(SELECT tzoffset FROM competition)
               END utcstartutc
          FROM tasks
          WHERE tasks.datecode= ${datecode} and tasks.class= ${className} and tasks.flown='Y'
    `);

    if (!taskdetails || !taskdetails.length) {
        console.log('/api/task.js: no active task');
        res.setHeader('Cache-Control', 's-maxage=60');
        res.status(204).end();
        mysqlEnd();
        return;
    }

    const taskid = taskdetails[0].taskid;

    const tasklegs = await query(escape`
      SELECT taskleg.*, nname name
      FROM taskleg
      WHERE taskleg.taskid = ${taskid}
      ORDER BY legno
    `);

    // We correct task leg length as our calculations are more accurate
    taskdetails[0].distance = calculateTaskLength(tasklegs);
    delete taskdetails[0].hdistance;

    const classes = await query(escape`
     SELECT *
          FROM classes
          WHERE classes.class= ${className}
    `);

    // How long should it be cached - 60 seconds is good
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');

    // And we succeeded - here is the json
    res.status(200).json({legs: tasklegs, task: taskdetails[0], classes: classes[0], rules: '', contestday: contestday[0]});

    // Done
    mysqlEnd();
}
