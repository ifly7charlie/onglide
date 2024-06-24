import type {ClassName, Datecode} from '../types';

const httpsTest = new RegExp(/^(https|wss)/i, 'i');

export function oldTracksUrl(vc: ClassName, datecode: Datecode, baseTime: string) {
    const hn = process.env.NEXT_PUBLIC_HISTORY_HOST || process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    console.log('oldTracksUrl', hn);
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_HISTORY_HOST ?? '') || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX ?? '') ? 'https://' : 'http://') + hn + '/tracks/' + (vc + datecode + '.' + baseTime).toUpperCase() + '.bin';
}

export function proposedUrl(vc: ClassName, datecode: Datecode) {
    const hn = process.env.NEXT_PUBLIC_WEBSOCKET_HOST || window.location.host;
    if (process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX) {
        return process.env.NEXT_PUBLIC_WEBSOCKET_PREFIX + hn + '/' + (vc + datecode).toUpperCase();
    }
    return (httpsTest.test(window.location.protocol) || httpsTest.test(process.env.NEXT_PUBLIC_WEBSOCKET_HOST) ? 'wss://' : 'ws://') + hn + '/' + (vc + datecode).toUpperCase();
}
