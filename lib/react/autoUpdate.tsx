//
// Auto-update detection for the PWA shell.
//
// The browser-tab case works fine on its own — page navigations refetch HTML
// — but the iOS PWA can hold a WebKit instance for days without ever
// reloading, so a backend (daemon) deploy can silently break the websocket
// protocol. This compares the Next.js BUILD_ID the client loaded with against
// what /api/version currently reports.
//
// Triggers a check on:
//   - the tab becoming visible (PWA returning from background)
//   - the websocket reconnecting (triggerVersionCheck() called from the
//     onOpen handlers — strongest deploy signal we have)
//
// On a mismatch the user sees a small banner they can tap to reload, AND we
// schedule an automatic location.reload() the next time the tab is hidden —
// so the update lands without intervention on the very next app switch.
//

import {useEffect, useState} from 'react';
import {useTranslation} from 'next-i18next/pages';

// Module-level so the websocket onOpen handlers (in ognfeed.tsx and
// competitionsSocket.tsx) can poke the running hook without prop drilling
// or a Redux round-trip.
let externalTrigger: (() => void) | null = null;

export function triggerVersionCheck() {
    externalTrigger?.();
}

export function AutoUpdateBanner() {
    const {t} = useTranslation('common');
    const [updateAvailable, setUpdateAvailable] = useState(false);

    useEffect(() => {
        const loaded = window.__NEXT_DATA__?.buildId;
        if (!loaded) return;

        let inFlight = false;
        const check = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const res = await fetch('/api/version', {cache: 'no-store'});
                if (!res.ok) return;
                const data = await res.json();
                if (data?.buildId && data.buildId !== loaded) {
                    setUpdateAvailable(true);
                }
            } catch {
                /* network blip — try again on the next trigger */
            } finally {
                inFlight = false;
            }
        };

        externalTrigger = check;

        const onVisibility = () => {
            if (document.visibilityState === 'visible') check();
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (externalTrigger === check) externalTrigger = null;
        };
    }, []);

    useEffect(() => {
        if (!updateAvailable) return;
        const onHide = () => {
            if (document.visibilityState === 'hidden') location.reload();
        };
        document.addEventListener('visibilitychange', onHide);
        return () => document.removeEventListener('visibilitychange', onHide);
    }, [updateAvailable]);

    if (!updateAvailable) return null;
    return (
        <button type="button" className="autoupdate-banner" onClick={() => location.reload()}>
            {t('app.update_available')}
        </button>
    );
}
