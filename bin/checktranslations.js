#!/usr/bin/env node
//
// i18n locale parity + formatting helper.
//
// Every key in the reference locale (en) must exist in every other locale, the
// files must be canonical 4-space JSON with a trailing newline, and no locale
// may carry keys en doesn't. The parity is asserted by test/locales.test.ts
// (so `yarn test` / CI fails when a new en key isn't translated everywhere);
// this file is the shared implementation plus a CLI:
//
//   node bin/checktranslations.js          report problems, exit 1 if any
//   node bin/checktranslations.js --fill   stub missing keys (en value as a
//                                          placeholder) and canonicalise format
//
// ESM (bin/ is type:module) with no dependencies, so it runs directly with node
// and is importable from the vitest test. Paths resolve relative to this file.

import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'public', 'locales');
const REFERENCE = 'en';

// dotted-path leaf keys of a nested translation object
function flatten(obj, prefix = '', acc = {}) {
    for (const k of Object.keys(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, acc);
        else acc[key] = v;
    }
    return acc;
}

function canonical(obj) {
    return JSON.stringify(obj, null, 4) + '\n';
}

function localeFile(locale) {
    return path.join(LOCALES_DIR, locale, 'common.json');
}

function listLocales() {
    return fs
        .readdirSync(LOCALES_DIR)
        .filter((l) => fs.existsSync(localeFile(l)))
        .sort();
}

function readRaw(locale) {
    return fs.readFileSync(localeFile(locale), 'utf8');
}

// Audit one locale against the reference key set. Never throws: a parse failure
// is reported as a problem so the test can surface it rather than crashing.
function auditLocale(locale, refKeys) {
    const raw = readRaw(locale);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {locale, parseError: e.message, missing: [], extra: [], formatOk: false};
    }
    const keys = new Set(Object.keys(flatten(parsed)));
    return {
        locale,
        parseError: null,
        missing: [...refKeys].filter((k) => !keys.has(k)),
        extra: [...keys].filter((k) => !refKeys.has(k)),
        formatOk: canonical(parsed) === raw,
    };
}

// One result row per non-reference locale.
export function audit() {
    const refKeys = new Set(Object.keys(flatten(JSON.parse(readRaw(REFERENCE)))));
    return listLocales()
        .filter((l) => l !== REFERENCE)
        .map((l) => auditLocale(l, refKeys));
}

// Non-destructive deep merge: keep target's existing keys/order/values, append
// any keys present in ref but missing from target (en value as placeholder).
function fillMerge(ref, target) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return target === undefined ? ref : target;
    const base = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
    const out = {...base};
    for (const k of Object.keys(ref)) {
        if (ref[k] && typeof ref[k] === 'object' && !Array.isArray(ref[k])) out[k] = fillMerge(ref[k], base[k]);
        else if (!(k in base)) out[k] = ref[k];
    }
    return out;
}

// Stub missing keys and canonicalise formatting in place. Returns the locales
// that changed.
export function fill() {
    const ref = JSON.parse(readRaw(REFERENCE));
    const changed = [];
    for (const l of listLocales()) {
        if (l === REFERENCE) continue;
        const raw = readRaw(l);
        const next = canonical(fillMerge(ref, JSON.parse(raw)));
        if (next !== raw) {
            fs.writeFileSync(localeFile(l), next);
            changed.push(l);
        }
    }
    return changed;
}

export {LOCALES_DIR, REFERENCE, flatten, canonical, listLocales};

// CLI entry — only when run directly, not when imported by the test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    if (process.argv.includes('--fill')) {
        const changed = fill();
        console.log(changed.length ? `Filled / reformatted: ${changed.join(', ')}` : 'Nothing to fill — all locales complete and canonical.');
        process.exit(0);
    }
    let problems = 0;
    for (const r of audit()) {
        const issues = [];
        if (r.parseError) issues.push(`PARSE ERROR: ${r.parseError}`);
        if (r.missing.length) issues.push(`missing ${r.missing.length}: ${r.missing.join(', ')}`);
        if (r.extra.length) issues.push(`extra ${r.extra.length}: ${r.extra.join(', ')}`);
        if (!r.formatOk && !r.parseError) issues.push('format not canonical (run --fill)');
        if (issues.length) {
            problems++;
            console.log(`✗ ${r.locale}: ${issues.join(' · ')}`);
        } else {
            console.log(`✓ ${r.locale}`);
        }
    }
    if (problems) {
        console.error(`\n${problems} locale(s) with issues. Run "yarn i18n:fill" to stub missing keys, then translate them.`);
        process.exit(1);
    }
    console.log(`\nAll locales match ${REFERENCE}.`);
}
