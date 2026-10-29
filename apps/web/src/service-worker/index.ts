import { version } from '$app/environment';
import { assets, immutable } from '$app/manifest';
import { self } from '$app/service-worker';

const CACHE = `shell-${version}`;
// '/' is the SPA shell (the static adapter's fallback index.html).
const SHELL = ['/', ...immutable.map((f) => f.path), ...assets.map((f) => f.path)];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app shell is cache-first so launches never wait on the network. The API is never cached here.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.mode === 'navigate' ? '/' : req);
      return hit ?? fetch(req);
    })(),
  );
});
