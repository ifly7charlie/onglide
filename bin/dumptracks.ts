//
// Diagnostic: dump or summarise messages from the APRS point log, optionally
// filtered by flarm id(s), or by class (+ optional compno). Class/compno
// resolves through `tracker` (current) + `trackerhistory` (every historical
// flarmid for the same pilot), so a pilot whose unit changed mid-comp is
// covered.
//
// --delay-stats reports the distribution of receive-delay d (= writeTime - t)
// and the count of packets that would have been delivered *after* the
// display-path cursor under each candidate total-delay setting. The defaults
// to check against are NEXT_PUBLIC_COMPETITION_DELAY (compDelay) and
// compDelay + aprsAdditionalDelay (the actual PMQ drop threshold in aprs.ts).
//

import yargs from 'yargs';
import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';

import {d, getDelay} from '../lib/now';
import {aprsAdditionalDelay} from '../lib/constants';
import type {ClassName, Compno, Epoch, FlarmID} from '../lib/types';
import {loadPointsForIds, scanAll} from '../lib/webworkers/pointlog';

dotenv.config({path: '.env.local'});

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        decimalNumbers: true,
        // affectedRows = changed rows, not matched rows.
        flags: ['-FOUND_ROWS']
    },
    onError: (e: unknown) => console.error('mysql error', e),
    onConnectError: (x: unknown) => console.error('mysql connect error', x),
    maxRetries: 2
});

// Thresholds for the delay-stats tables. The same offsets are emitted twice:
// once absolute (0..120s of raw d) and once shifted by the comp's official
// delay (compDelay+0..compDelay+120) so the comp's own cursor window is the
// reference point. compDelay + aprsAdditionalDelay is folded into the
// absolute table and annotated — that is the actual display-path cursor.
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
        .option('burst-stats', {type: 'boolean', description: 'shape of PMQ-induced drops per flarm: cursor jumps (a fresh packet bumps lastTime past late ones), drop victims per jump, longest emit-gap vs raw-gap (visual dead zones)'})
        .option('comp-delay', {type: 'number', description: 'override competition.delayseconds / env compDelay (seconds). Sets the simulation cushion (eligibleAt = max(arrival, t + compDelay))'})
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
    const effectiveCompDelay = (args['comp-delay'] as number | undefined) ?? compDelay ?? (getDelay() as number);
    if (args['comp-delay'] != null) {
        console.error(`comp delay: overridden via --comp-delay=${args['comp-delay']}`);
    }

    const makeIter = () =>
        flarmIds.size > 0
            ? loadPointsForIds({flarmIds: flarmIds as Set<string>, since: args.since, until: args.until})
            : scanAll({since: args.since, until: args.until});

    if (args['delay-stats']) {
        await delayStats(makeIter(), effectiveCompDelay);
    } else if (args['burst-stats']) {
        await burstStats(makeIter(), effectiveCompDelay);
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

    const compTotal = compDelay + aprsAdditionalDelay;
    const sortedKeys = [...overall.buckets.keys()].sort((a, b) => a - b);
    const total = overall.count;

    console.log('');
    console.log(`packets delivered *after* the cursor (d > threshold) — absolute thresholds (compDelay=${compDelay}s, +aprsAdditionalDelay=${aprsAdditionalDelay}s ⇒ total=${compTotal}s):`);
    const absoluteThresholds = [...new Set([...THRESHOLD_OFFSETS, compDelay, compTotal])].filter((t) => t >= 0).sort((a, b) => a - b);
    printThresholdTable(sortedKeys, overall.buckets, total, absoluteThresholds, (t) => (t === compTotal ? ' ← compDelay + aprsAdditionalDelay (display-path cursor)' : t === compDelay ? ' ← compDelay (public clock)' : ''));

    console.log('');
    console.log(`packets delivered *after* the cursor (d > threshold) — relative to official delay (compDelay + N, with N from 0..${THRESHOLD_OFFSETS[THRESHOLD_OFFSETS.length - 1]}s):`);
    const relativeThresholds = THRESHOLD_OFFSETS.map((n) => compDelay + n);
    printThresholdTable(sortedKeys, overall.buckets, total, relativeThresholds, (t) => {
        const n = t - compDelay;
        return n === aprsAdditionalDelay ? ` ← compDelay + aprsAdditionalDelay (display-path cursor) [N=${n}]` : ` [N=${n}]`;
    });

    console.log('');
    console.log(`stream out-of-order packets (t < max t seen for the same flarm, regardless of delay): ${overall.streamOOO} / ${total} (${((100 * overall.streamOOO) / total).toFixed(2)}%)`);
}

// Simulate the PMQ drop rule per flarm, and characterise the shape of the
// resulting drops on the display path.
//
// PMQ doesn't drop on delay magnitude — a flarm whose packets are uniformly
// 25 s late still makes it through, because each packet's t > the previous
// emitted t. Drops only happen when a *fresher* packet jumps lastTime past
// timestamps that haven't yet been emitted (the late ones become victims).
//
// The display-path cushion is compDelay + aprsAdditionalDelay (the latter is
// applied at aprs.ts:1248 inside PMQ before the BroadcastChannel emit that
// feeds the websocket). The simulator below uses just compDelay as its cushion
// and exposes --comp-delay to sweep larger values — so to compare "with the
// current aprsAdditionalDelay" pass --comp-delay $((10 + 15)).
// We model each packet's eligibility as:
//
//     eligibleAt(p) = max(p.writeTime, p.t + compDelay)
//
// — fresh packets (low d) are cushion-bound and end up sorted in t-order;
// late packets (d > compDelay) are arrival-bound and slip *later* in emit
// order than their timestamp would suggest, which is precisely how they
// become drop victims. We then walk packets in (eligibleAt, t) order and
// apply the drop rule (`emit iff t > lastTime`).
//
// What we report per flarm:
//   - jumps:            count of fresh emits that bumped lastTime by > 1 s
//   - longestJump(s):   the worst single jump (cursor moved this many seconds
//                       in one step — those seconds of track are at risk)
//   - drops:            packets the simulator drops (t ≤ lastTime at emit)
//   - dup:              subset of drops whose t was already emitted (a different
//                       receiver relaying the same fix). Benign — PMQ's same-t
//                       dedup at aprs.ts:1264-1298 picks one of them anyway.
//                       drops − dup = unique fixes actually lost.
//   - clusters / max:   30-s-merged groupings of *unique* dropped timestamps
//                       (duplicates excluded — they don't create dead zones).
//                       Few large clusters → bursty / receiver-driven; many
//                       tiny ones → scattered.
//   - longestEmitGap:   longest interval between consecutive *emitted*
//                       timestamps. This is what the front-end track shows
//                       as "no data" between two vertices.
//   - longestRawGap:    same on the raw stream (flarm's real silence). The
//                       difference is the invented-by-PMQ dead zone.
const DROP_CLUSTER_MERGE_SEC = 30;

interface BurstProfile {
    flarmId: string;
    raw: number;
    emitted: number;
    dropped: number;
    droppedDuplicates: number; // subset whose t was already emitted (relays of same fix)
    jumpCount: number;
    longestJumpSeconds: number;
    totalJumpedSeconds: number;
    longestEmitGap: number;
    longestRawGap: number;
    dropClusters: number;
    largestDropCluster: number; // packets in single 30-s-merged cluster
    longestDropClusterSeconds: number; // span of that cluster
}

interface Packet {
    t: number;
    eligibleAt: number; // max(writeTime, t + cushion)
}

interface BurstState {
    prof: BurstProfile;
    packets: Packet[]; // collect everything; sort by eligibleAt then t at finalisation
}

async function burstStats(iter: AsyncIterable<any>, compDelay: number) {
    const cushion = compDelay; // sweep larger via --comp-delay; production cushion is compDelay + aprsAdditionalDelay
    const flarms = new Map<string, BurstState>();

    for await (const msg of iter) {
        const id = (msg.f ?? '??????') as string;
        const t = msg.t | 0;
        const dVal = (msg.d ?? 0) | 0;
        const writeTime = t + dVal;
        const eligibleAt = Math.max(writeTime, t + cushion);
        let s = flarms.get(id);
        if (!s) {
            s = {
                prof: {
                    flarmId: id,
                    raw: 0,
                    emitted: 0,
                    dropped: 0,
                    droppedDuplicates: 0,
                    jumpCount: 0,
                    longestJumpSeconds: 0,
                    totalJumpedSeconds: 0,
                    longestEmitGap: 0,
                    longestRawGap: 0,
                    dropClusters: 0,
                    largestDropCluster: 0,
                    longestDropClusterSeconds: 0
                },
                packets: []
            };
            flarms.set(id, s);
        }
        s.prof.raw++;
        s.packets.push({t, eligibleAt});
    }

    if (flarms.size === 0) {
        console.log('no tracker data in this range');
        return;
    }

    for (const s of flarms.values()) simulateAndFinalise(s);

    console.log(`PMQ drop simulation (per-flarm; walk in (eligibleAt, t) order; cushion = compDelay = ${cushion}s; drop iff t ≤ maxEmittedT)`);
    console.log(`drop-cluster merge window = ${DROP_CLUSTER_MERGE_SEC}s; gaps in seconds`);
    console.log('');
    console.log('flarm    raw   emit   drop    dup  jumps  longestJump  totalJumped  clusters  biggestCluster(pkts/span)  longestEmitGap  longestRawGap');
    const sorted = [...flarms.values()].sort((a, b) => (a.prof.flarmId < b.prof.flarmId ? -1 : 1));
    for (const s of sorted) printBurstRow(s.prof);

    if (flarms.size > 1) {
        const agg = aggregateBurstProfiles([...flarms.values()].map((s) => s.prof));
        console.log('');
        printBurstRow(agg);
    }
}

function simulateAndFinalise(s: BurstState) {
    // Emit order: (eligibleAt, t). Stable on t within same eligibleAt so PMQ's
    // intra-tick t-ordered emission is preserved.
    s.packets.sort((a, b) => a.eligibleAt - b.eligibleAt || a.t - b.t);

    let maxEmittedT = -Infinity;
    const emittedSet = new Set<number>();
    const emittedTs: number[] = [];
    const droppedTs: number[] = [];

    for (const pkt of s.packets) {
        if (pkt.t > maxEmittedT) {
            const jump = maxEmittedT === -Infinity ? 0 : pkt.t - maxEmittedT;
            if (jump > 1) {
                s.prof.jumpCount++;
                s.prof.totalJumpedSeconds += jump - 1;
                if (jump > s.prof.longestJumpSeconds) s.prof.longestJumpSeconds = jump;
            }
            maxEmittedT = pkt.t;
            s.prof.emitted++;
            emittedTs.push(pkt.t);
            emittedSet.add(pkt.t);
        } else {
            s.prof.dropped++;
            if (emittedSet.has(pkt.t)) {
                s.prof.droppedDuplicates++;
            } else {
                droppedTs.push(pkt.t);
            }
        }
    }

    // emittedTs accumulates in emit order — for gap-on-the-track analysis we
    // want consecutive timestamps in time order. Each emit advances
    // maxEmittedT, so emittedTs is already monotonic — but we sort defensively.
    emittedTs.sort((a, b) => a - b);
    droppedTs.sort((a, b) => a - b);

    s.prof.longestEmitGap = longestConsecutiveGap(emittedTs);
    s.prof.longestRawGap = longestConsecutiveGap(s.packets.map((p) => p.t).sort((a, b) => a - b));

    let clusterStart = -1;
    let clusterEnd = -1;
    let clusterCount = 0;
    for (const t of droppedTs) {
        if (clusterStart < 0 || t - clusterEnd > DROP_CLUSTER_MERGE_SEC) {
            if (clusterStart >= 0) closeCluster(s.prof, clusterStart, clusterEnd, clusterCount);
            clusterStart = t;
            clusterEnd = t;
            clusterCount = 1;
        } else {
            clusterEnd = t;
            clusterCount++;
        }
    }
    if (clusterStart >= 0) closeCluster(s.prof, clusterStart, clusterEnd, clusterCount);
}

function closeCluster(p: BurstProfile, start: number, end: number, count: number) {
    p.dropClusters++;
    if (count > p.largestDropCluster) {
        p.largestDropCluster = count;
        p.longestDropClusterSeconds = end - start;
    }
}

function longestConsecutiveGap(sortedTs: number[]): number {
    let max = 0;
    for (let i = 1; i < sortedTs.length; i++) {
        const g = sortedTs[i] - sortedTs[i - 1];
        if (g > max) max = g;
    }
    return max;
}

function aggregateBurstProfiles(profiles: BurstProfile[]): BurstProfile {
    const agg: BurstProfile = {
        flarmId: '*',
        raw: 0,
        emitted: 0,
        dropped: 0,
        droppedDuplicates: 0,
        jumpCount: 0,
        longestJumpSeconds: 0,
        totalJumpedSeconds: 0,
        longestEmitGap: 0,
        longestRawGap: 0,
        dropClusters: 0,
        largestDropCluster: 0,
        longestDropClusterSeconds: 0
    };
    for (const p of profiles) {
        agg.raw += p.raw;
        agg.emitted += p.emitted;
        agg.dropped += p.dropped;
        agg.droppedDuplicates += p.droppedDuplicates;
        agg.jumpCount += p.jumpCount;
        agg.totalJumpedSeconds += p.totalJumpedSeconds;
        agg.dropClusters += p.dropClusters;
        if (p.longestJumpSeconds > agg.longestJumpSeconds) agg.longestJumpSeconds = p.longestJumpSeconds;
        if (p.longestEmitGap > agg.longestEmitGap) agg.longestEmitGap = p.longestEmitGap;
        if (p.longestRawGap > agg.longestRawGap) agg.longestRawGap = p.longestRawGap;
        if (p.largestDropCluster > agg.largestDropCluster) {
            agg.largestDropCluster = p.largestDropCluster;
            agg.longestDropClusterSeconds = p.longestDropClusterSeconds;
        }
    }
    return agg;
}

function printBurstRow(p: BurstProfile) {
    const cluster = p.largestDropCluster > 0 ? `${p.largestDropCluster}/${p.longestDropClusterSeconds}s` : '-';
    console.log(
        `${p.flarmId.padEnd(6)}  ${String(p.raw).padStart(5)}  ${String(p.emitted).padStart(5)}  ${String(p.dropped).padStart(5)}  ${String(p.droppedDuplicates).padStart(5)}  ${String(p.jumpCount).padStart(5)}  ${String(p.longestJumpSeconds).padStart(11)}  ${String(p.totalJumpedSeconds).padStart(11)}  ${String(p.dropClusters).padStart(8)}  ${cluster.padStart(25)}  ${String(p.longestEmitGap).padStart(14)}  ${String(p.longestRawGap).padStart(13)}`
    );
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
