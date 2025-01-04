import {ClassicLevel} from 'classic-level';

class DB extends ClassicLevel<string, string> {}
let db: DB | undefined;

import yargs from 'yargs';

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .option('file', {alias: 'f', type: 'string', required: true, description: 'APRS file to play'})
        .help()
        .alias('help', 'h').argv;

    const path = `${process.env.DB_PATH ?? './db/'}/${args.file}`;
    const openedDb = (db = new DB(path));
    console.log('opening points database', path);
    await openedDb.open().catch((e: any) => {
        console.log(`${path}: Failed to open: ${e.cause?.code || e.code}`);
        return undefined;
    });

    if (!(openedDb?.status == 'open' || openedDb?.status == 'opening')) {
        console.log(path, openedDb?.status, new Error('db status invalid'));
        db = undefined;
        return undefined;
    }

    for await (const [key, messageJson] of db.iterator()) {
        console.log(key, messageJson);
    }

    db.close();
}

run();
