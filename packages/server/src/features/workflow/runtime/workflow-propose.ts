/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-propose.ts).
 */
import type { WorkflowDef } from '@foxschema/workflow-engine';

/**
 * Agentic OS Phase F — propose a thin wrapper workflow that prefers calling
 * reusable (parent-trigger) workflows over inventing new pipes.
 */

export interface ProposeWorkflowInput {
  /** What the caller wants accomplished. */
  purpose: string;
  /** Optional tags to bias catalog matching. */
  tags?: string[];
  /** New workflow id. */
  id: string;
  name?: string;
  /** Catalog of existing workflows (typically list() results). */
  catalog: WorkflowDef[];
  /** Max sub-workflow calls to include. */
  limit?: number;
}

export interface ProposeWorkflowResult {
  workflow: WorkflowDef;
  reused: Array<{ workflowId: string; purpose?: string; score: number }>;
  notes: string[];
}

export function proposeWorkflow(
  input: ProposeWorkflowInput,
): ProposeWorkflowResult {
  const purpose = input.purpose.trim();
  if (!purpose) {
    throw new Error('purpose is required');
  }
  const id = input.id.trim();
  if (!id) {
    throw new Error('id is required');
  }

  const scored = input.catalog
    // A catalog entry sharing the new id would be proposed as its own
    // sub-workflow. `assertSavable` rejects that cycle, so the proposal cannot
    // be saved and the reader is left to work out why from an error about a
    // workflow they did not write. Reachable in practice: re-proposing over an
    // existing id is how you regenerate one.
    .filter((workflow) => workflow.id !== id)
    .filter((workflow) =>
      workflow.triggers.some((t) => t.kind === 'parent' && t.enabled),
    )
    .map((workflow) => ({
      workflow,
      score: scoreReuse(workflow, purpose, input.tags ?? []),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const limit = input.limit ?? 3;
  const picked = scored.slice(0, limit);
  const notes: string[] = [];

  if (picked.length === 0) {
    notes.push(
      'No callable workflows matched purpose/tags. Created a stub with a manual trigger — author pipes or extract a reusable procedure first.',
    );
    return {
      workflow: {
        id,
        name: input.name?.trim() || id,
        purpose,
        tags: input.tags ?? [],
        version: 1,
        pipelines: [
          {
            id: 'main',
            name: 'Main',
            task: purpose,
            pipes: [
              {
                id: 'start',
                role: 'source',
                type: 'source.triggerPayload',
                intent: 'Accept trigger payload',
                config: {},
                concurrency: 1,
              },
            ],
            edges: [],
          },
        ],
        dependencies: [],
        triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
        onOverlap: 'skip',
        middleware: [],
        // Generated, not reviewed. A proposal is a suggestion until a person
        // reads it, and this is what says so to anything downstream.
        origin: 'proposed' as const,
      },
      reused: [],
      notes,
    };
  }

  const pipes = [
    {
      id: 'start',
      role: 'source' as const,
      type: 'source.triggerPayload',
      intent: 'Accept trigger payload',
      config: {},
      concurrency: 1,
    },
    ...picked.map((entry, index) => ({
      id: `call_${index + 1}`,
      role: 'transform' as const,
      type: 'workflow.sub',
      intent: `Reuse ${entry.workflow.id}: ${entry.workflow.purpose ?? entry.workflow.name}`,
      config: {
        workflowId: entry.workflow.id,
        workflowVersion: entry.workflow.version,
      },
      concurrency: 1,
    })),
  ];

  const edges = pipes.slice(0, -1).map((pipe, index) => ({
    from: pipe.id,
    to: pipes[index + 1]!.id,
  }));

  notes.push(
    `Composed ${picked.length} reusable workflow(s) via workflow.sub instead of generating new pipes.`,
  );

  return {
    workflow: {
      id,
      name: input.name?.trim() || id,
      purpose,
      tags: input.tags ?? [],
      version: 1,
      pipelines: [
        {
          id: 'main',
          name: 'Orchestrate',
          task: purpose,
          pipes,
          edges,
        },
      ],
      dependencies: [],
      triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
      onOverlap: 'skip',
      middleware: [],
      // Generated, not reviewed — see the note on the stub above.
      origin: 'proposed' as const,
    },
    reused: picked.map((entry) => ({
      workflowId: entry.workflow.id,
      ...(entry.workflow.purpose
        ? { purpose: entry.workflow.purpose }
        : {}),
      score: entry.score,
    })),
    notes,
  };
}

function scoreReuse(
  workflow: WorkflowDef,
  purpose: string,
  tags: string[],
): number {
  const haystack = [
    workflow.purpose ?? '',
    workflow.expectedResult ?? '',
    workflow.description ?? '',
    workflow.name,
    ...(workflow.tags ?? []),
    ...workflow.pipelines.map((p) => p.task ?? p.name),
  ]
    .join(' ')
    .toLowerCase();
  const purposeTokens = tokenize(purpose);
  let score = 0;
  for (const token of purposeTokens) {
    if (haystack.includes(token)) score += 2;
  }
  for (const tag of tags) {
    if ((workflow.tags ?? []).map((t) => t.toLowerCase()).includes(tag.toLowerCase())) {
      score += 5;
    } else if (haystack.includes(tag.toLowerCase())) {
      score += 2;
    }
  }
  return score;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}
