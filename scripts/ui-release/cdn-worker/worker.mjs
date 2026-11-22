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

/** Used only when an object was uploaded without Cache-Control. */
const FALLBACK_CACHE_CONTROL = 'public, max-age=60';

function plain(status, text, extra = {}) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
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
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'Method not allowed', { allow: 'GET, HEAD' });
    }
    let key;
    try {
      key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch {
      return plain(404, 'Not found'); // a malformed %-escape
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
