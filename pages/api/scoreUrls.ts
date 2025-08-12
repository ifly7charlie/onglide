import {query, mysqlEnd} from '../../lib/react/db';
import escape from 'sql-template-strings';

import {replay, getNow} from '../../lib/now';

export default async function taskHandler(req, res) {
    const classes = await query(
        replay()
            ? escape`
                  SELECT
                      c.class,
                      c.classname,
                      c.description,
                      todcode (
                          from_unixtime (${getNow()})
                      ) datecode,
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
              `
            : escape`
                  SELECT
                      c.class,
                      c.classname,
                      c.description,
                      cs.datecode,
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
              `
    );

    // Generate the correct URL
    classes.forEach((c) => {
        c.scoresUrl = (process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX?.replace('ws', 'http') ?? '') + process.env.NEXT_PUBLIC_WEBSOCKET_HOST + '/scores/' + `${c.class}${c.datecode}`.toUpperCase() + '.json';
    });

    // How long should it be cached - 5 minutes is ok
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
    // And we succeeded - here is the json
    res.status(200).json(classes);

    // Done
    mysqlEnd();
}
