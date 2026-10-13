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

/**
 * How long a read config is reused. Every proxied engine call reads it — the
 * designer's debug poll once a second — and on a Postgres or MySQL metadata
 * database each read was a network round trip. Kept short because another
 * FoxSchema instance sharing that database can change it; a save here
 * refreshes it at once.
 */
const CONFIG_TTL_MS = 2_000;

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

/** The engine could not be reached, or is not configured to be. */
export class EngineUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineUnavailableError';
  }
}

/**
 * Origin and base path of the configured engine, without a trailing slash.
 *
 * Only http(s): the endpoint is admin-set, but a `file:` or `data:` URL here
 * would turn this proxy into a way to read things that are not an engine.
 */
export function engineBaseUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EngineUnavailableError(`Workflow engine endpoint is not a valid URL: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EngineUnavailableError(`Workflow engine endpoint must be http or https: ${endpoint}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class WorkflowSettingsService {
  private cached: { config: WorkflowEngineConfig; at: number } | undefined;

  constructor(private appSettings = new AppSettingsStore()) {}

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
    this.cached = { config: structuredClone(current), at: Date.now() };
    return current;
  }

  async probeEngineHealth(): Promise<WorkflowHealth & { endpoint: string; error?: string }> {
    const config = await this.getConfig();
    // The address the proxy forwards to, by the same rule (http(s) only, every
    // trailing slash, no query) — a probe of a differently-normalised URL
    // could report healthy an engine the proxy cannot reach.
    let endpoint: string;
    try {
      endpoint = engineBaseUrl(config.endpoint);
    } catch (err: unknown) {
      return { ok: false, acceptsRuns: false, endpoint: config.endpoint, error: (err as Error).message };
    }
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
