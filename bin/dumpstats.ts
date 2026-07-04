//
// Diagnostic: decode the binary flight-statistics snapshot (the `.bin` served
// by /stats/<channel>.<baseTime>.bin) and print it as JSON or a per-pilot
// summary. Either pass a local file path, or fetch the current snapshot for a
// channel from a server with --url and --class.
//
// Unlike scores/tracks, stats key to trackVersion (position lineage), not
// scoreId, and live only in the daemon's RAM — there is no DB to scan. The
// snapshot baseTime is discovered from /scores/<channel>.json (statsBaseTime).
//
//   node dist/bin/dumpstats.js path/to/snapshot.bin
//   node dist/bin/dumpstats.js --url https://www.onglide.com --class BLUE070
//   node dist/bin/dumpstats.js --url ... --class ... --summary
//

import {readFileSync} from 'fs';
import yargs from 'yargs';

import {d} from '../lib/now';
import type {Epoch} from '../lib/types';
import {OnglideWebSocketMessage, type ClassStats, type StatSegment} from '../lib/protobuf/onglide';
import {unscaleFromWire} from '../lib/protobuf/wireScaling';

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .usage('$0 <file> [options]\n  $0 --url <base> --class <channel> [options]')
        .positional('file', {type: 'string', description: 'path to .bin stats snapshot'})
        .option('url', {type: 'string', description: 'base URL of the scoring server (e.g. https://www.onglide.com)'})
        .option('class', {type: 'string', description: 'channel name (class+datecode, e.g. BLUE070)'})
        .option('base-time', {type: 'number', description: 'snapshot baseTime to fetch (defaults to statsBaseTime from /scores/<channel>.json)'})
        .option('compno', {type: 'string', description: 'only show this pilot'})
        .option('summary', {type: 'boolean', description: 'one-line summary per pilot'})
        .option('json', {type: 'boolean', description: 'emit decoded ClassStats as JSON'})
        .help()
        .alias('help', 'h').argv;

    const file = args._[0] as string | undefined;
    const url = args.url;
    const channel = args['class'];

    if (!file && !(url && channel)) {
        console.error('expected a file path, or --url and --class');
        process.exit(2);
    }
    if (file && (url || channel)) {
        console.error('pass either a file or --url/--class, not both');
        process.exit(2);
    }

    const stats = file
        ? unscaleFromWire(OnglideWebSocketMessage.decode(new Uint8Array(readFileSync(file)))).stats
        : await fetchSnapshot({url: url!, channel: channel!, baseTime: args['base-time']});

    const sourceLabel = file ? `file: ${file}` : `channel: ${channel} from ${url}`;

    if (!stats || !Object.keys(stats.class ?? {}).length) {
        console.log(sourceLabel);
        console.log('no stats in snapshot');
        process.exit(0);
    }

    if (args.json) {
        const filtered = args.compno ? filterByCompno(stats, args.compno) : stats;
        console.log(JSON.stringify(OnglideWebSocketMessage.toJSON({stats: filtered}), null, 2));
        process.exit(0);
    }

    console.log(sourceLabel);
    for (const [className, update] of Object.entries(stats.class)) {
        const pilots = Object.entries(update.pilots ?? {}).filter(([compno]) => !args.compno || compno.toUpperCase() === args.compno.toUpperCase());
        console.log('');
        console.log(`class: ${className}  baseTime: ${update.baseTime ? d(update.baseTime as Epoch) : 0}  pilots: ${pilots.length}`);

        if (args.summary) {
            console.log('');
            console.log('compno  segs  thermals  climb(best/avg m/s)  gain(m)  first                    last');
            for (const [compno, p] of pilots.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
                const segs = p.segments ?? [];
                const thermals = segs.filter((s) => s.state === 'thermal');
                const best = thermals.reduce((m, s) => Math.max(m, s.avgDelta ?? 0), 0);
                const avg = thermals.length ? thermals.reduce((a, s) => a + (s.avgDelta ?? 0), 0) / thermals.length : 0;
                const gain = segs.reduce((a, s) => a + (s.heightgain ?? 0), 0);
                const first = segs[0];
                const last = segs[segs.length - 1];
                console.log(
                    `${compno.padEnd(6)}  ${String(segs.length).padStart(4)}  ${String(thermals.length).padStart(8)}  ${`${best.toFixed(1)}/${avg.toFixed(1)}`.padStart(19)}  ${String(Math.round(gain)).padStart(7)}  ${(first ? d(first.start as Epoch) : '-').padEnd(22)}   ${last ? d(last.end as Epoch) : '-'}`
                );
            }
            continue;
        }

        for (const [compno, p] of pilots.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            console.log('');
            console.log(`=== ${compno} (trackVersion ${p.trackVersion}, ${p.segments?.length ?? 0} segments) ===`);
            for (const seg of p.segments ?? []) printSegment(seg);
        }
    }

    process.exit(0);
}

function filterByCompno(stats: ClassStats, compno: string): ClassStats {
    const cls: ClassStats['class'] = {};
    for (const [className, update] of Object.entries(stats.class)) {
        const match = Object.entries(update.pilots ?? {}).filter(([c]) => c.toUpperCase() === compno.toUpperCase());
        if (match.length) cls[className] = {...update, pilots: Object.fromEntries(match)};
    }
    return {class: cls};
}

function printSegment(s: StatSegment) {
    const dur = (s.end ?? 0) - (s.start ?? 0);
    const time = `${d(s.start as Epoch).slice(11, 19)}-${d(s.end as Epoch).slice(11, 19)} (${dur}s)`;
    const parts: string[] = [];
    if (s.state === 'thermal') {
        parts.push(`▲${(s.avgDelta ?? 0).toFixed(1)} m/s`);
        parts.push(`+${Math.round(s.heightgain ?? 0)}m`);
        if (s.turncount) parts.push(`turns=${Math.round(s.turncount / 360)}`);
        if (s.wind?.direction !== undefined) parts.push(`wind ${Math.round(s.wind.speed ?? 0)}kph@${Math.round(s.wind.direction)}`);
    } else if (s.state === 'gap') {
        parts.push('(tracking gap)');
    } else {
        parts.push(`${(s.distance ?? 0).toFixed(1)}km`);
        const delta = (s.heightgain ?? 0) - (s.heightloss ?? 0);
        parts.push(`Δ${delta >= 0 ? '+' : ''}${Math.round(delta)}m`);
    }
    console.log(`  ${(s.state ?? '?').padEnd(8)}  ${time.padEnd(34)}  ${parts.join('  ')}`);
}

interface FetchOpts {
    url: string;
    channel: string;
    baseTime?: number;
}

async function fetchSnapshot(opts: FetchOpts): Promise<ClassStats | undefined> {
    const base = opts.url.replace(/\/+$/, '');
    const channel = opts.channel.toUpperCase();

    let baseTime = opts.baseTime;
    if (baseTime === undefined) {
        const liveUrl = `${base}/scores/${channel}.json`;
        process.stderr.write(`fetching ${liveUrl}\n`);
        const r = await fetch(liveUrl);
        if (!r.ok) throw new Error(`GET ${liveUrl} -> ${r.status} ${r.statusText}`);
        const live = (await r.json()) as {statsBaseTime?: number};
        baseTime = live.statsBaseTime ?? 0;
    }

    if (!baseTime) {
        process.stderr.write('no stats snapshot frozen yet (statsBaseTime=0)\n');
        return undefined;
    }

    const snapUrl = `${base}/stats/${channel}.${baseTime}.bin`;
    process.stderr.write(`fetching ${snapUrl}\n`);
    const r = await fetch(snapUrl);
    if (!r.ok) throw new Error(`GET ${snapUrl} -> ${r.status} ${r.statusText}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    process.stderr.write(`  ${buf.length} bytes, baseTime=${d(baseTime as Epoch)}\n`);
    return unscaleFromWire(OnglideWebSocketMessage.decode(buf)).stats;
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
