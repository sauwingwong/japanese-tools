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
  const ttsText = text.trim().length <= 2 ? `${text}。` : text;

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

  return Response.json({ audio: audioB64 }, {
    headers: { 'Access-Control-Allow-Origin': '*' }
  });
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
