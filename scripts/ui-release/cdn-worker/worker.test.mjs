/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import worker from './worker.mjs';

const PACK = `packs/${'a'.repeat(64)}`;

/** A stand-in for the R2 binding: just enough of get/head for the Worker. */
function bucket(objects) {
  const seen = [];
  const objectFor = (key, withBody) => {
    const stored = objects[key];
    if (!stored) return null;
    const object = {
      httpEtag: `"${key.length}"`,
      writeHttpMetadata(headers) {
        if (stored.contentType) headers.set('content-type', stored.contentType);
        if (stored.cacheControl) headers.set('cache-control', stored.cacheControl);
      },
    };
    return withBody ? { ...object, body: new Blob([stored.body]).stream() } : object;
  };
  return {
    seen,
    async head(key) {
      seen.push(['head', key]);
      return objectFor(key, false);
    },
    async get(key, options) {
      seen.push(['get', key]);
      const match = options?.onlyIf?.get?.('if-none-match');
      return objectFor(key, !(match && match === `"${key.length}"`));
    },
    async put(key, value, options) {
      seen.push(['put', key]);
      objects[key] = {
        body: value,
        contentType: options?.httpMetadata?.contentType,
        cacheControl: options?.httpMetadata?.cacheControl,
      };
    },
    async list(options) {
      const prefix = options?.prefix ?? '';
      return {
        objects: Object.keys(objects)
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

const env = (objects = {}) => ({ BUCKET: bucket(objects) });
const call = (path, init, e = env()) => worker.fetch(new Request(`https://fox-ui.example.workers.dev/${path}`, init), e);

describe('cdn worker', () => {
  it('serves a published object with the headers it was uploaded with', async () => {
    const e = env({
      'channels/stable.json': { body: '{"ok":1}', contentType: 'application/json', cacheControl: 'public, max-age=60' },
    });
    const response = await call('channels/stable.json', undefined, e);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":1}');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('serves packs and release manifests', async () => {
    const e = env({ [PACK]: { body: 'x' }, 'releases/0.3.26/manifest.json': { body: '{}' } });
    expect((await call(PACK, undefined, e)).status).toBe(200);
    expect((await call('releases/0.3.26/manifest.json', undefined, e)).status).toBe(200);
  });

  it('falls back to a short cache lifetime when an object has none', async () => {
    const response = await call(PACK, undefined, env({ [PACK]: { body: 'x' } }));
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it.each([
    '',
    'other.txt',
    'channels/beta.json',
    'packs/abc',
    `packs/${'A'.repeat(64)}`,
    // The URL parser resolves dot segments first, so this asks for other.txt.
    'releases/0.3.26/../../other.txt',
    'releases/%2e%2e/manifest.json',
    'releases/0.3.26/manifest.json/extra',
    'packs/%E0%A4%A',
  ])('does not serve %j, and never asks the bucket', async (path) => {
    const e = env({ 'other.txt': { body: 'secret' } });
    const response = await call(path, undefined, e);
    expect(response.status).toBe(404);
    expect(e.BUCKET.seen).toEqual([]);
  });

  it('refuses writes', async () => {
    const response = await call('channels/stable.json', { method: 'PUT', body: 'x' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('answers 404 for an allowed key that is not in the bucket', async () => {
    expect((await call(PACK)).status).toBe(404);
  });

  it('answers 304 when the caller already has this version', async () => {
    const e = env({ [PACK]: { body: 'x' } });
    const response = await call(PACK, { headers: { 'if-none-match': `"${PACK.length}"` } }, e);
    expect(response.status).toBe(304);
  });

  it('answers HEAD without a body', async () => {
    const e = env({ [PACK]: { body: 'x', cacheControl: 'public, max-age=31536000, immutable' } });
    const response = await call(PACK, { method: 'HEAD' }, e);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(e.BUCKET.seen).toEqual([['head', PACK]]);
  });

  it('saves user sign-ups privately in Cloudflare R2 and tracks counts', async () => {
    const objects = {};
    const e = env(objects);
    const first = await call(
      'signup',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ' User@Example.com ', source: 'cli' }) },
      e
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, stored: true });

    const second = await call(
      'api/signup',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', source: 'web' }) },
      e
    );
    expect(second.status).toBe(200);

    const savedKey = Object.keys(objects).find((k) => k.startsWith('signups/by-email/'));
    expect(savedKey).toBeTruthy();
    const saved = JSON.parse(objects[savedKey].body);
    expect(saved).toMatchObject({ email: 'user@example.com', source: 'web', count: 2 });

    // Private sign-up objects are never exposed through the public CDN GET path.
    expect((await call(savedKey, undefined, e)).status).toBe(404);
  });

  it('enforces optional SIGNUP_WEBHOOK_SECRET and SIGNUP_ADMIN_TOKEN on signup routes', async () => {
    const objects = {};
    const e = { ...env(objects), SIGNUP_WEBHOOK_SECRET: 'hook-secret', SIGNUP_ADMIN_TOKEN: 'admin-token' };

    const denied = await call('signup', { method: 'POST', body: JSON.stringify({ email: 'a@b.co' }) }, e);
    expect(denied.status).toBe(403);

    const ok = await call(
      'signup',
      {
        method: 'POST',
        headers: { 'x-foxschema-signup-secret': 'hook-secret' },
        body: JSON.stringify({ email: 'a@b.co', source: 'web' }),
      },
      e
    );
    expect(ok.status).toBe(200);

    expect((await call('api/signups', undefined, e)).status).toBe(403);
    const exported = await call('api/signups', { headers: { authorization: 'Bearer admin-token' } }, e);
    expect(exported.status).toBe(200);
    expect((await exported.json()).signups).toHaveLength(1);

    // Without SIGNUP_ADMIN_TOKEN, admin export does not exist at all.
    expect((await call('api/signups', undefined, env(objects))).status).toBe(404);
  });
});
