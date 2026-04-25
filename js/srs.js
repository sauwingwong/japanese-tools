// Anki-style SM-2 SRS with localStorage persistence.
//
// Card state per id:
//   { ease: 2.5, interval: 0, due: <ms>, reps: 0, lapses: 0, seen: false }
//
// Grade flow (auto-binary):
//   correct:
//     reps==0 → interval=1 day
//     reps==1 → interval=6 days
//     else    → interval = round(interval * ease)
//     reps++
//   wrong:
//     interval=0, reps=0, lapses++, ease=max(1.3, ease-0.2)
//   both: due = now + interval*day; seen=true
//
// Picker priority (skips opts.avoidIds):
//   1. Lapsed/learning — seen && reps==0 && due≤now+60s   (random)
//   2. Due reviews     — seen && reps>0  && due≤now+60s   (oldest due first)
//   3. New cards       — !seen, up to newPerDay per local calendar day
//   4. Fallback        — nearest upcoming due
//
// New-card budget persists at `srs/<ns>/new-count/<YYYY-MM-DD>`.
//
// Migrates the legacy weighted-random schema (bare number weights) on first
// load: w≤0.7 → graduated (1w future), 0.7<w≤1.5 → fresh-due, w≥1.5 →
// lapsed-due with lower ease. Re-saved in new format on first write.
//
// Optional Supabase sync (opts.sync = true):
//   - On construction, kick off a pull from /api/srs?ns=<ns>. If the remote
//     row's updated_at is newer than the local snapshot, overwrite local.
//   - On every save, schedule a debounced (2s) upsert to /api/srs. Keeps
//     localStorage as the synchronous source of truth; Supabase is the
//     durability + cross-device layer.
//   - LWW per namespace. Two-user/two-device collisions are rare in this
//     app (single learner per account, usually one device at a time) and
//     worst case is re-showing a few cards.
//   - If /api/srs returns 501/404 (env vars unset), sync quietly no-ops.
//
// API is stable vs. the previous weighted engine:
//   createSRS(ns, opts?) → { pickNext, recordResult, getWeight, reset, stats }
//   opts: { newPerDay?: number, sync?: boolean }

const PREFIX = 'srs/';
const DAY_MS = 86_400_000;
const GRACE_MS = 60_000; // consider cards due if within 60s of now
const DEFAULT_NEW_PER_DAY = 20;

const DEFAULT_CARD = () => ({
  ease: 2.5, interval: 0, due: 0, reps: 0, lapses: 0, seen: false,
});

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Convert legacy bare-number weight → new card state.
function migrateWeight(w, now) {
  if (w <= 0.7) {
    return { ease: 2.5, interval: 7, due: now + 7 * DAY_MS, reps: 1, lapses: 0, seen: true };
  }
  if (w <= 1.5) {
    return { ease: 2.5, interval: 0, due: now, reps: 0, lapses: 0, seen: true };
  }
  return { ease: 2.0, interval: 0, due: now, reps: 0, lapses: 1, seen: true };
}

export function createSRS(namespace, opts = {}) {
  const key = PREFIX + namespace;
  const stampKey = `${key}/updated_at`;
  const newPerDay = opts.newPerDay || DEFAULT_NEW_PER_DAY;
  const syncEnabled = !!opts.sync;
  let dirty = false;
  let cards = load();
  let localStamp = readStamp();
  let pushTimer = null;
  let pushing = false;

  function readStamp() {
    try { return localStorage.getItem(stampKey) || null; } catch { return null; }
  }
  function writeStamp(iso) {
    localStamp = iso;
    try { localStorage.setItem(stampKey, iso); } catch {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const now = Date.now();
      const out = {};
      let migrated = false;
      for (const id of Object.keys(parsed)) {
        const v = parsed[id];
        if (typeof v === 'number') {
          out[id] = migrateWeight(v, now);
          migrated = true;
        } else if (v && typeof v === 'object') {
          out[id] = {
            ease: typeof v.ease === 'number' ? v.ease : 2.5,
            interval: typeof v.interval === 'number' ? v.interval : 0,
            due: typeof v.due === 'number' ? v.due : 0,
            reps: typeof v.reps === 'number' ? v.reps : 0,
            lapses: typeof v.lapses === 'number' ? v.lapses : 0,
            seen: !!v.seen,
          };
        }
      }
      if (migrated) dirty = true;
      return out;
    } catch { return {}; }
  }

  function save() {
    const iso = new Date().toISOString();
    try { localStorage.setItem(key, JSON.stringify(cards)); dirty = false; } catch {}
    writeStamp(iso);
    if (syncEnabled) schedulePush();
  }

  // Flush an initial save if migration ran.
  if (dirty) save();

  // ── Supabase sync ──
  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, 2000);
  }
  async function doPush() {
    pushTimer = null;
    if (pushing) { schedulePush(); return; }
    pushing = true;
    try {
      await fetch('/api/srs', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace, data: cards, updated_at: localStamp }),
      });
    } catch {}
    pushing = false;
  }
  async function pullOnce() {
    try {
      const res = await fetch(`/api/srs?ns=${encodeURIComponent(namespace)}`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const { data, updated_at } = await res.json();
      if (!data || !updated_at) {
        // Remote is empty — push local if we have anything worth keeping.
        if (Object.keys(cards).length) schedulePush();
        return;
      }
      // LWW: remote wins only if strictly newer than local snapshot.
      if (!localStamp || updated_at > localStamp) {
        cards = data;
        try { localStorage.setItem(key, JSON.stringify(cards)); } catch {}
        writeStamp(updated_at);
      } else if (updated_at < localStamp) {
        // Local is newer — push.
        schedulePush();
      }
    } catch {}
  }
  if (syncEnabled) pullOnce();

  // Flush pending push before the page unloads.
  if (syncEnabled && typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { if (pushTimer) { clearTimeout(pushTimer); doPush(); } });
  }

  function getCard(id) {
    return cards[id] || DEFAULT_CARD();
  }

  // ── New-card budget ──
  function newCountKey() { return `${PREFIX}${namespace}/new-count/${todayKey()}`; }
  function newCountToday() {
    try { return parseInt(localStorage.getItem(newCountKey()) || '0', 10) || 0; } catch { return 0; }
  }
  function bumpNewCount() {
    try { localStorage.setItem(newCountKey(), String(newCountToday() + 1)); } catch {}
  }

  function pickNext(ids, options = {}) {
    if (!ids || !ids.length) return null;
    const avoid = new Set(options.avoidIds || []);
    const now = Date.now();
    const cutoff = now + GRACE_MS;

    const lapsed = [];   // seen, reps==0, due
    const dueRev = [];   // seen, reps>0, due
    const newOnes = [];  // !seen
    const future = [];   // everything else (upcoming due)

    for (const id of ids) {
      if (avoid.has(id)) continue;
      const c = getCard(id);
      if (!c.seen) newOnes.push(id);
      else if (c.reps === 0 && c.due <= cutoff) lapsed.push(id);
      else if (c.reps > 0 && c.due <= cutoff) dueRev.push(id);
      else future.push(id);
    }

    // 1. Lapsed → random.
    if (lapsed.length) return lapsed[Math.floor(Math.random() * lapsed.length)];

    // 2. Due reviews → oldest `due` first.
    if (dueRev.length) {
      dueRev.sort((a, b) => getCard(a).due - getCard(b).due);
      return dueRev[0];
    }

    // 3. New cards within daily budget.
    if (newOnes.length && newCountToday() < newPerDay) {
      // Preserve original array order (map ids→position) rather than random,
      // so users progress through the vocab list as written.
      const byIndex = newOnes.slice(0, 1); // take the first unseen in source order
      return byIndex[0];
    }

    // 4. Fallback: nearest upcoming due.
    if (future.length) {
      future.sort((a, b) => getCard(a).due - getCard(b).due);
      return future[0];
    }

    // Nothing? Fall back to random from full list (minus avoid) so the UI
    // never dead-ends. Happens e.g. when all ids are in avoid.
    const free = ids.filter(i => !avoid.has(i));
    const src = free.length ? free : ids;
    return src[Math.floor(Math.random() * src.length)];
  }

  function recordResult(id, correct) {
    const c = { ...getCard(id) };
    const wasNew = !c.seen;

    if (correct) {
      if (c.reps === 0) c.interval = 1;
      else if (c.reps === 1) c.interval = 6;
      else c.interval = Math.max(1, Math.round(c.interval * c.ease));
      c.reps += 1;
    } else {
      c.interval = 0;
      c.reps = 0;
      c.lapses += 1;
      c.ease = Math.max(1.3, c.ease - 0.2);
    }
    const now = Date.now();
    c.due = now + c.interval * DAY_MS;
    c.seen = true;
    // Additive fields for retention7d() and presence — backwards compatible.
    c.lastReviewedAt = now;
    c.lastResult = correct ? 1 : 0;

    cards[id] = c;
    save();
    if (wasNew) bumpNewCount();
  }

  // 7-day retention rate: of cards reviewed in the last 7 days, what fraction
  // were answered correctly? Returns null if no reviews in window so callers
  // can hide the metric on day-1.
  function retention7d() {
    const cutoff = Date.now() - 7 * DAY_MS;
    let total = 0, correct = 0;
    for (const id of Object.keys(cards)) {
      const c = cards[id];
      if (!c || typeof c.lastReviewedAt !== 'number') continue;
      if (c.lastReviewedAt < cutoff) continue;
      total++;
      if (c.lastResult === 1) correct++;
    }
    if (!total) return null;
    return correct / total;
  }

  // The most recent item reviewed, or null. Used by presence to surface
  // "partner studied 駅 today".
  function lastStudied() {
    let bestId = null, bestT = 0;
    for (const id of Object.keys(cards)) {
      const c = cards[id];
      if (!c || typeof c.lastReviewedAt !== 'number') continue;
      if (c.lastReviewedAt > bestT) { bestT = c.lastReviewedAt; bestId = id; }
    }
    return bestId ? { id: bestId, at: bestT } : null;
  }

  // Derived difficulty score: higher = should show sooner. Keeps old
  // sort/filter code (that called getWeight) roughly working.
  function getWeight(id) {
    const c = getCard(id);
    if (!c.seen) return 1;
    // Lower ease and fewer reps → higher "weight".
    return (1 / Math.max(1.3, c.ease)) * (1 / Math.max(1, c.reps + 1)) * (c.lapses + 1);
  }

  function reset() {
    cards = {};
    try { localStorage.removeItem(key); } catch {}
    try { localStorage.removeItem(stampKey); } catch {}
    try {
      // Also drop today's new-count so a reset genuinely starts over.
      localStorage.removeItem(newCountKey());
    } catch {}
    localStamp = null;
    if (syncEnabled) {
      // Push empty state so other devices clear too.
      writeStamp(new Date().toISOString());
      schedulePush();
    }
  }

  function stats(ids) {
    const now = Date.now();
    const cutoff = now + GRACE_MS;
    let n = 0, learning = 0, due = 0, future = 0, known = 0, struggling = 0;
    for (const id of ids) {
      const c = cards[id];
      if (!c || !c.seen) { n++; continue; }
      if (c.reps === 0 && c.due <= cutoff) { learning++; struggling++; continue; }
      if (c.reps > 0 && c.due <= cutoff)   { due++; continue; }
      // Upcoming: classify "known" if interval ≥ 7 days AND reps ≥ 2.
      future++;
      if (c.interval >= 7 && c.reps >= 2) known++;
      if (c.ease < 2.0) struggling++;
    }
    return {
      new: n,
      learning,
      due,
      future,
      known,
      struggling,
      total: ids.length,
      newToday: newCountToday(),
      newPerDay,
    };
  }

  return { pickNext, recordResult, getWeight, reset, stats, retention7d, lastStudied };
}

// ── Presence (async co-presence between the two users) ──────────────────
//
// Stores a single row per user under namespace='presence' in srs_state via
// the existing /api/srs PUT. The partner's row is fetched cross-user via
// /api/srs?ns=presence&all=1 (a small extension to the GET that, only for
// the presence namespace, returns ALL owners' rows instead of filtering by
// the caller's email).
//
// Shape: { lastStudied: <iso>, lastItem: <string>, lastSlice: <string> }
//
// Quietly no-ops if /api/srs is disabled (501), localStorage-only fallback.

const PRESENCE_NS = 'presence';

export const presence = {
  async markStudied({ lastItem, lastSlice } = {}) {
    const data = {
      lastStudied: new Date().toISOString(),
      lastItem: lastItem || null,
      lastSlice: lastSlice || null,
    };
    try {
      await fetch('/api/srs', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: PRESENCE_NS, data, updated_at: data.lastStudied }),
      });
    } catch {}
    // Mirror locally so we can show "you studied X ago" without a network round-trip.
    try { localStorage.setItem('presence/self', JSON.stringify(data)); } catch {}
  },

  // Returns the partner's row, or null. Server-side filter excludes the
  // caller's own row when all=1 is set.
  async fetchPartner() {
    try {
      const res = await fetch(`/api/srs?ns=${PRESENCE_NS}&all=1`, { credentials: 'include' });
      if (!res.ok) return null;
      const body = await res.json();
      // Server returns { rows: [{ owner_email, data, updated_at }, ...] } when all=1.
      if (!body.rows || !body.rows.length) return null;
      // Pick the one with the most recent updated_at.
      body.rows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      return body.rows[0].data || null;
    } catch { return null; }
  },
};
