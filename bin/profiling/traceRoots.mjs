#!/usr/bin/env node
// Find what's driving a continuous render loop in a Chrome perf trace.
//
// Usage: node bin/profiling/traceRoots.mjs <trace.json>
//
// Reports:
//  - top stacks immediately under deck.gl's _animationFrame (what's making it draw)
//  - top entry roots for samples that include a MapLibre/deck render
//  - a few full sample stacks containing _animationFrame for inspection
import fs from 'fs';

const path = process.argv[2];
if (!path) {
    console.error('usage: node bin/profiling/traceRoots.mjs <trace.json>');
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const events = Array.isArray(data) ? data : data.traceEvents;

const nodeById = new Map();
const parentOf = new Map();
const samples = [];
for (const ev of events) {
    if (ev.name !== 'Profile' && ev.name !== 'ProfileChunk') continue;
    const cpu = ev.args?.data?.cpuProfile;
    if (cpu?.nodes)
        for (const n of cpu.nodes) {
            nodeById.set(n.id, n);
            if (n.parent != null) parentOf.set(n.id, n.parent);
            if (n.children) for (const c of n.children) parentOf.set(c, n.id);
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

function stackOf(leaf) {
    const out = [];
    let cur = leaf;
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
        seen.add(cur);
        const n = nodeById.get(cur);
        const cf = n?.callFrame || {};
        const loc = (cf.url || '').split('/').pop() + ':' + cf.lineNumber;
        out.push((cf.functionName || '(anon)') + '@' + loc);
        cur = parentOf.get(cur);
    }
    return out;
}

const animationFrameStacks = new Map();
for (const s of samples) {
    const stack = stackOf(s.node);
    const hasAnim = stack.findIndex((f) => f.startsWith('_animationFrame@'));
    if (hasAnim < 0) continue;
    const key = stack.slice(0, Math.min(hasAnim, 4)).join(' <- ');
    animationFrameStacks.set(key, (animationFrameStacks.get(key) || 0) + 1);
}
console.log('--- top stacks under _animationFrame (leaf<-...<-anim) ---');
[...animationFrameStacks.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([k, v]) => console.log(v, k));

const rootCount = new Map();
for (const s of samples) {
    const stack = stackOf(s.node);
    if (!stack.some((f) => f.startsWith('_render@') || f.startsWith('render@'))) continue;
    let i = stack.length - 1;
    while (i > 0 && /^(\(root\)|\(program\)|\(idle\)|\(garbage)/.test(stack[i])) i--;
    rootCount.set(stack[i], (rootCount.get(stack[i]) || 0) + 1);
}
console.log('\n--- entry roots for render-containing samples ---');
[...rootCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([k, v]) => console.log(v, k));

console.log('\n--- 3 sample full stacks containing _animationFrame ---');
let shown = 0;
for (const s of samples) {
    const stack = stackOf(s.node);
    if (!stack.some((f) => f.startsWith('_animationFrame@'))) continue;
    if (shown++ >= 3) break;
    console.log('STACK', shown);
    stack.forEach((f, i) => console.log('  ', i, f));
}
