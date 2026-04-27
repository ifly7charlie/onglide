import {useEffect, useRef, useState} from 'react';

import {OnglideWebSocketMessage, CompetitionSummary} from '../protobuf/onglide';
import type {CompetitionDisplayStatus} from '../competition-display-status';
import {competitionsWebsocketUrl} from './fixupUrls';
import type {Competition} from './globe';

// Subscribe to the daemon's reserved /all channel and keep a live list of
// competitions in React state. Replaces the polled /api/competitions
// endpoint. The daemon sends a `full=true` snapshot on connect, then only
// `full=false` deltas — comps that changed plus a `removed` compid list.
export function useCompetitionsWebsocket() {
    const [competitions, setCompetitions] = useState<Competition[]>([]);
    const [connected, setConnected] = useState(false);

    // Authoritative cache keyed by compid; React state is derived from it.
    const cacheRef = useRef<Map<string, Competition>>(new Map());

    useEffect(() => {
        const url = competitionsWebsocketUrl();
        if (!url) return;

        let ws: WebSocket | null = null;
        let closed = false;
        let retry = 0;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

        const emit = () => {
            // Sort by start date, then compid for stability.
            const list = Array.from(cacheRef.current.values()).sort((a, b) => {
                if (a.start !== b.start) return (a.start || '').localeCompare(b.start || '');
                return a.compid.localeCompare(b.compid);
            });
            setCompetitions(list);
        };

        const merge = (summaries: CompetitionSummary[], removed: string[], full: boolean) => {
            if (full) cacheRef.current.clear();
            for (const s of summaries) {
                cacheRef.current.set(s.compid, summaryToCompetition(s));
            }
            for (const compid of removed) {
                cacheRef.current.delete(compid);
            }
            emit();
        };

        const connect = () => {
            if (closed) return;
            try {
                ws = new WebSocket(url);
            } catch (e) {
                scheduleReconnect();
                return;
            }
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                retry = 0;
                setConnected(true);
            };
            ws.onclose = () => {
                setConnected(false);
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
                        merge(decoded.competitions.competitions, decoded.competitions.removed, decoded.competitions.full);
                    }
                } catch (e) {
                    console.log('useCompetitionsWebsocket: decode failed', e);
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
    }, []);

    return {competitions, connected};
}

function summaryToCompetition(s: CompetitionSummary): Competition {
    return {
        compid: s.compid,
        name: s.name,
        sitename: s.sitename ?? null,
        lat: s.lat,
        lng: s.lng,
        start: s.start,
        end: s.end,
        countrycode: s.countrycode,
        tz: s.tz,
        tzoffset: s.tzoffset,
        mainwebsite: s.mainwebsite ?? null,
        classCount: s.classCount,
        classes: s.classes.map((c) => ({
            class: c.class,
            classname: c.classname,
            status: c.status,
            pilotCount: c.pilotCount,
            displayStatus: c.displayStatus as CompetitionDisplayStatus
        })),
        classStatusesDiffer: s.classStatusesDiffer,
        displayStatus: s.displayStatus as CompetitionDisplayStatus
    };
}
