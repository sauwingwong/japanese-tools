// Service worker for Japanese Learning Tools
// Cache-first for static assets; network passthrough for /api/ (TTS/STT).
// Bump CACHE version to invalidate old cached HTML/CSS/JS on deploy.
const CACHE = 'japanese-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/phoneme-trainer.html',
  '/listening-quiz.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
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
  const url = new URL(e.request.url);
  // Never intercept API calls (TTS/STT) — always hit network.
  if (url.pathname.startsWith('/api/')) return;
  // Only handle same-origin GETs.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(resp => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => hit)
    )
  );
});
