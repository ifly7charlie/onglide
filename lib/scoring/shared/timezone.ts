// Copyright 2026- (c) Melissa Jenkins
// Part of Onglide.com competition tracking service
// BSD licence

//
// Timezone helpers used by the scoring scheduler. All cadence decisions
// in `lib/scoring/scheduler.ts` are made in the *competition's* local
// timezone (read from `competition.tz`), not the host's local time.
// `nowInTz()`, `localDatecode()` and `localTimeOfDayMinutes()` are pure
// functions over `Date.now()` + an IANA tz name; `applyJitter()` is the
// rule-7 spreader that prevents adjacent competitions from synchronising
// onto the same wall-clock minute.
//
// findTimezoneFromLocation / getTzOffset are lifted unchanged from the
// previous monolithic ssscrape.ts so adapters can reuse them when
// refining tz from taskleg coordinates.
//

import {find as findTz} from 'geo-tz';

// Wrapper around geo-tz: returns the IANA timezone name for a lat/lng.
// geo-tz returns an array (in case the point is on a boundary); take the
// first match.
export function findTimezoneFromLocation(lat: number, lng: number): string {
    const result = findTz(lat, lng);
    return Array.isArray(result) ? result[0] : result;
}

// Convert an IANA timezone name into the UTC offset in seconds. Uses
// Intl.DateTimeFormat to format "GMT+01:00" / "GMT-05:00" style strings,
// then parses the trailing offset.
export function getTzOffset(tzname: string): number {
    const parts = Intl.DateTimeFormat('ia', {
        timeZoneName: 'short',
        timeZone: tzname
    }).formatToParts();
    const tzPart = parts.find((i) => i.type === 'timeZoneName');
    if (!tzPart) return 0;
    const offset = tzPart.value.slice(3); // strip "GMT"
    if (!offset) return 0;

    const matchData = offset.match(/([+-])(\d+)(?::(\d+))?/);
    if (!matchData) {
        return 0;
    }
    const [, sign, hour, minute] = matchData;
    let result = parseInt(hour) * 60 * 60;
    if (minute) result += parseInt(minute) * 60;
    if (sign === '-') result *= -1;
    return result;
}

//
// Decomposed local time in a given IANA timezone, computed for an absolute
// epoch (defaults to "now"). Uses Intl.DateTimeFormat parts which always
// resolve in the requested zone — works correctly across DST and across
// host machines that are not themselves in the competition's tz.
//
export interface LocalTime {
    year: number;
    month: number; // 1-12
    day: number; // 1-31
    hour: number; // 0-23
    minute: number; // 0-59
    second: number; // 0-59
    iso: string; // 'YYYY-MM-DD'
    minuteOfDay: number; // hour*60 + minute
    epoch: number; // input ms since epoch (echoed for convenience)
}

const localTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function localTimeFormatter(tz: string): Intl.DateTimeFormat {
    let f = localTimeFormatterCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        localTimeFormatterCache.set(tz, f);
    }
    return f;
}

export function nowInTz(tz: string, atEpochMs: number = Date.now()): LocalTime {
    const parts = localTimeFormatter(tz).formatToParts(new Date(atEpochMs));
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;

    const year = parseInt(map.year, 10);
    const month = parseInt(map.month, 10);
    const day = parseInt(map.day, 10);
    // Intl gives "24" instead of "00" for midnight under hour12:false in
    // some Node versions — normalise it.
    const hour = parseInt(map.hour, 10) % 24;
    const minute = parseInt(map.minute, 10);
    const second = parseInt(map.second, 10);

    return {
        year,
        month,
        day,
        hour,
        minute,
        second,
        iso: `${map.year}-${map.month}-${map.day}`,
        minuteOfDay: hour * 60 + minute,
        epoch: atEpochMs
    };
}

// Convenience: 'YYYY-MM-DD' for "today" in the competition's tz.
export function localDateISO(tz: string, atEpochMs: number = Date.now()): string {
    return nowInTz(tz, atEpochMs).iso;
}

// Convenience: minute-of-day in the competition's tz (0..1439).
export function localMinuteOfDay(tz: string, atEpochMs: number = Date.now()): number {
    return nowInTz(tz, atEpochMs).minuteOfDay;
}

//
// applyJitter — multiply an interval by a uniform random in [0.8, 1.2]
// so successive checks drift around the nominal cadence and adjacent
// competitions never lock-step onto the same wall-clock minute. (Rule 7.)
// `Math.random()` is fine here — this is scheduling jitter, not crypto.
//
export function applyJitter(intervalMs: number): number {
    if (intervalMs <= 0) return intervalMs;
    return Math.round(intervalMs * (0.8 + Math.random() * 0.4));
}
