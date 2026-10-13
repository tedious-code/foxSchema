/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/http/src/request.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { InMemoryCredentialStore, parseHttpRequest } from '../../common/index.js';
import { buildHttpRequest, describeHttpFailure, executeHttpRequest } from './request.js';
import { interpolate } from '../../sdk/index.js';

describe('shared HTTP request', () => {
  it('builds URL with query, headers, bearer auth, and JSON body', () => {
    const request = parseHttpRequest({
      url: 'https://api.example.com/items',
      method: 'POST',
      query: [{ key: 'limit', value: '10', enabled: true }],
      headers: [{ key: 'x-trace', value: '1', enabled: true }],
      auth: { type: 'bearer', token: 'secret' },
      body: { mode: 'json', json: { hello: 'world' } },
    });
    const { url, init } = buildHttpRequest(request);
    expect(url).toBe('https://api.example.com/items?limit=10');
    expect(init.method).toBe('POST');
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer secret');
    expect(headers.get('x-trace')).toBe('1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('serializes condition operators as key[op]=value (eq stays plain)', () => {
    const request = parseHttpRequest({
      url: 'https://api.example.com/items',
      query: [
        { key: 'name', value: 'foo', enabled: true },
        { key: 'name2', value: 'bar', enabled: true, op: 'eq' },
        { key: 'price', value: '100', enabled: true, op: 'gte' },
        { key: 'status', value: 'a,b', enabled: true, op: 'in' },
        { key: 'age', value: '18,30', enabled: true, op: 'range' },
        { key: 'off', value: 'x', enabled: false, op: 'lt' },
      ],
    });
    const { url } = buildHttpRequest(request);
    expect(url).toBe(
      'https://api.example.com/items' +
        '?name=foo&name2=bar&price%5Bgte%5D=100&status%5Bin%5D=a%2Cb&age%5Brange%5D=18%2C30',
    );
    expect(decodeURIComponent(url)).toBe(
      'https://api.example.com/items?name=foo&name2=bar&price[gte]=100&status[in]=a,b&age[range]=18,30',
    );
  });

  it('drops unknown operators during coercion (falls back to plain eq)', () => {
    const request = parseHttpRequest({
      url: 'https://api.example.com',
      query: [{ key: 'a', value: '1', enabled: true, op: 'like' }],
    });
    expect(request.query[0]!.op).toBeUndefined();
    expect(buildHttpRequest(request).url).toBe('https://api.example.com/?a=1');
  });

  it('composes a fields body with typed values and validates its schema', () => {
    const request = parseHttpRequest({
      url: 'https://api.example.com/orders',
      method: 'POST',
      body: {
        mode: 'fields',
        fields: [
          { key: 'orderId', type: 'number', value: '42', enabled: true },
          { key: 'note', type: 'string', value: 'hi', enabled: true },
          { key: 'rush', type: 'boolean', value: 'true', enabled: true },
          { key: 'tags', type: 'json', value: '["a","b"]', enabled: true },
          { key: 'off', type: 'string', value: 'x', enabled: false },
        ],
        schema: { type: 'object', required: ['orderId'] },
      },
    });
    const { init } = buildHttpRequest(request);
    expect(JSON.parse(init.body as string)).toEqual({
      orderId: 42,
      note: 'hi',
      rush: true,
      tags: ['a', 'b'],
    });
    expect((init.headers as Headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('rejects a body that fails its schema before any request is sent', async () => {
    let fetched = 0;
    await expect(
      executeHttpRequest({
        request: {
          url: 'https://api.example.com/orders',
          method: 'POST',
          body: {
            mode: 'fields',
            fields: [{ key: 'note', type: 'string', value: 'hi', enabled: true }],
            schema: { type: 'object', required: ['orderId'] },
          },
        },
        fetch: async () => {
          fetched += 1;
          return new Response('{}', { status: 200 });
        },
      }),
    ).rejects.toMatchObject({
      name: 'HttpBodyValidationError',
      message: expect.stringContaining('orderId'),
    });
    expect(fetched).toBe(0);
  });

  it('validates raw and json bodies against their schema too', () => {
    expect(() =>
      buildHttpRequest(
        parseHttpRequest({
          url: 'https://api.example.com',
          method: 'POST',
          body: {
            mode: 'raw',
            raw: 'not json',
            contentType: 'text/plain',
            schema: { type: 'object' },
          },
        }),
      ),
    ).toThrow(/raw body is not valid JSON/);
    expect(() =>
      buildHttpRequest(
        parseHttpRequest({
          url: 'https://api.example.com',
          method: 'POST',
          body: {
            mode: 'json',
            json: { orderId: 'not-a-number' },
            schema: {
              type: 'object',
              properties: { orderId: { type: 'number' } },
            },
          },
        }),
      ),
    ).toThrow(/request body invalid/);
    const ok = buildHttpRequest(
      parseHttpRequest({
        url: 'https://api.example.com',
        method: 'POST',
        body: {
          mode: 'json',
          json: { orderId: 7 },
          schema: { type: 'object', properties: { orderId: { type: 'number' } } },
        },
      }),
    );
    expect(ok.init.body).toBe('{"orderId":7}');
  });

  it('validates form bodies against their schema as a {key: value} object', () => {
    const base = {
      url: 'https://api.example.com',
      method: 'POST',
      body: {
        mode: 'form',
        form: [{ key: 'email', value: 'not-an-email', enabled: true }],
        schema: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', pattern: '@' } },
        },
      },
    };
    expect(() => buildHttpRequest(parseHttpRequest(base))).toThrow(
      /request body invalid/,
    );
    const ok = buildHttpRequest(
      parseHttpRequest({
        ...base,
        body: {
          ...base.body,
          form: [{ key: 'email', value: 'fox@example.com', enabled: true }],
        },
      }),
    );
    expect(ok.init.body).toBe('email=fox%40example.com');
  });

  it('interpolates templates in fields values before composing', () => {
    const request = parseHttpRequest({
      url: 'https://api.example.com/orders',
      method: 'POST',
      body: {
        mode: 'fields',
        fields: [
          { key: 'user', type: 'string', value: '{{vars.userId}}', enabled: true },
        ],
      },
    });
    const resolvedValue = interpolate('{{vars.userId}}', { vars: { userId: 'u1' } });
    expect(resolvedValue).toBe('u1');
    const { init } = buildHttpRequest({
      ...request,
      body: {
        mode: 'fields',
        fields: [{ key: 'user', type: 'string', value: resolvedValue, enabled: true }],
      },
    });
    expect(init.body).toBe('{"user":"u1"}');
  });

  it('skips body composition and schema validation entirely for GET/HEAD', () => {
    // Stale body config from a former POST: invalid field + failing schema.
    const { url, init } = buildHttpRequest(
      parseHttpRequest({
        url: 'https://api.example.com/items',
        method: 'GET',
        body: {
          mode: 'fields',
          fields: [{ key: 'n', type: 'number', value: 'not-a-number', enabled: true }],
          schema: { type: 'object', required: ['missing'] },
        },
      }),
    );
    expect(url).toBe('https://api.example.com/items');
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get('content-type')).toBeNull();
  });

  it('maps {{variables}} into URL and valueFrom into query params', async () => {
    const fetches: string[] = [];
    const result = await executeHttpRequest({
      request: {
        url: 'https://api.example.com/users/{{vars.userId}}/orders',
        method: 'GET',
        variables: { userId: '42', page: 3 },
        query: [
          { key: 'page', value: '', enabled: true, valueFrom: 'vars.page' },
          { key: 'q', value: 'hello {{trigger.q}}', enabled: true },
        ],
      },
      trigger: { q: 'fox' },
      fetch: async (url) => {
        fetches.push(String(url));
        return new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(result.ok).toBe(true);
    expect(fetches[0]).toBe(
      'https://api.example.com/users/42/orders?page=3&q=hello+fox',
    );
  });

  it('sends a query-string API key but reports the URL without it', async () => {
    // A failed HTTP sink or transform puts `result.url` in the run's error,
    // which anyone who can open the run reads.
    const fetches: string[] = [];
    const result = await executeHttpRequest({
      request: {
        url: 'https://api.example.com/orders',
        method: 'POST',
        query: [{ key: 'page', value: '2', enabled: true }],
        auth: { type: 'apiKey', in: 'query', key: 'api_key', value: 'sk-live-123' },
      },
      fetch: async (url) => {
        fetches.push(String(url));
        return new Response('{"error":"nope"}', { status: 500, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(fetches[0]).toBe('https://api.example.com/orders?page=2&api_key=sk-live-123');
    expect(result.url).toBe('https://api.example.com/orders?page=2&api_key=REDACTED');
    expect(result.url).not.toContain('sk-live-123');
  });

  it('reuses cookie sessions and persists them on the credential', async () => {
    const store = new InMemoryCredentialStore(randomBytes(32));
    const credential = await store.create({
      name: 'session',
      kind: 'http',
      data: { bearerToken: 'seed' },
    });

    let calls = 0;
    await executeHttpRequest({
      request: {
        url: 'https://app.example.com/login',
        method: 'POST',
        auth: { type: 'credential', credentialId: credential.id },
        session: { enabled: true, persistToCredential: true },
        body: { mode: 'json', json: { user: 'a' } },
      },
      secret: await store.revealSecret(credential.id),
      credentialId: credential.id,
      credentials: store,
      fetch: async () => {
        calls += 1;
        return new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'sid=abc123; Path=/; HttpOnly',
          },
        });
      },
    });

    const secret = await store.revealSecret(credential.id);
    expect(secret?.cookies).toEqual([
      expect.objectContaining({ name: 'sid', value: 'abc123' }),
    ]);

    const cookieHeaders: string[] = [];
    await executeHttpRequest({
      request: {
        url: 'https://app.example.com/me',
        method: 'GET',
        auth: { type: 'credential', credentialId: credential.id },
        session: { enabled: true, persistToCredential: true },
      },
      secret,
      credentialId: credential.id,
      credentials: store,
      fetch: async (_url, init) => {
        cookieHeaders.push(new Headers(init?.headers).get('cookie') ?? '');
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(calls).toBe(1);
    expect(cookieHeaders[0]).toContain('sid=abc123');
  });

  it('auto-refreshes access tokens on 401 and retries', async () => {
    const store = new InMemoryCredentialStore(randomBytes(32));
    const credential = await store.create({
      name: 'oauth',
      kind: 'http',
      data: {
        accessToken: 'expired',
        refreshToken: 'refresh-me',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });

    const urls: string[] = [];
    const auths: string[] = [];
    await executeHttpRequest({
      request: {
        url: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'credential', credentialId: credential.id },
        tokenRefresh: {
          enabled: true,
          url: 'https://auth.example.com/token',
          method: 'POST',
          headers: [],
          body: {
            mode: 'json',
            json: {
              refresh_token: '{{secrets.refreshToken}}',
              grant_type: 'refresh_token',
            },
          },
          accessTokenPath: 'access_token',
          refreshTokenPath: 'refresh_token',
          expiresInPath: 'expires_in',
          onStatus: [401],
          skewSeconds: 60,
        },
      },
      secret: await store.revealSecret(credential.id),
      credentialId: credential.id,
      credentials: store,
      fetch: async (url, init) => {
        urls.push(String(url));
        if (String(url).includes('/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'fresh',
              refresh_token: 'refresh-2',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        auths.push(auth);
        if (auth.includes('expired')) {
          return new Response('unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    // proactive refresh (expired) + data call with fresh token
    expect(urls.some((url) => url.includes('/token'))).toBe(true);
    expect(auths.at(-1)).toBe('Bearer fresh');
    const updated = await store.revealSecret(credential.id);
    expect(updated?.accessToken).toBe('fresh');
    expect(updated?.refreshToken).toBe('refresh-2');
  });

  it('interpolates template helpers', () => {
    expect(
      interpolate('https://x/{{vars.id}}?q={{trigger.q}}', {
        vars: { id: 7 },
        trigger: { q: 'a b' },
      }),
    ).toBe('https://x/7?q=a b');
  });
});

describe('describeHttpFailure', () => {
  it('names the error a JSON body gives', () => {
    expect(describeHttpFailure({ status: 400, body: { error: 'idempotency key is required' } })).toBe(
      'returned 400: idempotency key is required',
    );
    expect(describeHttpFailure({ status: 422, body: { message: 'bad field' } })).toBe('returned 422: bad field');
  });

  it('falls back to the JSON itself when there is no error field', () => {
    expect(describeHttpFailure({ status: 409, body: { taken: true } })).toBe('returned 409: {"taken":true}');
  });

  it('flattens and caps a text body', () => {
    const page = `<html>\n  <body>${'x'.repeat(500)}</body>\n</html>`;
    const message = describeHttpFailure({ status: 502, body: page });
    expect(message).toMatch(/^returned 502: <html> <body>x+…$/);
    expect(message.length).toBeLessThan(230);
  });

  it('is just the status when the body says nothing', () => {
    expect(describeHttpFailure({ status: 500, body: '' })).toBe('returned 500');
    expect(describeHttpFailure({ status: 500, body: undefined })).toBe('returned 500');
  });
});
