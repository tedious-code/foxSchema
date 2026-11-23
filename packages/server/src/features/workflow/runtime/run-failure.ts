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

export interface FailedPipelineSummary {
  id: string;
  pipelineId: string;
  task?: string;
  error?: string;
}

export interface FailedPipeSummary {
  id: string;
  pipelineId: string;
  pipeId: string;
  name?: string;
  intent?: string;
  type?: string;
  error?: string;
}

export interface RunFailureSummary {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  status: WorkflowRunRecord['status'];
  workflowPurpose?: string;
  workflowExpectedResult?: string;
  error?: string;
  failedPipeline?: FailedPipelineSummary;
  failedPipelines?: FailedPipelineSummary[];
  failedPipe?: FailedPipeSummary;
  failedPipes?: FailedPipeSummary[];
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

  const failedPipelines: FailedPipelineSummary[] = pipelines
    .filter((p) => p.status === 'failed')
    .map((p) => {
      const def = workflow?.pipelines.find((cand) => cand.id === p.pipelineId);
      return {
        id: p.id,
        pipelineId: p.pipelineId,
        ...(def?.task ? { task: def.task } : {}),
        ...(p.error ? { error: p.error } : {}),
      };
    });
  const failedPipeline = failedPipelines[0];

  const failedPipes: FailedPipeSummary[] = pipes
    .filter((p) => p.status === 'failed')
    .map((p) => {
      const pipelineDef = workflow?.pipelines.find((cand) => cand.id === p.pipelineId);
      const pipeDef = pipelineDef?.pipes.find((cand) => cand.id === p.pipeId);
      return {
        id: p.id,
        pipelineId: p.pipelineId,
        pipeId: p.pipeId,
        ...(pipeDef?.name ? { name: pipeDef.name } : {}),
        ...(pipeDef?.intent ? { intent: pipeDef.intent } : {}),
        ...(pipeDef?.type ? { type: pipeDef.type } : {}),
        ...(p.error ? { error: p.error } : {}),
      };
    });
  const failedPipe = failedPipes[0];
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
    ...(failedPipeline ? { failedPipeline } : {}),
    ...(failedPipelines.length > 1 ? { failedPipelines } : {}),
    ...(failedPipe ? { failedPipe } : {}),
    ...(failedPipes.length > 1 ? { failedPipes } : {}),
    gateSkipped,
    aiFailovers,
    ...(inputTokens > 0 || outputTokens > 0
      ? { aiUsage: { inputTokens, outputTokens } }
      : {}),
  };
}
