// Cloudflare Pages Function — SRS state sync proxy (Supabase).
//
// Scopes all rows by the CF Access authenticated email header so the
// two users of this deploy can't see each other's state without any
// Supabase-side auth wiring.
//
// Env vars (Pages → Settings → Environment variables):
//   SUPABASE_URL                e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service_role / secret key (server only)
//
// Table schema (run once in the Supabase SQL editor):
//   create table srs_state (
//     owner_email text not null,
//     namespace   text not null,
//     data        jsonb not null,
//     updated_at  timestamptz not null default now(),
//     primary key (owner_email, namespace)
//   );
//
// API:
//   GET  /api/srs?ns=<namespace>
//     → { data: {...} | null, updated_at: <iso> | null }
//   PUT  /api/srs
//     body: { namespace: string, data: object, updated_at?: <iso> }
//     → { ok: true, updated_at: <iso> }
//
// The client sends its local `updated_at`; the server preserves it on
// the row so downstream GETs from another device can LWW-compare.
// If omitted, server uses now().
//
// Fail soft: when env vars are unset, returns 501 with a stable body so
// the SRS module knows to stay in localStorage-only mode without
// spamming errors.

function emailOf(request) {
  // CF Access injects this header on authenticated requests.
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  return email && email.trim() ? email.trim().toLowerCase() : null;
}

function supabaseHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

function missingEnv(env) {
  return !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function onRequestGet({ request, env }) {
  if (missingEnv(env)) {
    return Response.json({ error: 'sync disabled' }, { status: 501 });
  }
  const email = emailOf(request);
  if (!email) return Response.json({ error: 'no identity' }, { status: 401 });

  const url = new URL(request.url);
  const ns = url.searchParams.get('ns');
  if (!ns) return Response.json({ error: 'missing ns' }, { status: 400 });

  const q = `${env.SUPABASE_URL}/rest/v1/srs_state`
    + `?select=data,updated_at`
    + `&owner_email=eq.${encodeURIComponent(email)}`
    + `&namespace=eq.${encodeURIComponent(ns)}`
    + `&limit=1`;

  let res;
  try {
    res = await fetch(q, { headers: supabaseHeaders(env) });
  } catch (e) {
    return Response.json({ error: `supabase unreachable: ${e.message}` }, { status: 502 });
  }
  if (!res.ok) {
    const detail = await res.text();
    return Response.json({ error: 'supabase error', status: res.status, detail }, { status: 502 });
  }
  const rows = await res.json();
  if (!rows.length) return Response.json({ data: null, updated_at: null });
  return Response.json({ data: rows[0].data, updated_at: rows[0].updated_at });
}

export async function onRequestPut({ request, env }) {
  if (missingEnv(env)) {
    return Response.json({ error: 'sync disabled' }, { status: 501 });
  }
  const email = emailOf(request);
  if (!email) return Response.json({ error: 'no identity' }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const { namespace, data, updated_at } = body || {};
  if (!namespace || typeof namespace !== 'string') {
    return Response.json({ error: 'missing namespace' }, { status: 400 });
  }
  if (!data || typeof data !== 'object') {
    return Response.json({ error: 'missing data' }, { status: 400 });
  }

  const stamp = updated_at || new Date().toISOString();
  const row = {
    owner_email: email,
    namespace,
    data,
    updated_at: stamp,
  };

  // PostgREST upsert via Prefer: resolution=merge-duplicates.
  const url = `${env.SUPABASE_URL}/rest/v1/srs_state?on_conflict=owner_email,namespace`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...supabaseHeaders(env),
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    return Response.json({ error: `supabase unreachable: ${e.message}` }, { status: 502 });
  }
  if (!res.ok) {
    const detail = await res.text();
    return Response.json({ error: 'supabase error', status: res.status, detail }, { status: 502 });
  }
  return Response.json({ ok: true, updated_at: stamp });
}
