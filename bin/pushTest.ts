//
// Diagnostic Web Push sender for the OGN daemon's notification feature.
//
// Sends a test notification to every subscription in the pushsubscription
// table — verifying the whole delivery path (VAPID config, web-push, the
// service worker's push handler, notification rendering) without waiting for a
// real competition status change. Subscribe from the bell first, then run:
//
//   node dist/bin/pushTest.js                      # notify every subscription
//   node dist/bin/pushTest.js --comp leagueround3  # only that competition
//   node dist/bin/pushTest.js --title Hi --body "launch in 5"
//
// Dead subscriptions (404/410) are reaped, exactly as the daemon does.
//

import * as dotenv from 'dotenv';
// .env.local matches bin/ogn.ts; .env is the readme-documented fallback.
// dotenv does not override already-set vars, so .env.local wins where both define one.
dotenv.config({path: '.env.local'});
dotenv.config();

import yargs from 'yargs';
import webpush from 'web-push';
import mysql from 'serverless-mysql';
import escape from 'sql-template-strings';

async function run() {
    const args = await yargs(process.argv.slice(2))
        .option('comp', {type: 'string', description: 'only notify subscribers of this compid (default: all)'})
        .option('title', {type: 'string', default: 'Onglide test', description: 'notification title'})
        .option('body', {type: 'string', default: 'Test notification — push is working.', description: 'notification body'})
        .help().argv;

    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject) {
        console.error('VAPID keys not configured — set NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT');
        process.exit(1);
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const db = mysql({
        config: {
            host: process.env.MYSQL_HOST,
            database: process.env.MYSQL_DATABASE,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            // affectedRows = changed rows, not matched rows.
            flags: ['-FOUND_ROWS']
        }
    });

    const rows: any[] = args.comp
        ? await db.query(escape`SELECT id, endpoint, p256dh, auth, compid FROM pushsubscription WHERE compid = ${args.comp}`)
        : await db.query(escape`SELECT id, endpoint, p256dh, auth, compid FROM pushsubscription`);

    if (!rows || !rows.length) {
        console.log('no subscriptions found' + (args.comp ? ` for ${args.comp}` : '') + ' — subscribe from the bell first');
        await db.end();
        return;
    }
    console.log(`sending test notification to ${rows.length} subscription(s)`);

    for (const r of rows) {
        const payload = JSON.stringify({title: args.title, body: args.body, tag: `${r.compid}:test`, url: `/${r.compid}`});
        try {
            await webpush.sendNotification({endpoint: r.endpoint, keys: {p256dh: r.p256dh, auth: r.auth}}, payload);
            console.log(`  ok    #${r.id} ${r.compid}`);
        } catch (err: any) {
            console.log(`  fail  #${r.id} ${r.compid} (${err?.statusCode ?? '?'})`);
            if (err?.statusCode === 404 || err?.statusCode === 410) {
                await db.query(escape`DELETE FROM pushsubscription WHERE id = ${r.id}`);
                console.log(`        removed dead subscription #${r.id}`);
            }
        }
    }
    await db.end();
}

// web-push's HTTPS keep-alive agent and the mysql socket keep the event loop
// alive, so exit explicitly once the work is done rather than hanging.
run()
    .then(() => {
        console.log('done');
        process.exit(0);
    })
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
