// Service worker for Japanese Learning Tools
//
// The site sits behind Cloudflare Access (Google SSO), so HTML responses can
// be short-lived auth redirects. We must NOT cache HTML or navigation
// responses — otherwise a cached login-redirect is served on later visits
// and Safari shows "cannot open this page".
//
// Strategy:
//   - Precache only static non-HTML assets (icons, manifest, JSON data).
//   - Navigations + HTML: always network (passthrough).
//   - /data/*.json: NETWORK-FIRST with cache fallback — JSON content churns
//     (vocab/grammar/kanji expansions), so we want the latest on every load
//     when online, and still work offline via the cached copy.
//   - Other same-origin GETs (icons, JS, CSS): cache-first after first hit.
//   - /api/*: passthrough.
//
// Bump CACHE version to invalidate previously cached assets on deploy.
const CACHE = 'japanese-v6';
const PRECACHE = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/js/srs.js',
  '/js/gemini.js',
  '/js/quiz-card.js',
  '/data/grammar-n5n4.json',
  '/data/kanji-n5n4.json',
  '/data/vocab-n5n4.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(err => { /* precache is best-effort; don't block install */ })
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

  // Never intercept navigations or HTML — passthrough to network so
  // Cloudflare Access can do its auth dance normally.
  if (req.mode === 'navigate') return;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return;

  // Never intercept API calls.
  if (url.pathname.startsWith('/api/')) return;

  // Only handle same-origin GETs.
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Network-first for JSON data so vocab/grammar/kanji updates propagate
  // without needing a cache-version bump. Falls back to cache when offline.
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

  // Cache-first for static assets (icons, manifest, JS, CSS).
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
