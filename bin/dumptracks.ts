//
// Diagnostic: dump or summarise messages from the APRS point log, optionally
// filtered by flarm id(s), or by class (+ optional compno). Class/compno
// resolves through `tracker` (current) + `trackerhistory` (every historical
// flarmid for the same pilot), so a pilot whose unit changed mid-comp is
// covered.
//
// --delay-stats reports the distribution of receive-delay d (= writeTime - t)
// and the count of packets that would have been delivered *after* the inorder
// cursor under each candidate total-delay setting. The defaults to check
// against are 10 (NEXT_PUBLIC_COMPETITION_DELAY) and 16 (10 + the
// inorderAdditionalDelay of 6).
//

import yargs from 'yargs';
import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';

import {d, getDelay} from '../lib/now';
import {inorderAdditionalDelay} from '../lib/constants';
import type {ClassName, Compno, Epoch, FlarmID} from '../lib/types';
import {loadPointsForIds, scanAll} from '../lib/webworkers/pointlog';

dotenv.config({path: '.env.local'});

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        decimalNumbers: true
    },
    onError: (e: unknown) => console.error('mysql error', e),
    onConnectError: (x: unknown) => console.error('mysql connect error', x),
    maxRetries: 2
});

// Thresholds for the delay-stats tables. The same offsets are emitted twice:
// once absolute (0..120s of raw d) and once shifted by the comp's official
// delay (compDelay+0..compDelay+120) so the comp's own cursor window is the
// reference point. compDelay + inorderAdditionalDelay is folded into the
// absolute table and annotated.
const THRESHOLD_OFFSETS = [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120];

async function run() {
    const args = await yargs(process.argv.slice(2)) //
        .option('tracker', {type: 'string', array: true, description: 'flarm id (repeatable; combined with --class/--compno)'})
        .option('class', {type: 'string', description: 'class hash; resolve flarm ids from tracker + trackerhistory'})
        .option('compno', {type: 'string', description: 'compno within --class (requires --class)'})
        .option('since', {type: 'number', description: 'epoch seconds lower bound (default 0)', default: 0})
        .option('until', {type: 'number', description: 'epoch seconds upper bound (optional)'})
        .option('summary', {type: 'boolean', description: 'one row per flarm id: oldest, newest, count, rate'})
        .option('delay-stats', {type: 'boolean', description: 'distribution of receive-delay d (writeTime - t) and per-setting late count'})
        .help()
        .alias('help', 'h').argv;

    if (args.compno && !args.class) {
        console.error('--compno requires --class');
        process.exit(2);
    }

    const flarmIds = new Set<string>();
    for (const t of args.tracker ?? []) flarmIds.add(t.toUpperCase());
    let compDelay: number | null = null;
    let compDelaySource = '';
    if (args.class) {
        const ctx = await resolveClassContext(args.class as ClassName, args.compno as Compno | undefined);
        if (ctx.flarmIds.size === 0) {
            console.error(`no flarm ids found in tracker/trackerhistory for class=${args.class}${args.compno ? ` compno=${args.compno}` : ''}`);
        }
        for (const f of ctx.flarmIds) flarmIds.add(f);
        compDelay = ctx.delayseconds;
        compDelaySource = ctx.delayseconds != null ? `competition.delayseconds=${ctx.delayseconds}` : `competition.delayseconds=NULL, falling back to env compDelay=${getDelay()}`;
        console.error(`resolved ${ctx.flarmIds.size} flarm id(s) from DB: ${[...ctx.flarmIds].sort().join(', ') || '(none)'}`);
        console.error(`comp delay: ${compDelaySource}`);
    }
    const effectiveCompDelay = compDelay ?? (getDelay() as number);

    const makeIter = () =>
        flarmIds.size > 0
            ? loadPointsForIds({flarmIds: flarmIds as Set<string>, since: args.since, until: args.until})
            : scanAll({since: args.since, until: args.until});

    if (args['delay-stats']) {
        await delayStats(makeIter(), effectiveCompDelay);
    } else if (args.summary) {
        await summary(makeIter());
    } else {
        for await (const m of makeIter() as AsyncGenerator<any>) {
            console.log(`${d(m.t)}+${m.d ?? 0}: ${m.o} ${m.g}m  ${m.c ?? '??????'} (${m.f})  ${m.lat},${m.lng}`);
        }
    }

    await mysql.end();
    process.exit(0);
}

interface PerFlarm {
    flarmId: string;
    count: number;
    oldest: number;
    newest: number;
}

async function summary(iter: AsyncIterable<any>) {
    const stats = new Map<string, PerFlarm>();
    for await (const msg of iter) {
        const id = (msg.f ?? '??????') as string;
        let s = stats.get(id);
        if (!s) {
            s = {flarmId: id, count: 0, oldest: Infinity, newest: 0};
            stats.set(id, s);
        }
        s.count++;
        if (msg.t < s.oldest) s.oldest = msg.t;
        if (msg.t > s.newest) s.newest = msg.t;
    }
    if (stats.size === 0) {
        console.log('no tracker data in this range');
        return;
    }
    const sorted = [...stats.values()].sort((a, b) => (a.flarmId < b.flarmId ? -1 : 1));
    console.log('flarm   oldest                   newest                   count       rate');
    for (const s of sorted) {
        const span = s.newest - s.oldest;
        const rate = span > 0 ? `${(s.count / span).toFixed(2)} msg/s` : '-';
        console.log(`${s.flarmId}  ${d(s.oldest as Epoch).padEnd(22)}  ${d(s.newest as Epoch).padEnd(22)}  ${String(s.count).padStart(6)}  ${rate.padStart(9)}`);
    }
}

interface DelayStat {
    flarmId: string;
    count: number;
    sumD: number;
    minD: number;
    maxD: number;
    buckets: Map<number, number>; // d (int seconds) → count
    // Out-of-order in the per-stream sense: arrival order is writeTime order,
    // so a record whose t is less than the max t already seen for this flarm
    // arrived after a later-timestamped packet. Independent of any delay
    // setting — it's a property of the upstream stream.
    streamOOO: number;
    lastWriteTime: number;
    maxTSeen: number;
}

async function delayStats(iter: AsyncIterable<any>, compDelay: number) {
    const perFlarm = new Map<string, DelayStat>();
    const overall = mkStat('*');

    for await (const msg of iter) {
        const id = (msg.f ?? '??????') as string;
        const dVal = (msg.d ?? 0) | 0;
        const t = msg.t | 0;
        const writeTime = t + dVal;
        let s = perFlarm.get(id);
        if (!s) {
            s = mkStat(id);
            perFlarm.set(id, s);
        }
        bump(s, dVal, t, writeTime);
        bump(overall, dVal, t, writeTime);
    }

    if (overall.count === 0) {
        console.log('no tracker data in this range');
        return;
    }

    console.log('per-flarm receive-delay d statistics (seconds; d = writeTime - t)');
    console.log('flarm    count     mean    p50    p90    p95    p99    min    max   streamOOO');
    const sorted = [...perFlarm.values()].sort((a, b) => (a.flarmId < b.flarmId ? -1 : 1));
    for (const s of sorted) printRow(s);
    if (perFlarm.size > 1) {
        console.log('');
        printRow(overall);
    }

    const compTotal = compDelay + inorderAdditionalDelay;
    const sortedKeys = [...overall.buckets.keys()].sort((a, b) => a - b);
    const total = overall.count;

    console.log('');
    console.log(`packets delivered *after* the cursor (d > threshold) — absolute thresholds (compDelay=${compDelay}s, +inorderAdditionalDelay=${inorderAdditionalDelay}s ⇒ total=${compTotal}s):`);
    const absoluteThresholds = [...new Set([...THRESHOLD_OFFSETS, compDelay, compTotal])].filter((t) => t >= 0).sort((a, b) => a - b);
    printThresholdTable(sortedKeys, overall.buckets, total, absoluteThresholds, (t) => (t === compTotal ? ' ← compDelay + inorderAdditionalDelay (inorder cursor)' : t === compDelay ? ' ← compDelay (public clock)' : ''));

    console.log('');
    console.log(`packets delivered *after* the cursor (d > threshold) — relative to official delay (compDelay + N, with N from 0..${THRESHOLD_OFFSETS[THRESHOLD_OFFSETS.length - 1]}s):`);
    const relativeThresholds = THRESHOLD_OFFSETS.map((n) => compDelay + n);
    printThresholdTable(sortedKeys, overall.buckets, total, relativeThresholds, (t) => {
        const n = t - compDelay;
        return n === inorderAdditionalDelay ? ` ← compDelay + inorderAdditionalDelay (inorder cursor) [N=${n}]` : ` [N=${n}]`;
    });

    console.log('');
    console.log(`stream out-of-order packets (t < max t seen for the same flarm, regardless of delay): ${overall.streamOOO} / ${total} (${((100 * overall.streamOOO) / total).toFixed(2)}%)`);
}

// Walk the (already-sorted) thresholds in one pass over the sorted bucket
// keys: each threshold consumes every bucket whose d ≤ threshold, leaving the
// remainder as "late". Cheaper than re-bucketing per row.
function printThresholdTable(sortedKeys: number[], buckets: Map<number, number>, total: number, thresholds: number[], annotate: (t: number) => string) {
    console.log('threshold(s)     late     %     on-time<=threshold');
    let keyIdx = 0;
    let cumLEQ = 0;
    for (const t of thresholds) {
        while (keyIdx < sortedKeys.length && sortedKeys[keyIdx] <= t) {
            cumLEQ += buckets.get(sortedKeys[keyIdx])!;
            keyIdx++;
        }
        const late = total - cumLEQ;
        const pct = (100 * late) / total;
        console.log(`${String(t).padStart(11)}    ${String(late).padStart(6)}  ${pct.toFixed(2).padStart(6)}%   ${String(cumLEQ).padStart(8)}${annotate(t)}`);
    }
}

function mkStat(flarmId: string): DelayStat {
    return {flarmId, count: 0, sumD: 0, minD: Infinity, maxD: -Infinity, buckets: new Map(), streamOOO: 0, lastWriteTime: -Infinity, maxTSeen: -Infinity};
}

function bump(s: DelayStat, dVal: number, t: number, writeTime: number) {
    s.count++;
    s.sumD += dVal;
    if (dVal < s.minD) s.minD = dVal;
    if (dVal > s.maxD) s.maxD = dVal;
    s.buckets.set(dVal, (s.buckets.get(dVal) ?? 0) + 1);
    // The pointlog is monotonic in writeTime, so we'll see each flarm's
    // packets in arrival order; t < maxT means a later-arriving packet has
    // an earlier timestamp than something already received.
    if (writeTime >= s.lastWriteTime) {
        if (t < s.maxTSeen) s.streamOOO++;
        if (t > s.maxTSeen) s.maxTSeen = t;
        s.lastWriteTime = writeTime;
    }
}

function percentile(s: DelayStat, p: number): number {
    if (s.count === 0) return NaN;
    const target = Math.ceil(s.count * p);
    let seen = 0;
    const sortedKeys = [...s.buckets.keys()].sort((a, b) => a - b);
    for (const k of sortedKeys) {
        seen += s.buckets.get(k)!;
        if (seen >= target) return k;
    }
    return s.maxD;
}

function printRow(s: DelayStat) {
    const mean = (s.sumD / s.count).toFixed(2);
    console.log(
        `${s.flarmId.padEnd(6)}   ${String(s.count).padStart(6)}  ${mean.padStart(7)}  ${String(percentile(s, 0.5)).padStart(5)}  ${String(percentile(s, 0.9)).padStart(5)}  ${String(percentile(s, 0.95)).padStart(5)}  ${String(percentile(s, 0.99)).padStart(5)}  ${String(s.minD).padStart(5)}  ${String(s.maxD).padStart(5)}   ${String(s.streamOOO).padStart(8)}`
    );
}

// Resolve flarm ids for a class (and optional compno) by unioning the
// current `tracker.trackerid` with every historical `trackerhistory.flarmid`
// — covers pilots whose unit changed mid-comp. Also fetches the class's
// per-comp delayseconds (via classes → competition) for the delay-stats
// annotation. delayseconds is NULL when the operator hasn't overridden the
// default, in which case the caller falls back to the env compDelay.
async function resolveClassContext(className: ClassName, compno?: Compno): Promise<{flarmIds: Set<FlarmID>; delayseconds: number | null}> {
    const compnoFilterT = compno ? escape` AND t.compno = ${compno}` : escape``;
    const compnoFilterTh = compno ? escape` AND th.compno = ${compno}` : escape``;
    const cur = await mysql.query<{trackerid: string}[]>(
        escape`SELECT t.trackerid
                 FROM tracker t
                WHERE t.class = ${className}
                  AND t.trackerid IS NOT NULL
                  AND t.trackerid NOT IN ('', 'unknown')`.append(compnoFilterT)
    );
    const hist = await mysql.query<{flarmid: string}[]>(
        escape`SELECT DISTINCT th.flarmid
                 FROM trackerhistory th
                WHERE th.class = ${className}
                  AND th.flarmid IS NOT NULL
                  AND th.flarmid NOT IN ('', 'unknown')`.append(compnoFilterTh)
    );
    const compRows = await mysql.query<{delayseconds: number | null}[]>(
        escape`SELECT c.delayseconds
                 FROM classes cl
                 JOIN competition c ON c.compid = cl.compid
                WHERE cl.class = ${className}
                LIMIT 1`
    );
    const flarmIds = new Set<FlarmID>();
    const addAll = (raw: string | null | undefined) => {
        if (!raw) return;
        for (const part of String(raw).split(',')) {
            const id = part.trim().toUpperCase();
            if (!id || id === 'UNKNOWN') continue;
            flarmIds.add(id as FlarmID);
        }
    };
    for (const r of cur) addAll(r.trackerid);
    for (const r of hist) addAll(r.flarmid);
    const delayseconds = compRows.length && compRows[0].delayseconds != null ? Number(compRows[0].delayseconds) : null;
    return {flarmIds, delayseconds};
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
