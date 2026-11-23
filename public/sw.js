// Service Worker v4.9 — Auto-limpieza de caché y recarga automática en Smart TV WebView
const SW_VERSION = 'v4.9';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister().catch(() => {}))
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        clients.forEach((client) => {
          try {
            if (client.url && typeof client.navigate === 'function') {
              const baseUrl = client.url.split('?')[0];
              client.navigate(baseUrl + '?_v=' + Date.now()).catch(() => {});
            }
          } catch (_) {}
        });
      })
  );
});
