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
    'airfield',
    'airport',
    'aerodrome',
    'airstrip',
    'flugplatz',
    'flughafen',
    'segelfluggelande',
    'fliegerhorst',
    'heeresflugplatz',
    'sonderlandeplatz',
    'sonderflugplatz',
    'gelande',
    'aerodrom',
    'aeropuerto',
    'aeroport',
    'aeroporto'
]);

export interface OsmAerodrome {
    name: string;
    icao?: string;
    iata?: string;
    lat: number;
    lon: number;
    distanceKm: number;
    aerowayType: string; // 'aerodrome' | 'airstrip'
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
}

interface NominatimResult {
    lat: string;
    lon: string;
    display_name: string;
    address?: {
        country_code?: string;
    };
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
        .toLowerCase();
    const out: string[] = [];
    for (const t of normalized.split(/[\s\-,.()'"\/]+/)) {
        if (t.length < 3) continue;
        if (STOPWORDS.has(t)) continue;
        out.push(t);
    }
    return out;
}

export async function geocodeNominatim(name: string, log: Logger = noopLogger): Promise<NominatimGeocode | null> {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1&addressdetails=1`;
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
    const r = json[0];
    return {
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        displayName: r.display_name,
        countryCode: r.address?.country_code ? r.address.country_code.toUpperCase() : undefined,
        source: 'nominatim'
    };
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
            aerowayType: tags.aeroway || ''
        });
    }
    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
}

export function rankAirfieldsBySite(sitename: string, aerodromes: OsmAerodrome[]): RankedAirfield[] {
    const siteTokens = new Set(tokenize(sitename));
    const ranked: RankedAirfield[] = aerodromes.map((a) => {
        const matched: string[] = [];
        for (const t of tokenize(a.name)) {
            if (siteTokens.has(t)) matched.push(t);
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
