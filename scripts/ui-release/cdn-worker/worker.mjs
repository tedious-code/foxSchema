/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Serves the UI release bucket (R2, binding BUCKET) read-only on workers.dev,
 * so it needs no domain of its own. Deployed once with wrangler; see
 * docs/guides/publish.md. Workers Caching (wrangler.jsonc) answers repeat
 * requests from Cloudflare's cache using the Cache-Control each object was
 * uploaded with, so most requests never reach R2.
 *
 * Only the three kinds of object a release publishes are served. Everything
 * else is a 404, so nothing else that ever lands in the bucket is exposed.
 * Integrity does not depend on this Worker: backends verify the signatures
 * and hashes themselves.
 */

const SERVED = /^(?:channels\/stable\.json|releases\/[0-9A-Za-z][0-9A-Za-z.-]{0,63}\/manifest\.json|packs\/[0-9a-f]{64})$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGNUP_PREFIX = 'signups/by-email/';
const MAX_SIGNUP_BODY_BYTES = 4096;

/** Used only when an object was uploaded without Cache-Control. */
const FALLBACK_CACHE_CONTROL = 'public, max-age=60';

function plain(status, text, extra = {}) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

function constantTimeEquals(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a ?? ''));
  const bb = enc.encode(String(b ?? ''));
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab.at(i) ?? 0) ^ (bb.at(i) ?? 0);
  }
  return diff === 0;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readSignupRecord(bucket, objectKey) {
  if (!bucket || typeof bucket.get !== 'function') return null;
  const existing = await bucket.get(objectKey);
  if (!existing || !existing.body) return null;
  try {
    const raw = await new Response(existing.body).text();
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function persistSignup(env, { email, source }) {
  const now = new Date().toISOString();
  const bucket = env?.SIGNUP_BUCKET ?? env?.BUCKET;
  let stored = false;

  if (env?.SIGNUP_DB) {
    await env.SIGNUP_DB.prepare(
      'CREATE TABLE IF NOT EXISTS email_signups (email TEXT PRIMARY KEY, source TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1)'
    ).run();
    await env.SIGNUP_DB.prepare(
      'INSERT INTO email_signups (email, source, first_seen_at, last_seen_at, count) VALUES (?, ?, ?, ?, 1) ' +
        'ON CONFLICT(email) DO UPDATE SET source = excluded.source, last_seen_at = excluded.last_seen_at, count = email_signups.count + 1'
    )
      .bind(email, source, now, now)
      .run();
    stored = true;
  }

  if (env?.SIGNUPS_KV) {
    const kvKey = `signup:${email}`;
    const prevRaw = await env.SIGNUPS_KV.get(kvKey);
    let prev = null;
    if (prevRaw) {
      try {
        prev = JSON.parse(prevRaw);
      } catch {
        prev = null;
      }
    }
    const next = {
      email,
      source,
      firstSeenAt: typeof prev?.firstSeenAt === 'string' ? prev.firstSeenAt : now,
      lastSeenAt: now,
      count: typeof prev?.count === 'number' ? prev.count + 1 : 1,
    };
    await env.SIGNUPS_KV.put(kvKey, JSON.stringify(next));
    stored = true;
  }

  if (bucket && typeof bucket.put === 'function') {
    const key = `${SIGNUP_PREFIX}${await sha256Hex(email)}.json`;
    const prev = await readSignupRecord(bucket, key);
    const next = {
      email,
      source,
      firstSeenAt: typeof prev?.firstSeenAt === 'string' ? prev.firstSeenAt : now,
      lastSeenAt: now,
      count: typeof prev?.count === 'number' ? prev.count + 1 : 1,
    };
    await bucket.put(key, JSON.stringify(next), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
    stored = true;
  }

  return stored;
}

async function handleSignupPost(request, env) {
  if (env?.SIGNUP_WEBHOOK_SECRET) {
    const supplied = request.headers.get('x-foxschema-signup-secret') ?? '';
    if (!constantTimeEquals(env.SIGNUP_WEBHOOK_SECRET, supplied)) {
      return json(403, { ok: false, error: 'Forbidden' });
    }
  }
  const text = await request.text();
  if (text.length > MAX_SIGNUP_BODY_BYTES) {
    return json(413, { ok: false, error: 'Payload too large' });
  }
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json(400, { ok: false, error: 'Enter a valid email address.' });
  }
  const source = body?.source === 'cli' ? 'cli' : 'web';
  const stored = await persistSignup(env, { email, source });
  if (!stored) {
    return json(503, { ok: false, error: 'Signup storage is not configured on this worker.' });
  }
  return json(200, { ok: true, stored: true });
}

async function handleSignupsExport(request, env) {
  const adminToken = typeof env?.SIGNUP_ADMIN_TOKEN === 'string' ? env.SIGNUP_ADMIN_TOKEN : '';
  if (!adminToken) return plain(404, 'Not found');

  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const headerToken = request.headers.get('x-foxschema-admin-token') ?? '';
  if (!constantTimeEquals(adminToken, bearer || headerToken)) {
    return json(403, { ok: false, error: 'Forbidden' });
  }

  if (env?.SIGNUP_DB) {
    const result = await env.SIGNUP_DB.prepare(
      'SELECT email, source, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, count FROM email_signups ORDER BY last_seen_at DESC LIMIT 1000'
    ).all();
    return json(200, { ok: true, signups: result?.results ?? [] });
  }

  const bucket = env?.SIGNUP_BUCKET ?? env?.BUCKET;
  if (!bucket || typeof bucket.list !== 'function') {
    return json(200, { ok: true, signups: [] });
  }
  const signups = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: SIGNUP_PREFIX, cursor, limit: 100 });
    for (const obj of page?.objects ?? []) {
      const record = await readSignupRecord(bucket, obj.key);
      if (record) signups.push(record);
    }
    cursor = page?.truncated ? page.cursor : undefined;
  } while (cursor && signups.length < 1000);
  signups.sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')));
  return json(200, { ok: true, signups });
}

function headersFor(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  if (!headers.has('cache-control')) headers.set('cache-control', FALLBACK_CACHE_CONTROL);
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

export default {
  async fetch(request, env) {
    let key;
    try {
      key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch {
      return plain(404, 'Not found'); // a malformed %-escape
    }

    if (key === 'signup' || key === 'api/signup') {
      if (request.method === 'POST') return handleSignupPost(request, env);
      return plain(405, 'Method not allowed', { allow: 'POST' });
    }
    if (key === 'api/signups') {
      if (request.method === 'GET') return handleSignupsExport(request, env);
      return plain(405, 'Method not allowed', { allow: 'GET' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'Method not allowed', { allow: 'GET, HEAD' });
    }
    if (!SERVED.test(key)) return plain(404, 'Not found');

    if (request.method === 'HEAD') {
      const object = await env.BUCKET.head(key);
      if (!object) return plain(404, 'Not found');
      return new Response(null, { headers: headersFor(object) });
    }

    // onlyIf: an If-None-Match that still matches returns the object without
    // a body, which is a 304 for the caller.
    const object = await env.BUCKET.get(key, { onlyIf: request.headers });
    if (!object) return plain(404, 'Not found');
    if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers: headersFor(object) });
    return new Response(object.body, { headers: headersFor(object) });
  },
};
