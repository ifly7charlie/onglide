import {TZ, Epoch} from '../types';

export function RoundNumber(v) {
    if (typeof v === 'number') {
        v = Math.round(v * 10) / 10;
        if (isNaN(v)) {
            return null;
        }
    }

    if (v != '' && v != 0.0 && v != undefined && v != '00:00:00' && v != '0') {
        return v;
    } else {
        return null;
    }
}

export function Optional(props) {
    const v = RoundNumber(props.v);
    if (v) {
        return (
            <span style={props.style}>
                {props.b} {v} {props.e}
            </span>
        );
    }
    return null;
}
export function OptionalDiv(props) {
    const v = RoundNumber(props.v);
    if (v) {
        return (
            <div style={props.style}>
                {props.b} {v} {props.e}
            </div>
        );
    }
    return null;
}
export function OptionalText(b, iv, e = null) {
    const v = RoundNumber(iv);
    if (v) {
        return `${b ? b : ''}${v}${e ? e : ''}`;
    }
    return '';
}
// `hour12: false` forces 24-hour formatting regardless of the user's locale —
// the previous code achieved this by hardcoding the 'uk' (Ukrainian) locale,
// which was a side-effect of Ukrainian using 24-hour time. Switching to the
// proper hour12 option lets locale numerals (eg Arabic-Indic digits in 'ar')
// follow the user's actual language without changing the time format.
export function OptionalTime(before: string, t: Epoch | number, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString(undefined, {timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalTimeHHMM(before: string, t: Epoch | number, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString(undefined, {timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalDuration(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = (t < 0 ? '-' : '') + new Date(Math.abs(t) * 1000).toLocaleTimeString(undefined, {timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalDurationHHMM(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString(undefined, {timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
// Formats a positive duration in seconds. With after='m' returns the natural
// short form ("30m", "1h30m", "2h"); with any other suffix it falls back to
// HH:MM. The previous implementation used toLocaleTimeString's minute-only
// format, which silently dropped the hour for delays ≥ 1h (a 90-minute delay
// rendered as "30m").
export function OptionalDurationMM(before: string, t: Epoch, after: string | null = null) {
    if (!t) return '';
    const totalSec = Math.max(0, Math.trunc(t as number));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (after === 'm') {
        const v = h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
        return `${before || ''}${v}`;
    }
    const v = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    return `${before || ''}${v}${after || ''}`;
}
