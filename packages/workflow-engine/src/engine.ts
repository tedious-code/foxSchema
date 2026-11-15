/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/engine/src/engine.ts).
 */
import { randomUUID } from 'node:crypto';
import { keyFromEnv, type EventStore, type NewRunEvent, type RunEvent } from './common/index.js';
import { createDefaultPipeRegistry } from './pipes/utility/index.js';
import type { PipeRegistry } from './registry/index.js';
import {
  LocalRunScheduler,
  MiddlewareRegistry,
  PipelineExecutor,
  WorkflowRunner,
  type SqlProbe,
  ERROR_HANDLER_METADATA_KEY,
  createDefaultMiddlewareRegistry,
  createWorkflowServiceFactory,
} from './runtime/index.js';
import { createInfrastructureContext } from './sdk/index.js';
import { openSqliteStores, resolveDatabasePath } from './storage/index.js';

export interface EngineOptions {
  /**
   * SQLite path; `:memory:` for tests. Defaults to `FOXFLOW_DB_PATH`, else
   * `workflow-engine.sqlite` at the repo root — never relative to `process.cwd()`.
   */
  databasePath?: string;
  /** 32-byte credential key. Default: `FOXFLOW_ENCRYPTION_KEY` from the env. */
  encryptionKey?: Buffer;
  /** Pipe implementations. Default: the built-in registry. */
  registry?: PipeRegistry;
  /** Named control-plane middleware. Default: built-ins only (`log`). */
  middleware?: MiddlewareRegistry;
  instanceId?: string;
  /**
   * Run admitted work in this process (default). `false` only queues it, for a
   * scheduler role that leaves execution to workers.
   */
  executeInline?: boolean;
  /**
   * Probes for `sql` / `http` trigger conditions. Supplied by the app layer,
   * which is allowed to know about database drivers.
   */
  sql?: SqlProbe;
  /**
   * Resolve a FoxSchema saved-connection id to driver options. In-process
   * embedders inject this so a run never HTTP-calls FoxSchema for credentials.
   */
  resolveFoxSchemaConnection?: (
    connectionId: string,
  ) => Promise<Record<string, unknown> | undefined>;
  subWorkflowMaxDepth?: number;
  subWorkflowPollIntervalMs?: number;
}

/**
 * The engine facade (docs/engine-evolution.md step 7): one object that owns
 * the durable stores, the pipe and middleware registries, the executor, the
 * runner (with sub-workflow dispatch wired in), and the run scheduler — the
 * same wiring every embedder (API, worker, tests, future CLI/desktop) needs.
 * Cron coordination stays at the app layer.
 */
export class Engine {
  readonly stores: ReturnType<typeof openSqliteStores>;
  readonly registry: PipeRegistry;
  readonly middleware: MiddlewareRegistry;
  readonly executor: PipelineExecutor;
  readonly runner: WorkflowRunner;
  readonly scheduler: LocalRunScheduler;
  private readonly eventListeners = new Set<(event: RunEvent) => void>();

  constructor(options: EngineOptions = {}) {
    const stores = openSqliteStores(
      resolveDatabasePath(options.databasePath),
      options.encryptionKey ?? keyFromEnv(),
      { resolveFoxSchemaConnection: options.resolveFoxSchemaConnection },
    );
    // Every writer of run events — executor, runner, scheduler, sub-workflows —
    // is handed this one store, so observing it here observes all of them.
    this.stores = { ...stores, events: this.observe(stores.events) };
    this.registry = options.registry ?? createDefaultPipeRegistry();
    this.middleware = options.middleware ?? createDefaultMiddlewareRegistry();
    this.executor = new PipelineExecutor({
      registry: this.registry,
      checkpoints: this.stores.checkpoints,
      events: this.stores.events,
      runs: this.stores.runs,
      credentials: this.stores.credentials,
      humanInputs: this.stores.humanInputs,
      infrastructure: createInfrastructureContext({ credentials: this.stores.credentials }),
    });
    // The sub-workflow service needs the scheduler, which needs the runner —
    // break the construction cycle with a late-bound reference.
    const dispatcher: { scheduler?: LocalRunScheduler } = {};
    this.runner = new WorkflowRunner({
      runs: this.stores.runs,
      events: this.stores.events,
      pipelineExecutor: this.executor,
      middleware: this.middleware,
      humanInputs: this.stores.humanInputs,
      dispatchErrorHandler: async ({ handler, failure }) => {
        const target = await this.stores.workflows.get(handler.workflowId);
        if (!target) {
          throw new Error(`error handler workflow not found: ${handler.workflowId}`);
        }
        if (
          handler.workflowVersion !== undefined &&
          target.version !== handler.workflowVersion
        ) {
          throw new Error(
            `error handler ${handler.workflowId} version ${handler.workflowVersion} is not available (latest is ${target.version})`,
          );
        }
        const trigger =
          target.triggers.find((t) => t.kind === 'parent' && t.enabled) ??
          target.triggers.find((t) => t.kind === 'manual' && t.enabled);
        if (!trigger) {
          throw new Error(
            `error handler ${handler.workflowId} needs an enabled parent or manual trigger`,
          );
        }
        await dispatcher.scheduler!.enqueue(target, {
          id: randomUUID(),
          workflowId: target.id,
          triggerId: trigger.id,
          kind: trigger.kind,
          acceptedAt: new Date().toISOString(),
          payload: failure,
          // Stamped so the handler's own failure cannot summon another
          // handler — one broken workflow must not become an endless chain.
          metadata: { [ERROR_HANDLER_METADATA_KEY]: failure.runId },
        } as never);
      },
      workflows: createWorkflowServiceFactory({
        dispatcher: {
          enqueue: (workflow, invocation, dispatchOptions) =>
            dispatcher.scheduler!.enqueue(workflow, invocation, dispatchOptions),
        },
        workflows: this.stores.workflows,
        runs: this.stores.runs,
        events: this.stores.events,
        ...(options.subWorkflowMaxDepth !== undefined
          ? { maxDepth: options.subWorkflowMaxDepth }
          : {}),
        ...(options.subWorkflowPollIntervalMs !== undefined
          ? { pollIntervalMs: options.subWorkflowPollIntervalMs }
          : {}),
      }),
    });
    this.scheduler = new LocalRunScheduler({
      runs: this.stores.runs,
      events: this.stores.events,
      runner: this.runner,
      middleware: this.middleware,
      environments: this.stores.environments,
      variables: this.stores.variables,
      ...(options.sql ? { sql: options.sql } : {}),
      ...(options.instanceId !== undefined
        ? { instanceId: options.instanceId }
        : {}),
      ...(options.executeInline !== undefined
        ? { executeInline: options.executeInline }
        : {}),
    });
    dispatcher.scheduler = this.scheduler;
  }

  /** Be told of each run event once it is stored. Returns the unsubscribe. */
  onEvent(listener: (event: RunEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private observe(events: EventStore): EventStore {
    return {
      append: async (event: NewRunEvent) => {
        const stored = await events.append(event);
        for (const listener of this.eventListeners) {
          try {
            listener(stored);
          } catch {
            // A listener's failure is not the run's.
          }
        }
        return stored;
      },
      list: (workflowRunId, afterSeq) => events.list(workflowRunId, afterSeq),
    };
  }

  /** Resume interrupted and queued runs after a restart. */
  async start(): Promise<void> {
    await this.scheduler.recover();
  }

  /** Wait for all in-flight runs (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await this.scheduler.idle();
  }

  close(): void {
    // Before the store: a lease heartbeat that outlives its database renews
    // against a closed handle.
    this.scheduler.stopLeases();
    this.stores.close();
  }
}
