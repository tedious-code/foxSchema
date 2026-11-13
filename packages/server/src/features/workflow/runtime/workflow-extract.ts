/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/workflow-extract.ts).
 */
import type { PipelineDef, WorkflowDef } from '@foxschema/workflow-engine';

/**
 * Promote a pipeline into a reusable callable workflow and replace it in the
 * parent with a thin `workflow.sub` caller (Agentic OS Phase B).
 */

export class ExtractPipelineError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'ExtractPipelineError';
  }
}

export interface ExtractPipelineInput {
  /** Pipeline id inside the source workflow to extract. */
  pipelineId: string;
  /** Id for the new reusable workflow. */
  newWorkflowId: string;
  /** Display name for the new workflow. */
  newWorkflowName?: string;
  /** Optional purpose override (defaults to pipeline.task / pipeline.name). */
  purpose?: string;
  tags?: string[];
  expectedResult?: string;
  /**
   * When true (default), replace the extracted pipeline in the source with a
   * single `workflow.sub` pipe that calls the new workflow.
   */
  replaceWithSub?: boolean;
  /** Pin the sub-workflow call to this version (defaults to 1 for the new doc). */
  pinVersion?: boolean;
}

export interface ExtractPipelineResult {
  /** Updated source workflow (version bumped). */
  source: WorkflowDef;
  /** New callable workflow with a parent trigger. */
  extracted: WorkflowDef;
}

export function extractPipeline(
  source: WorkflowDef,
  input: ExtractPipelineInput,
): ExtractPipelineResult {
  const pipeline = source.pipelines.find((p) => p.id === input.pipelineId);
  if (!pipeline) {
    throw new ExtractPipelineError(
      `pipeline not found: ${input.pipelineId}`,
      404,
    );
  }
  if (source.pipelines.length === 1 && input.replaceWithSub !== false) {
    // Still allowed — source becomes a thin sub-workflow wrapper.
  }
  const newId = input.newWorkflowId.trim();
  if (!newId) {
    throw new ExtractPipelineError('newWorkflowId is required', 400);
  }
  if (newId === source.id) {
    throw new ExtractPipelineError(
      'newWorkflowId must differ from the source workflow id',
      400,
    );
  }

  const purpose =
    input.purpose?.trim() ||
    pipeline.task?.trim() ||
    pipeline.name ||
    `Reusable: ${pipeline.id}`;
  const tags = input.tags ?? source.tags ?? [];
  const expectedResult = input.expectedResult ?? source.expectedResult;

  const extractedPipeline: PipelineDef = {
    ...pipeline,
    id: 'main',
    name: pipeline.name,
    ...(pipeline.task ? { task: pipeline.task } : { task: purpose }),
  };

  const extracted: WorkflowDef = {
    id: newId,
    name: input.newWorkflowName?.trim() || pipeline.name,
    purpose,
    tags,
    ...(expectedResult ? { expectedResult } : {}),
    ...(source.description
      ? { description: `Extracted from ${source.id}/${pipeline.id}` }
      : {}),
    version: 1,
    // Inherited, not reset. Extraction moves pipes from one document into
    // another; it does not review them. Minting `authored` here would make
    // extract-after-import a laundering path — import an n8n export, pull a
    // pipeline out of it, and the copy comes out trusted.
    origin: source.origin,
    pipelines: [extractedPipeline],
    dependencies: [],
    triggers: [
      { id: 'manual', kind: 'manual', enabled: true },
      {
        id: 'parent',
        kind: 'parent',
        enabled: true,
        allowFrom: [source.id],
      },
    ],
    onOverlap: 'skip',
    middleware: [],
    ...(source.inputSchema ? { inputSchema: source.inputSchema } : {}),
    ...(source.outputSchema ? { outputSchema: source.outputSchema } : {}),
  };

  const replaceWithSub = input.replaceWithSub !== false;
  if (!replaceWithSub) {
    return {
      source: { ...source, version: source.version + 1 },
      extracted,
    };
  }

  const subPipeline: PipelineDef = {
    id: pipeline.id,
    name: pipeline.name,
    ...(pipeline.task ? { task: pipeline.task } : { task: `Call ${newId}` }),
    pipes: [
      {
        id: 'call',
        role: 'transform',
        type: 'workflow.sub',
        intent: `Call reusable workflow ${newId}`,
        config: {
          workflowId: newId,
          ...(input.pinVersion !== false ? { workflowVersion: 1 } : {}),
        },
        concurrency: 1,
      },
    ],
    // Needs a source to feed the transform — use trigger payload.
    // Actually workflow.sub is a transform needing input. Add a trigger payload source.
    edges: [{ from: 'start', to: 'call' }],
  };
  // Fix: pipes need a source first
  subPipeline.pipes = [
    {
      id: 'start',
      role: 'source',
      type: 'source.triggerPayload',
      intent: 'Pass run payload into sub-workflow',
      config: {},
      concurrency: 1,
    },
    subPipeline.pipes[0]!,
  ];

  const pipelines = source.pipelines.map((p) =>
    p.id === pipeline.id ? subPipeline : p,
  );

  return {
    source: {
      ...source,
      version: source.version + 1,
      pipelines,
    },
    extracted,
  };
}
