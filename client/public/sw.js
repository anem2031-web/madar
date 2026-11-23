const offlineCache = 'madar-offline-v1';
const offlinePage = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(offlineCache).then(cache => cache.add(offlinePage)));
});

// Wait for existing tabs to close so an update cannot interrupt password forms.
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('madar-offline-') && key !== offlineCache)
    .map(key => caches.delete(key)))));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // API, mutations, assets and unknown routes never enter the offline cache.
  if (request.method !== 'GET' || request.mode !== 'navigate'
      || url.origin !== self.location.origin || !['/', '/users', '/permissions'].includes(url.pathname)) return;
  event.respondWith(fetch(request).catch(async () => {
    const cache = await caches.open(offlineCache);
    return await cache.match(offlinePage) ?? Response.error();
  }));
});
