// Service worker: cache do app (abre offline) + notificações push.
const CACHE = 'radar-cripto-v6';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/analysis.js', 'js/chart.js', 'js/coins.js', 'js/config.js', 'js/study.js', 'js/positions.js', 'js/alerts.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Arquivos do app: rede primeiro (sempre atualizado), cache se offline. APIs externas: só rede.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Radar Cripto', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Radar Cripto', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: d.tag || 'radar', data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  const coin = new URL(url).searchParams.get('coin');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ coin }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
