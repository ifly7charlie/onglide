import {query} from '../../../lib/react/db';
import escape from 'sql-template-strings';

export default async function taskHandler(req, res) {
    const {
        query: {className}
    } = req;

    if (!className) {
        console.log('no class');
        res.status(404).json({error: 'missing parameter(s)'});
        return;
    }

    // this is the pilot results
    const pilots = await query(escape`
	select pilots.class, pilots.compno, 
	            concat(firstname,' ',lastname) name, gliderType, handicap, country,
          CASE 
            WHEN image != 'Y' THEN email ELSE 'Y' END image,
          distance,
          speed,
		       dataFromScoring, scoredStatus,
		       CASE WHEN start ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(fdcode(cs.datecode),' ',start))-(SELECT tzoffset FROM competition)
               END utcStart,
		       CASE WHEN finish ='00:00:00' THEN 0
                    ELSE UNIX_TIMESTAMP(CONCAT(fdcode(cs.datecode),' ',finish))-(SELECT tzoffset FROM competition)
               END utcFinish, forceTP
          
			FROM pilots, pilotresult pr, compstatus cs
			WHERE pilots.compno = pr.compno and pr.class = pilots.class
                          and cs.datecode = pr.datecode
                          and cs.class = pilots.class
			  and pilots.class = ${className}
     `);

    if (!pilots || !pilots.length) {
        console.log('invalid class');
        console.log(pilots);
        res.status(404).json({error: 'invalid class'});
        return;
    }

    // How long should it be cached - 60 seconds is good
    res.setHeader('Cache-Control', 'max-age=60');

    // And we succeeded - here is the json
    res.status(200).json({pilots: pilots});
}
