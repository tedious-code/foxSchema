/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-mutation.ts).
 */
import type { DependencyDef, PipelineDef, WorkflowDef } from '@foxschema/workflow-engine';

/**
 * Structural edits to a saved workflow, for callers that want to *extend* one
 * rather than re-author it — an agent adding a nightly reconciliation pipeline
 * to an existing import workflow, say. Regenerating the whole document to add
 * one pipeline is how an agent silently drops the parts it did not think to
 * mention.
 *
 * These are pure: they return a new document and never touch storage. The route
 * runs the result through the same `parseWorkflowInput` + cycle + middleware
 * checks a human save goes through, so a mutation cannot install a workflow a
 * human could not have saved. Validation *after* the merge is deliberate — the
 * combination is what has to be legal, not the fragment.
 */

export class WorkflowMutationError extends Error {
  constructor(
    message: string,
    /**
     * `409` for a state conflict the caller can resolve by re-reading, `400`
     * for a malformed ask, `404` for a target that is not there.
     */
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = 'WorkflowMutationError';
  }
}

export interface AddPipelineInput {
  pipeline: PipelineDef;
  /**
   * Completion edges to create, so the new pipeline is wired into the run order
   * rather than becoming a second, silently-parallel root.
   */
  dependsOn?: { from: string; on?: DependencyDef['on']; gate?: string }[];
  /** Pipelines that should now wait on the new one. */
  feeds?: { to: string; on?: DependencyDef['on']; gate?: string }[];
  /** Replace an existing pipeline of the same id instead of conflicting. */
  replace?: boolean;
}

/**
 * `expectedVersion` is optimistic concurrency, and it matters more here than
 * for a human save: two agents extending the same workflow at once would
 * otherwise each read version N and the second write would erase the first
 * one's pipeline with no error anywhere.
 */
export function assertExpectedVersion(
  workflow: WorkflowDef,
  expectedVersion?: number,
): void {
  if (expectedVersion !== undefined && workflow.version !== expectedVersion) {
    throw new WorkflowMutationError(
      `workflow ${workflow.id} is at version ${workflow.version}, not ${expectedVersion}; re-read it and retry`,
    );
  }
}

export function addPipeline(
  workflow: WorkflowDef,
  input: AddPipelineInput,
): WorkflowDef {
  const existing = workflow.pipelines.findIndex(
    (pipeline) => pipeline.id === input.pipeline.id,
  );
  if (existing >= 0 && !input.replace) {
    throw new WorkflowMutationError(
      `workflow ${workflow.id} already has a pipeline ${input.pipeline.id}; pass replace to overwrite it`,
    );
  }

  const known = new Set(workflow.pipelines.map((pipeline) => pipeline.id));
  known.add(input.pipeline.id);
  for (const edge of input.dependsOn ?? []) {
    if (!known.has(edge.from)) {
      throw new WorkflowMutationError(
        `dependsOn references unknown pipeline ${edge.from}`,
        400,
      );
    }
  }
  for (const edge of input.feeds ?? []) {
    if (!known.has(edge.to)) {
      throw new WorkflowMutationError(
        `feeds references unknown pipeline ${edge.to}`,
        400,
      );
    }
  }

  const pipelines =
    existing >= 0
      ? workflow.pipelines.map((pipeline, index) =>
          index === existing ? input.pipeline : pipeline,
        )
      : [...workflow.pipelines, input.pipeline];

  // A replace re-declares its own inbound edges, so drop the old ones rather
  // than merging two generations of wiring.
  const kept =
    existing >= 0
      ? workflow.dependencies.filter((dep) => dep.to !== input.pipeline.id)
      : workflow.dependencies;

  const added: DependencyDef[] = [
    ...(input.dependsOn ?? []).map((edge) => ({
      from: edge.from,
      to: input.pipeline.id,
      on: edge.on ?? ('success' as const),
      ...(edge.gate ? { gate: edge.gate } : {}),
    })),
    ...(input.feeds ?? []).map((edge) => ({
      from: input.pipeline.id,
      to: edge.to,
      on: edge.on ?? ('success' as const),
      ...(edge.gate ? { gate: edge.gate } : {}),
    })),
  ];

  return {
    ...workflow,
    version: workflow.version + 1,
    pipelines,
    dependencies: dedupeDependencies([...kept, ...added]),
  };
}

export function removePipeline(
  workflow: WorkflowDef,
  pipelineId: string,
): WorkflowDef {
  if (!workflow.pipelines.some((pipeline) => pipeline.id === pipelineId)) {
    throw new WorkflowMutationError(
      `workflow ${workflow.id} has no pipeline ${pipelineId}`,
      404,
    );
  }
  if (workflow.pipelines.length === 1) {
    throw new WorkflowMutationError(
      `pipeline ${pipelineId} is the only pipeline in ${workflow.id}; delete the workflow instead`,
    );
  }

  // Refuse rather than cascade: silently dropping the edges of pipelines that
  // wait on this one would change *their* run conditions, which is not what
  // "remove one pipeline" asked for.
  const dependents = workflow.dependencies
    .filter((dep) => dep.from === pipelineId)
    .map((dep) => dep.to);
  if (dependents.length > 0) {
    throw new WorkflowMutationError(
      `pipeline ${pipelineId} is depended on by ${[...new Set(dependents)].join(', ')}; re-wire or remove those first`,
    );
  }

  return {
    ...workflow,
    version: workflow.version + 1,
    pipelines: workflow.pipelines.filter((pipeline) => pipeline.id !== pipelineId),
    dependencies: workflow.dependencies.filter((dep) => dep.to !== pipelineId),
  };
}

/** Last writer wins per `from→to`, so a repeated add is idempotent in shape. */
function dedupeDependencies(dependencies: DependencyDef[]): DependencyDef[] {
  const byEdge = new Map<string, DependencyDef>();
  for (const dep of dependencies) byEdge.set(`${dep.from}\0${dep.to}`, dep);
  return [...byEdge.values()];
}
