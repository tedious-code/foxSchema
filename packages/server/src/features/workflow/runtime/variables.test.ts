/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/variables.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext } from './context.js';

function api() {
  return buildApp(
    createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) }),
  );
}

type App = ReturnType<typeof buildApp>;

async function createEnv(app: App, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/environments',
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

function putVar(
  app: App,
  environmentId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/environments/${environmentId}/variables`,
    payload: body,
  });
}

async function saveWorkflow(app: App, id: string) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/workflows/${id}`,
    payload: {
      name: id,
      triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
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
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('environments API', () => {
  it('creates, activates, and rejects duplicate names', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    const prod = await createEnv(app, 'prod');

    const dupe = await app.inject({
      method: 'POST',
      url: '/api/environments',
      payload: { name: 'dev' },
    });
    expect(dupe.statusCode).toBe(409);

    // First created is active; activation moves the flag.
    let list = (await app.inject({ method: 'GET', url: '/api/environments' })).json();
    expect(
      list.environments.find((e: { id: string }) => e.id === dev).isActive,
    ).toBe(true);

    await app.inject({ method: 'POST', url: `/api/environments/${prod}/activate` });
    list = (await app.inject({ method: 'GET', url: '/api/environments' })).json();
    const active = list.environments.filter((e: { isActive: boolean }) => e.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(prod);
    await app.close();
  });

  it('refuses to delete the active environment while others exist', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    await createEnv(app, 'prod');

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/environments/${dev}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/activate another first/);
    await app.close();
  });
});

describe('variables API', () => {
  it('stores global and workflow-scoped variables and resolves them', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    await saveWorkflow(app, 'orders');

    expect((await putVar(app, dev, { key: 'api_base', value: 'https://dev' })).statusCode).toBe(200);
    expect((await putVar(app, dev, { key: 'page_size', value: 100 })).statusCode).toBe(200);
    expect(
      (
        await putVar(app, dev, {
          scope: 'workflow',
          workflowId: 'orders',
          key: 'page_size',
          value: 500,
        })
      ).statusCode,
    ).toBe(200);

    const resolved = await app.inject({
      method: 'GET',
      url: '/api/variables/resolved?workflowId=orders',
    });
    expect(resolved.json().variables).toEqual({
      api_base: 'https://dev',
      page_size: 500,
    });
    await app.close();
  });

  it('rejects a workflow-scoped variable without a workflowId', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    const res = await putVar(app, dev, { scope: 'workflow', key: 'x', value: 1 });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('clones a variable name into other environments without clobbering', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    const staging = await createEnv(app, 'staging');
    const prod = await createEnv(app, 'prod');

    await putVar(app, dev, { key: 'api_base', value: 'https://dev' });
    // prod already has a tuned value that a clone must not overwrite.
    await putVar(app, prod, { key: 'api_base', value: 'https://prod' });

    const clone = await app.inject({
      method: 'POST',
      url: '/api/variables/clone',
      payload: {
        sourceEnvironmentId: dev,
        targetEnvironmentIds: [staging, prod],
        key: 'api_base',
      },
    });
    expect(clone.statusCode).toBe(200);
    expect(clone.json()).toEqual({
      key: 'api_base',
      cloned: [staging],
      skipped: [prod],
    });

    const prodVars = (
      await app.inject({ method: 'GET', url: `/api/environments/${prod}/variables` })
    ).json().variables;
    expect(prodVars[0].value).toBe('https://prod');

    // Same name now exists in staging, seeded from dev's value.
    const stagingVars = (
      await app.inject({ method: 'GET', url: `/api/environments/${staging}/variables` })
    ).json().variables;
    expect(stagingVars).toHaveLength(1);
    expect(stagingVars[0]).toMatchObject({ key: 'api_base', value: 'https://dev' });
    await app.close();
  });

  it('overwrites on clone when asked, and seeds a distinct value', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    const prod = await createEnv(app, 'prod');
    await putVar(app, dev, { key: 'api_base', value: 'https://dev' });
    await putVar(app, prod, { key: 'api_base', value: 'old' });

    const clone = await app.inject({
      method: 'POST',
      url: '/api/variables/clone',
      payload: {
        sourceEnvironmentId: dev,
        targetEnvironmentIds: [prod],
        key: 'api_base',
        value: 'https://api.example.com',
        overwrite: true,
      },
    });
    expect(clone.json().cloned).toEqual([prod]);

    const prodVars = (
      await app.inject({ method: 'GET', url: `/api/environments/${prod}/variables` })
    ).json().variables;
    expect(prodVars[0].value).toBe('https://api.example.com');
    await app.close();
  });

  it('404s when cloning a key that exists nowhere and has no seed value', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    const prod = await createEnv(app, 'prod');
    const clone = await app.inject({
      method: 'POST',
      url: '/api/variables/clone',
      payload: {
        sourceEnvironmentId: dev,
        targetEnvironmentIds: [prod],
        key: 'ghost',
      },
    });
    expect(clone.statusCode).toBe(404);
    await app.close();
  });
});

describe('per-run environment override', () => {
  it('runs against the active environment and honours an override', async () => {
    const app = api();
    const dev = await createEnv(app, 'dev');
    const prod = await createEnv(app, 'prod');
    await saveWorkflow(app, 'orders');
    await putVar(app, dev, { key: 'api_base', value: 'https://dev' });
    await putVar(app, prod, { key: 'api_base', value: 'https://prod' });

    // Bare POST (no body at all) must still work — the common case.
    const bare = await app.inject({ method: 'POST', url: '/api/workflows/orders/run' });
    expect(bare.statusCode, bare.body).toBe(202);

    const overridden = await app.inject({
      method: 'POST',
      url: '/api/workflows/orders/run',
      payload: { environment: 'prod' },
    });
    expect(overridden.statusCode).toBe(202);

    const runs = (await app.inject({ method: 'GET', url: '/api/runs' })).json();
    const environments = runs.map((r: { environmentId: string }) => r.environmentId);
    expect(environments).toContain(dev);
    expect(environments).toContain(prod);
    await app.close();
  });

  it('400s on an unknown environment instead of running against the wrong one', async () => {
    const app = api();
    await createEnv(app, 'dev');
    await saveWorkflow(app, 'orders');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/orders/run',
      payload: { environment: 'staging' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown environment: staging/);
    await app.close();
  });
});
