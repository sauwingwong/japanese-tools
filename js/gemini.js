// Client helper for /api/gemini.
// - Caches results in localStorage keyed by cacheKey with a TTL (default 7d)
//   so re-drilling the same content is free.
// - schema forces structured JSON output (Gemini responseSchema).
// - Abortable via opts.signal.
//
// Dual-mode: works as an ES module (export) AND as a classic script that
// attaches window.askGemini / window.clearGeminiCache / window.clearAllGeminiCache.
// Some older iOS Safari versions fail to load this file as a module; the
// classic-script path is the reliable fallback.

(function (root) {
  var CACHE_PREFIX = 'gemini-cache/';
  var DEFAULT_TTL_DAYS = 7;

  function cacheGet(key) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var value = parsed.value;
      var exp = parsed.exp;
      if (typeof exp === 'number' && exp < Date.now()) {
        localStorage.removeItem(CACHE_PREFIX + key);
        return null;
      }
      return value;
    } catch (_e) {
      return null;
    }
  }

  function cacheSet(key, value, ttlDays) {
    try {
      var exp = Date.now() + ttlDays * 86400000;
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ value: value, exp: exp }));
    } catch (_e) {
      // Quota exceeded or private-mode: best-effort, drop silently.
    }
  }

  function askGemini(prompt, opts) {
    opts = opts || {};
    var schema = opts.schema;
    var temperature = opts.temperature;
    var model = opts.model;
    var cacheKey = opts.cacheKey;
    var ttlDays = typeof opts.ttlDays === 'number' ? opts.ttlDays : DEFAULT_TTL_DAYS;
    var signal = opts.signal;
    var bypassCache = opts.bypassCache === true;

    if (cacheKey && !bypassCache) {
      var hit = cacheGet(cacheKey);
      if (hit !== null) return Promise.resolve(hit);
    }

    var body = { prompt: prompt };
    if (schema) body.schema = schema;
    if (typeof temperature === 'number') body.temperature = temperature;
    if (model) body.model = model;

    return fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(
          function (j) { throw new Error('Gemini request failed: ' + (j && j.error || res.status)); },
          function () { throw new Error('Gemini request failed: HTTP ' + res.status); }
        );
      }
      return res.json();
    }).then(function (data) {
      var text = data.text;
      if (cacheKey) cacheSet(cacheKey, text, ttlDays);
      return text;
    });
  }

  function clearGeminiCache(cacheKey) {
    try { localStorage.removeItem(CACHE_PREFIX + cacheKey); } catch (_e) {}
  }

  function clearAllGeminiCache() {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
      }
      for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
    } catch (_e) {}
  }

  // Expose on window for classic-script consumers.
  root.askGemini = askGemini;
  root.clearGeminiCache = clearGeminiCache;
  root.clearAllGeminiCache = clearAllGeminiCache;
})(typeof window !== 'undefined' ? window : this);
