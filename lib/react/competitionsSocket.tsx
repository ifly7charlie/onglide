//
// Headless component that owns the /all WebSocket. Mounted once in
// pages/_app.tsx so the connection persists across client-side navigations
// (globe → per-comp → back). Decoded snapshots/deltas are dispatched into
// the Redux competitions slice; consumers read via useSelector.
//

import {useEffect} from 'react';
import {useDispatch} from '../redux';
import {competitionsConnected, competitionsSnapshot, competitionsDelta} from '../redux/competitionsSlice';
import {OnglideWebSocketMessage} from '../protobuf/onglide';
import {competitionsWebsocketUrl} from './fixupUrls';

export function CompetitionsSocket() {
    const dispatch = useDispatch();

    useEffect(() => {
        const url = competitionsWebsocketUrl();
        if (!url) return;

        let ws: WebSocket | null = null;
        let closed = false;
        let retry = 0;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

        const connect = () => {
            if (closed) return;
            try {
                ws = new WebSocket(url);
            } catch (_e) {
                scheduleReconnect();
                return;
            }
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                retry = 0;
                dispatch(competitionsConnected(true));
            };
            ws.onclose = () => {
                dispatch(competitionsConnected(false));
                if (!closed) scheduleReconnect();
            };
            ws.onerror = () => {
                // close handler will trigger reconnect
            };
            ws.onmessage = (ev) => {
                if (typeof ev.data === 'string') {
                    // Server-sent 'reload' sentinel — only happens for unknown
                    // channels; we don't expect it on /all but tolerate it.
                    return;
                }
                try {
                    const buf = new Uint8Array(ev.data as ArrayBuffer);
                    const decoded = OnglideWebSocketMessage.decode(buf);
                    if (decoded.competitions) {
                        const {competitions, removed, full} = decoded.competitions;
                        if (full) {
                            dispatch(competitionsSnapshot(competitions));
                        } else {
                            dispatch(competitionsDelta({summaries: competitions, removed}));
                        }
                    }
                } catch (e) {
                    console.log('CompetitionsSocket: decode failed', e);
                }
            };
        };

        const scheduleReconnect = () => {
            if (closed) return;
            const delay = Math.min(30_000, 1000 * Math.pow(2, retry));
            retry++;
            reconnectTimer = setTimeout(connect, delay);
        };

        connect();

        return () => {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            try {
                ws?.close();
            } catch {
                /**/
            }
        };
    }, [dispatch]);

    return null;
}
