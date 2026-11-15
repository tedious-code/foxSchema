/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/dry-run.test.ts).
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

/**
 * A realistic shape: read a file, split on a condition, write to a database.
 * A dry run must exercise the condition for real while touching neither the
 * file nor the database.
 */
const workflow = {
  id: 'orders-etl',
  name: 'Orders ETL',
  pipelines: [
    {
      id: 'load',
      name: 'Load',
      pipes: [
        {
          id: 'read',
          role: 'source',
          type: 'source.file.csv',
          // Points at a file that does not exist: a dry run must not read it.
          config: { path: '/nonexistent/orders.csv' },
        },
        {
          id: 'total',
          role: 'transform',
          type: 'transform.script',
          config: {
            script:
              'return records.map((r) => ({ ...r, total: Number(r.qty) * Number(r.price) }));',
          },
        },
        {
          id: 'big',
          role: 'transform',
          type: 'transform.condition',
          config: { field: 'total', operator: 'greaterThan', value: 100 },
        },
        {
          id: 'write',
          role: 'sink',
          type: 'sink.postgres',
          // Points at a database that is not running.
          config: { table: 'orders', columns: { id: 'text', total: 'text' } },
        },
      ],
      edges: [
        { from: 'read', to: 'total' },
        { from: 'total', to: 'big' },
        { from: 'big', to: 'write', fromPort: 'true' },
      ],
    },
  ],
};

async function seed(
  app: Awaited<ReturnType<typeof api>>,
  doc: Record<string, unknown> = workflow,
) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/workflows/orders-etl`,
    payload: doc,
  });
  expect(res.statusCode, res.body).toBe(200);
}

function dryRun(
  app: Awaited<ReturnType<typeof api>>,
  samples: Record<string, Record<string, unknown>[]>,
) {
  return app.inject({
    method: 'POST',
    url: '/api/workflows/orders-etl/dry-run',
    payload: { samples },
  });
}

describe('POST /api/workflows/:id/dry-run', () => {
  it('runs the real transforms without touching the file or the database', async () => {
    const app = await api();
    await seed(app);

    const res = await dryRun(app, {
      read: [
        { id: 'a', qty: '3', price: '50' }, // 150 → passes the condition
        { id: 'b', qty: '1', price: '10' }, // 10  → does not
      ],
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);

    const byPipe = Object.fromEntries(
      body.pipes.map((p: { pipeId: string }) => [p.pipeId, p]),
    );

    // The source stood in: the configured path does not exist, and no error.
    expect(byPipe.read.mode).toBe('sample-source');
    expect(byPipe.read.records).toBe(2);

    // The script genuinely executed — this total is computed, not echoed.
    expect(byPipe.total.mode).toBe('executed');
    expect(byPipe.total.sample[0]).toMatchObject({ id: 'a', total: 150 });

    // The sink recorded rather than wrote, and the condition really did route:
    // only the row over 100 reached it, on the `true` port.
    expect(byPipe.write.mode).toBe('recorded-sink');
    expect(byPipe.write.records).toBe(1);
    expect(byPipe.write.sample[0]).toMatchObject({ id: 'a' });

    await app.close();
  });

  it('leaves no run, event or checkpoint behind', async () => {
    // A dry run that showed up in the run history would make the history lie
    // about what the workflow has actually done.
    const app = await api();
    await seed(app);

    await dryRun(app, { read: [{ id: 'a', qty: '3', price: '50' }] });

    const runs = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(runs.json()).toEqual([]);

    await app.close();
  });

  it('reports a transform that throws, instead of pretending it passed', async () => {
    const app = await api();
    await seed(app, {
      ...workflow,
      pipelines: [
        {
          ...workflow.pipelines[0]!,
          pipes: workflow.pipelines[0]!.pipes.map((pipe) =>
            pipe.id === 'total'
              ? { ...pipe, config: { script: 'throw new Error("bad row");' } }
              : pipe,
          ),
        },
      ],
    });

    const res = await dryRun(app, { read: [{ id: 'a' }] });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toMatch(/bad row/);

    await app.close();
  });

  it('stands in for pipes that reach outside the process', async () => {
    // `transform.http` would send a live request per record. It must be stood
    // in for, and the report must say so rather than quietly claiming it ran.
    const app = await api();
    await seed(app, {
      ...workflow,
      pipelines: [
        {
          id: 'load',
          name: 'Load',
          pipes: [
            {
              id: 'read',
              role: 'source',
              type: 'source.triggerPayload',
              config: {},
            },
            {
              id: 'enrich',
              role: 'transform',
              type: 'transform.http',
              config: { request: { method: 'POST', url: 'https://api.example.test/articles/{{topic}}' } },
            },
          ],
          edges: [{ from: 'read', to: 'enrich' }],
        },
      ],
    });

    const res = await dryRun(app, { read: [{ topic: 'foxes' }] });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().ok).toBe(true);
    const enrich = res.json().pipes.find((p: { pipeId: string }) => p.pipeId === 'enrich');
    expect(enrich.mode).toBe('skipped-side-effect');

    await app.close();
  });

  it('404s for a workflow that is not saved', async () => {
    const app = await api();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/nope/dry-run',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
