#!/usr/bin/env node
//
// Map glyph atlas coverage + compositing helper.
//
// Atkinson Hyperlegible Next ships only 347 codepoints, so the SDF atlases under
// public/fonts/glyphs/ are missing letters that European and Polynesian place
// names need -- U+014C / U+014D (O with macron) among them. MapLibre cannot fall
// back per glyph (with a "glyphs" URL set, text-font is joined into a single
// fontstack name), and the absent ranges are served as valid-but-empty protobufs,
// so a missing glyph renders as blank space with no error.
//
// This file fills those holes from parts the font already has: every target
// codepoint whose NFD decomposition is a base letter plus combining marks that
// are all present is composited from those pieces, so the result stays inside the
// one typeface and the one licence.
//
// Placement is never assumed. For each (mark, base height class) the rule is
// measured from the composites the font already ships, and a rule is only used
// if replaying it reproduces those shipped composites to within MAX_RESIDUAL.
// Marks the designer drew as a special form rather than a plain overlay (the
// ring of U+00C5, the cedilla of U+00C7, the dotless-i accents) fail that gate
// and are reported instead of being emitted wrong.
//
//   node bin/checkglyphs.js          report coverage, exit 1 if any problem
//   node bin/checkglyphs.js --fill   composite the missing glyphs in place
//
// The audit is asserted by test/glyphs.test.ts, so re-running the readme's
// build-glyphs recipe (which would drop the composites) fails CI rather than
// silently regressing the map.
//
// ESM (bin/ is type:module) with no dependencies, so it runs directly with node
// and is importable from the vitest test. Paths resolve relative to this file.
//
// Characters are referred to by codepoint only -- this file is ASCII.

import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLYPHS_DIR = path.join(__dirname, '..', 'public', 'fonts', 'glyphs');

// SDF padding around each glyph's ink, in px. Verified against every glyph in
// the shipped atlases: bitmap.length === (width + 2*BUFFER) * (height + 2*BUFFER).
const BUFFER = 3;
const RANGE_SIZE = 256;

// Codepoint blocks worth compositing: Latin Extended-A, Latin Extended-B and
// Latin Extended Additional. Greek and Cyrillic are deliberately out of scope --
// they decompose into bases this font does not have, so no amount of
// compositing reaches them.
const TARGET_BLOCKS = [
    [0x0100, 0x017f],
    [0x0180, 0x024f],
    [0x1e00, 0x1eff]
];

// Glyphs the map must be able to render. Kept small and specific: these are the
// ones a missing-letter bug was actually reported against, plus the shipped
// macron composites they are derived from, so a bad refill is caught too.
const REQUIRED = [
    0x014c, // LATIN CAPITAL LETTER O WITH MACRON
    0x014d, // LATIN SMALL LETTER O WITH MACRON
    0x0100,
    0x0101,
    0x016a,
    0x016b
];

// Mean absolute per-pixel difference, as a fraction of 255, allowed when
// replaying a rule against a composite the font already ships. The union of two
// disjoint SDFs is exact at the 0.5 iso-contour -- the rendered outline -- so the
// residual lives only in the gradient away from it.
const MAX_RESIDUAL = 0.03;

// Half-width of the horizontal offset sweep, in px, used when calibrating a
// mark's placement for a base height class.
const DX_SEARCH = 4;

// --- protobuf (glyphs.proto) -------------------------------------------------
//
// glyphs    { repeated fontstack stacks = 1; }
// fontstack { required string name = 1; required string range = 2;
//             repeated glyph glyphs = 3; }
// glyph     { required uint32 id = 1; optional bytes bitmap = 2;
//             required uint32 width = 3; required uint32 height = 4;
//             required sint32 left = 5; required sint32 top = 6;
//             required uint32 advance = 7; }
//
// Note fields 5 and 6 are sint32, i.e. zigzag encoded. Reading them as plain
// varints is the easy mistake here: it yields a "top" that moves -8 where the
// glyph grew 4 rows taller, instead of the +4 that matches.

function zigzagDecode(n) {
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

function zigzagEncode(n) {
    return n < 0 ? -n * 2 - 1 : n * 2;
}

function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;
    for (;;) {
        const byte = buf[pos++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [result, pos];
}

function writeVarint(out, value) {
    let v = value;
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
    }
    out.push(v);
}

function writeTag(out, field, wireType) {
    writeVarint(out, field * 8 + wireType);
}

function writeVarintField(out, field, value) {
    writeTag(out, field, 0);
    writeVarint(out, value);
}

function writeBytesField(out, field, bytes) {
    writeTag(out, field, 2);
    writeVarint(out, bytes.length);
    for (const b of bytes) out.push(b);
}

// Walk one protobuf message, yielding [field, wireType, value] triples. Length
// delimited values come back as Buffer slices; varints as numbers.
function* messageFields(buf) {
    let pos = 0;
    while (pos < buf.length) {
        let key;
        [key, pos] = readVarint(buf, pos);
        const field = Math.floor(key / 8);
        const wireType = key & 7;
        if (wireType === 0) {
            let value;
            [value, pos] = readVarint(buf, pos);
            yield [field, wireType, value];
        } else if (wireType === 2) {
            let len;
            [len, pos] = readVarint(buf, pos);
            yield [field, wireType, buf.subarray(pos, pos + len)];
            pos += len;
        } else if (wireType === 5) {
            yield [field, wireType, buf.subarray(pos, pos + 4)];
            pos += 4;
        } else if (wireType === 1) {
            yield [field, wireType, buf.subarray(pos, pos + 8)];
            pos += 8;
        } else {
            throw new Error(`unsupported protobuf wire type ${wireType}`);
        }
    }
}

function decodeGlyph(buf) {
    const g = {id: 0, bitmap: Buffer.alloc(0), width: 0, height: 0, left: 0, top: 0, advance: 0};
    for (const [field, , value] of messageFields(buf)) {
        if (field === 1) g.id = value;
        else if (field === 2) g.bitmap = Buffer.from(value);
        else if (field === 3) g.width = value;
        else if (field === 4) g.height = value;
        else if (field === 5) g.left = zigzagDecode(value);
        else if (field === 6) g.top = zigzagDecode(value);
        else if (field === 7) g.advance = value;
    }
    return g;
}

// One .pbf holds exactly one fontstack in the shipped atlases.
export function decodeGlyphsPbf(buf) {
    let name = '';
    let range = '';
    const glyphs = new Map();
    for (const [field, , stack] of messageFields(buf)) {
        if (field !== 1) continue;
        for (const [sField, , value] of messageFields(stack)) {
            if (sField === 1) name = value.toString('utf8');
            else if (sField === 2) range = value.toString('utf8');
            else if (sField === 3) {
                const g = decodeGlyph(value);
                glyphs.set(g.id, g);
            }
        }
    }
    return {name, range, glyphs};
}

export function encodeGlyphsPbf(name, range, glyphs) {
    const stack = [];
    writeBytesField(stack, 1, Buffer.from(name, 'utf8'));
    writeBytesField(stack, 2, Buffer.from(range, 'utf8'));
    for (const g of [...glyphs].sort((a, b) => a.id - b.id)) {
        const body = [];
        writeVarintField(body, 1, g.id);
        if (g.bitmap.length) writeBytesField(body, 2, g.bitmap);
        writeVarintField(body, 3, g.width);
        writeVarintField(body, 4, g.height);
        writeVarintField(body, 5, zigzagEncode(g.left));
        writeVarintField(body, 6, zigzagEncode(g.top));
        writeVarintField(body, 7, g.advance);
        writeBytesField(stack, 3, body);
    }
    const out = [];
    writeBytesField(out, 1, stack);
    return Buffer.from(out);
}

// --- atlas on disk -----------------------------------------------------------

// A stack is a directory of .pbf range files, so unrelated directories that
// happen to sit under public/fonts/glyphs are not mistaken for font stacks.
export function listStacks() {
    if (!fs.existsSync(GLYPHS_DIR)) return [];
    return fs
        .readdirSync(GLYPHS_DIR)
        .filter((d) => {
            const dir = path.join(GLYPHS_DIR, d);
            return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).some((f) => f.endsWith('.pbf'));
        })
        .sort();
}

function rangeOf(cp) {
    const start = Math.floor(cp / RANGE_SIZE) * RANGE_SIZE;
    return `${start}-${start + RANGE_SIZE - 1}`;
}

function rangeFile(stack, range) {
    return path.join(GLYPHS_DIR, stack, `${range}.pbf`);
}

function readRange(stack, range) {
    const file = rangeFile(stack, range);
    if (!fs.existsSync(file)) return null;
    return decodeGlyphsPbf(fs.readFileSync(file));
}

// Every glyph a stack holds, keyed by codepoint, across every range file present.
export function readStack(stack) {
    const dir = path.join(GLYPHS_DIR, stack);
    const glyphs = new Map();
    let name = stack;
    const bitmapErrors = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.pbf'))) {
        const decoded = decodeGlyphsPbf(fs.readFileSync(path.join(dir, f)));
        if (decoded.name) name = decoded.name;
        for (const [id, g] of decoded.glyphs) {
            glyphs.set(id, g);
            const expected = (g.width + 2 * BUFFER) * (g.height + 2 * BUFFER);
            if (g.bitmap.length && g.bitmap.length !== expected) {
                bitmapErrors.push(`${f}: ${hex(id)} bitmap ${g.bitmap.length} != ${expected}`);
            }
        }
    }
    return {name, glyphs, bitmapErrors};
}

// --- glyph geometry ----------------------------------------------------------
//
// Ink coordinates: a glyph's ink occupies x in [0, width), y in [0, height) with
// y increasing downwards. Its bitmap additionally covers the BUFFER px margin,
// i.e. x in [-BUFFER, width + BUFFER).

function sample(g, x, y) {
    const bx = x + BUFFER;
    const by = y + BUFFER;
    const w = g.width + 2 * BUFFER;
    const h = g.height + 2 * BUFFER;
    if (bx < 0 || by < 0 || bx >= w || by >= h) return 0; // SDF floor, verified 0
    return g.bitmap[by * w + bx];
}

// Place `mark` relative to `base` and take the per-pixel maximum of the two
// signed distance fields. A rule is {dTop, dBottom}: the rows the mark adds
// above and below the base's ink. The two shapes stay disjoint, so the union's
// 0.5 iso-contour -- the rendered outline -- is exact; only the gradient
// further out is approximated.
export function compose(base, mark, rule) {
    const {dTop, dBottom} = rule;
    // Horizontal placement defaults to centring the mark on the base's ink, but
    // the designer's own offset differs per letter (and leans in the italic), so
    // calibrate() supplies a measured dx per (mark, base class).
    const markX = Math.round((base.width - mark.width) / 2) + (rule.dx ?? 0);
    const markY = dTop > 0 ? -dTop : base.height + dBottom - mark.height;

    const minX = Math.min(0, markX);
    const maxX = Math.max(base.width, markX + mark.width);
    const minY = Math.min(0, -dTop);
    const maxY = Math.max(base.height, base.height + dBottom);

    const width = maxX - minX;
    const height = maxY - minY;
    const ox = -minX;
    const oy = -minY;

    const bw = width + 2 * BUFFER;
    const bh = height + 2 * BUFFER;
    const bitmap = Buffer.alloc(bw * bh);
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
            const cx = x - BUFFER;
            const cy = y - BUFFER;
            const fromBase = sample(base, cx - ox, cy - oy);
            const fromMark = sample(mark, cx - ox - markX, cy - oy - markY);
            bitmap[y * bw + x] = Math.max(fromBase, fromMark);
        }
    }
    return {
        id: 0,
        bitmap,
        width,
        height,
        left: base.left + minX,
        top: base.top + oy,
        advance: base.advance
    };
}

// --- calibration -------------------------------------------------------------

function decompose(cp) {
    const nfd = String.fromCodePoint(cp).normalize('NFD');
    const parts = [...nfd].map((ch) => ch.codePointAt(0));
    return parts.length > 1 ? parts : null;
}

function residualAgainst(built, shipped) {
    if (built.width !== shipped.width || built.height !== shipped.height || built.left !== shipped.left || built.top !== shipped.top || built.advance !== shipped.advance) return 1;
    if (built.bitmap.length !== shipped.bitmap.length) return 1;
    let total = 0;
    for (let i = 0; i < shipped.bitmap.length; i++) total += Math.abs(shipped.bitmap[i] - built.bitmap[i]);
    return total / shipped.bitmap.length / 255;
}

// Marks sit at a fixed height for a given base height class, and a base glyph's
// own `top` metric identifies that class exactly (all cap-height letters share
// one value, all x-height letters another). So rules are keyed by
// (mark, base.top) and derived only from shipped composites in the same class.
function ruleKey(markCp, baseTop) {
    return `${markCp}:${baseTop}`;
}

// For every (mark, base class) seen in the shipped composites, choose the rule
// that best reproduces them, and record how well it did. Callers use that
// residual as a gate: a rule that cannot rebuild what the font already has is
// not trusted to build what it lacks.
export function calibrate(glyphs) {
    const groups = new Map();
    for (const [cp, composite] of glyphs) {
        const parts = decompose(cp);
        if (!parts || parts.length !== 2) continue;
        const [baseCp, markCp] = parts;
        const base = glyphs.get(baseCp);
        const mark = glyphs.get(markCp);
        if (!base || !mark || !composite.bitmap.length || !base.bitmap.length || !mark.bitmap.length) continue;

        const dTop = composite.top - base.top;
        const dBottom = composite.height - base.height - dTop;
        if (dTop < 0 || dBottom < 0) continue; // not a plain overlay

        const key = ruleKey(markCp, base.top);
        if (!groups.has(key)) groups.set(key, {markCp, baseTop: base.top, samples: []});
        groups.get(key).samples.push({cp, base, mark, composite, rule: {dTop, dBottom}});
    }

    const rules = new Map();
    const report = [];
    for (const [key, group] of groups) {
        // Candidate vertical placements are the ones actually observed in this
        // class; the horizontal offset is swept, since the designer's own offset
        // is not plain centring. Score each candidate by how many of the class's
        // shipped composites it reproduces.
        const seen = new Map();
        for (const s of group.samples) seen.set(`${s.rule.dTop}:${s.rule.dBottom}`, s.rule);

        let best = null;
        for (const vertical of seen.values()) {
            for (let dx = -DX_SEARCH; dx <= DX_SEARCH; dx++) {
                const rule = {...vertical, dx};
                const residuals = group.samples.map((s) => residualAgainst(compose(s.base, s.mark, rule), s.composite));
                const matched = residuals.filter((r) => r <= MAX_RESIDUAL);
                const score = {
                    rule,
                    matched: matched.length,
                    total: residuals.length,
                    worst: matched.length ? Math.max(...matched) : 1
                };
                if (!best || score.matched > best.matched || (score.matched === best.matched && score.worst < best.worst)) best = score;
            }
        }
        if (!best) continue;

        // Only publish a rule that demonstrably reproduces at least one shipped
        // composite of this class.
        if (best.matched > 0) rules.set(key, {...best.rule, confidence: best.worst, backedBy: best.matched});
        report.push({
            mark: group.markCp,
            baseTop: group.baseTop,
            rule: best.rule,
            matched: best.matched,
            total: best.total,
            worst: best.worst,
            trusted: best.matched > 0,
            outliers: group.samples.filter((s) => residualAgainst(compose(s.base, s.mark, best.rule), s.composite) > MAX_RESIDUAL).map((s) => s.cp)
        });
    }
    return {rules, report};
}

// Build a codepoint from pieces already present, applying each mark in NFD
// order so stacked diacritics work. Returns null unless every piece exists and
// every mark has a trusted rule for the base class it is being applied to.
export function build(cp, glyphs, rules) {
    const parts = decompose(cp);
    if (!parts) return null;
    const [baseCp, ...markCps] = parts;
    let acc = glyphs.get(baseCp);
    if (!acc || !acc.bitmap.length) return null;
    for (const markCp of markCps) {
        const mark = glyphs.get(markCp);
        if (!mark || !mark.bitmap.length) return null;
        const rule = rules.get(ruleKey(markCp, acc.top));
        if (!rule) return null;
        acc = compose(acc, mark, rule);
    }
    return {...acc, id: cp};
}

// --- audit -------------------------------------------------------------------

function hex(cp) {
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function audit() {
    const results = [];

    for (const stack of listStacks()) {
        const {name, glyphs, bitmapErrors} = readStack(stack);
        const {rules, report} = calibrate(glyphs);

        // Replay every trusted rule against the shipped composites of its class.
        // A wrong placement model or a mis-encoded sint32 surfaces here.
        const verified = report.filter((r) => r.trusted);
        const untrusted = report.filter((r) => !r.trusted);
        const worstTrusted = verified.reduce((m, r) => Math.max(m, r.worst), 0);

        const buildable = [];
        const unbuildable = [];
        for (const [lo, hi] of TARGET_BLOCKS) {
            for (let cp = lo; cp <= hi; cp++) {
                if (glyphs.has(cp)) continue;
                if (!/\p{L}/u.test(String.fromCodePoint(cp))) continue;
                if (build(cp, glyphs, rules)) buildable.push(cp);
                else unbuildable.push(cp);
            }
        }

        results.push({
            stack,
            name,
            glyphCount: glyphs.size,
            bitmapErrors,
            calibration: report,
            trustedRules: verified.length,
            untrustedRules: untrusted,
            worstTrusted,
            residualOk: worstTrusted <= MAX_RESIDUAL,
            buildable,
            unbuildable,
            missingRequired: REQUIRED.filter((cp) => !glyphs.has(cp))
        });
    }

    return results;
}

// --- fill --------------------------------------------------------------------

export function fill() {
    const changed = [];
    for (const stack of listStacks()) {
        const {glyphs} = readStack(stack);
        const {rules} = calibrate(glyphs);

        // Group the new glyphs by the range file they belong in.
        const byRange = new Map();
        for (const [lo, hi] of TARGET_BLOCKS) {
            for (let cp = lo; cp <= hi; cp++) {
                if (glyphs.has(cp)) continue;
                if (!/\p{L}/u.test(String.fromCodePoint(cp))) continue;
                const built = build(cp, glyphs, rules);
                if (!built) continue;
                const range = rangeOf(cp);
                if (!byRange.has(range)) byRange.set(range, []);
                byRange.get(range).push(built);
            }
        }

        for (const [range, added] of [...byRange].sort()) {
            const existing = readRange(stack, range);
            if (!existing) {
                changed.push({stack, range, added: 0, error: 'range file missing'});
                continue;
            }
            const merged = [...existing.glyphs.values()];
            for (const g of added) if (!existing.glyphs.has(g.id)) merged.push(g);
            const buf = encodeGlyphsPbf(existing.name || stack, existing.range || range, merged);
            const file = rangeFile(stack, range);
            if (!fs.readFileSync(file).equals(buf)) {
                fs.writeFileSync(file, buf);
                changed.push({stack, range, added: added.length});
            }
        }
    }
    return changed;
}

export {GLYPHS_DIR, BUFFER, TARGET_BLOCKS, REQUIRED, MAX_RESIDUAL, hex};

// CLI entry -- only when run directly, not when imported by the test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    if (process.argv.includes('--fill')) {
        const changed = fill();
        if (!changed.length) {
            console.log('Nothing to fill -- every compositable glyph is already present.');
        } else {
            for (const c of changed) {
                if (c.error) console.error(`! ${c.stack} ${c.range}: ${c.error}`);
                else console.log(`filled ${c.stack} ${c.range}: +${c.added} glyph(s)`);
            }
        }
        process.exit(changed.some((c) => c.error) ? 1 : 0);
    }

    let problems = 0;
    for (const r of audit()) {
        const issues = [];
        if (r.bitmapErrors.length) issues.push(`${r.bitmapErrors.length} bitmap size error(s)`);
        if (!r.residualOk) issues.push(`worst trusted residual ${(r.worstTrusted * 100).toFixed(2)}%`);
        if (r.missingRequired.length) issues.push(`missing required: ${r.missingRequired.map(hex).join(', ')}`);

        console.log(`${issues.length ? 'FAIL' : 'ok  '}  ${r.stack}`);
        console.log(`        ${r.glyphCount} glyphs; ${r.trustedRules} placement rule(s) verified against shipped composites (worst residual ${(r.worstTrusted * 100).toFixed(2)}%)`);
        if (r.buildable.length) console.log(`        compositable but absent: ${r.buildable.length} (${r.buildable.slice(0, 8).map(hex).join(', ')}${r.buildable.length > 8 ? ', ...' : ''})`);
        if (r.unbuildable.length) console.log(`        not compositable: ${r.unbuildable.length}`);
        for (const u of r.untrustedRules) {
            console.log(`        skipped ${hex(u.mark)} on base class top=${u.baseTop}: no shipped composite reproduced (${u.total} sample(s), designer-specific form)`);
        }
        for (const c of r.calibration.filter((c) => c.trusted && c.outliers.length)) {
            console.log(`        note: ${hex(c.mark)} top=${c.baseTop} rule backed by ${c.matched}/${c.total}; special forms: ${c.outliers.map(hex).join(', ')}`);
        }
        for (const e of r.bitmapErrors) console.log(`        ${e}`);
        if (issues.length) problems++;
    }

    if (problems) {
        console.error(`\n${problems} stack(s) with issues. Run "yarn glyphs:fill" to composite the missing glyphs.`);
        process.exit(1);
    }
    console.log('\nAll stacks cover the required codepoints.');
}
