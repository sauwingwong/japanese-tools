// Cloudflare Pages Function — TTS proxy (Google Cloud TTS + Gemini)
//
// Two providers, routed by `model` field:
//   - cloud-ja-chirp3-hd-leda (default): Google Cloud Text-to-Speech
//     Chirp3 HD — fast (~100–300 ms), high free quota (4M chars/month),
//     consistent neutral tone. Used for ▶ Play.
//   - gemini-3.1-flash-tts-preview: Gemini expressive TTS, used for ✨ Rich.
//   - gemini-2.5-flash-preview-tts: legacy, still accepted.
//
// Env vars:
//   CLOUD_TTS_API_KEY — for texttospeech.googleapis.com (Chirp3)
//   GEMINI_API_KEY    — for generativelanguage.googleapis.com (Gemini TTS)
//
// Returns: { audio: <base64 PCM string> }
// Audio spec: 16-bit signed little-endian PCM, 24 kHz, mono
// (Cloud TTS WAV header is stripped server-side so the client's raw-PCM
// decode path works for both providers without branching.)

const DEFAULT_MODEL = 'cloud-ja-chirp3-hd-leda';
const ALLOWED_MODELS = new Set([
  'cloud-ja-chirp3-hd-leda',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
]);

// Gemini voice. Kore = calm female, good for Japanese.
const VOICE = 'Kore';
// Cloud TTS voice — full Google voice name.
const CLOUD_VOICE = 'ja-JP-Chirp3-HD-Leda';

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
const CACHE_VERSION = 'v4';

async function sha1Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Strip RIFF/WAV header from base64-encoded LINEAR16 audio returned by
// Google Cloud TTS so the client can treat the payload as raw 16-bit PCM
// exactly like the Gemini TTS output.
function stripWavHeader(b64) {
  const bin = atob(b64);
  if (!bin.startsWith('RIFF')) return b64; // already raw PCM
  const dataIdx = bin.indexOf('data');
  const pcmStart = dataIdx >= 0 ? dataIdx + 8 : 44;
  const pcm = bin.substring(pcmStart);
  // Re-encode to base64. btoa handles binary strings fine.
  return btoa(pcm);
}

export async function onRequestPost(context) {
  const geminiKey = context.env.GEMINI_API_KEY;
  const cloudKey = context.env.CLOUD_TTS_API_KEY;

  let text, model;
  try {
    ({ text, model } = await context.request.json());
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!text) return Response.json({ error: 'Missing text' }, { status: 400 });

  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const isCloud = chosenModel.startsWith('cloud-');

  // Short-text padding — Gemini TTS hangs on single-kana inputs. Harmless
  // for Cloud TTS too, so apply uniformly.
  const rawText = text.trim().length <= 2 ? `${text}。` : text;
  // Style prefix only on Gemini 3.1.
  const ttsText = chosenModel === 'gemini-3.1-flash-tts-preview'
    ? STYLE_PREFIX + rawText
    : rawText;

  // Per-provider required key check.
  if (isCloud && !cloudKey) {
    return Response.json({ error: 'CLOUD_TTS_API_KEY not configured' }, { status: 500 });
  }
  if (!isCloud && !geminiKey) {
    return Response.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  // Cache key includes model + voice; the hash ensures distinct providers
  // never collide. Same-text replays return identical bytes.
  const voiceForKey = isCloud ? CLOUD_VOICE : VOICE;
  const cacheKeyStr = `${CACHE_VERSION}|${chosenModel}|${voiceForKey}|${ttsText}`;
  const cacheKeyHash = await sha1Hex(cacheKeyStr);
  const cacheReq = new Request(
    `https://tts-cache.internal/${chosenModel}/${voiceForKey}/${cacheKeyHash}`,
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

  // ── Provider: Google Cloud TTS (Chirp3 HD) ──
  async function callCloud(inputText) {
    const upstreamAbort = new AbortController();
    const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 20000);
    try {
      const res = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${cloudKey}`,
        {
          method: 'POST',
          signal: upstreamAbort.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { text: inputText },
            voice: { languageCode: 'ja-JP', name: CLOUD_VOICE },
            audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 }
          })
        }
      );
      clearTimeout(upstreamTimer);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return { error: `HTTP ${res.status}`, detail: errBody, status: res.status };
      }
      const json = await res.json();
      const audioWav = json?.audioContent;
      if (!audioWav) return { error: 'No audioContent in response', status: 502 };
      return { audio: stripWavHeader(audioWav) };
    } catch (e) {
      clearTimeout(upstreamTimer);
      return { error: e.name === 'AbortError' ? 'Upstream timeout' : e.message, status: 504 };
    }
  }

  // ── Provider: Gemini TTS (2.5 or 3.1) ──
  async function callGemini(modelName, inputText) {
    const upstreamAbort = new AbortController();
    const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 20000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`;
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

  // Dispatch to the right provider.
  let result;
  if (isCloud) {
    result = await callCloud(rawText);
  } else {
    result = await callGemini(chosenModel, ttsText);
    // Gemini 2.5 (legacy) occasionally 502s on short hiragana — retry on 3.1.
    if (result.error && chosenModel === 'gemini-2.5-flash-preview-tts') {
      const fb = await callGemini('gemini-3.1-flash-tts-preview', STYLE_PREFIX + rawText);
      if (fb.audio) result = fb;
    }
  }

  if (result.error) {
    return Response.json(
      { error: `Upstream ${isCloud ? 'Cloud TTS' : 'Gemini'}: ${result.error}`, detail: result.detail },
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
