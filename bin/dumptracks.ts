//
// Diagnostic: dump or summarise messages from the APRS point log,
// optionally filtered by flarm id or time window.
//

import yargs from 'yargs';

import {d} from '../lib/now';
import type {Epoch, FlarmID} from '../lib/types';
import {loadPoints, scanAll, summarize} from '../lib/webworkers/pointlog';

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .option('tracker', {type: 'string', description: 'flarm id to dump (otherwise dumps/summarises all)'})
        .option('since', {type: 'number', description: 'epoch seconds lower bound (default 0)', default: 0})
        .option('until', {type: 'number', description: 'epoch seconds upper bound (optional)'})
        .option('summary', {type: 'boolean', description: 'list each flarm id with oldest, newest and packet count'})
        .help()
        .alias('help', 'h').argv;

    if (args.summary) {
        // Server-side aggregation: a single GROUP BY scan instead of
        // streaming every row across the JS boundary just to feed COUNT/
        // MIN/MAX. Already sorted by flarmid.
        const stats = summarize({
            flarmId: args.tracker ? (args.tracker.toUpperCase() as FlarmID) : undefined,
            since: args.since,
            until: args.until
        });

        if (stats.length === 0) {
            console.log('no tracker data in this range');
        } else {
            console.log('flarm   oldest                   newest                   count       rate');
            for (const s of stats) {
                const span = s.newest - s.oldest;
                const rate = span > 0 ? `${(s.count / span).toFixed(2)} msg/s` : '-';
                console.log(`${s.flarmId}  ${d(s.oldest as Epoch).padEnd(22)}  ${d(s.newest as Epoch).padEnd(22)}  ${String(s.count).padStart(6)}  ${rate.padStart(9)}`);
            }
        }
    } else {
        const iter = args.tracker
            ? loadPoints({flarmId: args.tracker.toUpperCase() as FlarmID, since: args.since, until: args.until})
            : scanAll({since: args.since, until: args.until});
        for await (const msg of iter) {
            const m = msg as any;
            console.log(`${d(m.t)}+${m.d ?? 0}: ${m.o} ${m.g}m  ${m.c ?? '??????'} (${m.f})`);
        }
    }

    process.exit(0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
