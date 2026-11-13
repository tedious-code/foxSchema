/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-api.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext } from './context.js';

function api() {
  return buildApp(
    createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) }),
  );
}

/**
 * The shape a non-coder builds to publish an API: an HTTP trigger, the request
 * body arriving as records, a map, and `sink.response` as the answer.
 */
function lookupWorkflow(extra: Record<string, unknown> = {}) {
  return {
    id: 'customer-lookup',
    name: 'Customer lookup',
    triggers: [
      {
        id: 'api',
        kind: 'http',
        enabled: true,
        credentialId: 'api-key',
      },
    ],
    pipelines: [
      {
        id: 'answer',
        name: 'Answer',
        pipes: [
          { id: 'in', role: 'source', type: 'source.triggerPayload', config: {} },
          {
            id: 'shape',
            role: 'transform',
            type: 'transform.map',
            config: { mappings: { greeting: 'name' }, includeOriginal: false },
          },
          { id: 'out', role: 'sink', type: 'sink.response', config: {} },
        ],
        edges: [
          { from: 'in', to: 'shape' },
          { from: 'shape', to: 'out' },
        ],
      },
    ],
    ...extra,
  };
}

async function seed(app: Awaited<ReturnType<typeof api>>, doc: unknown) {
  const credential = await app.inject({
    method: 'POST',
    url: '/api/credentials',
    payload: { name: 'api-key', kind: 'http', data: { apiKey: 'secret-key' } },
  });
  expect(credential.statusCode, credential.body).toBe(201);
  const id = credential.json().id as string;

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/workflows/customer-lookup',
    payload: JSON.parse(
      JSON.stringify(doc).replace('"credentialId":"api-key"', `"credentialId":"${id}"`),
    ),
  });
  expect(saved.statusCode, saved.body).toBe(200);
}

function call(
  app: Awaited<ReturnType<typeof api>>,
  body: Record<string, unknown>,
  query = '?wait=1',
) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: `/api/triggers/customer-lookup/api${query}`,
    headers: {
      'content-type': 'application/json',
      authorization: 'secret-key',
      // Idempotency is required; a fresh key per call means a fresh run.
      'x-idempotency-key': createHash('sha256').update(payload + Math.random()).digest('hex'),
    },
    payload,
  });
}

describe('a workflow published as a synchronous API', () => {
  it('returns the run output to the caller instead of a run id', async () => {
    const app = await api();
    await seed(app, lookupWorkflow());

    const res = await call(app, { name: 'Ada' });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'succeeded',
      output: [{ greeting: 'Ada' }],
    });

    await app.close();
  });

  it('waits for a run that cannot finish before the first poll', async () => {
    // The regression this pins: `?wait=1` was parsed as a *one millisecond*
    // budget rather than "yes", so the request answered `timeout` immediately.
    // Every other test here passed anyway, because an in-memory run finishes
    // before the first check — only work slow enough to still be running can
    // tell the two readings apart.
    const app = await api();
    await seed(
      app,
      lookupWorkflow({
        pipelines: [
          {
            id: 'answer',
            name: 'Answer',
            pipes: [
              { id: 'in', role: 'source', type: 'source.triggerPayload', config: {} },
              {
                id: 'slow',
                role: 'transform',
                type: 'transform.script',
                // Sandboxed, so this really does take time on another thread.
                config: {
                  script:
                    'const end = Date.now() + 250; while (Date.now() < end) {} return records;',
                  timeoutMs: 5000,
                },
              },
              { id: 'out', role: 'sink', type: 'sink.response', config: {} },
            ],
            edges: [
              { from: 'in', to: 'slow' },
              { from: 'slow', to: 'out' },
            ],
          },
        ],
      }),
    );

    const res = await call(app, { name: 'Ada' });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('succeeded');
    expect(res.json().output).toEqual([{ name: 'Ada' }]);

    await app.close();
  }, 20_000);

  it('treats waitMs as a budget and wait as a flag', async () => {
    const app = await api();
    await seed(app, lookupWorkflow());

    // An explicit tiny budget is honoured as a budget…
    const tiny = await call(app, { name: 'Ada' }, '?waitMs=1');
    expect([200, 202]).toContain(tiny.statusCode);

    // …while the flag form uses the default and returns the answer.
    const flagged = await call(app, { name: 'Ada' }, '?wait=true');
    expect(flagged.statusCode, flagged.body).toBe(200);
    expect(flagged.json().output).toEqual([{ greeting: 'Ada' }]);

    // And an explicit "no" keeps the async contract.
    const off = await call(app, { name: 'Ada' }, '?wait=false');
    expect(off.statusCode).toBe(202);

    await app.close();
  });

  it('still answers 202 with a run id when no wait is asked for', async () => {
    // The async contract is unchanged — an import or migration wants this.
    const app = await api();
    await seed(app, lookupWorkflow());

    const res = await call(app, { name: 'Ada' }, '');

    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toBeTruthy();
    expect(res.json().output).toBeUndefined();

    await app.close();
  });

  it('reports a failed run as a gateway error, not as a result', async () => {
    const app = await api();
    // A sink with a bad table name fails at write time.
    await seed(
      app,
      lookupWorkflow({
        pipelines: [
          {
            id: 'answer',
            name: 'Answer',
            pipes: [
              { id: 'in', role: 'source', type: 'source.triggerPayload', config: {} },
              {
                id: 'boom',
                role: 'sink',
                type: 'sink.postgres',
                config: { table: 'nope', columns: { a: 'text' } },
              },
            ],
            edges: [{ from: 'in', to: 'boom' }],
          },
        ],
      }),
    );

    const res = await call(app, { name: 'Ada' });

    expect(res.statusCode).toBe(502);
    expect(res.json().status).toBe('failed');
    expect(res.json().error).toBeTruthy();

    await app.close();
  });

  it('refuses to answer with a payload its outputSchema forbids', async () => {
    // A declared outputSchema is a promise to the caller. Here the workflow
    // returns objects but promises an array of strings.
    const app = await api();
    await seed(
      app,
      lookupWorkflow({
        outputSchema: { type: 'array', items: { type: 'string' } },
      }),
    );

    const res = await call(app, { name: 'Ada' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/outputSchema/);

    await app.close();
  });

  it('is a no-op for runs nobody is waiting on', async () => {
    // Same workflow, called async: sink.response must not fail when there is
    // no collector, so one workflow serves both calling styles.
    const app = await api();
    await seed(app, lookupWorkflow());

    const res = await call(app, { name: 'Ada' }, '');
    expect(res.statusCode).toBe(202);
    const runId = res.json().runId as string;

    // Give the run a moment, then confirm it still succeeded.
    for (let i = 0; i < 40; i++) {
      const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      if (['succeeded', 'failed'].includes(detail.json().status)) {
        expect(detail.json().status).toBe('succeeded');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await app.close();
  });
});
