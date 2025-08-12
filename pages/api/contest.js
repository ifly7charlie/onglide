import {query, mysqlEnd} from '../../lib/react/db';
import escape from 'sql-template-strings';
import {getNow} from '../../lib/now';
import {toDateCode} from '../../lib/datecode';

export default async function competitionHandler(req, res) {
    const competition = await query(escape`
        SELECT
            name,
            DATE_FORMAT (start, "%M %D") start,
            DATE_FORMAT (END, "%M %D") END,
            sitename club,
            tzoffset,
            mainwebsite,
            lt,
            lg
        FROM
            competition
    `);

    if (!competition[0]) {
        res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
        res.status(404).end();
        console.log('unable to access competition in db');
        return;
    }

    const tzoffset = competition[0].tzoffset;
    const now = new Date(getNow() * 1000);
    const nowLocalMs = now.getTime() + tzoffset * 1000;

    const local10am = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        10,
        0,
        0,
        0 // 10:00:00.000 local time
    );
    if (nowLocalMs < local10am.getTime()) {
        local10am.setDate(local10am.getDate() - 1);
    }
    const utcTime = local10am.getTime() - tzoffset * 1000;
    const datecode = toDateCode(new Date(utcTime));

    const classes = await query(escape`
        SELECT
            c.class,
            c.classname,
            c.description,
            ${datecode} datecode,
            cs.status,
            handicapped,
            notes
        FROM
            classes c,
            compstatus cs
        WHERE
            c.class = cs.class
        ORDER BY
            c.class
    `);

    // How long should it be cached - 5 minutes is ok
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
    // And we succeeded - here is the json
    res.status(200).json({competition: competition[0], classes: classes});

    // Done
    mysqlEnd();
}
