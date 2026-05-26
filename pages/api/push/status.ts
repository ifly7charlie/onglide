//
// Authoritative source of the subscribe-bell state: the comps this browser's
// push endpoint is currently registered for. The bell reads this (via useSWR)
// rather than any client cache, so if the server loses pushsubscription the
// bell correctly shows unsubscribed.
//
// Keyed by endpointhash (SHA-256 hex of the endpoint), not the raw endpoint —
// the endpoint carries a secret token and must not appear in a request URL.
//
import {query, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

export default async function handler(req, res) {
    const hash = req.query?.h;
    if (!hash || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
        res.status(400).json({error: 'missing or malformed endpoint hash'});
        return;
    }

    const rows = await query(escape`
        SELECT compid FROM pushsubscription WHERE endpointhash = ${hash}
    `);

    if (rows?.error) {
        console.log('api/push/status failed', rows.error);
        res.status(500).json({error: 'db'});
        mysqlEnd();
        return;
    }

    // Never cache — the bell must reflect the live DB state.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({compids: (rows || []).map((r: any) => r.compid)});
    mysqlEnd();
}
