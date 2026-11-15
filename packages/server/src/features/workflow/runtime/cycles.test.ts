/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/cycles.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '@foxschema/workflow-engine';
import { buildApp } from './app.js';
import { createContext } from './context.js';

function testContext() {
  return createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) });
}

function callerDoc(id: string, target: string) {
  return {
    id,
    name: id,
    pipelines: [
      {
        id: 'main',
        name: 'main',
        pipes: [
          { id: 'src', role: 'source', type: 'source.triggerPayload', config: {} },
          {
            id: 'sub',
            role: 'transform',
            type: 'workflow.sub',
            config: { workflowId: target },
          },
        ],
        edges: [{ from: 'src', to: 'sub' }],
      },
    ],
  };
}

describe('circular workflow detection (API layers)', () => {
  it('layer 1: rejects saving a workflow that closes a cycle, with the path', async () => {
    const app = buildApp(testContext());

    // Forward reference is fine: b → a while a does not exist yet.
    const saveB = await app.inject({
      method: 'PUT',
      url: '/api/workflows/cycle-b',
      payload: callerDoc('cycle-b', 'cycle-a'),
    });
    expect(saveB.statusCode).toBe(200);

    // Saving a → b now closes a cycle.
    const saveA = await app.inject({
      method: 'PUT',
      url: '/api/workflows/cycle-a',
      payload: callerDoc('cycle-a', 'cycle-b'),
    });
    expect(saveA.statusCode).toBe(400);
    expect(saveA.json().error).toContain(
      'Circular Workflow Dependency: cycle-a → cycle-b → cycle-a',
    );

    // Validate reports the same, without persisting.
    const validate = await app.inject({
      method: 'POST',
      url: '/api/workflows/validate',
      payload: callerDoc('self', 'self'),
    });
    expect(validate.statusCode).toBe(400);
    expect(validate.json()).toMatchObject({
      valid: false,
      error: expect.stringContaining('Circular Workflow Dependency: self → self'),
    });
    await app.close();
  });

  it('layer 2: refuses to run a stored cycle even when saves bypassed the API', async () => {
    const ctx = testContext();
    const app = buildApp(ctx);
    await ctx.workflows.put(parseWorkflow(callerDoc('loop-a', 'loop-b')));
    await ctx.workflows.put(parseWorkflow(callerDoc('loop-b', 'loop-a')));

    const run = await app.inject({
      method: 'POST',
      url: '/api/workflows/loop-a/run',
    });
    expect(run.statusCode).toBe(400);
    expect(run.json().error).toContain(
      'Circular Workflow Dependency: loop-a → loop-b → loop-a',
    );
    await app.close();
  });
});
