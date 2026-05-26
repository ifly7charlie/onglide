//
// Hook backing the subscribe bell in the competition sidepanel header.
//
// The bell state is *backend-authoritative*: it reflects what /api/push/status
// reports for this browser's push endpoint, never a client-side cache. If the
// server loses the pushsubscription table the status query returns nothing and
// the bell correctly shows unsubscribed — the user is never falsely told they
// are subscribed. The status is cached with useSWR (the repo convention for
// REST /api fetches; Redux is reserved for the live websocket feed).
//
// The push endpoint contains a secret token, so it never travels in a request
// URL. status/unsubscribe are keyed by endpointHash (SHA-256 hex of the
// endpoint); only subscribe sends the full endpoint, and only in a POST body.
//

import {useCallback, useEffect, useState} from 'react';
import useSWR, {mutate as globalMutate} from 'swr';

import {pushSupported, registerServiceWorker, getServiceWorkerRegistration} from './registerServiceWorker';

interface PushStatus {
    compids: string[];
}

const fetcher = (url: string): Promise<PushStatus> => fetch(url).then((r) => (r.ok ? r.json() : {compids: []}));

const statusKey = (hash: string) => '/api/push/status?h=' + hash;

// SHA-256 hex of a string — the safe lookup key for a push endpoint. The server
// computes the identical hash of the stored endpoint, so the two always agree.
async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// VAPID applicationServerKey must be a Uint8Array of the URL-safe-base64 key.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
}

interface UsePushSubscription {
    supported: boolean;
    subscribed: boolean;
    loading: boolean; // status query in flight — state not yet known
    busy: boolean; // a subscribe/unsubscribe POST is in flight
    denied: boolean; // the user blocked notifications in the browser
    subscribe: () => Promise<void>;
    unsubscribe: () => Promise<void>;
}

// `lang` is the subscriber's UI language — stored with the subscription so the
// daemon renders notification text in it.
export function usePushSubscription(compid: string | undefined, lang: string): UsePushSubscription {
    const [supported, setSupported] = useState(false);
    const [endpointHash, setEndpointHash] = useState<string | null>(null);
    const [endpointResolved, setEndpointResolved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [denied, setDenied] = useState(false);

    // On mount: detect support and read any *existing* subscription without
    // registering a service worker. No SW -> no endpoint -> not subscribed (the
    // user has never subscribed on this browser).
    useEffect(() => {
        let cancelled = false;
        const ok = pushSupported();
        setSupported(ok);
        if (ok && Notification.permission === 'denied') setDenied(true);
        if (!ok) {
            setEndpointResolved(true);
            return;
        }
        (async () => {
            try {
                const reg = await getServiceWorkerRegistration();
                const sub = reg ? await reg.pushManager.getSubscription() : null;
                const hash = sub ? await sha256Hex(sub.endpoint) : null;
                if (!cancelled) setEndpointHash(hash);
            } catch (e) {
                console.log('usePushSubscription: reading existing subscription failed', e);
            } finally {
                // Always mark resolved — a failure here must never leave the
                // bell stuck loading (and so permanently disabled) forever.
                if (!cancelled) setEndpointResolved(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const {data, error} = useSWR(endpointHash ? statusKey(endpointHash) : null, fetcher);

    const subscribed = !!(compid && data?.compids?.includes(compid));
    // Loading only while we genuinely don't know the state yet: endpoint
    // resolution pending, or a status query in flight. A failed status query
    // (error) ends loading too — the bell stays usable, just optimistically
    // shown as unsubscribed — so it can never get stuck disabled.
    const loading = supported && (!endpointResolved || (!!endpointHash && !data && !error));

    const subscribe = useCallback(async () => {
        if (!compid || !pushSupported()) return;
        // requestPermission must run in the click gesture, before any await.
        let permission: NotificationPermission;
        try {
            permission = await Notification.requestPermission();
        } catch {
            return;
        }
        if (permission !== 'granted') {
            setDenied(permission === 'denied');
            return;
        }
        setDenied(false);
        setBusy(true);
        try {
            const reg = await registerServiceWorker();
            if (!reg) return;
            const sub =
                (await reg.pushManager.getSubscription()) ??
                (await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '') as BufferSource
                }));
            const res = await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({subscription: sub.toJSON(), compid, lang})
            });
            if (!res.ok) {
                console.log('push subscribe failed', res.status);
                return;
            }
            const hash = await sha256Hex(sub.endpoint);
            setEndpointHash(hash);
            // Optimistic — revalidate corrects the list if other comps exist.
            globalMutate(statusKey(hash), {compids: [compid]}, {revalidate: true});
        } catch (e) {
            console.log('push subscribe error', e);
        } finally {
            setBusy(false);
        }
    }, [compid, lang]);

    const unsubscribe = useCallback(async () => {
        if (!compid || !endpointHash) return;
        setBusy(true);
        try {
            const res = await fetch('/api/push/unsubscribe', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({hash: endpointHash, compid})
            });
            if (!res.ok) {
                console.log('push unsubscribe failed', res.status);
                return;
            }
            const remaining = (data?.compids ?? []).filter((c) => c !== compid);
            globalMutate(statusKey(endpointHash), {compids: remaining}, {revalidate: true});
            // Tear the browser subscription down only once no comp wants it —
            // one PushSubscription backs every comp on this browser.
            if (remaining.length === 0) {
                const reg = await getServiceWorkerRegistration();
                const sub = reg ? await reg.pushManager.getSubscription() : null;
                await sub?.unsubscribe().catch(() => {});
                setEndpointHash(null);
            }
        } catch (e) {
            console.log('push unsubscribe error', e);
        } finally {
            setBusy(false);
        }
    }, [compid, endpointHash, data]);

    return {supported, subscribed, loading, busy, denied, subscribe, unsubscribe};
}
