// Cloudflare Pages Function — Gemini TTS proxy
// Keeps GEMINI_API_KEY server-side (set as a Pages environment secret).
//
// Model: gemini-3.1-flash-tts-preview (upgraded 2026-04-17 after enabling paid tier)
// Fall back to 'gemini-2.5-flash-preview-tts' if 3.1 throws quota errors.
//
// Returns: { audio: <base64 PCM string> }
// Audio spec: 16-bit signed PCM, 24 kHz, mono

// Default to 2.5 ("quick"): ~30% faster than 3.1 and naturally neutral, which
// fits drill-style replay where the same word gets pressed many times. 3.1
// ("rich") stays available via an explicit `model` on the request for when
// the user wants a richer rendition (invoked by a sparkle button in the UI).
const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
// Models the client is allowed to request via the optional `model` field.
const ALLOWED_MODELS = new Set([
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
]);

// Voice to use. Kore = calm female, good for Japanese.
// Other options: Aoede, Charon, Fenrir, Puck — all support 70+ languages.
const VOICE = 'Kore';

// Pedagogical style prompt prepended to the TTS input. Gemini 3.1 TTS is a
// conversational model that otherwise adds varying prosody / emotion / filler
// intonation on each generation — unhelpful when the same word should sound
// the same every replay. The model extracts this hint and does NOT read it
// aloud (Gemini TTS behaviour: "Say ...: <text>" is a recognised style frame).
const STYLE_PREFIX =
  'Say the following Japanese clearly and calmly, at a steady learning pace, ' +
  'with neutral pedagogical intonation, no emotion, no filler sounds: ';

// Tone-fixing cache. Same (text, model, voice, style) → same audio bytes on
// every replay, which eliminates the "different tone every press" problem.
// We reuse Cloudflare's edge cache (caches.default) keyed by a synthetic GET
// URL. TTL long: pronunciations don't churn. Cache miss regenerates fresh.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
// Bump this to invalidate all previously-cached audio. Prior 2.5 entries
// returned empty/short audio for some keys (earlier model-default churn),
// which manifested as silent ▶ playback on some Tourist Phrases rows.
const CACHE_VERSION = 'v3';

async function sha1Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  // ── CORS preflight (handled by onRequestOptions below) ──
  const apiKey = context.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  let text, model;
  try {
    ({ text, model } = await context.request.json());
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!text) return Response.json({ error: 'Missing text' }, { status: 400 });

  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${chosenModel}:generateContent`;

  // Both 2.5 and 3.1 TTS models hang (→ Cloudflare edge 502) on very short input
  // like a single kana. Pad to give the model enough context to synthesise quickly.
  // The trailing period adds ~a comma-length pause without altering the kana sound.
  const rawText = text.trim().length <= 2 ? `${text}。` : text;
  // Style prefix only on 3.1 — 2.5 rejects the English "Say …:" frame with
  // upstream 502s on some inputs.
  const ttsText = chosenModel === 'gemini-3.1-flash-tts-preview'
    ? STYLE_PREFIX + rawText
    : rawText;

  // ── Edge cache lookup ── Hash the final payload so a change to the style
  // prefix or voice invalidates old entries automatically.
  const cacheKeyStr = `${CACHE_VERSION}|${chosenModel}|${VOICE}|${ttsText}`;
  const cacheKeyHash = await sha1Hex(cacheKeyStr);
  const cacheReq = new Request(
    `https://tts-cache.internal/${chosenModel}/${VOICE}/${cacheKeyHash}`,
    { method: 'GET' }
  );
  const edgeCache = caches.default;
  const cached = await edgeCache.match(cacheReq);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        ...Object.fromEntries(cached.headers),
        'X-TTS-Cache': 'hit',
      },
    });
  }

  // One attempt against a given model. Returns { audio } on success, or
  // { error, status } on failure. Never throws.
  async function callGemini(modelName, inputText) {
    const upstreamAbort = new AbortController();
    const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 20000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: upstreamAbort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: inputText }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } }
            }
          }
        })
      });
      clearTimeout(upstreamTimer);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return { error: `HTTP ${res.status}`, detail: errBody, status: res.status };
      }
      const json = await res.json();
      const audio = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audio) return { error: 'No audio in response', status: 502 };
      return { audio };
    } catch (e) {
      clearTimeout(upstreamTimer);
      return { error: e.name === 'AbortError' ? 'Upstream timeout' : e.message, status: 504 };
    }
  }

  // Primary call against the requested/default model.
  let result = await callGemini(chosenModel, ttsText);

  // Fallback: if the user got 2.5 (quick) and it failed, retry once on 3.1.
  // 2.5 flash-preview-tts occasionally 502s on specific short hiragana
  // phrases; 3.1 handles them fine. We cache the result under the 2.5 key so
  // subsequent presses are instant and consistent.
  if (result.error && chosenModel === 'gemini-2.5-flash-preview-tts') {
    const fallbackText = STYLE_PREFIX + rawText; // 3.1 wants the style frame
    const fb = await callGemini('gemini-3.1-flash-tts-preview', fallbackText);
    if (fb.audio) result = fb;
  }

  if (result.error) {
    return Response.json(
      { error: `Gemini upstream: ${result.error}`, detail: result.detail },
      { status: result.status || 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
  const audioB64 = result.audio;

  const resp = Response.json({ audio: audioB64 }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      // Allow Cloudflare's edge cache to store this response for 30 days.
      // Same-text replays across all users hit this cache and return
      // identical audio bytes — which is exactly the "fix the tone" behaviour.
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
      'X-TTS-Cache': 'miss',
    }
  });
  // Fire-and-forget put into edge cache. Clone because Response bodies are
  // one-shot streams.
  context.waitUntil(edgeCache.put(cacheReq, resp.clone()));
  return resp;
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
