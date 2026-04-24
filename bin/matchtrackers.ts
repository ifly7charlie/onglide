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

interface AutocompEntry {
    code: string;
    elevation: number;
    id: number;
    name: string;
    tz: string;
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

async function pickAirfield(initial?: string | null): Promise<AutocompEntry> {
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
    // Strip after the first comma: the sitename is often "Lasham, Hampshire"
    // but the OGN autocomp wants just the airfield name.
    const airfieldHint = comp.sitename ? comp.sitename.split(',')[0].trim() : null;
    const airfield = await pickAirfield(airfieldHint);
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
