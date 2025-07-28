import {query, mysqlEnd} from '../../lib/react/db';
import escape from 'sql-template-strings';
import {replay, getReplayDatecode} from '../../lib/now';

export default async function competitionHandler(req, res) {
    const competition = await query(
        escape`
         SELECT name, 
                DATE_FORMAT( start, "%M %D" ) start, DATE_FORMAT( end, "%M %D" ) end, 
                sitename club,
                tzoffset,
                mainwebsite,
                lt, lg
           FROM competition`
    );

    if (!competition[0]) {
        res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
        res.status(404).end();
        console.log('unable to access competition in db');
        return;
    }

    let datecode = undefined;
    if (!getReplayDatecode()) {
        datecode = (await query(escape`SELECT MAX(datecode) as datecode FROM compstatus LIMIT 1`))?.[0]?.datecode;
    } else {
        datecode = getReplayDatecode();
    }

    const classes = await query(
        replay()
            ? escape`
         SELECT c.class, c.classname, c.description, ${getReplayDatecode()} datecode, cs.status, handicapped, notes
           FROM classes c, compstatus cs where c.class=cs.class ORDER BY c.class`
            : escape`
         SELECT c.class, c.classname, c.description, ${datecode} datecode, cs.status, handicapped, notes
           FROM classes c, compstatus cs where c.class=cs.class ORDER BY c.class`
    );

    // How long should it be cached - 5 minutes is ok
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
    // And we succeeded - here is the json
    res.status(200).json({competition: competition[0], classes: classes});

    // Done
    mysqlEnd();
}
