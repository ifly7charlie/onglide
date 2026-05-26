//
// Match OGN flightbook tracker IDs / registrations against pilots in the DB.
//
// Flow:
//   1. List competitions in this DB and pick one.
//   2. Search for an airfield via https://flightbook.glidernet.org/api/autocomp/<name>
//      (seeded from the comp's sitename via Nominatim + Overpass) and pick one.
//   3. Decide which date's logbook to fetch: yesterday wins if yesterday was
//      a flown contest day AND today either has no task or the comp's local
//      time is still before noon; otherwise today.
//   4. Fetch https://flightbook.glidernet.org/api/logbook/<code>/<date>/ and,
//      for every identified device whose `competition` field matches a pilot's
//      compno in the selected competition, show db-vs-api (flarmid / greg /
//      glidertype).
//   5. Accept/reject each proposed change individually, then write accepted
//      ones in a single transaction: tracker.trackerid + trackerhistory, and
//      pilots.greg. glidertype is reported only, never written.
//

import prompts from 'prompts';
import escape from 'sql-template-strings';
import Mysql from 'serverless-mysql';
import * as dotenv from 'dotenv';

import {findAirfieldsByName, type RankedAirfield} from '../lib/scoring/shared/airfield';
import {nowInTz} from '../lib/scoring/shared/timezone';
import {toDateCode} from '../lib/datecode';
import {loadMergedDDB, isBlocked, blockedMethod, gliderEquivalent, type DDBEntry} from '../lib/ddb';

dotenv.config({path: '.env.local'});

const mysql = Mysql({
    config: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        // affectedRows = changed rows, not matched rows.
        flags: ['-FOUND_ROWS']
    }
});

interface AutocompEntry {
    code: string;
    elevation: number;
    id: number;
    name: string;
    tz: string;
}

interface ResolvedAirfield {
    autocomp: AutocompEntry;
    osm: RankedAirfield;
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
    tz: string | null;
    start: Date | null;
    end: Date | null;
    trackingconsent: string | null;
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
    // Set when the device's flarm ID is in the merged DDB with
    // tracked!=Y AND the comp has not opted into trackingconsent.
    // Such matches write the 'blocked' sentinel into tracker.trackerid
    // instead of the real flarm id, and never apply gregChange.
    blocked?: boolean;
    blockedSources?: string;
    blockedMethod?: 'ogn-blocked' | 'flarmnet-blocked' | 'ddb-blocked';
}

function onCancel() {
    console.log('*** cancelled');
    process.exit(0);
}

function norm(s: string | null | undefined): string {
    return (s || '').trim().toUpperCase();
}

function isAutoApply(m: Match): boolean {
    if (!m.flarmChange) return false;
    const dbTid = norm(m.pilot.trackerid);
    if (dbTid !== '' && dbTid !== 'UNKNOWN' && dbTid !== 'BLOCKED') return false;
    // Blocked matches auto-apply (writing the 'blocked' sentinel) so
    // the comp organiser sees the privacy decision reflected in the
    // pilot list without needing to confirm each one. The glider-type
    // equivalence check is skipped because we never write the real id.
    if (m.blocked) return true;
    return gliderEquivalent(m.pilot.glidertype, m.device.aircraft);
}

async function autocomp(name: string): Promise<AutocompEntry[]> {
    const r = await fetch(`https://flightbook.glidernet.org/api/autocomp/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`autocomp ${name}: HTTP ${r.status}`);
    return (await r.json()) as AutocompEntry[];
}

async function logbook(code: string, date?: string): Promise<Logbook> {
    const url = date //
        ? `https://flightbook.glidernet.org/api/logbook/${encodeURIComponent(code)}/${date}/`
        : `https://flightbook.glidernet.org/api/logbook/${encodeURIComponent(code)}/`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`logbook ${code} ${date || 'today'}: HTTP ${r.status}`);
    return (await r.json()) as Logbook;
}

interface LogbookDateDecision {
    date: string; // YYYY-MM-DD
    isYesterday: boolean;
    reason: string;
}

// Decide whether to fetch today's or yesterday's logbook. Yesterday wins
// when yesterday was a flown contest day AND either today has no task
// scheduled OR the comp's local time is still before noon (pilots haven't
// yet generated useful data for today). Otherwise fall through to today.
async function chooseLogbookDate(comp: CompetitionRow): Promise<LogbookDateDecision> {
    const tz = comp.tz || 'UTC';
    const local = nowInTz(tz);
    const today = new Date(Date.UTC(local.year, local.month - 1, local.day));
    const yesterday = new Date(today);
    yesterday.setUTCDate(today.getUTCDate() - 1);
    const todayStr = today.toISOString().slice(0, 10);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const todayDc = toDateCode(today);
    const yesterdayDc = toDateCode(yesterday);

    const todayTask = await mysql.query<{n: number}[]>(escape`
        SELECT COUNT(*) AS n
        FROM tasks t JOIN classes c ON c.class = t.class
        WHERE c.compid = ${comp.compid} AND t.datecode = ${todayDc}
    `);
    const yesterdayContest = await mysql.query<{n: number}[]>(escape`
        SELECT COUNT(*) AS n
        FROM tasks t JOIN classes c ON c.class = t.class
        WHERE c.compid = ${comp.compid} AND t.datecode = ${yesterdayDc} AND t.flown = 'Y'
    `);

    const todayHasTask = (todayTask[0]?.n ?? 0) > 0;
    const yesterdayWasContest = (yesterdayContest[0]?.n ?? 0) > 0;

    console.log(
        `Comp local time: ${local.iso} ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} (${tz}).` +
            ` Today task: ${todayHasTask ? 'yes' : 'no'}. Yesterday contest day: ${yesterdayWasContest ? 'yes' : 'no'}.`
    );

    if (yesterdayWasContest && (!todayHasTask || local.hour < 12)) {
        const reason = !todayHasTask //
            ? 'no task today; yesterday was flown'
            : `before noon (${local.hour}h) and yesterday was flown`;
        return {date: yesterdayStr, isYesterday: true, reason};
    }
    return {date: todayStr, isYesterday: false, reason: 'today is the active contest day'};
}

async function resolveOgnCandidates(osms: RankedAirfield[]): Promise<ResolvedAirfield[]> {
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
            // Prefer the OSM source with stronger name overlap; fall back to closer distance.
            const better =
                !existing ||
                osm.nameOverlap > existing.osm.nameOverlap ||
                (osm.nameOverlap === existing.osm.nameOverlap && osm.distanceKm < existing.osm.distanceKm);
            if (better) byCode.set(pick.code, entry);
            break;
        }
    }
    return Array.from(byCode.values()).sort((a, b) => {
        if (a.osm.nameOverlap !== b.osm.nameOverlap) return b.osm.nameOverlap - a.osm.nameOverlap;
        return a.osm.distanceKm - b.osm.distanceKm;
    });
}

async function resolveBySitename(sitename: string): Promise<ResolvedAirfield[]> {
    const search = sitename.trim();
    if (!search) return [];

    console.log(`\nGeocoding "${search}" via Nominatim, then Wikidata...`);
    const {geocode, ranked} = await findAirfieldsByName(search, undefined, (msg, ...args) => console.log(`  ${msg}`, ...args));
    if (!geocode) {
        console.log('  no result — falling back to text search');
        return [];
    }
    console.log(`  → ${geocode.lat.toFixed(4)}, ${geocode.lon.toFixed(4)}  via ${geocode.source}  (${geocode.displayName})`);

    if (!ranked.length) {
        console.log('  no aerodromes found — falling back to text search');
        return [];
    }
    console.log(`  ${ranked.length} OSM aerodrome${ranked.length === 1 ? '' : 's'} (sorted by name match, then distance):`);
    for (const o of ranked) {
        const codes = [o.icao, o.iata].filter(Boolean).join('/') || '-';
        const match = o.matchedTokens.length ? `  name-match: ${o.matchedTokens.join(',')}` : '';
        console.log(`     ${o.distanceKm.toFixed(1).padStart(5)} km  ${o.name}  [${codes}]  (aeroway=${o.aerowayType})${match}`);
    }

    console.log('Resolving OGN codes...');
    return await resolveOgnCandidates(ranked);
}

async function pickCompetition(): Promise<CompetitionRow> {
    // Limit to competitions whose date window contains today. NULL dates are
    // kept in the list so a comp without full metadata doesn't silently
    // disappear.
    const rows = await mysql.query<CompetitionRow[]>(escape`
        SELECT compid, name, sitename, tz, start, end, trackingconsent
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

function buildMatches(
    devices: LogbookDevice[],
    pilots: PilotRow[],
    ddb: Record<string, DDBEntry> | null,
    trackingconsent: string | null
): Match[] {
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

        const flarmChange = !!apiFlarm && norm(apiFlarm) !== norm(pilot.trackerid) && norm(pilot.trackerid) !== 'BLOCKED';
        const gregChange = !!apiGreg && norm(apiGreg) !== norm(pilot.greg);
        const gliderDiffers = !!apiGlider && !!pilot.glidertype && norm(apiGlider) !== norm(pilot.glidertype);

        // DDB Permit-Livetracking gate. Look the device up in the
        // merged DDB; if either upstream marks tracked!=Y and the comp
        // hasn't opted in, write the 'blocked' sentinel instead of
        // the real flarm id.
        const ddbf = ddb && apiFlarm ? ddb[apiFlarm.toLowerCase()] || ddb[apiFlarm.toUpperCase()] || ddb[apiFlarm] : undefined;
        const blocked = isBlocked(ddbf, trackingconsent);
        const blockedSources = blocked ? ddbf?.sources?.join('+') : undefined;
        const blockedMethodValue = blocked ? blockedMethod(ddbf) : undefined;

        matches.push({pilot, device: d, flarmChange, gregChange, gliderDiffers, blocked, blockedSources, blockedMethod: blockedMethodValue});
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
    if (m.blocked) {
        parts.push(`flarmid: ${pilot.trackerid || '(none)'} → blocked (Permit-Livetracking declined: ${m.blockedSources || 'ddb'})`);
    } else if (m.flarmChange) {
        parts.push(`flarmid: ${pilot.trackerid || '(none)'} → ${device.address}`);
    }
    if (m.gliderDiffers) parts.push(`glider differs: db="${pilot.glidertype}" api="${device.aircraft}"`);
    if (!m.flarmChange && !m.gliderDiffers && !m.blocked) parts.push('(in sync)');
    return parts.join('  |  ');
}

function printAll(matches: Match[]) {
    if (!matches.length) {
        console.log('\nNo devices at airfield matched a pilot in this competition.\n');
        return;
    }
    const blockedCount = matches.filter((m) => m.blocked).length;
    if (blockedCount) {
        console.log(`\n${blockedCount} match${blockedCount === 1 ? '' : 'es'} blocked by DDB Permit-Livetracking — will be written as 'blocked'.`);
    }
    console.log(`\n${matches.length} match${matches.length === 1 ? '' : 'es'}:\n`);
    for (const m of matches) {
        const {pilot, device} = m;
        const auto = isAutoApply(m) ? '   [auto-apply]' : '';
        const blocked = m.blocked ? '   [blocked: Permit-Livetracking declined]' : '';
        console.log(`  ${pilotLabel(pilot)}${auto}${blocked}`);
        const apiAddrLabel = m.blocked ? "'blocked'" : device.address;
        console.log(`    flarmid:    db=${pilot.trackerid || '(none)'}  api=${apiAddrLabel}${m.flarmChange || m.blocked ? '   *update*' : ''}`);
        console.log(`    glidertype: db=${pilot.glidertype || '(none)'}  api=${device.aircraft || '(none)'}${m.gliderDiffers ? '   *differs*' : ''}`);
    }
    console.log('');
}

// Report devices at the airfield that did NOT make it into matches[],
// and pilots in this comp that have no logbook device today, so the
// operator can see *why* something is missing rather than guessing.
function reportUnmatched(devices: LogbookDevice[], pilots: PilotRow[], matches: Match[], ddb: Record<string, DDBEntry> | null) {
    const compnoSet = new Set(pilots.map((p) => norm(p.compno)));
    const matchedCompnos = new Set(matches.map((m) => norm(m.pilot.compno)));
    const pilotByGreg = new Map<string, PilotRow>();
    for (const p of pilots) {
        const g = (p.greg || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (g) pilotByGreg.set(g, p);
    }

    const unmatched: {d: LogbookDevice; reason: string}[] = [];
    for (const d of devices) {
        if (!d.identified) {
            unmatched.push({d, reason: 'OGN device not identified (no DDB record)'});
            continue;
        }
        if (!d.competition) {
            unmatched.push({d, reason: 'no competition compno on DDB record (visitor or unset)'});
            continue;
        }
        const cnNorm = norm(d.competition);
        if (!compnoSet.has(cnNorm)) {
            // See if registration would have matched a pilot — common
            // when the DDB CN drifts from the comp's compno.
            const regNorm = (d.registration || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
            const gregHit = regNorm ? pilotByGreg.get(regNorm) : undefined;
            const hint = gregHit ? ` (registration "${d.registration}" matches pilot ${pilotLabel(gregHit)} — DDB CN may be stale)` : '';
            unmatched.push({d, reason: `compno "${d.competition}" not in this comp's pilot list${hint}`});
        }
        // else: pilot was found, device is in matches[]
    }

    if (unmatched.length) {
        console.log(`Devices at airfield not matched (${unmatched.length}):`);
        for (const {d, reason} of unmatched) {
            const id = d.address || '(no address)';
            const reg = d.registration ? ` ${d.registration}` : '';
            const ac = d.aircraft ? ` ${d.aircraft}` : '';
            const cn = d.competition ? ` cn="${d.competition}"` : '';
            console.log(`  ${id}${reg}${ac}${cn} — ${reason}`);
        }
        console.log('');
    }

    const unmatchedPilots = pilots.filter((p) => !matchedCompnos.has(norm(p.compno)));
    if (unmatchedPilots.length) {
        console.log(`Pilots with no logbook device today (${unmatchedPilots.length}):`);
        for (const p of unmatchedPilots) {
            const tid = p.trackerid && norm(p.trackerid) !== '' ? p.trackerid : '(none)';
            const ddbEntry = ddb && tid !== '(none)' && tid !== 'unknown' && tid !== 'blocked' ? ddb[tid.toLowerCase()] || ddb[tid.toUpperCase()] || ddb[tid] : undefined;
            const ddbHint = ddbEntry ? `  [DDB: cn=${ddbEntry.cn || '-'} reg=${ddbEntry.registration || '-'} ${ddbEntry.aircraft_model || ''}]` : '';
            console.log(`  ${pilotLabel(p)}  trackerid=${tid}  greg=${p.greg || '(none)'}  ${p.glidertype || '(no type)'}${ddbHint}`);
        }
        console.log('');
    }
}

interface Decision {
    applyFlarm: boolean;
    applyGreg: boolean;
}

async function reviewMatches(matches: Match[]): Promise<Map<Match, Decision>> {
    const decisions = new Map<Match, Decision>();
    // Blocked matches are actionable too — the auto-apply path below
    // writes the 'blocked' sentinel for them so the front end knows.
    const actionable = matches.filter((m) => m.flarmChange || m.gregChange || m.blocked);
    if (!actionable.length) return decisions;

    // Auto-apply: safe tracker fills (flarmid was unknown/empty and the glider
    // type agrees modulo whitespace/dashes) — don't bother asking. Blocked
    // matches always auto-apply (writing the 'blocked' sentinel) regardless
    // of the current tracker value, so a privacy-declined pilot whose row
    // already holds a real flarm id still gets corrected.
    const auto = actionable.filter(isAutoApply);
    const manual = actionable.filter((m) => !isAutoApply(m));
    for (const m of auto) {
        const applyFlarm = m.blocked ? norm(m.pilot.trackerid) !== 'BLOCKED' : m.flarmChange;
        decisions.set(m, {applyFlarm, applyGreg: m.gregChange});
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
            // Permit-Livetracking gate: write the 'blocked' sentinel
            // rather than the real flarm id, and skip the trackerhistory
            // line that would otherwise leak the address.
            const writeId = m.blocked ? 'blocked' : device.address;
            const method = m.blocked ? m.blockedMethod ?? 'ddb-blocked' : 'ognddb';
            const histFlarm = m.blocked ? 'blocked' : device.address;
            t.query(escape`
                INSERT IGNORE INTO tracker (class, compno, type, trackerid)
                VALUES (${pilot.class}, ${pilot.compno}, 'flarm', 'unknown')
            `);
            t.query(escape`
                UPDATE tracker
                SET trackerid = ${writeId}
                WHERE class = ${pilot.class} AND compno = ${pilot.compno}
            `);
            t.query(escape`
                INSERT INTO trackerhistory (compno, class, changed, flarmid, greg, method)
                VALUES (${pilot.compno}, ${pilot.class}, now(), ${histFlarm}, ${device.registration || null}, ${method})
            `);
            flarmCount++;
        }
        // Don't write the registration for a blocked pilot — same
        // reason: we shouldn't be cross-linking their device records.
        if (d.applyGreg && !m.blocked) {
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
    const decision = await chooseLogbookDate(comp);
    console.log(`Logbook date: ${decision.date} (${decision.reason}).`);
    console.log(`\nFetching logbook for ${airfield.code} (${airfield.name}) on ${decision.date}...`);
    const lb = await logbook(airfield.code, decision.date);
    const devices = lb?.devices || [];
    const identifiedWithCompno = devices.filter((d) => d.identified && d.competition).length;
    console.log(`${devices.length} devices at airfield (${identifiedWithCompno} identified w/ compno).`);

    const pilots = await loadPilots(comp.compid);
    console.log(`${pilots.length} pilots in competition ${comp.compid}.`);

    // Load the merged OGN+FlarmNet DDB so we can honour the
    // Permit-Livetracking flag. A null result (both upstreams down,
    // no cache) just means we can't gate — proceed without blocking.
    console.log('Loading device database (OGN + FlarmNet)...');
    const ddb = await loadMergedDDB();
    if (!ddb) console.log('  (no DDB available — Permit-Livetracking gate disabled this run)');
    if (comp.trackingconsent === 'Y') {
        console.log(`  comp ${comp.compid} has trackingconsent=Y — Permit-Livetracking gate bypassed.`);
    }

    const matches = buildMatches(devices, pilots, ddb, comp.trackingconsent);
    printAll(matches);
    reportUnmatched(devices, pilots, matches, ddb);

    const decisions = await reviewMatches(matches);
    await applyDecisions(decisions);

    await mysql.end();
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
