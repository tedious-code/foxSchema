/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/app.test.ts).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp, buildIngressApp, openApiListenProblem } from './app.js';
import { createContext, type AppContext } from './context.js';

function testContext(): AppContext {
  return createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) });
}

function signWebhook(
  secret: string,
  timestamp: string,
  idempotencyKey: string,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${idempotencyKey}.`)
    .update(body)
    .digest('hex');
}

// A bare pipeline document — the implicit single-pipeline form.
const samplePipeline = {
  id: 'orders',
  name: 'orders daily',
  // Configs are real: a pipe whose own schema rejects its config is now
  // refused at save time, so a fixture without one describes a workflow that
  // could never run.
  pipes: [
    {
      id: 'src',
      role: 'source',
      type: 'source.file.csv',
      config: { path: '/tmp/foxflow-orders.csv' },
    },
    {
      id: 'sink',
      role: 'sink',
      type: 'sink.postgres',
      config: { table: 'orders', columns: { id: 'text' } },
    },
  ],
  edges: [{ from: 'src', to: 'sink' }],
};

// A full workflow document: load, then publish (completion edge).
const sampleWorkflow = {
  id: 'orders-full',
  name: 'orders full',
  pipelines: [
    samplePipeline,
    {
      id: 'publish',
      name: 'publish',
      // A sink needs something to pull from: a lone sink root is unrunnable
      // and is now refused at save time, not just at run time.
      pipes: [
        { id: 'payload', role: 'source', type: 'source.triggerPayload' },
        {
          id: 'merge',
          role: 'sink',
          type: 'sink.postgres',
          config: { table: 'published', columns: { id: 'text' } },
        },
      ],
      edges: [{ from: 'payload', to: 'merge' }],
    },
  ],
  dependencies: [{ from: 'orders', to: 'publish' }],
};

describe('foxflow api', () => {
  it('reports health', async () => {
    const app = buildApp(testContext());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it('stores a credential and never returns the secret', async () => {
    const app = buildApp(testContext());
    const create = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: {
        name: 'prod-pg',
        kind: 'database',
        data: { host: 'db', password: 'hunter2' },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.body).not.toContain('hunter2');
    expect(create.json()).toMatchObject({
      name: 'prod-pg',
      kind: 'database',
      source: 'local',
    });

    const list = await app.inject({ method: 'GET', url: '/api/credentials' });
    expect(list.json()).toHaveLength(1);
    expect(list.body).not.toContain('password');
    await app.close();
  });

  it('upserts credentials under a stable slug id', async () => {
    const app = buildApp(testContext());
    const create = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: {
        id: 'google-oauth',
        name: 'Google OAuth',
        kind: 'http',
        data: {
          clientId: 'cid',
          clientSecret: 'csec',
          refreshToken: 'refresh-1',
        },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ id: 'google-oauth', name: 'Google OAuth' });
    expect(create.body).not.toContain('refresh-1');

    const again = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: {
        id: 'google-oauth',
        name: 'Google OAuth v2',
        kind: 'http',
        data: {
          clientId: 'cid2',
          clientSecret: 'csec2',
          refreshToken: 'refresh-2',
        },
      },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ id: 'google-oauth', name: 'Google OAuth v2' });

    const list = await app.inject({ method: 'GET', url: '/api/credentials' });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe('google-oauth');
    await app.close();
  });

  it('stores an env-backed credential reference without the env value', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    process.env.FOXFLOW_API_CRED_TEST = 'runtime-secret';
    const create = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: {
        name: 'http-from-env',
        kind: 'http',
        source: 'env',
        data: { bearerToken: 'FOXFLOW_API_CRED_TEST' },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      name: 'http-from-env',
      kind: 'http',
      source: 'env',
    });
    expect(create.body).not.toContain('runtime-secret');

    const revealed = await ctx.credentials.revealSecret(create.json().id);
    expect(revealed).toEqual({ bearerToken: 'runtime-secret' });
    delete process.env.FOXFLOW_API_CRED_TEST;
    await app.close();
  });

  it('rejects incomplete cloud credential references', async () => {
    const app = buildApp(testContext());
    const create = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: {
        name: 'bad-gcp',
        kind: 'http',
        source: 'gcp',
        data: { projectId: 'only-project' },
      },
    });
    expect(create.statusCode).toBe(400);
    expect(create.body).toMatch(/secretId/i);
    await app.close();
  });

  it('validates a bare pipeline (implicit workflow) and returns both plan levels', async () => {
    const app = buildApp(testContext());
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/validate',
      payload: samplePipeline,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      valid: true,
      plan: {
        waves: [['orders']],
        pipelines: { orders: { waves: [['src'], ['sink']] } },
      },
    });
    await app.close();
  });

  it('validates a multi-pipeline workflow with completion ordering', async () => {
    const app = buildApp(testContext());
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/validate',
      payload: sampleWorkflow,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      valid: true,
      plan: { waves: [['orders'], ['publish']] },
    });
    await app.close();
  });

  it('rejects a cyclic pipe graph', async () => {
    const app = buildApp(testContext());
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/validate',
      payload: {
        ...samplePipeline,
        edges: [
          { from: 'src', to: 'sink' },
          { from: 'sink', to: 'src' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ valid: false });
    await app.close();
  });

  it('stores a bare pipeline as a wrapped workflow and triggers a run', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/workflows/orders',
      payload: samplePipeline,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      id: 'orders',
      pipelines: [{ id: 'orders' }],
      triggers: [{ kind: 'manual' }],
    });

    const run = await app.inject({
      method: 'POST',
      url: '/api/workflows/orders/run',
    });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ status: 'queued' });
    const runId = run.json().runId as string;
    await ctx.scheduler.idle();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: runId,
      status: 'failed',
      pipelines: [{ pipelineId: 'orders', status: 'failed' }],
    });

    const events = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/events?after=0`,
    });
    expect(events.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.status' }),
        expect.objectContaining({ type: 'pipeline.status' }),
      ]),
    );

    const resume = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
    });
    expect(resume.statusCode).toBe(409);
    await app.close();
  });

  it('accepts signed webhook payloads asynchronously and deduplicates retries', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    const credential = await ctx.credentials.create({
      name: 'inbound webhook',
      kind: 'webhook',
      data: { sharedSecret: 'test-webhook-secret' },
    });
    await ctx.workflows.put({
      id: 'inbound',
      name: 'inbound',
      version: 1,
      pipelines: [
        {
          id: 'receive',
          name: 'receive',
          pipes: [
            {
              id: 'payload',
              role: 'source',
              type: 'source.triggerPayload',
              config: {},
              concurrency: 1,
            },
          ],
          edges: [],
        },
      ],
      dependencies: [],
      middleware: [],
      triggers: [
        {
          id: 'orders',
          kind: 'webhook',
          enabled: true,
          // Deliberately the *old* flat shape: this asserts liftWebhookAuth
          // still accepts documents saved before `auth` existed.
          credentialId: credential.id,
          signatureHeader: 'x-foxflow-signature',
          timestampHeader: 'x-foxflow-timestamp',
          idempotencyHeader: 'x-idempotency-key',
          maxAgeSeconds: 300,
          maxBodyBytes: 1_048_576,
        } as never,
      ],
      onOverlap: 'parallel',
      origin: 'authored',
    });
    const body = JSON.stringify([{ orderId: 42 }]);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const idempotencyKey = 'order-42';
    const signature = signWebhook(
      'test-webhook-secret',
      timestamp,
      idempotencyKey,
      body,
    );
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/triggers/inbound/orders',
        headers: {
          'content-type': 'application/json',
          'x-foxflow-signature': `sha256=${signature}`,
          'x-foxflow-timestamp': timestamp,
          'x-idempotency-key': idempotencyKey,
        },
        payload: body,
      });

    const accepted = await request();
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: true, status: 'queued' });

    const duplicate = await request();
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({
      accepted: false,
      reason: 'duplicate',
      runId: accepted.json().runId,
    });
    const replayWithNewKey = await app.inject({
      method: 'POST',
      url: '/api/triggers/inbound/orders',
      headers: {
        'content-type': 'application/json',
        'x-foxflow-signature': `sha256=${signature}`,
        'x-foxflow-timestamp': timestamp,
        'x-idempotency-key': 'attacker-changed-key',
      },
      payload: body,
    });
    expect(replayWithNewKey.statusCode).toBe(401);
    const staleTimestamp = String(Number(timestamp) - 301);
    const staleSignature = signWebhook(
      'test-webhook-secret',
      staleTimestamp,
      idempotencyKey,
      body,
    );
    const staleRequest = await app.inject({
      method: 'POST',
      url: '/api/triggers/inbound/orders',
      headers: {
        'content-type': 'application/json',
        'x-foxflow-signature': `sha256=${staleSignature}`,
        'x-foxflow-timestamp': staleTimestamp,
        'x-idempotency-key': idempotencyKey,
      },
      payload: body,
    });
    expect(staleRequest.statusCode).toBe(401);
    const secondKey = 'order-43';
    const secondSignature = signWebhook(
      'test-webhook-secret',
      timestamp,
      secondKey,
      body,
    );
    const legitimateRepeat = await app.inject({
      method: 'POST',
      url: '/api/triggers/inbound/orders',
      headers: {
        'content-type': 'application/json',
        'x-foxflow-signature': `sha256=${secondSignature}`,
        'x-foxflow-timestamp': timestamp,
        'x-idempotency-key': secondKey,
      },
      payload: body,
    });
    expect(legitimateRepeat.json()).toMatchObject({ accepted: true });
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/triggers/inbound/orders',
      headers: {
        'content-type': 'application/json',
        'x-foxflow-signature': 'sha256=invalid',
        'x-foxflow-timestamp': timestamp,
        'x-idempotency-key': 'order-44',
      },
      payload: body,
    });
    expect(unauthorized.statusCode).toBe(401);

    await ctx.scheduler.idle();
    expect(await ctx.runs.get(accepted.json().runId)).toMatchObject({
      status: 'succeeded',
      trigger: 'webhook',
      triggerId: 'orders',
    });
    await app.close();
  });

  it('accepts authenticated HTTP trigger payloads', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    const credential = await ctx.credentials.create({
      name: 'inbound api',
      kind: 'http',
      data: { bearerToken: 'test-api-token' },
    });
    await ctx.workflows.put({
      id: 'api-workflow',
      name: 'api workflow',
      version: 1,
      pipelines: [
        {
          id: 'receive',
          name: 'receive',
          pipes: [
            {
              id: 'payload',
              role: 'source',
              type: 'source.triggerPayload',
              config: {},
              concurrency: 1,
            },
          ],
          edges: [],
        },
      ],
      dependencies: [],
      middleware: [],
      triggers: [
        {
          id: 'api',
          kind: 'http',
          enabled: true,
          credentialId: credential.id,
          authHeader: 'authorization',
          idempotencyHeader: 'x-idempotency-key',
          maxBodyBytes: 1_048_576,
          requiredFields: ['id'],
        },
      ],
      onOverlap: 'parallel',
      origin: 'authored',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/triggers/api-workflow/api',
      headers: {
        authorization: 'Bearer test-api-token',
        'x-idempotency-key': 'api-request-1',
      },
      payload: { id: 1 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true });
    const missingKey = await app.inject({
      method: 'POST',
      url: '/api/triggers/api-workflow/api',
      headers: { authorization: 'Bearer test-api-token' },
      payload: { id: 2 },
    });
    expect(missingKey.statusCode).toBe(400);
    const conflictingKey = await app.inject({
      method: 'POST',
      url: '/api/triggers/api-workflow/api',
      headers: {
        authorization: 'Bearer test-api-token',
        'x-idempotency-key': 'api-request-1',
      },
      payload: { id: 2 },
    });
    expect(conflictingKey.statusCode).toBe(409);
    expect(conflictingKey.json()).toMatchObject({
      accepted: false,
      reason: 'conflict',
      runId: response.json().runId,
    });
    await ctx.scheduler.idle();
    expect(await ctx.runs.get(response.json().runId)).toMatchObject({
      status: 'succeeded',
      trigger: 'http',
      triggerId: 'api',
    });
    await app.close();
  });


  it('lists built-in pipe metadata for registry-driven UI', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    const response = await app.inject({ method: 'GET', url: '/api/pipes' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pipes.map((c: { type: string }) => c.type)).toEqual([
      'human.gate',
      'logic.loop',
      'sink.db.sql',
      'sink.file.delimited',
      'sink.http',
      'sink.mysql',
      'sink.notify.email',
      'sink.notify.sms',
      'sink.postgres',
      'sink.response',
      'source.api.http',
      'source.api.http.multi',
      'source.db.mysql',
      'source.db.postgres',
      'source.db.sql',
      'source.file.csv',
      'source.file.json',
      'source.file.text',
      'source.trigger.cron',
      'source.trigger.http',
      'source.trigger.manual',
      'source.trigger.parent',
      'source.trigger.poll',
      'source.trigger.webhook',
      'source.triggerPayload',
      'transform.condition',
      'transform.http',
      'transform.map',
      'transform.merge',
      'transform.script',
      'transform.split',
      'transform.verify',
      'workflow.sub',
    ]);
    expect(body.pipes[0]).toMatchObject({
      name: expect.any(String),
      category: expect.any(String),
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      configSchema: expect.objectContaining({ type: 'object' }),
    });
    // The response schema filters as well as documents: these were dropped
    // from every reply, so the designer never saw a family or a palette tier.
    const sql = body.pipes.find((c: { type: string }) => c.type === 'source.db.sql');
    expect(sql).toMatchObject({ family: 'database', tags: expect.arrayContaining(['sql']) });
    const csvSink = body.pipes.find((c: { type: string }) => c.type === 'sink.file.delimited');
    expect(csvSink).toMatchObject({ family: 'file', sideEffects: true });
    await app.close();
  });

});

describe('service token', () => {
  const TOKEN = 'shared-engine-token-for-tests';

  it('answers the API only to a caller presenting the token', async () => {
    const app = buildApp(testContext(), { token: TOKEN });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/workflows' })).statusCode).toBe(401);
      expect(
        (await app.inject({
          method: 'GET',
          url: '/api/workflows',
          headers: { authorization: 'Bearer not-the-shared-engine-token' },
        })).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({
          method: 'GET',
          url: '/api/workflows',
          headers: { authorization: `Bearer ${TOKEN}` },
        })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('leaves health and trigger ingress to their own authentication', async () => {
    const app = buildApp(testContext(), { token: TOKEN });
    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      // No such workflow: the point is that the token check did not answer first.
      const ingress = await app.inject({ method: 'POST', url: '/api/triggers/nope/nope', payload: {} });
      expect(ingress.statusCode).not.toBe(401);
      const hook = await app.inject({ method: 'POST', url: '/api/hooks/nope', payload: {} });
      expect(hook.statusCode).not.toBe(401);
    } finally {
      await app.close();
    }
  });

  it('stays open when no token is configured', async () => {
    const app = buildApp(testContext(), { token: undefined });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/workflows' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('serves no trigger ingress once ingress has a listener of its own', async () => {
    const app = buildApp(testContext(), { token: TOKEN, ingress: false });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/triggers/nope/nope', payload: {} });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('run event stream', () => {
  it('sends a finished run’s events, then `end`, and closes', async () => {
    const ctx = testContext();
    const app = buildApp(ctx, { token: undefined });
    try {
      await ctx.runs.create(
        {
          id: 'run-done',
          workflowId: 'wf',
          workflowVersion: 1,
          status: 'succeeded',
          trigger: 'manual',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          instanceId: 'test',
        } as never,
        { id: 'wf', name: 'wf', version: 1, triggers: [], pipelines: [] } as never,
      );
      await ctx.events.append({
        workflowRunId: 'run-done',
        at: new Date().toISOString(),
        type: 'run.status',
        data: { status: 'succeeded' },
      } as never);

      // inject resolves only once the response ends, so this also proves the
      // stream closes by itself.
      const response = await app.inject({ method: 'GET', url: '/api/runs/run-done/events/stream' });
      const frames = response.body.split('\n\n').filter(Boolean);
      expect(frames[0]).toMatch(/^data: \{.*"type":"run.status"/);
      expect(frames.at(-1)).toBe('event: end\ndata: {}');
    } finally {
      await app.close();
    }
  });
});

describe('run event stream delivery', () => {
  it('pushes an event as the engine stores it, not on the next poll', async () => {
    const ctx = testContext();
    const app = buildApp(ctx, { token: undefined });
    try {
      await ctx.runs.create(
        {
          id: 'run-live',
          workflowId: 'wf',
          workflowVersion: 1,
          status: 'running',
          trigger: 'manual',
          startedAt: new Date().toISOString(),
          instanceId: 'test',
        } as never,
        { id: 'wf', name: 'wf', version: 1, triggers: [], pipelines: [] } as never,
      );
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${base}/api/runs/run-live/events/stream`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const until = async (pattern: RegExp) => {
        while (!pattern.test(text)) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      };

      const appended = Date.now();
      await ctx.events.append({
        workflowRunId: 'run-live',
        at: new Date().toISOString(),
        type: 'pipe.status',
        pipelineId: 'main',
        pipeId: 'src',
        data: { status: 'running' },
      } as never);
      await until(/"type":"pipe.status"/);
      // The fallback check runs every 500ms; arriving well inside that means
      // the stream was woken by the event itself.
      expect(Date.now() - appended).toBeLessThan(250);

      await ctx.events.append({
        workflowRunId: 'run-live',
        at: new Date().toISOString(),
        type: 'run.status',
        data: { status: 'succeeded' },
      } as never);
      await until(/event: end/);
      expect(text).toMatch(/"status":"succeeded"[\s\S]*event: end/);
    } finally {
      await app.close();
    }
  });
});

describe('ingress listener', () => {
  it('serves trigger ingress and health, and none of the engine API', async () => {
    const ctx = testContext();
    const ingress = buildIngressApp(ctx);
    try {
      expect((await ingress.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const trigger = await ingress.inject({ method: 'POST', url: '/api/triggers/nope/nope', payload: {} });
      expect(trigger.statusCode).toBe(404);
      expect(trigger.json()).toEqual({ error: 'workflow not found' });
      expect((await ingress.inject({ method: 'GET', url: '/api/workflows' })).statusCode).toBe(404);
      expect((await ingress.inject({ method: 'GET', url: '/api/credentials' })).statusCode).toBe(404);
    } finally {
      await ingress.close();
      ctx.close();
    }
  });
});

describe('where the engine API may listen without a token', () => {
  it('allows loopback, with or without a token', () => {
    for (const host of ['127.0.0.1', '127.0.1.1', '::1', 'localhost']) {
      expect(openApiListenProblem(host, undefined), host).toBeNull();
    }
  });

  it('refuses any other address unless a token is set', () => {
    // 0.0.0.0 is what a container needs — and with no token it handed every
    // caller on the network the credentials and the right to run workflows.
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'engine.internal']) {
      expect(openApiListenProblem(host, undefined), host).toMatch(/WORKFLOW_ENGINE_TOKEN/);
      expect(openApiListenProblem(host, 'secret'), host).toBeNull();
    }
  });
});

describe('the engine API behind its service token', () => {
  it('answers only a caller presenting exactly the token', async () => {
    const ctx = testContext();
    const app = buildApp(ctx, { token: 'shared-service-token' });
    try {
      const call = (authorization?: string) =>
        app.inject({ method: 'GET', url: '/api/workflows', headers: authorization ? { authorization } : {} });
      expect((await call()).statusCode).toBe(401);
      expect((await call('Bearer wrong')).statusCode).toBe(401);
      expect((await call('Bearer shared-service-token-and-more')).statusCode).toBe(401);
      expect((await call('Basic shared-service-token')).statusCode).toBe(401);
      expect((await call('Bearer shared-service-token')).statusCode).toBe(200);
      // Health stays open: the proxy probes it before it has anything to send.
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
