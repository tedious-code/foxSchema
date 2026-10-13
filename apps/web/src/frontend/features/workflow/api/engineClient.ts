/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client for the workflow engine, reached through FoxSchema's engine proxy
 * (`/api/workflow/engine/*`), which checks the caller's workflow permissions.
 */
import { getApiBase } from '@/shared/api/apiBase';
import { api as http } from '@/shared/api/client';
import type {
  EnvironmentRecord,
  TriggerKind,
  VariableRecord,
  VariableScope,
} from '@foxschema/workflow-engine/definitions';

/**
 * The engine's own shapes, type-only — erased from the bundle. Hand-kept copies
 * of these drifted: `PipeMetadata` lost `sideEffects` and widened `family`, and
 * `CredentialMeta.kind` became any string, so a kind check stopped type-checking.
 */
export type { CredentialMeta, PipeMetadata, PipeProvider } from '@foxschema/workflow-engine/definitions';
import type { CredentialMeta, PipeMetadata } from '@foxschema/workflow-engine/definitions';

const ENGINE = '/workflow/engine';

/**
 * What the engine answers a run request. It can say no without failing the
 * request: `accepted: false`, with a `reason` — `overlap` (and `runId` is then
 * the run already going, not a new one), `condition` or `disabled`.
 */
export interface RunStartResult {
  runId?: string;
  status?: string;
  accepted?: boolean;
  reason?: string;
  detail?: string;
}

export interface MiddlewareMeta {
  name: string;
  tiers: Array<'engine' | 'workflow' | 'pipeline'>;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  purpose?: string;
  tags?: string[];
  expectedResult?: string;
  version: number;
  pipelines: number;
  pipes: number;
  /** True when an enabled parent trigger exists (callable via workflow.sub). */
  callable?: boolean;
  triggers: { id: string; kind: string; enabled: boolean }[];
  updatedAt?: string;
  lastRun?: { id: string; status: string; startedAt: string };
}

// The engine's own records, shared type-only through its browser-safe entry.
export type EnvironmentMeta = EnvironmentRecord;
export type VariableMeta = VariableRecord;
export type { VariableScope };

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Present when the run was started with I/O sample capture. */
  debug?: boolean;
}

export interface RunDetail extends RunRecord {
  pipelines: Array<{
    id: string;
    pipelineId: string;
    status: string;
    error?: string;
  }>;
  pipes: Array<{
    id: string;
    pipelineId: string;
    pipeId: string;
    status: string;
    processedBatches: number;
    processedRecords: number;
    error?: string;
  }>;
}

export interface RunFailureSummary {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  status: string;
  workflowPurpose?: string;
  workflowExpectedResult?: string;
  error?: string;
  failedPipeline?: {
    id: string;
    pipelineId: string;
    task?: string;
    error?: string;
  };
  failedPipe?: {
    id: string;
    pipelineId: string;
    pipeId: string;
    intent?: string;
    type?: string;
    error?: string;
  };
  gateSkipped: Array<{ pipelineId: string; error?: string }>;
  aiFailovers: Array<{
    at: string;
    pipeId?: string;
    from?: string;
    to?: string;
    reason?: string;
  }>;
  aiUsage?: { inputTokens: number; outputTokens: number };
}

export interface WorkflowPackage {
  manifest: {
    format: string;
    formatVersion: number;
    exportedAt: string;
    workflowId: string;
    workflowVersion: number;
    purpose?: string;
    tags: string[];
    expectedResult?: string;
    credentials: Array<{ id: string; kind: string; name?: string }>;
    variableKeys: string[];
    subWorkflowIds: string[];
  };
  workflow: unknown;
}

export interface RunEvent {
  seq: number;
  workflowRunId: string;
  at: string;
  type: string;
  pipelineId?: string;
  pipeId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ParsePreview {
  fields: string[];
  records: Record<string, unknown>[];
  /** 1-based source line per visible record (parallel to `records`). */
  lines?: number[];
  invalid: { index: number; line?: number; message: string }[];
  total: number;
  truncated: boolean;
  error: string | null;
}

export interface ValidateResult {
  valid: boolean;
  error?: string;
  plan?: {
    waves: string[][];
    pipelines: Record<string, { waves: string[][] }>;
  };
}

/** One engine call through the shared API client: session cookie, JSON, ApiError on failure. */
function request<T>(
  path: string,
  { method = 'GET', body }: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const url = `${ENGINE}${path}`;
  switch (method) {
    case 'GET':
      return http.get<T>(url);
    case 'POST':
      return http.post<T>(url, body);
    case 'PUT':
      return http.put<T>(url, body);
    case 'DELETE':
      // Engine deletes answer 204 with no body.
      return http.delete<T>(url, body, { allowEmpty: true });
  }
}

export const api = {
  // validate returns its result on both 200 and 400 — surface both shapes.
  async validate(doc: unknown): Promise<ValidateResult> {
    const res = await http.raw('POST', `${ENGINE}/workflows/validate`, doc);
    return (await res.json()) as ValidateResult;
  },

  save(id: string, doc: unknown): Promise<unknown> {
    return request(`/workflows/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: doc,
    });
  },

  getWorkflow(id: string): Promise<unknown> {
    return request(`/workflows/${encodeURIComponent(id)}`);
  },

  run(
    id: string,
    options?: { environment?: string; debug?: boolean },
  ): Promise<RunStartResult> {
    // No body at all without options: the engine rejects an empty JSON body.
    const body =
      options && (options.environment || options.debug)
        ? {
            ...(options.environment ? { environment: options.environment } : {}),
            ...(options.debug ? { debug: true } : {}),
          }
        : undefined;
    return request(`/workflows/${encodeURIComponent(id)}/run`, { method: 'POST', body });
  },

  /** The newest runs; the list is polled, and the engine caps it anyway. */
  listRuns(): Promise<RunRecord[]> {
    return request('/runs?limit=200');
  },

  getRun(id: string): Promise<RunDetail> {
    return request(`/runs/${encodeURIComponent(id)}`);
  },

  getRunFailure(id: string): Promise<RunFailureSummary> {
    return request(`/runs/${encodeURIComponent(id)}/failure`);
  },

  listRunEvents(
    id: string,
    after = 0,
  ): Promise<{ events: RunEvent[] }> {
    return request(`/runs/${encodeURIComponent(id)}/events?after=${after}`);
  },

  streamRunEvents(id: string, after = 0): EventSource {
    return new EventSource(
      `${getApiBase()}${ENGINE}/runs/${encodeURIComponent(id)}/events/stream?after=${after}`,
      { withCredentials: true },
    );
  },

  listCredentials(): Promise<CredentialMeta[]> {
    return request('/credentials');
  },

  /** Parse a CSV/text sample (or the head of the configured file) server-side. */
  previewParse(input: {
    kind: 'csv' | 'text';
    config: Record<string, unknown>;
    sample?: string;
    limit?: number;
  }): Promise<ParsePreview> {
    return request('/preview/parse', {
      method: 'POST',
      body: input,
    });
  },

  createCredential(input: {
    id?: string;
    name: string;
    kind: string;
    source?: string;
    data: Record<string, unknown>;
  }): Promise<CredentialMeta> {
    return request('/credentials', {
      method: 'POST',
      body: input,
    });
  },

  async deleteCredential(id: string): Promise<void> {
    await request(`/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  listPipes(): Promise<{ pipes: PipeMetadata[] }> {
    return request('/pipes');
  },

  listWorkflows(): Promise<WorkflowSummary[]> {
    return request('/workflows');
  },

  async deleteWorkflow(id: string): Promise<void> {
    await request(`/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  duplicateWorkflow(
    id: string,
    input: { id: string; name?: string },
  ): Promise<unknown> {
    return request(`/workflows/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      body: input,
    });
  },

  extractPipeline(
    id: string,
    input: {
      pipelineId: string;
      newWorkflowId: string;
      newWorkflowName?: string;
      purpose?: string;
      tags?: string[];
      expectedResult?: string;
      replaceWithSub?: boolean;
      pinVersion?: boolean;
      expectedVersion?: number;
    },
  ): Promise<{ source: unknown; extracted: unknown }> {
    return request(`/workflows/${encodeURIComponent(id)}/extract-pipeline`, {
      method: 'POST',
      body: input,
    });
  },

  exportWorkflow(id: string): Promise<WorkflowPackage> {
    return request(`/workflows/${encodeURIComponent(id)}/export`);
  },

  importWorkflow(input: {
    package: WorkflowPackage;
    credentialMap?: Record<string, string>;
    workflowId?: string;
  }): Promise<unknown> {
    return request('/workflows/import', {
      method: 'POST',
      body: input,
    });
  },

  listMiddleware(): Promise<{ middleware: MiddlewareMeta[] }> {
    return request('/middleware');
  },

  listEnvironments(): Promise<{ environments: EnvironmentMeta[] }> {
    return request('/environments');
  },

  createEnvironment(name: string): Promise<EnvironmentMeta> {
    return request('/environments', {
      method: 'POST',
      body: { name },
    });
  },

  activateEnvironment(id: string): Promise<EnvironmentMeta> {
    return request(`/environments/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    });
  },

  async deleteEnvironment(id: string): Promise<void> {
    await request(`/environments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  listVariables(
    environmentId: string,
    query?: { scope?: VariableScope; workflowId?: string },
  ): Promise<{ variables: VariableMeta[] }> {
    const params = new URLSearchParams();
    if (query?.scope) params.set('scope', query.scope);
    if (query?.workflowId) params.set('workflowId', query.workflowId);
    const suffix = params.toString() ? `?${params}` : '';
    return request(
      `/environments/${encodeURIComponent(environmentId)}/variables${suffix}`,
    );
  },

  putVariable(
    environmentId: string,
    input: {
      scope?: VariableScope;
      workflowId?: string;
      key: string;
      value: unknown;
    },
  ): Promise<VariableMeta> {
    return request(`/environments/${encodeURIComponent(environmentId)}/variables`, {
      method: 'PUT',
      body: input,
    });
  },

  async deleteVariable(id: string): Promise<void> {
    await request(`/variables/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  cloneVariable(input: {
    sourceEnvironmentId: string;
    targetEnvironmentIds: string[];
    scope?: VariableScope;
    workflowId?: string;
    key: string;
    value?: unknown;
    overwrite?: boolean;
  }): Promise<{ key: string; cloned: string[]; skipped: string[] }> {
    return request('/variables/clone', {
      method: 'POST',
      body: input,
    });
  },
};
