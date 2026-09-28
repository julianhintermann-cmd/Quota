// Service Worker: zeigt eine eigene Seite, wenn der Server nicht erreichbar ist.
// Funktioniert nur über HTTPS (oder localhost) – so verlangen es die Browser.
const CACHE = 'quota-offline-v2';
const OFFLINE = '/offline';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll([OFFLINE, '/manifest.webmanifest', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Nur Seitenaufrufe abfangen: zuerst immer der Server, bei fehlender Verbindung die Offline-Seite.
// Daten (API) und alles andere laufen unverändert direkt zum Server.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) || new Response(
    'Der Server scheint nicht erreichbar zu sein.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  )));
});
