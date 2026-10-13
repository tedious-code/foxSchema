/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/runtime/src/executor.ts).
 */
import type { CredentialStore } from '../common/index.js';
import { HumanInputRequired, humanInputRequestSchema } from '../common/index.js';
import type {
  CheckpointStore,
  EdgeDef,
  HumanInputRequest,
  HumanInputStore,
  EventStore,
  PipeDef,
  PipeRunRecord,
  PipelineDef,
  RetryDef,
  RunStore,
  TriggerInvocation,
  WorkflowService,
} from '../common/index.js';
import {
  createInfrastructureContext,
  type InfrastructureContext,
  type PipeLogger,
} from '../sdk/index.js';
import {
  PipeRegistry,
  type HumanInputGateway,
  type PipeContext,
  type AnyPipe,
  type RecordBatch,
  type RunOutputCollector,
  type SinkPipe,
  type SourcePipe,
  type TransformPipe,
} from '../registry/index.js';
import { planExecution } from '../compiler/index.js';
import { applyContract } from './contracts.js';
import { scopeCredentialsToPipe } from './credential-scope.js';
import { errorMessage, isAbort, throwIfAborted } from './errors.js';
import {
  assertKnownFromPorts,
  defaultOutputPort,
  edgeMatchesPort,
  normalizePortedBatches,
  type TransformOutput,
} from './ports.js';

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly transient = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExecutionError';
  }
}

export class TransientExecutionError extends ExecutionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, true, options);
    this.name = 'TransientExecutionError';
  }
}

export interface PipelineExecutionContext {
  workflowRunId: string;
  invocation?: TriggerInvocation;
  signal?: AbortSignal;
  /** Engine-injected sub-workflow dispatch for workflow.sub pipes. */
  workflows?: WorkflowService;
  /** Run-scoped variables resolved from the run's environment. */
  variables?: Record<string, unknown>;
  /** When true, emit truncated `batch.sample` events for pipe I/O. */
  debug?: boolean;
  /**
   * Set when a caller is waiting on this run's answer. `sink.response` writes
   * into it; the runner persists the result. Absent for fire-and-forget runs,
   * which is what makes the same workflow callable either way.
   */
  output?: RunOutputCollector;
}

/** Max records kept in a debug sample (full batch count is still reported). */
const DEBUG_SAMPLE_RECORDS = 20;
/** Soft cap on JSON size for sampled records. */
const DEBUG_SAMPLE_BYTES = 16 * 1024;
/**
 * Log lines one pipe may add to its run's timeline. A pipe that logs per
 * record would otherwise write more events than the run has records.
 */
const PIPE_LOG_LIMIT = 200;

/**
 * `store` with each secret revealed once for the life of `cache`. Updating a
 * secret (a refreshed token, a new cookie) drops the cached copy, and a failed
 * reveal is not remembered.
 */
function cacheRevealedSecrets(
  store: CredentialStore,
  cache: Map<string, Promise<Record<string, unknown> | undefined>>,
): CredentialStore {
  const cached: CredentialStore = {
    create: (input) => store.create(input),
    list: () => store.list(),
    get: (id) => store.get(id),
    remove: (id) => store.remove(id),
    revealSecret(id) {
      let secret = cache.get(id);
      if (!secret) {
        secret = store.revealSecret(id);
        cache.set(id, secret);
        secret.catch(() => cache.delete(id));
      }
      return secret;
    },
  };
  if (store.updateSecret) {
    const update = store.updateSecret.bind(store);
    cached.updateSecret = async (id, patch) => {
      cache.delete(id);
      return update(id, patch);
    };
  }
  return cached;
}

export interface PipelineExecutorOptions {
  /**
   * Lets a pipe stop the run and ask a person for something (an OTP, a
   * CAPTCHA, a missing setting). Absent in a dry run or preview, where there
   * is nobody to ask — a pipe that needs input then fails, which is correct:
   * pausing with no way to answer would park the run forever.
   */
  humanInputs?: HumanInputStore;
  registry: PipeRegistry;
  checkpoints?: CheckpointStore;
  events?: EventStore;
  runs?: RunStore;
  credentials?: CredentialStore;
  infrastructure?: InfrastructureContext;
  logger?: PipeLogger;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** A completed downstream traversal: `undefined` on success, else the error. */
type Settled = { error: unknown } | undefined;

/** Hands one batch to a downstream pipe; `inbound` names the edge it arrived on. */
type Dispatch = (
  pipe: PipeDef,
  batch: RecordBatch,
  inbound?: { fromPipe: string; fromPort: string },
) => Promise<void>;

/**
 * Bound one unit of a pipe's work by `pipe.timeoutMs`.
 *
 * Unbounded work is how one workflow degrades another: a hung request or a
 * stuck query holds its run, its in-flight slot and its connection open
 * indefinitely, and nothing else on the instance gets them back. The timeout is
 * raised as *transient* so an existing `retry` policy treats it like any other
 * flaky failure.
 *
 * This bounds work that yields to the event loop, which is what a stuck I/O
 * call does. It cannot interrupt a synchronous busy loop — nothing on this
 * thread can. That needs a real thread boundary; see sandbox.ts.
 */
async function withDeadline<T>(
  operation: () => Promise<T>,
  pipe: PipeDef,
  what: string,
): Promise<T> {
  const budget = pipe.timeoutMs;
  if (!budget) return operation();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TransientExecutionError(
                `pipe ${pipe.id} ${what} exceeded its ${budget}ms timeout`,
              ),
            ),
          budget,
        );
        // The run should not be held open by this timer alone.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PipelineExecutor {
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly infrastructure: InfrastructureContext;
  /**
   * Per-execution PipeRunRecord cache so markPipe doesn't re-read the pipe
   * list from storage on every batch (O(batches) queries otherwise — Loop
   * with size 1 makes that O(records)). Keyed run:pipeline:pipe; entries are
   * evicted when execute() finishes that pipeline.
   */
  private readonly pipeRecords = new Map<string, PipeRunRecord>();
  /**
   * One update chain per pipe. `markPipe` is a read-modify-write over the
   * cached record, and its first touch per execution awaits storage — with
   * batches in flight concurrently, two calls would read the same counters and
   * both write `n + 1`, losing progress. Chaining per pipe keeps each pipe's
   * updates ordered without serialising unrelated pipes.
   */
  private readonly pipeUpdates = new Map<string, Promise<void>>();
  /** Log lines recorded per run:pipeline:pipe, evicted with the records above. */
  private readonly logCounts = new Map<string, number>();
  /** Revealed secrets per run:pipeline — see {@link cacheRevealedSecrets}. */
  private readonly secretCaches = new Map<string, Map<string, Promise<Record<string, unknown> | undefined>>>();

  constructor(private readonly options: PipelineExecutorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.infrastructure =
      options.infrastructure ??
      createInfrastructureContext({
        credentials: options.credentials,
        logger: options.logger,
      });
  }

  /** Tell each sink the run uses that the run is over (see `SinkPipe.finishRun`). */
  async finishRun(workflowRunId: string, workflow: { pipelines: PipelineDef[] }): Promise<void> {
    const seen = new Set<AnyPipe>();
    for (const pipe of workflow.pipelines.flatMap((pipeline) => pipeline.pipes)) {
      if (pipe.role !== 'sink') continue;
      let connector: AnyPipe;
      try {
        connector = this.options.registry.get(pipe);
      } catch {
        continue; // a type no longer registered has nothing to release
      }
      if (seen.has(connector) || connector.role !== 'sink') continue;
      seen.add(connector);
      try {
        await connector.finishRun?.(workflowRunId);
      } catch {
        // Releasing state must not turn a finished run into a failed one.
      }
    }
  }

  async execute(
    pipeline: PipelineDef,
    execution: PipelineExecutionContext,
  ): Promise<void> {
    planExecution(pipeline);
    const pipes = new Map(pipeline.pipes.map((pipe) => [pipe.id, pipe]));
    assertKnownFromPorts(this.options.registry, pipes, pipeline.edges);
    const inbound = new Map(pipeline.pipes.map((pipe) => [pipe.id, 0]));
    const downstream = new Map(
      pipeline.pipes.map((pipe) => [pipe.id, [] as EdgeDef[]]),
    );
    for (const edge of pipeline.edges) {
      inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
      downstream.get(edge.from)!.push(edge);
    }
    const roots = pipeline.pipes.filter((pipe) => inbound.get(pipe.id) === 0);
    if (roots.some((pipe) => pipe.role !== 'source' && pipe.role !== 'trigger')) {
      throw new ExecutionError('every pipeline root must be a source or trigger');
    }

    // First sample only per (pipe, direction, port) so large streams don't
    // flood the event log. Keyed for this pipeline execution only.
    const sampledKeys = new Set<string>();

    const dispatch: Dispatch = async (pipe, batch, inbound) => {
      throwIfAborted(execution.signal);
      const connector = this.options.registry.get(pipe);
      const context = await this.connectorContext(pipeline, pipe, execution);
      await this.markPipe(context, 'running');
      try {
        const isTransform = connector.role === 'transform';
        if (!isTransform && connector.role !== 'sink') {
          throw new ExecutionError(
            `source pipe ${pipe.id} cannot receive an input batch`,
          );
        }
        await this.captureSample(
          execution,
          pipeline.id,
          pipe.id,
          'in',
          inbound?.fromPort ?? 'in',
          batch,
          sampledKeys,
          inbound,
        );
        const result = await this.withRetry(
          pipe,
          connector,
          context,
          execution.workflowRunId,
          pipeline.id,
          (): Promise<TransformOutput | void> =>
            isTransform
              ? (connector as TransformPipe).transform(batch, context)
              : (connector as SinkPipe).write(batch, context),
        );
        if (result.skipped) {
          await this.markPipe(context, 'skipped', batch);
          return;
        }
        if (isTransform) {
          await this.routeOutput(
            pipes,
            downstream.get(pipe.id)!,
            result.value as TransformOutput,
            pipe,
            dispatch,
            execution,
            pipeline.id,
            sampledKeys,
          );
        }
        await this.saveCheckpoint(pipeline.id, pipe.id, execution, batch);
        await this.markPipe(context, 'success', batch);
      } catch (error) {
        await this.markPipe(
          context,
          isAbort(error) ? 'cancelled' : 'failed',
          batch,
          error,
        );
        throw error;
      }
    };

    try {
      await Promise.all(
        roots.map((pipe) =>
          this.runSource(
            pipeline,
            pipe,
            pipes,
            downstream.get(pipe.id)!,
            execution,
            dispatch,
            sampledKeys,
          ),
        ),
      );
    } finally {
      // Evict this execution's cached pipe records — the executor instance is
      // long-lived and must not accumulate per-run state.
      const prefix = `${execution.workflowRunId}\0${pipeline.id}\0`;
      for (const map of [this.pipeRecords, this.pipeUpdates, this.logCounts, this.secretCaches]) {
        for (const key of map.keys()) {
          if (key.startsWith(prefix)) map.delete(key);
        }
      }
    }
  }

  private async runSource(
    pipeline: PipelineDef,
    pipe: PipeDef,
    pipes: Map<string, PipeDef>,
    children: EdgeDef[],
    execution: PipelineExecutionContext,
    dispatch: Dispatch,
    sampledKeys: Set<string>,
  ): Promise<void> {
    let failures = 0;
    while (true) {
      const context = await this.connectorContext(pipeline, pipe, execution);
      const connector = this.options.registry.get(pipe) as SourcePipe;
      await this.markPipe(context, 'running');
      /**
       * Batches in flight through the downstream chain. Awaiting each batch's
       * full traversal before reading the next one makes a pipeline take the
       * *sum* of its stages: nothing is read while a row is being written.
       * `pipe.concurrency` is how many batches may travel at once, so read,
       * transform and write overlap.
       *
       * The window is drained strictly from the head, which is what keeps
       * checkpoints honest — a cursor may only advance across a contiguous
       * run of completed batches, or a crash-resume would skip whatever was
       * still in flight behind it.
       */
      const inFlight: { batch: RecordBatch; settled: Promise<Settled> }[] = [];
      /**
       * One window per pipeline, sized by the largest `concurrency` any of its
       * pipes asks for — not just the source's.
       *
       * A pipeline is a single stream: a batch occupies the whole chain until
       * it lands. So "how many batches are in flight" is a property of the
       * pipeline, and reading only the source's number made the knob on a
       * transform or a sink do nothing at all. Someone setting `concurrency: 4`
       * on a Postgres sink means "write four at once", and now gets it.
       */
      const limit = Math.max(
        1,
        ...[...pipes.values()].map((candidate) => candidate.concurrency ?? 1),
      );

      const drainHead = async (): Promise<void> => {
        const head = inFlight.shift();
        if (!head) return;
        const failure = await head.settled;
        if (failure) throw failure.error;
        await this.saveCheckpoint(pipeline.id, pipe.id, execution, head.batch);
        await this.markPipe(context, 'running', head.batch);
      };

      try {
        // Iterated by hand so the *wait for the next batch* can be bounded too:
        // a source hung on a request is as damaging as a hung sink, and
        // `for await` gives nowhere to put the deadline.
        const batches = connector.read(context)[Symbol.asyncIterator]();
        while (true) {
          const next = await withDeadline(
            () => batches.next(),
            pipe,
            'read',
          );
          if (next.done) break;
          const batch = next.value;
          throwIfAborted(execution.signal);
          validateBatch(batch, pipe.id);
          // Never rejects: a failure is carried as a value so a batch that
          // fails while others are still running can't surface as an
          // unhandled rejection before the head reaches it.
          const settled = this.routeOutput(
            pipes,
            children,
            batch,
            pipe,
            dispatch,
            execution,
            pipeline.id,
            sampledKeys,
          ).then(
            () => undefined,
            (error: unknown) => ({ error }),
          );
          inFlight.push({ batch, settled });
          if (inFlight.length >= limit) await drainHead();
        }
        while (inFlight.length > 0) await drainHead();
        await this.markPipe(context, 'success');
        return;
      } catch (error) {
        // Let whatever is still travelling finish before retrying or failing,
        // so a retry attempt never overlaps the previous one's writes.
        if (inFlight.length > 0) {
          await Promise.all(inFlight.splice(0).map((entry) => entry.settled));
        }
        const action = await this.resolveErrorAction(
          pipe,
          connector,
          context,
          failures,
          error,
        );
        if (action === 'skip') {
          await this.markPipe(context, 'skipped', undefined, error);
          return;
        }
        if (action !== 'retry') {
          await this.markPipe(
            context,
            isAbort(error) ? 'cancelled' : 'failed',
            undefined,
            error,
          );
          throw error;
        }
        failures++;
        await this.recordRetry(
          execution.workflowRunId,
          pipeline.id,
          pipe.id,
          failures,
          error,
        );
        await this.wait(pipe.retry!, failures);
      }
    }
  }

  private async routeOutput(
    pipes: Map<string, PipeDef>,
    edges: EdgeDef[],
    output: TransformOutput,
    pipe: PipeDef,
    dispatch: Dispatch,
    execution: PipelineExecutionContext,
    pipelineId: string,
    sampledKeys: Set<string>,
  ): Promise<void> {
    const defaultPort = defaultOutputPort(this.options.registry, pipe);
    for (const item of normalizePortedBatches(output, defaultPort)) {
      await this.captureSample(
        execution,
        pipelineId,
        pipe.id,
        'out',
        item.port,
        item.batch,
        sampledKeys,
      );
      await this.send(
        pipes,
        edges,
        item.batch,
        item.port,
        defaultPort,
        dispatch,
        execution,
        pipelineId,
        pipe.id,
      );
    }
  }

  private async send(
    pipes: Map<string, PipeDef>,
    edges: EdgeDef[],
    batch: RecordBatch,
    port: string,
    defaultPort: string,
    dispatch: Dispatch,
    execution: PipelineExecutionContext,
    pipelineId: string,
    fromPipe: string,
  ): Promise<void> {
    const routed = edges.filter((edge) =>
      edgeMatchesPort(edge, port, defaultPort),
    );
    await Promise.all(
      routed.map(async (edge) => {
        const target = pipes.get(edge.to);
        if (!target) throw new ExecutionError(`unknown pipe ${edge.to}`);
        let next = batch;
        if (edge.contract) {
          const applied = applyContract(batch, edge.contract);
          if (applied.rejected.length > 0) {
            await this.options.events?.append({
              workflowRunId: execution.workflowRunId,
              pipelineId,
              pipeId: target.id,
              at: this.now(),
              type: 'reject',
              message: `contract rejected ${applied.rejected.length} row(s)`,
              data: { count: applied.rejected.length },
            });
          }
          if (applied.batch.records.length === 0) return;
          next = applied.batch;
        }
        await dispatch(target, next, { fromPipe, fromPort: port });
      }),
    );
  }

  /**
   * Persist a truncated batch sample for the designer Inspector. No-op unless
   * the run opted into debug and this (pipe, direction, port) is still empty.
   */
  private async captureSample(
    execution: PipelineExecutionContext,
    pipelineId: string,
    pipeId: string,
    direction: 'in' | 'out',
    port: string,
    batch: RecordBatch,
    sampledKeys: Set<string>,
    inbound?: { fromPipe: string; fromPort: string },
  ): Promise<void> {
    if (!execution.debug || !this.options.events) return;
    // Inputs key by upstream edge so fan-in from true/false/rejects stay distinct.
    const key =
      direction === 'in' && inbound
        ? `${pipeId}\0in\0${inbound.fromPipe}\0${inbound.fromPort}`
        : `${pipeId}\0${direction}\0${port}`;
    if (sampledKeys.has(key)) return;
    sampledKeys.add(key);
    const { records, truncated } = truncateRecords(batch.records);
    await this.options.events.append({
      workflowRunId: execution.workflowRunId,
      pipelineId,
      pipeId,
      at: this.now(),
      type: 'batch.sample',
      data: {
        direction,
        port,
        batchId: batch.id,
        partitionId: batch.partitionId,
        recordCount: batch.records.length,
        records,
        truncated,
        ...(inbound
          ? { fromPipe: inbound.fromPipe, fromPort: inbound.fromPort }
          : {}),
      },
    });
  }

  /**
   * The pipe's half of human-in-the-loop. `require` throws rather than
   * returning: the run cannot proceed, and a pipe author who forgets to await
   * or return should still stop rather than carry on with undefined.
   */
  private humanInputGateway(
    pipeline: PipelineDef,
    pipe: PipeDef,
    execution: PipelineExecutionContext,
  ): HumanInputGateway | undefined {
    const store = this.options.humanInputs;
    if (!store) return undefined;
    return {
      get: (key: string) => store.answerFor(execution.workflowRunId, key),
      require: (request: HumanInputRequest): never => {
        // Parsed here so a malformed request fails at the pipe that wrote it,
        // with that pipe's identity, rather than later in a store write.
        throw new HumanInputRequired(humanInputRequestSchema.parse(request));
      },
    };
  }

  private async connectorContext(
    pipeline: PipelineDef,
    pipe: PipeDef,
    execution: PipelineExecutionContext,
  ): Promise<PipeContext> {
    const checkpoint = await this.options.checkpoints?.get(
      execution.workflowRunId,
      pipeline.id,
      pipe.id,
      '0',
    );
    // Per-pipe logger. What a pipe logs lands in its run's timeline with
    // pipeline/pipe identity, where the Runs panel, the failure summary and a
    // log sink can all read it. AI failover keeps the event it always had.
    const baseLogger = this.infrastructure.logger;
    const events = this.options.events;
    const logKey = `${execution.workflowRunId}\0${pipeline.id}\0${pipe.id}`;
    const record = (
      level: 'info' | 'warn' | 'error',
      message: string,
      data?: Record<string, unknown>,
    ): void => {
      if (!events) return;
      const count = (this.logCounts.get(logKey) ?? 0) + 1;
      this.logCounts.set(logKey, count);
      if (count > PIPE_LOG_LIMIT) return;
      void events
        .append({
          workflowRunId: execution.workflowRunId,
          pipelineId: pipeline.id,
          pipeId: pipe.id,
          at: this.now(),
          type: 'pipe.log',
          message:
            count === PIPE_LOG_LIMIT
              ? `${message} (later lines from this pipe are not recorded)`
              : message,
          data: { ...(data ?? {}), level },
        })
        // A log line is not worth failing the run over.
        .catch(() => undefined);
    };
    const logger = {
      info: (message: string, data?: Record<string, unknown>) => {
        baseLogger.info(message, data);
        record('info', message, data);
      },
      warn: (message: string, data?: Record<string, unknown>) => {
        baseLogger.warn(message, data);
        if (message === 'ai.failover' && events) {
          void events.append({
            workflowRunId: execution.workflowRunId,
            pipelineId: pipeline.id,
            pipeId: pipe.id,
            at: this.now(),
            type: 'retry.attempt',
            message:
              typeof data?.reason === 'string' ? data.reason : 'AI failover',
            data: { kind: 'ai.failover', ...(data ?? {}) },
          });
          return;
        }
        record('warn', message, data);
      },
      error: (message: string, data?: Record<string, unknown>) => {
        baseLogger.error(message, data);
        record('error', message, data);
      },
    };

    // Revealed once per pipeline run, not per batch: a linked FoxSchema
    // connection is an HTTP call, and a sink asks for its secret every batch.
    const cacheKey = `${execution.workflowRunId}\0${pipeline.id}\0`;
    let secrets = this.secretCaches.get(cacheKey);
    if (!secrets) {
      secrets = new Map();
      this.secretCaches.set(cacheKey, secrets);
    }
    const credentials = this.options.credentials
      ? cacheRevealedSecrets(this.options.credentials, secrets)
      : undefined;

    return {
      workflowRunId: execution.workflowRunId,
      pipelineId: pipeline.id,
      pipe,
      checkpoint,
      invocation: execution.invocation,
      signal: execution.signal,
      // Scoped, not the shared store: a pipe may only reveal credentials its
      // own definition names. See credential-scope.ts.
      credentials: credentials ? scopeCredentialsToPipe(credentials, pipe) : undefined,
      infrastructure: {
        ...this.infrastructure,
        logger,
        ...(credentials ? { secrets: { get: (id: string) => credentials.revealSecret(id) } } : {}),
      },
      workflows: execution.workflows,
      variables: execution.variables,
      output: execution.output,
      humanInput: this.humanInputGateway(pipeline, pipe, execution),
    };
  }

  private async withRetry<T>(
    pipe: PipeDef,
    connector: AnyPipe,
    context: PipeContext,
    workflowRunId: string,
    pipelineId: string,
    operation: () => Promise<T>,
  ): Promise<{ value: T; skipped?: false } | { skipped: true }> {
    let failures = 0;
    while (true) {
      try {
        return { value: await withDeadline(operation, pipe, 'operation') };
      } catch (error) {
        const action = await this.resolveErrorAction(
          pipe,
          connector,
          context,
          failures,
          error,
        );
        if (action === 'skip') return { skipped: true };
        if (action !== 'retry') throw error;
        failures++;
        await this.recordRetry(
          workflowRunId,
          pipelineId,
          pipe.id,
          failures,
          error,
        );
        await this.wait(pipe.retry!, failures);
      }
    }
  }

  private async resolveErrorAction(
    pipe: PipeDef,
    connector: AnyPipe,
    context: PipeContext,
    failures: number,
    error: unknown,
  ): Promise<'retry' | 'fail' | 'skip'> {
    if (isAbort(error)) return 'fail';
    if (connector.onError && error instanceof Error) {
      const action = await connector.onError(error, context);
      if (action === 'skip' || action === 'fail') return action;
      if (action === 'retry') {
        return pipe.retry && failures < pipe.retry.attempts ? 'retry' : 'fail';
      }
    }
    return this.shouldRetry(pipe.retry, failures, error) ? 'retry' : 'fail';
  }

  private shouldRetry(
    retry: RetryDef | undefined,
    failures: number,
    error: unknown,
  ): boolean {
    if (!retry || failures >= retry.attempts || isAbort(error)) return false;
    return retry.on === 'all' || isTransient(error);
  }

  private async wait(retry: RetryDef, failure: number): Promise<void> {
    const base = retry.backoff === 'exponential' ? 2 ** (failure - 1) * 100 : 100;
    const capped = Math.min(base, retry.maxDelayMs);
    const delay = retry.jitter ? Math.floor(Math.random() * (capped + 1)) : capped;
    if (delay > 0) await this.sleep(delay);
  }

  private async saveCheckpoint(
    pipelineId: string,
    pipeId: string,
    execution: PipelineExecutionContext,
    batch: RecordBatch,
  ): Promise<void> {
    if (!this.options.checkpoints || !batch.cursor) return;
    await this.options.checkpoints.put({
      workflowRunId: execution.workflowRunId,
      pipelineId,
      pipeId,
      partitionId: batch.partitionId,
      cursor: batch.cursor,
      updatedAt: this.now(),
    });
  }

  private async recordRetry(
    workflowRunId: string,
    pipelineId: string,
    pipeId: string,
    attempt: number,
    error: unknown,
  ): Promise<void> {
    await this.options.events?.append({
      workflowRunId,
      pipelineId,
      pipeId,
      at: this.now(),
      type: 'retry.attempt',
      message: errorMessage(error),
      data: { attempt },
    });
  }

  private markPipe(
    context: PipeContext,
    status: PipeRunRecord['status'],
    batch?: RecordBatch,
    error?: unknown,
  ): Promise<void> {
    const cacheKey = `${context.workflowRunId}\0${context.pipelineId}\0${context.pipe.id}`;
    // Queue behind this pipe's previous update. The `catch` keeps one failed
    // update from poisoning the chain for the rest of the run; the caller of
    // that update still sees its own rejection through `next`.
    const next = (this.pipeUpdates.get(cacheKey) ?? Promise.resolve()).then(() =>
      this.applyPipeUpdate(cacheKey, context, status, batch, error),
    );
    this.pipeUpdates.set(
      cacheKey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async applyPipeUpdate(
    cacheKey: string,
    context: PipeContext,
    status: PipeRunRecord['status'],
    batch?: RecordBatch,
    error?: unknown,
  ): Promise<void> {
    if (!this.options.runs && !this.options.events) return;
    // Sources report progress per batch while 'running'; transforms and sinks
    // report the batch they just finished with 'success'. Both must count, or
    // every non-source pipe shows 0 processed batches/records.
    const progressBatch =
      status === 'running' || status === 'success' ? batch : undefined;
    // First touch per execution reads storage (crash-resume keeps its attempt
    // counter); every later update reuses the cached record.
    const existing =
      this.pipeRecords.get(cacheKey) ??
      (
        await this.options.runs?.listPipes(
          context.workflowRunId,
          context.pipelineId,
        )
      )?.find((record) => record.pipeId === context.pipe.id);
    const record: PipeRunRecord = {
      id: existing?.id ?? `${context.workflowRunId}:${context.pipelineId}:${context.pipe.id}`,
      workflowRunId: context.workflowRunId,
      pipelineId: context.pipelineId,
      pipeId: context.pipe.id,
      status,
      attempt: existing?.attempt ?? 1,
      processedBatches:
        (existing?.processedBatches ?? 0) + (progressBatch ? 1 : 0),
      processedRecords:
        (existing?.processedRecords ?? 0) +
        (progressBatch?.records.length ?? 0),
      startedAt: existing?.startedAt ?? this.now(),
      finishedAt: isTerminalPipeStatus(status) ? this.now() : undefined,
      error: error ? errorMessage(error) : undefined,
    };
    this.pipeRecords.set(cacheKey, record);
    await this.options.runs?.putPipe(record);
    await this.options.events?.append({
      workflowRunId: context.workflowRunId,
      pipelineId: context.pipelineId,
      pipeId: context.pipe.id,
      at: this.now(),
      type: progressBatch ? 'batch.progress' : 'pipe.status',
      data: progressBatch
        ? {
            status,
            batchId: progressBatch.id,
            records: progressBatch.records.length,
          }
        : { status },
      message: error ? errorMessage(error) : undefined,
    });
  }
}

function validateBatch(batch: RecordBatch, pipeId: string): void {
  if (!batch.id || !batch.partitionId || !Array.isArray(batch.records)) {
    throw new ExecutionError(`connector ${pipeId} emitted an invalid RecordBatch`);
  }
}

/** Cap sample size so debug events stay small enough for SSE/JSON storage. */
function truncateRecords(
  records: Record<string, unknown>[],
): { records: Record<string, unknown>[]; truncated: boolean } {
  const capped = records.slice(0, DEBUG_SAMPLE_RECORDS);
  const encoded = JSON.stringify(capped);
  if (encoded.length <= DEBUG_SAMPLE_BYTES) {
    return {
      records: capped,
      truncated: records.length > capped.length,
    };
  }
  // Drop rows until under the byte budget (always keep at least one when present).
  let keep = capped.length;
  while (keep > 1 && JSON.stringify(capped.slice(0, keep)).length > DEBUG_SAMPLE_BYTES) {
    keep--;
  }
  return {
    records: capped.slice(0, keep),
    truncated: true,
  };
}

function isTransient(error: unknown): boolean {
  return error instanceof ExecutionError && error.transient;
}

function isTerminalPipeStatus(status: PipeRunRecord['status']): boolean {
  return (
    status === 'success' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}
