// Presale Radar service worker: offline shell, push notifications, notification buttons.
const CACHE = 'presale-radar-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/icons.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App shell: network first (so updates land), cache as fallback. API and calendar: network only.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cal/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Presale Radar', body: event.data?.text() ?? '' };
  }
  const actions = (data.actions || []).slice(0, 2);
  const options = {
    body: data.body || '',
    tag: data.tag,
    renotify: !!data.urgent,
    requireInteraction: !!data.urgent,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/#/', actions },
    actions: actions.map((a) => ({ action: a.action, title: a.title })),
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Presale Radar', options).then(() =>
      self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'refresh' }))),
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  if (event.action) {
    const act = (data.actions || []).find((a) => a.action === event.action);
    if (act) {
      event.waitUntil(
        fetch(act.url, { method: 'POST' }).then(() =>
          self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'refresh' }))),
        ),
      );
      return;
    }
  }
  const target = data.url || '/#/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          c.postMessage({ type: 'navigate', url: target });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
