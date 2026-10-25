/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * App Secrets are merged into a run only for an account that may read them.
 * Asking without `secrets.view` is refused every time, so a viewer — or a demo
 * visitor — saw "App Secrets unavailable" under every query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';

const executeSql = vi.hoisted(() => vi.fn());
const resolveAppSecrets = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api/sqlApi', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
}));
vi.mock('@/shared/api/appSecretsApi', () => ({
  resolveAppSecrets: (...args: unknown[]) => resolveAppSecrets(...args),
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
  resolveAppSecrets.mockReset().mockRejectedValue(new Error('Permission denied: this needs "secrets.view".'));
});

describe('App Secrets in a run', () => {
  it.each(['viewer', 'demo'] as const)('a %s runs without asking for them, and without a warning', async (role) => {
    const warnings = await runAs(role);
    expect(resolveAppSecrets).not.toHaveBeenCalled();
    expect(warnings.join('\n')).not.toMatch(/App Secrets/);
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('an editor’s run still merges them, and says when they cannot be read', async () => {
    resolveAppSecrets.mockResolvedValueOnce({ secrets: {}, errors: {} });
    expect(await runAs('editor')).toEqual([]);
    expect(resolveAppSecrets).toHaveBeenCalledTimes(1);

    resolveAppSecrets.mockRejectedValueOnce(new Error('vault offline'));
    expect((await runAs('editor')).join('\n')).toMatch(/App Secrets unavailable: vault offline/);
  });
});
