// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Airfield locator: geocode a competition sitename via OpenStreetMap
// Nominatim, then ask Overpass for nearby `aeroway=aerodrome|airstrip`
// features and rank them by name overlap with the sitename, breaking
// ties by distance. Used by:
//   - lib/scoring/sources/soaringspotscrape.ts (automatic resolution
//     replacing the previous Mapbox geocode)
//   - bin/matchtrackers.ts (interactive CLI; OGN logbook lookup runs
//     against the OGN-resolved subset of these candidates)
//
// All network calls fail open — Nominatim/Overpass errors return
// null/[] and the caller decides what to do.
//

import distance from '@turf/distance';
import {point} from '@turf/helpers';

const HTTP_UA = 'onglide-airfield-locator/1.0 (https://github.com/ifly7charlie/onglide)';
const DEFAULT_RADIUS_KM = 30;

// Optional diagnostic logger threaded through the network helpers so
// callers (matchtrackers, ssscrape) can surface endpoint-level failures
// — fetch threw, HTTP non-2xx, or zero results — instead of having them
// vanish into a generic "no result" verdict.
type Logger = (msg: string, ...args: unknown[]) => void;
const noopLogger: Logger = () => {};

// Type-words that say nothing about *which* airfield we're looking at —
// drop them so a sitename of "Lasham" matches "Lasham Airfield" cleanly.
// NFD normalisation strips diacritics, so the German "ä" forms collapse
// to "gelande" / "segelfluggelande" rather than the "ae" transliteration.
const STOPWORDS = new Set([
    // English
    'airfield',
    'airport',
    'aerodrome',
    'airstrip',
    // German (de)
    'flugplatz',
    'flughafen',
    'segelflugplatz',
    'segelfluggelande',
    'verkehrslandeplatz',
    'modellflugplatz',
    'fliegerhorst',
    'heeresflugplatz',
    'sonderlandeplatz',
    'sonderflugplatz',
    'gelande',
    // French (fr)
    'aerodrome',
    'aeroport',
    'altiport',
    'altisurface',
    'velisurface',
    // Romance shared / es / it / pt
    'aerodrom',
    'aerodromo',
    'aeropuerto',
    'aeroporto',
    'aviosuperficie',
    // Dutch (nl)
    'vliegveld',
    'vliegbasis',
    'luchthaven',
    'zweefvliegterrein',
    // Finnish (fi)
    'lentokentta',
    'lentopaikka',
    'lentoasema',
    'purjelentokentta',
    // Estonian (et) — bonus
    'lennujaam',
    'lennuvali',
    // Swedish (sv)
    'flygplats',
    'flygfalt',
    'flygbas',
    // Danish / Norwegian (da/nb)
    'lufthavn',
    'flyveplads',
    'flyplass',
    // Czech / Slovak (cs/sk)
    'letiste',
    'letisko',
    // Polish (pl)
    'lotnisko',
    'ladowisko',
    // Slovenian (sl)
    'letalisce',
    'vzletisce',
    // Hungarian (hu)
    'repuloter',
    'repter',
    // Baltic — bonus (lt/lv)
    'aerodromas',
    'lidosta',
    // Turkish — bonus
    'havalimani',
    'havaalani'
]);

// Non-decomposable letters that NFD leaves as-is. Without this map a
// Polish "lądowisko" would never collapse to the stopword "ladowisko",
// and Danish/Norwegian "Ærø" would never line up with site spellings
// like "Aero". Applied symmetrically to both site and OSM tokens so the
// match stays consistent regardless of which side spells it natively.
// Applied AFTER toLowerCase, so we only need lowercase keys — uppercase
// forms either decompose under NFD (e.g. İ → i + combining-dot-above,
// stripped by the existing diacritic regex) or lowercase to a key in
// this map (Æ → æ, Ø → ø, Ł → ł, ß has no uppercase, etc.).
const NON_DECOMPOSABLE_MAP: Record<string, string> = {
    æ: 'ae',
    œ: 'oe',
    ø: 'o',
    ł: 'l',
    ß: 'ss',
    ı: 'i', // Turkish dotless i
    þ: 'th', // Icelandic thorn
    ð: 'd' // Icelandic eth
};
const NON_DECOMPOSABLE_RE = new RegExp(`[${Object.keys(NON_DECOMPOSABLE_MAP).join('')}]`, 'g');

// Token-match minimum: two tokens with the same first N characters count
// as a match even if the rest differs. Catches inflectional suffixes
// like Finnish genitive ("Räyskälä" → "Räyskälän") that exact equality
// misses. Set just high enough to keep coincidental short-prefix
// collisions ("london"/"lonely") from registering as matches.
const MIN_TOKEN_PREFIX_MATCH = 5;

function tokenMatch(a: string, b: string): boolean {
    if (a === b) return true;
    const min = Math.min(a.length, b.length);
    if (min < MIN_TOKEN_PREFIX_MATCH) return false;
    let i = 0;
    while (i < min && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i >= MIN_TOKEN_PREFIX_MATCH;
}

export interface OsmAerodrome {
    name: string;
    icao?: string;
    iata?: string;
    lat: number;
    lon: number;
    distanceKm: number;
    aerowayType: string; // 'aerodrome' | 'airstrip'
    // Locality address tags joined into one space-separated string —
    // addr:city, addr:town, addr:place, addr:hamlet, addr:suburb, and
    // is_in:city when present. Lets ranking match clubs named for the
    // club (e.g. "London Gliding Club", addr:city=Dunstable) against a
    // town-only sitename like "Dunstable, UK".
    locality?: string;
}

const LOCALITY_TAG_KEYS = ['addr:city', 'addr:town', 'addr:place', 'addr:hamlet', 'addr:suburb', 'is_in:city'];
function extractLocality(tags: Record<string, string>): string | undefined {
    const parts: string[] = [];
    for (const k of LOCALITY_TAG_KEYS) {
        const v = tags[k];
        if (v && !parts.includes(v)) parts.push(v);
    }
    return parts.length ? parts.join(' ') : undefined;
}

export interface RankedAirfield extends OsmAerodrome {
    nameOverlap: number;
    matchedTokens: string[];
}

export interface NominatimGeocode {
    lat: number;
    lon: number;
    displayName: string;
    countryCode?: string; // ISO-3166-1 alpha-2, uppercased
    source: 'nominatim' | 'wikidata';
    // OSM feature class from Nominatim (`aeroway`, `place`, `highway`,
    // …). Wikidata results don't have one — left undefined. Callers in
    // airfield-only mode use this to short-circuit: a class=aeroway
    // geocode is the airfield itself and needs no further refinement.
    featureClass?: string;
}

interface NominatimResult {
    lat: string;
    lon: string;
    display_name: string;
    class?: string;
    type?: string;
    address?: {
        country_code?: string;
    };
}

// Nominatim sorts hits by query-string relevance, not feature type, so a
// street or waterway whose name *exactly* equals the sitename can float
// above the aerodrome that merely *contains* it — e.g. "Mönchsheide" the
// residential road in Overath beats "Segelfluggelände Mönchsheide" 45 km
// south. That gap exceeds the Overpass refinement radius, so the row
// would lock at the wrong street. Pick by feature type, not Nominatim's
// order:
//   1. an aeroway feature                — the airfield itself;
//   2. a place feature (town/village/…)  — a settlement point near the
//      site, good enough to seed the Overpass refinement sweep;
//   3. any non-street/waterway/railway hit;
//   4. Nominatim's raw top hit as a last resort.
const GEOCODE_DEMOTED_CLASSES = new Set(['highway', 'waterway', 'railway']);

function pickBestNominatimResult(results: NominatimResult[], log: Logger): NominatimResult {
    const aeroway = results.find((r) => r.class === 'aeroway');
    if (aeroway) {
        if (aeroway !== results[0]) log(`nominatim: preferring aeroway hit "${aeroway.display_name}" over top hit "${results[0].display_name}"`);
        return aeroway;
    }
    const place = results.find((r) => r.class === 'place');
    if (place && place !== results[0]) {
        log(`nominatim: demoting ${results[0].class} top hit "${results[0].display_name}"; using place "${place.display_name}"`);
        return place;
    }
    const nonStreet = results.find((r) => !r.class || !GEOCODE_DEMOTED_CLASSES.has(r.class));
    if (nonStreet && nonStreet !== results[0]) {
        log(`nominatim: demoting ${results[0].class} top hit "${results[0].display_name}"; using "${nonStreet.display_name}"`);
        return nonStreet;
    }
    return results[0];
}

interface OverpassElement {
    type: 'node' | 'way' | 'relation';
    id: number;
    lat?: number;
    lon?: number;
    center?: {lat: number; lon: number};
    tags?: Record<string, string>;
}

function tokenize(s: string): string[] {
    if (!s) return [];
    const normalized = s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(NON_DECOMPOSABLE_RE, (c) => NON_DECOMPOSABLE_MAP[c]);
    const out: string[] = [];
    for (const t of normalized.split(/[\s\-,.()'"\/]+/)) {
        if (t.length < 3) continue;
        if (STOPWORDS.has(t)) continue;
        out.push(t);
    }
    return out;
}

export async function geocodeNominatim(name: string, log: Logger = noopLogger): Promise<NominatimGeocode | null> {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=10&addressdetails=1`;
    let resp: Response;
    try {
        resp = await fetch(url, {headers: {'User-Agent': HTTP_UA}});
    } catch (e) {
        log(`nominatim: fetch threw for "${name}":`, e);
        return null;
    }
    if (!resp.ok) {
        log(`nominatim: HTTP ${resp.status} for "${name}"`);
        return null;
    }
    const json = (await resp.json().catch(() => null)) as NominatimResult[] | null;
    if (!json?.length) {
        log(`nominatim: no match for "${name}"`);
        return null;
    }
    const r = pickBestNominatimResult(json, log);
    return {
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        displayName: r.display_name,
        countryCode: r.address?.country_code ? r.address.country_code.toUpperCase() : undefined,
        source: 'nominatim',
        featureClass: r.class
    };
}

// Aerodrome-biased Nominatim retry. Append the English term `aerodrome`
// to bias the gazetteer toward the `aeroway=aerodrome` feature when the
// bare sitename matched a same-named settlement (e.g. nine "Hütten"
// places in Germany, none of which is Flugplatz Hütten-Hotzenwald).
// `aerodrome` works across locales because it's the literal OSM tag
// value, not a language word. Returns only an aeroway hit — accepting
// any other class here would just reintroduce the original ambiguity.
export async function geocodeNominatimAerodrome(name: string, log: Logger = noopLogger, countryCode?: string): Promise<NominatimGeocode | null> {
    // Strip a trailing `, <Country>` segment — Nominatim's text matcher
    // treats `Hütten, Germany aerodrome` as three tokens and finds
    // nothing, whereas `Hütten aerodrome` lifts the actual aeroway hit
    // out of the noise cleanly. `countryCode` (ISO alpha-2) is passed
    // through Nominatim's `countrycodes` filter to keep an ASCII-folded
    // sitename like `Żar` from matching `Aeropuerto Almirante Marcos
    // Zar` in Argentina.
    const base = name.replace(/\s*,\s*[^,]+$/, '').trim() || name;
    const q = `${base} aerodrome`;
    const ccParam = countryCode ? `&countrycodes=${encodeURIComponent(countryCode.toLowerCase())}` : '';
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1${ccParam}`;
    let resp: Response;
    try {
        resp = await fetch(url, {headers: {'User-Agent': HTTP_UA}});
    } catch (e) {
        log(`nominatim aerodrome retry: fetch threw for "${q}":`, e);
        return null;
    }
    if (!resp.ok) {
        log(`nominatim aerodrome retry: HTTP ${resp.status} for "${q}"`);
        return null;
    }
    const json = (await resp.json().catch(() => null)) as NominatimResult[] | null;
    if (!json?.length) {
        log(`nominatim aerodrome retry: no match for "${q}"`);
        return null;
    }
    const aero = json.find((r) => r.class === 'aeroway');
    if (!aero) {
        log(`nominatim aerodrome retry: no aeroway feature in ${json.length} result(s) for "${q}"`);
        return null;
    }
    return {
        lat: parseFloat(aero.lat),
        lon: parseFloat(aero.lon),
        displayName: aero.display_name,
        countryCode: aero.address?.country_code ? aero.address.country_code.toUpperCase() : undefined,
        source: 'nominatim',
        featureClass: aero.class
    };
}

// Multi-result Nominatim wrapper used by the step-3 fallback. Returns
// up to `limit` geocoded hits in `pickBestNominatimResult` preference
// order (aeroway, then place, then non-street, then everything else),
// so the caller can try several seed points before giving up.
export async function geocodeNominatimSeeds(name: string, limit: number = 5, log: Logger = noopLogger): Promise<NominatimGeocode[]> {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=${Math.max(10, limit * 2)}&addressdetails=1`;
    let resp: Response;
    try {
        resp = await fetch(url, {headers: {'User-Agent': HTTP_UA}});
    } catch (e) {
        log(`nominatim seeds: fetch threw for "${name}":`, e);
        return [];
    }
    if (!resp.ok) {
        log(`nominatim seeds: HTTP ${resp.status} for "${name}"`);
        return [];
    }
    const json = (await resp.json().catch(() => null)) as NominatimResult[] | null;
    if (!json?.length) return [];
    const score = (r: NominatimResult) =>
        r.class === 'aeroway' ? 0 : r.class === 'place' ? 1 : !r.class || !GEOCODE_DEMOTED_CLASSES.has(r.class) ? 2 : 3;
    const sorted = [...json].sort((a, b) => score(a) - score(b));
    return sorted.slice(0, limit).map((r) => ({
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        displayName: r.display_name,
        countryCode: r.address?.country_code ? r.address.country_code.toUpperCase() : undefined,
        source: 'nominatim' as const,
        featureClass: r.class
    }));
}

interface SparqlBinding {
    item: {value: string};
    itemLabel?: {value: string};
    lat: {value: string};
    lon: {value: string};
    cc?: {value: string};
}

// Wikidata fallback for sitenames Nominatim doesn't know about — typical
// of German micro-toponyms like "Garbenheimer Wiesen" which exist as
// Wikidata items (e.g. Q126164412 "Garbenheimer Wiesen gliding site")
// with P625 coordinate-location and P17 → P297 country ISO code, but
// have no OSM place feature for Nominatim to anchor on. Free, no API
// key, just a User-Agent.
export async function geocodeWikidata(name: string, log: Logger = noopLogger): Promise<NominatimGeocode | null> {
    const escName = name.replace(/[\\"]/g, '\\$&');
    const query = `SELECT ?item ?itemLabel ?lat ?lon ?cc WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch".
    bd:serviceParam wikibase:endpoint "www.wikidata.org".
    bd:serviceParam mwapi:search "${escName}".
    bd:serviceParam mwapi:language "en".
    ?item wikibase:apiOutputItem mwapi:item.
  }
  ?item p:P625/psv:P625 ?coord.
  ?coord wikibase:geoLatitude ?lat; wikibase:geoLongitude ?lon.
  OPTIONAL { ?item wdt:P17/wdt:P297 ?cc. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de". }
} LIMIT 1`;

    let resp: Response;
    try {
        resp = await fetch('https://query.wikidata.org/sparql', {
            method: 'POST',
            headers: {
                'User-Agent': HTTP_UA,
                Accept: 'application/sparql-results+json',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'query=' + encodeURIComponent(query)
        });
    } catch (e) {
        log(`wikidata: fetch threw for "${name}":`, e);
        return null;
    }
    if (!resp.ok) {
        log(`wikidata: HTTP ${resp.status} for "${name}"`);
        return null;
    }
    const json = (await resp.json().catch(() => null)) as {results?: {bindings?: SparqlBinding[]}} | null;
    const row = json?.results?.bindings?.[0];
    if (!row) {
        log(`wikidata: no match for "${name}"`);
        return null;
    }
    return {
        lat: parseFloat(row.lat.value),
        lon: parseFloat(row.lon.value),
        displayName: row.itemLabel?.value || name,
        countryCode: row.cc?.value ? row.cc.value.toUpperCase() : undefined,
        source: 'wikidata'
    };
}

// Build a regex alternation from the sitename's word tokens, preserving
// diacritics (Overpass `~` matches the raw OSM value byte-by-byte —
// `Hutten` won't match `Hütten`, and the case-insensitive `,i` flag is
// broken for multi-byte UTF-8 so we can't rely on it either). Each
// token contributes up to four variants: original, original capitalised,
// ASCII-folded (for OSM names tagged without diacritics e.g.
// `Huetten Hotzenwald`), and ASCII-folded capitalised. Strips the
// trailing `, <Country>` segment so the country name doesn't become a
// matchable token, and filters airfield-type stopwords so they don't
// widen the regex pointlessly. Regex-special characters are escaped.
function sitenameRegexAlternation(sitename: string): string | null {
    const stripped = sitename.replace(/\s*,\s*[^,]+$/, '').trim() || sitename;
    const variants = new Set<string>();
    const addVariant = (s: string) => {
        if (!s) return;
        variants.add(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const cap = s.charAt(0).toLocaleUpperCase() + s.slice(1);
        if (cap !== s) variants.add(cap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    };
    for (const t of stripped.split(/[\s\-,.()'"\/]+/)) {
        if (t.length < 3) continue;
        const norm = t
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(NON_DECOMPOSABLE_RE, (c) => NON_DECOMPOSABLE_MAP[c]);
        if (STOPWORDS.has(norm)) continue;
        addVariant(t);
        const ascii = t
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(NON_DECOMPOSABLE_RE, (c) => NON_DECOMPOSABLE_MAP[c]);
        if (ascii !== t) addVariant(ascii);
    }
    if (!variants.size) return null;
    return Array.from(variants).join('|');
}

// Country-scoped aerodrome search. Asks Overpass for every
// `aeroway=aerodrome|airstrip` whose `name` regex-matches a token in the
// sitename, anywhere inside the ISO country area. Avoids the seed-point
// failure mode of `nearbyAerodromes` — when the geocode lands on a
// same-named town 150 km from the actual airfield (e.g. "Hütten,
// Germany"), the 30 km radius sweep misses it; this query doesn't.
// `seedLat`/`seedLon` are optional and only feed the ranking tiebreaker:
// the regex can return several country-wide matches (Hütten-Hotzenwald
// AND Hüttenbusch in Germany) and the Nominatim seed's region picks
// between them.
export async function findAerodromesByCountry(
    countryCode: string,
    sitename: string,
    seedLat?: number,
    seedLon?: number,
    log: Logger = noopLogger
): Promise<RankedAirfield[]> {
    const pattern = sitenameRegexAlternation(sitename);
    if (!pattern) {
        log(`overpass country search: no usable tokens in "${sitename}"`);
        return [];
    }
    const cc = countryCode.toUpperCase();
    const haveSeed = typeof seedLat === 'number' && typeof seedLon === 'number';
    const origin = haveSeed ? point([seedLon!, seedLat!]) : null;

    // Two passes — one matching against `name`, one against `addr:city`
    // — issued as separate requests. Trying to union them in a single
    // Overpass query (`(way[name~p](area.a); way[addr:city~p](area.a);)`)
    // consistently returns zero hits, an Overpass quirk with named-area
    // references across union members. Two requests also degrade
    // gracefully under rate-limiting: a 429 on one pass still lets the
    // other contribute. Picks up clubs named for the club (London
    // Gliding Club at Dunstable) via `addr:city=Dunstable`.
    const collected = new Map<string, OsmAerodrome>();
    const seenKey = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
    const ingest = (els: OverpassElement[] | null | undefined) => {
        for (const el of els || []) {
            const tags = el.tags || {};
            const aname = tags.name || tags['name:en'] || tags.icao || tags.iata;
            if (!aname) continue;
            const elat = el.lat ?? el.center?.lat;
            const elon = el.lon ?? el.center?.lon;
            if (elat == null || elon == null) continue;
            const k = seenKey(elat, elon);
            if (collected.has(k)) continue;
            collected.set(k, {
                name: aname,
                icao: tags.icao,
                iata: tags.iata,
                lat: elat,
                lon: elon,
                distanceKm: origin ? distance(origin, point([elon, elat])) : 0,
                aerowayType: tags.aeroway || '',
                locality: extractLocality(tags)
            });
        }
    };

    const passes: Array<{label: string; key: string}> = [
        {label: 'name', key: 'name'},
        {label: 'addr:city', key: 'addr:city'}
    ];
    for (const {label, key} of passes) {
        const q = `[out:json][timeout:25];
area["ISO3166-1"="${cc}"]->.a;
(
  node["aeroway"~"^(aerodrome|airstrip)$"]["${key}"~"${pattern}"](area.a);
  way["aeroway"~"^(aerodrome|airstrip)$"]["${key}"~"${pattern}"](area.a);
  relation["aeroway"~"^(aerodrome|airstrip)$"]["${key}"~"${pattern}"](area.a);
);
out center tags;`;
        let resp: Response;
        try {
            resp = await fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': HTTP_UA},
                body: 'data=' + encodeURIComponent(q)
            });
        } catch (e) {
            log(`overpass country search (${label}): fetch threw for cc=${cc}:`, e);
            continue;
        }
        if (!resp.ok) {
            log(`overpass country search (${label}): HTTP ${resp.status} for cc=${cc}`);
            continue;
        }
        const json = (await resp.json().catch(() => null)) as {elements: OverpassElement[]} | null;
        const hits = json?.elements?.length ?? 0;
        log(`overpass country search (${label}): ${hits} hit(s) in ${cc}`);
        ingest(json?.elements);
    }

    if (!collected.size) return [];
    return rankAirfieldsBySite(sitename, Array.from(collected.values()));
}

export async function nearbyAerodromes(lat: number, lon: number, radiusKm: number = DEFAULT_RADIUS_KM, log: Logger = noopLogger): Promise<OsmAerodrome[]> {
    const r = Math.round(radiusKm * 1000);
    const q = `[out:json][timeout:25];
(
  node["aeroway"~"^(aerodrome|airstrip)$"](around:${r},${lat},${lon});
  way["aeroway"~"^(aerodrome|airstrip)$"](around:${r},${lat},${lon});
  relation["aeroway"~"^(aerodrome|airstrip)$"](around:${r},${lat},${lon});
);
out center tags;`;

    let resp: Response;
    try {
        resp = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': HTTP_UA},
            body: 'data=' + encodeURIComponent(q)
        });
    } catch (e) {
        log(`overpass: fetch threw at (${lat}, ${lon}):`, e);
        return [];
    }
    if (!resp.ok) {
        log(`overpass: HTTP ${resp.status} at (${lat}, ${lon})`);
        return [];
    }
    const json = (await resp.json().catch(() => null)) as {elements: OverpassElement[]} | null;
    if (!json?.elements) {
        log(`overpass: no elements field in response at (${lat}, ${lon})`);
        return [];
    }

    const origin = point([lon, lat]);
    const out: OsmAerodrome[] = [];
    for (const el of json.elements) {
        const tags = el.tags || {};
        const aname = tags.name || tags['name:en'] || tags.icao || tags.iata;
        if (!aname) continue;
        const elat = el.lat ?? el.center?.lat;
        const elon = el.lon ?? el.center?.lon;
        if (elat == null || elon == null) continue;
        out.push({
            name: aname,
            icao: tags.icao,
            iata: tags.iata,
            lat: elat,
            lon: elon,
            distanceKm: distance(origin, point([elon, elat])),
            aerowayType: tags.aeroway || '',
            locality: extractLocality(tags)
        });
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
}

export function rankAirfieldsBySite(sitename: string, aerodromes: OsmAerodrome[]): RankedAirfield[] {
    const siteTokens = tokenize(sitename);
    const ranked: RankedAirfield[] = aerodromes.map((a) => {
        const matched: string[] = [];
        // Match against name + locality combined — a club named for the
        // club (e.g. "London Gliding Club") in a sitename-named town
        // (Dunstable) gets picked up via addr:city without dropping
        // name-based matches.
        const haystack = a.locality ? `${a.name} ${a.locality}` : a.name;
        for (const t of tokenize(haystack)) {
            if (siteTokens.some((s) => tokenMatch(s, t))) matched.push(t);
        }
        return {...a, nameOverlap: matched.length, matchedTokens: matched};
    });
    ranked.sort((a, b) => {
        if (a.nameOverlap !== b.nameOverlap) return b.nameOverlap - a.nameOverlap;
        return a.distanceKm - b.distanceKm;
    });
    return ranked;
}

export async function findAirfieldsByPoint(sitename: string, lat: number, lon: number, radiusKm: number = DEFAULT_RADIUS_KM, log: Logger = noopLogger): Promise<RankedAirfield[]> {
    const aerodromes = await nearbyAerodromes(lat, lon, radiusKm, log);
    return rankAirfieldsBySite(sitename, aerodromes);
}

export async function findAirfieldsByName(
    sitename: string,
    radiusKm: number = DEFAULT_RADIUS_KM,
    log: Logger = noopLogger
): Promise<{geocode: NominatimGeocode | null; ranked: RankedAirfield[]}> {
    let geocode = await geocodeNominatim(sitename, log);
    if (!geocode) geocode = await geocodeWikidata(sitename, log);

    // If both endpoints reject the full string, retry with the trailing
    // ", <suffix>" segment stripped. Common case: "Garbenheimer Wiesen,
    // Germany" — both Nominatim and Wikidata's label search fail on the
    // country-suffixed form but resolve "Garbenheimer Wiesen" cleanly.
    // Original sitename is still used for airfield ranking, so the
    // dropped segment doesn't affect the name-match score.
    if (!geocode) {
        const stripped = sitename.replace(/\s*,\s*[^,]+$/, '').trim();
        if (stripped && stripped !== sitename) {
            log(`retrying geocode with trailing suffix stripped: "${stripped}"`);
            geocode = await geocodeNominatim(stripped, log);
            if (!geocode) geocode = await geocodeWikidata(stripped, log);
        }
    }

    if (!geocode) return {geocode: null, ranked: []};
    const ranked = await findAirfieldsByPoint(sitename, geocode.lat, geocode.lon, radiusKm, log);
    return {geocode, ranked};
}
