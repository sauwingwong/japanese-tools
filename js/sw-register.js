// Shared service-worker registration + auto-update + auto-reload.
//
// Paired with functions/sw.js, which embeds the deploy commit SHA as the
// cache key. Together they eliminate the stale-PWA / unregister dance:
//
//   1. register /sw.js once per page load
//   2. call registration.update() whenever the app becomes visible (iOS
//      PWA resume, desktop tab focus) and on pageshow (covers bfcache)
//   3. when a new SW installs + activates (skipWaiting + clients.claim
//      in sw.js), 'controllerchange' fires → reload the page once so it
//      picks up new assets automatically.
//
// The reloaded latch avoids the infinite-reload loop that
// 'controllerchange' can otherwise cause on some browsers.

(function () {
  if (!('serviceWorker' in navigator)) return;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;

  // The expected current cache name. Bump in lockstep with sw.js's
  // CACHE constant. If the active SW's source doesn't contain this
  // string we know it's stale and force-unregister + reload, which
  // works around CF edge caching of the SW script.
  const EXPECTED_CACHE = 'japanese-v9-today';

  async function ensureFresh() {
    try {
      // Cache-bust the SW source; if it doesn't contain EXPECTED_CACHE
      // the deploy hasn't propagated yet, so don't churn.
      const txt = await fetch('/sw.js?probe=' + Date.now(), { cache: 'no-store' }).then(r => r.text());
      if (!txt.includes(EXPECTED_CACHE)) return false; // origin not ready

      // Origin has the right SW. If the active controller is using a
      // different cache, scrub everything and reload once.
      const regs = await navigator.serviceWorker.getRegistrations();
      const cacheKeys = await caches.keys();
      const stale = cacheKeys.some(k => k !== EXPECTED_CACHE);
      if (stale && !sessionStorage.getItem('sw-scrubbed')) {
        sessionStorage.setItem('sw-scrubbed', '1');
        for (const r of regs) await r.unregister();
        for (const k of cacheKeys) await caches.delete(k);
        location.reload();
        return true;
      }
    } catch {}
    return false;
  }

  ensureFresh().then(scrubbed => {
    if (scrubbed) return;
    navigator.serviceWorker.register('/sw.js').then(reg => {
      const kick = () => { try { reg.update(); } catch {} };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') kick();
      });
      window.addEventListener('pageshow', kick);
    }).catch(err => console.warn('SW fail:', err));
  });

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
})();
