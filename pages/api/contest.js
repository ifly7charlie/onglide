import {query} from '../../lib/react/db';
import escape from 'sql-template-strings';

export default async function competitionHandler(req, res) {
    const competition = await query(escape`
         SELECT name, 
                DATE_FORMAT( start, "%M %D" ) start, DATE_FORMAT( end, "%M %D" ) end, 
                sitename club,
                tzoffset,
                mainwebsite,
                lt, lg
           FROM competition`);

    if (!competition[0]) {
        console.log(competition.error);
    }

    const classes = await query(escape`
         SELECT c.class, c.classname, c.description, cs.datecode, cs.status
           FROM classes c, compstatus cs where c.class=cs.class ORDER BY c.class`);

    // How long should it be cached - 5 minutes is ok
    res.setHeader('Cache-Control', 'max-age=300');

    // And we succeeded - here is the json
    res.status(200).json({competition: competition[0], classes: classes});
}
