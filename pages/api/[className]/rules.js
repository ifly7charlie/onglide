import {query} from '../../../lib/react/db';
import escape from 'sql-template-strings';

import { calculateTaskLength } from '../../../lib/flightprocessing/taskhelper.js';

export default async function taskHandler( req, res) {
    const {
		query: { className },
    } = req;
	
    if( !className ) {
		console.log( "no class" );
		res.status(404).json({error: "missing parameter(s)"});
		return;
    }
	
    const rules = await query(escape`
         SELECT comprules.* FROM comprules,classes WHERE classes.class=${className} AND classes.type = comprules.name
    `);
	
    // How long should it be cached
    res.setHeader('Cache-Control','max-age=3600');
	
    // And we succeeded - here is the json
    res.status(200)
	   .json( rules )
}
