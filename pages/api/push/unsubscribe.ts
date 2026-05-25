//
// Remove a browser Web Push subscription for one competition. Deletes only the
// (endpoint, compid) row — other comps this browser follows are untouched.
// Keyed by endpointhash so the raw endpoint token is never transmitted.
//
import {query, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    const {hash, compid} = req.body || {};
    if (!hash || !compid || !/^[0-9a-f]{64}$/.test(hash)) {
        res.status(400).json({error: 'missing or malformed hash / compid'});
        return;
    }

    const result = await query(escape`
        DELETE FROM pushsubscription WHERE endpointhash = ${hash} AND compid = ${compid}
    `);

    if (result?.error) {
        console.log('api/push/unsubscribe failed', result.error);
        res.status(500).json({error: 'db'});
        mysqlEnd();
        return;
    }

    // Always log — a 0-row delete (stray/replayed call against an already-gone
    // sub) returns 200 silently otherwise.
    const affected = result?.affectedRows ?? 0;
    console.log(`api/push/unsubscribe: compid=${compid} endpointhash=${hash} deleted=${affected}`);

    res.status(200).json({ok: true});
    mysqlEnd();
}
