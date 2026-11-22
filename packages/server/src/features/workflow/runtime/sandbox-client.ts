/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Parent-side supervisor & IPC bridge for the sandboxed workflow engine child
 * process, plus an in-process adapter for explicit test/debug fallback.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertSafeSqliteSql } from '@foxschema/sql';
import type { EngineRuntimeConfig } from '@foxschema/shared';
import {
  NATIVE_ADDON_SQL_DIALECTS,
  decodeKey,
  gateForHandle,
  runSandboxedWithLogs,
  type CreateCredentialInput,
  type CredentialMeta,
  type WorkflowDef,
} from '@foxschema/workflow-engine';
import { assertSafeUserDatabasePath } from '../../../platform/connections/resolve.js';
import { getLogger } from '../../../platform/logger/logger.js';
import { linkedConnectionsIn } from '../engine-routes.js';
import { loadConfiguredPlugins, type AppContext } from './context.js';
import { ensureSandboxBundle } from './sandbox-bundle.js';
import {
  buildSandboxEnv,
  buildSandboxExecArgv,
  prepareSandboxDirectories,
  resolveSandboxPaths,
  type SandboxPaths,
} from './sandbox-policy.js';
import {
  deserializeError,
  serializeError,
  type ChildToParentMessage,
  type ParentRpcMethod,
  type ParentToChildMessage,
  type RunEventStreamHandlers,
  type RunScriptSandboxParams,
  type SandboxHttpRequest,
  type SandboxHttpResponse,
  type SqlCloseParams,
  type SqlOpenParams,
  type SqlOpenResult,
  type SqlQueryParams,
  type SqlTxParams,
  type WorkflowEngineBackend,
} from './sandbox-protocol.js';
import { streamRunEvents } from './routes/runs.js';

const INIT_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 60_000;
const SHUTDOWN_RPC_TIMEOUT_MS = 3_000;
const SIGTERM_GRACE_MS = 1_500;
const BACKOFF_SCHEDULE_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;
const STABLE_UPTIME_RESET_MS = 30_000;
const SCRIPT_TIMEOUT_MAX_MS = 60_000;
const SCRIPT_HEAP_MAX_MB = 512;
const SQL_SESSION_IDLE_MS = 10 * 60_000;
const MAX_SQL_SESSIONS = 64;

export interface WorkflowSandboxClientOptions {
  databasePath?: string;
  encryptionKey: string;
  resolveFoxSchemaConnection: (
    connectionId: string,
  ) => Promise<Record<string, unknown> | undefined>;
  loadRuntimeConfig: () => Promise<EngineRuntimeConfig>;
  onReadyChange?: (ready: boolean) => void;
}

interface PendingPromise<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveStream {
  handlers: RunEventStreamHandlers;
  headReceived: boolean;
}

interface ActiveSqlSession {
  dialect: string;
  handle: unknown;
  query: (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>;
  beginTransaction: () => Promise<void>;
  commitTransaction: () => Promise<void>;
  rollbackTransaction: () => Promise<void>;
  close: () => Promise<void>;
  idleTimer: ReturnType<typeof setTimeout>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export class WorkflowSandboxClient implements WorkflowEngineBackend {
  readonly mode = 'sandbox' as const;

  private child: ChildProcess | undefined;
  private ready = false;
  private childPermissionEnforced = false;
  private closing = false;
  private lifecycleStarted = false;
  private startedAt = 0;
  private consecutiveRestarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private inflightStart: Promise<void> | undefined;

  private readonly pendingRpc = new Map<string, PendingPromise<unknown>>();
  private readonly pendingHttp = new Map<string, PendingPromise<SandboxHttpResponse>>();
  private readonly activeStreams = new Map<string, ActiveStream>();
  private readonly sqlSessions = new Map<string, ActiveSqlSession>();

  constructor(private readonly options: WorkflowSandboxClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get permissionEnforced(): boolean {
    return this.childPermissionEnforced;
  }

  isReady(): boolean {
    return this.ready && !this.closing && Boolean(this.child?.connected);
  }

  /** Validate the key up-front and spawn + initialize the sandboxed child. */
  async start(): Promise<void> {
    if (this.isReady()) return;
    if (this.inflightStart) return this.inflightStart;
    // Validate 32-byte key immediately so misconfiguration fails fast with the
    // exact synchronous key error before spawning any process.
    decodeKey(this.options.encryptionKey);
    this.inflightStart = this.spawnAndInit(false).finally(() => {
      this.inflightStart = undefined;
    });
    return this.inflightStart;
  }

  private async spawnAndInit(isRestart: boolean): Promise<void> {
    if (this.closing) return;

    const paths = resolveSandboxPaths(process.env, {
      ...(this.options.databasePath !== undefined ? { databasePath: this.options.databasePath } : {}),
    });
    prepareSandboxDirectories(paths);

    const workerBundlePath = await ensureSandboxBundle(paths.repoRoot);
    const runtimeConfig = await this.options.loadRuntimeConfig();
    const env = buildSandboxEnv(process.env, paths);
    const execArgv = buildSandboxExecArgv({
      workerBundlePath,
      paths,
      parentEnv: process.env,
    });

    await this.launchChild(paths, workerBundlePath, execArgv, env, runtimeConfig, isRestart);
  }

  private launchChild(
    paths: SandboxPaths,
    workerBundlePath: string,
    execArgv: string[],
    env: Record<string, string>,
    runtimeConfig: EngineRuntimeConfig,
    isRestart: boolean,
  ): Promise<void> {
    return new Promise<void>((resolveReady, rejectReady) => {
      if (this.closing) {
        rejectReady(new Error('Workflow sandbox closed before start'));
        return;
      }

      const child = spawn(process.execPath, [...execArgv, workerBundlePath], {
        cwd: paths.repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      this.child = child;
      this.ready = false;
      this.childPermissionEnforced = false;

      let settled = false;
      let initStderr = '';

      const settleErr = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        if (!this.closing) {
          this.killProcess(child, 'SIGKILL');
        }
        rejectReady(error);
      };

      const initTimer = setTimeout(() => {
        settleErr(new Error(`Workflow sandbox failed to initialize within ${INIT_TIMEOUT_MS}ms`));
      }, INIT_TIMEOUT_MS);
      initTimer.unref?.();

      this.forwardChildLogs(child, (line) => {
        if (!settled && initStderr.length < 2_000) {
          initStderr += (initStderr ? '\n' : '') + line;
        }
      });

      child.on('message', (msg: ChildToParentMessage) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(initTimer);
          this.ready = true;
          this.childPermissionEnforced = msg.permissionEnforced;
          this.startedAt = Date.now();
          this.options.onReadyChange?.(true);
          resolveReady();
          return;
        }
        if (msg.type === 'init.err') {
          settleErr(deserializeError(msg.error));
          return;
        }
        this.handleChildMessage(msg);
      });

      child.once('error', (error) => {
        if (!settled) {
          settleErr(error);
          return;
        }
        this.handleChildExit(child, null, error.message);
      });

      child.once('exit', (code, signal) => {
        if (!settled) {
          const detail = initStderr.trim() || `code=${String(code)} signal=${String(signal)}`;
          settleErr(new Error(`Workflow sandbox exited during startup (${detail})`));
          return;
        }
        this.handleChildExit(child, code, signal ? String(signal) : undefined);
      });

      const initMsg: ParentToChildMessage = {
        type: 'init',
        config: {
          databasePath: paths.databasePath,
          encryptionKey: this.options.encryptionKey,
          filesDir: paths.filesDir,
          ...(paths.logDir ? { logDir: paths.logDir } : {}),
          startLifecycle: isRestart ? this.lifecycleStarted : false,
          runtimeConfig,
        },
      };
      child.send(initMsg);
    });
  }

  private forwardChildLogs(child: ChildProcess, onStderrLine?: (line: string) => void): void {
    const logger = getLogger();
    const attach = (stream: NodeJS.ReadableStream | null, level: 'info' | 'warn') => {
      if (!stream) return;
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        for (;;) {
          const idx = buf.indexOf('\n');
          if (idx === -1) break;
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line) continue;
          if (level === 'warn') onStderrLine?.(line);
          if (line.includes('ExperimentalWarning: SQLite')) continue;
          logger[level]({ component: 'workflow-sandbox', pid: child.pid }, line);
        }
      });
    };
    attach(child.stdout, 'info');
    attach(child.stderr, 'warn');
  }

  private handleChildMessage(msg: ChildToParentMessage): void {
    switch (msg.type) {
      case 'http.res': {
        const pending = this.pendingHttp.get(msg.id);
        if (!pending) return;
        this.pendingHttp.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg.res);
        break;
      }
      case 'sse.head': {
        const stream = this.activeStreams.get(msg.streamId);
        if (!stream || stream.headReceived) return;
        stream.headReceived = true;
        stream.handlers.onHead(msg.statusCode);
        break;
      }
      case 'sse.chunk': {
        const stream = this.activeStreams.get(msg.streamId);
        if (!stream) return;
        stream.handlers.onChunk(msg.chunk);
        break;
      }
      case 'sse.end': {
        const stream = this.activeStreams.get(msg.streamId);
        if (!stream) return;
        this.activeStreams.delete(msg.streamId);
        stream.handlers.onEnd();
        break;
      }
      case 'rpc.res': {
        const pending = this.pendingRpc.get(msg.id);
        if (!pending) return;
        this.pendingRpc.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(deserializeError(msg.error));
        break;
      }
      case 'rev.req':
        void this.handleReverseRpc(msg.id, msg.method, msg.params);
        break;
    }
  }

  private async handleReverseRpc(
    id: string,
    method: Extract<ChildToParentMessage, { type: 'rev.req' }>['method'],
    params: unknown,
  ): Promise<void> {
    try {
      let result: unknown;
      if (method === 'resolveConnection') {
        const { connectionId } = params as { connectionId: string };
        result = await this.options.resolveFoxSchemaConnection(connectionId);
      } else if (method === 'runScriptSandbox') {
        const { body, records, options } = params as RunScriptSandboxParams;
        const timeoutMs = clampInt(options?.timeoutMs, 1, SCRIPT_TIMEOUT_MAX_MS, 5_000);
        const maxOldGenerationSizeMb = clampInt(
          options?.maxOldGenerationSizeMb,
          16,
          SCRIPT_HEAP_MAX_MB,
          128,
        );
        result = await runSandboxedWithLogs(body, records, {
          timeoutMs,
          maxOldGenerationSizeMb,
          isolation: 'process',
        });
      } else if (method === 'sqlOpen') {
        result = await this.openParentSqlSession(params as SqlOpenParams);
      } else if (method === 'sqlQuery') {
        const { sessionId, sql, params: sqlParams } = params as SqlQueryParams;
        const session = this.touchSqlSession(sessionId);
        if (session.dialect.trim().toLowerCase() === 'sqlite') {
          assertSafeSqliteSql(sql);
        }
        result = await session.query(sql, sqlParams);
      } else if (method === 'sqlTx') {
        const { sessionId, action } = params as SqlTxParams;
        const session = this.touchSqlSession(sessionId);
        if (action === 'begin') await session.beginTransaction();
        else if (action === 'commit') await session.commitTransaction();
        else if (action === 'rollback') await session.rollbackTransaction();
        else throw new Error(`Unsupported SQL tx action: ${String(action)}`);
        result = { ok: true };
      } else if (method === 'sqlClose') {
        const { sessionId } = params as SqlCloseParams;
        await this.closeSqlSession(sessionId);
        result = { ok: true };
      } else {
        throw new Error(`Unsupported reverse RPC method: ${String(method)}`);
      }
      this.sendToChild({ type: 'rev.res', id, ok: true, result });
    } catch (error) {
      this.sendToChild({
        type: 'rev.res',
        id,
        ok: false,
        error: serializeError(error),
      });
    }
  }

  private async openParentSqlSession(params: SqlOpenParams): Promise<SqlOpenResult> {
    const normalizedDialect = params.dialect.trim().toLowerCase();
    if (!NATIVE_ADDON_SQL_DIALECTS.has(normalizedDialect)) {
      throw new Error(`Dialect "${params.dialect}" is not delegated through the parent SQL runner`);
    }
    if (this.sqlSessions.size >= MAX_SQL_SESSIONS) {
      throw new Error('Too many concurrent workflow SQL sessions');
    }
    assertSafeUserDatabasePath(params.dialect, params.option as never);

    const db = await import('@foxschema/db');
    const adapter = db.getAdapter(params.dialect);
    const handle = await db.ConnectionFactory.create(params.dialect, params.option as never, {
      pooled: !params.dedicated,
    });
    try {
      if (params.schema) await adapter.setCurrentSchema(handle, params.schema);
    } catch (error) {
      await db.ConnectionFactory.close(params.dialect, handle).catch(() => undefined);
      throw error;
    }

    const sessionId = randomUUID();
    const canRollBack = db.dialectSupportsTransactionalRollback(params.dialect);
    const makeIdleTimer = () => {
      const timer = setTimeout(() => {
        void this.closeSqlSession(sessionId);
      }, SQL_SESSION_IDLE_MS);
      timer.unref?.();
      return timer;
    };

    // The SQLite and DuckDB adapters hand every session on a file the same
    // handle, `dedicated` or not. The gate keeps one session's statements and
    // BEGIN out of another's open transaction on that handle.
    const gate = gateForHandle(handle);
    const owner = Symbol(sessionId);
    this.sqlSessions.set(sessionId, {
      dialect: params.dialect,
      handle,
      query: (sql, sqlParams) => gate.run(owner, () => adapter.query<Record<string, unknown>>(handle, sql, sqlParams)),
      beginTransaction: () => gate.begin(owner, () => adapter.beginTransaction(handle)),
      commitTransaction: async () => {
        try {
          await adapter.commitTransaction(handle);
        } finally {
          gate.release(owner);
        }
      },
      rollbackTransaction: async () => {
        try {
          await adapter.rollbackTransaction(handle);
        } finally {
          gate.release(owner);
        }
      },
      close: async () => {
        // A session closed mid-transaction (idle timeout, sandbox crash) must
        // not leave the shared handle in its transaction, or locked for others.
        if (gate.holds(owner)) {
          await adapter.rollbackTransaction(handle).catch(() => undefined);
          gate.release(owner);
        }
        await db.ConnectionFactory.close(params.dialect, handle);
      },
      idleTimer: makeIdleTimer(),
    });

    return { sessionId, canRollBack };
  }

  private touchSqlSession(sessionId: string): ActiveSqlSession {
    const session = this.sqlSessions.get(sessionId);
    if (!session) throw new Error(`Workflow SQL session not found or already closed: ${sessionId}`);
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.closeSqlSession(sessionId);
    }, SQL_SESSION_IDLE_MS);
    session.idleTimer.unref?.();
    return session;
  }

  private async closeSqlSession(sessionId: string): Promise<void> {
    const session = this.sqlSessions.get(sessionId);
    if (!session) return;
    this.sqlSessions.delete(sessionId);
    clearTimeout(session.idleTimer);
    await session.close().catch(() => undefined);
  }

  private closeAllSqlSessions(): void {
    for (const sessionId of [...this.sqlSessions.keys()]) {
      void this.closeSqlSession(sessionId);
    }
  }

  private handleChildExit(
    exitedChild: ChildProcess,
    code: number | null,
    signal: string | undefined,
  ): void {
    if (this.child !== exitedChild) return;
    this.child = undefined;
    this.ready = false;
    this.childPermissionEnforced = false;
    this.options.onReadyChange?.(false);

    this.rejectAllInFlight(new Error('Workflow sandbox exited before responding'));

    if (this.closing) return;

    const uptime = this.startedAt ? Date.now() - this.startedAt : 0;
    if (uptime >= STABLE_UPTIME_RESET_MS) {
      this.consecutiveRestarts = 0;
    }
    const delayMs =
      BACKOFF_SCHEDULE_MS[
        Math.min(this.consecutiveRestarts, BACKOFF_SCHEDULE_MS.length - 1)
      ]!;
    this.consecutiveRestarts += 1;

    getLogger().warn(
      { component: 'workflow-sandbox', code, signal, restartInMs: delayMs },
      'sandboxed workflow engine exited unexpectedly; scheduling restart',
    );

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.respawnAfterCrash();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private async respawnAfterCrash(): Promise<void> {
    if (this.closing || this.isReady()) return;
    if (this.inflightStart) return;
    this.inflightStart = this.spawnAndInit(true)
      .catch((error) => {
        getLogger().error(
          { component: 'workflow-sandbox', err: error },
          'failed to respawn sandboxed workflow engine',
        );
        if (!this.closing) {
          this.handleCrashRetry();
        }
      })
      .finally(() => {
        this.inflightStart = undefined;
      });
    await this.inflightStart;
  }

  private handleCrashRetry(): void {
    if (this.closing || this.restartTimer) return;
    const delayMs =
      BACKOFF_SCHEDULE_MS[
        Math.min(this.consecutiveRestarts, BACKOFF_SCHEDULE_MS.length - 1)
      ]!;
    this.consecutiveRestarts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.respawnAfterCrash();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private rejectAllInFlight(error: Error): void {
    for (const [id, pending] of this.pendingRpc.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRpc.delete(id);
    }
    for (const [id, pending] of this.pendingHttp.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingHttp.delete(id);
    }
    for (const [streamId, stream] of this.activeStreams.entries()) {
      this.activeStreams.delete(streamId);
      stream.handlers.onEnd();
    }
    this.closeAllSqlSessions();
  }

  private sendToChild(msg: ParentToChildMessage): void {
    if (this.child?.connected) {
      this.child.send(msg);
    }
  }

  private async waitForReadyIfRestarting(): Promise<void> {
    if (this.isReady()) return;
    if (this.closing) throw new Error('Workflow sandbox is closed');
    if (this.inflightStart) {
      await this.inflightStart;
      if (this.isReady()) return;
    }
    throw new Error('Workflow sandbox is unavailable');
  }

  private async callRpc<T>(
    method: ParentRpcMethod,
    params?: unknown,
    timeoutMs: number = RPC_TIMEOUT_MS,
  ): Promise<T> {
    if (method !== 'shutdown') {
      await this.waitForReadyIfRestarting();
    }
    const child = this.child;
    if (!child?.connected) {
      throw new Error('Workflow sandbox IPC channel is not connected');
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Workflow sandbox RPC "${method}" timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRpc.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.send({ type: 'rpc.req', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  async getWorkflow(id: string): Promise<WorkflowDef | undefined> {
    return this.callRpc<WorkflowDef | undefined>('getWorkflow', { workflowId: id });
  }

  async getRunSnapshot(id: string): Promise<WorkflowDef | undefined> {
    return this.callRpc<WorkflowDef | undefined>('getRunSnapshot', { runId: id });
  }

  async getRunLinkedConnections(runIds: readonly string[]): Promise<Record<string, string[]>> {
    if (runIds.length === 0) return {};
    return this.callRpc<Record<string, string[]>>('getRunLinkedConnections', { runIds });
  }

  readonly credentials = {
    create: (input: CreateCredentialInput): Promise<CredentialMeta> =>
      this.callRpc<CredentialMeta>('createCredential', input),
    remove: (credentialId: string): Promise<boolean> =>
      this.callRpc<boolean>('removeCredential', { credentialId }),
  };

  async applyRuntimeConfig(config: EngineRuntimeConfig): Promise<void> {
    if (!this.isReady()) return;
    await this.callRpc('applyConfig', config);
  }

  async startLifecycle(): Promise<void> {
    this.lifecycleStarted = true;
    await this.callRpc('startLifecycle');
  }

  async enqueueWorkflow(
    workflow: WorkflowDef,
  ): Promise<{ accepted: boolean; reason?: string; runId?: string }> {
    return this.callRpc('enqueueWorkflow', { workflow });
  }

  async injectHttp(req: SandboxHttpRequest): Promise<SandboxHttpResponse> {
    await this.waitForReadyIfRestarting();
    const child = this.child;
    if (!child?.connected) {
      throw new Error('Workflow sandbox IPC channel is not connected');
    }
    const id = randomUUID();
    return new Promise<SandboxHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHttp.delete(id);
        reject(new Error(`Workflow sandbox HTTP request timed out (${req.method} ${req.url})`));
      }, HTTP_TIMEOUT_MS);
      timer.unref?.();
      this.pendingHttp.set(id, { resolve, reject, timer });
      child.send({ type: 'http.req', id, req });
    });
  }

  openRunEventsStream(
    runId: string,
    after: number,
    handlers: RunEventStreamHandlers,
  ): () => void {
    const streamId = randomUUID();
    if (!this.isReady() || !this.child?.connected) {
      queueMicrotask(() => {
        handlers.onHead(503);
        handlers.onEnd();
      });
      return () => undefined;
    }

    this.activeStreams.set(streamId, { handlers, headReceived: false });
    this.child.send({ type: 'sse.open', streamId, runId, after });

    return () => {
      if (!this.activeStreams.delete(streamId)) return;
      this.sendToChild({ type: 'sse.close', streamId });
    };
  }

  async probeHealth(): Promise<{
    ok: boolean;
    pid?: number;
    sandboxed: boolean;
    error?: string;
  }> {
    if (!this.isReady()) {
      return {
        ok: false,
        sandboxed: true,
        error: 'Workflow engine sandbox is starting or unavailable',
      };
    }
    try {
      const res = await this.callRpc<{ ok: boolean; pid: number }>('health', undefined, 5_000);
      return {
        ok: res.ok,
        pid: res.pid,
        sandboxed: true,
        ...(res.ok ? {} : { error: 'Workflow engine sandbox reported not ready' }),
      };
    } catch (error) {
      return {
        ok: false,
        sandboxed: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private killProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    } catch {
      // process already dead
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.ready = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.options.onReadyChange?.(false);

    const child = this.child;
    if (!child) {
      this.rejectAllInFlight(new Error('Workflow sandbox closed'));
      return;
    }

    const exited = new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
        return;
      }
      child.once('exit', () => resolveExit());
    });

    if (child.connected) {
      await this.callRpc('shutdown', undefined, SHUTDOWN_RPC_TIMEOUT_MS).catch(() => undefined);
    }

    const cleanShutdown = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SIGTERM_GRACE_MS).unref()),
    ]);

    if (!cleanShutdown) {
      this.killProcess(child, 'SIGTERM');
      const termDone = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000).unref()),
      ]);
      if (!termDone) {
        this.killProcess(child, 'SIGKILL');
        await exited;
      }
    }

    this.child = undefined;
    this.rejectAllInFlight(new Error('Workflow sandbox closed'));
  }
}

/** Explicit `FOXFLOW_SANDBOX_MODE=in-process` backend adapter for tests/debug. */
export function createInProcessBackend(
  ctx: AppContext,
  options: {
    onClose?: () => Promise<void> | void;
    onApplyConfig?: (config: EngineRuntimeConfig) => void;
  } = {},
): WorkflowEngineBackend {
  let lifecycleStarted = false;
  return {
    mode: 'in-process',
    pid: process.pid,
    permissionEnforced: false,
    isReady: () => true,
    getWorkflow: (id) => ctx.workflows.get(id),
    getRunSnapshot: (id) => ctx.runs.getSnapshot(id),
    async getRunLinkedConnections(runIds) {
      const out: Record<string, string[]> = {};
      for (const runId of runIds) {
        const snapshot = await ctx.runs.getSnapshot(runId);
        if (snapshot) out[runId] = linkedConnectionsIn(snapshot);
      }
      return out;
    },
    credentials: {
      create: (input) => ctx.credentials.create(input),
      remove: (id) => ctx.credentials.remove(id),
    },
    async applyRuntimeConfig(config) {
      ctx.scheduler.setAdmission({
        state: config.state,
        maxConcurrentRuns: config.maxParallel,
      });
      options.onApplyConfig?.(config);
    },
    async startLifecycle() {
      if (lifecycleStarted) return;
      lifecycleStarted = true;
      await loadConfiguredPlugins(ctx.registry);
      await ctx.scheduler.recover();
      await ctx.cron.recover();
      ctx.cron.start();
    },
    async enqueueWorkflow(workflow) {
      const enqueued = await ctx.scheduler.enqueue(workflow);
      return {
        accepted: enqueued.accepted,
        ...(enqueued.reason ? { reason: enqueued.reason } : {}),
        ...(enqueued.run?.id ? { runId: enqueued.run.id } : {}),
      };
    },
    async injectHttp() {
      throw new Error('in-process backend registers Fastify plugins directly rather than via injectHttp');
    },
    openRunEventsStream(runId, after, handlers) {
      let stopped = false;
      let innerStop: (() => void) | undefined;
      void ctx.runs.get(runId).then((run) => {
        if (stopped) return;
        if (!run) {
          handlers.onHead(404);
          handlers.onEnd();
          return;
        }
        handlers.onHead(200);
        innerStop = streamRunEvents(ctx, runId, after, {
          onChunk: handlers.onChunk,
          onEnd: handlers.onEnd,
        });
      });
      return () => {
        stopped = true;
        innerStop?.();
      };
    },
    async probeHealth() {
      return { ok: true, pid: process.pid, sandboxed: false };
    },
    async close() {
      ctx.cron.stop();
      await Promise.race([
        ctx.scheduler.idle(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
      ]);
      await options.onClose?.();
      ctx.close();
    },
  };
}
