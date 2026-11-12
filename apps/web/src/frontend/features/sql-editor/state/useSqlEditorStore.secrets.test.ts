/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A run substitutes this session's Variables, secret ones included, and
 * nothing else: saved App Secrets left the SQL editor, so a run never asks
 * the server for them (nor warns that it could not).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';

const executeSql = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api/sqlApi', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
}));

import { useAuthStore } from '@/platform/authStore';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from './useSqlEditorStore';
import { createTab } from './sqlEditorTabLogic';

async function runAs(role: 'viewer' | 'editor' | 'demo') {
  useAuthStore.setState({
    user: { id: 'u', email: 'u@example.com', onboardingCompleted: true, role, permissions: DEFAULT_ROLE_PERMISSIONS[role] },
    status: 'ready',
  } as never);
  await useSqlEditorStore.persist.rehydrate();
  const tab = createTab({ id: 't1', title: 'Q', sql: 'SELECT 1;', selectedConnectionIds: ['c1'] });
  useSyncStore.setState({ connections: [{ id: 'c1', name: 'Lite', dialect: 'sqlite', hasPassword: true } as never] });
  useSqlEditorStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    shareDestinations: false,
    sharedConnectionIds: [],
    runningTabId: null,
    variables: [],
    resultsByTab: {},
  });
  await useSqlEditorStore.getState().execute();
  return useSqlEditorStore.getState().resultsByTab[tab.id]?.warnings ?? [];
}

beforeEach(() => {
  executeSql.mockReset().mockResolvedValue({
    results: [{ ok: true, columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1 }],
  });
});

describe('saved App Secrets and a run', () => {
  it.each(['viewer', 'demo', 'editor'] as const)('a %s runs without asking the server for them, and without a warning', async (role) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const warnings = await runAs(role);
      expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/app-secrets'))).toEqual([]);
      expect(warnings.join('\n')).not.toMatch(/App Secrets|Secret "/);
      expect(executeSql).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('Variable and secret interpolation', () => {
  async function runSql(sql: string, variables: Array<Record<string, unknown>>) {
    useAuthStore.setState({
      user: {
        id: 'u',
        email: 'u@example.com',
        onboardingCompleted: true,
        role: 'editor',
        permissions: DEFAULT_ROLE_PERMISSIONS.editor,
      },
      status: 'ready',
    } as never);
    await useSqlEditorStore.persist.rehydrate();
    const tab = createTab({ id: 't1', title: 'Q', sql, selectedConnectionIds: ['c1'] });
    useSyncStore.setState({
      connections: [{ id: 'c1', name: 'Lite', dialect: 'sqlite', hasPassword: true } as never],
    });
    useSqlEditorStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      shareDestinations: false,
      sharedConnectionIds: [],
      runningTabId: null,
      variables: variables as never,
      recentQueries: [],
      resultsByTab: {},
    });
    await useSqlEditorStore.getState().execute();
    return { tabId: tab.id, state: useSqlEditorStore.getState() };
  }

  it('sends a secret’s value to the engine and keeps it out of Out labels and Recent', async () => {
    const { tabId, state } = await runSql('SELECT ${{tok}}', [
      { id: 'v1', name: 'tok', kind: 'scalar', value: 'shh-secret', secret: true, updatedAt: 1 },
    ]);
    expect(executeSql.mock.calls[0]![1]).toEqual(["SELECT 'shh-secret'"]);
    const results = state.resultsByTab[tabId];
    expect(results?.ranStatements.join('\n')).toBe('SELECT (secret)');
    expect(results?.ranStatements.join('\n')).not.toContain('shh-secret');
    expect(results?.pageSqlByConnection?.c1?.[0]).toBe("SELECT 'shh-secret'");
    expect(state.recentQueries[0]?.sql).toBe('SELECT ${{tok}}');
    expect(state.recentQueries[0]?.sql).not.toContain('shh');
  });

  it('fills a public variable in Out labels and Recent', async () => {
    const { tabId, state } = await runSql('SELECT ${{id}}', [
      { id: 'v1', name: 'id', kind: 'scalar', value: 7, updatedAt: 1 },
    ]);
    expect(executeSql.mock.calls[0]![1]).toEqual(['SELECT 7']);
    expect(state.resultsByTab[tabId]?.ranStatements.join('\n')).toBe('SELECT 7');
    expect(state.recentQueries[0]?.sql).toBe('SELECT 7');
  });

  it('mixes a public fill with a masked secret in the same statement', async () => {
    const { tabId, state } = await runSql('SELECT ${{id}} WHERE t = ${{tok}}', [
      { id: 'v1', name: 'id', kind: 'scalar', value: 7, updatedAt: 1 },
      { id: 'v2', name: 'tok', kind: 'scalar', value: 'shh-secret', secret: true, updatedAt: 1 },
    ]);
    expect(executeSql.mock.calls[0]![1]).toEqual(["SELECT 7 WHERE t = 'shh-secret'"]);
    expect(state.resultsByTab[tabId]?.ranStatements.join('\n')).toBe('SELECT 7 WHERE t = (secret)');
    expect(state.recentQueries[0]?.sql).toBe('SELECT ${{id}} WHERE t = ${{tok}}');
  });
});
