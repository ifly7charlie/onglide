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
export function OptionalTime(before: string, t: Epoch | number, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalTimeHHMM(before: string, t: Epoch | number, tz: TZ, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: tz, hour: '2-digit', minute: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalDuration(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalDurationHHMM(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: 'UTC', hour: '2-digit', minute: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
export function OptionalDurationMM(before: string, t: Epoch, after: string | null = null) {
    if (!t) {
        return '';
    }
    const v = new Date(t * 1000).toLocaleTimeString('uk', {timeZone: 'UTC', minute: '2-digit'});
    if (v) {
        return `${before || ''}${v}${after || ''}`;
    }
    return '';
}
