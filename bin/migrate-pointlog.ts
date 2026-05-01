//
// Migrate the legacy text-file APRS pointlogs into the SQLite store.
//
// The previous implementation wrote one NDJSON record per line into rotated
// `aprs-<host>-<pid>-<firstTs>[-<lastTs>].log` files in $DB_PATH. The current
// implementation persists the same records into $DB_PATH/aprs.sqlite. This
// script reads the legacy files, parses each line, and bulk-inserts the
// records into SQLite via the pointlog public API.
//
// Usage:
//   yarn build:tsc
//   node dist/bin/migrate-pointlog.js db/aprs-*.log
//
// Notes:
//   - Each file is streamed line-by-line; memory stays bounded.
//   - Inserts are batched into transactions of --batch rows (default 10000)
//     so SQLite fsyncs amortize. This is roughly 100× faster than per-row.
//   - Records older than APRS_LOG_RETAIN_HOURS will be reaped by the next
//     hourly purge (default 24h). Set APRS_LOG_RETAIN_HOURS=720 (or higher)
//     to import historical data without it being deleted on the first tick.
//   - Re-running the migration is safe: PK is (t, f, o), so duplicate rows
//     are silently overwritten by INSERT OR REPLACE.
//

import {createReadStream} from 'fs';
import * as readline from 'readline';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {openLog, closeLog, bulkAppend, type LoggedMessage} from '../lib/webworkers/pointlog';

interface FileResult {
    file: string;
    lines: number;
    parsed: number;
    inserted: number;
    skipped: number;
    parseErrors: number;
    elapsedMs: number;
}

async function migrateFile(file: string, batchSize: number): Promise<FileResult> {
    const start = Date.now();
    const stream = createReadStream(file, {encoding: 'utf8'});
    // crlfDelay: Infinity so we treat \r\n the same as \n.
    const rl = readline.createInterface({input: stream, crlfDelay: Infinity});

    let lines = 0;
    let parsed = 0;
    let parseErrors = 0;
    let inserted = 0;
    let skipped = 0;
    let batch: LoggedMessage[] = [];

    const flush = () => {
        if (batch.length === 0) return;
        const r = bulkAppend(batch);
        inserted += r.inserted;
        skipped += r.skipped;
        batch = [];
    };

    try {
        for await (const raw of rl) {
            lines++;
            const line = raw.trim();
            if (!line) continue;
            let msg: LoggedMessage;
            try {
                msg = JSON.parse(line) as LoggedMessage;
            } catch {
                parseErrors++;
                continue;
            }
            if (typeof msg.t !== 'number' || !msg.f) {
                parseErrors++;
                continue;
            }
            batch.push(msg);
            parsed++;
            if (batch.length >= batchSize) flush();
        }
        flush();
    } catch (e) {
        // Read errors mid-file: keep what we got, surface the error.
        flush();
        console.log(`migrate: read error in ${file} after ${lines} lines: ${e}`);
    }

    return {file, lines, parsed, inserted, skipped, parseErrors, elapsedMs: Date.now() - start};
}

async function main() {
    const argv = await yargs(hideBin(process.argv))
        .scriptName('migrate-pointlog')
        .usage('$0 [--batch <N>] <file>...')
        .option('batch', {type: 'number', default: 10000, description: 'rows per SQLite transaction'})
        .demandCommand(1, 'specify one or more legacy aprs-*.log files')
        .help()
        .alias('help', 'h').argv;

    const files = argv._.map(String);
    const batchSize = Math.max(1, Number(argv.batch) || 10000);

    console.log(`migrate: ${files.length} files, batch size ${batchSize}`);

    await openLog();

    let totalInserted = 0;
    let totalSkipped = 0;
    let totalParseErrors = 0;
    let totalLines = 0;
    const overallStart = Date.now();

    for (const file of files) {
        try {
            const r = await migrateFile(file, batchSize);
            totalInserted += r.inserted;
            totalSkipped += r.skipped;
            totalParseErrors += r.parseErrors;
            totalLines += r.lines;
            const rate = r.elapsedMs > 0 ? Math.round((r.inserted * 1000) / r.elapsedMs) : 0;
            console.log(
                `${r.file}: ${r.lines} lines, ${r.parsed} parsed, ${r.inserted} inserted, ${r.skipped} skipped, ${r.parseErrors} parse errors (${r.elapsedMs}ms, ${rate} row/s)`
            );
        } catch (e) {
            console.log(`migrate: ${file} failed: ${e}`);
        }
    }

    await closeLog();

    const overallMs = Date.now() - overallStart;
    const overallRate = overallMs > 0 ? Math.round((totalInserted * 1000) / overallMs) : 0;
    console.log(
        `\nmigrate: total ${totalLines} lines, ${totalInserted} inserted, ${totalSkipped} skipped, ${totalParseErrors} parse errors (${overallMs}ms, ${overallRate} row/s)`
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
