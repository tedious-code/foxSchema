/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forward the Workflow designer's calls to the workflow engine (FoxAgent).
 *
 * The engine is a separate process with no authentication of its own, so this
 * is the only door the designer uses: every route is on an explicit allowlist,
 * each guarded by a FoxSchema permission. Anything not listed — the engine's
 * public trigger ingress above all — is simply not reachable through here.
 */
import type { Permission } from '@foxschema/shared';
import { WORKFLOW_ENGINE_TOKEN_ENV } from '@foxschema/workflow-contract';
import { EngineUnavailableError, WorkflowSettingsService, engineBaseUrl } from './workflow-settings.service';

// Defined with the settings that hold the endpoint; re-exported for the routes.
export { EngineUnavailableError, engineBaseUrl };

export interface EngineRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Path under the engine's `/api`, in Fastify `:param` syntax. */
  path: string;
  permission: Permission;
  /** Starts engine work, so it is refused while the engine is not accepting runs. */
  startsRun?: true;
  /**
   * The workflow whose saved connections the caller must be able to use:
   * the request body, the stored workflow `:id`, or the workflow of run `:id`.
   */
  connections?: 'body' | 'workflow' | 'run';
}

/**
 * Every engine route the designer may reach, and what it takes to reach it.
 *
 * Deliberately absent: `POST /triggers/:workflowId/:triggerId` (public webhook
 * and API-endpoint ingress — it authenticates callers itself and must never be
 * fronted by a FoxSchema session), `/setup/credentials`, dry runs, and the
 * pipeline and variable endpoints the designer does not call. Add a route here
 * only when a screen needs it.
 *
 * Reading follows `workflow.access`. Anything that changes a definition, or
 * touches environments and variables, is `workflow.design`. Starting and
 * steering runs is `workflow.run`. Creating or deleting an engine credential
 * stores a secret, so it is `workflow.admin`; listing them returns names and
 * kinds only, which authoring needs.
 */
export const ENGINE_ROUTES: readonly EngineRoute[] = [
  { method: 'GET', path: '/pipes', permission: 'workflow.access' },
  { method: 'GET', path: '/middleware', permission: 'workflow.access' },
  { method: 'GET', path: '/workflows', permission: 'workflow.access' },
  { method: 'GET', path: '/workflows/:id', permission: 'workflow.access' },
  { method: 'GET', path: '/workflows/:id/export', permission: 'workflow.access' },
  { method: 'GET', path: '/runs', permission: 'workflow.access' },
  // A run's detail and events carry what its connections returned (debug
  // samples are rows), so they follow the same rule as running it.
  { method: 'GET', path: '/runs/:id', permission: 'workflow.access', connections: 'run' },
  { method: 'GET', path: '/runs/:id/failure', permission: 'workflow.access', connections: 'run' },
  { method: 'GET', path: '/runs/:id/events', permission: 'workflow.access', connections: 'run' },
  { method: 'GET', path: '/runs/:id/events/stream', permission: 'workflow.access', connections: 'run' },

  { method: 'POST', path: '/workflows/validate', permission: 'workflow.design' },
  { method: 'POST', path: '/workflows/import', permission: 'workflow.design', connections: 'body' },
  { method: 'PUT', path: '/workflows/:id', permission: 'workflow.design', connections: 'body' },
  { method: 'DELETE', path: '/workflows/:id', permission: 'workflow.design' },
  { method: 'POST', path: '/workflows/:id/duplicate', permission: 'workflow.design', connections: 'workflow' },
  { method: 'POST', path: '/workflows/:id/extract-pipeline', permission: 'workflow.design', connections: 'workflow' },
  { method: 'POST', path: '/preview/parse', permission: 'workflow.design' },
  { method: 'GET', path: '/environments', permission: 'workflow.design' },
  { method: 'POST', path: '/environments', permission: 'workflow.design' },
  { method: 'POST', path: '/environments/:id/activate', permission: 'workflow.design' },
  { method: 'DELETE', path: '/environments/:id', permission: 'workflow.design' },
  { method: 'GET', path: '/environments/:id/variables', permission: 'workflow.design' },
  { method: 'PUT', path: '/environments/:id/variables', permission: 'workflow.design' },
  { method: 'DELETE', path: '/variables/:id', permission: 'workflow.design' },
  { method: 'POST', path: '/variables/clone', permission: 'workflow.design' },
  { method: 'GET', path: '/credentials', permission: 'workflow.design' },

  { method: 'POST', path: '/credentials', permission: 'workflow.admin' },
  { method: 'DELETE', path: '/credentials/:id', permission: 'workflow.admin' },

  { method: 'POST', path: '/workflows/:id/run', permission: 'workflow.run', startsRun: true, connections: 'workflow' },
];


/** A request that would start a run arrived while the engine is not `enabled`. */
export class EngineNotAcceptingRunsError extends Error {
  constructor() {
    super('The workflow engine is not accepting new runs. A workflow admin can enable it in the control panel.');
    this.name = 'EngineNotAcceptingRunsError';
  }
}

export interface EngineRequest {
  method: EngineRoute['method'];
  /** Refused unless the engine is `enabled`: `draining` finishes work and takes nothing new. */
  startsRun?: boolean;
  /** Path under the engine's `/api`, still URL-encoded — e.g. `/workflows/a%2Fb`. */
  path: string;
  /** Query string without the leading `?`, or empty. */
  search: string;
  body?: unknown;
  signal?: AbortSignal;
}

export class WorkflowEngineProxyService {
  constructor(
    private readonly settings: Pick<WorkflowSettingsService, 'getConfig'> = new WorkflowSettingsService(),
    private readonly fetchImpl: typeof fetch = fetch,
    /** Shared service token; the engine refuses its API without it once it has one. */
    private readonly token: string | undefined = process.env[WORKFLOW_ENGINE_TOKEN_ENV],
  ) {}

  /** Refuse before any other work when a run could not start anyway. */
  async assertAcceptingRuns(): Promise<void> {
    if ((await this.settings.getConfig()).state !== 'enabled') throw new EngineNotAcceptingRunsError();
  }

  async forward(request: EngineRequest): Promise<Response> {
    // One settings read serves both the run gate and the endpoint.
    const config = await this.settings.getConfig();
    if (request.startsRun && config.state !== 'enabled') throw new EngineNotAcceptingRunsError();
    const base = engineBaseUrl(config.endpoint);
    const url = `${base}/api${request.path}${request.search ? `?${request.search}` : ''}`;
    // A JSON content type on an empty body is rejected by the engine's Fastify
    // (FST_ERR_CTP_EMPTY_JSON_BODY), so it is only claimed when there is one.
    const hasBody = request.body !== undefined && request.method !== 'GET';
    try {
      return await this.fetchImpl(url, {
        method: request.method,
        // Built from scratch rather than copied from the incoming request: the
        // caller's cookies and Authorization header are their FoxSchema session
        // and must not reach another process.
        headers: {
          accept: 'application/json, text/event-stream',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          // FoxSchema's own credential for the engine, never the caller's.
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      if (request.signal?.aborted) throw cause;
      throw new EngineUnavailableError(`Workflow engine at ${base} is unreachable`, { cause });
    }
  }
}
