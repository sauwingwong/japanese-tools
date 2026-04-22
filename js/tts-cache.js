// IndexedDB cache for /api/tts base64 PCM clips.
//
// Why IDB (not localStorage / Cache API):
//   - localStorage: 5-10 MB cap, synchronous → blocks main thread on MB
//     base64 writes. Wrong tool.
//   - Cache API: stores Response objects; /api/tts returns JSON-wrapped
//     base64, so round-tripping is awkward.
//   - IDB: async, GB-scale quota, binary-safe. Clean fit.
//
// DB: 'ttscache', store: 'clips', keyPath: 'key'
// Entry: { key, b64, bytes, voice, model, addedAt, lastUsed }
//
// Key shape: `${model}|${voice}|${text}` — same as the server-side SHA-1
// hash input so logs line up when debugging.
//
// LRU eviction runs on put() when total bytes > CACHE_MAX_BYTES.
//
// All functions fail soft: on IDB error they resolve null/undefined
// rather than throwing, so a broken cache never breaks audio playback.

const DB_NAME = 'ttscache';
const STORE = 'clips';
const CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('lastUsed', 'lastUsed');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return _dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export function makeKey(text, opts = {}) {
  return `${opts.model || 'default'}|${opts.voice || 'default'}|${text}`;
}

export async function get(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const store = tx(db, 'readwrite');
      const req = store.get(key);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) return resolve(null);
        // Touch lastUsed for LRU.
        row.lastUsed = Date.now();
        try { store.put(row); } catch {}
        resolve(row.b64);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function put(key, b64, meta = {}) {
  const db = await openDB();
  if (!db) return;
  const now = Date.now();
  const entry = {
    key,
    b64,
    bytes: b64.length, // base64 char count ≈ decoded bytes × 4/3; close enough for budgeting
    voice: meta.voice || null,
    model: meta.model || null,
    addedAt: now,
    lastUsed: now,
  };
  await new Promise((resolve) => {
    try {
      const req = tx(db, 'readwrite').put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
  // Fire-and-forget prune; don't await so playback isn't delayed.
  prune().catch(() => {});
}

export async function size() {
  const db = await openDB();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      let total = 0;
      const req = tx(db, 'readonly').openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { total += cur.value.bytes || 0; cur.continue(); }
        else resolve(total);
      };
      req.onerror = () => resolve(0);
    } catch { resolve(0); }
  });
}

// LRU eviction: if over budget, delete oldest-`lastUsed` rows until under.
export async function prune() {
  const db = await openDB();
  if (!db) return;
  const total = await size();
  if (total <= CACHE_MAX_BYTES) return;
  let overBy = total - CACHE_MAX_BYTES;
  await new Promise((resolve) => {
    try {
      const store = tx(db, 'readwrite');
      const idx = store.index('lastUsed');
      const req = idx.openCursor(); // ascending = oldest first
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || overBy <= 0) return resolve();
        overBy -= cur.value.bytes || 0;
        try { cur.delete(); } catch {}
        cur.continue();
      };
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}

export async function clear() {
  const db = await openDB();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const req = tx(db, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch { resolve(); }
  });
}

export default { get, put, size, prune, clear, makeKey };
