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

  navigator.serviceWorker.register('/sw.js').then(reg => {
    const kick = () => { try { reg.update(); } catch {} };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
    window.addEventListener('pageshow', kick);
  }).catch(err => console.warn('SW fail:', err));

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
})();
