import * as dotenv from 'dotenv';
import yargs from 'yargs';
import mysql from 'serverless-mysql';

import {readFile} from 'fs';

async function run() {
    dotenv.config({path: '.env.local'});
    const args = await yargs(process.argv.slice(2)) //
        .option('competition', {type: 'string', required: true, description: 'db to open'})
        .option('class', {type: 'string', required: true, description: 'class for compno'})
        .option('compno', {type: 'string', required: true, description: 'compno to update'})
        .option('file', {type: 'string', default: '-', description: 'image file, default stdin'})
        .help()
        .alias('help', 'h').argv;

    readFile(args.file == '-' ? 0 : args.file, (err, data) => {
        if (err) {
            console.log(`unable to read file ${args.file}`, err);
            return;
        }

        const db: ReturnType<typeof mysql> = mysql({config: {host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: args.competition}});

        db.query('INSERT INTO images (class, compno, image, updated) VALUES (?, ?, ?, UNIX_TIMESTAMP())', [args.class, args.compno, data])
            .then((results) => console.log(results))
            .catch((err) => console.error(err))
            .finally(() => db.quit());
    });
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
