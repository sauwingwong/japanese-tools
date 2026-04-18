// Client helper for /api/gemini.
// - Caches results in localStorage keyed by `cacheKey` with a TTL (default 7d)
//   so re-drilling the same content is free.
// - `schema` forces structured JSON output (Gemini responseSchema).
// - Abortable via opts.signal.
//
// Usage:
//   const data = await askGemini(prompt, {
//     schema: { type: 'object', properties: {...}, required: [...] },
//     cacheKey: 'grammar/naranai',
//     ttlDays: 7,
//   });

const CACHE_PREFIX = 'gemini-cache/';
const DEFAULT_TTL_DAYS = 7;

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { value, exp } = JSON.parse(raw);
    if (typeof exp === 'number' && exp < Date.now()) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function cacheSet(key, value, ttlDays) {
  try {
    const exp = Date.now() + ttlDays * 86400000;
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ value, exp }));
  } catch {
    // Quota exceeded or private-mode: best-effort, drop silently.
  }
}

export async function askGemini(prompt, opts = {}) {
  const {
    schema,
    temperature,
    model,
    cacheKey,
    ttlDays = DEFAULT_TTL_DAYS,
    signal,
    bypassCache = false,
  } = opts;

  if (cacheKey && !bypassCache) {
    const hit = cacheGet(cacheKey);
    if (hit !== null) return hit;
  }

  const body = { prompt };
  if (schema) body.schema = schema;
  if (typeof temperature === 'number') body.temperature = temperature;
  if (model) body.model = model;

  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let detail;
    try { detail = (await res.json()).error; } catch { detail = `HTTP ${res.status}`; }
    throw new Error(`Gemini request failed: ${detail}`);
  }

  const { text } = await res.json();

  if (cacheKey) cacheSet(cacheKey, text, ttlDays);
  return text;
}

// Tiny helper: clear a single cache entry (e.g. "regenerate" button).
export function clearGeminiCache(cacheKey) {
  try { localStorage.removeItem(CACHE_PREFIX + cacheKey); } catch {}
}

// Wipe all cached Gemini content (e.g. settings "clear cache" button).
export function clearAllGeminiCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch {}
}
