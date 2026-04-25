// Today queue: builds a single multi-tool study session from due / new
// SRS items across the four bounded-session tools, persists it to
// localStorage, and routes the learner from one tool to the next.
//
// Flow:
//   1. Home (index.html) calls await getTodayPreview(cup) to render the
//      hero card preview ("5 vocab due, 3 grammar due, 2 kanji due, +3
//      new — ~15 min").
//   2. Continue button calls startQueue(cup) → navigates to the first
//      slice's tool URL with ?queue=0.
//   3. Each tool page calls queueState() on load. If non-null, it:
//        - sets the session length to slice.count
//        - on session.onComplete, calls recordSliceResult + advances
//   4. After the last slice, the tool navigates to /index.html?done=1
//      and the home page renders an aggregate summary.
//
// Single source of truth: localStorage 'todayQueue' = {
//   date: 'YYYY-MM-DD',  // queue is invalidated when date changes
//   cup: 5|15|30,
//   slices: [{ tool, count, summary?: {correct,total,wrongList,durationMs} }, ...],
// }
//
// Why a slice ≠ a "due item": each tool already runs its own SRS pick
// loop (lapsed → due → new → fallback). The queue only allocates a
// question budget per tool — the tool decides which specific items.
// This keeps the queue dumb and avoids tight coupling between tools.

import { createSRS } from '/js/srs.js';

// 4 tools the queue knows about. Phoneme + Dictation are excluded for
// now: phoneme is a tutorial-style sound chart (no SRS pool), and
// dictation overlaps with listening-quiz. Either could be added later
// as a 5th slice.
export const TOOLS = [
  {
    id: 'vocab',
    ns: 'n5n4-vocab',
    dataUrl: '/data/vocab-n5n4.json',
    pickIds: (data) => data.map(w => w.h),
    path: '/listening-quiz.html',
    label: 'Vocab',
    icon: '🎧',
    weight: 0.40,
  },
  {
    id: 'grammar',
    ns: 'n5n4-grammar',
    dataUrl: '/data/grammar-n5n4.json',
    pickIds: (data) => (data.patterns || []).map(p => p.id),
    path: '/grammar.html',
    label: 'Grammar',
    icon: '🧠',
    weight: 0.25,
  },
  {
    id: 'kanji',
    ns: 'n5n4-kanji',
    dataUrl: '/data/kanji-n5n4.json',
    pickIds: (data) => (data.kanji || []).map(k => k.kanji),
    path: '/kanji.html',
    label: 'Kanji',
    icon: '🈁',
    weight: 0.20,
  },
  {
    id: 'phrases',
    ns: 'phrases-tourist',
    dataUrl: '/data/phrases-tourist.json',
    pickIds: (data) => (data.phrases || []).map(p => p.id),
    path: '/phrases.html',
    label: 'Phrases',
    icon: '🗺️',
    weight: 0.15,
    extraQuery: '&mode=practice', // phrases needs Practice mode for the bounded session
  },
];

// Cup → total question count. Calibrated at ~12 s/question average
// (mix of MCQ, composition, "got it/need more"). 30-min cup is the
// upper bound — beyond this, retention gains diminish per the
// pedagogy review.
export const CUPS = [
  { mins: 5,  total: 6,  label: '☕ 5 min' },
  { mins: 15, total: 18, label: '🎯 15 min' },
  { mins: 30, total: 36, label: '🔥 30 min' },
];

const QUEUE_KEY = 'todayQueue';
const LAST_CUP_KEY = 'todayCup';

function todayDate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// One in-memory cache of each tool's data file, so repeated preview
// renders during cup switching don't re-fetch.
const _dataCache = new Map();
async function loadToolData(tool) {
  if (_dataCache.has(tool.id)) return _dataCache.get(tool.id);
  const res = await fetch(tool.dataUrl, { cache: 'no-cache' });
  const data = await res.json();
  _dataCache.set(tool.id, data);
  return data;
}

// Per-tool SRS instances are built read-only here (no sync needed for
// preview — the live tool pages already own the writes).
const _srsCache = new Map();
function srsFor(tool) {
  if (_srsCache.has(tool.id)) return _srsCache.get(tool.id);
  const s = createSRS(tool.ns, { sync: false });
  _srsCache.set(tool.id, s);
  return s;
}

// Stats for one tool across its full id pool: how many due / learning /
// new-budget-remaining. Used by the home preview.
export async function statsForTool(tool) {
  const data = await loadToolData(tool);
  const ids = tool.pickIds(data);
  const s = srsFor(tool).stats(ids);
  return {
    poolSize: ids.length,
    due: s.due,
    learning: s.learning,
    newRemaining: Math.max(0, s.newPerDay - s.newToday),
    known: s.known,
  };
}

// Build the queue preview for a given cup. Returns the slice list +
// the aggregate "X vocab, Y grammar, Z kanji" preview string.
//
// Allocation: start with weighted budget per tool. Then in a second
// pass redistribute any leftover (when due+new < budget) to tools
// that still have capacity. Final cap: a single tool can't exceed
// the cup's total; tools with zero capacity are dropped.
export async function buildPreview(cup) {
  const cupCfg = CUPS.find(c => c.mins === cup) || CUPS[1];
  const total = cupCfg.total;

  const stats = await Promise.all(TOOLS.map(async t => ({
    tool: t,
    stats: await statsForTool(t),
  })));

  // Initial weighted allocation, capped by what each tool can realistically serve.
  // Capacity = due + learning (re-shown soon) + newRemaining.
  let allocated = stats.map(({ tool, stats: s }) => {
    const capacity = s.due + s.learning + s.newRemaining;
    const want = Math.round(total * tool.weight);
    return { tool, stats: s, count: Math.min(want, capacity) };
  });

  // Redistribute any leftover budget to tools that still have capacity
  // (greedy: largest remaining capacity first).
  let leftover = total - allocated.reduce((a, x) => a + x.count, 0);
  while (leftover > 0) {
    const candidates = allocated
      .map((a, i) => ({ i, slack: (a.stats.due + a.stats.learning + a.stats.newRemaining) - a.count }))
      .filter(c => c.slack > 0)
      .sort((a, b) => b.slack - a.slack);
    if (!candidates.length) break;
    allocated[candidates[0].i].count++;
    leftover--;
  }

  const slices = allocated.filter(a => a.count > 0).map(a => ({
    tool: a.tool.id,
    count: a.count,
  }));

  return {
    cup,
    cupLabel: cupCfg.label,
    totalQ: slices.reduce((a, s) => a + s.count, 0),
    targetMins: cupCfg.mins,
    slices,
    perTool: stats,
  };
}

// Persist the preview as the active queue and return the first tool URL.
export async function startQueue(cup) {
  const preview = await buildPreview(cup);
  const queue = {
    date: todayDate(),
    cup,
    slices: preview.slices.map(s => ({ ...s, summary: null })),
  };
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch {}
  try { localStorage.setItem(LAST_CUP_KEY, String(cup)); } catch {}
  return urlForSlice(0);
}

export function getQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return null;
    const q = JSON.parse(raw);
    if (q.date !== todayDate()) return null; // stale, ignore
    return q;
  } catch { return null; }
}

export function clearQueue() {
  try { localStorage.removeItem(QUEUE_KEY); } catch {}
}

export function lastCup() {
  try { return Number(localStorage.getItem(LAST_CUP_KEY)) || 15; }
  catch { return 15; }
}

// Build the URL for slice index i (or done URL if past the last).
function urlForSlice(i) {
  const q = getQueue();
  if (!q || i >= q.slices.length) return '/index.html?done=1';
  const slice = q.slices[i];
  const tool = TOOLS.find(t => t.id === slice.tool);
  if (!tool) return '/index.html?done=1';
  return tool.path + '?queue=' + i + (tool.extraQuery || '');
}

// Tool-page entry point: returns { index, slice, tool, advance(summary) }
// or null if no queue is active for this URL.
export function queueState() {
  const params = new URLSearchParams(location.search);
  const idxRaw = params.get('queue');
  if (idxRaw == null) return null;
  const idx = Number(idxRaw);
  const q = getQueue();
  if (!q || isNaN(idx) || idx < 0 || idx >= q.slices.length) return null;
  const slice = q.slices[idx];
  const tool = TOOLS.find(t => t.id === slice.tool);
  if (!tool) return null;

  return {
    index: idx,
    total: q.slices.length,
    count: slice.count,
    tool,
    slice,
    // Called from session.onComplete on this page.
    advance(summary) {
      try {
        const cur = getQueue();
        if (cur) {
          cur.slices[idx].summary = summary || null;
          localStorage.setItem(QUEUE_KEY, JSON.stringify(cur));
        }
      } catch {}
      // Brief pause so the end screen's medal + ding can register
      // before the navigation fires.
      setTimeout(() => { location.href = urlForSlice(idx + 1); }, 1400);
    },
  };
}

// Aggregate summary for the done screen on /index.html?done=1.
export function aggregateSummary() {
  const q = getQueue();
  if (!q) return null;
  const completed = q.slices.filter(s => s.summary);
  const correct = completed.reduce((a, s) => a + (s.summary?.correct || 0), 0);
  const total   = completed.reduce((a, s) => a + (s.summary?.total   || 0), 0);
  const durMs   = completed.reduce((a, s) => a + (s.summary?.durationMs || 0), 0);
  const wrong   = completed.flatMap(s => s.summary?.wrongList || []);
  return {
    cup: q.cup,
    correct, total,
    pct: total ? correct / total : 0,
    durationMs: durMs,
    perSlice: q.slices.map(s => ({
      tool: s.tool,
      count: s.count,
      summary: s.summary,
    })),
    wrongList: wrong,
  };
}
