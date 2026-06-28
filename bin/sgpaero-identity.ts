// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// sgpaero-identity — read-only diagnostic. Pull the sgpaero pilot roster
// (crosscountry.aero REST feed) and, for each pilot's FLARM/ICAO id (the
// `q` field), report what cross-comp identity evidence exists in the
// flarm_aircraft / flarm_pilot / flarm_pilot_nametoken tables.
//
// This does NOT write anything and is unrelated to the ssscrape sgpaero
// sync path (which only writes the `tracker` row from `q`). It's a lookup
// over the evidence bin/findtrackers.ts accumulates.
//
// The identity tables store names, clubs and FAI ids ONLY as HMAC hashes
// (no raw strings). So to tell whether a flarmid's stored pilot clue is
// THIS sgpaero pilot, we recompute the pilot's own facet hashes with the
// same IDENTITY_HMAC_SECRET and compare hashes. Aircraft facets
// (glider_key, greg, country, compno) are stored in the clear and match
// without the secret — so the tool still reports aircraft evidence when
// the secret is unset, just not name/club/FAI matches.
//
// Usage:
//   yarn build && node dist/bin/sgpaero-identity.js --compid <compid>
//   node dist/bin/sgpaero-identity.js --url https://www.crosscountry.aero/c/sgp/rest/comp/92
//   node dist/bin/sgpaero-identity.js --json ./feed.json --compid <compid>
//   ... --all     also list pilots whose flarmid has no stored evidence
//

import {readFileSync} from 'fs';

import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {fingerprintFromPilot, type IdentityFacets} from '../lib/scoring/shared/identity';

dotenv.config({path: '.env.local'});

const SGP_FETCH_TIMEOUT_MS = 20_000;
// Mirror loadPriorAircraft: only evidence reconfirmed within the window is
// meaningful. Hardcoded here to keep the tool free of the constants import
// chain; matches IDENTITY_EXPIRY_MONTHS in lib/constants.
const IDENTITY_EXPIRY_MONTHS = 18;

const argv = yargs(hideBin(process.argv))
    .option('compid', {type: 'string', describe: 'competition id (looks up the sgpaero url from scoringsource)'})
    .option('url', {type: 'string', describe: 'sgpaero REST url (overrides the scoringsource lookup)'})
    .option('json', {type: 'string', describe: 'read the feed from a local JSON file instead of fetching'})
    .option('all', {type: 'boolean', default: false, describe: 'also list pilots whose flarmid has no stored evidence'})
    .option('expired', {type: 'boolean', default: false, describe: 'include evidence older than the retention window'})
    .strict()
    .parseSync();

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        decimalNumbers: true,
        flags: ['-FOUND_ROWS']
    },
    onError: (e: unknown) => console.error(e),
    onConnectError: (x: unknown) => console.error('mysql connect error', x),
    maxRetries: 2,
    connUtilization: 0.2
});

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

// ----- feed shapes (only the fields we read; see lib/scoring/sources/sgpaero.ts) -----

interface AeroPilot {
    d?: string; // compno
    f?: string; // first name
    l?: string; // last name
    z?: string; // country
    s?: string; // glider type
    w?: string; // registration
    q?: string; // FLARM/ICAO id, 3-letter prefix + 6 hex
}

interface Candidate {
    compno: string;
    name: string;
    flarmid: string | null;
    facets: IdentityFacets | null; // null when IDENTITY_HMAC_SECRET unset
    raw: {country: string | null; glider: string | null; greg: string | null};
}

// Same trailing-6-hex extraction as sgpaero.ts flarmFromQ, uppercased to
// match the stored flarmid (char(6), uppercase).
function flarmFromQ(q: string | null | undefined): string | null {
    const m = String(q ?? '').match(/[0-9A-F]{6}$/i);
    return m ? m[0].toUpperCase() : null;
}

async function fetchFeed(url: string | undefined, jsonPath: string | undefined): Promise<any> {
    if (jsonPath) {
        return JSON.parse(readFileSync(jsonPath, 'utf8'));
    }
    if (!url) throw new Error('no feed source: pass --json, --url, or --compid');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SGP_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {signal: ac.signal});
        if (!res.ok) throw new Error(`sgpaero fetch ${url} -> ${res.status} ${res.statusText}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function resolveUrl(): Promise<string | undefined> {
    if (argv.url) return argv.url;
    if (argv.json) return undefined; // local file, no url needed
    if (!argv.compid) throw new Error('pass one of --compid, --url, or --json');
    const rows = await mysql.query<{url: string}[]>(escape`SELECT url FROM scoringsource WHERE compid = ${argv.compid} AND type = 'sgpaero' LIMIT 1`);
    if (!rows.length) throw new Error(`no sgpaero scoringsource row for compid=${argv.compid} — pass --url explicitly`);
    return rows[0].url;
}

// Build a candidate per pilot. country/glider/greg are passed to
// fingerprintFromPilot exactly as the sgpaero adapter shapes them for the
// pilots table, so the recomputed hashes line up with what findtrackers
// would have collected for the same pilot.
function buildCandidates(pilots: Record<string, AeroPilot>, haveSecret: boolean): Candidate[] {
    const out: Candidate[] = [];
    for (const p of Object.values(pilots)) {
        const compnoRaw = String(p?.d ?? '');
        if (!compnoRaw || /(TBA|TBD)/i.test(compnoRaw)) continue;
        const compno = compnoRaw.substring(0, 4);
        const name = `${String(p.f ?? '').trim()} ${String(p.l ?? '').trim()}`.trim();
        const country = p.z ? String(p.z).substring(0, 2).toUpperCase() : null;
        const glider = p.s ? String(p.s).substring(0, 30) : null;
        const greg = p.w ? String(p.w).substring(0, 8) : null;
        const flarmid = flarmFromQ(p.q);

        const facets = haveSecret
            ? fingerprintFromPilot({
                  name,
                  homeclub: null, // sgpaero feed carries no club
                  glidertype: glider,
                  country,
                  fai: null, // sgpaero feed carries no FAI id
                  greg,
                  compno,
                  flarmid: flarmid ?? undefined
              })
            : null;

        out.push({compno, name, flarmid, facets, raw: {country, glider, greg}});
    }
    out.sort((a, b) => a.compno.localeCompare(b.compno));
    return out;
}

// ----- evidence loading (read-only; mirrors loadPriorAircraft's queries but
// keeps the current comp and exposes raw rows for display) -----

interface AircraftRow {
    flarmid: string;
    compid: string;
    glider_key: string | null;
    greg: string | null;
    country: string | null;
    compno: string | null;
    is_icao_id: string | null;
    match_score: number | null;
    observations: number;
    last_seen: string | null;
}
interface PilotRow {
    flarmid: string;
    pilot_key: string;
    compid: string;
    club_hash: string | null;
    fai_hash: string | null;
    match_score: number | null;
    observations: number;
    last_seen: string | null;
}

async function loadEvidence(flarmids: string[]): Promise<{
    aircraft: Map<string, AircraftRow[]>;
    pilots: Map<string, PilotRow[]>;
    tokens: Map<string, Set<string>>; // `${flarmid}|${pilot_key}` -> token hashes
}> {
    const aircraft = new Map<string, AircraftRow[]>();
    const pilots = new Map<string, PilotRow[]>();
    const tokens = new Map<string, Set<string>>();
    const ids = Array.from(new Set(flarmids.map((f) => f.toUpperCase())));
    if (!ids.length) return {aircraft, pilots, tokens};

    const ageGate = argv.expired ? escape`` : escape` AND last_seen >= DATE_SUB(NOW(), INTERVAL ${IDENTITY_EXPIRY_MONTHS} MONTH)`;

    const aircraftRows = await mysql.query<AircraftRow[]>(
        escape`SELECT flarmid, compid, glider_key, greg, country, compno, is_icao_id, match_score, observations, last_seen
                 FROM flarm_aircraft WHERE flarmid IN (${ids})`.append(ageGate).append(escape` ORDER BY last_seen DESC`)
    );
    for (const r of aircraftRows) {
        const k = r.flarmid.toUpperCase();
        (aircraft.get(k) ?? aircraft.set(k, []).get(k)!).push(r);
    }

    const pilotRows = await mysql.query<PilotRow[]>(
        escape`SELECT flarmid, pilot_key, compid, club_hash, fai_hash, match_score, observations, last_seen
                 FROM flarm_pilot WHERE flarmid IN (${ids})`.append(ageGate).append(escape` ORDER BY last_seen DESC`)
    );
    for (const r of pilotRows) {
        const k = r.flarmid.toUpperCase();
        (pilots.get(k) ?? pilots.set(k, []).get(k)!).push(r);
    }

    // Tokens are comp-independent, keyed (flarmid, pilot_key); load for every
    // referenced pilot clue.
    const tokenRows = await mysql.query<{flarmid: string; pilot_key: string; token_hash: string}[]>(escape`SELECT flarmid, pilot_key, token_hash FROM flarm_pilot_nametoken WHERE flarmid IN (${ids})`);
    for (const t of tokenRows) {
        const k = `${t.flarmid.toUpperCase()}|${t.pilot_key}`;
        (tokens.get(k) ?? tokens.set(k, new Set()).get(k)!).add(t.token_hash);
    }

    return {aircraft, pilots, tokens};
}

// Jaccard-style overlap of the candidate's name token hashes against a stored
// clue's tokens: fraction of the candidate's distinct tokens present in the
// clue. 1.0 == every candidate token is in the stored clue.
function tokenOverlap(candidate: string[], stored: Set<string>): {hit: number; of: number} {
    if (!candidate.length) return {hit: 0, of: 0};
    let hit = 0;
    for (const t of candidate) if (stored.has(t)) hit++;
    return {hit, of: candidate.length};
}

function yn(b: boolean): string {
    return b ? 'Y' : '·';
}

async function main(): Promise<void> {
    const haveSecret = !!process.env.IDENTITY_HMAC_SECRET;
    if (!haveSecret) {
        console.warn('IDENTITY_HMAC_SECRET not set — aircraft-level facets (glider/greg/country/compno) still compared; pilot name/club/FAI matching disabled.\n');
    }

    // Probe the tables up front so a missing migration is a clear message,
    // not a confusing per-query error.
    try {
        await mysql.query(escape`SELECT 1 FROM flarm_aircraft LIMIT 1`);
    } catch (e: any) {
        if (e?.code === 'ER_NO_SUCH_TABLE') {
            console.error('flarm_aircraft does not exist — apply conf/sql/migrations/20260601_flarm_aircraft.sql first.');
            process.exit(1);
        }
        throw e;
    }

    const url = await resolveUrl();
    const feed = await fetchFeed(url, argv.json);
    const pilots = feed?.p;
    if (!pilots || typeof pilots !== 'object') {
        console.error('feed has no pilot object (`p`) — nothing to look up.');
        process.exit(1);
    }

    const candidates = buildCandidates(pilots, haveSecret);
    const withFlarm = candidates.filter((c) => c.flarmid);
    const evidence = await loadEvidence(withFlarm.map((c) => c.flarmid!));

    let pilotsWithEvidence = 0;
    let pilotsWithIdentityMatch = 0;
    const noFlarm: string[] = [];

    for (const c of candidates) {
        if (!c.flarmid) {
            noFlarm.push(`${c.compno} ${c.name}`);
            continue;
        }
        const ac = evidence.aircraft.get(c.flarmid) ?? [];
        const pc = evidence.pilots.get(c.flarmid) ?? [];
        const hasEvidence = ac.length > 0 || pc.length > 0;

        if (!hasEvidence) {
            if (argv.all) console.log(`${c.compno.padEnd(4)} ${c.flarmid}  ${c.name}\n     (no stored evidence)\n`);
            continue;
        }
        pilotsWithEvidence++;

        console.log(`${c.compno.padEnd(4)} ${c.flarmid}  ${c.name}`);

        // Aircraft rows — per source comp. Compare clear-text facets to the
        // sgpaero pilot's own.
        for (const r of ac) {
            const gliderMatch = c.facets?.gliderKey != null && r.glider_key != null && c.facets.gliderKey === r.glider_key;
            const gregMatch = c.facets?.greg != null && r.greg != null && c.facets.greg === r.greg;
            const countryMatch = c.facets?.country != null && r.country != null && c.facets.country === r.country;
            const compnoMatch = r.compno != null && r.compno.toUpperCase() === c.compno.toUpperCase();
            console.log(
                `     aircraft  ${String(r.compid).padEnd(24)} glider=${(r.glider_key ?? '-').padEnd(20)}[${yn(gliderMatch)}] ` +
                    `greg=${(r.greg ?? '-').padEnd(8)}[${yn(gregMatch)}] cc=${(r.country ?? '-').padEnd(2)}[${yn(countryMatch)}] ` +
                    `cn=${(r.compno ?? '-').padEnd(4)}[${yn(compnoMatch)}] icao=${r.is_icao_id ?? '-'} ` +
                    `score=${r.match_score == null ? '-' : r.match_score.toFixed(2)} obs=${r.observations} seen=${r.last_seen ?? '-'}`
            );
        }

        // Pilot clues — per (pilot_key, comp). Name/club/FAI are hashes, so we
        // compare the candidate's recomputed hashes (needs the secret).
        let identityMatched = false;
        for (const r of pc) {
            const stored = evidence.tokens.get(`${c.flarmid}|${r.pilot_key}`) ?? new Set<string>();
            const ov = c.facets ? tokenOverlap(c.facets.nameTokenHashes, stored) : {hit: 0, of: 0};
            const nameWhole = ov.of > 0 && ov.hit === ov.of;
            const clubMatch = c.facets?.clubHash != null && r.club_hash != null && c.facets.clubHash === r.club_hash;
            const faiMatch = c.facets?.faiHash != null && r.fai_hash != null && c.facets.faiHash === r.fai_hash;
            if (nameWhole || faiMatch) identityMatched = true;
            const nameLabel = c.facets ? `name=${ov.hit}/${ov.of}${nameWhole ? '[Y]' : ''}` : 'name=?(no secret)';
            console.log(`     pilot     ${String(r.compid).padEnd(24)} ${nameLabel.padEnd(20)} club[${yn(clubMatch)}] fai[${yn(faiMatch)}] score=${r.match_score == null ? '-' : r.match_score.toFixed(2)} obs=${r.observations} seen=${r.last_seen ?? '-'}`);
        }
        if (identityMatched) pilotsWithIdentityMatch++;
        console.log('');
    }

    console.log('---');
    console.log(`pilots in roster:            ${candidates.length}`);
    console.log(`  with a flarmid (q):        ${withFlarm.length}`);
    console.log(`  flarmid has stored evidence: ${pilotsWithEvidence}`);
    if (haveSecret) console.log(`  evidence confirms same pilot: ${pilotsWithIdentityMatch} (whole-name or FAI hash match)`);
    if (noFlarm.length) console.log(`  no flarmid in feed:        ${noFlarm.length}${argv.all ? ` (${noFlarm.join(', ')})` : ''}`);

    await mysql.end();
}
