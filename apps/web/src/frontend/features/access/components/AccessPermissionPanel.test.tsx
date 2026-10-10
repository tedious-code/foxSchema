/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';

const fetchDbAccess = vi.fn();
const fetchSchemaList = vi.fn();
const loadSchema = vi.fn();
const runAccessSql = vi.fn();
const setSql = vi.fn();
const ensureConnectionSelected = vi.fn();
const setActiveView = vi.fn();

vi.mock('@/features/compare/state/useSyncStore', () => {
  const state = {
    connections: [
      { id: 'c1', name: 'Demo PG', dialect: 'postgres', database: 'app', schema: 'public' },
    ],
  };
  return {
    useSyncStore: (sel: (s: typeof state) => unknown) => sel(state),
  };
});

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => {
  const state = {
    sessionPasswords: {} as Record<string, string>,
    setSql: (...args: unknown[]) => setSql(...args),
    ensureConnectionSelected: (...args: unknown[]) => ensureConnectionSelected(...args),
    schemaCache: { c1: { status: 'ready', tables: [] as [] } },
    ensureSchema: vi.fn(),
  };
  return {
    useSqlEditorStore: (sel: (s: typeof state) => unknown) => sel(state),
  };
});

vi.mock('@/app/store/uiStore', () => ({
  useUiStore: (sel: (s: { setActiveView: typeof setActiveView }) => unknown) =>
    sel({ setActiveView }),
}));

vi.mock('@/shared/api/schemaApi', () => ({
  fetchDbAccess: (...args: unknown[]) => fetchDbAccess(...args),
  fetchSchemaList: (...args: unknown[]) => fetchSchemaList(...args),
  loadSchema: (...args: unknown[]) => loadSchema(...args),
}));

vi.mock('@/shared/api/accessSql', () => ({
  runAccessSql: (...args: unknown[]) => runAccessSql(...args),
}));

import { AccessPermissionPanel } from './AccessPermissionPanel';

const catalog = {
  dialect: 'postgres',
  schema: 'public',
  mode: 'native' as const,
  support: { mode: 'native', query: true, grant: true, hint: 'PostgreSQL catalog' },
  principals: [
    {
      name: 'alice',
      kind: 'user' as const,
      canLogin: true,
      memberOf: ['readonly'],
      members: [],
    },
    {
      name: 'readonly',
      kind: 'role' as const,
      canLogin: false,
      memberOf: [],
      members: ['alice'],
    },
  ],
  privileges: [
    {
      grantee: 'alice',
      privilege: 'SELECT',
      objectType: 'TABLE' as const,
      objectSchema: 'public',
      objectName: 'orders',
      grantable: false,
      grantor: null,
      state: 'grant' as const,
    },
  ],
};

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  fetchDbAccess.mockReset();
  fetchSchemaList.mockReset();
  loadSchema.mockReset();
  runAccessSql.mockReset();
  setSql.mockReset();
  ensureConnectionSelected.mockReset();
  setActiveView.mockReset();
  fetchDbAccess.mockResolvedValue(catalog);
  fetchSchemaList.mockResolvedValue(['public']);
  loadSchema.mockResolvedValue({
    tables: [{ name: 'orders', objectType: 'TABLE' }],
  });
  useAuthStore.setState({
    user: {
      id: 'owner',
      email: 'owner@example.com',
      onboardingCompleted: true,
      role: 'owner',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.owner],
    },
    status: 'ready',
    error: null,
    busy: false,
    refreshMe: vi.fn(async () => {}),
  });
});

describe('AccessPermissionPanel — one session', () => {
  it('loads a principal tree and Account / Grants / Effective on one catalog', async () => {
    render(<AccessPermissionPanel />);
    fireEvent.change(screen.getByTestId('access-permission-connection'), {
      target: { value: 'c1' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('access-permission-principal').textContent).toMatch(/alice/)
    );
    expect(screen.getByTestId('access-permission-principal').textContent).toMatch(/readonly/);
    expect(fetchDbAccess).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('access-permission-row-alice'));
    fireEvent.click(screen.getByTestId('access-permission-stage-account'));
    expect(screen.getByTestId('access-permission-account-kind').textContent).toMatch(/user/i);
    expect(screen.getByTestId('access-permission-account-login').textContent).toMatch(/Can log in/);
    expect(screen.getByTestId('access-permission-account-memberof').textContent).toMatch(/readonly/);

    fireEvent.click(screen.getByTestId('access-permission-row-readonly'));
    expect(screen.getByTestId('access-permission-account-members').textContent).toMatch(/alice/);

    fireEvent.click(screen.getByTestId('access-permission-stage-grants'));
    // findBy, not getBy: the stage loads its own schema objects, so a
    // synchronous read passed or failed on microtask timing — which is what
    // made this file flaky on CI while passing in isolation.
    expect(await screen.findByTestId('access-grants-stage')).toBeTruthy();

    fireEvent.click(screen.getByTestId('access-permission-stage-effective'));
    await waitFor(() => expect(screen.getByTestId('permission-inspector')).toBeTruthy());
    expect(screen.queryByTestId('inspector-load')).toBeNull();
    expect(fetchDbAccess).toHaveBeenCalledTimes(1);
  });

  /** Select a principal and land on the Grants stage with its catalog loaded. */
  async function grantsStageFor(principal: string) {
    render(<AccessPermissionPanel />);
    fireEvent.change(screen.getByTestId('access-permission-connection'), {
      target: { value: 'c1' },
    });
    fireEvent.click(await screen.findByTestId(`access-permission-row-${principal}`));
    fireEvent.click(screen.getByTestId('access-permission-stage-grants'));
    await screen.findByTestId('access-grants-stage');
  }

  it('copies GRANT SQL instead of executing it', async () => {
    await grantsStageFor('alice');

    // Read-and-write, not read-only: alice already holds SELECT on
    // public.orders, so the read-only preset matches the catalog and correctly
    // generates nothing. The SQL only exists where the desired state differs.
    fireEvent.click(await screen.findByTestId('access-grants-preset-read-write'));
    const copy = (await screen.findByTestId('access-grants-copy')) as HTMLButtonElement;
    // This project does not load jest-dom, so read the property directly.
    await waitFor(() => expect(copy.disabled).toBe(false));
    fireEvent.click(copy);

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/GRANT/i))
    );
    // The guarantee the screen is built on: it writes SQL out, never runs it.
    expect(runAccessSql).not.toHaveBeenCalled();
  });

  it('opens generated SQL in the SQL Editor without executing', async () => {
    await grantsStageFor('alice');

    fireEvent.click(await screen.findByTestId('access-grants-preset-read-write'));
    const open = (await screen.findByTestId('access-grants-open-sql')) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);

    // Handing SQL to the editor goes through the panel's confirm step, so the
    // reader sees what is about to land there.
    fireEvent.click(await screen.findByTestId('access-permission-open-sql'));

    expect(setSql).toHaveBeenCalledWith(expect.stringMatching(/GRANT/i));
    expect(ensureConnectionSelected).toHaveBeenCalledWith('c1');
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
    expect(runAccessSql).not.toHaveBeenCalled();
  });

  const ORDERS = 'cat-0-public.table.orders';
  const cell = (permission: string) => screen.getByTestId(`matrix-cell-${ORDERS}-${permission}`) as HTMLInputElement;
  const sqlText = () => screen.getByTestId('access-grants-sql').querySelector('pre')?.textContent ?? '';

  it('opens the grid on what an existing principal holds, not on empty boxes', async () => {
    await grantsStageFor('alice');
    await waitFor(() => expect(cell('read').checked).toBe(true));
    expect(cell('read').closest('td')?.getAttribute('data-change')).toBe('held');
    expect(cell('insert').checked).toBe(false);
    expect(sqlText()).toMatch(/Nothing to change: the grid matches what alice holds now/);
    expect(screen.getByTestId('matrix-summary').textContent).toMatch(/1 privilege held now · 0 to grant · 0 to revoke/);
  });

  it('is one view: the grid, what else is held, and database-wide grants under it', async () => {
    const wide = (privilege: string, objectType: 'DATABASE' | 'SCHEMA', objectName: string) => ({
      grantee: 'alice',
      privilege,
      objectType,
      objectSchema: null,
      objectName,
      grantable: false,
      grantor: null,
      state: 'grant' as const,
    });
    fetchDbAccess.mockResolvedValue({
      ...catalog,
      privileges: [...catalog.privileges, wide('CONNECT', 'DATABASE', 'shop'), wide('USAGE', 'SCHEMA', 'public')],
    });
    await grantsStageFor('alice');
    await waitFor(() => expect(cell('read').checked).toBe(true));
    // The grid cannot draw these, so it says they exist rather than hiding them.
    const also = await screen.findByTestId('access-grants-also-holds');
    expect(also.textContent).toMatch(/CONNECT on database shop/);
    expect(also.textContent).toMatch(/USAGE on schema public/);
    // Database- and schema-wide grants are edited below; there is no second mode.
    expect(screen.getByTestId('db-access-section-general')).toBeTruthy();
    expect(screen.queryByTestId('db-access-section-table')).toBeNull();
    expect(screen.queryByTestId('access-grants-mode')).toBeNull();
  });

  it('grants a new tick without revoking what is already held', async () => {
    await grantsStageFor('alice');
    await waitFor(() => expect(cell('read').checked).toBe(true));
    fireEvent.click(cell('insert'));
    await waitFor(() => expect(sqlText()).toMatch(/GRANT INSERT ON "public"\."orders" TO "alice"/));
    expect(sqlText()).not.toMatch(/REVOKE/);
    expect(cell('insert').closest('td')?.getAttribute('data-change')).toBe('grant');
    expect(screen.getByTestId('access-grants-change-grant').textContent).toBe('Grant INSERT on public.orders');
  });

  it('revokes only the held box that was cleared, and Reset puts it back', async () => {
    await grantsStageFor('alice');
    await waitFor(() => expect(cell('read').checked).toBe(true));
    fireEvent.click(cell('read'));
    await waitFor(() => expect(sqlText()).toMatch(/^REVOKE SELECT ON "public"\."orders" FROM "alice";$/));
    expect(cell('read').closest('td')?.getAttribute('data-change')).toBe('revoke');

    fireEvent.click(screen.getByTestId('access-grants-reset'));
    await waitFor(() => expect(cell('read').checked).toBe(true));
    expect(sqlText()).toMatch(/Nothing to change/);
  });

  it('applies a preset to the objects that load after it was clicked', async () => {
    let arrive: (v: unknown) => void = () => undefined;
    loadSchema.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    await grantsStageFor('alice');
    fireEvent.click(await screen.findByTestId('access-grants-preset-read-write'));
    arrive({ tables: [{ name: 'orders', objectType: 'TABLE' }] });
    // The SQL reaches the stage one render after the ticks; wait for it, not the box.
    await waitFor(() => expect(sqlText()).toMatch(/GRANT INSERT, UPDATE, DELETE ON "public"\."orders"/));
    expect(cell('insert').checked).toBe(true);
  });

  it('offers nothing to copy when the desired matrix already matches', async () => {
    // alice holds exactly SELECT on public.orders, which is what read-only
    // asks for. Offering a GRANT here would hand over SQL that changes
    // nothing, and running it would still be a write against production.
    await grantsStageFor('alice');

    fireEvent.click(await screen.findByTestId('access-grants-preset-read-only'));
    await waitFor(() =>
      expect(screen.getByTestId('access-grants-sql').textContent).toMatch(/Nothing to change/)
    );
    expect((screen.getByTestId('access-grants-copy') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('access-grants-open-sql') as HTMLButtonElement).disabled).toBe(true);
    expect(runAccessSql).not.toHaveBeenCalled();
  });
});

describe('AccessPermissionPanel — allow-all', () => {
  async function accountOf(name: string) {
    render(<AccessPermissionPanel />);
    fireEvent.change(screen.getByTestId('access-permission-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(screen.getByTestId(`access-permission-row-${name}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`access-permission-row-${name}`));
    fireEvent.click(screen.getByTestId('access-permission-stage-account'));
  }

  it('says an account inherits superuser through its role', async () => {
    fetchDbAccess.mockResolvedValue({
      ...catalog,
      principals: [
        { ...catalog.principals[0]!, superuser: false },
        { ...catalog.principals[1]!, superuser: true },
      ],
    });
    await accountOf('alice');
    expect(screen.getByTestId('access-permission-allow-all').textContent).toMatch(
      /Superuser.*Inherited through readonly/
    );
  });

  it('shows no banner for an ordinary account', async () => {
    await accountOf('alice');
    expect(screen.queryByTestId('access-permission-allow-all')).toBeNull();
  });
});
