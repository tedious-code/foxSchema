/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_WORKSPACE_ID,
  type AdminConfigPut,
  type WorkflowEngineConfig,
  type WorkflowHealth,
} from './index';

describe('workflow-contract', () => {
  it('exports the community workspace id', () => {
    expect(COMMUNITY_WORKSPACE_ID).toBe('local');
  });

  it('accepts a well-formed engine config', () => {
    const config: WorkflowEngineConfig = {
      state: 'enabled',
      endpoint: 'http://127.0.0.1:8081',
      maxParallel: 2,
      onOverlap: 'skip',
      processes: [{ id: 'p1', label: 'Main', status: 'idle' }],
      sinks: [{ kind: 'json', enabled: true, target: 'file' }],
      workspaceId: COMMUNITY_WORKSPACE_ID,
    };
    expect(config.state).toBe('enabled');
  });

  it('shapes health and admin put bodies', () => {
    const health: WorkflowHealth = { ok: true, acceptsRuns: true, version: '0.0.0' };
    const put: AdminConfigPut = {
      acceptsRuns: false,
      sinks: [{ kind: 'text', enabled: true }],
    };
    expect(health.acceptsRuns).toBe(true);
    expect(put.sinks?.[0]?.kind).toBe('text');
  });
});
