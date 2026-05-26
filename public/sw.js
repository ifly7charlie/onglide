// Onglide service worker.
//
// Registered lazily — only when a user clicks the subscribe bell (see
// lib/react/registerServiceWorker.ts). Its single job is Web Push: it has no
// fetch handler and caches nothing, so it never intercepts page requests.
//
// Push payloads are JSON built by the OGN daemon (bin/lib/pushNotifications.ts):
//   {title, body, tag, url}
// `tag` is `${compid}:${class}` so a newer notification for a class replaces
// the older one rather than stacking.

self.addEventListener('install', () => {
    // Activate immediately rather than waiting for existing tabs to close.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = {};
    }
    const title = payload.title || 'Onglide';
    const options = {
        body: payload.body || '',
        tag: payload.tag || undefined,
        renotify: !!payload.tag,
        icon: '/logo192.png',
        badge: '/logo32.png',
        data: {url: payload.url || '/'}
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({type: 'window', includeUncontrolled: true}).then((clientList) => {
            // Focus an existing onglide tab if one is open, else open a new one.
            for (const client of clientList) {
                if ('focus' in client) {
                    client.navigate(target).catch(() => {});
                    return client.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(target);
            return undefined;
        })
    );
});
