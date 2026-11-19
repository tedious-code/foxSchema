/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sandboxed workflow engine worker process.
 *
 * Runs strictly as a child process spawned by FoxSchema over a private OS IPC
 * channel under Node `--permission` (no `--allow-child-process`, no
 * `--allow-worker`, stripped environment, narrow FS allowlist). Never opens a
 * TCP or Unix socket listener — refuses to boot if invoked standalone without
 * a parent IPC channel.
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { EngineRuntimeConfig } from '@foxschema/workflow-contract';
import {
  decodeKey,
  setScriptSandboxDelegate,
  setSqlRunnerDelegate,
  type CreateCredentialInput,
  type WorkflowDef,
} from '@foxschema/workflow-engine';
import { linkedConnectionsIn } from '../engine-routes.js';
import { createContext, loadConfiguredPlugins, type AppContext } from './context.js';
import { RunEventSinks } from './run-event-sinks.js';
import {
  deserializeError,
  serializeError,
  type ChildReverseRpcMethod,
  type ChildToParentMessage,
  type ParentToChildMessage,
  type RunScriptSandboxParams,
  type SandboxHttpRequest,
  type SandboxInitConfig,
  type SqlCloseParams,
  type SqlOpenParams,
  type SqlOpenResult,
  type SqlQueryParams,
  type SqlTxParams,
} from './sandbox-protocol.js';
import { credentialRoutes } from './routes/credentials.js';
import { middlewareRoutes } from './routes/middleware.js';
import { pipeRoutes } from './routes/pipes.js';
import { previewRoutes } from './routes/preview.js';
import { runRoutes, streamRunEvents } from './routes/runs.js';
import { triggerRoutes } from './routes/triggers.js';
import { variableRoutes } from './routes/variables.js';
import { workflowRoutes } from './routes/workflows.js';
import { serializerCompiler, validatorCompiler } from './zod-provider.js';

if (typeof process.send !== 'function' || !process.connected) {
  process.stderr.write('[workflow-sandbox] Refusing to start outside FoxSchema IPC channel\n');
  process.exit(1);
}

const REVERSE_RPC_TIMEOUT_MS = 120_000;
const ENGINE_IDLE_CLOSE_MS = 2_000;

interface PendingReverseRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingReverse = new Map<string, PendingReverseRpc>();
const openStreams = new Map<string, () => void>();

let ctx: AppContext | undefined;
let app: FastifyInstance | undefined;
let sinks: RunEventSinks | undefined;
let unsubscribeSinks: (() => void) | undefined;
let lifecycleStarted = false;
let shuttingDown = false;

function sendToParent(msg: ChildToParentMessage): void {
  if (typeof process.send === 'function' && process.connected) {
    process.send(msg);
  }
}

function callParent<T>(method: ChildReverseRpcMethod, params: unknown): Promise<T> {
  if (!process.connected) {
    return Promise.reject(new Error('Parent FoxSchema IPC channel is disconnected'));
  }
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReverse.delete(id);
      reject(new Error(`Reverse RPC "${method}" timed out`));
    }, REVERSE_RPC_TIMEOUT_MS);
    timer.unref?.();
    pendingReverse.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    sendToParent({ type: 'rev.req', id, method, params });
  });
}

function applyRuntimeConfig(config: EngineRuntimeConfig): void {
  if (!ctx) return;
  ctx.scheduler.setAdmission({
    state: config.state,
    maxConcurrentRuns: config.maxParallel,
  });
  sinks?.configure(Array.isArray(config.sinks) ? config.sinks : []);
}

async function startLifecycleOnce(): Promise<void> {
  if (!ctx || lifecycleStarted) return;
  lifecycleStarted = true;
  await loadConfiguredPlugins(ctx.registry);
  await ctx.scheduler.recover();
  await ctx.cron.recover();
  ctx.cron.start();
}

async function shutdownEngine(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const stop of [...openStreams.values()]) {
    stop();
  }
  openStreams.clear();

  for (const [id, pending] of pendingReverse.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Workflow sandbox shutting down'));
    pendingReverse.delete(id);
  }

  if (ctx) {
    ctx.cron.stop();
    await Promise.race([
      ctx.scheduler.idle(),
      new Promise<void>((resolve) => setTimeout(resolve, ENGINE_IDLE_CLOSE_MS).unref()),
    ]);
  }

  unsubscribeSinks?.();
  unsubscribeSinks = undefined;
  await sinks?.close().catch(() => undefined);
  sinks = undefined;

  if (app) {
    await app.close().catch(() => undefined);
    app = undefined;
  }

  ctx?.close();
  ctx = undefined;
  setScriptSandboxDelegate(undefined);
  setSqlRunnerDelegate(undefined);
}

async function initializeWorker(config: SandboxInitConfig): Promise<void> {
  if (ctx) {
    throw new Error('Workflow sandbox already initialized');
  }

  setScriptSandboxDelegate(async (body, records, options) => {
    const payload: RunScriptSandboxParams = { body, records, options };
    return callParent('runScriptSandbox', payload);
  });

  // Delegate native-addon dialects (file-based SQLite, DuckDB, IBM Db2) over
  // private reverse IPC to FoxSchema so those workflows work out of the box
  // while the sandbox child stays strictly free of `--allow-addons` and host FS access.
  setSqlRunnerDelegate(async (connection, { dedicated }) => {
    const openParams: SqlOpenParams = {
      dialect: connection.dialect,
      ...(connection.schema ? { schema: connection.schema } : {}),
      option: connection.option,
      dedicated,
    };
    const { sessionId, canRollBack } = await callParent<SqlOpenResult>('sqlOpen', openParams);
    return {
      query: (sql, params) => {
        const queryParams: SqlQueryParams = { sessionId, sql, params };
        return callParent<Record<string, unknown>[]>('sqlQuery', queryParams);
      },
      async transaction(work) {
        if (!canRollBack) return work();
        const begin: SqlTxParams = { sessionId, action: 'begin' };
        await callParent('sqlTx', begin);
        try {
          const result = await work();
          const commit: SqlTxParams = { sessionId, action: 'commit' };
          await callParent('sqlTx', commit);
          return result;
        } catch (error) {
          const rollback: SqlTxParams = { sessionId, action: 'rollback' };
          await callParent('sqlTx', rollback).catch(() => undefined);
          throw error;
        }
      },
      close: async () => {
        const closeParams: SqlCloseParams = { sessionId };
        await callParent('sqlClose', closeParams);
      },
    };
  });

  ctx = createContext({
    databasePath: config.databasePath,
    encryptionKey: decodeKey(config.encryptionKey),
    resolveFoxSchemaConnection: async (connectionId) =>
      callParent<Record<string, unknown> | undefined>('resolveConnection', { connectionId }),
  });

  sinks = new RunEventSinks(config.logDir);
  unsubscribeSinks = ctx.onEvent((event) => sinks?.write(event));
  applyRuntimeConfig(config.runtimeConfig);

  const engineCtx = ctx;
  const server = Fastify({
    logger: false,
    // Child only receives app.inject calls from parent over private IPC;
    // rate limiting and proxy-header trust are enforced in the parent FoxSchema server.
    trustProxy: false,
    forceCloseConnections: true,
  });
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  await server.register(rateLimit, { global: false });

  await server.register(
    async (api) => {
      await api.register(credentialRoutes(engineCtx));
      await api.register(pipeRoutes(engineCtx));
      await api.register(previewRoutes());
      await api.register(middlewareRoutes(engineCtx));
      await api.register(workflowRoutes(engineCtx, { extra: false }));
      await api.register(runRoutes(engineCtx, { extra: false }));
      await api.register(variableRoutes(engineCtx, { extra: false }));
    },
    { prefix: '/engine' },
  );

  await server.register(
    async (ingress) => {
      // Rate limiting is applied per real client IP in the parent FoxSchema
      // server (`registerSandboxIngress`), so disable the child's per-route
      // limit that would otherwise bucket all injected callers under 127.0.0.1.
      await ingress.register(triggerRoutes(engineCtx, { rateLimit: false }));
    },
    { prefix: '/ingress' },
  );

  await server.ready();
  app = server;

  if (config.startLifecycle) {
    await startLifecycleOnce();
  }

  sendToParent({
    type: 'ready',
    pid: process.pid,
    permissionEnforced: Boolean((process as { permission?: unknown }).permission),
  });
}

function normalizeResponseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') {
      continue;
    }
    out[lower] = typeof val === 'number' ? String(val) : val;
  }
  return out;
}

async function handleHttpRequest(id: string, req: SandboxHttpRequest): Promise<void> {
  if (!app) {
    sendToParent({
      type: 'http.res',
      id,
      res: {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(JSON.stringify({ error: 'workflow sandbox not initialized' })).toString('base64'),
      },
    });
    return;
  }

  try {
    const payload = req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined;
    const res = await app.inject({
      method: req.method as never,
      url: req.url,
      headers: req.headers,
      ...(payload !== undefined ? { payload } : {}),
    });
    sendToParent({
      type: 'http.res',
      id,
      res: {
        statusCode: res.statusCode,
        headers: normalizeResponseHeaders(res.headers),
        bodyBase64: Buffer.from(res.rawPayload).toString('base64'),
      },
    });
  } catch (error) {
    sendToParent({
      type: 'http.res',
      id,
      res: {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        ).toString('base64'),
      },
    });
  }
}

async function handleSseOpen(streamId: string, runId: string, after: number): Promise<void> {
  if (!ctx) {
    sendToParent({ type: 'sse.head', streamId, statusCode: 503 });
    sendToParent({ type: 'sse.end', streamId });
    return;
  }

  const run = await ctx.runs.get(runId);
  if (!run) {
    sendToParent({ type: 'sse.head', streamId, statusCode: 404 });
    sendToParent({ type: 'sse.end', streamId });
    return;
  }

  sendToParent({ type: 'sse.head', streamId, statusCode: 200 });
  const stop = streamRunEvents(ctx, runId, after, {
    onChunk: (chunk) => sendToParent({ type: 'sse.chunk', streamId, chunk }),
    onEnd: () => {
      openStreams.delete(streamId);
      sendToParent({ type: 'sse.end', streamId });
    },
    onStop: () => {
      openStreams.delete(streamId);
    },
  });
  openStreams.set(streamId, stop);
}

async function handleRpc(
  id: string,
  method: Extract<ParentToChildMessage, { type: 'rpc.req' }>['method'],
  params: unknown,
): Promise<void> {
  try {
    let result: unknown;
    switch (method) {
      case 'health':
        result = { ok: Boolean(ctx && app && !shuttingDown), pid: process.pid };
        break;
      case 'getWorkflow': {
        const { workflowId } = params as { workflowId: string };
        result = ctx ? await ctx.workflows.get(workflowId) : undefined;
        break;
      }
      case 'getRunSnapshot': {
        const { runId } = params as { runId: string };
        result = ctx ? await ctx.runs.getSnapshot(runId) : undefined;
        break;
      }
      case 'getRunLinkedConnections': {
        const { runIds } = params as { runIds: string[] };
        const out: Record<string, string[]> = {};
        if (ctx && Array.isArray(runIds)) {
          for (const runId of runIds) {
            const snapshot = await ctx.runs.getSnapshot(runId);
            if (snapshot) {
              out[runId] = linkedConnectionsIn(snapshot);
            }
          }
        }
        result = out;
        break;
      }
      case 'createCredential': {
        if (!ctx) throw new Error('Workflow sandbox not initialized');
        result = await ctx.credentials.create(params as CreateCredentialInput);
        break;
      }
      case 'removeCredential': {
        if (!ctx) throw new Error('Workflow sandbox not initialized');
        const { credentialId } = params as { credentialId: string };
        result = await ctx.credentials.remove(credentialId);
        break;
      }
      case 'applyConfig': {
        applyRuntimeConfig(params as EngineRuntimeConfig);
        result = { ok: true };
        break;
      }
      case 'startLifecycle': {
        await startLifecycleOnce();
        result = { ok: true };
        break;
      }
      case 'enqueueWorkflow': {
        if (!ctx) throw new Error('Workflow sandbox not initialized');
        const { workflow } = params as { workflow: WorkflowDef };
        const enqueued = await ctx.scheduler.enqueue(workflow);
        result = {
          accepted: enqueued.accepted,
          ...(enqueued.reason ? { reason: enqueued.reason } : {}),
          ...(enqueued.run?.id ? { runId: enqueued.run.id } : {}),
        };
        break;
      }
      case 'shutdown': {
        await shutdownEngine();
        sendToParent({ type: 'rpc.res', id, ok: true, result: { ok: true } });
        setImmediate(() => process.exit(0));
        return;
      }
      default:
        throw new Error(`Unknown RPC method: ${String(method)}`);
    }
    sendToParent({ type: 'rpc.res', id, ok: true, result });
  } catch (error) {
    sendToParent({ type: 'rpc.res', id, ok: false, error: serializeError(error) });
  }
}

process.on('message', (msg: ParentToChildMessage) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'init':
      void initializeWorker(msg.config).catch((error) => {
        sendToParent({ type: 'init.err', error: serializeError(error) });
        void shutdownEngine().finally(() => process.exit(1));
      });
      break;
    case 'http.req':
      void handleHttpRequest(msg.id, msg.req);
      break;
    case 'sse.open':
      void handleSseOpen(msg.streamId, msg.runId, msg.after);
      break;
    case 'sse.close': {
      const stop = openStreams.get(msg.streamId);
      if (stop) {
        openStreams.delete(msg.streamId);
        stop();
      }
      break;
    }
    case 'rpc.req':
      void handleRpc(msg.id, msg.method, msg.params);
      break;
    case 'rev.res': {
      const pending = pendingReverse.get(msg.id);
      if (!pending) return;
      pendingReverse.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(deserializeError(msg.error));
      break;
    }
  }
});

// No orphan workflow engine if FoxSchema terminates unexpectedly.
process.on('disconnect', () => {
  void shutdownEngine().finally(() => process.exit(0));
});
