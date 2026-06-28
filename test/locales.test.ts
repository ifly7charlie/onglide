import {describe, test, expect} from 'vitest';
// Dependency-free ESM helper (no type declarations) — see bin/checktranslations.js.
// @ts-ignore
import {audit} from '../bin/checktranslations.js';

// Every key in en must be translated in every other locale, no locale may carry
// keys en lacks, and each file must be canonical 4-space JSON with a trailing
// newline. `yarn i18n:fill` stubs/repairs; this test keeps CI honest.
describe('i18n locale parity with en', () => {
    const results: {locale: string; parseError: string | null; missing: string[]; extra: string[]; formatOk: boolean}[] = audit();

    test('there are locales to check', () => {
        expect(results.length).toBeGreaterThan(0);
    });

    for (const r of results) {
        test(`${r.locale}`, () => {
            expect(r.parseError, `${r.locale}/common.json did not parse`).toBeNull();
            expect(r.missing, `${r.locale} is missing keys present in en — run "yarn i18n:fill"`).toEqual([]);
            expect(r.extra, `${r.locale} has keys not in en (typo or stale key)`).toEqual([]);
            expect(r.formatOk, `${r.locale} is not canonical 4-space JSON — run "yarn i18n:fill"`).toBe(true);
        });
    }
});
