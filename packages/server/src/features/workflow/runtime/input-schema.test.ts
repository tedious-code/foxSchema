/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/input-schema.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext } from './context.js';

function testContext() {
  return createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) });
}

function guardedDoc(inputData: unknown) {
  return {
    id: 'guarded',
    name: 'guarded',
    description: 'input-contract demo',
    inputSchema: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', required: ['sku'] },
    },
    outputSchema: { type: 'object' },
    triggers: [{ id: 'manual', kind: 'manual', enabled: true, inputData }],
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

describe('workflow input/output schemas (API)', () => {
  it('rejects a malformed inputSchema at save time', async () => {
    const app = buildApp(testContext());
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workflows/bad-schema',
      payload: { ...guardedDoc([]), inputSchema: { type: 42 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('valid JSON Schema');
    await app.close();
  });

  it('round-trips description and both schemas, and gates manual runs', async () => {
    const app = buildApp(testContext());

    const save = await app.inject({
      method: 'PUT',
      url: '/api/workflows/guarded',
      payload: guardedDoc({ wrong: 'shape' }),
    });
    expect(save.statusCode).toBe(200);

    const fetched = await app.inject({
      method: 'GET',
      url: '/api/workflows/guarded',
    });
    expect(fetched.json()).toMatchObject({
      description: 'input-contract demo',
      inputSchema: { type: 'array' },
      outputSchema: { type: 'object' },
    });

    // Manual run: the trigger's inputData violates the schema → 400.
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/workflows/guarded/run',
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain('workflow guarded input invalid');

    // Fix the input data → the run is admitted.
    await app.inject({
      method: 'PUT',
      url: '/api/workflows/guarded',
      payload: guardedDoc([{ sku: 'A-1' }]),
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/workflows/guarded/run',
    });
    expect(accepted.statusCode).toBe(202);
    await app.close();
  });
});
