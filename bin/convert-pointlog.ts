//
// Convert pointlog .log files (JSON-lines) into .v8 fixed-size-record files.
// One-shot, idempotent: produces aprs-<host>-<pid>-<firstTs>[-<lastTs>].v8
// alongside the .log source. Set POINTLOG_FORMAT=v8 to make readers consume
// them instead of the .log files.
//

import {promises as fsp} from 'fs';
import * as path from 'path';

import yargs from 'yargs';

import {convertLogFileToV8, V8_RECORD_SIZE, V8_RECORD_HEADER_SIZE} from '../lib/webworkers/pointlog-v8';

const basePath = (): string => (process.env.DB_PATH ?? './db/').replace(/\/$/, '') + '/';

interface FileStat {
    src: string;
    dst: string;
    recordsIn: number;
    recordsWritten: number;
    skippedParse: number;
    bytesIn: number;
    bytesOut: number;
    elapsedMs: number;
    payloadBytesSum: number;
    payloadBytesMin: number;
    payloadBytesMax: number;
}

async function convertOne(srcPath: string, dstPath: string, overwrite: boolean): Promise<FileStat | undefined> {
    try {
        await fsp.access(dstPath);
        if (!overwrite) {
            console.log(`skip ${path.basename(srcPath)} → ${path.basename(dstPath)} already exists`);
            return undefined;
        }
    } catch {
        // not present — proceed
    }

    const srcStat = await fsp.stat(srcPath);
    const start = Date.now();
    const result = await convertLogFileToV8(srcPath, dstPath);
    const elapsedMs = Date.now() - start;
    const outStat = await fsp.stat(dstPath);
    return {
        src: srcPath,
        dst: dstPath,
        recordsIn: result.recordsIn,
        recordsWritten: result.recordsWritten,
        skippedParse: result.skippedParse,
        bytesIn: srcStat.size,
        bytesOut: outStat.size,
        elapsedMs,
        payloadBytesSum: result.payloadBytesSum,
        payloadBytesMin: result.payloadBytesMin,
        payloadBytesMax: result.payloadBytesMax,
    };
}

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .option('overwrite', {type: 'boolean', default: false, description: 'overwrite existing .v8 files'})
        .option('delete-source', {type: 'boolean', default: false, description: 'remove the .log after a successful conversion'})
        .option('only', {type: 'string', description: 'filename glob substring (matches against the .log basename)'})
        .option('record-size', {type: 'number', default: V8_RECORD_SIZE, description: 'fixed record size in bytes (default 256)'})
        .help()
        .alias('help', 'h').argv;

    if (args['record-size'] !== V8_RECORD_SIZE) {
        // The exported V8_RECORD_SIZE is the value baked into serializeRecord
        // via its default. Allowing override here requires plumbing the size
        // through — out of scope for v1; document and exit.
        console.error('--record-size override not yet supported; rebuild with V8_RECORD_SIZE changed in pointlog-v8.ts');
        process.exit(2);
    }

    const dir = basePath();
    let entries: string[];
    try {
        entries = await fsp.readdir(dir);
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            console.error(`no such directory: ${dir}`);
            process.exit(1);
        }
        throw e;
    }
    const sources = entries.filter((f) => f.startsWith('aprs-') && f.endsWith('.log')).filter((f) => (args.only ? f.includes(args.only) : true)).sort();
    if (sources.length === 0) {
        console.log(`no .log files in ${dir}`);
        return;
    }

    const totals = {recordsIn: 0, recordsWritten: 0, skippedParse: 0, bytesIn: 0, bytesOut: 0, files: 0, deleted: 0, payloadBytesSum: 0, payloadBytesMax: 0};

    for (const src of sources) {
        const srcPath = path.join(dir, src);
        const dstPath = path.join(dir, src.slice(0, -'.log'.length) + '.v8');
        try {
            const s = await convertOne(srcPath, dstPath, args.overwrite);
            if (!s) continue;
            totals.files++;
            totals.recordsIn += s.recordsIn;
            totals.recordsWritten += s.recordsWritten;
            totals.skippedParse += s.skippedParse;
            totals.bytesIn += s.bytesIn;
            totals.bytesOut += s.bytesOut;
            totals.payloadBytesSum += s.payloadBytesSum;
            if (s.payloadBytesMax > totals.payloadBytesMax) totals.payloadBytesMax = s.payloadBytesMax;
            const inMb = (s.bytesIn / (1024 * 1024)).toFixed(1);
            const outMb = (s.bytesOut / (1024 * 1024)).toFixed(1);
            const rate = s.elapsedMs > 0 ? `${((s.recordsWritten * 1000) / s.elapsedMs).toFixed(0)} rec/s` : '-';
            const avgPayload = s.recordsWritten > 0 ? (s.payloadBytesSum / s.recordsWritten).toFixed(1) : '-';
            console.log(
                `${src.padEnd(48)} ${String(s.recordsWritten).padStart(8)} rec  ${inMb.padStart(7)} MB → ${outMb.padStart(7)} MB  ${s.elapsedMs.toString().padStart(5)} ms  ${rate.padStart(11)}  ` +
                    `payload avg=${avgPayload.padStart(6)} B min=${String(s.payloadBytesMin).padStart(3)} B max=${String(s.payloadBytesMax).padStart(3)} B` +
                    (s.skippedParse > 0 ? `  skipped=${s.skippedParse}` : '')
            );
            if (args['delete-source']) {
                await fsp.unlink(srcPath);
                totals.deleted++;
            }
        } catch (e: any) {
            console.error(`error converting ${src}: ${e?.message ?? e}`);
        }
    }

    console.log('');
    console.log(`done: ${totals.files} file(s), ${totals.recordsWritten} record(s) written, ${totals.skippedParse} skipped`);
    console.log(`bytes: ${(totals.bytesIn / (1024 * 1024)).toFixed(1)} MB in → ${(totals.bytesOut / (1024 * 1024)).toFixed(1)} MB out`);
    if (totals.recordsWritten > 0) {
        const avg = (totals.payloadBytesSum / totals.recordsWritten).toFixed(1);
        console.log(`v8 payload: avg=${avg} B  max=${totals.payloadBytesMax} B  (budget ${V8_RECORD_SIZE - V8_RECORD_HEADER_SIZE} B per record)`);
    }
    if (args['delete-source']) console.log(`deleted: ${totals.deleted} source .log file(s)`);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
