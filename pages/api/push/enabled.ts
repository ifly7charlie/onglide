//
// Reports whether a competition has opted in to Web Push status
// notifications (competition.pushnotifications = 'Y'). The subscribe bell
// reads this to decide whether to show at all; subscribe.ts and the daemon
// enforce the same flag independently.
//
import {query, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

export default async function handler(req, res) {
    const compid = req.query?.compid;
    if (!compid || typeof compid !== 'string') {
        res.status(400).json({error: 'missing compid'});
        return;
    }

    const rows = await query(escape`SELECT pushnotifications FROM competition WHERE compid = ${compid}`);
    const enabled = Array.isArray(rows) && rows[0]?.pushnotifications === 'Y';

    // The flag changes rarely — a short cache keeps sidepanel loads cheap.
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=60');
    res.status(200).json({enabled});
    mysqlEnd();
}
