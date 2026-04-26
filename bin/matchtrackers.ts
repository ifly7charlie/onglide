//
// Match OGN flightbook tracker IDs / registrations against pilots in the DB.
//
// Flow:
//   1. List competitions in this DB and pick one.
//   2. Search for an airfield via https://flightbook.glidernet.org/api/autocomp/<name>
//      and pick one (or confirm if unique).
//   3. Fetch https://flightbook.glidernet.org/api/logbook/<code>/ and, for every
//      identified device whose `competition` field matches a pilot's compno in
//      the selected competition, show db-vs-api (flarmid / greg / glidertype).
//   4. Accept/reject each proposed change individually, then write accepted
//      ones in a single transaction: tracker.trackerid + trackerhistory, and
//      pilots.greg. glidertype is reported only, never written.
//

import prompts from 'prompts';
import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';

dotenv.config({path: '.env.local'});

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD
    }
});

const HTTP_UA = 'onglide-matchtrackers/1.0 (https://github.com/ifly7charlie/onglide)';
const NEARBY_RADIUS_KM = 30;

interface AutocompEntry {
    code: string;
    elevation: number;
    id: number;
    name: string;
    tz: string;
}

interface NominatimResult {
    lat: string;
    lon: string;
    display_name: string;
}

interface OverpassElement {
    type: 'node' | 'way' | 'relation';
    id: number;
    lat?: number;
    lon?: number;
    center?: {lat: number; lon: number};
    tags?: Record<string, string>;
}

interface OsmAerodrome {
    name: string;
    icao?: string;
    iata?: string;
    lat: number;
    lon: number;
    distanceKm: number;
    aerowayType: string;
}

interface ResolvedAirfield {
    autocomp: AutocompEntry;
    osm: OsmAerodrome;
    matchedVia: 'icao' | 'iata' | 'name';
}

interface LogbookDevice {
    address: string;
    aircraft: string | null;
    aircraft_type: number;
    competition: string | null;
    db_org: string | null;
    device_type: string;
    identified: boolean;
    registration: string | null;
    tracked: boolean;
}

interface Logbook {
    code: string;
    date: string;
    devices: LogbookDevice[];
}

interface CompetitionRow {
    compid: string;
    name: string | null;
    sitename: string | null;
    start: Date | null;
    end: Date | null;
}

interface PilotRow {
    class: string;
    classdesc: string;
    compno: string;
    greg: string;
    glidertype: string;
    trackerid: string;
}

interface Match {
    pilot: PilotRow;
    device: LogbookDevice;
    flarmChange: boolean;
    gregChange: boolean;
    gliderDiffers: boolean;
}

function onCancel() {
    console.log('*** cancelled');
    process.exit(0);
}

function norm(s: string | null | undefined): string {
    return (s || '').trim().toUpperCase();
}

// Loose glider-type comparison: strip whitespace and dashes before comparing
// so "ASW-20" == "ASW 20" == "asw20".
function gliderEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
    const strip = (s: string | null | undefined) => (s || '').replace(/[\s-]/g, '').toUpperCase();
    return strip(a) === strip(b);
}

function isAutoApply(m: Match): boolean {
    if (!m.flarmChange) return false;
    const dbTid = norm(m.pilot.trackerid);
    if (dbTid !== '' && dbTid !== 'UNKNOWN') return false;
    return gliderEquivalent(m.pilot.glidertype, m.device.aircraft);
}

async function autocomp(name: string): Promise<AutocompEntry[]> {
    const r = await fetch(`https://flightbook.glidernet.org/api/autocomp/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`autocomp ${name}: HTTP ${r.status}`);
    return (await r.json()) as AutocompEntry[];
}

async function logbook(code: string): Promise<Logbook> {
    const r = await fetch(`https://flightbook.glidernet.org/api/logbook/${encodeURIComponent(code)}/`);
    if (!r.ok) throw new Error(`logbook ${code}: HTTP ${r.status}`);
    return (await r.json()) as Logbook;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocode(name: string): Promise<{lat: number; lon: number; displayName: string} | null> {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1`;
    const r = await fetch(url, {headers: {'User-Agent': HTTP_UA}});
    if (!r.ok) {
        console.log(`  Nominatim HTTP ${r.status}`);
        return null;
    }
    const json = (await r.json()) as NominatimResult[];
    if (!json?.length) return null;
    return {lat: parseFloat(json[0].lat), lon: parseFloat(json[0].lon), displayName: json[0].display_name};
}

async function nearbyAerodromes(lat: number, lon: number, radiusKm: number): Promise<OsmAerodrome[]> {
    const r = Math.round(radiusKm * 1000);
    const q = `[out:json][timeout:25];
(
  node["aeroway"~"^(aerodrome|airstrip)$"](around:${r},${lat},${lon});
  way["aeroway"~"^(aerodrome|airstrip)$"](around:${r},${lat},${lon});
  relation["aeroway"~"^(aerodrome|airstrip)$"](around:${r},${lat},${lon});
);
out center tags;`;
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': HTTP_UA},
        body: 'data=' + encodeURIComponent(q)
    });
    if (!resp.ok) {
        console.log(`  Overpass HTTP ${resp.status}`);
        return [];
    }
    const json = (await resp.json()) as {elements: OverpassElement[]};
    const out: OsmAerodrome[] = [];
    for (const el of json.elements || []) {
        const tags = el.tags || {};
        const name = tags.name || tags['name:en'] || tags.icao || tags.iata;
        if (!name) continue;
        const elat = el.lat ?? el.center?.lat;
        const elon = el.lon ?? el.center?.lon;
        if (elat == null || elon == null) continue;
        out.push({
            name,
            icao: tags.icao,
            iata: tags.iata,
            lat: elat,
            lon: elon,
            distanceKm: haversineKm(lat, lon, elat, elon),
            aerowayType: tags.aeroway || ''
        });
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
}

async function resolveOgnCandidates(osms: OsmAerodrome[]): Promise<ResolvedAirfield[]> {
    const byCode = new Map<string, ResolvedAirfield>();
    for (const osm of osms) {
        const tries: Array<{key: string; via: ResolvedAirfield['matchedVia']}> = [];
        if (osm.icao) tries.push({key: osm.icao, via: 'icao'});
        if (osm.iata) tries.push({key: osm.iata, via: 'iata'});
        tries.push({key: osm.name, via: 'name'});

        for (const t of tries) {
            let list: AutocompEntry[] = [];
            try {
                list = await autocomp(t.key);
            } catch (e) {
                console.log(`    autocomp(${t.via}="${t.key}") errored: ${(e as Error).message}`);
                continue;
            }
            console.log(`    autocomp(${t.via}="${t.key}") → ${list.length}${list.length ? ' [' + list.map((l) => l.code).join(', ') + ']' : ''}`);
            if (!list.length) continue;
            const exact = t.via !== 'name' ? list.find((l) => norm(l.code) === norm(t.key)) : undefined;
            const pick = exact || list[0];
            const entry: ResolvedAirfield = {autocomp: pick, osm, matchedVia: t.via};
            const existing = byCode.get(pick.code);
            if (!existing || osm.distanceKm < existing.osm.distanceKm) {
                byCode.set(pick.code, entry);
            }
            break;
        }
    }
    return Array.from(byCode.values()).sort((a, b) => a.osm.distanceKm - b.osm.distanceKm);
}

async function resolveBySitename(sitename: string): Promise<ResolvedAirfield[]> {
    const search = sitename.trim();
    if (!search) return [];

    console.log(`\nGeocoding "${search}" via Nominatim...`);
    const geo = await geocode(search).catch((e) => {
        console.log(`  Nominatim error: ${(e as Error).message}`);
        return null;
    });
    if (!geo) {
        console.log('  no result — falling back to text search');
        return [];
    }
    console.log(`  → ${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)}  (${geo.displayName})`);

    console.log(`Querying Overpass for aeroway=aerodrome|airstrip within ${NEARBY_RADIUS_KM} km...`);
    const osms = await nearbyAerodromes(geo.lat, geo.lon, NEARBY_RADIUS_KM).catch((e) => {
        console.log(`  Overpass error: ${(e as Error).message}`);
        return [] as OsmAerodrome[];
    });
    if (!osms.length) {
        console.log('  no aerodromes found — falling back to text search');
        return [];
    }
    console.log(`  → ${osms.length} OSM aerodrome${osms.length === 1 ? '' : 's'}:`);
    for (const o of osms) {
        const codes = [o.icao, o.iata].filter(Boolean).join('/') || '-';
        console.log(`     ${o.distanceKm.toFixed(1).padStart(5)} km  ${o.name}  [${codes}]  (aeroway=${o.aerowayType})`);
    }

    console.log('Resolving OGN codes...');
    return await resolveOgnCandidates(osms);
}

async function pickCompetition(): Promise<CompetitionRow> {
    // Limit to competitions whose date window contains today. NULL dates are
    // kept in the list so a comp without full metadata doesn't silently
    // disappear.
    const rows = await mysql.query<CompetitionRow[]>(escape`
        SELECT compid, name, sitename, start, end
        FROM competition
        WHERE (start IS NULL OR start <= CURDATE())
          AND (end   IS NULL OR end   >= CURDATE())
        ORDER BY start DESC, compid ASC
    `);
    if (!rows.length) {
        console.log('No current competitions (none with today within start..end) in this database.');
        process.exit(1);
    }
    if (rows.length === 1) {
        const c = rows[0];
        console.log(`Using competition: ${c.compid}${c.name ? ` — ${c.name}` : ''}`);
        return c;
    }
    const fmt = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const {idx} = await prompts(
        {
            type: 'select',
            name: 'idx',
            message: 'Select competition',
            choices: rows.map((c, i) => ({
                title: `${c.compid}${c.name ? ` — ${c.name}` : ''}  [${fmt(c.start)} → ${fmt(c.end)}]`,
                value: i
            }))
        },
        {onCancel}
    );
    return rows[idx];
}

async function pickAirfieldByName(initial?: string | null): Promise<AutocompEntry> {
    const {name} = await prompts(
        {
            type: 'text',
            name: 'name',
            message: 'Airfield search (name / code)',
            initial: initial || '',
            validate: (v: string) => (v && v.length >= 2 ? true : 'at least 2 characters')
        },
        {onCancel}
    );

    const list = await autocomp(name);
    if (!list?.length) {
        console.log(`No airfield matches for "${name}"`);
        process.exit(1);
    }

    if (list.length === 1) {
        const a = list[0];
        const {confirm} = await prompts(
            {
                type: 'confirm',
                name: 'confirm',
                message: `Use ${a.code} — ${a.name} (${a.tz})?`,
                initial: true
            },
            {onCancel}
        );
        if (!confirm) process.exit(0);
        return a;
    }

    const {idx} = await prompts(
        {
            type: 'select',
            name: 'idx',
            message: 'Select airfield',
            choices: list.map((a, i) => ({title: `${a.code} — ${a.name} (${a.tz})`, value: i}))
        },
        {onCancel}
    );
    return list[idx];
}

async function pickAirfield(comp: CompetitionRow): Promise<AutocompEntry> {
    const candidates = comp.sitename ? await resolveBySitename(comp.sitename) : [];

    if (candidates.length) {
        console.log(`\n${candidates.length} OGN airfield${candidates.length === 1 ? '' : 's'} resolved near "${comp.sitename}":`);
        for (const c of candidates) {
            console.log(`   ${c.osm.distanceKm.toFixed(1).padStart(5)} km  ${c.autocomp.code} — ${c.autocomp.name}  (via ${c.matchedVia})`);
        }
        const choices = candidates.map((c, i) => ({
            title: `${c.autocomp.code} — ${c.autocomp.name}  (${c.osm.distanceKm.toFixed(1)} km, ${c.matchedVia})`,
            value: i
        }));
        choices.push({title: '— search by name instead —', value: -1});
        const {idx} = await prompts(
            {
                type: 'select',
                name: 'idx',
                message: 'Select airfield',
                choices,
                initial: 0
            },
            {onCancel}
        );
        if (typeof idx === 'number' && idx >= 0) return candidates[idx].autocomp;
    }

    // Fall back to free-text search; seed with sitename minus anything after a comma
    // (e.g. "Lasham, Hampshire" → "Lasham") so the user usually just hits enter.
    const hint = comp.sitename ? comp.sitename.split(',')[0].trim() : null;
    return await pickAirfieldByName(hint);
}

async function loadPilots(compid: string): Promise<PilotRow[]> {
    return await mysql.query<PilotRow[]>(escape`
        SELECT
            p.class                       AS class,
            COALESCE(cl.description, '')  AS classdesc,
            p.compno                      AS compno,
            COALESCE(p.greg, '')          AS greg,
            COALESCE(p.glidertype, '')    AS glidertype,
            COALESCE(t.trackerid, '')     AS trackerid
        FROM pilots p
        JOIN classes cl ON cl.class = p.class
        LEFT JOIN tracker t
            ON t.class = p.class AND t.compno = p.compno
        WHERE cl.compid = ${compid}
    `);
}

function buildMatches(devices: LogbookDevice[], pilots: PilotRow[]): Match[] {
    const byCompno = new Map<string, PilotRow>();
    for (const p of pilots) byCompno.set(norm(p.compno), p);

    const matches: Match[] = [];
    for (const d of devices) {
        if (!d.identified) continue;
        if (!d.competition) continue;
        const pilot = byCompno.get(norm(d.competition));
        if (!pilot) continue;

        const apiFlarm = d.address || '';
        const apiGreg = d.registration || '';
        const apiGlider = d.aircraft || '';

        const flarmChange = !!apiFlarm && norm(apiFlarm) !== norm(pilot.trackerid);
        const gregChange = !!apiGreg && norm(apiGreg) !== norm(pilot.greg);
        const gliderDiffers = !!apiGlider && !!pilot.glidertype && norm(apiGlider) !== norm(pilot.glidertype);

        matches.push({pilot, device: d, flarmChange, gregChange, gliderDiffers});
    }
    // Stable sort: actionable first, then compno
    matches.sort((a, b) => {
        const aAct = (a.flarmChange ? 1 : 0) + (a.gregChange ? 1 : 0);
        const bAct = (b.flarmChange ? 1 : 0) + (b.gregChange ? 1 : 0);
        if (aAct !== bAct) return bAct - aAct;
        return a.pilot.compno.localeCompare(b.pilot.compno);
    });
    return matches;
}

function pilotLabel(p: PilotRow): string {
    return `${p.classdesc || p.class}/${p.compno}`;
}

function summarise(m: Match): string {
    const {pilot, device} = m;
    const parts: string[] = [];
    parts.push(pilotLabel(pilot));
    if (m.flarmChange) parts.push(`flarmid: ${pilot.trackerid || '(none)'} → ${device.address}`);
    if (m.gliderDiffers) parts.push(`glider differs: db="${pilot.glidertype}" api="${device.aircraft}"`);
    if (!m.flarmChange && !m.gliderDiffers) parts.push('(in sync)');
    return parts.join('  |  ');
}

function printAll(matches: Match[]) {
    if (!matches.length) {
        console.log('\nNo devices at airfield matched a pilot in this competition.\n');
        return;
    }
    console.log(`\n${matches.length} match${matches.length === 1 ? '' : 'es'}:\n`);
    for (const m of matches) {
        const {pilot, device} = m;
        const auto = isAutoApply(m) ? '   [auto-apply]' : '';
        console.log(`  ${pilotLabel(pilot)}${auto}`);
        console.log(`    flarmid:    db=${pilot.trackerid || '(none)'}  api=${device.address}${m.flarmChange ? '   *update*' : ''}`);
        console.log(`    glidertype: db=${pilot.glidertype || '(none)'}  api=${device.aircraft || '(none)'}${m.gliderDiffers ? '   *differs*' : ''}`);
    }
    console.log('');
}

interface Decision {
    applyFlarm: boolean;
    applyGreg: boolean;
}

async function reviewMatches(matches: Match[]): Promise<Map<Match, Decision>> {
    const decisions = new Map<Match, Decision>();
    const actionable = matches.filter((m) => m.flarmChange || m.gregChange);
    if (!actionable.length) return decisions;

    // Auto-apply: safe tracker fills (flarmid was unknown/empty and the glider
    // type agrees modulo whitespace/dashes) — don't bother asking.
    const auto = actionable.filter(isAutoApply);
    const manual = actionable.filter((m) => !isAutoApply(m));
    for (const m of auto) {
        decisions.set(m, {applyFlarm: m.flarmChange, applyGreg: m.gregChange});
        console.log(`[auto] ${summarise(m)}`);
    }
    if (auto.length) console.log('');

    if (!manual.length) return decisions;

    console.log(`Reviewing ${manual.length} proposed change${manual.length === 1 ? '' : 's'} (y=apply, n=skip, a=accept-all-remaining, q=quit review).\n`);

    let acceptAll = false;
    for (let i = 0; i < manual.length; i++) {
        const m = manual[i];
        console.log(`[${i + 1}/${manual.length}] ${summarise(m)}`);

        if (acceptAll) {
            decisions.set(m, {applyFlarm: m.flarmChange, applyGreg: m.gregChange});
            console.log('  → accepted (all)\n');
            continue;
        }

        const {choice} = await prompts(
            {
                type: 'select',
                name: 'choice',
                message: 'Apply?',
                choices: [
                    {title: 'yes — apply this', value: 'y'},
                    {title: 'no — skip this', value: 'n'},
                    {title: 'accept all remaining', value: 'a'},
                    {title: 'quit review', value: 'q'}
                ],
                initial: 0
            },
            {onCancel}
        );

        if (choice === 'q') break;
        if (choice === 'a') {
            acceptAll = true;
            decisions.set(m, {applyFlarm: m.flarmChange, applyGreg: m.gregChange});
        } else if (choice === 'y') {
            decisions.set(m, {applyFlarm: m.flarmChange, applyGreg: m.gregChange});
        }
        console.log('');
    }
    return decisions;
}

async function applyDecisions(decisions: Map<Match, Decision>) {
    if (!decisions.size) {
        console.log('Nothing accepted — no changes written.\n');
        return;
    }

    const t = mysql.transaction();
    let flarmCount = 0;
    let gregCount = 0;

    for (const [m, d] of decisions) {
        const {pilot, device} = m;
        if (d.applyFlarm) {
            t.query(escape`
                INSERT IGNORE INTO tracker (class, compno, type, trackerid)
                VALUES (${pilot.class}, ${pilot.compno}, 'flarm', 'unknown')
            `);
            t.query(escape`
                UPDATE tracker
                SET trackerid = ${device.address}
                WHERE class = ${pilot.class} AND compno = ${pilot.compno}
            `);
            t.query(escape`
                INSERT INTO trackerhistory (compno, changed, flarmid, greg, method)
                VALUES (${pilot.compno}, now(), ${device.address}, ${device.registration || null}, 'ognddb')
            `);
            flarmCount++;
        }
        if (d.applyGreg) {
            t.query(escape`
                UPDATE pilots
                SET greg = ${device.registration}
                WHERE class = ${pilot.class} AND compno = ${pilot.compno}
            `);
            gregCount++;
        }
    }

    await t.commit();
    console.log(`Wrote ${flarmCount} flarmid update${flarmCount === 1 ? '' : 's'}, ${gregCount} greg update${gregCount === 1 ? '' : 's'}.\n`);
}

async function main() {
    mysql.connect();

    const comp = await pickCompetition();
    const airfield = await pickAirfield(comp);
    console.log(`\nFetching logbook for ${airfield.code} (${airfield.name})...`);
    const lb = await logbook(airfield.code);
    const devices = lb?.devices || [];
    const identifiedWithCompno = devices.filter((d) => d.identified && d.competition).length;
    console.log(`${devices.length} devices at airfield (${identifiedWithCompno} identified w/ compno).`);

    const pilots = await loadPilots(comp.compid);
    console.log(`${pilots.length} pilots in competition ${comp.compid}.`);

    const matches = buildMatches(devices, pilots);
    printAll(matches);

    const decisions = await reviewMatches(matches);
    await applyDecisions(decisions);

    await mysql.end();
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
