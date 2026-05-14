//
// Shared device-database (DDB) loader.
//
// Two upstream sources, both publishing the same JSON shape
// (`{devices: [{device_type, device_id, aircraft_model, registration, cn, tracked, identified}, ...]}`):
//
//   * OGN     — http://ddb.glidernet.org/download/?j=1
//   * FlarmNet — https://www.flarmnet.org/files/ddb.json
//
// We merge by `device_id`. The `tracked` flag (FlarmNet calls it
// "Permit Livetracking") combines with most-restrictive-wins: if
// EITHER source says 'N', the merged record is 'N'. A per-comp
// override (competition.trackingconsent) is honoured by callers.
//
// Each side falls back to its own on-disk cache (under DB_PATH) so
// matching keeps working when an upstream is unreachable at startup.
//

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';

export type DDBSource = 'ogn' | 'flarmnet';

export interface DDBEntry {
    device_type: string;
    device_id: string;
    aircraft_model: string;
    registration: string;
    cn: string;
    tracked: string; // 'Y' or 'N' — most-restrictive after merge
    identified: string;
    sources?: DDBSource[]; // diagnostic: which upstream(s) produced this record
    blockedBy?: DDBSource[]; // upstream(s) that set tracked != 'Y' for this device
}

interface DDBPayload {
    devices: DDBEntry[];
}

const dbPath = () => process.env.DB_PATH ?? './db/';
const ognCachePath = () => `${dbPath()}/ddb-cache.json`;
const flarmnetCachePath = () => `${dbPath()}/flarmnet-cache.json`;

const OGN_URL = 'http://ddb.glidernet.org/download/?j=1';
const FLARMNET_URL = 'https://www.flarmnet.org/files/ddb.json';

function cleanRegistration(reg: string | undefined | null): string {
    return (reg || '').replace(/[^A-Z0-9]/gi, '');
}

// Forgiving glider-type comparison. Reduces each side to its leading
// "model key" (alphabetic prefix + first digit run, alphanumerics only,
// uppercase) and accepts a match when one is a prefix of the other. So
// "Ventus 3T/18m" ~ "Ventus 3T", "JS3 18m" ~ "JS-3 18M RES",
// "Ventus 2cxM/18m" ~ "Ventus", "ASG 29E/18m" ~ "ASG-29E", but
// "JS3 18m" ≠ "UFO" and "ASG 27" ≠ "ASG 29".
export function gliderEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
    const key = (s: string | null | undefined): string => {
        const norm = (s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const m = norm.match(/^[A-Z]+\d*/);
        return m ? m[0] : norm;
    };
    const ka = key(a);
    const kb = key(b);
    if (!ka || !kb) return false;
    return ka.startsWith(kb) || kb.startsWith(ka);
}

//
// Merge two device arrays into a keyed map. When a device_id appears
// in both, fields are merged (FlarmNet fills gaps in OGN), and tracked
// is the AND of both flags.
//
export function mergeDDB(ognDevices: DDBEntry[], flarmnetDevices: DDBEntry[]): Record<string, DDBEntry> {
    const out: Record<string, DDBEntry> = {};

    for (const d of ognDevices || []) {
        if (!d?.device_id) continue;
        out[d.device_id] = {
            ...d,
            registration: cleanRegistration(d.registration),
            sources: ['ogn'],
            blockedBy: d.tracked === 'Y' ? [] : ['ogn']
        };
    }

    for (const d of flarmnetDevices || []) {
        if (!d?.device_id) continue;
        const existing = out[d.device_id];
        const reg = cleanRegistration(d.registration);
        if (!existing) {
            out[d.device_id] = {
                ...d,
                registration: reg,
                sources: ['flarmnet'],
                blockedBy: d.tracked === 'Y' ? [] : ['flarmnet']
            };
            continue;
        }
        // Merge: prefer non-empty fields from either side; tracked is most-restrictive.
        const blockedBy: DDBSource[] = [...(existing.blockedBy ?? [])];
        if (d.tracked !== 'Y') blockedBy.push('flarmnet');
        out[d.device_id] = {
            device_type: existing.device_type || d.device_type,
            device_id: existing.device_id,
            aircraft_model: existing.aircraft_model || d.aircraft_model,
            registration: existing.registration || reg,
            cn: existing.cn || d.cn,
            tracked: existing.tracked === 'Y' && d.tracked === 'Y' ? 'Y' : 'N',
            identified: existing.identified === 'Y' && d.identified === 'Y' ? 'Y' : 'N',
            sources: ['ogn', 'flarmnet'],
            blockedBy
        };
    }

    return out;
}

async function fetchSource(url: string, cachePath: string): Promise<DDBEntry[] | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = (await res.json()) as DDBPayload;
        if (!raw?.devices?.length) {
            console.log(`no devices from ${url}`);
            return null;
        }
        try {
            mkdirSync(dbPath(), {recursive: true});
            writeFileSync(cachePath, JSON.stringify(raw));
        } catch (e) {
            console.error(`unable to persist DDB cache ${cachePath}`, e);
        }
        return raw.devices;
    } catch (e) {
        console.error(`unable to fetch ${url}:`, (e as Error).message);
        return null;
    }
}

function loadFromDisk(cachePath: string): DDBEntry[] | null {
    try {
        if (!existsSync(cachePath)) return null;
        const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as DDBPayload;
        if (!raw?.devices?.length) return null;
        console.log(`ddb loaded from local cache ${cachePath}`);
        return raw.devices;
    } catch (e) {
        console.error(`unable to load ddb cache ${cachePath}`, e);
        return null;
    }
}

//
// Fetch both sources in parallel, fall back to per-source disk cache,
// return the merged map. Returns null only if both sources failed AND
// no cache is available.
//
export async function loadMergedDDB(): Promise<Record<string, DDBEntry> | null> {
    const [ognFetched, flarmnetFetched] = await Promise.all([
        fetchSource(OGN_URL, ognCachePath()),
        fetchSource(FLARMNET_URL, flarmnetCachePath())
    ]);

    const ogn = ognFetched ?? loadFromDisk(ognCachePath());
    const flarmnet = flarmnetFetched ?? loadFromDisk(flarmnetCachePath());

    if (!ogn && !flarmnet) return null;

    const merged = mergeDDB(ogn ?? [], flarmnet ?? []);
    const total = Object.keys(merged).length;
    const blocked = Object.values(merged).filter((e) => e.tracked !== 'Y').length;
    console.log(
        `ddb merged: ${total} entries (${blocked} with tracked=N) — ogn:${(ogn ?? []).length} flarmnet:${(flarmnet ?? []).length}`
    );
    return merged;
}

//
// Helper: a device should be blocked from auto-matching when it has a
// DDB entry whose `tracked` is not 'Y' AND the comp has not opted into
// explicit consent.
//
export function isBlocked(entry: DDBEntry | undefined, trackingconsent: string | undefined | null): boolean {
    if (!entry) return false;
    if (entry.tracked === 'Y') return false;
    return (trackingconsent || 'N') !== 'Y';
}

//
// Returns the trackerhistory.method enum value identifying which
// source(s) blocked the device: 'ogn-blocked', 'flarmnet-blocked',
// or 'ddb-blocked' when both sources blocked it.
//
export function blockedMethod(entry: DDBEntry | undefined): 'ogn-blocked' | 'flarmnet-blocked' | 'ddb-blocked' {
    const by = entry?.blockedBy ?? [];
    if (by.length >= 2) return 'ddb-blocked';
    if (by[0] === 'flarmnet') return 'flarmnet-blocked';
    return 'ogn-blocked';
}
