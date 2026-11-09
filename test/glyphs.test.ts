import {describe, test, expect} from 'vitest';
// Dependency-free ESM helper (no type declarations) - see bin/checkglyphs.js.
// @ts-ignore
import {audit, MAX_RESIDUAL, hex} from '../bin/checkglyphs.js';

// The map's SDF atlases must cover the codepoints the label layers can ask for.
// Atkinson Hyperlegible Next itself only has 347, so the rest are composited
// from its own base letters and combining marks by `yarn glyphs:fill`.
//
// Two things are asserted. First, every required codepoint is present - so
// re-running the readme's build-glyphs recipe (which regenerates straight from
// the OTFs and drops the composites) fails here instead of silently blanking
// letters on the map. Second, every placement rule still reproduces the
// composites the font already ships, which is what makes the generated glyphs
// trustworthy: get the sint32 metrics or the offsets wrong and this goes red.
describe('map glyph atlas coverage', () => {
    const results: {
        stack: string;
        glyphCount: number;
        bitmapErrors: string[];
        trustedRules: number;
        worstTrusted: number;
        residualOk: boolean;
        buildable: number[];
        missingRequired: number[];
    }[] = audit();

    test('there are font stacks to check', () => {
        expect(results.length).toBeGreaterThan(0);
    });

    for (const r of results) {
        describe(r.stack, () => {
            test('covers every required codepoint', () => {
                expect(r.missingRequired.map(hex), `${r.stack} is missing glyphs - run "yarn glyphs:fill"`).toEqual([]);
            });

            test('every glyph bitmap matches its declared size', () => {
                expect(r.bitmapErrors, `${r.stack} has malformed glyph bitmaps`).toEqual([]);
            });

            test('placement rules reproduce the shipped composites', () => {
                expect(r.trustedRules, `${r.stack} calibrated no placement rules at all`).toBeGreaterThan(0);
                expect(r.residualOk, `${r.stack} worst reproduction residual ${(r.worstTrusted * 100).toFixed(2)}% exceeds ${(MAX_RESIDUAL * 100).toFixed(0)}%`).toBe(true);
            });

            test('nothing compositable is left absent', () => {
                expect(r.buildable.map(hex), `${r.stack} could composite more glyphs - run "yarn glyphs:fill"`).toEqual([]);
            });
        });
    }
});
