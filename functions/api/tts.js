// Cloudflare Pages Function — Gemini TTS proxy
// Keeps GEMINI_API_KEY server-side (set as a Pages environment secret).
//
// Model: gemini-3.1-flash-tts-preview (upgraded 2026-04-17 after enabling paid tier)
// Fall back to 'gemini-2.5-flash-preview-tts' if 3.1 throws quota errors.
//
// Returns: { audio: <base64 PCM string> }
// Audio spec: 16-bit signed PCM, 24 kHz, mono

const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
// Models the client is allowed to request via the optional `model` field.
// 2.5 is kept available for isolated mora playback (single kana) where 3.1's
// conversational prosody adds unwanted emotion / filler-word intonation.
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
  // Prepend the pedagogical style instruction. 2.5 TTS is less conversational
  // and doesn't need it — applying only on 3.1 keeps 2.5 output unchanged for
  // single-kana playback paths that deliberately pick 2.5 for neutrality.
  const ttsText = chosenModel === 'gemini-3.1-flash-tts-preview'
    ? STYLE_PREFIX + rawText
    : rawText;

  // ── Edge cache lookup ── Hash the final payload so a change to the style
  // prefix or voice invalidates old entries automatically.
  const cacheKeyStr = `${chosenModel}|${VOICE}|${ttsText}`;
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

  // Abort the upstream call if Gemini hangs, so we return control to the client
  // with a clean JSON error instead of getting killed by Cloudflare's edge timeout.
  const upstreamAbort = new AbortController();
  const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 20000);

  let geminiRes;
  try {
    geminiRes = await fetch(`${endpoint}?key=${apiKey}`, {
      method: 'POST',
      signal: upstreamAbort.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: ttsText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: VOICE }
            }
          }
        }
      })
    });
  } catch (e) {
    clearTimeout(upstreamTimer);
    const aborted = e.name === 'AbortError';
    return Response.json(
      { error: aborted ? 'Gemini upstream timed out' : `Gemini upstream error: ${e.message}` },
      { status: 504, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
  clearTimeout(upstreamTimer);

  if (!geminiRes.ok) {
    const err = await geminiRes.text();
    return Response.json({ error: `Gemini API error: ${geminiRes.status}`, detail: err }, { status: 502 });
  }

  const data = await geminiRes.json();
  const audioB64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audioB64) {
    return Response.json({ error: 'No audio in Gemini response', raw: data }, { status: 502 });
  }

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
