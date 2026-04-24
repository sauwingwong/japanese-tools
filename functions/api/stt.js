// Cloudflare Pages Function — Gemini STT proxy for mobile devices
// Accepts: POST { audio: <base64>, mimeType: "audio/mp4" | "audio/webm" | ... }
// Returns: { transcript: <string> }
// Used when Web Speech API is unavailable (iOS Safari, Firefox, etc.)

const MODEL = 'gemini-2.0-flash';

export async function onRequestPost(context) {
  const apiKey = context.env.GEMINI_API_KEY;
  if (!apiKey) return Response.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });

  let audio, mimeType;
  try {
    ({ audio, mimeType } = await context.request.json());
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!audio) return Response.json({ error: 'Missing audio' }, { status: 400 });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(`${endpoint}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'Transcribe this Japanese audio. Output ONLY hiragana (ひらがな) — convert any kanji or katakana the speaker pronounces into their hiragana reading. Loan words normally written in katakana should also be output as hiragana. No explanation, no translation, no punctuation unless it appears naturally in speech.' },
          { inlineData: { mimeType: mimeType || 'audio/webm', data: audio } }
        ]
      }],
      generationConfig: { temperature: 0 }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    return Response.json({ error: `Gemini error: ${res.status}`, detail: err }, { status: 502 });
  }

  const data = await res.json();
  const transcript = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return Response.json({ transcript }, {
    headers: { 'Access-Control-Allow-Origin': '*' }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
