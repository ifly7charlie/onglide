import {describe, test, expect} from 'vitest';
import {
    tokeniseName,
    hashNameToken,
    hashNameTokens,
    hashClub,
    gliderKeyOf,
    validFai,
    hashFai,
    normaliseGreg,
    normaliseCountry,
    normaliseCompno,
    flarmidIsIcao,
    fingerprintFromPilot,
    hasPilotEvidence,
    pilotKey,
    resolveCountries,
    resolvePilotCountry,
    xcSignals,
    type IdentityFacets,
    type PilotEvidence
} from '../lib/scoring/shared/identity';

const SECRET = 'test-secret-do-not-use-in-prod';
const OTHER = 'a-different-secret';

describe('tokeniseName', () => {
    test('splits a plain name into normalised tokens', () => {
        expect(tokeniseName('Alice Smith')).toEqual(['alice', 'smith']);
    });

    test('shared-crew joiners (& / + and) split into both pilots tokens', () => {
        expect(tokeniseName('A Smith & B Jones')).toEqual(['smith', 'jones']); // single letters <2 dropped
        expect(tokeniseName('Alice Smith / Bob Jones').sort()).toEqual(['alice', 'bob', 'jones', 'smith']);
        expect(tokeniseName('Alice and Bob').sort()).toEqual(['alice', 'bob']);
    });

    test('strips accents and punctuation', () => {
        expect(tokeniseName('Élodie O\'Brien-Müller').sort()).toEqual(['elodie', 'obrienmuller']);
    });

    test('drops tokens shorter than 2 chars and stopwords — "Team A" yields nothing', () => {
        expect(tokeniseName('Team A')).toEqual([]);
        expect(tokeniseName('The Flying Group')).toEqual([]);
    });

    test('empty/blank name yields no tokens', () => {
        expect(tokeniseName('')).toEqual([]);
        expect(tokeniseName(null)).toEqual([]);
    });
});

describe('hashing determinism and secret-sensitivity', () => {
    test('hashNameToken is deterministic for a given secret', () => {
        expect(hashNameToken('smith', SECRET)).toBe(hashNameToken('smith', SECRET));
    });

    test('different secrets produce different hashes', () => {
        expect(hashNameToken('smith', SECRET)).not.toBe(hashNameToken('smith', OTHER));
    });

    test('hashNameTokens are distinct, sorted, and reveal no plaintext', () => {
        const h = hashNameTokens('Bob Smith Smith', SECRET); // duplicate surname collapses
        expect(h.length).toBe(2);
        expect([...h]).toEqual([...h].sort());
        for (const x of h) expect(x).toMatch(/^[0-9a-f]{32}$/);
        expect(h.join('')).not.toContain('smith');
    });

    test('hashClub returns null for empty/placeholder clubs, a hash otherwise', () => {
        expect(hashClub('', SECRET)).toBeNull();
        expect(hashClub('The Club', SECRET)).toBeNull(); // all stopwords
        expect(hashClub('Lasham Gliding', SECRET)).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('facet validation', () => {
    test('gliderKeyOf normalises to the model key', () => {
        expect(gliderKeyOf('Ventus 3T/18m')).toBe('VENTUS3');
        expect(gliderKeyOf('')).toBeNull();
    });

    test('validFai accepts only real ids (>0 and <300000)', () => {
        expect(validFai(0)).toBeNull();
        expect(validFai(12345)).toBe(12345);
        expect(validFai(299999)).toBe(299999);
        expect(validFai(300000)).toBeNull();
        expect(validFai(3_000_001)).toBeNull();
        expect(validFai(null)).toBeNull();
    });

    test('hashFai hashes real ids and is null for synthetic/blank — never the raw number', () => {
        const h = hashFai(12345, SECRET);
        expect(h).toMatch(/^[0-9a-f]{32}$/);
        expect(h).not.toContain('12345');
        expect(hashFai(12345, SECRET)).toBe(hashFai(12345, SECRET)); // deterministic
        expect(hashFai(12345, SECRET)).not.toBe(hashFai(54321, SECRET));
        expect(hashFai(0, SECRET)).toBeNull();
        expect(hashFai(3_000_001, SECRET)).toBeNull();
    });

    test('normaliseGreg strips punctuation and uppercases', () => {
        expect(normaliseGreg('G-DEAR')).toBe('GDEAR');
        expect(normaliseGreg('')).toBeNull();
    });

    test('normaliseCountry folds UK to GB and rejects non-2-letter', () => {
        expect(normaliseCountry('uk')).toBe('GB');
        expect(normaliseCountry('GB')).toBe('GB');
        expect(normaliseCountry('fr')).toBe('FR');
        expect(normaliseCountry('GBR')).toBeNull();
        expect(normaliseCountry('')).toBeNull();
    });

    test('normaliseCompno trims and uppercases', () => {
        expect(normaliseCompno(' g1 ')).toBe('G1');
        expect(normaliseCompno('')).toBeNull();
    });
});

describe('flarmidIsIcao', () => {
    test('UK ICAO block address is recognised (4052F2)', () => {
        expect(flarmidIsIcao('4052F2')).toBe(true);
    });

    test('lower-case and German addresses also recognised', () => {
        expect(flarmidIsIcao('3ee5c1')).toBe(true); // Germany block
    });

    test('OGN/random tracker id falls through to false', () => {
        expect(flarmidIsIcao('DDA5BA')).toBe(false); // OGN range
        expect(flarmidIsIcao('not-hex')).toBe(false);
        expect(flarmidIsIcao('')).toBe(false);
    });
});

describe('fingerprintFromPilot / pilotKey', () => {
    const input = {name: 'Alice Smith', homeclub: 'Lasham Gliding', glidertype: 'Ventus 3T', country: 'GB', fai: 12345, greg: 'G-ABCD', compno: 'A1', flarmid: '4052F2'};

    test('builds facets from a pilot row', () => {
        const f = fingerprintFromPilot(input, SECRET);
        expect(f.nameTokenHashes.length).toBe(2);
        expect(f.gliderKey).toBe('VENTUS3');
        expect(f.country).toBe('GB');
        expect(f.faiHash).toBe(hashFai(12345, SECRET));
        expect(f.faiHash).toMatch(/^[0-9a-f]{32}$/);
        expect(f.greg).toBe('GABCD');
        expect(f.compno).toBe('A1');
        expect(f.isIcaoId).toBe(true);
        expect(f.clubHash).toMatch(/^[0-9a-f]{32}$/);
    });

    test('pilotKey is stable and token-order independent', () => {
        const a = pilotKey(fingerprintFromPilot({...input, name: 'Alice Smith'}, SECRET), SECRET);
        const b = pilotKey(fingerprintFromPilot({...input, name: 'Smith Alice'}, SECRET), SECRET);
        expect(a).toBe(b);
    });

    test('different pilots get different keys; same compno does not collide', () => {
        const a = pilotKey(fingerprintFromPilot({...input, name: 'Alice Smith', fai: 1, greg: null}, SECRET), SECRET);
        const b = pilotKey(fingerprintFromPilot({...input, name: 'Bob Jones', fai: 2, greg: null}, SECRET), SECRET);
        expect(a).not.toBe(b);
    });

    test('hasPilotEvidence is false for a placeholder crew with no fai/club', () => {
        const f = fingerprintFromPilot({name: 'Team A', homeclub: null, glidertype: 'JS3', country: 'GB', fai: null, greg: null}, SECRET);
        expect(f.nameTokenHashes).toEqual([]);
        expect(hasPilotEvidence(f)).toBe(false);
    });

    test('hasPilotEvidence is true when a real FAI is present even without name tokens', () => {
        const f = fingerprintFromPilot({name: 'Team A', homeclub: null, glidertype: 'JS3', country: 'GB', fai: 999, greg: null}, SECRET);
        expect(hasPilotEvidence(f)).toBe(true);
    });
});

describe('resolveCountries / resolvePilotCountry', () => {
    test('>90% single-country uses the comp-country fallback', () => {
        const countries = Array(19).fill('GB').concat(['FR']);
        const r = resolveCountries(countries, 'UK');
        expect(r.useFallback).toBe(true);
        expect(resolvePilotCountry('FR', r, 'UK')).toBe('GB'); // even the FR pilot attributed to comp country
    });

    test('mixed field keeps each pilot country', () => {
        const countries = ['GB', 'GB', 'FR', 'FR', 'DE'];
        const r = resolveCountries(countries, 'UK');
        expect(r.useFallback).toBe(false);
        expect(resolvePilotCountry('FR', r, 'UK')).toBe('FR');
        expect(resolvePilotCountry('', r, 'UK')).toBe('GB'); // blank falls back to comp
    });

    test('no pilot states a country → fallback', () => {
        const r = resolveCountries([null, '', undefined], 'FR');
        expect(r.useFallback).toBe(true);
        expect(resolvePilotCountry(null, r, 'FR')).toBe('FR');
    });
});

describe('xcSignals', () => {
    const facets = (over: Partial<IdentityFacets> = {}): IdentityFacets => ({
        nameTokenHashes: [],
        clubHash: null,
        gliderKey: null,
        country: null,
        compno: null,
        faiHash: null,
        greg: null,
        isIcaoId: false,
        ...over
    });
    const tokens = (name: string) => hashNameTokens(name, SECRET);
    const faiH = (n: number) => hashFai(n, SECRET);

    test('no aircraft and no pilots → empty block', () => {
        const s = xcSignals(facets({nameTokenHashes: tokens('Alice Smith')}), null, []);
        expect(s.xcNameOverlap).toBeNull();
        expect(s.xcGregMatch).toBe(false);
    });

    test('full name overlap scores 1.0', () => {
        const cand = facets({nameTokenHashes: tokens('Alice Smith')});
        const prior: PilotEvidence = {tokenHashes: tokens('Alice Smith'), clubHash: null, faiHash: null};
        const s = xcSignals(cand, null, [prior]);
        expect(s.xcNameOverlap).toBeCloseTo(1.0, 6);
    });

    test('solo pilot vs an "A & B" two-seater crew scores ~0.5 (partial)', () => {
        const cand = facets({nameTokenHashes: tokens('Alice Smith')});
        const crew: PilotEvidence = {tokenHashes: tokens('Alice Smith / Bob Jones'), clubHash: null, faiHash: null};
        const s = xcSignals(cand, null, [crew]);
        // candidate has 2 tokens, crew has 4, shared 2 → 2/max(2,4)=0.5
        expect(s.xcNameOverlap).toBeCloseTo(0.5, 6);
    });

    test('null overlap when candidate has no name tokens', () => {
        const cand = facets({faiHash: faiH(999)});
        const prior: PilotEvidence = {tokenHashes: tokens('Alice Smith'), clubHash: null, faiHash: faiH(999)};
        const s = xcSignals(cand, null, [prior]);
        expect(s.xcNameOverlap).toBeNull();
        expect(s.xcFaiMatch).toBe(true); // fai still matches the best clue
    });

    test('aircraft facets compare against the single aircraft row', () => {
        const cand = facets({greg: 'GABCD', gliderKey: 'VENTUS3', compno: 'A1', country: 'GB'});
        const s = xcSignals(cand, {greg: 'GABCD', gliderKey: 'VENTUS3', compno: 'A1', country: 'GB', isIcaoId: true}, []);
        expect(s.xcGregMatch).toBe(true);
        expect(s.xcGliderMatch).toBe(true);
        expect(s.xcCompnoMatch).toBe(true);
        expect(s.xcCountryMatch).toBe(true);
    });

    test('glider match is forgiving of descriptor suffixes (winglets, span, etc.)', () => {
        const cand = facets({gliderKey: gliderKeyOf('Standard Cirrus')!});
        const a = {gliderKey: gliderKeyOf('Standard Cirrus Winglets')!, greg: null, country: null, compno: null, isIcaoId: false};
        expect(xcSignals(cand, a, []).xcGliderMatch).toBe(true);
        // genuinely different models do not match
        const b = {gliderKey: gliderKeyOf('Ventus 2')!, greg: null, country: null, compno: null, isIcaoId: false};
        expect(xcSignals(facets({gliderKey: gliderKeyOf('Ventus 3')!}), b, []).xcGliderMatch).toBe(false);
    });

    test('best clue supplies the booleans — fai dominates clue selection', () => {
        const cand = facets({nameTokenHashes: tokens('Alice Smith'), faiHash: faiH(555), clubHash: hashClub('Lasham Gliding', SECRET)});
        const wrongName: PilotEvidence = {tokenHashes: tokens('Zoe Other'), clubHash: hashClub('Lasham Gliding', SECRET), faiHash: faiH(555)};
        const rightName: PilotEvidence = {tokenHashes: tokens('Alice Smith'), clubHash: null, faiHash: null};
        const s = xcSignals(cand, null, [wrongName, rightName]);
        // fai match (weight 2 in selection) wins → booleans from wrongName clue
        expect(s.xcFaiMatch).toBe(true);
        expect(s.xcClubMatch).toBe(true);
    });
});
