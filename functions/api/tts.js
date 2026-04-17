// Cloudflare Pages Function — Gemini TTS proxy
// Keeps GEMINI_API_KEY server-side (set as a Pages environment secret).
//
// Model: gemini-3.1-flash-tts-preview (upgraded 2026-04-17 after enabling paid tier)
// Fall back to 'gemini-2.5-flash-preview-tts' if 3.1 throws quota errors.
//
// Returns: { audio: <base64 PCM string> }
// Audio spec: 16-bit signed PCM, 24 kHz, mono

const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`;

// Voice to use. Kore = calm female, good for Japanese.
// Other options: Aoede, Charon, Fenrir, Puck — all support 70+ languages.
const VOICE = 'Kore';

export async function onRequestPost(context) {
  // ── CORS preflight (handled by onRequestOptions below) ──
  const apiKey = context.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  let text;
  try {
    ({ text } = await context.request.json());
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!text) return Response.json({ error: 'Missing text' }, { status: 400 });

  const geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
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
