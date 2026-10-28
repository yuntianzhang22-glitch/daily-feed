// __BUILD_ID__ changes with the complete asset content, not just package.json.
const CACHE = 'daily-feed-mobile-__BUILD_ID__';
const ASSETS = ['/mobile/', '/mobile/index.html', '/mobile/app.js', '/mobile/style.css',
  '/mobile/manifest.webmanifest', '/mobile/icons/icon-192.png', '/mobile/icons/icon-512.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener('message', (event) => {
  if (event.data === 'activate') self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('daily-feed-mobile-') && key !== CACHE).map((key) => caches.delete(key)))));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Explicit allowlist: never cache /v1/*, Authorization, POSTs, or remote media.
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      request.headers.has('Authorization') || url.search || !ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) || fetch(request)));
});
