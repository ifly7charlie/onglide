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

import {findAirfieldsByName} from './airfield';
import {findTimezoneFromLocation, getTzOffset} from './timezone';

// Approximate site location used to seed competition.lt/lg before any
// tasks have been scraped. Filled by Nominatim/Wikidata + Overpass:
// geocode the free-text sitename, then look for nearby OSM aerodromes;
// if one's name overlaps with the sitename we snap lt/lg to its centroid
// (more accurate than the geocoded town point), otherwise keep the
// geocoded point.
export interface ApproximateContestLocation {
    lt: number;
    lg: number;
    countrycode: string;
    timezone: {
        name: string;
        offset: number;
    };
}

export async function findApproximateContestLocation(
    log: (msg: string, ...args: unknown[]) => void, //
    location: string
): Promise<ApproximateContestLocation> {
    const fallback: ApproximateContestLocation = {lt: 0, lg: 0, countrycode: '', timezone: {name: 'Europe/London', offset: 0}};

    log(`geocoding "${location}" via Nominatim, then Wikidata, then Overpass...`);
    const result = await findAirfieldsByName(location, undefined, log).catch((e) => {
        log('findAirfieldsByName threw:', e);
        return null;
    });
    if (!result?.geocode) {
        log(`no geocode result for "${location}" — Nominatim and Wikidata both returned no match (or both endpoints failed); leaving competition.lt/lg unset`);
        return fallback;
    }

    log(`  geocoded "${location}" -> ${result.geocode.lat.toFixed(4)}, ${result.geocode.lon.toFixed(4)} via ${result.geocode.source}${result.geocode.countryCode ? ` (cc=${result.geocode.countryCode})` : ''} (${result.geocode.displayName})`);

    let lt = result.geocode.lat;
    let lg = result.geocode.lon;
    const top = result.ranked[0];
    if (top && top.nameOverlap >= 1) {
        log(`  refined site to OSM "${top.name}" (${top.distanceKm.toFixed(1)} km, match: ${top.matchedTokens.join(',')})`);
        lt = top.lat;
        lg = top.lon;
    } else if (top) {
        log(`  no name-matching airfield within range; using geocoded point (closest OSM: ${top.name} at ${top.distanceKm.toFixed(1)} km)`);
    } else {
        log(`  no OSM aerodromes within range of (${lt.toFixed(4)}, ${lg.toFixed(4)}); using geocoded point as-is`);
    }

    const tz = findTimezoneFromLocation(lt, lg);
    return {
        lt: Math.round(lt * 100) / 100,
        lg: Math.round(lg * 100) / 100,
        countrycode: result.geocode.countryCode || '',
        timezone: {name: tz, offset: getTzOffset(tz)}
    };
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
    const rows: Array<{compid: string; sitename: string}> = await db.query(escape`
        SELECT compid, sitename
        FROM competition
        WHERE sitename IS NOT NULL AND sitename != ''
          AND (lt IS NULL OR lt = 0 OR lg IS NULL OR lg = 0)
    `);
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
