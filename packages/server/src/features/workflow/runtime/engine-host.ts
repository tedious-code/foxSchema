/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one in-process engine this API process runs: stores, admission, and
 * the saved-connection resolver the credential store calls per run.
 */
import type { EngineRuntimeConfig, WorkflowEngineConfig } from '@foxschema/workflow-contract';
import { AppSettingsStore } from '../../../platform/settings/app-settings.service';
import { WorkflowConnectionGrants } from '../workflow-connection-grants.service';
import { WorkflowSettingsService } from '../workflow-settings.service';
import { createContext, type AppContext } from './context.js';
import { attachEngineSettings } from './engine-settings.js';
import { markWorkflowEngineReady } from './engine-ready.js';

export interface WorkflowEngineHost {
  ctx: AppContext;
  settings: WorkflowSettingsService;
  grants: WorkflowConnectionGrants;
  applyAdmission: () => Promise<void>;
}

let production: WorkflowEngineHost | undefined;
let detachSettings: (() => Promise<void>) | undefined;
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

async function openProductionHost(): Promise<WorkflowEngineHost> {
  const grants = new WorkflowConnectionGrants();
  const ctx = createContext({
    databasePath: process.env.FOXFLOW_DB_PATH ?? (process.env.VITEST ? ':memory:' : undefined),
    resolveFoxSchemaConnection: async (connectionId) => {
      const resolved = await grants.resolveForEngine(connectionId);
      if (!resolved) return undefined;
      return {
        dialect: resolved.dialect,
        ...(resolved.schema ? { schema: resolved.schema } : {}),
        option: resolved.option,
      };
    },
  });

  function applyAdmissionFrom(config: WorkflowEngineConfig): void {
    ctx.scheduler.setAdmission({
      state: config.state,
      maxConcurrentRuns: config.maxParallel,
    });
  }

  const settings = new WorkflowSettingsService(new AppSettingsStore(), applyAdmissionFrom);
  const host: WorkflowEngineHost = {
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
  detachSettings = attachEngineSettings(ctx, async (): Promise<EngineRuntimeConfig> => {
    const config = await settings.getConfig();
    return { state: config.state, maxParallel: config.maxParallel, sinks: config.sinks };
  });
  markWorkflowEngineReady(true);
  refs = 1;
  return host;
}

/** Drop the process-wide host once nothing is using it. */
export async function stopProductionWorkflowEngine(): Promise<void> {
  if (!production || refs <= 0) return;
  refs -= 1;
  if (refs > 0) return;
  await detachSettings?.();
  detachSettings = undefined;
  production.ctx.close();
  production = undefined;
  markWorkflowEngineReady(false);
}
