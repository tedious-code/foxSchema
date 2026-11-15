/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persist FoxWorkflow engine config (app_settings) and report in-process health.
 */
import {
  COMMUNITY_WORKSPACE_ID,
  type AdminConfigPut,
  type WorkflowEngineConfig,
  type WorkflowHealth,
} from '@foxschema/workflow-contract';
import { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { isWorkflowEngineReady } from './runtime/engine-ready';

export const WORKFLOW_ENGINE_CONFIG_KEY = 'workflow.engine_config';

/**
 * How long a read config is reused. Every designer poll reads it, and on a
 * Postgres or MySQL metadata database each read was a network round trip.
 * Kept short because another FoxSchema instance sharing that database can
 * change it; a save here refreshes it at once.
 */
const CONFIG_TTL_MS = 2_000;

export function defaultWorkflowEngineConfig(): WorkflowEngineConfig {
  return {
    state: 'enabled',
    endpoint: '',
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
  private cached: { config: WorkflowEngineConfig; at: number } | undefined;

  constructor(
    private appSettings: AppSettingsStore = new AppSettingsStore(),
    private onChange?: (config: WorkflowEngineConfig) => void,
  ) {}

  /** The saved config. A copy each call: callers (putConfig among them) change it. */
  async getConfig(): Promise<WorkflowEngineConfig> {
    if (!this.cached || Date.now() - this.cached.at >= CONFIG_TTL_MS) {
      this.cached = { config: await this.readConfig(), at: Date.now() };
    }
    return structuredClone(this.cached.config);
  }

  private async readConfig(): Promise<WorkflowEngineConfig> {
    const raw = await this.appSettings.get(WORKFLOW_ENGINE_CONFIG_KEY);
    if (!raw) return defaultWorkflowEngineConfig();
    try {
      const parsed = JSON.parse(raw) as Partial<WorkflowEngineConfig>;
      return { ...defaultWorkflowEngineConfig(), ...parsed, endpoint: '', processes: [] };
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
    this.cached = { config: structuredClone(current), at: Date.now() };
    this.onChange?.(current);
    return current;
  }

  async probeEngineHealth(): Promise<WorkflowHealth & { error?: string }> {
    if (!isWorkflowEngineReady()) {
      return {
        ok: false,
        acceptsRuns: false,
        error: 'Workflow engine is not started',
      };
    }
    const config = await this.getConfig();
    return {
      ok: true,
      acceptsRuns: config.state === 'enabled',
    };
  }
}
