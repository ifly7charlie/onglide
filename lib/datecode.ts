// Get a string date
export function fromDateCode(dcode: string): string {
    const now = new Date();
    const year = parseInt(dcode.charAt(0)) + now.getFullYear() - (now.getFullYear() % 10);
    const month = parseInt(dcode.charAt(1), 36);
    const day = parseInt(dcode.charAt(2), 36);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Get a date code
export function toDateCode(date: string | Date): string {
    if (!(date instanceof Date)) {
        date = new Date(date);
    }
    const year = date.getFullYear() % 10;
    const month = (date.getMonth() + 1).toString(36);
    const day = date.getDate().toString(36);
    return `${year}${month}${day}`;
}
