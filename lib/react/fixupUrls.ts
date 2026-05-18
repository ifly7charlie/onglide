import type {ClassName, Datecode} from '../types';
import {groupForHost} from './domainGroups';

const httpsTest = new RegExp(/^(https|wss)/i, 'i');

export function oldTracksUrl(vc: ClassName, datecode: Datecode, baseTime: string, scoreId: string) {
    const hn = process.env.NEXT_PUBLIC_HISTORY_HOST || process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    //    console.log('oldTracksUrl', hn);
    return (
        (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_HISTORY_HOST ?? '') || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX ?? '') ? 'https://' : 'http://') +
        `${hn}/tracks/${(vc + datecode + '.' + baseTime).toUpperCase()}.bin`
    );
}

export function oldScoresUrl(vc: ClassName, datecode: Datecode, baseTime: string, scoreId: string) {
    const hn = process.env.NEXT_PUBLIC_HISTORY_HOST || window.location.host;
    //    console.log('oldScoresUrl', hn);
    return (
        (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_HISTORY_HOST ?? '') || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX ?? '') ? 'https://' : 'http://') +
        `${hn}/scorehistory/${(vc + datecode + '.' + baseTime).toUpperCase()}/${scoreId ?? 0}.bin`
    );
}

export function statusSummaryUrl() {
    const hn = process.env.NEXT_PUBLIC_HISTORY_HOST || window.location.host;
    return (
        (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_HISTORY_HOST ?? '') || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX ?? '') ? 'https://' : 'http://') +
        `${hn}/status/summary`
    );
}

// URL for the reserved /all channel — landing-page CompetitionsList feed.
// Mirrors proposedUrl()'s prefix/protocol logic but uses the literal `all`
// channel instead of `{className}{datecode}`. When the browser host is
// configured for a group (lib/react/domainGroups.ts) the channel becomes
// `/all/<group>`, restricting the feed to that group's competitions. The
// group keys off window.location.host — the front-end domain — not the
// (possibly shared) NEXT_PUBLIC_WEBSOCKET_HOST.
//
// A `?group=` query param overrides the domain map — handy for testing
// grouped feeds on localhost without a proxy. `?group=` (empty) forces the
// unfiltered bare /all feed regardless of the domain map.
export function competitionsWebsocketUrl() {
    if (typeof window === 'undefined') return null;
    const hn = process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    const override = new URLSearchParams(window.location.search).get('group');
    const group = (override !== null ? override : groupForHost(window.location.host)) || null;
    const channel = group ? `/all/${group}` : '/all';
    if (process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX) {
        return process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX + hn + channel;
    }
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_HOST ?? '') ? 'wss://' : 'ws://') + hn + channel;
}

export function proposedUrl(vc: ClassName, datecode: Datecode) {
    const hn = process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    if (process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX) {
        return process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX + hn + '/' + (vc + datecode).toUpperCase();
    }
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_HOST) ? 'wss://' : 'ws://') + hn + '/' + (vc + datecode).toUpperCase();
}
