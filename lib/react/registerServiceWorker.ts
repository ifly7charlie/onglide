//
// Service-worker helpers for Web Push. The SW is registered lazily — only when
// a user clicks the subscribe bell — so a visitor who never subscribes never
// gets one. Once registered it persists across sessions, so returning
// subscribers keep working push without re-registering.
//

// True when the browser can actually do Web Push notifications.
export function pushSupported(): boolean {
    return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Register /sw.js (root scope) and resolve to the ready registration. Called
// from the subscribe click handler. Best-effort: never throws.
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!pushSupported()) return null;
    try {
        await navigator.serviceWorker.register('/sw.js');
        return await navigator.serviceWorker.ready;
    } catch (e) {
        console.log('registerServiceWorker failed', e);
        return null;
    }
}

// Find an already-registered SW without creating one — used to read existing
// subscription state on mount. Returns null when nothing is registered (i.e.
// the user has never subscribed on this browser).
export async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (!pushSupported()) return null;
    try {
        return (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch (e) {
        console.log('getServiceWorkerRegistration failed', e);
        return null;
    }
}
