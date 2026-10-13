/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/registry/src/pipes.ts).
 */
import type { CredentialStore } from '../common/index.js';
import type { HumanInputRequest, PipeDef, PipeRole } from '../common/index.js';
import type {
  ErrorAction,
  InfrastructureContext,
  PipeMetadata,
  PipeProvider,
} from '../sdk/index.js';
import type {
  Checkpoint,
  TriggerInvocation,
  WorkflowService,
} from '../common/index.js';

/** Built-ins own the bare (un-namespaced) type-id space. */
export const FOXFLOW_PROVIDER: PipeProvider = Object.freeze({
  namespace: 'foxagent',
  origin: 'builtin',
});

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface RecordBatch {
  /** Stable replay/idempotency key. */
  id: string;
  partitionId: string;
  records: Record<string, unknown>[];
  /** Source position represented by this committed batch. */
  cursor?: Record<string, unknown>;
  /**
   * Named output port this batch was emitted on. Prefer returning a
   * `Map<port, RecordBatch>` from transforms; this field is a convenience
   * for single-batch multi-port emitters.
   */
  port?: string;
}

export interface PipeContext {
  workflowRunId: string;
  pipelineId: string;
  pipe: PipeDef;
  checkpoint?: Checkpoint;
  invocation?: TriggerInvocation;
  signal?: AbortSignal;
  credentials?: CredentialStore;
  /** Formal infrastructure boundary (Phase 1). Prefer over ad-hoc access. */
  infrastructure?: InfrastructureContext;
  /**
   * Sub-workflow dispatch (`workflow.sub`). Engine-injected; carries the
   * circular-dependency guard and max nesting depth.
   */
  workflows?: WorkflowService;
  /**
   * Environment variables resolved for this run (global then workflow-local)
   * and frozen on the run record. Exposed to templates as `{{vars.*}}`.
   */
  variables?: Record<string, unknown>;
  /**
   * Where a pipe puts records that are the *workflow's* answer, for a caller
   * waiting on a synchronous response. Engine-injected and run-scoped, so a
   * pipe declares the intent and the engine owns how it is persisted and
   * returned. Absent when nothing is waiting.
   */
  output?: RunOutputCollector;
  /**
   * Ask a person for something the run cannot proceed without — an OTP, a
   * CAPTCHA solution, a setting nobody filled in. Engine-injected and
   * run-scoped, like `output`: the pipe declares what it needs and the engine
   * owns pausing, notifying, storing and resuming.
   *
   * Absent when nothing can service a request (a dry run, a preview). A pipe
   * that needs input and finds this missing should fail rather than block —
   * there is no one on the other end.
   */
  humanInput?: HumanInputGateway;
}

/**
 * The pipe's half of human-in-the-loop. `get` first, `require` only if the
 * answer is not yet there — a pipe is re-executed after being answered, so
 * this pair is the whole protocol.
 */
export interface HumanInputGateway {
  /** The answer for this key on this run, or undefined if not yet given. */
  get(key: string): Promise<Record<string, unknown> | undefined>;
  /**
   * Suspend the run and ask. Never returns: it throws `HumanInputRequired`,
   * which the runtime turns into a paused run rather than a failed one. Typed
   * as `never` so a caller cannot accidentally treat it as a value.
   */
  require(request: HumanInputRequest): never;
}

/** Collects a run's response payload in emission order. */
export interface RunOutputCollector {
  collect(records: Record<string, unknown>[]): void;
}

interface PipeBase {
  type: string;
  role: PipeRole;
  validateConfig?(config: Record<string, unknown>): void;
  /** Required for Phase 1 registry-driven UI; enforced by `listMetadata`. */
  metadata?(): PipeMetadata;
  /**
   * Optional error policy hook. Return `retry` to force a retry attempt,
   * `fail` to fail immediately, or `skip` to treat the error as soft skip
   * (executor maps to pipe `skipped` when supported).
   */
  onError?(error: Error, context: PipeContext): ErrorAction | Promise<ErrorAction>;
}

export interface SourcePipe extends PipeBase {
  role: 'trigger' | 'source';
  read(context: PipeContext): AsyncIterable<RecordBatch>;
}

export interface TransformPipe extends PipeBase {
  role: 'transform';
  /**
   * Transform one inbound batch. Return a single batch, several batches, a
   * `Map` keyed by named output port (for branching), or `undefined` to drop.
   */
  transform(
    batch: RecordBatch,
    context: PipeContext,
  ): Promise<RecordBatch | RecordBatch[] | Map<string, RecordBatch> | undefined>;
}

export interface SinkPipe extends PipeBase {
  role: 'sink';
  write(batch: RecordBatch, context: PipeContext): Promise<void>;
  /**
   * The run is over: release anything kept for it. A sink instance serves
   * every run, so state keyed by run (a file's header already written) would
   * otherwise grow for as long as the engine runs. Called once the run is
   * terminal — not when it pauses, since a resumed run writes on.
   */
  finishRun?(workflowRunId: string): void | Promise<void>;
}

export type AnyPipe = SourcePipe | TransformPipe | SinkPipe;

export class PipeRegistry {
  private readonly pipes = new Map<string, AnyPipe>();
  private readonly providers = new Map<string, PipeProvider>();

  constructor(pipes: AnyPipe[] = []) {
    pipes.forEach((pipe) => this.register(pipe));
  }

  /**
   * Register a pipe implementation. `provider` is the stamped provenance —
   * built-in by default; plugin loaders pass their own. Plugin type ids must
   * carry the plugin's namespace prefix; built-ins own the bare id space.
   */
  register(pipe: AnyPipe, provider: PipeProvider = FOXFLOW_PROVIDER): void {
    if (!NAMESPACE_PATTERN.test(provider.namespace)) {
      throw new Error(`invalid pipe namespace: ${provider.namespace}`);
    }
    if (provider.origin === 'plugin') {
      if (!pipe.type.startsWith(`${provider.namespace}/`)) {
        throw new Error(
          `plugin pipe type must be namespaced "${provider.namespace}/…", got: ${pipe.type}`,
        );
      }
    } else if (pipe.type.includes('/')) {
      throw new Error(
        `built-in pipe type must not be namespaced, got: ${pipe.type}`,
      );
    }
    if (this.pipes.has(pipe.type)) {
      throw new Error(`pipe already registered: ${pipe.type}`);
    }
    this.pipes.set(pipe.type, pipe);
    this.providers.set(pipe.type, provider);
  }

  get(pipe: PipeDef): AnyPipe {
    const implementation = this.pipes.get(pipe.type);
    if (!implementation) {
      throw new Error(`pipe not registered: ${pipe.type}`);
    }
    if (implementation.role !== pipe.role) {
      const sourceRoles =
        implementation.role === 'source' && pipe.role === 'trigger';
      if (!sourceRoles) {
        throw new Error(
          `pipe ${pipe.type} has role ${implementation.role}, expected ${pipe.role}`,
        );
      }
    }
    implementation.validateConfig?.(pipe.config);
    return implementation;
  }

  /** Metadata for all registered pipes that expose `metadata()`. */
  listMetadata(): PipeMetadata[] {
    return [...this.pipes.values()]
      .map((pipe) => this.requireMetadata(pipe))
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  metadata(type: string): PipeMetadata {
    const pipe = this.pipes.get(type);
    if (!pipe) throw new Error(`pipe not registered: ${type}`);
    return this.requireMetadata(pipe);
  }

  private requireMetadata(pipe: AnyPipe): PipeMetadata {
    if (!pipe.metadata) {
      throw new Error(`pipe ${pipe.type} is missing metadata()`);
    }
    const meta = pipe.metadata();
    if (meta.type !== pipe.type) {
      throw new Error(`pipe ${pipe.type} metadata type mismatch: ${meta.type}`);
    }
    // Provenance is registry-stamped; a self-declared provider never survives.
    return { ...meta, provider: this.providers.get(pipe.type) };
  }
}
