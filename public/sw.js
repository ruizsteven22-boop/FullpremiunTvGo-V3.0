const CACHE_NAME = 'tvgo-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Las peticiones al proxy (/proxy y /transcode) no se guardan en cache para no congelar video en vivo
  if (event.request.url.includes('/proxy') || event.request.url.includes('/transcode')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});