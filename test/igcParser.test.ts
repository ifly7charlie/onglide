import {describe, test, expect} from 'vitest';
import {parseIGC} from '../lib/view/igcParser';

// PEV presses are E records (EHHMMSSPEV) interleaved in time order with the
// B-record fixes. The parser reports their epochs (pevTimes, for logging) and
// credits each press to the next fix via the `pev` flag — that is how the
// press reaches the scoring chain.
describe('igcParser PEV events', () => {
    const HDR = ['HFDTEDATE:080726', 'HFPLTPILOT: Test Pilot', 'HFCIDCOMPETITIONID: XX'];
    const B = (hhmmss: string) => `B${hhmmss}4700000N01900000EA0100001000`;
    const parse = (records: string[]) => parseIGC([...HDR, ...records, ''].join('\r\n'));
    const base = Date.UTC(2026, 6, 8) / 1000;

    test('PEV presses become epochs and flag the next fix', () => {
        const data = parse([B('100000'), 'E100002PEV', B('100004'), B('100008'), 'E101500PEV', B('101502')]);
        expect(data.pevTimes).toEqual([base + 10 * 3600 + 2, base + 10 * 3600 + 15 * 60]);
        expect(data.fixes.filter((f) => f.pev).map((f) => f.t - base)).toEqual([10 * 3600 + 4, 10 * 3600 + 15 * 60 + 2]);
    });

    test('non-PEV E records are ignored', () => {
        const data = parse([B('100000'), 'E100002ATS102312', B('100004')]);
        expect(data.pevTimes).toEqual([]);
        expect(data.fixes.some((f) => f.pev)).toBe(false);
    });

    test('a press with no later fix is reported but flags nothing', () => {
        const data = parse([B('100000'), B('100004'), 'E100010PEV']);
        expect(data.pevTimes).toEqual([base + 10 * 3600 + 10]);
        expect(data.fixes.some((f) => f.pev)).toBe(false);
    });
});
