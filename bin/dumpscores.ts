//
// Diagnostic: decode binary score-history chunks (the `.bin` files served by
// /scorehistory/...) and print them as JSON or a per-pilot summary. Either
// pass a local file path, or fetch all chunks for a channel from a server with
// --url and --class.
//

import {readFileSync} from 'fs';
import yargs from 'yargs';

import {d} from '../lib/now';
import {scoreChunkSize} from '../lib/constants';
import type {Epoch} from '../lib/types';
import {ClassScoreHistory, type PilotScore, type ScoreHistory} from '../lib/protobuf/onglide';
import {unscaleClassScoreHistoryFromWire} from '../lib/protobuf/wireScaling';

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .usage('$0 <file> [options]\n  $0 --url <base> --class <channel> [options]')
        .positional('file', {type: 'string', description: 'path to .bin scorehistory chunk'})
        .option('url', {type: 'string', description: 'base URL of the scoring server (e.g. https://www.onglide.com)'})
        .option('class', {type: 'string', description: 'channel name (class+datecode, e.g. 0530818D8669660653)'})
        .option('score-id', {type: 'string', description: 'scoreId to fetch (defaults to live scoreId from /scores/<channel>.json)'})
        .option('from', {type: 'number', description: 'epoch lower bound for chunk scan (defaults to walking back until empty)'})
        .option('until', {type: 'number', description: 'epoch upper bound (defaults to latest live score t)'})
        .option('empty-stop', {type: 'number', description: 'consecutive empty chunks before stopping the back-scan', default: 4})
        .option('compno', {type: 'string', description: 'only show this pilot'})
        .option('summary', {type: 'boolean', description: 'one-line summary per pilot'})
        .option('json', {type: 'boolean', description: 'emit decoded message as JSON'})
        .option('full', {type: 'boolean', description: 'with --json, do not strip the bulky array fields'})
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

    const msg = file
        ? unscaleClassScoreHistoryFromWire(ClassScoreHistory.decode(new Uint8Array(readFileSync(file))))
        : await fetchChannel({url: url!, channel: channel!, scoreId: args['score-id'], from: args.from, until: args.until, emptyStop: args['empty-stop']});

    const sourceLabel = file ? `file: ${file}` : `channel: ${channel} from ${url}`;

    const pilots = Object.entries(msg.pilots).filter(([compno]) => !args.compno || compno.toUpperCase() === args.compno.toUpperCase());

    if (args.json) {
        const filtered: ClassScoreHistory = {...msg, pilots: Object.fromEntries(pilots)};
        const out = ClassScoreHistory.toJSON(filtered) as any;
        if (!args.full) {
            for (const p of Object.values(out.pilots ?? {}) as any[]) {
                for (const s of p.history ?? []) stripBulky(s);
            }
        }
        console.log(JSON.stringify(out, null, 2));
        process.exit(0);
    }

    console.log(sourceLabel);
    console.log(`className: ${msg.className || '(unset)'}  datecode: ${msg.datecode || '(unset)'}`);
    console.log(`pilots:    ${pilots.length}`);

    if (args.summary) {
        console.log('');
        console.log('compno  scores  first                    last                     legs  status');
        for (const [compno, sh] of pilots.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            const h = sh.history ?? [];
            if (!h.length) {
                console.log(`${compno.padEnd(6)}  ${String(0).padStart(6)}`);
                continue;
            }
            const first = h[0];
            const last = h[h.length - 1];
            const legs = last.currentLeg ?? 0;
            const status = [
                last.utcStart ? 'started' : '',
                last.utcFinish ? 'finished' : '',
                last.inSector ? 'inSector' : '',
                last.inPenalty ? 'inPenalty' : '',
                last.stationary ? 'stationary' : ''
            ]
                .filter(Boolean)
                .join(',');
            console.log(`${compno.padEnd(6)}  ${String(h.length).padStart(6)}  ${d(first.t as Epoch).padEnd(22)}   ${d(last.t as Epoch).padEnd(22)}   ${String(legs).padStart(3)}   ${status}`);
        }
        process.exit(0);
    }

    for (const [compno, sh] of pilots.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        console.log('');
        console.log(`=== ${compno} (${sh.history?.length ?? 0} scores) ===`);
        for (const s of sh.history ?? []) printScore(s);
    }

    process.exit(0);
}

function stripBulky(s: any) {
    for (const k of ['scoredPoints', 'minDistancePoints', 'maxDistancePoints', 'optimalGrid', 'optimalGridBaselinePath', 'suggestedTrackPoints']) {
        if (Array.isArray(s[k])) s[k] = `<${s[k].length} nums>`;
    }
    if (s.stats?.segments) s.stats.segments = `<${s.stats.segments.length} segments>`;
    if (s.legs && typeof s.legs === 'object') {
        for (const leg of Object.values(s.legs) as any[]) {
            if (Array.isArray(leg?.convexHull)) leg.convexHull = `<${leg.convexHull.length} nums>`;
        }
    }
}

function printScore(s: PilotScore) {
    const flags = [
        s.live ? 'live' : '',
        s.inSector ? 'inSector' : '',
        s.inPenalty ? 'inPenalty' : '',
        s.stationary ? 'stationary' : '',
        s.utcStart ? `start=${d(s.utcStart as Epoch)}` : '',
        s.utcFinish ? `finish=${d(s.utcFinish as Epoch)}` : '',
        s.taskTimeRemaining !== undefined ? `ttr=${s.taskTimeRemaining}` : '',
        s.taskDuration !== undefined ? `td=${s.taskDuration}` : '',
        s.flightStatus !== undefined ? `fs=${s.flightStatus}` : ''
    ]
        .filter(Boolean)
        .join(' ');
    const a = s.actual;
    const h = s.handicapped;
    const fmt = (x?: number) => (x === undefined || x === null ? '-' : x.toFixed(2));
    const sd = (label: string, x: typeof a) =>
        x ? ` ${label}{td=${fmt(x.taskDistance)} d=${fmt(x.distance)} dr=${fmt(x.distanceRemaining)} max=${fmt(x.maxPossible)} min=${fmt(x.minPossible)} ts=${fmt(x.taskSpeed)} ls=${fmt(x.legSpeed)}}` : '';
    console.log(`${d(s.t as Epoch)}  leg=${s.currentLeg}  ${flags}${sd('A', a)}${sd('H', h)}`);
    if (s.wind) console.log(`    wind: ${s.wind.speed.toFixed(1)} m/s @ ${s.wind.direction.toFixed(0)}°`);
    if (s.scoringClosestPoint) console.log(`    closest: ${s.scoringClosestPoint.lat.toFixed(5)},${s.scoringClosestPoint.lng.toFixed(5)} t=${d(s.scoringClosestPoint.t as Epoch)}`);
    if (s.optimalNextSectorPoint) console.log(`    optNext: ${s.optimalNextSectorPoint.lat.toFixed(5)},${s.optimalNextSectorPoint.lng.toFixed(5)}`);
    if (s.optimalGridBaseline !== undefined) console.log(`    optimalGridBaseline: ${s.optimalGridBaseline.toFixed(2)}`);
    if (s.optimalGrid?.length) console.log(`    optimalGrid: ${s.optimalGrid.length / 3} cells`);
    if (s.optimalGridBaselinePath?.length) console.log(`    baselinePath: ${s.optimalGridBaselinePath.length / 2} pts`);
    if (s.suggestedTrackPoints?.length) console.log(`    suggested: ${s.suggestedTrackPoints.length / 4} pts`);
    if (s.scoredPoints?.length) console.log(`    scoredPoints: ${s.scoredPoints.length / 4} pts`);
    if (s.minDistancePoints?.length) console.log(`    minDistancePoints: ${s.minDistancePoints.length / 4} pts`);
    if (s.maxDistancePoints?.length) console.log(`    maxDistancePoints: ${s.maxDistancePoints.length / 4} pts`);
    const legs = Object.entries(s.legs ?? {});
    if (legs.length) {
        const summary = legs
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([n, l]) => `${n}@${l.time ? d(l.time as Epoch).slice(11, 19) : '-'}`)
            .join(' ');
        console.log(`    legs: ${summary}`);
    }
    if (s.stats?.segments?.length) console.log(`    stats: ${s.stats.segments.length} segments`);
    if (s.scoreId) console.log(`    scoreId: ${s.scoreId}`);
}

interface FetchOpts {
    url: string;
    channel: string;
    scoreId?: string;
    from?: number;
    until?: number;
    emptyStop: number;
}

async function fetchChannel(opts: FetchOpts): Promise<ClassScoreHistory> {
    const base = opts.url.replace(/\/+$/, '');
    const channel = opts.channel.toUpperCase();

    let scoreId = opts.scoreId;
    let until = opts.until;
    let className = '';

    // /scores/<channel>.json gives us the live scoreId and the latest t per pilot
    if (!scoreId || until === undefined) {
        const liveUrl = `${base}/scores/${channel}.json`;
        process.stderr.write(`fetching ${liveUrl}\n`);
        const r = await fetch(liveUrl);
        if (!r.ok) throw new Error(`GET ${liveUrl} -> ${r.status} ${r.statusText}`);
        const live = (await r.json()) as {scores?: {scoreId?: string; pilots?: Record<string, PilotScore>}};
        if (!scoreId) scoreId = live.scores?.scoreId ?? '0';
        if (until === undefined) {
            let max = 0;
            for (const p of Object.values(live.scores?.pilots ?? {})) if ((p.t ?? 0) > max) max = p.t ?? 0;
            until = max || Math.trunc(Date.now() / 1000);
        }
    }

    process.stderr.write(`scoreId=${scoreId}  until=${d(until as Epoch)}  ${opts.from !== undefined ? `from=${d(opts.from as Epoch)}` : `from=auto (stop after ${opts.emptyStop} empty)`}\n`);

    // Walk backwards in 30-min steps. Each chunk URL takes any timestamp inside
    // the chunk window; using chunkStart keeps the URLs canonical.
    const chunks: ClassScoreHistory[] = [];
    let consecutiveEmpty = 0;
    let t = (until as number) - ((until as number) % scoreChunkSize);
    const lowerBound = opts.from !== undefined ? (opts.from as number) - ((opts.from as number) % scoreChunkSize) : -Infinity;

    while (t >= lowerBound) {
        const chunkUrl = `${base}/scorehistory/${channel}.${t}/${scoreId}.bin`;
        const r = await fetch(chunkUrl);
        if (r.status === 404) {
            process.stderr.write(`  ${d(t as Epoch)} -> 404\n`);
            consecutiveEmpty++;
            if (opts.from === undefined && consecutiveEmpty >= opts.emptyStop) break;
            t -= scoreChunkSize;
            continue;
        }
        if (!r.ok) throw new Error(`GET ${chunkUrl} -> ${r.status} ${r.statusText}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        const decoded = unscaleClassScoreHistoryFromWire(ClassScoreHistory.decode(buf));
        if (decoded.className) className = decoded.className;
        const totalScores = Object.values(decoded.pilots ?? {}).reduce((n, sh) => n + (sh.history?.length ?? 0), 0);
        process.stderr.write(`  ${d(t as Epoch)} -> ${buf.length} bytes, ${totalScores} scores\n`);
        if (totalScores === 0) {
            consecutiveEmpty++;
            if (opts.from === undefined && consecutiveEmpty >= opts.emptyStop) break;
        } else {
            consecutiveEmpty = 0;
            chunks.push(decoded);
        }
        t -= scoreChunkSize;
    }

    // Merge: per-pilot, concat all histories, sort by t, dedupe.
    const merged: Record<string, ScoreHistory> = {};
    for (const c of chunks) {
        for (const [compno, sh] of Object.entries(c.pilots ?? {})) {
            (merged[compno] ??= {history: []}).history.push(...(sh.history ?? []));
        }
    }
    for (const sh of Object.values(merged)) {
        sh.history.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
        const out: PilotScore[] = [];
        let prev = -1;
        for (const s of sh.history) {
            if (s.t !== prev) out.push(s);
            prev = s.t;
        }
        sh.history = out;
    }

    return {className, datecode: '', pilots: merged};
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
