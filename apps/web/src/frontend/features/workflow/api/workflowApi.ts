/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Control-plane client for FoxWorkflow settings, engine health, and linking
 * saved FoxSchema connections to workflows.
 */
import type {
  AdminConfigPut,
  WorkflowConnectionSummary,
  WorkflowEngineConfig,
  WorkflowHealth,
} from '@foxschema/workflow-contract';
import { api } from '@/shared/api/client';

export async function fetchWorkflowSettings(): Promise<WorkflowEngineConfig> {
  const { config } = await api.get<{ config: WorkflowEngineConfig }>('/workflow/settings');
  return config;
}

export async function saveWorkflowSettings(body: AdminConfigPut): Promise<WorkflowEngineConfig> {
  const { config } = await api.put<{ config: WorkflowEngineConfig }>('/workflow/settings', body);
  return config;
}

export async function fetchWorkflowEngineHealth(): Promise<
  WorkflowHealth & { error?: string }
> {
  return api.get('/workflow/engine/health');
}

/** The editable part of the engine config, as the settings endpoint takes it. */
export function toAdminConfigPut(config: WorkflowEngineConfig): AdminConfigPut {
  return {
    state: config.state,
    acceptsRuns: config.state === 'enabled',
    maxParallel: config.maxParallel,
    onOverlap: config.onOverlap,
    sinks: config.sinks.map((s) => ({
      kind: s.kind,
      enabled: s.enabled,
      target: s.target || undefined,
    })),
  };
}

const connectionGrantPath = (id: string) =>
  `/workflow/connections/${encodeURIComponent(id)}/grant`;

/** The caller's saved FoxSchema connections, and linking them to workflows. */
export const workflowConnections = {
  list: async (): Promise<WorkflowConnectionSummary[]> =>
    (await api.get<{ connections: WorkflowConnectionSummary[] }>('/workflow/connections')).connections,
  /** Links the connection and resolves with the engine credential that points at it. */
  grant: (id: string): Promise<{ ok: true; credentialId: string }> =>
    api.put(connectionGrantPath(id)),
  revoke: (id: string): Promise<{ ok: true }> => api.delete(connectionGrantPath(id)),
};
