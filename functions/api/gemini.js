// Cloudflare Pages Function — Gemini text-generation proxy.
// Keeps GEMINI_API_KEY server-side (set as a Pages environment secret).
//
// Same-shape twin of functions/api/tts.js:
//   - 20s upstream AbortController → clean JSON 504 on hang
//   - Model allow-list
//   - CORS
//
// Body: { prompt: string, schema?: object, temperature?: number, model?: string }
// Returns: { text: string }  — if schema passed, `text` is parsed JSON object.

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
]);

export async function onRequestPost(context) {
  const apiKey = context.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
  }

  let prompt, schema, temperature, model;
  try {
    ({ prompt, schema, temperature, model } = await context.request.json());
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!prompt || typeof prompt !== 'string') {
    return Response.json({ error: 'Missing prompt' }, { status: 400 });
  }

  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${chosenModel}:generateContent`;

  const generationConfig = {};
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (schema && typeof schema === 'object') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }

  const upstreamAbort = new AbortController();
  const upstreamTimer = setTimeout(() => upstreamAbort.abort(), 20000);

  let res;
  try {
    res = await fetch(`${endpoint}?key=${apiKey}`, {
      method: 'POST',
      signal: upstreamAbort.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
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

  if (!res.ok) {
    const err = await res.text();
    return Response.json(
      { error: `Gemini API error: ${res.status}`, detail: err },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof rawText !== 'string') {
    return Response.json(
      { error: 'No text in Gemini response', raw: data },
      { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }

  let text = rawText;
  if (schema) {
    try {
      text = JSON.parse(rawText);
    } catch (e) {
      return Response.json(
        { error: 'Gemini returned invalid JSON', raw: rawText },
        { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
  }

  return Response.json({ text }, {
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
