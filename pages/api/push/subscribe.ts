//
// Register a browser Web Push subscription for competition status
// notifications. The OGN daemon reads pushsubscription and sends the pushes;
// this route only owns the DB write. Idempotent — re-subscribing refreshes the
// row rather than duplicating it.
//
import {createHash} from 'crypto';

import {query, queryRow, mysqlEnd} from '../../../lib/react/db';
import escape from 'sql-template-strings';

// Locales with a public/locales/<lang>/common.json the daemon can render
// notification text from; anything else is stored as 'en'.
const KNOWN_LOCALES = ['cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hu', 'it', 'nb', 'nl', 'pl', 'sk', 'sl', 'sv'];

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    const {subscription, compid, lang} = req.body || {};
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;

    // Normalise the language to a known base locale (e.g. 'de-DE' -> 'de').
    const base = String(lang || 'en')
        .toLowerCase()
        .split('-')[0];
    const safeLang = KNOWN_LOCALES.includes(base) ? base : 'en';

    if (!endpoint || !p256dh || !auth || !compid) {
        res.status(400).json({error: 'missing subscription or compid'});
        return;
    }

    // expiresat is a generous safety net (end date + 2 days) — the daemon
    // purges precisely on competition rollover. + 2 days clears 22:00 local on
    // the end date for any timezone.
    const comp = await queryRow(escape`
        SELECT DATE_FORMAT(DATE_ADD(\`end\`, INTERVAL 2 DAY), '%Y-%m-%d %H:%i:%s') AS expires, pushnotifications
        FROM competition WHERE compid = ${compid}
    `);
    if (!comp?.expires) {
        res.status(404).json({error: 'unknown competition'});
        mysqlEnd();
        return;
    }
    // Per-competition opt-in — reject even if the client somehow showed the
    // bell for a competition that has not enabled notifications.
    if (comp.pushnotifications !== 'Y') {
        res.status(403).json({error: 'notifications not enabled for this competition'});
        mysqlEnd();
        return;
    }

    // endpointhash is the safe lookup key for status/unsubscribe — the raw
    // endpoint (with its token) never travels in a request URL.
    // targetclass / targetcompno keep their '' default (whole competition).
    const endpointHash = createHash('sha256').update(endpoint).digest('hex');
    const result = await query(escape`
        INSERT INTO pushsubscription (endpoint, endpointhash, p256dh, auth, compid, lang, expiresat)
        VALUES (${endpoint}, ${endpointHash}, ${p256dh}, ${auth}, ${compid}, ${safeLang}, ${comp.expires})
        ON DUPLICATE KEY UPDATE lang = ${safeLang}, expiresat = ${comp.expires}
    `);

    if (result?.error) {
        console.log('api/push/subscribe failed', result.error);
        res.status(500).json({error: 'db'});
        mysqlEnd();
        return;
    }

    res.status(200).json({ok: true});
    mysqlEnd();
}
