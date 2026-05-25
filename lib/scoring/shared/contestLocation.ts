// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Contest location helpers — geocode a free-text sitename to a usable
// (lt, lg, countrycode, tz) tuple, and a startup sweep that fills in any
// existing competition rows whose lt/lg are still NULL/0.
//
// Geocode is the source of truth for `competition.lt`/`lg`. The taskleg
// fallback in `lib/scoring/shared/tasks.ts` only kicks in for rows where
// geocoding never succeeded.
//

import escape from 'sql-template-strings';

import {findAerodromesByCountry, findAirfieldsByPoint, geocodeNominatimAerodrome, geocodeNominatimSeeds, type RankedAirfield} from './airfield';
import {findTimezoneFromLocation, getTzOffset} from './timezone';

// Approximate site location seeded into competition.lt/lg from the
// free-text sitename. Airfield-only: every non-zero result has been
// matched against an OSM `aeroway=aerodrome|airstrip` feature. If no
// airfield can be confirmed, returns 0/0 and callers leave the row
// alone — town/street guesses are worse than no value.
export interface ApproximateContestLocation {
    lt: number;
    lg: number;
    countrycode: string;
    timezone: {
        name: string;
        offset: number;
    };
}

// Three-stage airfield resolver. Each stage hits the network at most
// once or twice; later stages run only when earlier ones fail to
// produce a name-matched aerodrome:
//
//  1. Country-scoped Overpass — ISO country area (derived from the
//     Nominatim seed's countryCode, or from a `, <Country>` suffix) +
//     name regex. Catches the common "Hütten, Germany" case where the
//     sitename is shared by many settlements but unique among
//     aerodromes in-country. Tiebreaks by distance from the seed so
//     when several aerodromes share the name (Hütten-Hotzenwald vs
//     Hüttenbusch in DE) the regionally-nearest one wins.
//
//  2. Nominatim aerodrome retry — `<sitename> aerodrome`. Works when
//     the airfield exists in OSM but is missing the country=ISO area
//     membership Overpass relies on, or when the country probe failed.
//
//  3. Multi-seed Overpass — fall back to the legacy "geocode the
//     sitename, sweep 30 km around each top hit for aerodromes whose
//     name overlaps" approach, but iterating the top three Nominatim
//     seeds instead of just the first.
export async function findApproximateContestLocation(
    log: (msg: string, ...args: unknown[]) => void, //
    location: string
): Promise<ApproximateContestLocation> {
    const fallback: ApproximateContestLocation = {lt: 0, lg: 0, countrycode: '', timezone: {name: 'Europe/London', offset: 0}};

    log(`geocoding "${location}" (airfield-only)`);
    const seeds = await geocodeNominatimSeeds(location, 5, log).catch((e) => {
        log('nominatim seeds threw:', e);
        return [];
    });
    const primarySeed = seeds[0];
    const countryCode = primarySeed?.countryCode || extractCountrySuffix(location);

    // Stage 1: country-scoped Overpass name search.
    if (countryCode) {
        log(`  stage 1: overpass aerodromes in ${countryCode} matching "${location}"`);
        const ranked = await findAerodromesByCountry(countryCode, location, primarySeed?.lat, primarySeed?.lon, log).catch((e) => {
            log('overpass country search threw:', e);
            return [] as RankedAirfield[];
        });
        const winner = ranked.find((r) => r.nameOverlap >= 1);
        if (winner) {
            log(`  matched OSM "${winner.name}" (cc=${countryCode}, ${winner.distanceKm.toFixed(1)} km from seed, tokens: ${winner.matchedTokens.join(',')})`);
            return makeResult(winner.lat, winner.lon, countryCode);
        }
    } else {
        log(`  stage 1 skipped: no country code from Nominatim or sitename suffix`);
    }

    // Stage 2: Nominatim aerodrome-biased retry.
    log(`  stage 2: nominatim "<name> aerodrome" retry`);
    const aero = await geocodeNominatimAerodrome(location, log).catch((e) => {
        log('nominatim aerodrome retry threw:', e);
        return null;
    });
    if (aero) {
        log(`  matched aeroway via retry: ${aero.displayName}`);
        return makeResult(aero.lat, aero.lon, aero.countryCode || countryCode || '');
    }

    // Stage 3: top-N Nominatim seeds + 30 km Overpass sweeps.
    log(`  stage 3: trying ${Math.min(seeds.length, 3)} nominatim seed(s) with radius overpass`);
    let best: RankedAirfield | null = null;
    for (const seed of seeds.slice(0, 3)) {
        const ranked = await findAirfieldsByPoint(location, seed.lat, seed.lon, undefined, log).catch(() => [] as RankedAirfield[]);
        const top = ranked[0];
        if (!top || top.nameOverlap < 1) continue;
        if (!best || top.nameOverlap > best.nameOverlap || (top.nameOverlap === best.nameOverlap && top.distanceKm < best.distanceKm)) {
            best = top;
        }
    }
    if (best) {
        log(`  matched OSM "${best.name}" via seed sweep (${best.distanceKm.toFixed(1)} km, tokens: ${best.matchedTokens.join(',')})`);
        return makeResult(best.lat, best.lon, primarySeed?.countryCode || countryCode || '');
    }

    log(`  no airfield match for "${location}" — leaving competition.lt/lg unset`);
    return fallback;

    function makeResult(lat: number, lon: number, cc: string): ApproximateContestLocation {
        const tz = findTimezoneFromLocation(lat, lon);
        return {
            lt: Math.round(lat * 100) / 100,
            lg: Math.round(lon * 100) / 100,
            countrycode: cc,
            timezone: {name: tz, offset: getTzOffset(tz)}
        };
    }
}

// Tiny country-name → ISO-3166-1 alpha-2 lookup for the trailing
// `, <Country>` suffix on sitenames. Only used when Nominatim returned
// nothing (so we can't crib its countryCode), and only covers a handful
// of common forms — Nominatim's countryCode is authoritative when
// available. Keys are NFD-stripped lowercase; values are uppercase
// ISO codes.
const COUNTRY_SUFFIX_TO_ISO: Record<string, string> = {
    germany: 'DE',
    deutschland: 'DE',
    france: 'FR',
    italy: 'IT',
    italia: 'IT',
    spain: 'ES',
    espana: 'ES',
    poland: 'PL',
    polska: 'PL',
    netherlands: 'NL',
    nederland: 'NL',
    belgium: 'BE',
    belgie: 'BE',
    austria: 'AT',
    osterreich: 'AT',
    switzerland: 'CH',
    schweiz: 'CH',
    suisse: 'CH',
    'czech republic': 'CZ',
    czechia: 'CZ',
    slovakia: 'SK',
    slovenia: 'SI',
    hungary: 'HU',
    finland: 'FI',
    suomi: 'FI',
    sweden: 'SE',
    sverige: 'SE',
    norway: 'NO',
    norge: 'NO',
    denmark: 'DK',
    danmark: 'DK',
    portugal: 'PT',
    'united kingdom': 'GB',
    uk: 'GB',
    'great britain': 'GB',
    england: 'GB',
    scotland: 'GB',
    wales: 'GB',
    ireland: 'IE',
    eire: 'IE',
    lithuania: 'LT',
    latvia: 'LV',
    estonia: 'EE',
    romania: 'RO',
    bulgaria: 'BG',
    croatia: 'HR',
    hrvatska: 'HR',
    serbia: 'RS',
    'south africa': 'ZA',
    australia: 'AU',
    'new zealand': 'NZ',
    canada: 'CA',
    'united states': 'US',
    usa: 'US',
    russia: 'RU',
    ukraine: 'UA'
};

function extractCountrySuffix(sitename: string): string | undefined {
    const m = sitename.match(/,\s*([^,]+)\s*$/);
    if (!m) return undefined;
    const key = m[1]
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
    return COUNTRY_SUFFIX_TO_ISO[key];
}

// Startup sweep — find every competition row that's missing a useful
// lt/lg (NULL or 0) but has a sitename to geocode against, and run the
// same geocode flow updateContest uses. Sequential to be polite to the
// public Nominatim/Wikidata/Overpass endpoints. One bad row never aborts
// the rest.
export async function regeocodeMissingCompetitions(
    db: any, //
    log: (msg: string, ...args: unknown[]) => void
): Promise<void> {
    let rows: Array<{compid: string; sitename: string}>;
    try {
        rows = await db.query(escape`
            SELECT compid, sitename
            FROM competition
            WHERE sitename IS NOT NULL AND sitename != ''
              AND (lt IS NULL OR lt = 0 OR lg IS NULL OR lg = 0)
        `);
    } catch (e) {
        log('regeocodeMissingCompetitions: competition read failed:', e);
        return;
    }
    if (!rows?.length) return;

    log(`regeocodeMissingCompetitions: ${rows.length} competition(s) need geocoding`);
    for (const row of rows) {
        const perCompLog = (msg: string, ...args: unknown[]) => log(`[${row.compid}] ${msg}`, ...args);
        try {
            const acl = await findApproximateContestLocation(perCompLog, row.sitename);
            if (!acl.lt || !acl.lg) {
                perCompLog(`re-geocode failed for sitename="${row.sitename}"`);
                continue;
            }
            await db.query(escape`
                UPDATE competition
                SET
                    tz = ${acl.timezone.name},
                    tzoffset = ${acl.timezone.offset},
                    countrycode = ${acl.countrycode || null},
                    lt = ${acl.lt},
                    lg = ${acl.lg}
                WHERE compid = ${row.compid}
            `);
            perCompLog(`re-geocoded "${row.sitename}" -> (${acl.lt}, ${acl.lg}) tz=${acl.timezone.name}`);
        } catch (e) {
            perCompLog('re-geocode error:', e);
        }
    }
}
