'use strict';
const scope = self.registration.scope;
const base = new URL(scope);
const shell = new URL('./',scope).href;
const cachePrefix = 'bay-area-rail-' + base.pathname + '-';
const cacheName = cachePrefix + 'v3';
const assets = ['./manifest.webmanifest','./icons/rail-180.png','./icons/rail-192.png','./icons/rail-512.png','./bart-options.js?v=3','./bart-timetable.json']
  .map(path => new URL(path,scope).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll([shell,...assets])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    const url = new URL(request.url);
    if (url.origin !== base.origin || url.pathname !== base.pathname) return;
    event.respondWith(fetch(request).then(async response => {
      if (response.ok && !response.redirected) {
        const cache = await caches.open(cacheName);
        await cache.put(shell,response.clone()).catch(() => {});
      }
      return response;
    }).catch(async () => (await caches.match(shell)) || Response.error()));
  } else if (assets.includes(request.url)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
