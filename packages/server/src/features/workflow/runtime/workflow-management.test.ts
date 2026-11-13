/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-management.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext, type AppContext } from './context.js';

function harness() {
  const ctx = createContext({
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
  });
  return { ctx, app: buildApp(ctx) };
}

type App = ReturnType<typeof buildApp>;

function workflowDoc(name: string, extras: Record<string, unknown> = {}) {
  return {
    name,
    triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
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

async function save(app: App, id: string, extras: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/workflows/${id}`,
    payload: workflowDoc(id, extras),
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('workflow list detail', () => {
  it('reports triggers, counts, updatedAt and the latest run', async () => {
    const { app } = harness();
    await save(app, 'orders', { description: 'Order intake' });
    await app.inject({ method: 'POST', url: '/api/workflows/orders/run' });

    const list = (await app.inject({ method: 'GET', url: '/api/workflows' })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'orders',
      description: 'Order intake',
      pipelines: 1,
      pipes: 1,
      triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
    });
    expect(list[0].updatedAt).toEqual(expect.any(String));
    expect(list[0].lastRun).toMatchObject({ status: expect.any(String) });
    await app.close();
  });

  it('omits lastRun for a workflow that never ran', async () => {
    const { app } = harness();
    await save(app, 'never-run');
    const list = (await app.inject({ method: 'GET', url: '/api/workflows' })).json();
    expect(list[0].lastRun).toBeUndefined();
    await app.close();
  });
});

describe('workflow delete', () => {
  it('deletes a workflow while leaving its run history intact', async () => {
    const { app } = harness();
    await save(app, 'orders');
    const run = await app.inject({
      method: 'POST',
      url: '/api/workflows/orders/run',
    });
    const runId = run.json().runId;

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/workflows/orders',
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/workflows/orders' })).statusCode,
    ).toBe(404);
    // The run still resolves — it carries its own snapshot, which the
    // connection check reads after the live workflow is gone.
    const stored = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().workflowId).toBe('orders');
    const snapshot = await app.inject({ method: 'GET', url: `/api/runs/${runId}/snapshot` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().id).toBe('orders');
    await app.close();
  });

  it('refuses to delete while a run is still queued or running', async () => {
    const { ctx, app } = harness();
    await save(app, 'orders');
    // A run parked in `queued` stands in for work still in flight.
    const workflow = (await ctx.workflows.get('orders'))!;
    await ctx.runs.create(
      {
        id: 'run-active',
        workflowId: 'orders',
        workflowVersion: workflow.version,
        status: 'queued',
        trigger: 'manual',
        triggerId: 'manual',
        startedAt: new Date().toISOString(),
        instanceId: 'test',
      },
      workflow,
    );

    const blocked = await app.inject({
      method: 'DELETE',
      url: '/api/workflows/orders',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/active run/);
    expect(
      (await app.inject({ method: 'GET', url: '/api/workflows/orders' })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it('removes cron schedules belonging to the deleted workflow', async () => {
    const { ctx, app } = harness();
    await save(app, 'scheduled', {
      triggers: [
        {
          id: 'nightly',
          kind: 'cron',
          enabled: true,
          cron: '0 0 * * *',
          timezone: 'UTC',
          catchUp: 'none',
          executionType: 'workflow',
        },
      ],
    });
    await ctx.schedules.put({
      workflowId: 'scheduled',
      triggerId: 'nightly',
      nextFireAt: new Date().toISOString(),
    });

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/workflows/scheduled' }))
        .statusCode,
    ).toBe(204);
    expect(await ctx.schedules.get('scheduled', 'nightly')).toBeUndefined();
    await app.close();
  });

  it('removes the workflow-scoped variables of a deleted workflow', async () => {
    const { ctx, app } = harness();
    await save(app, 'orders');
    const dev = await ctx.environments.create({ name: 'dev' });
    await ctx.variables.put({
      environmentId: dev.id,
      scope: 'global',
      key: 'api_base',
      value: 'https://dev',
    });
    await ctx.variables.put({
      environmentId: dev.id,
      scope: 'workflow',
      workflowId: 'orders',
      key: 'page_size',
      value: 500,
    });

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/workflows/orders' }))
        .statusCode,
    ).toBe(204);
    const remaining = await ctx.variables.list({ environmentId: dev.id });
    // The global survives; the orphaned workflow-scoped row is gone.
    expect(remaining.map((variable) => variable.scope)).toEqual(['global']);
    await app.close();
  });

  it('404s deleting a workflow that does not exist', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'DELETE', url: '/api/workflows/ghost' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('workflow duplicate', () => {
  it('copies the definition under a new id and resets the version', async () => {
    const { app } = harness();
    // Versions are caller-supplied (no auto-increment on save), so set v2
    // explicitly to make the copy's reset to v1 observable.
    await save(app, 'orders', { version: 2 });

    const copy = await app.inject({
      method: 'POST',
      url: '/api/workflows/orders/duplicate',
      payload: { id: 'orders-staging' },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json()).toMatchObject({
      id: 'orders-staging',
      name: 'orders copy',
      version: 1,
    });
    expect(copy.json().pipelines[0].pipes[0].id).toBe('src');

    // Source is untouched.
    const source = (
      await app.inject({ method: 'GET', url: '/api/workflows/orders' })
    ).json();
    expect(source.version).toBe(2);
    await app.close();
  });

  it('gives up the webhook path, so the copy cannot answer the original’s calls', async () => {
    const { app } = harness();
    await save(app, 'inbound', {
      triggers: [
        {
          id: 'hook',
          kind: 'webhook',
          enabled: true,
          path: 'typeform/signup',
          auth: { type: 'none', acknowledgeUnauthenticated: true },
          onMissingIdempotencyKey: 'fingerprint',
        },
      ],
    });

    const copy = await app.inject({
      method: 'POST',
      url: '/api/workflows/inbound/duplicate',
      payload: { id: 'inbound-copy' },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().triggers[0]).toMatchObject({ id: 'hook', kind: 'webhook' });
    expect(copy.json().triggers[0].path).toBeUndefined();

    // The original keeps its path, and the copy can be saved as it came back.
    const original = (await app.inject({ method: 'GET', url: '/api/workflows/inbound' })).json();
    expect(original.triggers[0].path).toBe('typeform/signup');
    const resave = await app.inject({ method: 'PUT', url: '/api/workflows/inbound-copy', payload: copy.json() });
    expect(resave.statusCode, resave.body).toBe(200);
    await app.close();
  });

  it('accepts a custom name and rejects an id that already exists', async () => {
    const { app } = harness();
    await save(app, 'orders');
    await save(app, 'taken');

    const named = await app.inject({
      method: 'POST',
      url: '/api/workflows/orders/duplicate',
      payload: { id: 'orders-v2', name: 'Orders (v2)' },
    });
    expect(named.json().name).toBe('Orders (v2)');

    const clash = await app.inject({
      method: 'POST',
      url: '/api/workflows/orders/duplicate',
      payload: { id: 'taken' },
    });
    expect(clash.statusCode).toBe(409);
    await app.close();
  });
});
