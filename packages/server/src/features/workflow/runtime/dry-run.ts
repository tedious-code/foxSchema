/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/dry-run.ts).
 */
import {
  PipeRegistry,
  PipelineExecutor,
  planWorkflow,
  type AnyPipe,
  type PipeContext,
  type PipeDef,
  type PipelineDef,
  type RecordBatch,
  type SinkPipe,
  type SourcePipe,
  type WorkflowDef,
} from '@foxschema/workflow-engine';

/**
 * Run a workflow for real, but with its edges to the outside world replaced.
 *
 * Static validation says the document is well-formed and every pipe's config
 * parses. It cannot say whether the *pipeline* works: whether a map produces
 * the fields the next pipe expects, whether a condition routes anything down
 * the branch you built, whether a script throws on your actual data. Those only
 * show up by running it, and running it for real writes to production.
 *
 * So the executor, the port routing, the contracts and the retry policy are all
 * the genuine ones — only the boundaries are stood in for:
 *
 * - **sources** emit the caller's sample records instead of reading a file,
 *   querying a database or calling an API
 * - **sinks** record what they were handed instead of writing it
 * - **transforms that reach outside the process** (`sideEffects: true` — the AI
 *   generator, sub-workflow dispatch, every browser pipe) pass their batch
 *   through untouched, so a dry run never spends money, never starts a child
 *   run, and never drives a browser
 *
 * Everything else — maps, conditions, splits, merges, loops, scripts — executes
 * exactly as it would in production, which is the point.
 */

export interface DryRunPipeResult {
  pipelineId: string;
  pipeId: string;
  type: string;
  role: string;
  /** How the pipe was executed: for real, or stood in for. */
  mode: 'executed' | 'sample-source' | 'recorded-sink' | 'skipped-side-effect';
  batches: number;
  records: number;
  /** First few records the pipe produced (sinks: what they were handed). */
  sample: Record<string, unknown>[];
}

export interface DryRunResult {
  ok: boolean;
  error?: string;
  waves: string[][];
  pipes: DryRunPipeResult[];
}

/** Records kept per pipe, so a big sample cannot make the response huge. */
const SAMPLE_LIMIT = 5;

class Recorder {
  readonly byPipe = new Map<string, DryRunPipeResult>();

  note(
    pipelineId: string,
    pipe: PipeDef,
    mode: DryRunPipeResult['mode'],
    records: Record<string, unknown>[],
  ): void {
    const key = `${pipelineId}\0${pipe.id}`;
    const existing = this.byPipe.get(key) ?? {
      pipelineId,
      pipeId: pipe.id,
      type: pipe.type,
      role: pipe.role,
      mode,
      batches: 0,
      records: 0,
      sample: [],
    };
    existing.batches += 1;
    existing.records += records.length;
    if (existing.sample.length < SAMPLE_LIMIT) {
      existing.sample.push(...records.slice(0, SAMPLE_LIMIT - existing.sample.length));
    }
    this.byPipe.set(key, existing);
  }
}

/** Emits the caller's sample rows for whichever source pipe is running. */
function sampleSource(type: string, samples: Record<string, Record<string, unknown>[]>, recorder: Recorder, pipelineId: () => string): SourcePipe {
  return {
    type,
    role: 'source',
    // Config is not re-validated here: the save path already did it, and a dry
    // run should not fail on a path that is never going to be read.
    async *read(context: PipeContext): AsyncIterable<RecordBatch> {
      const records = samples[context.pipe.id] ?? [];
      recorder.note(pipelineId(), context.pipe, 'sample-source', records);
      if (records.length === 0) return;
      yield {
        id: `${context.pipe.id}:0:1-${records.length}`,
        partitionId: '0',
        records,
      };
    },
  };
}

function recordingSink(type: string, recorder: Recorder, pipelineId: () => string): SinkPipe {
  return {
    type,
    role: 'sink',
    async write(batch: RecordBatch, context: PipeContext): Promise<void> {
      recorder.note(pipelineId(), context.pipe, 'recorded-sink', batch.records);
    },
  };
}

function passthroughTransform(type: string, recorder: Recorder, pipelineId: () => string): AnyPipe {
  return {
    type,
    role: 'transform',
    async transform(batch: RecordBatch, context: PipeContext): Promise<RecordBatch> {
      recorder.note(pipelineId(), context.pipe, 'skipped-side-effect', batch.records);
      return batch;
    },
  } as AnyPipe;
}

/**
 * A registry with the same metadata as the real one — so port routing and
 * validation behave identically — but with boundary implementations swapped.
 */
function dryRunRegistry(
  real: PipeRegistry,
  workflow: WorkflowDef,
  samples: Record<string, Record<string, unknown>[]>,
  recorder: Recorder,
  pipelineId: () => string,
): PipeRegistry {
  const registry = new PipeRegistry();
  const seen = new Set<string>();

  for (const pipeline of workflow.pipelines) {
    for (const pipe of pipeline.pipes) {
      if (seen.has(pipe.type)) continue;
      seen.add(pipe.type);

      const metadata = real.metadata(pipe.type);
      const implementation =
        metadata.role === 'source'
          ? sampleSource(pipe.type, samples, recorder, pipelineId)
          : metadata.role === 'sink'
            ? recordingSink(pipe.type, recorder, pipelineId)
            : metadata.sideEffects
              ? passthroughTransform(pipe.type, recorder, pipelineId)
              : wrapExecuted(real.get(pipe), recorder, pipelineId);

      // Reuse the real metadata verbatim: the executor reads `outputs` from it
      // to route ports, so a stub with different ports would change the graph
      // the dry run is supposed to be testing.
      registry.register(
        Object.assign(implementation, { metadata: () => metadata }) as AnyPipe,
      );
    }
  }
  return registry;
}

/** The real transform, with its output recorded on the way past. */
function wrapExecuted(pipe: AnyPipe, recorder: Recorder, pipelineId: () => string): AnyPipe {
  if (pipe.role !== 'transform') return pipe;
  const inner = pipe;
  return {
    type: inner.type,
    role: 'transform',
    validateConfig: inner.validateConfig?.bind(inner),
    async transform(batch: RecordBatch, context: PipeContext) {
      const result = await inner.transform(batch, context);
      const produced =
        result === undefined
          ? []
          : result instanceof Map
            ? [...result.values()].flatMap((b) => b.records)
            : Array.isArray(result)
              ? result.flatMap((b) => b.records)
              : result.records;
      recorder.note(pipelineId(), context.pipe, 'executed', produced);
      return result;
    },
  } as AnyPipe;
}

export async function dryRunWorkflow(
  real: PipeRegistry,
  workflow: WorkflowDef,
  samples: Record<string, Record<string, unknown>[]> = {},
): Promise<DryRunResult> {
  const recorder = new Recorder();
  let current: PipelineDef | undefined;
  const registry = dryRunRegistry(real, workflow, samples, recorder, () => current!.id);
  // No stores are passed: a dry run must not write a run record, an event or a
  // checkpoint. It leaves nothing behind.
  const executor = new PipelineExecutor({ registry });

  try {
    for (const wave of planWorkflow(workflow).waves) {
      for (const pipelineId of wave) {
        current = workflow.pipelines.find((p) => p.id === pipelineId)!;
        await executor.execute(current, { workflowRunId: `dry-${workflow.id}` });
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
      waves: planWorkflow(workflow).waves,
      pipes: [...recorder.byPipe.values()],
    };
  }

  return {
    ok: true,
    waves: planWorkflow(workflow).waves,
    pipes: [...recorder.byPipe.values()],
  };
}
