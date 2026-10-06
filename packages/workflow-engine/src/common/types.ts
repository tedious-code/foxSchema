/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/common/src/types.ts).
 */
import type { TriggerDef } from './definitions/workflow.js';
import { isTerminalRunStatus, TERMINAL_RUN_STATUSES } from '@foxschema/workflow-contract';

// Run lifecycle for a workflow run — the top-level record a trigger creates.
// `interrupted` is the crash/lease-expiry state that a resume treats exactly
// like `paused`. These are stored, so the set is append-only — never renumber
// or remove a state.
export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

// Terminal states are defined with the wire contract so the browser can test a
// run without loading the engine; this keeps them a subset of RunStatus.
const _terminalAreRunStatuses: readonly RunStatus[] = TERMINAL_RUN_STATUSES;
void _terminalAreRunStatuses;

/** States in which a run holds its workflow's place: admitted, not finished, not parked. */
export const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const satisfies readonly RunStatus[];

export { isTerminalRunStatus };

// Per-pipeline status within a workflow run. `skipped` is what a false run
// gate on a completion edge produces (vs `failed` — matters for alerting).
// `paused` is a pipeline stopped on a human gate — waiting for an OTP, a
// CAPTCHA, a setting. Distinct from `failed` because nothing is wrong, and
// distinct from `pending` because it has already run and asked.
export type PipelineRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'paused';

// Per-pipe status within a pipeline run.
export type PipeRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled';

// One execution of a workflow. Pipeline runs nest under it; pause/stop/
// continue are commands against this record.
export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  trigger: string;
  triggerId?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Owning instance id — always set (cluster of one in single-node mode). */
  instanceId: string;
  /** Set when this run was dispatched by a parent run's `workflow.sub` pipe. */
  parentRunId?: string;
  /** Environment whose variables this run resolved against. */
  environmentId?: string;
  /**
   * Variables resolved at admission (global then workflow-local, within
   * `environmentId`) and frozen onto the run — like the workflow snapshot, so
   * a resume/replay sees the values the run started with, not today's.
   */
  variables?: Record<string, unknown>;
  /**
   * When true, the executor emits truncated `batch.sample` events for pipe
   * I/O (per port). Opt-in so production webhook/cron runs stay lean.
   */
  debug?: boolean;
}


/** Result of dispatching a child workflow run from the data plane. */
export interface WorkflowCallResult {
  runId: string;
  status: RunStatus;
  /**
   * Whatever the child sent to `sink.response`, so a caller can use the answer
   * rather than only learn that it finished.
   *
   * Without this, composition is one-directional: a workflow can delegate but
   * not receive, which is why a caller wanting a child's result had to read a
   * fixture instead. Empty when the child collected nothing — an absent array
   * and "returned nothing" are the same thing to a caller.
   */
  output: Record<string, unknown>[];
}

/**
 * Engine-provided service for dispatching sub-workflow runs from a pipe. The
 * implementation carries the runtime circular-dependency guard (ancestor
 * chain) and the max nesting depth — see docs/engine-evolution.md.
 */
export interface WorkflowService {
  call(
    workflowId: string,
    payload?: unknown,
    options?: {
      signal?: AbortSignal;
      /** Pin to a specific stored workflow version when set. */
      workflowVersion?: number;
    },
  ): Promise<WorkflowCallResult>;
}

/** Immutable, sanitized input accepted by a workflow trigger. */
export interface TriggerInvocation {
  id: string;
  workflowId: string;
  triggerId: string;
  kind: TriggerDef['kind'];
  acceptedAt: string;
  payload?: unknown;
  idempotencyKey?: string;
  /** SHA-256 of the canonical trigger input, used to detect key reuse. */
  fingerprint?: string;
  metadata: Record<string, string>;
}

export interface TriggerScheduleState {
  workflowId: string;
  triggerId: string;
  nextFireAt: string;
  lastAcceptedAt?: string;
  scheduleFingerprint?: string;
  /**
   * Poll triggers only: dedup keys already seen, most recent last. Absent
   * means "never polled", which is what `onFirstPoll` decides the meaning of.
   * Bounded when written — see POLL_SEEN_KEYS_LIMIT.
   */
  seenKeys?: string[];
}

// One pipeline's execution within a workflow run.
export interface PipelineRunRecord {
  id: string;
  workflowRunId: string;
  pipelineId: string;
  status: PipelineRunStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface PipeRunRecord {
  id: string;
  workflowRunId: string;
  pipelineId: string;
  pipeId: string;
  status: PipeRunStatus;
  attempt: number;
  processedBatches: number;
  processedRecords: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

// Append-only run timeline. Feeds the run monitor and the audit trail; on
// reconnect an SSE client replays from the last seen `seq`.
export interface RunEvent {
  seq: number;
  workflowRunId: string;
  at: string;
  type:
    | 'run.status'
    | 'pipeline.status'
    | 'pipe.status'
    | 'batch.progress'
    | 'batch.sample'
    | 'retry.attempt'
    | 'reject'
    /** The run's response payload, for a caller awaiting it synchronously. */
    | 'run.output'
    /**
     * The run stopped and is waiting for a person. Carries the prompt and the
     * field *labels* so a UI can build the form — never an answer, since
     * anyone who can read the run can read this.
     */
    | 'human.input.requested'
    /** Someone answered; the run is about to be resumed. */
    | 'human.input.received'
    /** A line a pipe logged; `data.level` is `info`, `warn` or `error`. */
    | 'pipe.log';
  pipelineId?: string;
  pipeId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

// Resume point. Keyed by (workflowRunId, pipelineId, pipeId, partitionId)
// from the start so linear (one partition), parallel (per branch), and
// concurrent (per partition) modes all share one checkpoint shape.
export interface Checkpoint {
  workflowRunId: string;
  pipelineId: string;
  pipeId: string;
  partitionId: string;
  cursor: Record<string, unknown>;
  updatedAt: string;
}
