//
// Diagnostic: dump raw point records from the shared APRS leveldb for a
// given datecode, optionally filtered to a single flarm id, or summarise
// per-flarm activity.
//

import {ClassicLevel} from 'classic-level';

import {d} from '../lib/now';
import type {Epoch} from '../lib/types';

import yargs from 'yargs';

class DB extends ClassicLevel<string, string> {}

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .option('tracker', {type: 'string', description: 'flarm id to dump'})
        .option('datecode', {type: 'string', required: true, description: 'datecode to open'})
        .option('summary', {type: 'boolean', description: 'list each flarm id with oldest, newest and packet count'})
        .help()
        .alias('help', 'h').argv;

    // Since the multi-comp refactor the points db is shared across every
    // competition the tracker process sees (keyed only by datecode).
    const path = `${process.env.DB_PATH ?? './db/'}/aprs-${args.datecode}.db`;
    const db = new DB(path);
    console.log('opening points database', path);
    await db.open().catch((e: any) => {
        console.log(`${path}: Failed to open: ${e.cause?.code || e.code}`);
        process.exit(1);
    });

    if (!(db?.status == 'open' || db?.status == 'opening')) {
        console.log(path, db?.status, new Error('db status invalid'));
        process.exit(1);
    }

    if (args.summary) {
        // Walk every record in the root db and aggregate by the flarm
        // id stored on each packet (j.c). No sublevel discovery needed;
        // the root iterator sees every sublevel entry.
        interface Stat {
            flarmId: string;
            count: number;
            oldest: number;
            newest: number;
        }
        const stats = new Map<string, Stat>();
        for await (const [, messageJson] of db.iterator()) {
            const j = JSON.parse(messageJson);
            const id = (j.c ?? '??????') as string;
            let s = stats.get(id);
            if (!s) {
                s = {flarmId: id, count: 0, oldest: Infinity, newest: 0};
                stats.set(id, s);
            }
            s.count++;
            if (j.t < s.oldest) s.oldest = j.t;
            if (j.t > s.newest) s.newest = j.t;
        }

        if (stats.size === 0) {
            console.log('no tracker data in this db');
        } else {
            const sorted = [...stats.values()].sort((a, b) => (a.flarmId < b.flarmId ? -1 : 1));
            console.log('flarm   oldest                   newest                   count');
            for (const s of sorted) {
                console.log(`${s.flarmId}  ${d(s.oldest as Epoch).padEnd(22)}  ${d(s.newest as Epoch).padEnd(22)}  ${String(s.count).padStart(6)}`);
            }
        }
    } else {
        // Dump mode. --tracker scopes to a single sublevel; default
        // iterates the root db so you see records from every flarm id.
        const sldb = args.tracker ? db.sublevel(args.tracker.toUpperCase(), {}) : db;
        for await (const [, messageJson] of sldb.iterator()) {
            const j = JSON.parse(messageJson);
            console.log(`${d(j.t)}+${j.d}: ${j.o} ${j.g}m  ${j.c ?? '??????'}`);
        }
    }

    await db.close();
    process.exit(0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
