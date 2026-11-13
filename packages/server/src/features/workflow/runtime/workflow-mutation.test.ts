/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-mutation.test.ts).
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

/** A pipeline that needs no external resources, so runs stay hermetic. */
function pipeline(id: string) {
  return {
    id,
    name: id,
    pipes: [
      {
        id: `${id}-src`,
        type: 'source.triggerPayload',
        role: 'source',
        config: {},
      },
    ],
    edges: [],
  };
}

const base = {
  id: 'agent-target',
  name: 'Agent target',
  pipelines: [pipeline('ingest')],
  triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
};

async function seed(app: Awaited<ReturnType<typeof api>>) {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/workflows/agent-target',
    payload: base,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { version: number };
}

describe('POST /api/workflows/:id/pipelines', () => {
  it('adds a pipeline and wires it into the run order', async () => {
    const app = await api();
    const seeded = await seed(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: pipeline('reconcile'),
        dependsOn: [{ from: 'ingest' }],
        expectedVersion: seeded.version,
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.workflow.pipelines.map((p: { id: string }) => p.id)).toEqual([
      'ingest',
      'reconcile',
    ]);
    expect(body.workflow.dependencies).toEqual([
      { from: 'ingest', to: 'reconcile', on: 'success' },
    ]);
    // The new pipeline must land in a later wave, not run as a second root.
    expect(body.plan.waves).toEqual([['ingest'], ['reconcile']]);
    expect(body.workflow.version).toBe(seeded.version + 1);

    await app.close();
  });

  it('rejects a stale expectedVersion so two agents cannot erase each other', async () => {
    const app = await api();
    const seeded = await seed(app);

    // First agent lands its change.
    const first = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: { pipeline: pipeline('a'), expectedVersion: seeded.version },
    });
    expect(first.statusCode).toBe(200);

    // Second agent still holds the version it read before that.
    const second = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: { pipeline: pipeline('b'), expectedVersion: seeded.version },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/re-read it and retry/);

    // The first agent's pipeline survived.
    const after = await app.inject({ method: 'GET', url: '/api/workflows/agent-target' });
    expect(after.json().pipelines.map((p: { id: string }) => p.id)).toContain('a');

    await app.close();
  });

  it('conflicts on a duplicate pipeline id unless replace is set', async () => {
    const app = await api();
    await seed(app);

    const clash = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: { pipeline: pipeline('ingest') },
    });
    expect(clash.statusCode).toBe(409);

    const replaced = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: { pipeline: pipeline('ingest'), replace: true },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().workflow.pipelines).toHaveLength(1);

    await app.close();
  });

  it('refuses a dependsOn on a pipeline that does not exist', async () => {
    const app = await api();
    await seed(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: pipeline('reconcile'),
        dependsOn: [{ from: 'imaginary' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown pipeline imaginary/);

    await app.close();
  });

  it('validates the merged result, not the fragment, and saves nothing on failure', async () => {
    const app = await api();
    await seed(app);

    // A pipeline whose only pipe is a transform has no source root — legal as a
    // fragment in isolation, illegal as part of a workflow.
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: {
          id: 'broken',
          name: 'broken',
          pipes: [
            { id: 't', type: 'transform.map', role: 'transform', config: { mappings: { a: 'b' } } },
          ],
          edges: [],
        },
      },
    });

    expect(res.statusCode).toBe(400);

    // Nothing half-applied: the workflow is untouched, still at version 1.
    const after = await app.inject({ method: 'GET', url: '/api/workflows/agent-target' });
    expect(after.json().pipelines.map((p: { id: string }) => p.id)).toEqual(['ingest']);
    expect(after.json().version).toBe(1);

    await app.close();
  });

  it('refuses a pipe whose own config schema rejects it', async () => {
    // Before this check a `sink.postgres` with no table saved with a cheerful
    // 200 and failed at 3am. The API is the gate in front of the engine, so it
    // runs the same `registry.get` the executor will.
    const app = await api();
    await seed(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: {
          id: 'writer',
          name: 'writer',
          pipes: [
            { id: 's', role: 'source', type: 'source.triggerPayload', config: {} },
            { id: 'w', role: 'sink', type: 'sink.postgres', config: {} },
          ],
          edges: [{ from: 's', to: 'w' }],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    // Names the pipeline and pipe: a workflow can hold several of one type.
    expect(res.json().error).toMatch(/pipeline writer, pipe w/);

    await app.close();
  });

  it('refuses a pipe type that does not exist', async () => {
    const app = await api();
    await seed(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: {
          id: 'ghost',
          name: 'ghost',
          pipes: [
            { id: 'g', role: 'source', type: 'source.imaginary', config: {} },
          ],
          edges: [],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pipe not registered: source.imaginary/);

    await app.close();
  });

  it('says what is wrong with a pipe config in words, not a JSON dump', async () => {
    const app = await api();
    await seed(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: {
          id: 'gate',
          name: 'gate',
          pipes: [
            { id: 's', role: 'source', type: 'source.triggerPayload', config: {} },
            { id: 'c', role: 'transform', type: 'transform.condition', config: { value: 1 } },
          ],
          edges: [{ from: 's', to: 'c' }],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    const error = res.json().error as string;
    expect(error).toMatch(/pipeline gate, pipe c: field: /);
    expect(error).not.toMatch(/"code":/);

    await app.close();
  });

  it('refuses an edge from a port the pipe does not declare', async () => {
    // The executor refused this on the first batch, so it saved fine and
    // failed at run time instead.
    const app = await api();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflows/ports',
      payload: {
        ...base,
        id: 'ports',
        pipelines: [
          {
            id: 'p',
            name: 'p',
            pipes: [
              { id: 's', role: 'source', type: 'source.triggerPayload', config: {} },
              { id: 'split', role: 'transform', type: 'transform.split', config: { field: 'region' } },
              { id: 'out', role: 'sink', type: 'sink.response', config: {} },
            ],
            edges: [
              { from: 's', to: 'split' },
              { from: 'split', fromPort: 'eu', to: 'out' },
            ],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pipeline p: edge split → out: unknown fromPort "eu"/);

    await app.close();
  });

  it('404s for a workflow that is not there', async () => {
    const app = await api();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/nope/pipelines',
      payload: { pipeline: pipeline('x') },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reports a schema failure as one readable sentence, not a Zod dump', async () => {
    // These endpoints exist for callers that write workflows programmatically
    // and retry on rejection. A serialised ZodError makes the agent parse a
    // JSON array of issue objects before it can fix anything.
    const app = await api();
    await seed(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: {
          id: 'nameless',
          pipes: [
            { id: 'a', type: 'source.triggerPayload', role: 'source', config: {} },
          ],
          edges: [],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: string };
    expect(error).toMatch(/name/);
    expect(error).not.toContain('[');
    expect(error).not.toContain('invalid_type');
    expect(() => JSON.parse(error)).toThrow();

    await app.close();
  });
});

describe('DELETE /api/workflows/:id/pipelines/:pipelineId', () => {
  it('removes a pipeline and its inbound edges', async () => {
    const app = await api();
    const seeded = await seed(app);
    await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: {
        pipeline: pipeline('reconcile'),
        dependsOn: [{ from: 'ingest' }],
        expectedVersion: seeded.version,
      },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workflows/agent-target/pipelines/reconcile',
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().workflow.pipelines.map((p: { id: string }) => p.id)).toEqual([
      'ingest',
    ]);
    expect(res.json().workflow.dependencies).toEqual([]);

    await app.close();
  });

  it('refuses to strand pipelines that depend on the target', async () => {
    const app = await api();
    await seed(app);
    await app.inject({
      method: 'POST',
      url: '/api/workflows/agent-target/pipelines',
      payload: { pipeline: pipeline('reconcile'), dependsOn: [{ from: 'ingest' }] },
    });

    // Removing `ingest` would change when `reconcile` runs — not what was asked.
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workflows/agent-target/pipelines/ingest',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/depended on by reconcile/);

    await app.close();
  });

  it('refuses to remove the last pipeline', async () => {
    const app = await api();
    await seed(app);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/workflows/agent-target/pipelines/ingest',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/only pipeline/);

    await app.close();
  });
});
