# Japanese Trainer — Claude operating memory

Project memory for Claude Code sessions. Written 2026-04-19 after the
iOS PWA hardening round shipped.

## What this repo is

A Japanese-learning PWA (japanese.sauww.uk). Single learner, personal
project. Hosted on Cloudflare Pages behind Cloudflare Access SSO,
installed on the user's iPhone as a PWA.

## Repo layout

```
japanese/
├── output/                       ← Cloudflare Pages root (deployed)
│   ├── index.html                ← home tab
│   ├── listening-quiz.html       ← N5/N4 vocab listening drill + 🎤 Say it aloud
│   ├── phrases.html              ← tourist phrases, Practice with speech grading
│   ├── dictation.html
│   ├── grammar.html
│   ├── kanji.html
│   ├── phoneme-trainer.html      ← kana drills + shadowing
│   ├── study-plan.html
│   ├── manifest.webmanifest, sw.js, icon-*.png  ← PWA
│   ├── data/
│   │   ├── vocab-n5n4.json
│   │   ├── grammar-n5n4.json
│   │   ├── kanji-n5n4.json
│   │   └── phrases-tourist.json
│   ├── js/
│   │   ├── gemini.js             ← shared /api/gemini client
│   │   ├── quiz-card.js
│   │   └── srs.js
│   └── functions/api/            ← Cloudflare Pages Functions (serverless)
│       ├── tts.js                ← TTS proxy (Cloud TTS + Gemini TTS)
│       ├── stt.js                ← STT proxy (Gemini 2.0 Flash)
│       └── gemini.js             ← text-gen proxy (Gemini 2.5 Flash)
├── prompt-reference.md           ← product spec / learner notes
└── CLAUDE.md                     ← this file
```

Only `output/` is a git repo — that's the deploy root. The parent
`japanese/` dir is not versioned.

## Deploy model

- Remote: `github.com/sauwingwong/japanese-tools.git` (branch `master`)
- Push to `master` → Cloudflare Pages auto-builds and deploys in ~30–60 s
- No build step; static files + Pages Functions
- Deploy gating: **none**. A push equals a prod release.

## Env vars (Cloudflare Pages → Settings → Environment variables)

| Name | Used by | Notes |
|---|---|---|
| `CLOUD_TTS_API_KEY` | `functions/api/tts.js` | Google Cloud TTS (Chirp3-HD-Leda) — default ▶ Play |
| `GEMINI_API_KEY`    | `functions/api/tts.js`, `stt.js`, `gemini.js` | Gemini TTS (Rich), STT, text-gen |

Never write values to disk or commits. If user says "the key is set"
they mean they already pasted it into the CF Pages UI.

## API surface (all under `/api/`, same origin)

| Endpoint | Default model | Purpose |
|---|---|---|
| `POST /api/tts`    | `cloud-ja-chirp3-hd-leda` | ▶ Play. Also accepts `gemini-3.1-flash-tts-preview` (Rich ✨) and legacy `gemini-2.5-flash-preview-tts`. Returns `{ audio: <base64 16-bit LE PCM, 24 kHz mono> }`. Cloud TTS WAV header stripped server-side so the client's raw-PCM decode path works for both providers. |
| `POST /api/stt`    | `gemini-2.0-flash`        | Mobile STT fallback (iOS Safari has no Web Speech API). Body `{ audio: base64, mimeType }`. Returns `{ transcript }`. |
| `POST /api/gemini` | `gemini-2.5-flash`        | Generic text-gen (grammar drills, explanations). Supports schema-constrained JSON responses. |

All three behind CF Access. Clients must send `credentials: 'include'`
or a 302 to the Access login page breaks JSON parsing.

## Speech recognition routing

- **Desktop Chrome / Edge:** Web Speech API (free, Google backend).
- **iPhone Chrome:** WebKit under the hood → no Web Speech API → falls
  back to `/api/stt` (Gemini 2.0 Flash). Cost ≈ $0.0001 per press.
- **iOS PWA:** same as iPhone Chrome — Gemini STT path.

## iOS PWA landmines — already fixed, keep the patterns

Shipped in commit `586b9a3` (listening-quiz.html, phrases.html,
dictation.html, grammar.html, kanji.html, phoneme-trainer.html,
js/gemini.js). When adding new pages or new audio code, keep these
patterns:

### 1. AudioContext rebuild on dead states

iOS suspends the `AudioContext` when the PWA is backgrounded and
sometimes leaves it in `interrupted` or `closed` state that `resume()`
cannot recover. Always detect and rebuild:

```js
let _ctx, _currentSource;
function _getCtx() {
  const dead = !_ctx || _ctx.state === 'closed' || _ctx.state === 'interrupted';
  if (dead) {
    try { _ctx?.close(); } catch {}
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_ctx.state === 'suspended') { try { _ctx.resume(); } catch {} }
  return _ctx;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _getCtx();
});
window.addEventListener('pagehide', () => {
  try { _currentSource?.stop(); } catch {}
  try { _ctx?.close(); } catch {}
});
```

And wrap `src.start()` in try/catch with one rebuild-and-retry.

### 2. MediaRecorder mimeType — `audio/mp4` first

iOS only supports `audio/mp4`. Array order matters because the code
picks the first supported type:

```js
const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac'];
```

### 3. `credentials: 'include'` on every `/api/*` fetch

Without it, expired CF Access session → silent 302 to Google login →
`Unexpected token '<'` in JSON.parse. With it, the browser surfaces
the redirect so existing content-type guard code shows the "Auth
session expired — reload" toast.

### 4. Safe-area side inset on bottom tab bar

iPhone rounded corners clip tabs. `env(safe-area-inset-left/right)`
is 0 in portrait, so use `max()`:

```css
.nav-tabs, .tabbar-mobile {
  padding-left:  max(30px, env(safe-area-inset-left));
  padding-right: max(30px, env(safe-area-inset-right));
}
```

30px was the floor that finally got all 7 tabs clear on iPhone.
(Was 22px; bumped after the user still found the edges too close.)

## Nav bars — desktop top + mobile bottom

Two nav strips per tool page; same 7 links, same order. Classes
differ for historical reasons but are unified via media queries.

- `.nav-desktop` — horizontal top bar under the red header. Hidden
  below 900 px, shown at ≥900 px. (900 px breakpoint chosen so
  iPad portrait ≈820 px still gets the mobile bar, while split
  landscape ≥1180 px gets the desktop bar.)
- `.nav-tabs` / `.tabbar-mobile` — fixed bottom grid. Shown at
  <900 px, hidden at ≥900 px via
  `{ display: none !important; }` inside the desktop media block.

Nav-link order is fixed; see any tool page for the canonical markup.
Changing any nav link currently requires editing **7 HTML files**.
See "Known deferred work" — shared-nav extraction is the next
change that should precede another nav edit.

## Japanese grader normalisation

`listening-quiz.html` and `phrases.html` define `cleanJP()` +
`normalizeJaDigits()` + `JA_DIGIT_TABLE` so the grader accepts arabic
(`6月`), full-width (`６月`), and kanji (`六月`) forms against a
hiragana expected (`ろくがつ`).

Table covers months 1–12, hours 1–12, days-of-month 1–31, with
irregulars: しがつ=4月, しちがつ=7月, くがつ=9月, よじ=4時, しちじ=7時,
くじ=9時, ついたち=1日, ふつか=2日, みっか=3日, よっか=4日, いつか=5日,
むいか=6日, なのか=7日, ようか=8日, ここのか=9日, とおか=10日,
じゅうよっか=14日, はつか=20日, にじゅうよっか=24日.

When extending: add entries to `JA_DIGIT_TABLE` only, the rest flows.

## Known deferred work (don't let it rot)

- **Shared-code extraction.** `_getCtx`, `speak`, `cleanJP`,
  `srCompare`, `recordAndTranscribe`, `JA_DIGIT_TABLE` are duplicated
  across 5–7 HTML files. Target: `output/js/audio.js` and
  `output/js/grade-ja.js`. Deferred after iOS hardening shipped — any
  future change to these helpers has to touch every file until
  extracted.

## Session-start checklist

1. `cd output && git log --oneline -10` to see what's recent.
2. Read this file + `prompt-reference.md` for product context.
3. For iOS-specific issues: trust the patterns above, reproduce on
   iPhone PWA (user has one), not desktop Safari (behaves differently).
4. For audio/grader bugs: check digit table and `cleanJP` first.
5. If user says "the key is set" — don't ask for its value, just deploy.

## Conventions

- Commit messages: short imperative subject, optional body. Examples
  from history: `iOS PWA hardening: grader, audio, mimeType, auth, cleanup`,
  `UI: bump bottom-tab side inset to 22px`, `TTS: Google Cloud TTS (Chirp3-HD-Leda) as default for ▶ Play`.
- `git add -u` is fine here (user approves; no secrets in working tree).
- User approves deploys explicitly ("ok to deploy?"). Don't push on
  own initiative unless asked.
