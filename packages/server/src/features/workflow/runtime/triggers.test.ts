/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/triggers.test.ts).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext, type AppContext } from './context.js';

/** Ingress-layer rules per trigger kind (auth, gating, error codes). */

function ctxWithApp() {
  const ctx = createContext({
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
  });
  return { ctx, app: buildApp(ctx) };
}

function workflowDoc(triggers: unknown[], extras: Record<string, unknown> = {}) {
  return {
    name: 'trig',
    triggers,
    ...extras,
    pipelines: [
      {
        id: 'main',
        name: 'main',
        pipes: [
          { id: 'src', role: 'source', type: 'source.triggerPayload', config: {} },
        ],
        edges: [],
      },
    ],
  };
}

async function saveWorkflow(
  app: ReturnType<typeof buildApp>,
  id: string,
  triggers: unknown[],
  extras: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/workflows/${id}`,
    payload: workflowDoc(triggers, extras),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** Webhook auth is HMAC over `timestamp.idempotencyKey.` + raw body. */
async function webhookCredential(ctx: AppContext) {
  return ctx.credentials.create({
    name: 'hook',
    kind: 'webhook',
    data: { sharedSecret: 'shh' },
  });
}

/** HTTP-trigger auth is a static bearer/api-key header. */
async function httpCredential(ctx: AppContext) {
  return ctx.credentials.create({
    name: 'api',
    kind: 'http',
    data: { apiKey: 'key-123' },
  });
}

function signedHeaders(body: string, idempotencyKey: string) {
  // Freshness is checked in seconds since epoch, not milliseconds.
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'x-foxflow-signature': createHmac('sha256', 'shh')
      .update(`${timestamp}.${idempotencyKey}.`)
      .update(Buffer.from(body))
      .digest('hex'),
    'x-foxflow-timestamp': timestamp,
    'x-idempotency-key': idempotencyKey,
  };
}

describe('trigger ingress by kind (API)', () => {
  it('accepts a signed webhook and rejects a bad signature', async () => {
    const { ctx, app } = ctxWithApp();
    const credential = await webhookCredential(ctx);
    await saveWorkflow(app, 'hook-wf', [
      { id: 'hook', kind: 'webhook', enabled: true, credentialId: credential.id },
    ]);

    const body = JSON.stringify({ event: 'created' });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/triggers/hook-wf/hook',
      headers: signedHeaders(body, 'k1'),
      payload: body,
    });
    expect(ok.statusCode, ok.body).toBe(202);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/triggers/hook-wf/hook',
      headers: { ...signedHeaders(body, 'k2'), 'x-foxflow-signature': 'deadbeef' },
      payload: body,
    });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it('enforces http trigger requiredFields', async () => {
    const { ctx, app } = ctxWithApp();
    const credential = await httpCredential(ctx);
    await saveWorkflow(app, 'api-wf', [
      {
        id: 'api',
        kind: 'http',
        enabled: true,
        credentialId: credential.id,
        requiredFields: ['orderId'],
      },
    ]);

    const send = async (payload: unknown, key: string) =>
      app.inject({
        method: 'POST',
        url: '/api/triggers/api-wf/api',
        headers: {
          'content-type': 'application/json',
          authorization: 'key-123',
          'x-idempotency-key': key,
        },
        payload: JSON.stringify(payload),
      });

    const missing = await send({ nope: 1 }, 'r1');
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error).toContain('orderId');
    expect((await send({ orderId: 7 }, 'r2')).statusCode).toBe(202);
    await app.close();
  });


  it('does not expose parent or manual triggers over the ingress route', async () => {
    const { app } = ctxWithApp();
    await saveWorkflow(app, 'internal-wf', [
      { id: 'manual', kind: 'manual', enabled: true },
      { id: 'parent', kind: 'parent', enabled: true },
    ]);

    for (const triggerId of ['manual', 'parent']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/triggers/internal-wf/${triggerId}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode, triggerId).toBe(405);
      expect(res.json().error).toMatch(/not an HTTP ingress trigger/);
    }
    await app.close();
  });

  it('runs a workflow whose only trigger is manual, and 409s without one', async () => {
    const { app } = ctxWithApp();
    await saveWorkflow(app, 'runnable-wf', [
      { id: 'manual', kind: 'manual', enabled: true },
    ]);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/workflows/runnable-wf/run',
    });
    expect(ok.statusCode).toBe(202);

    await saveWorkflow(app, 'evt-only-wf', [
      { id: 'evt', kind: 'parent', enabled: true },
    ]);
    const noManual = await app.inject({
      method: 'POST',
      url: '/api/workflows/evt-only-wf/run',
    });
    expect(noManual.statusCode).toBe(409);
    expect(noManual.json().error).toMatch(/manual trigger/);
    await app.close();
  });

  it('validates cron executionType http requires a request config', async () => {
    const { app } = ctxWithApp();
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/workflows/cron-http-wf',
      payload: workflowDoc([
        {
          id: 'nightly',
          kind: 'cron',
          enabled: true,
          cron: '0 0 * * *',
          timezone: 'UTC',
          catchUp: 'none',
          executionType: 'http',
        },
      ]),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/http request config is required/);

    const saved = await saveWorkflow(app, 'cron-http-wf', [
      {
        id: 'nightly',
        kind: 'cron',
        enabled: true,
        cron: '0 0 * * *',
        timezone: 'UTC',
        catchUp: 'none',
        executionType: 'http',
        http: { url: 'https://example.com/ping', method: 'POST' },
      },
    ]);
    expect(saved.triggers[0].http.url).toBe('https://example.com/ping');
    await app.close();
  });
});
