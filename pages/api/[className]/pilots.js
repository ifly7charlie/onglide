import { query } from '../../../lib/react/db'
import escape from 'sql-template-strings'

export default async function taskHandler( req, res) {
    const {
	query: { className },
    } = req;

    if( !className ) {
	console.log( "no class" );
	res.status(404).json({error: "missing parameter(s)"});
	return;
    }

    // this is the pilot results
    const pilots = await query(escape`
	select pilots.class, pilots.compno, 
		       pr.status dbstatus, datafromscoring,scoredstatus,
		       CASE WHEN start ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(fdcode(cs.datecode),' ',start))-(SELECT tzoffset FROM competition)
               END utcstart, start, finish, duration,
		       pilots.class, forcetp,
	            concat(firstname,' ',lastname) name, glidertype, handicap, daypoints, dayrank, country,
          CASE 
            WHEN image != 'Y' THEN email ELSE 'Y' END image,

          CASE
			WHEN participating = 'N' THEN "H/C"
                        WHEN dayrank = 0 THEN ''
	    		WHEN dayrank%100 BETWEEN 11 AND 13 THEN concat(dayrank, "th place" )
	    		WHEN dayrank%10 = 1 THEN concat(dayrank,"st place")
	    		WHEN dayrank%10 = 2 THEN concat(dayrank,"nd place")
	    WHEN dayrank%10 = 3 THEN concat(dayrank,"rd place")
	    ELSE concat(dayrank,"th place")
          END dayrankordinal,

	  prevtotalrank, totalrank,
	  hdistance hdistancedone, distance distancedone,
          speed, hspeed
          
			FROM pilots, pilotresult pr, compstatus cs
			WHERE pilots.compno = pr.compno and pr.class = pilots.class
                          and cs.datecode = pr.datecode
                          and cs.class = pilots.class
			  and pilots.class = ${className}
     `);

    if( ! pilots || ! pilots.length ) {
		console.log( "invalid class" );
		console.log( pilots );
		res.status(404).json({error: "invalid class"});
		return;
    }


    // How long should it be cached - 60 seconds is good
    res.setHeader('Cache-Control','max-age=60');

    // And we succeeded - here is the json
    res.status(200)
	.json({pilots: pilots});
}
