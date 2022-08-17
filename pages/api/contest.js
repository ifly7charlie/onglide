import {query, mysqlEnd} from '../../lib/react/db';
import escape from 'sql-template-strings';

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
        console.log(competition.error);
        return;
    }

    const classes = await query(
        process.env.REPLAY
            ? escape`
         SELECT c.class, c.classname, c.description, todcode(from_unixtime(${process.env.REPLAY})) datecode, cs.status, handicapped
           FROM classes c, compstatus cs where c.class=cs.class ORDER BY c.class`
            : escape`
         SELECT c.class, c.classname, c.description, cs.datecode, cs.status, handicapped
           FROM classes c, compstatus cs where c.class=cs.class ORDER BY c.class`
    );

    // How long should it be cached - 5 minutes is ok
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
    // And we succeeded - here is the json
    res.status(200).json({competition: competition[0], classes: classes});

    // Done
    mysqlEnd();
}
