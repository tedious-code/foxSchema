/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/common/src/definitions/pipe.ts).
 */
import { z } from 'zod';
import { PIPE_NAME_MAX_LENGTH } from '@foxschema/workflow-contract';
import { contractSchema } from './contract.js';

// Retry policy applied per pipe, wrapping the batch executor. `attempts`
// counts re-tries after the first failure (0 = off). Only transient errors
// retry by default; the driver-level classifier decides what "transient" means.
export const retrySchema = z.object({
  attempts: z.number().int().min(0).max(20).default(3),
  backoff: z.enum(['fixed', 'exponential']).default('exponential'),
  maxDelayMs: z.number().int().min(0).default(60_000),
  jitter: z.boolean().default(true),
  on: z.enum(['transient', 'all']).default('transient'),
});
export type RetryDef = z.infer<typeof retrySchema>;

// Pipe roles. Triggers are entry pipes with no inputs — they emit the trigger
// payload (webhook body, schedule tick, manual params) as the first batch; the
// workflow-level `triggers` array remains the scheduling config and the
// reactive layer derives it from trigger pipes. Sources emit batches,
// transforms reshape them, sinks write them out. The concrete `type` (e.g.
// "source.file", "trigger.webhook") selects the connector; its `config` is
// validated by that connector's own schema at registration time.
export const pipeRoleSchema = z.enum(['trigger', 'source', 'transform', 'sink']);
export type PipeRole = z.infer<typeof pipeRoleSchema>;

// A pipe is one operator in a pipeline's streaming DAG — the finest-grained
// unit of the workflow > pipeline > pipe hierarchy.
export const pipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(PIPE_NAME_MAX_LENGTH).optional(),
  role: pipeRoleSchema,
  /** Pipe type id, e.g. "source.file.csv", "transform.mapper", "sink.postgres". */
  type: z.string().min(1),
  /**
   * Optional one-liner for agents/humans. Defaults to the pipe catalog name
   * when omitted.
   */
  intent: z.string().max(500).optional(),
  /** Connector-specific options; shape validated by the pipe implementation, not here. */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Optional reference to a stored credential (id) the connector needs. */
  credentialId: z.string().optional(),
  /** Intra-pipe data parallelism (concurrent writers/readers). 1 = ordered. */
  concurrency: z.number().int().min(1).max(64).default(1),
  /**
   * Wall-clock budget for one unit of work — a single transform call, a single
   * sink write, or the wait for a source's next batch. Unset means unbounded,
   * which is how a hung HTTP call or a stuck query holds a run open forever.
   *
   * A timeout is raised as transient, so a `retry` policy treats it like any
   * other flaky failure rather than failing the run outright.
   */
  timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  retry: retrySchema.optional(),
});
export type PipeDef = z.infer<typeof pipeSchema>;

// A streaming edge between two pipes of the same pipeline. Batches flow along
// these with backpressure — never across a pipeline boundary (pipelines are
// connected by completion edges on the workflow instead).
export const edgeSchema = z.object({
  from: z.string().min(1),
  /** Optional named output port on the source pipe (e.g. a row-switch port). */
  fromPort: z.string().optional(),
  to: z.string().min(1),
  /** Typed row contract carried by this streaming edge when known. */
  contract: contractSchema.optional(),
});
export type EdgeDef = z.infer<typeof edgeSchema>;
