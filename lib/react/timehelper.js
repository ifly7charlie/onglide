export function delayToText(t) {
    if (!t || t > 7200) return '';
    let secs = Math.floor(t) % 60;
    let mins = Math.floor((t / 60) % 60);
    let hours = Math.floor(t / 3600);

    if (secs) {
        secs = `${secs < 10 && (mins > 0 || hours > 0) ? '0' : ''}${secs}s`;
    } else {
        secs = undefined;
    }
    if (mins) {
        mins = `${mins < 10 && hours > 0 ? '0' : ''}${mins}m`;
        if (mins > 30) {
            secs = undefined;
        }
    } else {
        mins = undefined;
    }
    if (hours) {
        hours = `${hours}h`;
        secs = undefined;
    } else {
        hours = undefined;
    }
    return [hours, mins, secs].join(' ').trim();
}

export function formatTime(t, tz) {
    // hour12: false forces 24-hour formatting; locale comes from the user.
    const dt = new Date(t * 1000);
    return [dt.toLocaleTimeString(undefined, {timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false}), (t % 60 < 10 ? '0' : '') + dt.toLocaleTimeString(undefined, {timeZone: tz, second: '2-digit'})];
}
