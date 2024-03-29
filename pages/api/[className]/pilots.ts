import {query, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

import {keyBy as _keyBy} from 'lodash';

export default async function taskHandler(req, res) {
    const {
        query: {className}
    } = req;

    if (!className) {
        console.log('api/pilots no class');
        res.status(404);
        return;
    }

    // this is the pilot results
    const pilots = await query(escape`
	select pilots.class, pilots.compno, 
	            concat(firstname,' ',lastname) name, gliderType, handicap, country,
          CASE 
            WHEN image != 'Y' THEN email ELSE 'Y' END image
          
			FROM pilots
			WHERE 
            pilots.class = ${className}`);

    if (!pilots || !pilots.length) {
        console.log('api/pilots: invalid class or day not started');
        console.log(pilots);
        res.setHeader('Cache-Control', 'max-age=30');
        res.status(204).end();
        return;
    }

    // How long should it be cached - 60 seconds is good
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=60');

    // And we succeeded - here is the json
    res.status(200).json({pilots: _keyBy(pilots, 'compno')});
    // Done
    mysqlEnd();
}
