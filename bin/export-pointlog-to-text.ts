//
// One-shot migration: stream every row out of the SQLite pointlog at
// $DB_PATH/aprs.sqlite into rotated plain-text aprs-*.log files in the
// same directory, in the format the plain-text pointlog (lib/webworkers/
// pointlog.ts on the onglide branch) reads.
//
// Workflow:
//   1. Stop ogn (so nothing is appending to aprs.sqlite while we read).
//   2. Run this script on the box that holds aprs.sqlite. It needs
//      better-sqlite3 in node_modules — easiest is to run it from the
//      mayday checkout where the dep is already installed.
//   3. Switch the worker code to the plain-text pointlog and start ogn.
//      The new files coexist with aprs.sqlite; ogn won't touch the
//      sqlite file once it's running plain-text code.
//
// Output filenames: aprs-<host>-<exporterPid>-<firstTs>-<lastTs>.log
// The plain-text reader treats files where the writer pid is no longer
// alive as rotated; once this script exits its pid is gone, so its files
// look like normal rotated logs.
//
// Usage:
//   yarn ts-node bin/export-pointlog-to-text.ts [--rotate-mb 100]
//

import * as path from 'path';
import * as os from 'os';
import {createWriteStream, mkdirSync, renameSync, WriteStream} from 'fs';
import Database from 'better-sqlite3';
import yargs from 'yargs';
import * as dotenv from 'dotenv';

dotenv.config({path: '.env.local'});

interface Row {
    t: number;
    f: string;
    o: string;
    lat: number;
    lng: number;
    a: number;
    g: number;
    b: number | null;
    s: number | null;
    d: number | null;
    ad: number | null;
}

async function run() {
    const args = await yargs(process.argv.slice(2))
        .option('rotate-mb', {type: 'number', description: 'output file size cap in MB', default: 100})
        .help()
        .alias('help', 'h').argv;

    const baseDir = (process.env.DB_PATH ?? './db/').replace(/\/$/, '') + '/';
    const dbPath = path.join(baseDir, 'aprs.sqlite');
    const rotateBytes = (args['rotate-mb'] ?? 100) * 1024 * 1024;

    mkdirSync(baseDir, {recursive: true});
    const db = new Database(dbPath, {readonly: true, fileMustExist: true});
    db.pragma('journal_mode = WAL');

    const host = os.hostname();
    const pid = process.pid;

    let stream: WriteStream | undefined;
    let tmpPath: string | undefined;
    let activeFirstTs = 0;
    let activeLastTs = 0;
    let activeBytes = 0;
    let totalRows = 0;
    let totalFiles = 0;
    let progressRows = 0;
    const startMs = Date.now();

    function openNew(firstTs: number) {
        activeFirstTs = firstTs;
        activeLastTs = firstTs;
        activeBytes = 0;
        // Write under a .tmp suffix so the plain-text reader (which
        // pattern-matches aprs-*.log) ignores the file until it's complete.
        tmpPath = path.join(baseDir, `aprs-${host}-${pid}-${firstTs}.log.tmp`);
        stream = createWriteStream(tmpPath);
    }

    async function closeCurrent() {
        if (!stream || !tmpPath) return;
        await new Promise<void>((resolve, reject) => {
            stream!.end((err: any) => (err ? reject(err) : resolve()));
        });
        const finalPath = path.join(baseDir, `aprs-${host}-${pid}-${activeFirstTs}-${activeLastTs}.log`);
        renameSync(tmpPath, finalPath);
        totalFiles++;
        console.log(`pointlog-export: ${finalPath} (${activeBytes} bytes)`);
        stream = undefined;
        tmpPath = undefined;
    }

    const stmt = db.prepare(
        `SELECT t, f, o, lat, lng, a, g, b, s, d, ad
         FROM points
         ORDER BY t ASC`
    );

    try {
        for (const r of stmt.iterate() as IterableIterator<Row>) {
            // LoggedMessage shape the plain-text appendPoint would have
            // written. The SQLite reader sets c=f and l=null at row→message
            // time; we replicate that on disk so plain-text JSON.parse gives
            // back the same object.
            const msg: Record<string, unknown> = {
                t: r.t,
                f: r.f,
                o: r.o,
                c: r.f,
                lat: r.lat,
                lng: r.lng,
                a: r.a,
                g: r.g,
                l: null
            };
            if (r.b != null) msg.b = r.b;
            if (r.s != null) msg.s = r.s;
            if (r.d != null) msg.d = r.d;
            if (r.ad != null) msg.ad = r.ad;

            const line = JSON.stringify(msg) + '\n';
            const lineBytes = Buffer.byteLength(line, 'utf8');

            if (!stream) {
                openNew(r.t);
            } else if (activeBytes + lineBytes > rotateBytes) {
                await closeCurrent();
                openNew(r.t);
            }

            // Backpressure: once write returns false, wait for drain. Without
            // this, better-sqlite3's sync iterate() will queue every
            // outstanding row into the WriteStream buffer and OOM the box on
            // a real-sized DB.
            if (!stream!.write(line)) {
                await new Promise<void>((resolve) => stream!.once('drain', () => resolve()));
            }
            activeBytes += lineBytes;
            if (r.t > activeLastTs) activeLastTs = r.t;
            totalRows++;

            if (++progressRows >= 100_000) {
                progressRows = 0;
                const elapsed = (Date.now() - startMs) / 1000;
                console.log(`pointlog-export: ${totalRows} rows in ${elapsed.toFixed(1)}s (${Math.round(totalRows / elapsed)}/s)`);
            }
        }

        await closeCurrent();
    } finally {
        db.close();
    }

    const elapsed = (Date.now() - startMs) / 1000;
    console.log(`pointlog-export: done — ${totalRows} rows → ${totalFiles} files in ${elapsed.toFixed(1)}s`);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
