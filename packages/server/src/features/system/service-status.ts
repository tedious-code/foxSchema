/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The state of the services the app runs, for the Services card on Home.
 * Read-only: starting and stopping the engine is a later step of
 * docs/plans/2026-11-01-service-status.md.
 */
import type { ServiceStatusReport, EngineServiceStatus } from '@foxschema/shared';
import { WORKFLOW_ENGINE_TOKEN_ENV, type WorkflowHealth } from '@foxschema/workflow-contract';

/** What the engine needs in this server's environment to be run from here. */
export const ENGINE_REQUIRED_ENV = [WORKFLOW_ENGINE_TOKEN_ENV, 'FOXFLOW_ENCRYPTION_KEY'] as const;

export interface ServiceStatusDeps {
  /** The engine's /health, at the configured endpoint (WorkflowSettingsService). */
  probeEngine: () => Promise<WorkflowHealth & { error?: string }>;
  version: () => string;
  uptimeSec: () => number;
  env?: Readonly<Record<string, string | undefined>>;
}

export async function readServiceStatus(deps: ServiceStatusDeps): Promise<ServiceStatusReport> {
  return {
    api: { state: 'running', version: deps.version(), uptimeSec: Math.floor(deps.uptimeSec()) },
    engine: await engineStatus(deps),
  };
}

async function engineStatus(deps: ServiceStatusDeps): Promise<EngineServiceStatus> {
  let probe: WorkflowHealth & { error?: string };
  try {
    probe = await deps.probeEngine();
  } catch (error: unknown) {
    probe = { ok: false, acceptsRuns: false, error: error instanceof Error ? error.message : 'Health check failed' };
  }
  if (probe.ok) {
    return {
      state: 'running',
      version: probe.version,
      acceptsRuns: probe.acceptsRuns,
      ...(probe.acceptsRuns ? {} : { detail: 'Not taking new runs (Workflow settings).' }),
    };
  }
  const env = deps.env ?? process.env;
  const missing = ENGINE_REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return { state: 'not_configured', detail: `Set ${missing.join(' and ')} on the server to run the engine.` };
  }
  return { state: 'unreachable', detail: probe.error ? `No answer: ${probe.error}` : 'No answer from its health check.' };
}
