// Shared weighted-random SRS with localStorage persistence.
//
// Lifted from the listening quiz's in-memory engine:
//   - correct → weight *= 0.6, min 0.5
//   - wrong   → weight += 2.5
//   - pickNext() is weighted-random across known ids, excluding any in
//     `avoidIds` (for session-level "don't repeat immediately" constraints).
//
// Weights persist per namespace ("srs/n4-grammar", etc.) so a wrong answer on
// Monday still biases the pool on Tuesday.
//
// Usage:
//   const srs = createSRS('n4-grammar');
//   const id = srs.pickNext(allIds, { avoidIds: [lastId] });
//   srs.recordResult(id, true);   // or false

const PREFIX = 'srs/';
const DEFAULT_WEIGHT = 1;
const MIN_WEIGHT = 0.5;
const CORRECT_FACTOR = 0.6;
const WRONG_ADD = 2.5;

export function createSRS(namespace) {
  const key = PREFIX + namespace;
  let weights = loadWeights(key);

  function loadWeights(k) {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function save() {
    try { localStorage.setItem(key, JSON.stringify(weights)); } catch {}
  }

  function weightOf(id) {
    return typeof weights[id] === 'number' ? weights[id] : DEFAULT_WEIGHT;
  }

  function pickNext(ids, opts = {}) {
    const avoid = new Set(opts.avoidIds || []);
    const pool = ids.filter(id => !avoid.has(id));
    const source = pool.length ? pool : ids;
    if (!source.length) return null;

    let total = 0;
    for (const id of source) total += weightOf(id);
    let r = Math.random() * total;
    for (const id of source) {
      r -= weightOf(id);
      if (r <= 0) return id;
    }
    return source[source.length - 1];
  }

  function recordResult(id, correct) {
    const w = weightOf(id);
    weights[id] = correct
      ? Math.max(MIN_WEIGHT, w * CORRECT_FACTOR)
      : w + WRONG_ADD;
    save();
  }

  function getWeight(id) { return weightOf(id); }

  function reset() {
    weights = {};
    try { localStorage.removeItem(key); } catch {}
  }

  // Simple mastery estimate: items whose weight has decayed below 0.7 are
  // "known", weight >= 2 is "struggling". Returns {known, learning, struggling, total}.
  function stats(ids) {
    let known = 0, learning = 0, struggling = 0;
    for (const id of ids) {
      const w = weightOf(id);
      if (w <= 0.7) known++;
      else if (w >= 2) struggling++;
      else learning++;
    }
    return { known, learning, struggling, total: ids.length };
  }

  return { pickNext, recordResult, getWeight, reset, stats };
}
