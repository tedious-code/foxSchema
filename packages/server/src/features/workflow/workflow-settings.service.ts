/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persist FoxWorkflow engine config (app_settings) and proxy engine health.
 */
import {
  COMMUNITY_WORKSPACE_ID,
  type AdminConfigPut,
  type WorkflowEngineConfig,
  type WorkflowHealth,
} from '@foxschema/workflow-contract';
import { AppSettingsStore } from '../../platform/settings/app-settings.service';

export const WORKFLOW_ENGINE_CONFIG_KEY = 'workflow.engine_config';

const HEALTH_TIMEOUT_MS = 2_000;

export function defaultWorkflowEngineConfig(): WorkflowEngineConfig {
  return {
    state: 'disabled',
    endpoint: 'http://127.0.0.1:8081',
    maxParallel: 4,
    onOverlap: 'skip',
    processes: [],
    sinks: [
      { kind: 'events', enabled: false },
      { kind: 'json', enabled: false },
      { kind: 'text', enabled: false },
    ],
    workspaceId: COMMUNITY_WORKSPACE_ID,
  };
}

export class WorkflowSettingsService {
  constructor(private appSettings = new AppSettingsStore()) {}

  async getConfig(): Promise<WorkflowEngineConfig> {
    const raw = await this.appSettings.get(WORKFLOW_ENGINE_CONFIG_KEY);
    if (!raw) return defaultWorkflowEngineConfig();
    try {
      const parsed = JSON.parse(raw) as Partial<WorkflowEngineConfig>;
      return { ...defaultWorkflowEngineConfig(), ...parsed };
    } catch {
      return defaultWorkflowEngineConfig();
    }
  }

  async putConfig(body: AdminConfigPut): Promise<WorkflowEngineConfig> {
    const current = await this.getConfig();
    if (typeof body.acceptsRuns === 'boolean') {
      current.state = body.acceptsRuns ? 'enabled' : 'disabled';
    }
    if (body.state) current.state = body.state;
    if (typeof body.endpoint === 'string') current.endpoint = body.endpoint;
    if (typeof body.maxParallel === 'number' && Number.isFinite(body.maxParallel)) {
      current.maxParallel = Math.max(1, Math.floor(body.maxParallel));
    }
    if (body.onOverlap) current.onOverlap = body.onOverlap;
    if (Array.isArray(body.sinks)) {
      current.sinks = body.sinks.map((s) => ({
        kind: s.kind,
        enabled: Boolean(s.enabled),
        target: s.target,
      }));
    }
    current.workspaceId = current.workspaceId ?? COMMUNITY_WORKSPACE_ID;
    await this.appSettings.set(WORKFLOW_ENGINE_CONFIG_KEY, JSON.stringify(current));
    return current;
  }

  async probeEngineHealth(): Promise<WorkflowHealth & { endpoint: string; error?: string }> {
    const config = await this.getConfig();
    const endpoint = config.endpoint.replace(/\/$/, '');
    const url = `${endpoint}/health`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!res.ok) {
        return {
          ok: false,
          acceptsRuns: false,
          endpoint,
          error: `HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as Partial<WorkflowHealth>;
      return {
        ok: body.ok === true,
        // Admission is decided here, by the saved state; the engine does not know it.
        acceptsRuns: config.state === 'enabled',
        version: body.version,
        endpoint,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        acceptsRuns: false,
        endpoint,
        error: err instanceof Error ? err.message : 'health probe failed',
      };
    }
  }
}
