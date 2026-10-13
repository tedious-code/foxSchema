/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/runtime/src/workflow.ts).
 */
import type { PipelineDef } from '../common/index.js';
import type {
  DependencyDef,
  WorkflowDef,
} from '../common/index.js';
import type { EngineState } from '@foxschema/workflow-contract';
import {
  ACTIVE_RUN_STATUSES,
  isHumanInputRequired,
  isTerminalRunStatus,
  validateWorkflowInput,
} from '../common/index.js';
import { evaluateConditions } from './conditions.js';
import { errorMessage, isAbort } from './errors.js';
import type { SqlProbe } from './scheduler/sql-precondition.js';
import type { HumanInputRequired, HumanInputStore } from '../common/index.js';
import { evaluateGate } from './gates.js';
import type { RunOutputCollector } from '../registry/index.js';
import {
  runMiddlewareChain,
  type MiddlewareRegistry,
} from './middleware.js';
import type {
  EnvironmentStore,
  EventStore,
  RunStore,
  VariableStore,
} from '../common/index.js';
import type {
  PipelineRunRecord,
  PipelineRunStatus,
  TriggerInvocation,
  WorkflowRunRecord,
  WorkflowService,
} from '../common/index.js';

/** Event type carrying a run's synchronous response payload. */
export const RUN_OUTPUT_EVENT = 'run.output';

export interface PipelineExecutionPort {
  execute(
    pipeline: PipelineDef,
    context: {
      workflowRunId: string;
      invocation?: TriggerInvocation;
      signal?: AbortSignal;
      workflows?: WorkflowService;
      variables?: Record<string, unknown>;
      /** Opt-in per-port I/O sampling for designer debug runs. */
      debug?: boolean;
      /** Where `sink.response` puts the run's answer, when one is awaited. */
      output?: { collect(records: Record<string, unknown>[]): void };
    },
  ): Promise<void>;
  /** The run is terminal: let its sinks release what they kept for it. */
  finishRun?(workflowRunId: string, workflow: WorkflowDef): Promise<void>;
}

export interface WorkflowRunnerOptions {
  runs: RunStore;
  events: EventStore;
  pipelineExecutor: PipelineExecutionPort;
  now?: () => string;
  /**
   * Per-run factory for the sub-workflow dispatch service handed to pipes
   * (`workflow.sub`). Bound to the run so the circular-dependency guard can
   * walk the ancestor chain.
   */
  workflows?: (run: WorkflowRunRecord) => WorkflowService;
  /** Workflow- and pipeline-tier middleware (resolved by name per run). */
  middleware?: MiddlewareRegistry;
  /**
   * Where a human gate's question is recorded. Absent means nobody can be
   * asked, so a pipe that needs input fails instead of pausing — a run parked
   * forever with no way to answer it is worse than a clear failure.
   */
  humanInputs?: HumanInputStore;
  /**
   * Dispatches a workflow's `errorHandler` after a failed run. Injected, like
   * the SQL probe and `fetch`, so the runner does not need the scheduler it
   * would otherwise have to reach back into.
   */
  dispatchErrorHandler?: (input: ErrorHandlerDispatch) => Promise<void>;
}

/** What a handler workflow is told about the run that failed. */
export interface ErrorHandlerDispatch {
  handler: { workflowId: string; workflowVersion?: number };
  failure: {
    runId: string;
    workflowId: string;
    workflowVersion: number;
    error?: string;
    failedPipelineId?: string;
    startedAt: string;
    finishedAt?: string;
  };
}

/**
 * Marks a run that exists *because* something else failed. A handler that
 * fails must not summon its own handler, or one broken workflow becomes an
 * unbounded chain of runs.
 */
export const ERROR_HANDLER_METADATA_KEY = 'errorHandlerForRunId';

export class WorkflowRunner {
  private readonly now: () => string;
  /**
   * Runs that stopped on a human gate during this phase. In-memory because it
   * only has to survive from the pipeline's catch to the end of the same
   * `executePhase`; the durable record is the `human_inputs` row, which is
   * what a restarted process reads.
   */
  private readonly paused = new Set<string>();

  constructor(private readonly options: WorkflowRunnerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(workflowRunId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.runOnce(workflowRunId, signal);
    } finally {
      // A paused run resumes as the same run, so only a terminal one is over.
      const run = await this.options.runs.get(workflowRunId).catch(() => undefined);
      if (run && isTerminalRunStatus(run.status) && this.options.pipelineExecutor.finishRun) {
        const workflow = await this.options.runs.getSnapshot(workflowRunId).catch(() => undefined);
        if (workflow) await this.options.pipelineExecutor.finishRun(workflowRunId, workflow).catch(() => undefined);
      }
    }
  }

  private async runOnce(workflowRunId: string, signal?: AbortSignal): Promise<void> {
    const run = await this.options.runs.get(workflowRunId);
    const workflow = await this.options.runs.getSnapshot(workflowRunId);
    if (!run || !workflow) {
      throw new Error(`run or immutable snapshot not found: ${workflowRunId}`);
    }
    const invocation = await this.options.runs.getInvocation(workflowRunId);

    const records = new Map(
      (await this.options.runs.listPipelines(workflowRunId)).map((record) => [
        record.pipelineId,
        record,
      ]),
    );
    for (const pipeline of workflow.pipelines) {
      const existing = records.get(pipeline.id);
      // `running` means the process died mid-execution; `paused` means it
      // stopped on a human gate and has now been answered. Both are attempts
      // to redo, and a paused pipeline left alone would be treated as finished
      // by the wave planner — the run would "succeed" having skipped the work
      // the person was waiting to unblock.
      if (existing?.status === 'running' || existing?.status === 'paused') {
        existing.status = 'pending';
        existing.finishedAt = undefined;
        existing.error = undefined;
        await this.options.runs.putPipeline(existing);
      } else if (!existing) {
        const pending = pipelineRecord(workflowRunId, pipeline.id);
        records.set(pipeline.id, pending);
        await this.options.runs.putPipeline(pending);
      }
    }

    run.status = 'running';
    run.finishedAt = undefined;
    run.error = undefined;
    await this.updateRun(run);

    // Run-scoped, so every pipeline's `sink.response` appends to one payload in
    // completion order. Kept in memory during the run and appended to the event
    // log at the end — the event store is already append-only and immutable,
    // which is exactly what a run's answer wants, and it needs no new column.
    const collected: Record<string, unknown>[] = [];
    const collector = { collect: (records: Record<string, unknown>[]) => {
      collected.push(...records);
    } };

    // Workflow-tier middleware wraps the whole execution phase. A middleware
    // error fails the run like any other failure — nothing silent.
    let aborted = false;
    try {
      await runMiddlewareChain(
        this.options.middleware?.resolve(workflow.middleware, 'workflow') ?? [],
        { tier: 'workflow', workflow, run, invocation },
        async () => {
          aborted = await this.executePhase(
            workflow,
            run,
            records,
            invocation,
            signal,
            collector,
          );
        },
      );
    } catch (error) {
      await this.cancelPending(records);
      run.status = 'failed';
      run.error = errorMessage(error);
      run.finishedAt = this.now();
      await this.updateRun(run);
      await this.handleFailure(workflow, run, invocation);
      return;
    }
    if (aborted) {
      run.status = 'cancelled';
      run.finishedAt = this.now();
      await this.updateRun(run);
      return;
    }

    // Checked before failure, because a run waiting on a person is not a run
    // that went wrong — reporting it as failed would page someone and lose the
    // question that was already asked.
    if (this.paused.delete(run.id)) {
      run.status = 'paused';
      run.finishedAt = undefined;
      await this.updateRun(run);
      return;
    }

    const failed = [...records.values()].find(
      (record) => record.status === 'failed',
    );
    const cancelled = [...records.values()].some(
      (record) => record.status === 'cancelled',
    );
    run.status = finalRunStatus(cancelled, failed !== undefined);
    run.error = failed?.error;
    run.finishedAt = this.now();
    await this.updateRun(run);
    await this.recordOutput(run, collected);
    if (run.status === 'failed') {
      await this.handleFailure(workflow, run, invocation, failed?.pipelineId);
    }
  }

  /**
   * Run the workflow's error handler, if it has one and this run is not
   * already a handler.
   *
   * Failures here are swallowed on purpose: the run has already failed and
   * been recorded, and letting a broken handler throw would corrupt that
   * record with a second, misleading error.
   */
  private async handleFailure(
    workflow: WorkflowDef,
    run: WorkflowRunRecord,
    invocation: TriggerInvocation | undefined,
    failedPipelineId?: string,
  ): Promise<void> {
    const handler = workflow.errorHandler;
    if (!handler || !this.options.dispatchErrorHandler) return;
    // The guard that keeps one broken workflow from becoming an endless chain.
    if (invocation?.metadata?.[ERROR_HANDLER_METADATA_KEY]) return;

    try {
      await this.options.dispatchErrorHandler({
        handler,
        failure: {
          runId: run.id,
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          ...(run.error ? { error: run.error } : {}),
          ...(failedPipelineId ? { failedPipelineId } : {}),
          startedAt: run.startedAt,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        },
      });
    } catch (error) {
      this.options.events
        .append({
          workflowRunId: run.id,
          at: this.now(),
          type: 'run.status',
          message: `error handler dispatch failed: ${errorMessage(error)}`,
        })
        .catch(() => undefined);
    }
  }

  /**
   * Persist the question so it outlives the process that asked it, and put it
   * in the run's event log so the timeline shows *why* the run stopped.
   */
  private async recordHumanInput(
    run: WorkflowRunRecord,
    pipelineId: string,
    error: HumanInputRequired,
  ): Promise<void> {
    const store = this.options.humanInputs;
    if (!store) return;
    const record = await store.request({
      workflowRunId: run.id,
      pipelineId,
      pipeId: error.request.key,
      request: error.request,
      now: this.now(),
    });
    await this.options.events.append({
      workflowRunId: run.id,
      pipelineId,
      at: this.now(),
      type: 'human.input.requested',
      message: error.request.prompt,
      // The prompt and field *labels* only. Never an answer: this log is read
      // by anyone who can see the run.
      data: {
        key: record.request.key,
        channel: record.request.channel,
        expiresAt: record.expiresAt,
        fields: record.request.fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          secret: field.secret,
        })),
      },
    });
  }

  /**
   * Append the run's answer to the event log. Only when something was collected
   * — an empty event would make "this workflow returns nothing" and "nothing
   * was waiting" indistinguishable to a caller reading the log back.
   */
  private async recordOutput(
    run: WorkflowRunRecord,
    collected: Record<string, unknown>[],
  ): Promise<void> {
    if (collected.length === 0) return;
    await this.options.events.append({
      workflowRunId: run.id,
      at: this.now(),
      type: RUN_OUTPUT_EVENT,
      data: { records: collected, recordCount: collected.length },
    });
  }

  /** Dependency release + pipeline execution. Returns true when aborted. */
  private async executePhase(
    workflow: WorkflowDef,
    run: WorkflowRunRecord,
    records: Map<string, PipelineRunRecord>,
    invocation: TriggerInvocation | undefined,
    signal?: AbortSignal,
    collector?: RunOutputCollector,
  ): Promise<boolean> {
    while ([...records.values()].some((record) => record.status === 'pending')) {
      if (signal?.aborted) {
        await this.cancelPending(records);
        return true;
      }

      const ready = workflow.pipelines.filter((pipeline) => {
        const record = records.get(pipeline.id)!;
        return (
          record.status === 'pending' &&
          inbound(workflow.dependencies, pipeline.id).every((dependency) =>
            isTerminal(records.get(dependency.from)!.status),
          )
        );
      });
      if (ready.length === 0) {
        throw new Error('workflow dependency release made no progress');
      }

      await Promise.all(
        ready.map(async (pipeline) => {
          const dependencies = inbound(workflow.dependencies, pipeline.id);
          let released = true;
          try {
            released = dependencies.every((dependency) => {
              if (!matches(dependency, records.get(dependency.from)!.status)) {
                return false;
              }
              if (!dependency.gate) return true;
              return evaluateGate(dependency.gate, {
                payload: invocation?.payload,
                trigger: invocation?.kind ?? run.trigger,
              });
            });
          } catch (error) {
            const failed = records.get(pipeline.id)!;
            failed.status = 'failed';
            failed.error = errorMessage(error);
            failed.finishedAt = this.now();
            await this.putPipeline(failed);
            return;
          }
          if (!released) {
            const skipped = records.get(pipeline.id)!;
            skipped.status = 'skipped';
            skipped.finishedAt = this.now();
            await this.putPipeline(skipped);
            return;
          }
          await this.executePipeline(
            workflow,
            run,
            pipeline,
            records,
            invocation,
            signal,
            collector,
          );
        }),
      );
    }
    return false;
  }

  private async executePipeline(
    workflow: WorkflowDef,
    run: WorkflowRunRecord,
    pipeline: PipelineDef,
    records: Map<string, PipelineRunRecord>,
    invocation: TriggerInvocation | undefined,
    signal?: AbortSignal,
    collector?: RunOutputCollector,
  ): Promise<void> {
    const record = records.get(pipeline.id)!;
    record.status = 'running';
    record.startedAt ??= this.now();
    await this.putPipeline(record);
    try {
      // Pipeline-tier middleware wraps one pipeline's execution; a middleware
      // error fails that pipeline exactly like an executor error.
      await runMiddlewareChain(
        this.options.middleware?.resolve(workflow.middleware, 'pipeline') ?? [],
        { tier: 'pipeline', workflow, run, invocation, pipeline },
        () =>
          this.options.pipelineExecutor.execute(pipeline, {
            workflowRunId: run.id,
            invocation,
            signal,
            workflows: this.options.workflows?.(run),
            variables: run.variables,
            debug: run.debug === true,
            output: collector,
          }),
      );
      record.status = 'succeeded';
    } catch (error) {
      if (isHumanInputRequired(error)) {
        // Not a failure: the pipeline ran, discovered it needs a person, and
        // asked. The run stops here and starts again once someone answers.
        record.status = 'paused';
        record.error = error.message;
        this.paused.add(run.id);
        await this.recordHumanInput(run, pipeline.id, error);
      } else {
        record.status = isAbort(error) ? 'cancelled' : 'failed';
        record.error = errorMessage(error);
      }
    }
    record.finishedAt = this.now();
    await this.putPipeline(record);
  }

  private async cancelPending(
    records: Map<string, PipelineRunRecord>,
  ): Promise<void> {
    await Promise.all(
      [...records.values()]
        .filter((record) => record.status === 'pending')
        .map(async (record) => {
          record.status = 'cancelled';
          record.finishedAt = this.now();
          await this.putPipeline(record);
        }),
    );
  }

  private async putPipeline(record: PipelineRunRecord): Promise<void> {
    await this.options.runs.putPipeline(record);
    await this.options.events.append({
      workflowRunId: record.workflowRunId,
      pipelineId: record.pipelineId,
      at: this.now(),
      type: 'pipeline.status',
      data: { status: record.status },
      message: record.error,
    });
  }

  private async updateRun(run: WorkflowRunRecord): Promise<void> {
    await this.options.runs.update(run);
    await this.options.events.append({
      workflowRunId: run.id,
      at: this.now(),
      type: 'run.status',
      data: { status: run.status },
      message: run.error,
    });
  }
}

export interface LocalRunSchedulerOptions {
  /**
   * Probes for `sql` / `http` trigger conditions, injected the way `fetch`
   * already is elsewhere so the runtime carries no database drivers.
   */
  sql?: SqlProbe;
  fetch?: typeof fetch;
  runs: RunStore;
  events: EventStore;
  runner: WorkflowRunner;
  instanceId?: string;
  now?: () => string;
  /** When false, enqueue only persists queued runs (worker dispatches). Default true. */
  executeInline?: boolean;
  /** Engine-tier middleware wrapping admission (resolved by name). */
  middleware?: MiddlewareRegistry;
  /** Environments + variables. Absent = runs get no resolved variables. */
  environments?: EnvironmentStore;
  variables?: VariableStore;
  /** Most runs executing at once on this instance. Default: no limit. */
  maxConcurrentRuns?: number;
}

export interface EnqueueResult {
  accepted: boolean;
  /**
   * Absent when nothing was created. A condition that refuses admission
   * produces no run at all — which is the point of asking before the record
   * exists rather than after.
   */
  run?: WorkflowRunRecord;
  reason?: 'overlap' | 'duplicate' | 'conflict' | 'condition' | 'disabled';
  /** Which condition refused, so the silence is explainable. */
  detail?: string;
}

export class LocalRunScheduler {
  private readonly jobs = new Set<Promise<void>>();
  private readonly serial = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Promise<void>>();
  private readonly controls = new Map<string, AbortController>();
  /**
   * Lease renewal timers, one per run this instance is executing. The TTL is
   * generous relative to the renewal interval so a slow tick does not make a
   * healthy instance look dead to its peers.
   */
  private readonly leases = new Map<string, NodeJS.Timeout>();
  private readonly now: () => string;
  private readonly instanceId: string;
  private state: EngineState = 'enabled';
  private readonly slots = new RunSlots();

  constructor(private readonly options: LocalRunSchedulerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.instanceId = options.instanceId ?? 'local';
    this.slots.setLimit(options.maxConcurrentRuns);
  }

  /**
   * Apply the engine settings an admin saved. `disabled` admits nothing new.
   * `draining` admits only runs started for a run already in flight
   * (sub-workflows), so work under way can finish. Lowering
   * `maxConcurrentRuns` lets running work finish and keeps the rest queued.
   */
  setAdmission(admission: { state: EngineState; maxConcurrentRuns?: number }): void {
    this.state = admission.state;
    this.slots.setLimit(admission.maxConcurrentRuns);
  }

  async enqueue(
    workflow: WorkflowDef,
    providedInvocation?: TriggerInvocation,
    options?: { parentRunId?: string; environment?: string; debug?: boolean },
  ): Promise<EnqueueResult> {
    // First, and for every activation path: manual, cron, poll, webhook and
    // sub-workflow runs all arrive here.
    if (this.state === 'disabled' || (this.state === 'draining' && !options?.parentRunId)) {
      return { accepted: false, reason: 'disabled', detail: `the workflow engine is ${this.state}` };
    }
    const invocation = providedInvocation ?? this.manualInvocation(workflow);
    const trigger = workflow.triggers.find(
      (candidate) => candidate.id === invocation.triggerId,
    );
    if (
      invocation.workflowId !== workflow.id ||
      !trigger ||
      trigger.kind !== invocation.kind
    ) {
      throw new Error(`invalid trigger invocation: ${invocation.triggerId}`);
    }
    if (!trigger.enabled) {
      throw new Error(`trigger is disabled: ${invocation.triggerId}`);
    }
    // Central input-contract enforcement: every activation path funnels
    // through here. Cron is exempt — its payload is engine-generated
    // ({ scheduledAt }), not external input.
    if (invocation.kind !== 'cron') {
      validateWorkflowInput(workflow, invocation.payload);
    }
    const admit = () =>
      this.withAdmission(workflow.id, () =>
        this.enqueueLocked(workflow, trigger, invocation, options),
      );
    // Engine-tier middleware wraps admission. A rejection here happens before
    // a run exists, so it surfaces to the caller instead of a run event.
    const entries =
      this.options.middleware?.resolve(workflow.middleware, 'engine') ?? [];
    if (entries.length === 0) return admit();
    let result: EnqueueResult | undefined;
    await runMiddlewareChain(
      entries,
      { tier: 'engine', workflow, invocation },
      async () => {
        result = await admit();
      },
    );
    return result!;
  }

  private async enqueueLocked(
    workflow: WorkflowDef,
    trigger: WorkflowDef['triggers'][number],
    invocation: TriggerInvocation,
    options?: { parentRunId?: string; environment?: string; debug?: boolean },
  ): Promise<EnqueueResult> {
    if (invocation.idempotencyKey) {
      const duplicate = await this.options.runs.findByIdempotencyKey(
        workflow.id,
        invocation.triggerId,
        invocation.idempotencyKey,
      );
      if (duplicate) {
        return this.duplicateResult(duplicate, invocation);
      }
    }
    // Asked after idempotency (a duplicate is a duplicate whatever the gates
    // say) and before anything is written.
    let collected: Record<string, unknown> = {};
    if (trigger.conditions?.length) {
      const outcome = await evaluateConditions(trigger.conditions, {
        payload: invocation.payload,
        ...(this.options.sql ? { sql: this.options.sql } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
      if (!outcome.met) {
        return { accepted: false, reason: 'condition', detail: outcome.failed };
      }
      collected = outcome.collected;
    }

    const [active] = await this.options.runs.list(workflow.id, {
      status: ACTIVE_RUN_STATUSES,
      limit: 1,
    });
    if (active && workflow.onOverlap === 'skip') {
      return { accepted: false, run: active, reason: 'overlap' };
    }

    const enriched =
      Object.keys(collected).length > 0
        ? {
            ...invocation,
            payload:
              invocation.payload && typeof invocation.payload === 'object'
                ? { ...(invocation.payload as Record<string, unknown>), ...collected }
                : { payload: invocation.payload, ...collected },
          }
        : invocation;

    const environment = await this.resolveEnvironment(options?.environment);
    const variables = environment
      ? await this.options.variables?.resolve(environment.id, workflow.id)
      : undefined;

    const run: WorkflowRunRecord = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: 'queued',
      trigger: invocation.kind,
      triggerId: invocation.triggerId,
      startedAt: invocation.acceptedAt,
      instanceId: this.instanceId,
      ...(options?.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(environment ? { environmentId: environment.id } : {}),
      ...(variables ? { variables } : {}),
      ...(options?.debug ? { debug: true } : {}),
    };
    try {
      // For `skip`, let the write decide the race. The read above is still
      // worth doing — it returns the blocking run to the caller, which a
      // conditional insert cannot — but two instances sharing a database will
      // both pass it, so the insert is what actually enforces the policy.
      if (workflow.onOverlap === 'skip' && this.options.runs.createIfIdle) {
        const won = await this.options.runs.createIfIdle(run, workflow, enriched);
        if (!won) {
          const [blocking] = await this.options.runs.list(workflow.id, {
            status: ACTIVE_RUN_STATUSES,
            limit: 1,
          });
          // `blocking` can be absent if the winner finished in between; the
          // decision stands either way — this instance did not create a run.
          return { accepted: false, run: blocking ?? run, reason: 'overlap' };
        }
      } else {
        await this.options.runs.create(run, workflow, enriched);
      }
    } catch (error) {
      if (invocation.idempotencyKey) {
        const duplicate = await this.options.runs.findByIdempotencyKey(
          workflow.id,
          invocation.triggerId,
          invocation.idempotencyKey,
        );
        if (duplicate) {
          return this.duplicateResult(duplicate, invocation);
        }
      }
      throw error;
    }
    await this.options.events.append({
      workflowRunId: run.id,
      at: this.now(),
      type: 'run.status',
      data: { status: 'queued' },
    });

    if (this.options.executeInline !== false) {
      if (workflow.onOverlap === 'parallel') {
        this.startRun(run.id);
      } else {
        this.startSerial(workflow.id);
      }
    }
    return { accepted: true, run };
  }

  private async duplicateResult(
    run: WorkflowRunRecord,
    invocation: TriggerInvocation,
  ): Promise<EnqueueResult> {
    const previous = await this.options.runs.getInvocation(run.id);
    const fingerprintsConflict = Boolean(
      previous?.fingerprint &&
        invocation.fingerprint &&
        previous.fingerprint !== invocation.fingerprint,
    );
    return {
      accepted: false,
      run,
      reason: fingerprintsConflict ? 'conflict' : 'duplicate',
    };
  }

  private async withAdmission<T>(
    workflowId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.admissions.get(workflowId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.admissions.set(workflowId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.admissions.get(workflowId) === current) {
        this.admissions.delete(workflowId);
      }
    }
  }

  /**
   * Pick the environment a run resolves variables against: an explicit
   * override by name or id (manual/test runs), else the active one. An unknown
   * override is an error rather than a silent fallback — running against the
   * wrong environment is exactly the mistake worth failing loudly on.
   */
  private async resolveEnvironment(
    override?: string,
  ): Promise<{ id: string } | undefined> {
    const environments = this.options.environments;
    if (!environments) return undefined;
    if (!override) return environments.active();
    const found =
      (await environments.getByName(override)) ??
      (await environments.get(override));
    if (!found) throw new Error(`unknown environment: ${override}`);
    return found;
  }

  private manualInvocation(workflow: WorkflowDef): TriggerInvocation {
    const trigger = workflow.triggers.find(
      (candidate) => candidate.kind === 'manual' && candidate.enabled,
    );
    if (!trigger) throw new Error('workflow has no enabled manual trigger');
    const acceptedAt = this.now();
    const inputData =
      trigger.kind === 'manual' ? trigger.inputData : undefined;
    return {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      triggerId: trigger.id,
      kind: 'manual',
      acceptedAt,
      metadata: {},
      ...(inputData !== undefined ? { payload: inputData } : {}),
    };
  }

  async cancel(runId: string): Promise<WorkflowRunRecord | undefined> {
    const run = await this.options.runs.get(runId);
    if (!run) return undefined;
    if (run.status === 'queued') {
      run.status = 'cancelled';
      run.finishedAt = this.now();
      await this.options.runs.update(run);
      await this.options.events.append({
        workflowRunId: run.id,
        at: this.now(),
        type: 'run.status',
        data: { status: 'cancelled' },
      });
      return run;
    }
    this.controls.get(runId)?.abort();
    return run;
  }

  async resume(runId: string): Promise<WorkflowRunRecord | undefined> {
    const run = await this.options.runs.get(runId);
    if (!run) return undefined;
    if (run.status !== 'paused' && run.status !== 'interrupted') {
      throw new Error(`run ${runId} is not resumable from status ${run.status}`);
    }
    run.status = 'queued';
    run.finishedAt = undefined;
    run.error = undefined;
    await this.options.runs.update(run);
    const workflow = await this.options.runs.getSnapshot(run.id);
    if (workflow?.onOverlap === 'parallel') {
      this.startRun(run.id);
    } else {
      this.startSerial(run.workflowId);
    }
    return run;
  }

  async dispatchAvailable(): Promise<void> {
    await this.startQueuedRuns();
  }

  async recover(): Promise<void> {
    // Only reclaim what no one is working on. Without the timestamp this took
    // every running run in the installation, so a second instance booting
    // re-executed a live peer's work.
    const interrupted = await this.options.runs.interruptRunning(
      this.now(),
      this.instanceId,
    );
    for (const run of interrupted) {
      run.status = 'queued';
      run.finishedAt = undefined;
      await this.options.runs.update(run);
    }
    await this.startQueuedRuns();
    await this.idle();
  }

  /**
   * Start every queued run: side by side for a workflow that allows parallel
   * runs, otherwise one at a time in queue order.
   */
  private async startQueuedRuns(): Promise<void> {
    const queued = await this.options.runs.list(undefined, { status: ['queued'] });
    const workflowIds = new Set(queued.map((run) => run.workflowId));
    for (const workflowId of workflowIds) {
      const workflowRuns = queued.filter((run) => run.workflowId === workflowId);
      const workflow = await this.options.runs.getSnapshot(workflowRuns[0]!.id);
      if (workflow?.onOverlap === 'parallel') {
        workflowRuns.forEach((run) => this.startRun(run.id));
      } else {
        this.startSerial(workflowId);
      }
    }
  }

  async idle(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.all([...this.jobs]);
    }
  }

  private startSerial(workflowId: string): void {
    if (this.serial.has(workflowId)) return;
    const job = (async () => {
      while (true) {
        const queued = (await this.options.runs.list(workflowId, { status: ['queued'] }))
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
        if (!queued) return;
        if (!(await this.runControlled(queued.id, true))) return;
      }
    })();
    this.serial.set(workflowId, job);
    this.track(
      job.finally(() => {
        this.serial.delete(workflowId);
      }),
    );
  }

  private track(job: Promise<void>): void {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }

  private startRun(runId: string): void {
    this.track(this.runControlled(runId).then(() => undefined));
  }

  private async runControlled(runId: string, serial = false): Promise<boolean> {
    // Waits here, still queued, while this instance is at its limit.
    await this.slots.acquire();
    let claimed: boolean;
    try {
      claimed = await this.options.runs.claimQueuedRun(
        runId,
        this.instanceId,
        this.leaseExpiry(),
        serial,
        this.now(),
      );
    } catch (error) {
      this.slots.release();
      throw error;
    }
    if (!claimed) {
      this.slots.release();
      return false;
    }
    const controller = new AbortController();
    this.controls.set(runId, controller);
    this.holdLease(runId);
    try {
      await this.options.runner.run(runId, controller.signal);
    } finally {
      this.controls.delete(runId);
      this.releaseLease(runId);
      this.slots.release();
    }
    return true;
  }

  /**
   * Say "still mine" for as long as this instance is executing the run.
   *
   * A peer decides a run is abandoned by finding an expired lease, so the owner
   * has to keep renewing. If the process dies the timer dies with it, the lease
   * lapses, and the run becomes reclaimable — which is the whole mechanism, and
   * why nothing has to notice the death.
   */
  private holdLease(runId: string): void {
    const renew = (): void => {
      // Optional on the interface, so guard before calling: `?.()` yields
      // undefined when absent and `.catch` on that is a TypeError.
      const renewal = this.options.runs.renewLease?.(
        runId,
        this.instanceId,
        this.leaseExpiry(),
      );
      // A failed renewal is not worth failing the run over: the lease lapses
      // and a peer may take over, which is the designed outcome for an
      // instance that cannot reach the database — including one whose store
      // has already closed underneath it.
      void renewal?.catch(() => undefined);
    };
    renew();
    const timer = setInterval(renew, LEASE_RENEW_MS);
    // Never hold the process open for a heartbeat.
    timer.unref?.();
    this.leases.set(runId, timer);
  }

  /**
   * Stop every heartbeat. Called before the store closes: a timer that
   * outlives its database wakes up and renews against a closed handle, which
   * surfaces as `database is not open` from somewhere unrelated to the run.
   */
  stopLeases(): void {
    for (const timer of this.leases.values()) clearInterval(timer);
    this.leases.clear();
  }

  private releaseLease(runId: string): void {
    const timer = this.leases.get(runId);
    if (timer) clearInterval(timer);
    this.leases.delete(runId);
  }

  private leaseExpiry(): string {
    return new Date(Date.parse(this.now()) + LEASE_TTL_MS).toISOString();
  }
}

/**
 * The lease outlives several renewals on purpose. A GC pause or a slow query
 * must not make a working instance look dead: the cost of a false positive is
 * two instances running the same workflow — the exact thing this prevents.
 */
const LEASE_RENEW_MS = 5_000;
const LEASE_TTL_MS = 30_000;

function pipelineRecord(
  workflowRunId: string,
  pipelineId: string,
): PipelineRunRecord {
  return {
    id: `${workflowRunId}:${pipelineId}`,
    workflowRunId,
    pipelineId,
    status: 'pending',
  };
}

function inbound(
  dependencies: DependencyDef[],
  pipelineId: string,
): DependencyDef[] {
  return dependencies.filter((dependency) => dependency.to === pipelineId);
}

/** A counting gate whose size can change while runs wait on it. */
class RunSlots {
  private limit = Number.POSITIVE_INFINITY;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /** A missing or non-positive limit means no limit. */
  setLimit(limit: number | undefined): void {
    this.limit = limit !== undefined && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    this.wake();
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    this.active -= 1;
    this.wake();
  }

  /** Hand free slots to waiters in arrival order. */
  private wake(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active += 1;
      this.waiting.shift()!();
    }
  }
}

function isTerminal(status: PipelineRunStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'skipped' ||
    status === 'cancelled' ||
    // Terminal *for this attempt*. The run is about to stop, and treating a
    // paused pipeline as still-running would spin the wave loop into
    // "dependency release made no progress".
    status === 'paused'
  );
}

function matches(
  dependency: DependencyDef,
  status: PipelineRunStatus,
): boolean {
  if (dependency.on === 'always') return isTerminal(status);
  if (dependency.on === 'success') return status === 'succeeded';
  return status === 'failed';
}

function finalRunStatus(
  cancelled: boolean,
  failed: boolean,
): WorkflowRunRecord['status'] {
  if (cancelled) return 'cancelled';
  if (failed) return 'failed';
  return 'succeeded';
}
