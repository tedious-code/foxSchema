/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DbPrincipal, DbPrivilege } from '@foxschema/ui-shared';
import { PermissionInspector } from './PermissionInspector';

const fetchDbAccess = vi.fn();
vi.mock('@/shared/api/schemaApi', () => ({
  fetchDbAccess: (...args: unknown[]) => fetchDbAccess(...args),
}));

vi.mock('@/app/store/useSyncStore', () => {
  const state = { connections: [{ id: 'c1', name: 'Demo', dialect: 'postgres', schema: 'public' }] };
  return { useSyncStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

vi.mock('@/app/store/useSqlEditorStore', () => {
  const state = { sessionPasswords: {} as Record<string, string> };
  return { useSqlEditorStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

const principals: DbPrincipal[] = [
  { name: 'alice', kind: 'user', canLogin: true, memberOf: ['readonly'], members: [] },
  { name: 'readonly', kind: 'role', canLogin: false, memberOf: [], members: ['alice'] },
];

const privileges: DbPrivilege[] = [
  {
    grantee: 'readonly',
    privilege: 'SELECT',
    objectType: 'TABLE',
    objectSchema: 'public',
    objectName: 'orders',
    grantable: false,
    grantor: null,
    state: 'grant',
  },
];

describe('PermissionInspector catalog reuse', () => {
  it('resolves effective access from the parent catalog without fetching', () => {
    render(
      <PermissionInspector
        embedded={{
          connectionId: 'c1',
          principalName: 'alice',
          schema: 'public',
          principals,
          privileges,
        }}
      />
    );
    expect(fetchDbAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inspector-load')).toBeNull();
    expect(screen.getByTestId('inspector-summary-read')).toBeTruthy();
    expect(screen.getByTestId('inspector-chain').textContent).toMatch(/readonly/);
  });
});
