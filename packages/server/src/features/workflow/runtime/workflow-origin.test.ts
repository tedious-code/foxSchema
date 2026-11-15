/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-origin.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWorkflowInput } from '@foxschema/workflow-engine';
import { buildWorkflowPackage, importWorkflowPackage } from './workflow-package.js';
import { proposeWorkflow } from './workflow-propose.js';
import { extractPipeline } from './workflow-extract.js';
import { buildApp } from './app.js';
import { createContext } from './context.js';

/**
 * Where a workflow came from.
 *
 * A workflow is data, and these are the doors data comes in through. The field
 * only means anything if it is true at every one of them — a capability
 * withheld from "imported" workflows is worth exactly as much as the accuracy
 * of that label, and no more.
 */

const AUTHORED = {
  id: 'wf',
  name: 'WF',
  version: 1,
  triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
  pipelines: [
    {
      id: 'main',
      name: 'Main',
      pipes: [
        { id: 'start', type: 'source.triggerPayload', role: 'source', config: {} },
      ],
      edges: [],
    },
  ],
};

describe('workflow origin', () => {
  it('defaults to authored, so existing stored workflows keep their standing', () => {
    // Every workflow written before this field existed is one a person wrote.
    // Defaulting to "untrusted" would retroactively demote all of them.
    expect(parseWorkflowInput(AUTHORED as never).origin).toBe('authored');
  });

  it('marks an imported package as imported', () => {
    const pkg = buildWorkflowPackage(parseWorkflowInput(AUTHORED as never));

    expect(importWorkflowPackage({ package: pkg }).origin).toBe('imported');
  });

  it('refuses to let a package declare its own trust level', () => {
    // The load-bearing case. The package file is written by whoever shares it,
    // so `origin: 'authored'` inside one is an assertion about itself. Taking
    // it at face value would make the field a decoration that any attacker
    // could set, rather than a fact the importer establishes.
    const pkg = buildWorkflowPackage(parseWorkflowInput(AUTHORED as never));
    const forged = {
      ...pkg,
      workflow: { ...pkg.workflow, origin: 'authored' as const },
    };

    expect(importWorkflowPackage({ package: forged }).origin).toBe('imported');
  });

  it('marks an agent proposal as proposed, with or without reuse', () => {
    const callable = {
      id: 'wp-publish',
      name: 'wp-publish',
      version: 1,
      purpose: 'publish a draft to wordpress',
      triggers: [{ id: 'parent', kind: 'parent', enabled: true }],
      pipelines: [{ id: 'p', name: 'P', pipes: [], edges: [] }],
    };

    // Composed from the catalog …
    const reusing = proposeWorkflow({
      purpose: 'publish a draft to wordpress',
      id: 'caller',
      catalog: [callable as never],
    });
    expect(reusing.reused).not.toHaveLength(0);
    expect(reusing.workflow.origin).toBe('proposed');

    // … and the stub it falls back to when nothing matches. Both are generated,
    // so both must be labelled; the fallback is the easier one to forget.
    const stub = proposeWorkflow({
      purpose: 'something nothing in the catalog does',
      id: 'lonely',
      catalog: [],
    });
    expect(stub.reused).toEqual([]);
    expect(stub.workflow.origin).toBe('proposed');
  });

  it('does not launder an import by extracting a pipeline out of it', () => {
    // Extraction copies pipes into a new document; nobody reviews them on the
    // way. If the copy came out `authored`, then import-then-extract would be
    // a two-step path from untrusted to trusted — and every capability gated
    // on this field would be gated on nothing.
    const imported = importWorkflowPackage({
      package: buildWorkflowPackage(parseWorkflowInput(AUTHORED as never)),
    });
    expect(imported.origin).toBe('imported');

    const { extracted } = extractPipeline(imported, {
      pipelineId: 'main',
      newWorkflowId: 'pulled-out',
    });

    expect(extracted.origin).toBe('imported');
  });

  it('survives the parse a save goes through', () => {
    // The field is only useful if it reaches storage, so it has to survive the
    // same parse every saved workflow passes through.
    const pkg = buildWorkflowPackage(parseWorkflowInput(AUTHORED as never));
    const imported = importWorkflowPackage({ package: pkg });

    expect(parseWorkflowInput(imported as never).origin).toBe('imported');
  });
});

describe('saving over a workflow', () => {
  it('cannot raise an imported workflow to authored', async () => {
    const ctx = createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) });
    const app = buildApp(ctx, { token: undefined });
    try {
      await ctx.workflows.put(parseWorkflowInput({ ...AUTHORED, origin: 'imported' } as never));

      // What the designer sent: the document without `origin`, which parses
      // as `authored`. And what a crafted request could send.
      for (const body of [{ ...AUTHORED }, { ...AUTHORED, origin: 'authored' }]) {
        const res = await app.inject({ method: 'PUT', url: '/api/workflows/wf', payload: body });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().origin).toBe('imported');
        expect((await ctx.workflows.get('wf'))!.origin).toBe('imported');
      }
    } finally {
      await app.close();
    }
  });

  it('leaves an authored workflow authored', async () => {
    const ctx = createContext({ databasePath: ':memory:', encryptionKey: randomBytes(32) });
    const app = buildApp(ctx, { token: undefined });
    try {
      const res = await app.inject({ method: 'PUT', url: '/api/workflows/wf', payload: AUTHORED });
      expect(res.json().origin).toBe('authored');
    } finally {
      await app.close();
    }
  });
});
