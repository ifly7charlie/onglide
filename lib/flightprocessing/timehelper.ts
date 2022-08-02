let tz = 'UTC';

import {Epoch} from '../types';

export function setSiteTz(newtz: string): void {
    tz = newtz;
}

export function getSiteTz(): string {
    return tz;
}

export function timeToText(t: Epoch): string {
    const dt = new Date(t * 1000);
    return dt.toLocaleTimeString('en-GB', {timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'});
}

export function durationToText(elapsed: Epoch): string {
    var hours = Math.trunc(elapsed / 3600);
    var mins: string | number = Math.trunc((elapsed / 60) % 60);
    var secs: string | number = elapsed % 60;
    if (mins < 10) {
        mins = '0' + mins;
    }
    if (secs < 10) {
        secs = '0' + secs;
    }
    return hours + ':' + mins + ':' + secs;
}
