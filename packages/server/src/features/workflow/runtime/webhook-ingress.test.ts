/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/webhook-ingress.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '@foxschema/workflow-engine';
import { buildApp } from './app.js';
import { createContext, type AppContext } from './context.js';

function testContext(): AppContext {
  return createContext({
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
  });
}

const receivePipeline = {
  id: 'receive',
  name: 'receive',
  pipes: [
    {
      id: 'payload',
      role: 'source' as const,
      type: 'source.triggerPayload',
      config: {},
    },
  ],
  edges: [],
};

async function withWebhook(
  trigger: Record<string, unknown>,
): Promise<{ ctx: AppContext; app: ReturnType<typeof buildApp> }> {
  const ctx = testContext();
  const app = buildApp(ctx);
  await ctx.workflows.put(
    parseWorkflow({
      id: 'inbound',
      name: 'inbound',
      version: 1,
      pipelines: [receivePipeline],
      triggers: [{ id: 'hook', kind: 'webhook', ...trigger }],
      onOverlap: 'parallel',
    }),
  );
  return { ctx, app };
}

const open = {
  auth: { type: 'none', acknowledgeUnauthenticated: true },
  onMissingIdempotencyKey: 'fingerprint',
};

describe('webhook methods', () => {
  it('answers only the configured methods', async () => {
    const { app } = await withWebhook({ ...open, methods: ['POST', 'PUT'] });

    for (const method of ['POST', 'PUT'] as const) {
      const res = await app.inject({
        method,
        url: '/api/triggers/inbound/hook',
        payload: { n: 1 },
      });
      expect(res.statusCode, `${method} should be accepted`).toBe(202);
    }

    const rejected = await app.inject({
      method: 'DELETE',
      url: '/api/triggers/inbound/hook',
    });
    expect(rejected.statusCode).toBe(405);
    // Tell the caller what *is* allowed rather than only what is not.
    expect(rejected.headers.allow).toBe('POST, PUT');
    await app.close();
  });

  it('defaults to POST only, so a GET cannot fire it from a browser bar', async () => {
    const { app } = await withWebhook(open);
    const res = await app.inject({ method: 'GET', url: '/api/triggers/inbound/hook' });
    expect(res.statusCode).toBe(405);
    await app.close();
  });

  it('gives two GETs with different query strings different fingerprints', async () => {
    const { ctx, app } = await withWebhook({ ...open, methods: ['GET'] });

    const first = await app.inject({
      method: 'GET',
      url: '/api/triggers/inbound/hook?order=1',
    });
    const second = await app.inject({
      method: 'GET',
      url: '/api/triggers/inbound/hook?order=2',
    });
    expect(first.statusCode).toBe(202);
    // A GET has no body. Fingerprinting the body alone would make every GET
    // identical, so the second would be swallowed as a duplicate.
    expect(second.statusCode).toBe(202);
    expect(second.json().runId).not.toBe(first.json().runId);
    expect(await ctx.runs.list('inbound')).toHaveLength(2);
    await app.close();
  });
});

describe('webhook idempotency fallback', () => {
  it('rejects a missing key by default', async () => {
    const { app } = await withWebhook({
      auth: { type: 'none', acknowledgeUnauthenticated: true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers/inbound/hook',
      payload: { n: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/idempotency key is required/);
    await app.close();
  });

  it('derives one from the request when told to, and still dedups', async () => {
    const { app } = await withWebhook(open);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/triggers/inbound/hook',
        payload: { orderId: 7 },
      });

    const first = await send();
    expect(first.statusCode).toBe(202);
    const retry = await send();
    // Identical request, derived key matches: one run, not two.
    expect(retry.json()).toMatchObject({ accepted: false, reason: 'duplicate' });

    const different = await app.inject({
      method: 'POST',
      url: '/api/triggers/inbound/hook',
      payload: { orderId: 8 },
    });
    expect(different.json().runId).not.toBe(first.json().runId);
    await app.close();
  });
});

describe('webhook vanity path', () => {
  it('serves the same trigger at /api/hooks/<path>', async () => {
    const { app } = await withWebhook({ ...open, path: 'typeform/signup' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/typeform/signup',
      payload: { email: 'a@b.test' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(true);
    await app.close();
  });

  it('404s an unknown path', async () => {
    const { app } = await withWebhook({ ...open, path: 'known' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/nope',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('stops answering a path once the trigger is disabled', async () => {
    const { ctx, app } = await withWebhook({ ...open, path: 'gone' });
    const workflow = await ctx.workflows.get('inbound');
    await ctx.workflows.put(
      parseWorkflow({
        ...workflow,
        triggers: [
          { id: 'hook', kind: 'webhook', enabled: false, ...open, path: 'gone' },
        ],
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/gone',
      payload: {},
    });
    // Freed rather than 409-squatted: the path is available again.
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('refuses to save two workflows claiming one path', async () => {
    const { ctx, app } = await withWebhook({ ...open, path: 'shared' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflows/other',
      payload: {
        name: 'other',
        pipelines: [receivePipeline],
        triggers: [{ id: 'hook', kind: 'webhook', ...open, path: 'shared' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/already used by workflow inbound/);
    expect(await ctx.workflows.get('other')).toBeUndefined();
    await app.close();
  });

  it('refuses two triggers in one document claiming one path', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflows/dupe',
      payload: {
        name: 'dupe',
        pipelines: [receivePipeline],
        triggers: [
          { id: 'a', kind: 'webhook', ...open, path: 'same' },
          { id: 'b', kind: 'webhook', ...open, path: 'same' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/both use webhook path "same"/);
    await app.close();
  });

  it('lets a workflow keep its own path when saved over itself', async () => {
    const { app } = await withWebhook({ ...open, path: 'mine' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflows/inbound',
      payload: {
        name: 'inbound renamed',
        pipelines: [receivePipeline],
        triggers: [{ id: 'hook', kind: 'webhook', ...open, path: 'mine' }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('webhook auth over the wire', () => {
  it('401s a bad Basic password and accepts the right one', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    const credential = await ctx.credentials.create({
      name: 'basic hook',
      kind: 'webhook',
      data: { username: 'alice', password: 's3cret' },
    });
    await ctx.workflows.put(
      parseWorkflow({
        id: 'inbound',
        name: 'inbound',
        version: 1,
        pipelines: [receivePipeline],
        triggers: [
          {
            id: 'hook',
            kind: 'webhook',
            auth: { type: 'basic', credentialId: credential.id },
            onMissingIdempotencyKey: 'fingerprint',
          },
        ],
        onOverlap: 'parallel',
      }),
    );
    const call = (user: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/triggers/inbound/hook',
        payload: { n: 1 },
        headers: {
          authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
        },
      });

    expect((await call('alice', 'wrong')).statusCode).toBe(401);
    expect((await call('alice', 's3cret')).statusCode).toBe(202);
    await app.close();
  });

  it('401s when the credential is not a webhook credential', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    // A database credential happens to have a `password` field. Without the
    // kind check it would satisfy Basic auth on a webhook.
    const credential = await ctx.credentials.create({
      name: 'a database',
      kind: 'database',
      data: { username: 'alice', password: 's3cret' },
    });
    await ctx.workflows.put(
      parseWorkflow({
        id: 'inbound',
        name: 'inbound',
        version: 1,
        pipelines: [receivePipeline],
        triggers: [
          {
            id: 'hook',
            kind: 'webhook',
            auth: { type: 'basic', credentialId: credential.id },
            onMissingIdempotencyKey: 'fingerprint',
          },
        ],
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers/inbound/hook',
      payload: { n: 1 },
      headers: {
        authorization: `Basic ${Buffer.from('alice:s3cret').toString('base64')}`,
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
