/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The process-wide workflow engine host run by FoxSchema: isolated by default in
 * a Node `--permission` child process over a private OS IPC channel, with an
 * explicit `FOXFLOW_SANDBOX_MODE=in-process` fallback for debugging/tests.
 */
import type { EngineRuntimeConfig, WorkflowEngineConfig } from '@foxschema/shared';
import { AppSettingsStore } from '../../../platform/settings/app-settings.service';
import { WorkflowConnectionGrants } from '../workflow-connection-grants.service';
import { WorkflowSettingsService } from '../workflow-settings.service';
import { createContext, type AppContext } from './context.js';
import { attachEngineSettings } from './engine-settings.js';
import { markWorkflowEngineReady } from './engine-ready.js';
import {
  WorkflowSandboxClient,
  createInProcessBackend,
} from './sandbox-client.js';
import type { WorkflowEngineBackend } from './sandbox-protocol.js';

const SETTINGS_REFRESH_MS = 30_000;

/**
 * Resolve the 32-byte encryption key for the workflow engine.
 * An explicit `FOXFLOW_ENCRYPTION_KEY` (even if blank/invalid in tests) takes
 * precedence; when omitted, the install's `APP_ENCRYPTION_KEY` is shared so a
 * new install only needs one encryption key.
 */
export function resolveWorkflowEncryptionKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env.FOXFLOW_ENCRYPTION_KEY;
  return (explicit !== undefined ? explicit : env.APP_ENCRYPTION_KEY) ?? '';
}

export interface WorkflowEngineHost {
  backend: WorkflowEngineBackend;
  /** Populated only when `FOXFLOW_SANDBOX_MODE=in-process`. */
  ctx?: AppContext;
  settings: WorkflowSettingsService;
  grants: WorkflowConnectionGrants;
  applyAdmission: () => Promise<void>;
}

let production: WorkflowEngineHost | undefined;
let cleanupHost: (() => Promise<void>) | undefined;
let starting: Promise<WorkflowEngineHost> | undefined;
let refs = 0;

export function getProductionWorkflowEngine(): WorkflowEngineHost | undefined {
  return production;
}

/**
 * Start (or return) the process-wide engine. Idempotent across Fastify
 * restarts: each start is paired with a stop, and the host lives until the
 * last consumer closes. Admission is applied before this resolves, so
 * recovered cron/webhooks cannot run while a saved config is `disabled`.
 */
export async function startProductionWorkflowEngine(): Promise<WorkflowEngineHost> {
  if (production) {
    refs += 1;
    return production;
  }
  if (starting) {
    const host = await starting;
    refs += 1;
    return host;
  }
  starting = openProductionHost();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

function toRuntimeConfig(config: WorkflowEngineConfig): EngineRuntimeConfig {
  return {
    state: config.state,
    maxParallel: config.maxParallel,
    sinks: config.sinks,
  };
}

async function openProductionHost(): Promise<WorkflowEngineHost> {
  const grants = new WorkflowConnectionGrants();
  const resolveFoxSchemaConnection = async (connectionId: string) => {
    const resolved = await grants.resolveForEngine(connectionId);
    if (!resolved) return undefined;
    return {
      dialect: resolved.dialect,
      ...(resolved.schema ? { schema: resolved.schema } : {}),
      option: resolved.option,
    };
  };

  if (process.env.FOXFLOW_SANDBOX_MODE === 'in-process') {
    const ctx = createContext({
      databasePath: process.env.FOXFLOW_DB_PATH ?? (process.env.VITEST ? ':memory:' : undefined),
      resolveFoxSchemaConnection,
    });

    function applyAdmissionFrom(config: WorkflowEngineConfig): void {
      ctx.scheduler.setAdmission({
        state: config.state,
        maxConcurrentRuns: config.maxParallel,
      });
    }

    const settings = new WorkflowSettingsService(new AppSettingsStore(), applyAdmissionFrom);
    let detachSettings: (() => Promise<void>) | undefined;
    const backend = createInProcessBackend(ctx, {
      onClose: async () => {
        await detachSettings?.();
        detachSettings = undefined;
      },
    });
    const host: WorkflowEngineHost = {
      backend,
      ctx,
      settings,
      grants,
      applyAdmission: async () => applyAdmissionFrom(await settings.getConfig()),
    };

    try {
      await host.applyAdmission();
    } catch (error) {
      ctx.close();
      throw error;
    }

    production = host;
    detachSettings = attachEngineSettings(ctx, async (): Promise<EngineRuntimeConfig> =>
      toRuntimeConfig(await settings.getConfig()),
    );
    cleanupHost = async () => {
      await backend.close();
    };
    markWorkflowEngineReady(true);
    refs = 1;
    return host;
  }

  let backend: WorkflowSandboxClient | undefined;
  const settings = new WorkflowSettingsService(
    new AppSettingsStore(),
    (config) => {
      void backend?.applyRuntimeConfig(toRuntimeConfig(config)).catch(() => undefined);
    },
    async () =>
      backend
        ? backend.probeHealth()
        : { ok: false, error: 'Workflow engine sandbox is not started' },
  );

  backend = new WorkflowSandboxClient({
    databasePath: process.env.FOXFLOW_DB_PATH ?? (process.env.VITEST ? ':memory:' : undefined),
    encryptionKey: resolveWorkflowEncryptionKey(),
    resolveFoxSchemaConnection,
    loadRuntimeConfig: async () => toRuntimeConfig(await settings.getConfig()),
    onReadyChange: (ready) => markWorkflowEngineReady(ready),
  });

  await backend.start();

  const refreshTimer = setInterval(() => {
    void settings
      .getConfig()
      .then((cfg) => backend?.applyRuntimeConfig(toRuntimeConfig(cfg)))
      .catch(() => undefined);
  }, SETTINGS_REFRESH_MS);
  refreshTimer.unref?.();

  const host: WorkflowEngineHost = {
    backend,
    settings,
    grants,
    applyAdmission: async () => {
      await backend.applyRuntimeConfig(toRuntimeConfig(await settings.getConfig()));
    },
  };

  production = host;
  cleanupHost = async () => {
    clearInterval(refreshTimer);
    await backend.close();
  };
  markWorkflowEngineReady(true);
  refs = 1;
  return host;
}

/** Drop the process-wide host once nothing is using it. */
export async function stopProductionWorkflowEngine(): Promise<void> {
  if (!production || refs <= 0) return;
  refs -= 1;
  if (refs > 0) return;
  const stop = cleanupHost;
  cleanupHost = undefined;
  production = undefined;
  markWorkflowEngineReady(false);
  await stop?.();
}
