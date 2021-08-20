/*
 *
 * This will return a GeoJSON object for the task with taskid specified
 *
 */

import { query } from '../../../lib/react/db';
import escape from 'sql-template-strings';


export default async function image( req, res ) {
    const {
        query: { className, compno },
    } = req;

    if( !className || !compno) {
        console.log( "no className/compno" );
        res.status(404).json({error: "missing parameter(s)"});
        return;
    }

    // We need to figure out what date is needed as this isn't passed in to the webpage
    const imageBlob = (await query(escape`
      SELECT image
      FROM images
      WHERE class = ${className} and compno=${compno}
    `))[0].image;

	if( !imageBlob ) {
        console.log( "no image" );
        res.status(404).json({error: "no image found"});
        return;
    }

	res.setHeader( 'Content-type', 'image/jpeg' );
	res.write( imageBlob, 'binary' );
	res.end();
}
