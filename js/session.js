// Bounded learning session — shared shell for listening-quiz, grammar,
// kanji, phrases. Owns the HUD (streak chip, retention %, progress bar)
// and the end screen (medal, wrong-answer review, finish-line flourish).
// The drill UI itself stays in each page — this module is purely
// session-state + HUD/end DOM.
//
// Typical flow:
//   import { createSession } from '/js/session.js';
//   const session = createSession({
//     length: 15,
//     hudEl: document.getElementById('session-hud'),
//     endEl: document.getElementById('session-end'),
//     poolSize: () => pool.length,
//     retention7d: () => srs.retention7d(),
//     onComplete: (summary) => { /* chain to next tool, or showEnd ritual */ },
//     onReset:    () => { /* page clears its UI, calls start() again, etc */ },
//   });
//   session.start();                                              // begin
//   // … page renders question …
//   // user answers:
//   session.recordAnswer({ id, correct, label, meaning });
//   // user clicks Next:
//   if (session.advance()) renderNextQuestion();
//   // else: session has already shown the end screen + flourish.
//
// Why this shape: each page already owns its own SRS instance, its own
// pool selection, and its own reveal/next-button UI. The session is just
// the "round" wrapper — start, count, end, celebrate.

const STYLE_ID = 'session-shell-styles';

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .ses-hud { display:flex; gap:10px; align-items:center; padding:8px 12px; background:#f7f7fa; border-radius:8px; flex-wrap:wrap; font-size:0.85rem; }
    .ses-hud-score { font-weight:700; color:#1a237e; font-size:1rem; }
    .ses-hud-pct { color:#888; font-weight:400; font-size:0.8rem; margin-left:4px; }
    .ses-hud-retention { color:#2e7d32; font-weight:600; }
    .ses-hud-streak { color:#e65100; font-weight:600; }
    .ses-hud-pool { margin-left:auto; color:#777; font-size:0.78rem; }
    .ses-hud-reset { margin-left:6px; padding:3px 10px; font-size:0.78rem; border:1px solid #ccc; border-radius:14px; background:white; cursor:pointer; }
    .ses-hud-reset:hover { background:#eee; }
    .ses-hud-progress { flex-basis:100%; height:5px; background:#e0e0e0; border-radius:3px; margin-top:6px; overflow:hidden; }
    .ses-hud-progress-fill { height:100%; background:linear-gradient(90deg,#1e88e5,#43a047); transition:width 250ms ease; width:0%; }

    .ses-end { display:none; background:white; border-radius:12px; padding:24px 20px; text-align:center; box-shadow:0 4px 16px rgba(0,0,0,0.08); position:relative; overflow:hidden; margin-top:12px; }
    .ses-end-medal { font-size:60px; line-height:1; margin-bottom:6px; display:inline-block; animation:sesMedalPop 800ms cubic-bezier(.2,.8,.3,1.2); }
    .ses-end h2 { margin:6px 0 8px; color:#1a237e; }
    .ses-end-summary { color:#444; margin:8px 0 14px; font-size:0.95rem; }
    .ses-end-review-title { font-weight:600; margin:14px 0 6px; color:#c62828; font-size:0.9rem; }
    .ses-end-review-list { list-style:none; padding:0; margin:0 auto; max-width:340px; text-align:left; }
    .ses-end-review-list li { padding:6px 12px; background:#fff5f5; border-left:3px solid #ff5252; margin:4px 0; border-radius:4px; font-size:0.88rem; }
    .ses-end-perfect { color:#2e7d32; font-size:1.05rem; font-weight:600; margin:14px 0; }
    .ses-end-btn { background:#1a237e; color:white; border:none; padding:10px 22px; font-size:0.95rem; border-radius:8px; cursor:pointer; margin-top:14px; }
    .ses-end-btn:hover { background:#0d1551; }
    .ses-end-meta { color:#888; font-size:0.78rem; margin-top:8px; }

    @keyframes sesMedalPop { 0%{transform:scale(0);opacity:0;} 60%{transform:scale(1.18);opacity:1;} 100%{transform:scale(1);opacity:1;} }
    .ses-confetti { position:absolute; top:-18px; width:7px; height:13px; opacity:0.9; pointer-events:none; animation:sesFall 1.8s ease-in forwards; }
    @keyframes sesFall { 0%{transform:translateY(0) rotate(0);opacity:1;} 100%{transform:translateY(420px) rotate(720deg);opacity:0;} }
  `;
  document.head.appendChild(s);
}

export function createSession(opts = {}) {
  injectStyles();

  const length = Math.max(1, opts.length || 15);
  const hudEl = opts.hudEl || null;
  const endEl = opts.endEl || null;
  const poolSize = opts.poolSize || (() => null);
  const retention7d = opts.retention7d || (() => null);
  const onComplete = opts.onComplete || (() => {});
  const onReset = opts.onReset || (() => {});

  // Mark mount nodes so page CSS can target them.
  if (hudEl) hudEl.classList.add('ses-hud-mount');
  if (endEl) { endEl.classList.add('ses-end'); endEl.style.display = 'none'; }

  let correct = 0, total = 0, streak = 0, answered = false;
  const wrongList = []; // { id, label, meaning, userPick }
  const seen = new Set();
  let startedAt = 0;
  let ended = false;

  function renderHud() {
    if (!hudEl) return;
    const ret = retention7d();
    const retText = (typeof ret === 'number')
      ? `<span class="ses-hud-retention" title="7-day retention rate">${Math.round(ret * 100)}%</span>`
      : '';
    const streakText = streak >= 3
      ? `<span class="ses-hud-streak">🔥 ${streak}</span>`
      : '';
    const pct = total ? Math.round(correct / total * 100) : null;
    const pctText = pct == null ? '' : `<span class="ses-hud-pct">(${pct}%)</span>`;
    const pool = poolSize();
    const poolText = (pool != null) ? `<span class="ses-hud-pool">Pool ${pool}</span>` : '';
    const progress = Math.min(1, total / length);
    hudEl.innerHTML = `
      <span class="ses-hud-score"><strong>${correct}</strong> / <strong>${total}</strong>/<span style="opacity:.7;">${length}</span> ${pctText}</span>
      ${retText}
      ${streakText}
      ${poolText}
      <button type="button" class="ses-hud-reset" data-act="reset" title="Restart this session">↻</button>
      <div class="ses-hud-progress"><div class="ses-hud-progress-fill" style="width:${progress * 100}%"></div></div>
    `;
    const resetBtn = hudEl.querySelector('[data-act="reset"]');
    if (resetBtn) resetBtn.addEventListener('click', () => onReset());
  }

  function start() {
    correct = 0; total = 0; streak = 0; answered = false; ended = false;
    wrongList.length = 0;
    seen.clear();
    startedAt = Date.now();
    if (endEl) endEl.style.display = 'none';
    if (hudEl) hudEl.style.display = '';
    renderHud();
  }

  function recordAnswer({ id, correct: ok, label, meaning, userPick } = {}) {
    if (answered || ended) return;
    answered = true;
    total++;
    if (id != null) seen.add(id);
    if (ok) {
      correct++;
      streak++;
    } else {
      streak = 0;
      wrongList.push({ id, label: label || String(id || ''), meaning: meaning || '', userPick });
    }
    renderHud();
  }

  // Call after the user dismisses the per-question reveal (e.g. clicks Next).
  // Returns true if session should keep going, false if we just rendered the
  // end screen.
  function advance() {
    if (total >= length) { finish(); return false; }
    answered = false;
    return true;
  }

  function isOver() { return total >= length; }

  function summary() {
    return {
      correct, total,
      length,
      pct: total ? correct / total : 0,
      seenCount: seen.size,
      wrongList: wrongList.slice(),
      durationMs: Date.now() - startedAt,
    };
  }

  function finish() {
    if (ended) return;
    ended = true;
    const s = summary();
    renderEnd(s);
    flourish(s);
    try { onComplete(s); } catch (e) { console.warn('session onComplete threw:', e); }
  }

  function renderEnd(s) {
    if (!endEl) return;
    const pct = Math.round(s.pct * 100);
    const medal = pct >= 90 ? '🥇' : pct >= 70 ? '🥈' : pct >= 50 ? '🥉' : '💪';
    const mins = (s.durationMs / 60000).toFixed(1);
    const reviewHtml = s.wrongList.length
      ? `<div class="ses-end-review-title">To review (${s.wrongList.length}):</div>
         <ul class="ses-end-review-list">${
           s.wrongList.map(w => `<li><strong>${escapeHtml(w.label)}</strong>${w.meaning ? ' — ' + escapeHtml(w.meaning) : ''}</li>`).join('')
         }</ul>`
      : `<div class="ses-end-perfect">🎉 Perfect session!</div>`;
    endEl.innerHTML = `
      <div class="ses-end-medal">${medal}</div>
      <h2>Session complete</h2>
      <div class="ses-end-summary">
        Score: <strong>${s.correct} / ${s.total}</strong> (${pct}%)<br>
        Unique items: <strong>${s.seenCount}</strong>
      </div>
      ${reviewHtml}
      <button type="button" class="ses-end-btn" data-act="restart">Start another</button>
      <div class="ses-end-meta">${mins} min · ${s.length} questions</div>
    `;
    endEl.style.display = 'block';
    const btn = endEl.querySelector('[data-act="restart"]');
    if (btn) btn.addEventListener('click', () => { endEl.style.display = 'none'; ended = false; onReset(); });
  }

  // ---- finish-line flourish: a soft ding + (perfect only) confetti ----
  let _ctx = null;
  function flourish(s) {
    try {
      if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (_ctx.state === 'suspended') _ctx.resume();
      const o = _ctx.createOscillator();
      const g = _ctx.createGain();
      o.frequency.value = (s.pct === 1) ? 1318 : 880; // E6 vs A5
      o.type = 'sine';
      g.gain.value = 0.0001;
      o.connect(g); g.connect(_ctx.destination);
      const t = _ctx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.start(t); o.stop(t + 0.46);
    } catch {}
    if (s.pct === 1 && s.total > 0 && endEl) confetti();
  }

  function confetti() {
    const COLORS = ['#ff5252', '#ffb300', '#43a047', '#1e88e5', '#8e24aa', '#f06292'];
    for (let i = 0; i < 18; i++) {
      const d = document.createElement('div');
      d.className = 'ses-confetti';
      d.style.left = (5 + Math.random() * 90) + '%';
      d.style.background = COLORS[i % COLORS.length];
      d.style.animationDelay = (Math.random() * 0.4) + 's';
      d.style.transform = `rotate(${Math.random() * 360}deg)`;
      endEl.appendChild(d);
      setTimeout(() => d.remove(), 2200);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return {
    start,
    recordAnswer,
    advance,
    isOver,
    summary,
    renderHud,
    finish,
    get correct() { return correct; },
    get total() { return total; },
    get streak() { return streak; },
    get length() { return length; },
  };
}
