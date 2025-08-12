//
// This webworker will parse inbound APRS messages and package them to be passed to
// both scoring and the front end using messages
//

//
// Subscribe to APRS and then broadcast to
// -> `Unknown_${competitionName}` for close to airfield but unknown
// -> `${className}` for known gliders
//
// Control channel allows adding new trackers and stopping the
// worker

// Import the APRS server

// APRS connection
// Our persistence
import {ClassicLevel} from 'classic-level';
import type {AbstractSublevel} from 'abstract-level';

import {d} from '../lib/now';

class DB extends ClassicLevel<string, string> {}

import yargs from 'yargs';

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .option('competition', {type: 'string', required: true, description: 'db to open'})
        .option('tracker', {type: 'string', required: false, description: 'flarm id to dump'})
        .option('datecode', {type: 'string', required: true, description: 'datecode to open'})
        .help()
        .alias('help', 'h').argv;

    const path = `${process.env.DB_PATH ?? './db/'}/aprs-${args.datecode}-${args.competition}.db`;
    const db = new DB(path);
    console.log('opening points database', path);
    await db.open().catch((e: any) => {
        console.log(`${path}: Failed to open: ${e.cause?.code || e.code}`);
        return undefined;
    });

    if (!(db?.status == 'open' || db?.status == 'opening')) {
        console.log(path, db?.status, new Error('db status invalid'));
        return undefined;
    }

    const sldb = args.tracker ? db.sublevel(args.tracker, {}) : db;

    for await (const [key, messageJson] of sldb.iterator()) {
        const j = JSON.parse(messageJson);
        console.log(`${d(j.t)}+${j.d}: ${j.o} ${j.g}m`);
    }
}

run();
