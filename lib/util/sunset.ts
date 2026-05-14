import SunCalc from 'suncalc';
import {fromDateCode} from '../datecode';
import type {Datecode, Epoch} from '../types';

// End-of-day for contest purposes is end of civil twilight (sun 6° below horizon).
// SunCalc's `dusk` is the civil-twilight boundary. Clamped to 22:00 local — at high
// latitudes near midsummer civil dusk runs past midnight (or never happens at all, NaN),
// but no contest day is going to run that late.
export function computeSunset(datecode: Datecode, lat: number, lng: number, tzoffset: number): {sunset: Epoch; localMidday: Epoch} {
    const localMiddayMs = new Date(fromDateCode(datecode)).getTime() - (tzoffset - 12 * 3600) * 1000;
    const civilDusk = Math.round(SunCalc.getTimes(new Date(localMiddayMs), lat, lng).dusk.getTime() / 1000);
    const cap = Math.round((localMiddayMs + 10 * 3600 * 1000) / 1000) as Epoch;
    const sunset = (isNaN(civilDusk) ? cap : Math.min(civilDusk, cap)) as Epoch;
    return {sunset, localMidday: (localMiddayMs / 1000) as Epoch};
}
