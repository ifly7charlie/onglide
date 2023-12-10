import type {Datecode} from './types';

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
