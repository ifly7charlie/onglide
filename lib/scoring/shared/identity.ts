//
// Cross-competition, privacy-preserving identity evidence.
//
// The FLARM id is the primary entity here: barring an equipment change or
// failure, an aircraft keeps the same id between competitions. The aircraft is
// the stable anchor (glider type, registration, country, comp number); the
// pilots who fly it are *clues* to which aircraft a newly-seen id is. A club
// glider produces several pilot clues under one id; a pilot changing gliders
// does not fragment anything because the id (= aircraft) is the key.
//
// Privacy: we NEVER store raw pilot names or club names. Names and clubs are
// reduced to keyed HMAC-SHA256 token hashes (truncated). Names have low
// entropy, so a plain hash would be dictionary-attackable; the HMAC secret
// (IDENTITY_HMAC_SECRET) makes the stored hashes meaningless without it. The
// same secret across comps is what lets a returning pilot's tokens line up —
// it must therefore be stable and backed up. Glider type, country, comp
// number, FAI id and registration are public/non-sensitive and stored plainly.
//
// Pure module — no DB, no argv. `bin/findtrackers.ts` collects evidence from
// confident matches and uses it as scoring signals; `ssscrape` (part 2) will
// reuse the same fingerprinting and the name-token reverse index.
//

import {createHmac} from 'crypto';
import {gliderKey, gliderEquivalent, cleanRegistration} from '../../ddb';
import {FAI_REAL_MAX, NAME_STOPWORDS, TRACKER_SCORE_WEIGHTS, IDENTITY_DECAY_MONTHS, IDENTITY_CONF_FULL_NATS} from '../../constants';

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

let cachedSecret: string | null = null;

// The HMAC key. Read once from the environment. Throws if missing so a
// misconfiguration can never silently produce unsalted (reversible) hashes —
// callers that only read evidence (and so never need to hash) won't call this.
export function identitySecret(): string {
    if (cachedSecret !== null) return cachedSecret;
    const s = process.env.IDENTITY_HMAC_SECRET;
    if (!s) throw new Error('IDENTITY_HMAC_SECRET is not set — refusing to write privacy-preserving identity evidence without a salt');
    cachedSecret = s;
    return s;
}

// 128-bit (32 hex) keyed digest — plenty for set-membership comparison while
// matching the 32-char width used for idsig elsewhere.
function hmac(value: string, secret: string): string {
    return createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Name handling
// ---------------------------------------------------------------------------

// Lowercase, strip accents, keep only [a-z0-9]. Empty string when nothing left.
function normaliseToken(raw: string): string {
    return raw
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // combining diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

// Split a competition "name" into normalised tokens. Shared-crew joiners
// (`&`, `/`, `+`, the word "and") are treated like whitespace so a two-seater
// "A Smith & B Jones" yields both pilots' tokens. Tokens shorter than 2 chars
// and generic placeholder/team words (NAME_STOPWORDS) are dropped, so "Team A"
// reduces to nothing and contributes no identifying name evidence.
export function tokeniseName(name: string | null | undefined): string[] {
    if (!name) return [];
    const parts = name.split(/[\s&/+]+|\band\b/i);
    const out: string[] = [];
    for (const p of parts) {
        const t = normaliseToken(p);
        if (t.length < 2) continue;
        if (NAME_STOPWORDS.has(t)) continue;
        out.push(t);
    }
    return out;
}

export function hashNameToken(token: string, secret: string = identitySecret()): string {
    return hmac(`name:${token}`, secret);
}

// Distinct, sorted token hashes for a name. Sorted so a stored set and a
// candidate set compare order-independently; distinct so a repeated surname
// doesn't inflate the overlap denominator.
export function hashNameTokens(name: string | null | undefined, secret: string = identitySecret()): string[] {
    const seen = new Set<string>();
    for (const t of tokeniseName(name)) seen.add(hashNameToken(t, secret));
    return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Other facets
// ---------------------------------------------------------------------------

// Normalise a club name the same way as a name token (lower, accent-stripped,
// alphanumerics only) then HMAC it. null when the club is empty or a generic
// placeholder that can't identify anyone.
export function hashClub(club: string | null | undefined, secret: string = identitySecret()): string | null {
    if (!club) return null;
    const tokens = tokeniseName(club);
    if (!tokens.length) return null;
    return hmac(`club:${tokens.join(' ')}`, secret);
}

// gliderEquivalent's leading model key — not sensitive. null when empty.
export function gliderKeyOf(glidertype: string | null | undefined): string | null {
    const k = gliderKey(glidertype);
    return k || null;
}

// A real FAI ranking id (> 0 and < FAI_REAL_MAX). Synthetic placeholders
// (>= FAI_SYNTHETIC_FLOOR) and unresolved 0/blank become null.
export function validFai(fai: number | null | undefined): number | null {
    if (fai === null || fai === undefined) return null;
    const n = Number(fai);
    if (!Number.isFinite(n) || n <= 0 || n >= FAI_REAL_MAX) return null;
    return n;
}

// HMAC of a real FAI id. The FAI id resolves directly to a named pilot on the
// public ranking site, so it's effectively a name — we store only the keyed
// hash, never the number. null for unresolved/synthetic ids.
export function hashFai(fai: number | null | undefined, secret: string = identitySecret()): string | null {
    const v = validFai(fai);
    return v === null ? null : hmac(`fai:${v}`, secret);
}

// Registration → A-Z0-9 uppercase (reuses the DDB normaliser). null when empty.
export function normaliseGreg(greg: string | null | undefined): string | null {
    const g = cleanRegistration(greg).toUpperCase();
    return g || null;
}

// 2-letter country, uppercased; 'UK' folded to 'GB' so competition.countrycode
// (defaults 'UK') and pilots.country (defaults 'GB') compare equal. null when
// not a 2-letter code.
export function normaliseCountry(country: string | null | undefined): string | null {
    if (!country) return null;
    const c = country.trim().toUpperCase();
    if (c.length !== 2) return null;
    return c === 'UK' ? 'GB' : c;
}

// Comp number → trimmed uppercase. null when empty.
export function normaliseCompno(compno: string | null | undefined): string | null {
    if (!compno) return null;
    const c = String(compno).trim().toUpperCase();
    return c || null;
}

// ICAO 24-bit national address blocks (start..end inclusive, hex). When a
// 6-hex flarmid falls in one of these it is the aircraft's permanent ICAO
// mode-S address (e.g. UK '4052F2'), never a temporary FLARM/OGN assignment.
// Conservative subset of the ICAO allocation — extend as needed; an id outside
// every listed block returns false ("unsure → not flagged"). OGN tracker ids
// (the 0xDD0000–0xDFFFFF range etc.) deliberately fall through to false.
const ICAO_BLOCKS: ReadonlyArray<readonly [number, number]> = [
    [0x380000, 0x3bffff], // France
    [0x3c0000, 0x3fffff], // Germany
    [0x400000, 0x43ffff], // United Kingdom
    [0x440000, 0x447fff], // Austria
    [0x448000, 0x44ffff], // Belgium
    [0x458000, 0x45ffff], // Denmark
    [0x460000, 0x467fff], // Finland
    [0x468000, 0x46ffff], // Greece
    [0x478000, 0x47ffff], // Norway
    [0x480000, 0x487fff], // Netherlands
    [0x488000, 0x48ffff], // Poland
    [0x490000, 0x497fff], // Portugal
    [0x4a0000, 0x4a7fff], // Sweden
    [0x4b0000, 0x4b7fff], // Switzerland
    [0x4c8000, 0x4cffff], // Ireland
    [0x500000, 0x5003ff], // Slovenia (sample small block)
    [0x340000, 0x37ffff], // Spain
    [0x300000, 0x33ffff], // Italy
    [0x7c0000, 0x7fffff], // Australia
    [0xa00000, 0xafffff], // United States
    [0xc00000, 0xc3ffff] // Canada
];

export function flarmidIsIcao(flarmid: string | null | undefined): boolean {
    if (!flarmid) return false;
    const hex = String(flarmid).trim();
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
    const n = parseInt(hex, 16);
    for (const [lo, hi] of ICAO_BLOCKS) if (n >= lo && n <= hi) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

// The privacy-preserving fingerprint of one (pilot, aircraft) observation. The
// pilot facets (name tokens, fai, club) say *who*; the aircraft facets (glider
// key, greg, country, compno) say *which airframe*. `isIcaoId` marks a
// permanent ICAO-address flarmid.
export interface IdentityFacets {
    nameTokenHashes: string[];
    clubHash: string | null;
    gliderKey: string | null;
    country: string | null;
    compno: string | null;
    faiHash: string | null; // HMAC of a real FAI id (never the raw number)
    greg: string | null;
    isIcaoId: boolean;
}

export interface PilotIdentityInput {
    name: string; // "First Last" or shared-crew "A & B"
    homeclub: string | null;
    glidertype: string | null;
    country: string | null; // already resolved (see resolveCountries)
    fai: number | null;
    greg: string | null;
    compno?: string | null;
    flarmid?: string; // optional, for isIcaoId derivation at collection time
}

export function fingerprintFromPilot(p: PilotIdentityInput, secret: string = identitySecret()): IdentityFacets {
    return {
        nameTokenHashes: hashNameTokens(p.name, secret),
        clubHash: hashClub(p.homeclub, secret),
        gliderKey: gliderKeyOf(p.glidertype),
        country: normaliseCountry(p.country),
        compno: normaliseCompno(p.compno),
        faiHash: hashFai(p.fai, secret),
        greg: normaliseGreg(p.greg),
        isIcaoId: flarmidIsIcao(p.flarmid)
    };
}

// True when these facets carry anything that identifies a pilot. A crew that
// tokenises to nothing (e.g. "Team A") with no FAI and no club isn't worth a
// pilot-clue row — the aircraft attributes are still collected separately.
export function hasPilotEvidence(f: IdentityFacets): boolean {
    return f.nameTokenHashes.length > 0 || f.faiHash !== null || f.clubHash !== null;
}

// Stable dedupe key for one pilot clue under a flarmid: HMAC over the sorted
// name token hashes + fai hash + country. The same crew next comp reproduces
// the same key; two unrelated pilots sharing a comp number get different keys
// (compno is deliberately NOT part of it). Two-seater token sets are
// order-independent because hashNameTokens sorts.
export function pilotKey(f: IdentityFacets, secret: string = identitySecret()): string {
    const canon = `${f.nameTokenHashes.join(',')}|${f.faiHash ?? ''}|${f.country ?? ''}`;
    return hmac(`pilot:${canon}`, secret);
}

// ---------------------------------------------------------------------------
// Country resolution
// ---------------------------------------------------------------------------

// Decide how to attribute a country to a comp's pilots. `dominant` is the modal
// per-pilot country (falling back to the comp's own country code). `useFallback`
// is true when the field is overwhelmingly single-country (>90%) or no pilot
// has a country set — in either case the comp country is a safe attribution for
// every pilot. Otherwise keep each pilot's own country (see resolvePilotCountry).
export function resolveCountries(pilotCountries: (string | null | undefined)[], compCountrycode: string | null | undefined): {dominant: string | null; useFallback: boolean} {
    const counts = new Map<string, number>();
    let total = 0;
    for (const c of pilotCountries) {
        const n = normaliseCountry(c);
        if (!n) continue;
        counts.set(n, (counts.get(n) ?? 0) + 1);
        total++;
    }
    let dominant: string | null = null;
    let max = 0;
    for (const [c, n] of counts) {
        if (n > max) {
            max = n;
            dominant = c;
        }
    }
    const useFallback = total === 0 || max / total > 0.9;
    return {dominant: dominant ?? normaliseCountry(compCountrycode), useFallback};
}

// Resolve one pilot's country given the comp-wide resolution.
export function resolvePilotCountry(pilotCountry: string | null | undefined, resolution: {useFallback: boolean}, compCountrycode: string | null | undefined): string | null {
    if (resolution.useFallback) return normaliseCountry(compCountrycode);
    return normaliseCountry(pilotCountry) ?? normaliseCountry(compCountrycode);
}

// ---------------------------------------------------------------------------
// Scoring helper
// ---------------------------------------------------------------------------

// What collection stored for a flarmid, loaded back for scoring.
export interface AircraftEvidence {
    gliderKey: string | null;
    greg: string | null;
    country: string | null;
    compno: string | null;
    isIcaoId: boolean;
}
export interface PilotEvidence {
    tokenHashes: string[];
    clubHash: string | null;
    faiHash: string | null;
}

// One competition's stored evidence for a flarmid: the aircraft row, its pilot
// clues, the physical-track confidence that comp produced, and when it was last
// confirmed (epoch ms) for age decay. Assembled by the caller from the per-comp
// rows of flarm_aircraft / flarm_pilot.
export interface PerCompEvidence {
    compid: string;
    aircraft: AircraftEvidence | null;
    pilots: PilotEvidence[];
    matchScore: number | null; // physical-track nats stored for this (flarmid, comp)
    lastSeenMs: number; // epoch ms of the row's last_seen, for age decay
}

// Result of scoring a candidate against a flarmid's cross-comp evidence: a
// single nats value (confidence-scaled, age-decayed, best prior comp), the list
// of facets that fired in that comp (for the operator's breakdown line), and
// which comp won. nats is 0 / facets empty / compid null when nothing qualifies.
export interface XcEvidence {
    nats: number;
    facets: string[];
    compid: string | null;
}

const MONTH_MS = (365.25 / 12) * 24 * 3600 * 1000;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Szymkiewicz–Simpson-ish overlap with a `max` denominator: |C∩P| / max(|C|,|P|).
// A solo pilot matching one half of a stored "A & B" crew scores ≈0.5; an exact
// match scores 1.0 — so a better match always scores higher.
function tokenOverlap(candidate: string[], prior: string[]): number {
    if (!candidate.length || !prior.length) return 0;
    const set = new Set(prior);
    let shared = 0;
    for (const t of candidate) if (set.has(t)) shared++;
    return shared / Math.max(candidate.length, prior.length);
}

const W = TRACKER_SCORE_WEIGHTS;

// Identity-match strength of a candidate against ONE comp's evidence, in nats,
// using the xc* facet weights as relative importances, plus the list of facets
// that fired. Aircraft facets (greg/glider/compno/country) compare against the
// aircraft row; pilot facets (name/fai/club) come from the single best-matching
// clue so they describe one coherent pilot — a real FAI match dominates clue
// selection even when names don't tokenise.
function identityMatch(candidate: IdentityFacets, ev: PerCompEvidence): {nats: number; facets: string[]} {
    const facets: string[] = [];
    let nats = 0;
    const a = ev.aircraft;

    if (!!candidate.greg && !!a?.greg && candidate.greg === a.greg) {
        nats += W.xcGreg;
        facets.push('greg');
    }
    // Forgiving prefix match (not exact equality): the same airframe's glider is
    // entered inconsistently across comps ("Standard Cirrus" vs "… Winglets").
    if (!!candidate.gliderKey && !!a?.gliderKey && gliderEquivalent(candidate.gliderKey, a.gliderKey)) {
        nats += W.xcGlider;
        facets.push('glider');
    }
    if (!!candidate.compno && !!a?.compno && candidate.compno === a.compno) {
        nats += W.xcCompno;
        facets.push('compno');
    }
    if (!!candidate.country && !!a?.country && candidate.country === a.country) {
        nats += W.xcCountry;
        facets.push('country');
    }

    // Best pilot clue: FAI match dominates (a precise id), then name overlap,
    // then a club match as a faint tiebreak.
    let best: {clue: PilotEvidence; overlap: number; fai: boolean; club: boolean} | null = null;
    for (const clue of ev.pilots ?? []) {
        const overlap = tokenOverlap(candidate.nameTokenHashes, clue.tokenHashes);
        const fai = !!candidate.faiHash && !!clue.faiHash && candidate.faiHash === clue.faiHash;
        const club = !!candidate.clubHash && !!clue.clubHash && candidate.clubHash === clue.clubHash;
        const rank = (fai ? 2 : 0) + overlap + (club ? 0.1 : 0);
        const bestRank = best ? (best.fai ? 2 : 0) + best.overlap + (best.club ? 0.1 : 0) : -1;
        if (rank > bestRank) best = {clue, overlap, fai, club};
    }
    if (best) {
        const haveNames = candidate.nameTokenHashes.length > 0 && best.clue.tokenHashes.length > 0;
        if (haveNames && best.overlap > 0) {
            nats += W.xcName * clamp01(best.overlap);
            facets.push('name');
        }
        if (best.fai) {
            nats += W.xcFai;
            facets.push('fai');
        }
        if (best.club) {
            nats += W.xcClub;
            facets.push('club');
        }
    }
    return {nats, facets};
}

// Score a candidate pilot against a flarmid's cross-comp evidence. For each
// prior comp, blend the facet matches into identity nats and scale by that
// comp's physical-match confidence (saturating) and its age (exponential decay).
// Take the single BEST comp (argmax of identity × confidence) — repeat
// appearances don't stack. The caller must already have excluded the current
// competition from `perComp`.
export function xcEvidenceScore(candidate: IdentityFacets, perComp: PerCompEvidence[], nowMs: number): XcEvidence {
    let winner: XcEvidence | null = null;
    let bestProduct = 0;
    for (const ev of perComp ?? []) {
        const {nats: identityNats, facets} = identityMatch(candidate, ev);
        if (identityNats <= 0) continue; // candidate doesn't match this comp's evidence at all
        const score = ev.matchScore ?? 0;
        const ageMonths = Math.max(0, (nowMs - ev.lastSeenMs) / MONTH_MS);
        const conf = clamp01(score / IDENTITY_CONF_FULL_NATS) * Math.exp(-ageMonths / IDENTITY_DECAY_MONTHS);
        const product = identityNats * conf;
        if (product > bestProduct) {
            bestProduct = product;
            winner = {nats: product, facets, compid: ev.compid};
        }
    }
    return winner ?? {nats: 0, facets: [], compid: null};
}
