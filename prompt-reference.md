# Japanese Trainer — Product Reference

Self-hosted Japanese learning PWA at **japanese.sauww.uk** (Cloudflare
Pages, CF Access SSO, installed as iPhone PWA). See `CLAUDE.md` for
engineering memory; this file is the product/learner spec.

## Context (about the learner)

- ~2 years of Duolingo Japanese, but cannot hold casual conversations or follow TV drama
- Knows hiragana and katakana
- Can recognise some spoken words (e.g. 多分、話、聞きます)
- Previously used Anki cards (hiragana, katakana, long vowels, diacritical marks)
- Found TTS audio in Anki unnatural → now uses Google Cloud TTS Chirp3-HD-Leda (natural, consistent) with Gemini 3.1 TTS as a "Rich ✨" expressive alternative

## Two key challenges

1. Pronounce each sound accurately
2. Train listening to common sounds

## Navigation — 7-tab bottom bar (same on every page)

| Tab | File | Purpose |
|---|---|---|
| Home     | `index.html`            | Landing page with links to all tools and study plan |
| Listening | `listening-quiz.html`  | N5/N4 vocab listening drill with spaced repetition |
| Phrases  | `phrases.html`          | Tourist phrases with Practice mode and speech grading |
| Dictation | `dictation.html`       | Hear a sentence → type what you heard |
| Grammar  | `grammar.html`          | N5/N4 grammar drills (Gemini-generated fill-in-the-blank) |
| Kanji    | `kanji.html`            | N5/N4 kanji readings and meanings |
| Phoneme  | `phoneme-trainer.html`  | Kana chart, minimal pairs, pitch accent, shadowing |

---

## Tool — `listening-quiz.html`

**Purpose:** Spaced-repetition listening quiz using N5/N4 core vocabulary (~114 words).

**Features**

- Word played automatically → choose from 4 hiragana options (multiple choice)
- 🐢 Play slower button
- ✨ Rich voice button (Gemini 3.1 expressive TTS) alongside default ▶ Play (Cloud TTS Chirp3-HD-Leda)
- After each answer: shows kanji, English meaning, pitch accent H/L pattern
- Category filter: All / Greetings / Time / Verbs / Adjectives / Nouns
- Spaced repetition: wrong answers reappear ~3× more often
- Streak counter + session summary with review list
- **🎤 Say it aloud** button on every question — speaks and checks pronunciation (non-scoring)
  - Desktop Chrome/Edge: Web Speech API (free)
  - iPhone/Safari/Firefox: falls back to `/api/stt` (Gemini 2.0 Flash)
  - Grader accepts arabic/full-width/kanji digit forms (e.g. `6月` / `６月` / `六月` all match `ろくがつ`)

**Vocabulary coverage**

| Category | Count |
|----------|-------|
| Greetings & social | 15 |
| Time words | 15 |
| Common verbs | 22 |
| Adjectives | 20 |
| Nouns | 35 |

Data source: `data/vocab-n5n4.json`.

---

## Tool — `phrases.html`

**Purpose:** Tourist/travel phrases with a Practice mode that drills pronunciation.

- Curated travel scenarios (airport, restaurant, directions, etc.)
- Each phrase: audio (▶ Play / ✨ Rich) + English gloss + romaji
- Practice mode: 🎤 Say it aloud → Gemini STT transcription → grader scores the match
- Same digit-aware grader as listening-quiz

Data source: `data/phrases-tourist.json`.

---

## Tool — `dictation.html`

**Purpose:** Type what you hear. Shorter sentences using N5/N4 vocab.
Audio via the same TTS stack.

---

## Tool — `grammar.html`

**Purpose:** N5/N4 grammar drills, fill-in-the-blank format. Explanations
generated on demand via `/api/gemini` (Gemini 2.5 Flash) with
schema-constrained JSON responses.

Data source: `data/grammar-n5n4.json`.

---

## Tool — `kanji.html`

**Purpose:** N5/N4 kanji flashcards (reading + meaning).

Data source: `data/kanji-n5n4.json`.

---

## Tool — `phoneme-trainer.html`

**Purpose:** Systematic pronunciation reference and drilling tool.

**Tabs**

| Tab | Content |
|-----|---------|
| Sound Chart | Full clickable kana table (basic, voiced, combo) — click to hear |
| Long Vowels | 6 minimal pairs (e.g. おじさん vs おじいさん) + quick quiz mode |
| Double っ | 5 minimal pairs with visual mora beat boxes showing the silent pause |
| ら行 R-Sounds | All 5 ら行 sounds + tongue-position tip + practice words |
| Pitch Accent | Famous minimal pairs (あめ rain vs candy, はし bridge vs chopsticks) + 13 common N5 words with H/L visual blocks |
| Practice | Random kana played → click correct character → score tracked |
| Shadowing 🎤 | Hear a word → speak it → mic compares and scores your pronunciation |

---

## Audio & speech stack

| Feature | Desktop Chrome/Edge | iPhone (Safari / PWA / Chrome) |
|---|---|---|
| ▶ Play (default) | `/api/tts` → Google Cloud TTS Chirp3-HD-Leda | same |
| ✨ Rich | `/api/tts` → Gemini 3.1 Flash TTS | same |
| 🎤 Say it aloud — STT | Web Speech API (free, Google backend) | `/api/stt` → Gemini 2.0 Flash (~$0.0001/press) |
| Grammar explanations | `/api/gemini` → Gemini 2.5 Flash | same |

All behind Cloudflare Access SSO. Same-origin fetches with
`credentials: 'include'`.

---

## PWA

- `manifest.webmanifest` + `sw.js` — installable on iPhone home screen
- Works offline for cached HTML + data JSON; audio/STT/grammar need network
- Safe-area insets: `max(22px, env(safe-area-inset-*))` so bottom tabs clear iPhone rounded corners

---

## Technical notes

- Pure HTML/CSS/JS — one file per page, no build step
- Hosted on Cloudflare Pages; backend is Pages Functions in `output/functions/api/`
- Cloud TTS default because it's free (4M chars/month), fast (~100–300 ms), and consistent (same input → same output)
- Gemini TTS kept as "Rich ✨" for expressive variety but is slower and costs per call
- See `CLAUDE.md` for env vars, iOS pitfalls, and engineering conventions

---

## Recommended supplements

| Resource | Purpose |
|----------|---------|
| **Comprehensible Japanese** (YouTube) | Graded listening input |
| **NHK Web Easy** (nhk.or.jp/news/easy) | Real Japanese with audio, simplified text |
| **Forvo** (forvo.com) | Human recordings of individual words |
| **OJAD** (ojad.eng.hokudai.ac.jp) | Definitive pitch accent dictionary |
| **Shadowing: Let's Speak Japanese** (book+audio) | Best exercise to close the gap to natural speech |
