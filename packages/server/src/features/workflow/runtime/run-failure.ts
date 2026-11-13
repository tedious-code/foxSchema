/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/run-failure.ts).
 */
import type {
  PipelineRunRecord,
  PipeRunRecord,
  RunEvent,
  WorkflowDef,
  WorkflowRunRecord,
} from '@foxschema/workflow-engine';

/**
 * Compact failure / outcome summary for agents and the Runs UI
 * (Agentic OS Phase E).
 */

export interface RunFailureSummary {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  status: WorkflowRunRecord['status'];
  workflowPurpose?: string;
  workflowExpectedResult?: string;
  error?: string;
  failedPipeline?: {
    id: string;
    pipelineId: string;
    task?: string;
    error?: string;
  };
  failedPipe?: {
    id: string;
    pipelineId: string;
    pipeId: string;
    intent?: string;
    type?: string;
    error?: string;
  };
  gateSkipped: Array<{
    pipelineId: string;
    error?: string;
  }>;
  aiFailovers: Array<{
    at: string;
    pipeId?: string;
    from?: string;
    to?: string;
    reason?: string;
  }>;
  aiUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export function buildRunFailureSummary(input: {
  run: WorkflowRunRecord;
  workflow?: WorkflowDef;
  pipelines: PipelineRunRecord[];
  pipes: PipeRunRecord[];
  events: RunEvent[];
}): RunFailureSummary {
  const { run, workflow, pipelines, pipes, events } = input;

  const failedPipeline = pipelines.find((p) => p.status === 'failed');
  const failedPipe = pipes.find((p) => p.status === 'failed');
  const gateSkipped = pipelines
    .filter((p) => p.status === 'skipped')
    .map((p) => ({
      pipelineId: p.pipelineId,
      ...(p.error ? { error: p.error } : {}),
    }));

  const aiFailovers = events
    .filter(
      (event) =>
        event.type === 'retry.attempt' &&
        event.data &&
        typeof event.data === 'object' &&
        (event.data as Record<string, unknown>).kind === 'ai.failover',
    )
    .map((event) => {
      const data = event.data as Record<string, unknown>;
      return {
        at: event.at,
        ...(event.pipeId ? { pipeId: event.pipeId } : {}),
        ...(typeof data.from === 'string' ? { from: data.from } : {}),
        ...(typeof data.to === 'string' ? { to: data.to } : {}),
        ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
      };
    });

  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (!event.data || typeof event.data !== 'object') continue;
    const usage = (event.data as Record<string, unknown>).aiUsage;
    if (!usage || typeof usage !== 'object') continue;
    const bag = usage as Record<string, unknown>;
    if (typeof bag.inputTokens === 'number') inputTokens += bag.inputTokens;
    if (typeof bag.outputTokens === 'number') outputTokens += bag.outputTokens;
  }

  const pipelineDef = failedPipeline
    ? workflow?.pipelines.find((p) => p.id === failedPipeline.pipelineId)
    : undefined;
  const failedPipePipeline = failedPipe
    ? workflow?.pipelines.find((p) => p.id === failedPipe.pipelineId)
    : undefined;
  const pipeDef =
    failedPipe && failedPipePipeline
      ? failedPipePipeline.pipes.find((p) => p.id === failedPipe.pipeId)
      : undefined;

  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    ...(workflow?.purpose ? { workflowPurpose: workflow.purpose } : {}),
    ...(workflow?.expectedResult
      ? { workflowExpectedResult: workflow.expectedResult }
      : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(failedPipeline
      ? {
          failedPipeline: {
            id: failedPipeline.id,
            pipelineId: failedPipeline.pipelineId,
            ...(pipelineDef?.task ? { task: pipelineDef.task } : {}),
            ...(failedPipeline.error ? { error: failedPipeline.error } : {}),
          },
        }
      : {}),
    ...(failedPipe
      ? {
          failedPipe: {
            id: failedPipe.id,
            pipelineId: failedPipe.pipelineId,
            pipeId: failedPipe.pipeId,
            ...(pipeDef?.intent ? { intent: pipeDef.intent } : {}),
            ...(pipeDef?.type ? { type: pipeDef.type } : {}),
            ...(failedPipe.error ? { error: failedPipe.error } : {}),
          },
        }
      : {}),
    gateSkipped,
    aiFailovers,
    ...(inputTokens > 0 || outputTokens > 0
      ? { aiUsage: { inputTokens, outputTokens } }
      : {}),
  };
}
