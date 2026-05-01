#!/usr/bin/env node
//
// Chrome trace analyzer for onglide perf work.
//
// Usage:
//   node bin/trace.js <file> stats                    high-level overview
//   node bin/trace.js <file> long [minMs=100] [tid]   list long main-thread tasks
//   node bin/trace.js <file> hot [limit=25]           top profile functions (whole trace)
//   node bin/trace.js <file> window <ts> <dur>        top profile functions in a time window
//   node bin/trace.js <file> children <ts> <dur> [tid]  main-thread children inside a window
//
// Timestamps are microseconds, matching Chrome's raw trace format. The `long` and
// `window` commands print timestamps that you can feed back into `window`/`children`.

import fs from 'fs';
import {fileURLToPath} from 'url';

function load(path) {
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    return Array.isArray(data) ? data : data.traceEvents;
}

function buildProfile(events) {
    const nodeById = new Map();
    const parentOf = new Map();
    const samples = []; // {ts, node}
    for (const ev of events) {
        if (ev.name !== 'Profile' && ev.name !== 'ProfileChunk') continue;
        const cpu = ev.args?.data?.cpuProfile;
        if (cpu?.nodes) {
            for (const n of cpu.nodes) {
                nodeById.set(n.id, n);
                if (n.parent != null) parentOf.set(n.id, n.parent);
                if (n.children) for (const c of n.children) parentOf.set(c, n.id);
            }
        }
        const deltas = ev.args?.data?.timeDeltas;
        if (cpu?.samples && deltas) {
            let t = ev.ts;
            for (let i = 0; i < cpu.samples.length; i++) {
                t += deltas[i];
                samples.push({ts: t, node: cpu.samples[i]});
            }
        }
    }
    return {nodeById, parentOf, samples};
}

function topAncestors(samples, parentOf, nodeById, limit = 25) {
    const cnt = new Map();
    for (const s of samples) {
        let cur = s.node;
        const seen = new Set();
        while (cur != null && !seen.has(cur)) {
            seen.add(cur);
            cnt.set(cur, (cnt.get(cur) || 0) + 1);
            cur = parentOf.get(cur);
        }
    }
    const skip = new Set(['(idle)', 'idle', '(program)', '(garbage collector)', '(root)']);
    const out = [];
    for (const {id, c} of [...cnt.entries()].map(([id, c]) => ({id, c})).sort((a, b) => b.c - a.c)) {
        const n = nodeById.get(id);
        const cf = n?.callFrame || {};
        const name = cf.functionName || '(anon)';
        if (skip.has(name)) continue;
        const loc = (cf.url || '').split('/').pop() + ':' + cf.lineNumber;
        out.push(`${c}\t${name} @ ${loc}`);
        if (out.length >= limit) break;
    }
    return out;
}

function ms(us) {
    return (us / 1000).toFixed(1) + 'ms';
}

function cmdStats(events) {
    // Frame cadence
    const frames = events.filter((e) => e.ph === 'X' && e.name === 'FireAnimationFrame' && e.dur).sort((a, b) => a.ts - b.ts);
    if (frames.length) {
        const span = (frames.at(-1).ts + frames.at(-1).dur - frames[0].ts) / 1000;
        const tot = frames.reduce((s, f) => s + f.dur, 0) / 1000;
        console.log(`frames: n=${frames.length} span=${span.toFixed(0)}ms fps=${((frames.length / span) * 1000).toFixed(1)} avgFrame=${(tot / frames.length).toFixed(2)}ms totalInFrames=${tot.toFixed(0)}ms`);
    }

    // EventDispatch breakdown
    console.log('\n-- EventDispatch --');
    const byEv = new Map();
    for (const e of events) {
        if (e.ph !== 'X' || e.name !== 'EventDispatch' || !e.dur) continue;
        const t = e.args?.data?.type || '?';
        const c = byEv.get(t) || {n: 0, dur: 0, max: 0};
        c.n++;
        c.dur += e.dur;
        if (e.dur > c.max) c.max = e.dur;
        byEv.set(t, c);
    }
    for (const [k, v] of [...byEv.entries()].sort((a, b) => b[1].dur - a[1].dur).slice(0, 12)) {
        console.log(`  ${ms(v.dur)} n=${v.n} max=${ms(v.max)} ${k}`);
    }

    // RunTask by tid
    console.log('\n-- RunTask by tid --');
    const byTid = new Map();
    for (const e of events) {
        if (e.ph !== 'X' || e.name !== 'RunTask' || !e.dur) continue;
        const a = byTid.get(e.tid) || {n: 0, dur: 0};
        a.n++;
        a.dur += e.dur;
        byTid.set(e.tid, a);
    }
    const tidSorted = [...byTid.entries()].sort((a, b) => b[1].dur - a[1].dur);
    for (const [tid, a] of tidSorted.slice(0, 6)) {
        console.log(`  tid=${tid} n=${a.n} dur=${(a.dur / 1000).toFixed(0)}ms`);
    }
    if (tidSorted[0]) console.log(`(main thread is likely tid=${tidSorted[0][0]})`);
}

function cmdLong(events, minMs = 100, tidFilter) {
    const minUs = Number(minMs) * 1000;
    const tid = tidFilter ? Number(tidFilter) : null;
    const byTid = new Map();
    for (const e of events) {
        if (e.ph !== 'X' || e.name !== 'RunTask' || !e.dur) continue;
        const a = byTid.get(e.tid) || {n: 0, dur: 0};
        a.n++;
        a.dur += e.dur;
        byTid.set(e.tid, a);
    }
    const mainTid = tid ?? [...byTid.entries()].sort((a, b) => b[1].dur - a[1].dur)[0]?.[0];
    const long = events.filter((e) => e.ph === 'X' && e.name === 'RunTask' && e.tid === mainTid && e.dur >= minUs).sort((a, b) => a.ts - b.ts);
    console.log(`long tasks on tid=${mainTid} (>=${minMs}ms): n=${long.length}`);
    for (const t of long) console.log(`  ${ms(t.dur)} @ ${t.ts}`);
}

function cmdHot(events, limit = 25) {
    const {nodeById, parentOf, samples} = buildProfile(events);
    console.log(`total samples: ${samples.length}`);
    for (const line of topAncestors(samples, parentOf, nodeById, Number(limit))) console.log(line);
}

function cmdWindow(events, ts, dur) {
    const s = Number(ts);
    const e = s + Number(dur);
    const {nodeById, parentOf, samples} = buildProfile(events);
    const inWin = samples.filter((x) => x.ts >= s && x.ts <= e);
    console.log(`window [${s}, ${e}) samples: ${inWin.length}`);
    for (const line of topAncestors(inWin, parentOf, nodeById, 25)) console.log(line);
}

function cmdChildren(events, ts, dur, tidArg) {
    const s = Number(ts);
    const e = s + Number(dur);
    const tid = tidArg ? Number(tidArg) : null;
    const kids = events.filter((x) => x.ph === 'X' && x.ts >= s && x.ts + (x.dur || 0) <= e && x.dur && (tid == null || x.tid === tid));
    kids.sort((a, b) => b.dur - a.dur);
    console.log(`events in [${s}, ${e})${tid ? ' tid=' + tid : ''}: ${kids.length}`);
    for (const k of kids.slice(0, 20)) {
        const extra = JSON.stringify(k.args?.data?.functionName || k.args?.data?.url || k.args?.data?.type || '').slice(0, 80);
        console.log(`  ${ms(k.dur)} ${k.name} ${extra}`);
    }
}

// --- main ---
const [file, cmd, ...rest] = process.argv.slice(2);
if (!file || !cmd) {
    const self = fileURLToPath(import.meta.url);
    console.error(fs.readFileSync(self, 'utf8').split('\n').slice(2, 14).join('\n'));
    process.exit(1);
}
const events = load(file);
switch (cmd) {
    case 'stats':
        cmdStats(events);
        break;
    case 'long':
        cmdLong(events, rest[0], rest[1]);
        break;
    case 'hot':
        cmdHot(events, rest[0]);
        break;
    case 'window':
        cmdWindow(events, rest[0], rest[1]);
        break;
    case 'children':
        cmdChildren(events, rest[0], rest[1], rest[2]);
        break;
    default:
        console.error(`unknown command: ${cmd}`);
        process.exit(1);
}
