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

// A page still running an older build loads its route files from that build's cache until its
// next reload, since the server only has the newest build's files. Three covers a guarded page
// surviving several takeovers without tracking which build each window runs; a build is ~52 small files.
const KEPT_BUILDS = 3;

// Cache names list in creation order, so the last KEPT_BUILDS other names are the newest previous builds.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const old = keys.filter((k) => k !== CACHE);
        return Promise.all(old.slice(0, -KEPT_BUILDS).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

// The app shell is cache-first so launches never wait on the network. The API is never cached here.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (url.origin !== self.location.origin || isApi) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.mode === 'navigate' ? '/' : req);
      if (hit) return hit;
      // A hashed file this build lacks belongs to a kept older build, for a page not yet reloaded.
      const kept = url.pathname.startsWith('/_app/immutable/')
        ? await caches.match(req)
        : undefined;
      return kept ?? fetch(req);
    })(),
  );
});
