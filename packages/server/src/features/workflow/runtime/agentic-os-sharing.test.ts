/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/agentic-os-sharing.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { parseWorkflowInput } from '@foxschema/workflow-engine';
import { buildWorkflowPackage, findInlineSecrets } from './workflow-package.js';
import { proposeWorkflow } from './workflow-propose.js';

/**
 * The sharing path, attacked rather than demonstrated. `agentic-os.test.ts`
 * covers the happy path for each module; these are the cases where a wrong
 * answer costs something — a leaked token, or a proposal that cannot be saved.
 */

function httpWorkflow(config: unknown): never {
  return {
    id: 'wf', name: 'WF', version: 1,
    triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
    pipelines: [
      { id: 'main', name: 'Main', edges: [],
        pipes: [{ id: 'call', type: 'transform.http', role: 'transform', config }] },
    ],
  } as never;
}

describe('exporting a workflow that contains an inline secret', () => {
  it('flags a token pasted into a header', () => {
    const warnings = findInlineSecrets(
      httpWorkflow({
        request: {
          url: 'https://api.example.test/x',
          headers: { Authorization: 'Bearer sk-live-DEADBEEF' },
        },
      }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.path).toBe(
      'pipelines[main].pipes[call].config.request.headers.Authorization',
    );
  });

  it('flags a key smuggled through a URL, where the field name is innocent', () => {
    // The field is `url`, so a name-based check alone would miss this.
    const warnings = findInlineSecrets(
      httpWorkflow({ request: { url: 'https://api.example.test/x?api_key=SECRET' } }),
    );

    expect(warnings.map((w) => w.path)).toEqual([
      'pipelines[main].pipes[call].config.request.url (query "api_key")',
    ]);
  });

  it('stays quiet about references, which are the pattern to encourage', () => {
    // Flagging the recommended shape would train readers to ignore warnings.
    const warnings = findInlineSecrets(
      httpWorkflow({
        request: {
          url: 'https://api.example.test/x?api_key={{vars.apiKey}}',
          headers: { Authorization: 'Bearer {{vars.token}}' },
        },
        credentialId: 'cred-1',
      }),
    );

    expect(warnings).toEqual([]);
  });

  it('surfaces the warning on the package a user is about to share', () => {
    const pkg = buildWorkflowPackage(
      httpWorkflow({
        request: { url: 'https://x.test', headers: { Authorization: 'Bearer sk-live-1' } },
      }),
    );

    // The manifest still carries no secret material of its own …
    expect(JSON.stringify(pkg.manifest)).not.toContain('sk-live-1');
    // … but the workflow does, and saying so is the whole point: a package
    // that quietly ships a token is worse than one that admits it.
    expect(pkg.manifest.inlineSecretWarnings).toHaveLength(1);
    expect(JSON.stringify(pkg.workflow)).toContain('sk-live-1');
  });

  it('omits the field entirely when nothing was flagged', () => {
    const pkg = buildWorkflowPackage(
      httpWorkflow({ request: { url: 'https://x.test' } }),
    );

    expect(pkg.manifest.inlineSecretWarnings).toBeUndefined();
  });
});

describe('proposing a workflow over an existing id', () => {
  const callable = (id: string, purpose: string): never =>
    ({
      id, name: id, version: 1, purpose,
      triggers: [{ id: 'parent', kind: 'parent', enabled: true }],
      pipelines: [{ id: 'p', name: 'P', pipes: [], edges: [] }],
    }) as never;

  it('does not propose that a workflow call itself', () => {
    // Regenerating over an existing id is ordinary use. Proposing the target
    // as its own sub-workflow builds a cycle that assertSavable rejects, so
    // the user gets a save error about a workflow they never wrote.
    const result = proposeWorkflow({
      purpose: 'publish a draft to wordpress',
      id: 'wp-publish',
      catalog: [callable('wp-publish', 'publish a draft to wordpress')],
    });

    expect(result.reused).toEqual([]);
  });

  it('still reuses a different workflow with the same purpose', () => {
    const result = proposeWorkflow({
      purpose: 'publish a draft to wordpress',
      id: 'new-caller',
      catalog: [callable('wp-publish', 'publish a draft to wordpress')],
    });

    expect(result.reused.map((r) => r.workflowId)).toEqual(['wp-publish']);
    expect(() => parseWorkflowInput(result.workflow as never)).not.toThrow();
  });
});
