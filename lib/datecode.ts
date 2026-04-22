import type {Datecode} from './types';
import {getNow} from './now';

// Get a string date
export function fromDateCode(dcodeA: string | Datecode): string {
    const now = new Date();
    const dcode = dcodeA.toUpperCase();
    const year = parseInt(dcode.charAt(0)) + now.getFullYear() - (now.getFullYear() % 10);
    const month = parseInt(dcode.charAt(1), 36);
    const day = parseInt(dcode.charAt(2), 36);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Get a date code
export function toDateCode(date?: string | Date): Datecode {
    if (!date) {
        date = new Date();
    } else if (!(date instanceof Date)) {
        date = new Date(date);
    }
    const year = date.getUTCFullYear() % 10;
    const month = (date.getUTCMonth() + 1).toString(36);
    const day = date.getUTCDate().toString(36);
    return `${year}${month}${day}`.toUpperCase() as Datecode;
}

export function getCurrentDateCode(): Datecode {
    return toDateCode(new Date(getNow() * 1000));
}

// UTC epoch seconds of the most recent 10:00 local-time (in the given timezone)
// that has already elapsed by `referenceTs` (default: now). This is the start
// of the "competition day" — anything before this belongs to the previous day.
// tzoffsetSeconds is seconds east of UTC (e.g. +3600 for UTC+1, -18000 for EST).
export function competitionStartTs(tzoffsetSeconds: number, referenceTs?: number): number {
    const nowMs = referenceTs != null ? referenceTs * 1000 : Date.now();
    const localMs = nowMs + tzoffsetSeconds * 1000;
    const localNow = new Date(localMs);
    let local10amMs = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 10, 0, 0, 0);
    if (localMs < local10amMs) local10amMs -= 86400 * 1000;
    return Math.floor((local10amMs - tzoffsetSeconds * 1000) / 1000);
}
