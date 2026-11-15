/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/agent-extends-workflow.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext } from './context.js';

/**
 * The agentic claim, end to end: an agent *extends* a workflow that already
 * exists instead of regenerating it, and the next run picks the addition up
 * with no redeploy.
 *
 * Regeneration is the failure mode this exists to avoid. Asked to add one
 * pipeline, a model that re-emits the whole document silently drops whatever it
 * did not think to mention — and the parts it drops are the parts nobody
 * described to it, which are exactly the parts someone tuned by hand.
 *
 * So the tests below check two things in equal measure: that a good fragment
 * lands and runs, and that a bad one changes nothing at all.
 */

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

function api() {
  return buildApp(
    createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) }),
  );
}

async function ordersFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-'));
  cleanup.push(dir);
  const path = join(dir, 'sales.ndjson');
  await writeFile(
    path,
    [
      '{"order_id":"A-1","region":"eu","amount":10,"status":"paid"}',
      '{"order_id":"A-2","region":"eu","amount":20,"status":"refunded"}',
      '{"order_id":"A-3","region":"us","amount":30,"status":"paid"}',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** What a human authored: one pipeline that ingests. */
function baseWorkflow(path: string) {
  return {
    id: 'daily-sales',
    name: 'Daily sales',
    triggers: [{ id: 'run-now', kind: 'manual', enabled: true }],
    pipelines: [
      {
        id: 'ingest',
        name: 'Ingest orders',
        pipes: [
          {
            id: 'read',
            type: 'source.file.json',
            role: 'source',
            config: { path, format: 'ndjson', batchSize: 10 },
          },
        ],
        edges: [],
      },
    ],
  };
}

/** What the agent sends: the fragment only, never the whole document. */
function refundPipeline(path: string) {
  return {
    id: 'refund-watch',
    name: 'Flag refunds',
    pipes: [
      {
        id: 'reread',
        type: 'source.file.json',
        role: 'source',
        config: { path, format: 'ndjson', batchSize: 10 },
      },
      {
        id: 'is-refund',
        type: 'transform.condition',
        role: 'transform',
        config: { field: 'status', operator: 'equals', value: 'refunded' },
      },
    ],
    edges: [{ from: 'reread', to: 'is-refund' }],
  };
}

async function runToCompletion(
  app: ReturnType<typeof api>,
  workflowId: string,
): Promise<{ status: string; pipelines: string[] }> {
  const started = await app.inject({
    method: 'POST',
    url: `/api/workflows/${workflowId}/run`,
    payload: {},
  });
  const { runId } = started.json() as { runId: string };

  for (let attempt = 0; attempt < 100; attempt++) {
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    const run = detail.json() as {
      status: string;
      pipes: { pipelineId: string }[];
    };
    if (run.status === 'succeeded' || run.status === 'failed') {
      return {
        status: run.status,
        pipelines: [...new Set(run.pipes.map((p) => p.pipelineId))].sort(),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('run did not finish');
}

describe('an agent extends a live workflow', () => {
  it('adds a pipeline, and the next run executes it', async () => {
    const app = api();
    const path = await ordersFile();

    await app.inject({
      method: 'PUT',
      url: '/api/workflows/daily-sales',
      payload: baseWorkflow(path),
    });

    const before = await runToCompletion(app, 'daily-sales');
    expect(before.pipelines).toEqual(['ingest']);

    const added = await app.inject({
      method: 'POST',
      url: '/api/workflows/daily-sales/pipelines',
      payload: {
        expectedVersion: 1,
        pipeline: refundPipeline(path),
        dependsOn: [{ from: 'ingest', on: 'success' }],
      },
    });
    expect(added.statusCode, added.body).toBe(200);

    const saved = (
      await app.inject({ method: 'GET', url: '/api/workflows/daily-sales' })
    ).json() as {
      version: number;
      pipelines: { id: string; pipes: unknown[] }[];
      dependencies: { from: string; to: string }[];
    };

    expect(saved.version).toBe(2);
    expect(saved.pipelines.map((p) => p.id).sort()).toEqual([
      'ingest',
      'refund-watch',
    ]);
    // The pipeline the agent was not asked about must come through untouched.
    expect(saved.pipelines.find((p) => p.id === 'ingest')?.pipes).toHaveLength(1);
    expect(saved.dependencies).toContainEqual(
      expect.objectContaining({ from: 'ingest', to: 'refund-watch' }),
    );

    // No redeploy, no re-authoring: the next run just has more in it.
    const after = await runToCompletion(app, 'daily-sales');
    expect(after.status).toBe('succeeded');
    expect(after.pipelines).toEqual(['ingest', 'refund-watch']);

    await app.close();
  });

  it('refuses a stale write rather than clobbering a concurrent edit', async () => {
    const app = api();
    const path = await ordersFile();
    await app.inject({
      method: 'PUT',
      url: '/api/workflows/daily-sales',
      payload: baseWorkflow(path),
    });
    await app.inject({
      method: 'POST',
      url: '/api/workflows/daily-sales/pipelines',
      payload: { expectedVersion: 1, pipeline: refundPipeline(path) },
    });

    // The agent still believes it is version 1.
    const stale = await app.inject({
      method: 'POST',
      url: '/api/workflows/daily-sales/pipelines',
      payload: {
        expectedVersion: 1,
        pipeline: { ...refundPipeline(path), id: 'another' },
      },
    });

    expect(stale.statusCode).toBe(409);
    // The message has to tell the agent how to recover, not just that it lost.
    expect(stale.json()).toMatchObject({
      error: expect.stringContaining('re-read it and retry'),
    });

    await app.close();
  });

  it.each([
    [
      'a duplicate pipeline id',
      (path: string) => ({ pipeline: refundPipeline(path) }),
      409,
    ],
    [
      'a dependency on a pipeline that is not there',
      (path: string) => ({
        pipeline: { ...refundPipeline(path), id: 'orphan' },
        dependsOn: [{ from: 'nonexistent', on: 'success' }],
      }),
      400,
    ],
    [
      'a pipe whose config the registry rejects',
      (path: string) => ({
        pipeline: {
          ...refundPipeline(path),
          id: 'broken',
          pipes: [
            {
              id: 'bad',
              type: 'transform.condition',
              role: 'transform',
              config: { field: 'status' },
            },
          ],
          edges: [],
        },
      }),
      400,
    ],
  ])('rejects %s and leaves the workflow untouched', async (_name, build, status) => {
    const app = api();
    const path = await ordersFile();
    await app.inject({
      method: 'PUT',
      url: '/api/workflows/daily-sales',
      payload: baseWorkflow(path),
    });
    await app.inject({
      method: 'POST',
      url: '/api/workflows/daily-sales/pipelines',
      payload: { pipeline: refundPipeline(path) },
    });

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/workflows/daily-sales/pipelines',
      payload: build(path),
    });
    expect(rejected.statusCode, rejected.body).toBe(status);

    // Half-applying a mutation is worse than refusing it: the workflow would
    // run in a shape nobody authored.
    const saved = (
      await app.inject({ method: 'GET', url: '/api/workflows/daily-sales' })
    ).json() as { version: number; pipelines: { id: string }[] };
    expect(saved.version).toBe(2);
    expect(saved.pipelines.map((p) => p.id).sort()).toEqual([
      'ingest',
      'refund-watch',
    ]);

    await app.close();
  });
});
