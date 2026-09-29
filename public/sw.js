// Service Worker: eigene Seite, wenn der Server nicht erreichbar ist, und Push-Mitteilungen.
// Funktioniert nur über HTTPS (oder localhost) – so verlangen es die Browser.
const CACHE = 'quota-offline-v3';
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

// Push-Mitteilung vom eigenen Server anzeigen (Inhalt ist verschlüsselt, der Browser entschlüsselt ihn)
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Quota', {
    body: d.body || '', icon: '/icons/icon-192.png', tag: d.tag || undefined, lang: 'de', data: { url: d.url || '/' },
  }));
});

// Antippen: offene App nach vorne holen (und dorthin führen), sonst neu öffnen
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      w.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
