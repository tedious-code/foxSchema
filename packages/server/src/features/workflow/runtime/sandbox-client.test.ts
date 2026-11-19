/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end containment and IPC integration tests for the sandboxed workflow
 * engine child process: verifies standalone rejection, zero shared secrets,
 * filesystem isolation beside `foxschema.db`, workflow execution with script
 * sandboxing, SSE streaming, webhook HMAC ingress, saved connection RPC, and
 * automatic crash recovery.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@foxschema/shared';
import type { WorkflowEngineConfig } from '@foxschema/workflow-contract';
import { pluginDigest } from '@foxschema/workflow-engine';
import { createFeatureContext } from '../../../app/feature-registry';
import type { AuthedRequest } from '../../../platform/http/types';
import type { WorkflowSettingsService } from '../workflow-settings.service';
import { registerWorkflowEngine } from './register-engine';
import { ensureSandboxBundle } from './sandbox-bundle';
import { WorkflowSandboxClient } from './sandbox-client';

const ALL_PERMS: Permission[] = [
  'workflow.access',
  'workflow.design',
  'workflow.run',
  'workflow.admin',
];

const SAVED_ENV_KEYS = [
  'APP_ENCRYPTION_KEY',
  'APP_DB_PATH',
  'SESSION_SECRET',
  'FOXFLOW_ENCRYPTION_KEY',
  'FOXFLOW_DB_PATH',
  'FOXFLOW_FILES_DIR',
  'FOXFLOW_PLUGINS_DIR',
  'FOXFLOW_PLUGINS_ALLOWLIST',
  'FOXFLOW_SANDBOX_PARENT_ONLY_TEST',
] as const;

let tempDir: string;
let savedEnv: Record<string, string | undefined>;
let backend: WorkflowSandboxClient | undefined;
let app: FastifyInstance | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = fs.mkdtempSync(join(tmpdir(), 'fox-wf-sandbox-test-'));

  // Plant simulated FoxSchema secrets in the SAME parent directory as
  // workflow-engine.sqlite (matching production `/data` layout).
  fs.writeFileSync(join(tempDir, 'foxschema.db'), 'FOXSCHEMA_SECRET_METADATA_DB');
  fs.writeFileSync(join(tempDir, '.app_encryption_key'), 'FOXSCHEMA_SECRET_KEY_MATERIAL');

  process.env.APP_ENCRYPTION_KEY = 'super-secret-app-key';
  process.env.SESSION_SECRET = 'super-secret-session';
  process.env.APP_DB_PATH = join(tempDir, 'foxschema.db');
  process.env.FOXFLOW_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.FOXFLOW_DB_PATH = join(tempDir, 'workflow-engine.sqlite');
  process.env.FOXFLOW_FILES_DIR = join(tempDir, 'workflow-files');
  process.env.FOXFLOW_SANDBOX_PARENT_ONLY_TEST = 'only-in-parent';
});

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await backend?.close().catch(() => undefined);
  backend = undefined;
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runtimeSettings(state: WorkflowEngineConfig['state'] = 'enabled') {
  const cfg: WorkflowEngineConfig = {
    state,
    endpoint: '',
    maxParallel: 4,
    onOverlap: 'parallel',
    processes: [],
    sinks: [],
  };
  return {
    settings: {
      getConfig: async () => cfg,
    } as unknown as WorkflowSettingsService,
    runtimeConfig: { state: cfg.state, maxParallel: cfg.maxParallel, sinks: cfg.sinks },
  };
}

async function mountTestApp(
  client: WorkflowSandboxClient,
  options: { foreignConnections?: string[]; startLifecycle?: boolean } = {},
) {
  const { settings } = runtimeSettings('enabled');
  const server = Fastify({ forceCloseConnections: true });
  server.addHook('onRequest', async (req) => {
    const authed = req as unknown as AuthedRequest;
    authed.userId = 'user-1';
    authed.appRole = 'admin';
    authed.permissions = new Set(ALL_PERMS);
  });
  await registerWorkflowEngine(server, {
    backend: client,
    featureContext: createFeatureContext(),
    settings,
    grants: {
      notUsableBy: async (_userId: string, ids: readonly string[]) =>
        ids.filter((id) => (options.foreignConnections ?? []).includes(id)),
    },
    startLifecycle: options.startLifecycle ?? true,
    sessionGuard: (_req, _res, next) => next(),
  });
  await server.ready();
  app = server;
  return server;
}

describe('sandboxed workflow engine child process', () => {
  it('refuses standalone execution when launched without FoxSchema IPC channel', async () => {
    const bundlePath = await ensureSandboxBundle();
    let exitStatus: number | null = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [bundlePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (err) {
      const failed = err as { status?: number | null; stderr?: string };
      exitStatus = failed.status ?? null;
      stderr = failed.stderr ?? '';
    }
    expect(exitStatus).toBe(1);
    expect(stderr).toMatch(/Refusing to start outside FoxSchema IPC channel/);
  });

  it(
    'enforces Node --permission, stripped env, zero subprocess/worker spawning inside a running plugin, while running script pipes & saving output in filesDir',
    async () => {
      const pluginsRoot = join(tempDir, 'plugins');
      const probeDir = join(pluginsRoot, 'containment-probe');
      fs.mkdirSync(probeDir, { recursive: true });
      fs.writeFileSync(
        join(probeDir, 'foxflow.pipe.json'),
        JSON.stringify({
          name: '@foxtest/probe',
          version: '0.1.0',
          namespace: 'foxtest',
          pipes: [{ type: 'foxtest/probe', entry: './index.mjs', export: 'ProbePipe' }],
        }),
      );
      fs.writeFileSync(
        join(probeDir, 'index.mjs'),
        `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

export class ProbePipe {
  type = 'foxtest/probe';
  role = 'source';
  metadata() {
    return {
      type: this.type,
      name: 'Containment Probe',
      category: 'Test',
      family: 'logic',
      version: '0.1.0',
      role: 'source',
      inputs: [],
      outputs: [{ name: 'out', type: 'records' }],
    };
  }
  async *read(context) {
    const { foxDbPath, appKeyPath, filesOutPath } = context.pipe.config;
    const probeRead = (p) => {
      try { fs.readFileSync(p, 'utf8'); return 'ESCAPED'; }
      catch (e) { return e.code || 'ERR'; }
    };
    let execResult = 'ESCAPED';
    try { execFileSync('echo', ['hi']); } catch (e) { execResult = e.code || 'ERR'; }
    let workerResult = 'ESCAPED';
    try { new Worker('1+1', { eval: true }); } catch (e) { workerResult = e.code || 'ERR'; }
    fs.writeFileSync(filesOutPath, 'ok-inside-files-dir', 'utf8');
    yield {
      id: 'b0',
      partitionId: '0',
      records: [{
        foxDbRead: probeRead(foxDbPath),
        appKeyRead: probeRead(appKeyPath),
        etcHostsRead: probeRead('/etc/hosts'),
        appKeyEnv: process.env.APP_ENCRYPTION_KEY ?? null,
        flowKeyEnv: process.env.FOXFLOW_ENCRYPTION_KEY ?? null,
        sessionEnv: process.env.SESSION_SECRET ?? null,
        parentOnlyEnv: process.env.FOXFLOW_SANDBOX_PARENT_ONLY_TEST ?? null,
        execResult,
        workerResult,
        filesWritten: fs.readFileSync(filesOutPath, 'utf8'),
      }],
    };
  }
}
`,
      );
      const digest = await pluginDigest(probeDir, ['./index.mjs']);
      process.env.FOXFLOW_PLUGINS_DIR = pluginsRoot;
      process.env.FOXFLOW_PLUGINS_ALLOWLIST = `@foxtest/probe@${digest}`;

      const { runtimeConfig } = runtimeSettings('enabled');
      const resolveSpy = vi.fn(async (connectionId: string) =>
        connectionId === 'conn-mem'
          ? { dialect: 'sqlite', option: { database: ':memory:' } }
          : undefined,
      );

      backend = new WorkflowSandboxClient({
        databasePath: process.env.FOXFLOW_DB_PATH,
        encryptionKey: process.env.FOXFLOW_ENCRYPTION_KEY!,
        resolveFoxSchemaConnection: resolveSpy,
        loadRuntimeConfig: async () => runtimeConfig,
      });
      await backend.start();

      expect(backend.isReady()).toBe(true);
      expect(backend.permissionEnforced).toBe(true);
      expect(backend.pid).toBeDefined();
      expect(backend.pid).not.toBe(process.pid);

      const server = await mountTestApp(backend, { foreignConnections: ['foreign-conn'] });

      // Put a workflow calling our probe plugin + script transform (delegated to
      // parent zero-FS sandbox) + delimited sink writing output to filesDir.
      const filesOutPath = join(process.env.FOXFLOW_FILES_DIR!, 'probe-check.txt');
      const workflow = {
        id: 'wf-containment',
        name: 'Containment Workflow',
        version: 1,
        onOverlap: 'parallel',
        pipelines: [
          {
            id: 'main',
            name: 'Main',
            pipes: [
              {
                id: 'probe',
                role: 'source',
                type: 'foxtest/probe',
                config: {
                  foxDbPath: join(tempDir, 'foxschema.db'),
                  appKeyPath: join(tempDir, '.app_encryption_key'),
                  filesOutPath,
                },
                concurrency: 1,
              },
              {
                id: 'script',
                role: 'transform',
                type: 'transform.script',
                config: {
                  script: 'return records.map((r) => ({ ...r, scripted: true }));',
                },
                concurrency: 1,
              },
              {
                id: 'out',
                role: 'sink',
                type: 'sink.file.delimited',
                config: {
                  path: 'probe-report.csv',
                  mode: 'overwrite',
                  columns: [
                    'foxDbRead',
                    'appKeyRead',
                    'etcHostsRead',
                    'appKeyEnv',
                    'flowKeyEnv',
                    'sessionEnv',
                    'parentOnlyEnv',
                    'execResult',
                    'workerResult',
                    'filesWritten',
                    'scripted',
                  ],
                },
                concurrency: 1,
              },
            ],
            edges: [
              { from: 'probe', to: 'script', fromPort: 'out', toPort: 'in' },
              { from: 'script', to: 'out', fromPort: 'out', toPort: 'in' },
            ],
          },
        ],
        triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
        dependencies: [],
        middleware: [],
      };

      const putRes = await server.inject({
        method: 'PUT',
        url: '/api/workflow/engine/workflows/wf-containment',
        payload: workflow,
      });
      expect(putRes.statusCode).toBe(200);

      // Foreign connection is refused by parent FoxSchema RBAC/grants before hitting child.
      const foreignPut = await server.inject({
        method: 'PUT',
        url: '/api/workflow/engine/workflows/wf-foreign',
        payload: {
          ...workflow,
          id: 'wf-foreign',
          pipelines: [
            {
              id: 'main',
              name: 'Main',
              pipes: [
                {
                  id: 's',
                  role: 'source',
                  type: 'source.triggerPayload',
                  credentialId: 'foxschema-foreign-conn',
                  config: {},
                  concurrency: 1,
                },
              ],
              edges: [],
            },
          ],
        },
      });
      expect(foreignPut.statusCode).toBe(403);

      // Start the workflow run.
      const runRes = await server.inject({
        method: 'POST',
        url: '/api/workflow/engine/workflows/wf-containment/run',
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      // Stream run events live via SSE over IPC until terminal `end` event.
      const sseRes = await server.inject({
        method: 'GET',
        url: `/api/workflow/engine/runs/${runId}/events/stream`,
      });
      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.body).toContain('event: end');

      const detailRes = await server.inject({
        method: 'GET',
        url: `/api/workflow/engine/runs/${runId}`,
      });
      expect(detailRes.statusCode).toBe(200);
      expect((detailRes.json() as { error?: unknown }).error ?? null).toBeNull();
      expect((detailRes.json() as { status: string }).status).toBe('succeeded');

      // Verify CSV written by sink reflects every containment guarantee.
      const csv = fs.readFileSync(join(process.env.FOXFLOW_FILES_DIR!, 'probe-report.csv'), 'utf8');
      expect(csv).toContain('ERR_ACCESS_DENIED');
      expect(csv).not.toContain('ESCAPED');
      expect(csv).not.toContain('FOXSCHEMA_SECRET');
      expect(csv).not.toContain('super-secret');
      expect(csv).not.toContain('only-in-parent');
      expect(csv).toContain('ok-inside-files-dir');
      expect(csv).toContain('true');
    },
    30_000,
  );

  it(
    'proxies webhook HMAC raw bodies and resolves FoxSchema connections over reverse RPC without exposing secrets',
    async () => {
      const { runtimeConfig } = runtimeSettings('enabled');
      const resolveSpy = vi.fn(async (connectionId: string) =>
        connectionId === 'conn-mem'
          ? { dialect: 'sqlite', option: { database: ':memory:' } }
          : undefined,
      );

      backend = new WorkflowSandboxClient({
        databasePath: process.env.FOXFLOW_DB_PATH,
        encryptionKey: process.env.FOXFLOW_ENCRYPTION_KEY!,
        resolveFoxSchemaConnection: resolveSpy,
        loadRuntimeConfig: async () => runtimeConfig,
      });
      await backend.start();
      const server = await mountTestApp(backend);

      // Grant FoxSchema saved connection via engine credential store.
      await backend.credentials.create({
        id: 'foxschema-conn-mem',
        name: 'In-memory SQLite',
        kind: 'database',
        source: 'foxschema',
        data: { connectionId: 'conn-mem' },
      });

      const webhookSecret = 'wh-hmac-secret-123';
      await backend.credentials.create({
        id: 'wh-cred',
        name: 'Webhook Secret',
        kind: 'webhook',
        source: 'local',
        data: { secret: webhookSecret },
      });

      // Save valid SQL workflow using foxschema-conn-mem.
      const sqlPut = await server.inject({
        method: 'PUT',
        url: '/api/workflow/engine/workflows/wf-sql-grant',
        payload: {
          id: 'wf-sql-grant',
          name: 'SQL Grant Test',
          version: 1,
          onOverlap: 'parallel',
          pipelines: [
            {
              id: 'main',
              name: 'Main',
              pipes: [
                {
                  id: 'sql',
                  role: 'source',
                  type: 'source.db.sql',
                  credentialId: 'foxschema-conn-mem',
                  config: { sql: 'SELECT 7 AS lucky' },
                  concurrency: 1,
                },
                {
                  id: 'out',
                  role: 'sink',
                  type: 'sink.file.delimited',
                  config: {
                    path: 'sql-grant.csv',
                    mode: 'overwrite',
                    columns: ['lucky'],
                  },
                  concurrency: 1,
                },
              ],
              edges: [{ from: 'sql', to: 'out', fromPort: 'out', toPort: 'in' }],
            },
          ],
          triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
          dependencies: [],
          middleware: [],
        },
      });
      expect(sqlPut.statusCode).toBe(200);

      const sqlRun = await server.inject({
        method: 'POST',
        url: '/api/workflow/engine/workflows/wf-sql-grant/run',
      });
      expect(sqlRun.statusCode).toBe(202);
      const sqlRunId = (sqlRun.json() as { runId: string }).runId;
      await server.inject({
        method: 'GET',
        url: `/api/workflow/engine/runs/${sqlRunId}/events/stream`,
      });
      expect(resolveSpy).toHaveBeenCalledWith('conn-mem');
      expect(fs.readFileSync(join(process.env.FOXFLOW_FILES_DIR!, 'sql-grant.csv'), 'utf8')).toContain('7');

      // Save webhook workflow with non-canonical JSON whitespace so byte-exact rawBody is proven.
      const hookPut = await server.inject({
        method: 'PUT',
        url: '/api/workflow/engine/workflows/wf-hook',
        payload: {
          id: 'wf-hook',
          name: 'Webhook HMAC Test',
          version: 1,
          onOverlap: 'parallel',
          pipelines: [
            {
              id: 'main',
              name: 'Main',
              pipes: [
                {
                  id: 'trig',
                  role: 'source',
                  type: 'source.triggerPayload',
                  config: {},
                  concurrency: 1,
                },
                {
                  id: 'resp',
                  role: 'sink',
                  type: 'sink.response',
                  config: { shape: 'records' },
                  concurrency: 1,
                },
              ],
              edges: [{ from: 'trig', to: 'resp', fromPort: 'out', toPort: 'in' }],
            },
          ],
          triggers: [
            {
              id: 'hook-1',
              kind: 'webhook',
              enabled: true,
              path: 'orders/hmac',
              methods: ['POST'],
              auth: {
                type: 'signature',
                credentialId: 'wh-cred',
                signatureHeader: 'x-foxflow-signature',
                timestampHeader: 'x-foxflow-timestamp',
                maxAgeSeconds: 300,
              },
            },
          ],
          dependencies: [],
          middleware: [],
        },
      });
      expect(hookPut.statusCode).toBe(200);

      // Non-canonical JSON formatting (extra spaces & newlines) — only succeeds if
      // FoxSchema preserves exact raw bytes across IPC to sandbox!
      const rawJson = '{\n  "orderId" :  "ord-99"  }\n';
      const ts = String(Math.floor(Date.now() / 1000));
      const idempotencyKey = 'idem-1';
      const sig = createHmac('sha256', webhookSecret)
        .update(`${ts}.${idempotencyKey}.`)
        .update(rawJson)
        .digest('hex');

      const badSigRes = await server.inject({
        method: 'POST',
        url: '/api/hooks/orders/hmac?wait=1',
        headers: {
          'content-type': 'application/json',
          'x-foxflow-timestamp': ts,
          'x-idempotency-key': idempotencyKey,
          'x-foxflow-signature': 'sha256=bad',
        },
        payload: rawJson,
      });
      expect(badSigRes.statusCode).toBe(401);

      const goodHookRes = await server.inject({
        method: 'POST',
        url: '/api/hooks/orders/hmac?wait=1',
        headers: {
          'content-type': 'application/json',
          'x-foxflow-timestamp': ts,
          'x-idempotency-key': idempotencyKey,
          'x-foxflow-signature': `sha256=${sig}`,
        },
        payload: rawJson,
      });
      expect(goodHookRes.statusCode).toBe(200);
      expect(goodHookRes.body).toContain('ord-99');
    },
    30_000,
  );

  it(
    'isolates crashes and automatically respawns after SIGKILL with persisted workflows intact',
    async () => {
      const { runtimeConfig } = runtimeSettings('enabled');
      backend = new WorkflowSandboxClient({
        databasePath: process.env.FOXFLOW_DB_PATH,
        encryptionKey: process.env.FOXFLOW_ENCRYPTION_KEY!,
        resolveFoxSchemaConnection: async () => undefined,
        loadRuntimeConfig: async () => runtimeConfig,
      });
      await backend.start();
      const server = await mountTestApp(backend);

      const putRes = await server.inject({
        method: 'PUT',
        url: '/api/workflow/engine/workflows/wf-persist',
        payload: {
          id: 'wf-persist',
          name: 'Survives Crash',
          version: 1,
          onOverlap: 'parallel',
          pipelines: [
            {
              id: 'main',
              name: 'Main',
              pipes: [
                {
                  id: 'trig',
                  role: 'source',
                  type: 'source.triggerPayload',
                  config: {},
                  concurrency: 1,
                },
              ],
              edges: [],
            },
          ],
          triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
          dependencies: [],
          middleware: [],
        },
      });
      expect(putRes.statusCode).toBe(200);

      const originalPid = backend.pid!;
      process.kill(originalPid, 'SIGKILL');

      // Wait until auto-respawn completes (first backoff is 500ms).
      for (let i = 0; i < 40; i++) {
        if (backend.isReady() && backend.pid !== originalPid) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      expect(backend.isReady()).toBe(true);
      expect(backend.pid).toBeDefined();
      expect(backend.pid).not.toBe(originalPid);

      const listRes = await server.inject({
        method: 'GET',
        url: '/api/workflow/engine/workflows/wf-persist',
      });
      expect(listRes.statusCode).toBe(200);
      expect((listRes.json() as { id: string }).id).toBe('wf-persist');
    },
    30_000,
  );

  it(
    'runs file-based SQLite workflows via parent reverse-RPC without --allow-addons while blocking foxschema.db, and filters GET /runs in one batch RPC',
    async () => {
      const shopDbPath = join(tempDir, 'shop.db');
      const db = new DatabaseSync(shopDbPath);
      db.exec('CREATE TABLE items (name TEXT); INSERT INTO items VALUES (\'wrench\');');
      db.close();

      const { runtimeConfig } = runtimeSettings('enabled');
      backend = new WorkflowSandboxClient({
        databasePath: process.env.FOXFLOW_DB_PATH,
        encryptionKey: process.env.FOXFLOW_ENCRYPTION_KEY!,
        resolveFoxSchemaConnection: async (connectionId: string) =>
          connectionId === 'conn-shop'
            ? { dialect: 'sqlite', option: { database: shopDbPath } }
            : connectionId === 'conn-foxmeta'
              ? { dialect: 'sqlite', option: { database: join(tempDir, 'foxschema.db') } }
              : undefined,
        loadRuntimeConfig: async () => runtimeConfig,
      });
      await backend.start();
      const server = await mountTestApp(backend);

      await backend.credentials.create({
        id: 'foxschema-conn-shop',
        name: 'Shop SQLite',
        kind: 'database',
        source: 'foxschema',
        data: { connectionId: 'conn-shop' },
      });

      const putShop = await server.inject({
        method: 'PUT',
        url: '/api/workflow/engine/workflows/wf-shop-sqlite',
        payload: {
          id: 'wf-shop-sqlite',
          name: 'Shop SQLite File',
          version: 1,
          onOverlap: 'parallel',
          pipelines: [
            {
              id: 'main',
              name: 'Main',
              pipes: [
                {
                  id: 'sql',
                  role: 'source',
                  type: 'source.db.sql',
                  credentialId: 'foxschema-conn-shop',
                  config: { sql: 'SELECT name FROM items' },
                  concurrency: 1,
                },
                {
                  id: 'out',
                  role: 'sink',
                  type: 'sink.file.delimited',
                  config: { path: 'shop.csv', mode: 'overwrite', columns: ['name'] },
                  concurrency: 1,
                },
              ],
              edges: [{ from: 'sql', to: 'out', fromPort: 'out', toPort: 'in' }],
            },
          ],
          triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
          dependencies: [],
          middleware: [],
        },
      });
      expect(putShop.statusCode).toBe(200);

      const runRes = await server.inject({
        method: 'POST',
        url: '/api/workflow/engine/workflows/wf-shop-sqlite/run',
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const sseRes = await server.inject({
        method: 'GET',
        url: `/api/workflow/engine/runs/${runId}/events/stream`,
      });
      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.body).toContain('event: end');
      expect(fs.readFileSync(join(process.env.FOXFLOW_FILES_DIR!, 'shop.csv'), 'utf8')).toContain('wrench');

      // GET /runs filters via single batch getRunLinkedConnections RPC.
      const batchSpy = vi.spyOn(backend, 'getRunLinkedConnections');
      const runsRes = await server.inject({ method: 'GET', url: '/api/workflow/engine/runs' });
      expect(runsRes.statusCode).toBe(200);
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect((runsRes.json() as Array<{ id: string }>).some((r) => r.id === runId)).toBe(true);
    },
    30_000,
  );

  it('unblocks proxied SSE run stream with 503 if the sandbox terminates before sending sse.head', async () => {
    const { settings } = runtimeSettings('enabled');
    const crashingBackend = {
      mode: 'sandbox' as const,
      permissionEnforced: true,
      isReady: () => true,
      getWorkflow: async () => undefined,
      getRunSnapshot: async () =>
        ({
          id: 'wf',
          name: 'wf',
          version: 1,
          origin: 'authored',
          onOverlap: 'parallel',
          pipelines: [],
          triggers: [],
          dependencies: [],
          middleware: [],
        }) as never,
      getRunLinkedConnections: async () => ({}),
      credentials: { create: vi.fn(), remove: vi.fn() },
      applyRuntimeConfig: async () => undefined,
      startLifecycle: async () => undefined,
      enqueueWorkflow: async () => ({ accepted: false }),
      injectHttp: async () => ({ statusCode: 200, headers: {}, bodyBase64: '' }),
      openRunEventsStream: (_runId: string, _after: number, handlers: { onHead: (s: number) => void; onChunk: (c: string) => void; onEnd: () => void }) => {
        // Simulate child crash/SIGKILL right after sse.open: rejectAllInFlight
        // fires onEnd() without ever having received sse.head.
        setTimeout(() => handlers.onEnd(), 10);
        return () => undefined;
      },
      probeHealth: async () => ({ ok: false, sandboxed: true }),
      close: async () => undefined,
    };

    const server = Fastify({ forceCloseConnections: true });
    server.addHook('onRequest', async (req) => {
      const authed = req as unknown as AuthedRequest;
      authed.userId = 'user-1';
      authed.appRole = 'admin';
      authed.permissions = new Set(ALL_PERMS);
    });
    await registerWorkflowEngine(server, {
      backend: crashingBackend,
      featureContext: createFeatureContext(),
      settings,
      grants: { notUsableBy: async () => [] },
      startLifecycle: false,
      sessionGuard: (_req, _res, next) => next(),
    });
    await server.ready();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/api/workflow/engine/runs/run-crashed/events/stream',
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await server.close();
    }
  });

  it(
    'blocks SQLite ATTACH/VACUUM INTO, symlink/hardlink aliases to foxschema.db, and DuckDB read_text/ATTACH/COPY escapes from workflow SQL pipes',
    async () => {
      const shopDbPath = join(tempDir, 'shop-escape.db');
      const db = new DatabaseSync(shopDbPath);
      db.exec('CREATE TABLE items (name TEXT); INSERT INTO items VALUES (\'ok\');');
      db.close();

      const foxDbPath = join(tempDir, 'foxschema.db');
      const appKeyPath = join(tempDir, '.app_encryption_key');
      const symlinkToFox = join(tempDir, 'harmless-sym.db');
      const hardlinkToFox = join(tempDir, 'harmless-hard.db');
      const exfilPath = join(tempDir, 'exfil.out');
      fs.symlinkSync(foxDbPath, symlinkToFox);
      fs.linkSync(foxDbPath, hardlinkToFox);

      const { runtimeConfig } = runtimeSettings('enabled');
      backend = new WorkflowSandboxClient({
        databasePath: process.env.FOXFLOW_DB_PATH,
        encryptionKey: process.env.FOXFLOW_ENCRYPTION_KEY!,
        resolveFoxSchemaConnection: async (connectionId: string) => {
          if (connectionId === 'conn-shop') return { dialect: 'sqlite', option: { database: shopDbPath } };
          if (connectionId === 'conn-duck') return { dialect: 'duckdb', option: { database: ':memory:' } };
          if (connectionId === 'conn-sym') return { dialect: 'sqlite', option: { database: symlinkToFox } };
          if (connectionId === 'conn-hard') return { dialect: 'sqlite', option: { database: hardlinkToFox } };
          return undefined;
        },
        loadRuntimeConfig: async () => runtimeConfig,
      });
      await backend.start();
      const server = await mountTestApp(backend);

      for (const [id, connId] of [
        ['foxschema-conn-shop', 'conn-shop'],
        ['foxschema-conn-duck', 'conn-duck'],
        ['foxschema-conn-sym', 'conn-sym'],
        ['foxschema-conn-hard', 'conn-hard'],
      ] as const) {
        await backend.credentials.create({
          id,
          name: id,
          kind: 'database',
          source: 'foxschema',
          data: { connectionId: connId },
        });
      }

      const runSqlAttack = async (wfId: string, credentialId: string, sql: string) => {
        const put = await server.inject({
          method: 'PUT',
          url: `/api/workflow/engine/workflows/${wfId}`,
          payload: {
            id: wfId,
            name: wfId,
            version: 1,
            onOverlap: 'parallel',
            pipelines: [
              {
                id: 'main',
                name: 'Main',
                pipes: [
                  {
                    id: 'sql',
                    role: 'source',
                    type: 'source.db.sql',
                    credentialId,
                    config: { sql },
                    concurrency: 1,
                  },
                ],
                edges: [],
              },
            ],
            triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
            dependencies: [],
            middleware: [],
          },
        });
        expect(put.statusCode).toBe(200);
        const runRes = await server.inject({
          method: 'POST',
          url: `/api/workflow/engine/workflows/${wfId}/run`,
        });
        expect(runRes.statusCode).toBe(202);
        const { runId } = runRes.json() as { runId: string };
        const sse = await server.inject({
          method: 'GET',
          url: `/api/workflow/engine/runs/${runId}/events/stream`,
        });
        expect(sse.statusCode).toBe(200);
        const detail = await server.inject({
          method: 'GET',
          url: `/api/workflow/engine/runs/${runId}`,
        });
        expect(detail.statusCode).toBe(200);
        return detail.json() as { status: string; error?: string };
      };

      const escapedFoxDb = foxDbPath.replace(/'/g, "''");
      const escapedAppKey = appKeyPath.replace(/'/g, "''");
      const escapedExfil = exfilPath.replace(/'/g, "''");

      const sqliteAttach = await runSqlAttack(
        'wf-sqlite-attach',
        'foxschema-conn-shop',
        `ATTACH DATABASE '${escapedFoxDb}' AS meta`,
      );
      expect(sqliteAttach.status).toBe('failed');
      expect(sqliteAttach.error ?? '').toMatch(/ATTACH and DETACH/i);

      const sqliteVacuum = await runSqlAttack(
        'wf-sqlite-vacuum',
        'foxschema-conn-shop',
        `VACUUM INTO '${escapedExfil}'`,
      );
      expect(sqliteVacuum.status).toBe('failed');
      expect(sqliteVacuum.error ?? '').toMatch(/VACUUM INTO/i);
      expect(fs.existsSync(exfilPath)).toBe(false);

      const sqliteSymlink = await runSqlAttack('wf-sqlite-sym', 'foxschema-conn-sym', 'SELECT 1');
      expect(sqliteSymlink.status).toBe('failed');
      expect(sqliteSymlink.error ?? '').toMatch(/internal metadata database/i);

      const sqliteHardlink = await runSqlAttack('wf-sqlite-hard', 'foxschema-conn-hard', 'SELECT 1');
      expect(sqliteHardlink.status).toBe('failed');
      expect(sqliteHardlink.error ?? '').toMatch(/internal metadata database/i);

      const duckReadText = await runSqlAttack(
        'wf-duck-read',
        'foxschema-conn-duck',
        `SELECT * FROM read_text('${escapedAppKey}')`,
      );
      expect(duckReadText.status).toBe('failed');
      expect(duckReadText.error ?? '').toMatch(/file system operations are disabled|permission/i);

      const duckAttach = await runSqlAttack(
        'wf-duck-attach',
        'foxschema-conn-duck',
        `ATTACH '${escapedFoxDb}' AS meta`,
      );
      expect(duckAttach.status).toBe('failed');
      expect(duckAttach.error ?? '').toMatch(/file system operations are disabled|permission/i);

      const duckCopy = await runSqlAttack(
        'wf-duck-copy',
        'foxschema-conn-duck',
        `COPY (SELECT 1) TO '${escapedExfil}'`,
      );
      expect(duckCopy.status).toBe('failed');
      expect(duckCopy.error ?? '').toMatch(/file system operations are disabled|permission/i);
      expect(fs.existsSync(exfilPath)).toBe(false);
    },
    30_000,
  );
});
