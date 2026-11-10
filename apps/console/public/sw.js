/* global self, caches */
/* Yanımda konsol service worker (PWA): yalnız uygulama kabuğu (HTML/JS/CSS/simge) önbelleğe alınır.
 * API (/v1), kimlik (/realms), WebSocket ve ses kayıtları ASLA önbelleğe alınmaz — operatör her zaman canlı veri görür.
 * Ağ öncelikli: çevrimiçiyken her zaman ağdan; ağ yoksa son kabuk açılır (bağlantı yok uyarısıyla). */
const CACHE = 'yanimda-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];
const NEVER = [/^\/v1\//, /\/realms\//, /\/recording/];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || NEVER.some((r) => r.test(url.pathname)))
    return;
  const shell = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (shell || /\.(js|css|svg|webmanifest)$/.test(url.pathname))) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(shell ? '/' : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(shell ? '/' : e.request).then((r) => r || Response.error())),
  );
});

/* Amir uyarıları (web push): yük yalnız kod + olay kimliği; metin katalogdan istemcide çözülür. */
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = {};
  }
  const title = d.title || 'Yanımda';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag || 'yanimda',
      icon: '/icon.svg',
      badge: '/icon.svg',
      requireInteraction: !!d.urgent,
      data: { url: d.url || '/supervisor' },
    }),
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
      const w = ws.find((x) => 'focus' in x);
      if (w) return w.navigate(url).then((x) => x && x.focus());
      return self.clients.openWindow(url);
    }),
  );
});
