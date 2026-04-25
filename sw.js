// Service worker for Japanese Learning Tools
//
// IMPORTANT: bump CACHE on every deploy that ships changes to /js/*.js
// or any precached asset. The activate handler purges any cache whose
// name doesn't match the current CACHE constant, so a bump = guaranteed
// fresh fetch of every precached file on next visit.
//
// (We had a Pages Function at functions/sw.js intended to embed the
// commit SHA automatically, but CF edge serves a static sw.js when one
// exists at root, which is simpler and avoids the function-output
// caching weirdness we hit.)
//
// The site sits behind Cloudflare Access (Google SSO), so HTML responses
// can be short-lived auth redirects. We must NOT cache HTML or
// navigation responses — otherwise a cached login-redirect is served on
// later visits.
//
// Strategy:
//   - Precache only static non-HTML assets (icons, manifest, JSON data).
//   - Navigations + HTML: always network (passthrough).
//   - /data/*.json: network-first with cache fallback.
//   - Other same-origin GETs (icons, JS, CSS): cache-first after first hit.
//   - /api/*: passthrough.
const CACHE = 'japanese-v9-today';
const PRECACHE = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/js/srs.js',
  '/js/session.js',
  '/js/today.js',
  '/js/gemini.js',
  '/js/quiz-card.js',
  '/js/sw-register.js',
  '/js/tts-cache.js',
  '/data/grammar-n5n4.json',
  '/data/kanji-n5n4.json',
  '/data/vocab-n5n4.json',
  '/data/phrases-tourist.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => { /* precache is best-effort; don't block install */ })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Never intercept navigations / HTML — CF Access can issue auth
  // redirects, and a cached redirect kills the page.
  if (req.mode === 'navigate') return;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return;

  // Never intercept API or cross-origin.
  if (url.pathname.startsWith('/api/')) return;
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Never intercept the SW source itself — let the browser update path
  // see network reality.
  if (url.pathname === '/sw.js') return;

  // /data/*.json: network-first so content updates land on reload, with
  // cache fallback for offline.
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    e.respondWith(
      fetch(req).then(resp => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Other same-origin GETs (JS, CSS, icons): cache-first.
  e.respondWith(
    caches.match(req).then(hit =>
      hit || fetch(req).then(resp => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return resp;
      }).catch(() => hit)
    )
  );
});
