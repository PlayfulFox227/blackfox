// Black Fox PWA Service Worker v1.1 — prefix: /blackfox/
const CACHE_NAME = 'blackfox-v1';
const BASE = '/blackfox';

const PRECACHE_URLS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([
        BASE + '/',
        BASE + '/index.html',
        BASE + '/manifest.json',
        BASE + '/icon-192.png',
        BASE + '/icon-512.png',
      ]).then(() =>
        cache.add('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js')
          .catch(() => console.log('SW: XLSX CDN not cached'))
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept Supabase
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.io')) return;

  // Navigation — network first, fallback to cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(BASE + '/index.html'))
    );
    return;
  }

  // Everything else — cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
        return res;
      }).catch(() => cached);
    })
  );
});

// Push notifications
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Black Fox', {
      body:    data.body  || 'У вас новое уведомление',
      icon:    BASE + '/icon-192.png',
      badge:   BASE + '/icon-72.png',
      tag:     data.tag   || 'blackfox',
      data:    { url: data.url || BASE + '/' },
      vibrate: [200, 100, 200],
      actions: [
        { action: 'open',    title: '📅 Открыть график' },
        { action: 'dismiss', title: 'Закрыть' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || BASE + '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
