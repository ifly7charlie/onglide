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
import {unscaleFromWire} from '../protobuf/wireScaling';
import {competitionsWebsocketUrl} from './fixupUrls';

// Server pushes a `ka` packet every 15s on /all. If we hear nothing for
// longer than this we assume the connection has gone silent (NAT timeout,
// network change without RST, etc.) and force a reconnect. 46s tolerates
// up to two consecutive missed packets before tearing down.
const KEEPALIVE_TIMEOUT_MS = 46_000;

export function CompetitionsSocket() {
    const dispatch = useDispatch();

    useEffect(() => {
        const url = competitionsWebsocketUrl();
        if (!url) return;

        let ws: WebSocket | null = null;
        let closed = false;
        let retry = 0;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

        const clearWatchdog = () => {
            if (watchdogTimer) {
                clearTimeout(watchdogTimer);
                watchdogTimer = null;
            }
        };

        // Bind the watchdog to a specific socket so a stale fire can't tear
        // down a successor that's already replaced it.
        const armWatchdog = (target: WebSocket) => {
            clearWatchdog();
            watchdogTimer = setTimeout(() => {
                if (target !== ws) return;
                console.log('CompetitionsSocket: keepalive watchdog fired, closing socket');
                try {
                    target.close();
                } catch {
                    /**/
                }
            }, KEEPALIVE_TIMEOUT_MS);
        };

        const connect = () => {
            if (closed) return;
            let socket: WebSocket;
            try {
                socket = new WebSocket(url);
            } catch (e) {
                console.log('CompetitionsSocket: WebSocket ctor threw', e);
                scheduleReconnect();
                return;
            }
            ws = socket;
            socket.binaryType = 'arraybuffer';

            socket.onopen = () => {
                console.log('CompetitionsSocket: open');
                retry = 0;
                dispatch(competitionsConnected(true));
                armWatchdog(socket);
            };
            socket.onclose = (ev) => {
                console.log('CompetitionsSocket: close', {code: ev.code, reason: ev.reason, wasClean: ev.wasClean});
                if (socket === ws) clearWatchdog();
                dispatch(competitionsConnected(false));
                if (!closed && socket === ws) scheduleReconnect();
            };
            socket.onerror = () => {
                console.log('CompetitionsSocket: error');
            };
            socket.onmessage = (ev) => {
                // Any frame counts as liveness — including the bare `ka`
                // keepalive that carries no `competitions` payload.
                armWatchdog(socket);
                if (typeof ev.data === 'string') {
                    // Server-sent 'reload' sentinel — only happens for unknown
                    // channels; we don't expect it on /all but tolerate it.
                    return;
                }
                try {
                    const buf = new Uint8Array(ev.data as ArrayBuffer);
                    const decoded = unscaleFromWire(OnglideWebSocketMessage.decode(buf));
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
            console.log(`CompetitionsSocket: reconnect in ${delay}ms (retry ${retry})`);
            reconnectTimer = setTimeout(connect, delay);
        };

        connect();

        return () => {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            clearWatchdog();
            try {
                ws?.close();
            } catch {
                /**/
            }
        };
    }, [dispatch]);

    return null;
}
