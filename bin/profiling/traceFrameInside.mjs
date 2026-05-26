#!/usr/bin/env node
// For each FireAnimationFrame on the main thread, classify what runs inside:
//   - MapLibre paint (_render)
//   - deck.gl redraw
//   - other (React render, layout, etc.)
//
// Helps answer "is the map painting every frame or just deck.gl?"

import fs from 'fs';

const path = process.argv[2];
if (!path) {
    console.error('usage: node bin/profiling/traceFrameInside.mjs <trace.json>');
    process.exit(1);
}
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const events = Array.isArray(data) ? data : data.traceEvents;

const main = events
    .filter((e) => e.ph === 'X' && e.dur && e.tid)
    .reduce((m, e) => {
        m.set(e.tid, (m.get(e.tid) || 0) + e.dur);
        return m;
    }, new Map());
const mainTid = [...main.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log('main tid:', mainTid);

const onMain = events.filter((e) => e.ph === 'X' && e.dur && e.tid === mainTid);
const rafs = onMain.filter((e) => e.name === 'FireAnimationFrame').sort((a, b) => a.ts - b.ts);
console.log('FireAnimationFrame count:', rafs.length);

// Use Profile samples for per-RAF deep classification
const nodeById = new Map(),
    parentOf = new Map(),
    samples = [];
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
        out.push(cf.functionName || '(anon)');
        cur = parentOf.get(cur);
    }
    return out;
}

// Per-RAF: do any samples land inside it with a MapLibre paint stack?
// Identify MapLibre paint by presence of `_renderTileClippingMasks` or `renderLayer` in stack
let mapPaintRafs = 0;
let deckOnlyRafs = 0;
let emptyRafs = 0;
let bothRafs = 0;
for (const raf of rafs) {
    const sl = [];
    // binary search would be nicer but linear is fine
    for (const s of samples) {
        if (s.ts < raf.ts) continue;
        if (s.ts > raf.ts + raf.dur) break;
        sl.push(s);
    }
    let hasMap = false,
        hasDeck = false;
    for (const s of sl) {
        const st = stackOf(s.node);
        if (st.some((f) => f === '_renderTileClippingMasks' || f === 'renderLayer' || f === '_render')) hasMap = true;
        if (st.some((f) => f === '_animationFrame' || f === 'redraw' || f === '_renderFrame')) hasDeck = true;
    }
    if (hasMap && hasDeck) bothRafs++;
    else if (hasMap) mapPaintRafs++;
    else if (hasDeck) deckOnlyRafs++;
    else emptyRafs++;
}
console.log('per-RAF classification:');
console.log('  both MapLibre paint + deck redraw:', bothRafs);
console.log('  MapLibre paint only:', mapPaintRafs);
console.log('  deck redraw only:', deckOnlyRafs);
console.log('  neither (empty / short):', emptyRafs);

// What does the deck.gl AnimationLoop do when MapLibre is NOT painting?
// Look at samples in deck-only RAFs — what stacks dominate?
const deckOnlyStackCounts = new Map();
let deckOnlySamples = 0;
for (const raf of rafs) {
    // re-find sl
    const sl = [];
    for (const s of samples) {
        if (s.ts < raf.ts) continue;
        if (s.ts > raf.ts + raf.dur) break;
        sl.push(s);
    }
    let hasMap = false;
    let hasDeck = false;
    for (const s of sl) {
        const st = stackOf(s.node);
        if (st.some((f) => f === '_renderTileClippingMasks' || f === 'renderLayer' || f === '_render')) hasMap = true;
        if (st.some((f) => f === '_animationFrame' || f === 'redraw' || f === '_renderFrame')) hasDeck = true;
    }
    if (hasDeck && !hasMap) {
        for (const s of sl) {
            deckOnlySamples++;
            const st = stackOf(s.node);
            // top 3 leaf frames
            const key = st.slice(0, 3).join(' / ');
            deckOnlyStackCounts.set(key, (deckOnlyStackCounts.get(key) || 0) + 1);
        }
    }
}
console.log('\ndeck-only RAF samples:', deckOnlySamples);
console.log('top stacks in deck-only RAFs:');
[...deckOnlyStackCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([k, v]) => console.log('  ', v, k));

// And what makes MapLibre repaint? Look for triggerRepaint callers
let triggerRepaintCount = 0;
const triggerCallers = new Map();
for (const s of samples) {
    const st = stackOf(s.node);
    const i = st.indexOf('triggerRepaint');
    if (i < 0) continue;
    triggerRepaintCount++;
    const caller = st.slice(i + 1, i + 6).join(' <- ');
    triggerCallers.set(caller, (triggerCallers.get(caller) || 0) + 1);
}
console.log('\ntriggerRepaint samples:', triggerRepaintCount);
console.log('top callers of triggerRepaint:');
[...triggerCallers.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([k, v]) => console.log('  ', v, k));
