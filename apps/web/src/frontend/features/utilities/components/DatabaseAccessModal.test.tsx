/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';
import { useSyncStore } from '@/app/store/useSyncStore';

const fetchDbAccess = vi.fn();
const executeSql = vi.fn();
const fetchSchemaList = vi.fn();
const loadSchema = vi.fn();

vi.mock('@/shared/api/schemaApi', () => ({
  fetchDbAccess: (...args: unknown[]) => fetchDbAccess(...args),
  fetchSchemaList: (...args: unknown[]) => fetchSchemaList(...args),
  loadSchema: (...args: unknown[]) => loadSchema(...args),
}));
vi.mock('@/shared/api/sqlApi', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
}));

import { DatabaseAccessModal } from './DatabaseAccessModal';

beforeEach(() => {
  fetchDbAccess.mockReset();
  executeSql.mockReset();
  fetchSchemaList.mockReset();
  loadSchema.mockReset();
  fetchSchemaList.mockResolvedValue(['public']);
  loadSchema.mockResolvedValue({
    tables: [
      { name: 'orders', objectType: 'TABLE' },
      { name: 'customers', objectType: 'TABLE' },
      { name: 'v_open', objectType: 'VIEW' },
      { name: 'sp_run', objectType: 'PROCEDURE' },
      { name: 'fn_total', objectType: 'FUNCTION' },
    ],
  });
  fetchDbAccess.mockResolvedValue({
    dialect: 'postgres',
    schema: 'public',
    mode: 'native',
    support: {
      mode: 'native',
      query: true,
      grant: true,
      hint: 'PostgreSQL catalog',
    },
    principals: [
      {
        name: 'analysts',
        kind: 'role',
        canLogin: false,
        memberOf: [],
        members: ['alice'],
      },
      {
        name: 'alice',
        kind: 'user',
        canLogin: true,
        memberOf: ['analysts'],
        members: [],
      },
    ],
    privileges: [
      {
        grantee: 'alice',
        privilege: 'SELECT',
        objectType: 'TABLE',
        objectSchema: 'public',
        objectName: 'orders',
        grantable: false,
        grantor: null,
        state: null,
      },
    ],
  });
  executeSql.mockResolvedValue({
    results: [{ ok: true, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 }],
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
  useSyncStore.setState({
    connections: [
      {
        id: 'c1',
        name: 'prod',
        dialect: 'postgres',
        schema: 'public',
        database: 'app',
        hasPassword: true,
      },
    ],
  } as never);
});

describe('DatabaseAccessModal', () => {
  it('lists groups and users, shows privileges, and grants via dialect-aware sections', async () => {
    render(<DatabaseAccessModal open onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('db-access-connection'), { target: { value: 'c1' } });

    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    // The group renders empty before the catalog arrives; wait for its rows.
    await waitFor(() =>
      expect(screen.getByTestId('db-access-group-role').textContent).toMatch(/analysts/)
    );
    expect(screen.getByTestId('db-access-group-user').textContent).toMatch(/alice/);

    fireEvent.click(await screen.findByTestId('db-access-principal-alice'));
    expect(screen.getByTestId('db-access-privileges').textContent).toMatch(/SELECT/);
    expect(screen.getByTestId('db-access-privileges').textContent).toMatch(/public\.orders/);

    expect(screen.getByTestId('db-access-permission-sections')).toBeTruthy();
    expect(screen.getByTestId('db-access-section-general')).toBeTruthy();

    fireEvent.click(screen.getByTestId('db-access-expand-table'));
    await waitFor(() => expect(fetchSchemaList).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('db-access-obj-public-orders')).toBeTruthy());

    fireEvent.click(screen.getByTestId('db-access-edit-orders'));
    await waitFor(() => expect(screen.getByTestId('db-access-object-editor')).toBeTruthy());
    // Held SELECT is pre-selected; Preview uses dialect buildAccessSql.
    fireEvent.click(screen.getByTestId('db-access-preview-sql'));

    await waitFor(() => expect(screen.getByTestId('db-access-sql-modal')).toBeTruthy());
    const preview = screen.getByTestId('db-access-grant-sql').textContent ?? '';
    expect(preview).toMatch(/GRANT/i);
    expect(preview).toMatch(/orders/i);
    expect(preview).toMatch(/alice/i);

    fireEvent.click(screen.getByTestId('db-access-grant'));
    expect(screen.getByTestId('db-access-confirm').textContent).toMatch(/GRANT/i);
    fireEvent.click(screen.getByTestId('db-access-confirm-run'));
    await waitFor(() => expect(executeSql).toHaveBeenCalled());
    const stmts = executeSql.mock.calls[0][1] as string[];
    expect(stmts.join('\n')).toMatch(/GRANT/i);
    expect(stmts.join('\n')).toMatch(/orders/i);
  });

  it('ignores a slow catalog after the credential changes', async () => {
    useSyncStore.setState({
      connections: [
        {
          id: 'c1',
          name: 'slow prod',
          dialect: 'postgres',
          schema: 'public',
          database: 'app',
          hasPassword: true,
        },
        {
          id: 'c2',
          name: 'current prod',
          dialect: 'mysql',
          database: 'app',
          hasPassword: true,
        },
      ],
    } as never);
    const catalog = (dialect: string, principal: string) => ({
      dialect,
      schema: dialect === 'postgres' ? 'public' : '',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [
        { name: principal, kind: 'user', canLogin: true, memberOf: [], members: [] },
      ],
      privileges: [],
    });
    let resolveFirst!: (value: ReturnType<typeof catalog>) => void;
    const first = new Promise<ReturnType<typeof catalog>>((resolve) => {
      resolveFirst = resolve;
    });
    fetchDbAccess.mockImplementation((ref: { connectionId: string }) =>
      ref.connectionId === 'c1'
        ? first
        : Promise.resolve(catalog('mysql', 'only_on_mysql'))
    );

    render(<DatabaseAccessModal open onClose={() => undefined} />);
    const connection = screen.getByTestId('db-access-connection');
    fireEvent.change(connection, { target: { value: 'c1' } });
    await waitFor(() =>
      expect(fetchDbAccess).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'c1' }),
        expect.anything()
      )
    );

    fireEvent.change(connection, { target: { value: 'c2' } });
    await waitFor(() =>
      expect(screen.getByTestId('db-access-group-user').textContent).toMatch(/only_on_mysql/)
    );

    await act(async () => {
      resolveFirst(catalog('postgres', 'only_on_postgres'));
      await first;
    });

    const users = screen.getByTestId('db-access-group-user').textContent ?? '';
    expect(users).toMatch(/only_on_mysql/);
    expect(users).not.toMatch(/only_on_postgres/);
  });
});

describe('DatabaseAccessModal — role membership is not an object privilege', () => {
  /** A principal that both holds a privilege and belongs to a role. */
  function withMembership() {
    fetchDbAccess.mockResolvedValue({
      dialect: 'postgres',
      schema: 'public',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: 'PostgreSQL catalog' },
      principals: [
        { name: 'alice', kind: 'user', canLogin: true, memberOf: ['analysts'], members: [] },
      ],
      privileges: [
        {
          grantee: 'alice',
          privilege: 'SELECT',
          objectType: 'TABLE',
          objectSchema: 'public',
          objectName: 'orders',
          grantable: false,
          grantor: null,
          state: null,
        },
        {
          grantee: 'alice',
          privilege: 'analysts',
          objectType: 'ROLE',
          objectSchema: null,
          objectName: 'analysts',
          grantable: false,
          grantor: null,
          state: null,
        },
      ],
    });
  }

  it('lists the membership under Role memberships, not under privileges', async () => {
    withMembership();
    render(<DatabaseAccessModal open onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('db-access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('db-access-principal-alice'));

    const privileges = screen.getByTestId('db-access-privileges').textContent ?? '';
    const memberships = screen.getByTestId('db-access-memberships').textContent ?? '';

    expect(privileges).toMatch(/SELECT/);
    expect(privileges).toMatch(/public\.orders/);
    expect(privileges).not.toMatch(/analysts/);
    expect(privileges).not.toMatch(/\bROLE\b/);
    expect(privileges).toMatch(/Object privileges \(1\)/);

    expect(memberships).toMatch(/Role memberships \(1\)/);
    expect(memberships).toMatch(/analysts/);
  });

  it('offers object privileges and membership as separate grant kinds', async () => {
    withMembership();
    render(<DatabaseAccessModal open onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('db-access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('db-access-principal-alice'));

    const kind = screen.getByTestId('db-access-grant-kind') as HTMLSelectElement;
    // Postgres has database-level ALL, so allow-all is offered too.
    expect([...kind.options].map((o) => o.value)).toEqual(['sections', 'membership', 'all']);

    expect(screen.getByTestId('db-access-permission-sections')).toBeTruthy();
    fireEvent.change(kind, { target: { value: 'membership' } });
    expect(screen.queryByTestId('db-access-permission-sections')).toBeNull();
    expect(screen.getByTestId('db-access-grant-name')).toBeTruthy();
  });
});

describe('DatabaseAccessModal — dialect-aware general CREATE', () => {
  it('previews Postgres CREATE ON SCHEMA for general create-object', async () => {
    render(<DatabaseAccessModal open onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('db-access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('db-access-principal-alice'));

    fireEvent.click(screen.getByTestId('db-access-grant-general'));
    await waitFor(() => expect(screen.getByTestId('db-access-general-editor')).toBeTruthy());
    fireEvent.click(screen.getByTestId('db-access-general-preview-sql'));
    await waitFor(() => expect(screen.getByTestId('db-access-sql-modal')).toBeTruthy());
    const sql = screen.getByTestId('db-access-grant-sql').textContent ?? '';
    // Postgres emitter — not a fake "GRANT CREATE TABLE, CREATE VIEW ON SCHEMA".
    expect(sql).toMatch(/CREATE/i);
    expect(sql).toMatch(/SCHEMA/i);
    expect(sql).toMatch(/alice/i);
  });
});

describe('DatabaseAccessModal — roles and allow-all', () => {
  /** What `GRANT ALL PRIVILEGES ON *.*` leaves in MySQL's USER_PRIVILEGES. */
  const MYSQL_ALL = [
    'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE USER',
    'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'FILE', 'INDEX', 'INSERT', 'LOCK TABLES',
    'PROCESS', 'REFERENCES', 'RELOAD', 'REPLICATION CLIENT', 'REPLICATION SLAVE', 'SELECT',
    'SHOW DATABASES', 'SHOW VIEW', 'SHUTDOWN', 'SUPER', 'TRIGGER', 'UPDATE',
  ];
  const row = (grantee: string, privilege: string, objectType: string, extra: object = {}) => ({
    grantee,
    privilege,
    objectType,
    objectSchema: null,
    objectName: null,
    grantable: false,
    grantor: null,
    state: null,
    ...extra,
  });

  function catalog(dialect: string, principals: unknown[], privileges: unknown[]) {
    useSyncStore.setState({
      connections: [
        { id: 'c1', name: 'prod', dialect, schema: 'demo_a', database: 'demo_a', hasPassword: true },
      ],
    } as never);
    fetchDbAccess.mockResolvedValue({
      dialect,
      schema: 'demo_a',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: 'catalog' },
      principals,
      privileges,
    });
  }

  async function open(name: string) {
    render(<DatabaseAccessModal open onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('db-access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId(`db-access-principal-${name}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`db-access-principal-${name}`));
  }

  it('says ALL PRIVILEGES ON *.* once, tags the account, and revokes it whole', async () => {
    catalog(
      'mysql',
      [{ name: 'app@%', kind: 'user', canLogin: true, memberOf: [], members: [] }],
      MYSQL_ALL.map((p) => row('app@%', p, 'GLOBAL'))
    );
    await open('app@%');

    expect(screen.getByTestId('db-access-allow-all-app@%').textContent).toBe('allow-all');
    expect(screen.getByTestId('db-access-allow-all-banner').textContent).toMatch(
      /every privilege on the whole server/
    );
    const group = screen.getByTestId('db-access-privgroup-0');
    expect(group.getAttribute('data-all')).toBe('true');
    expect(group.textContent).toMatch(/ALL PRIVILEGES/);
    expect(group.textContent).toMatch(/every database \(\*\.\*\)/);
    // Collapsed: 27 privileges are not 27 rows until asked for.
    expect(screen.queryByTestId('db-access-revoke-0')).toBeNull();
    fireEvent.click(screen.getByTestId('db-access-privgroup-toggle-0'));
    expect(screen.getByTestId('db-access-revoke-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('db-access-revoke-all-0'));
    expect(screen.getByTestId('db-access-confirm').textContent).toMatch(
      "REVOKE ALL PRIVILEGES ON *.* FROM 'app'@'%';"
    );
  });

  it('shows a superuser inherited through a role, and finds it by filter', async () => {
    catalog(
      'postgres',
      [
        { name: 'admins', kind: 'role', canLogin: false, memberOf: [], members: ['alice'], superuser: true },
        { name: 'alice', kind: 'user', canLogin: true, memberOf: ['admins'], members: [], superuser: false },
        { name: 'bob', kind: 'user', canLogin: true, memberOf: [], members: [], superuser: false },
      ],
      []
    );
    await open('alice');
    expect(screen.getByTestId('db-access-allow-all-banner').textContent).toMatch(
      /Superuser.*Inherited through admins/
    );

    fireEvent.change(screen.getByTestId('db-access-filter'), { target: { value: 'allow-all' } });
    expect(screen.queryByTestId('db-access-principal-bob')).toBeNull();
    expect(screen.getByTestId('db-access-principal-alice')).toBeTruthy();
    expect(screen.getByTestId('db-access-principal-admins')).toBeTruthy();
  });

  it('marks WITH GRANT OPTION as grantable, not with an asterisk', async () => {
    catalog(
      'postgres',
      [{ name: 'alice', kind: 'user', canLogin: true, memberOf: [], members: [] }],
      [row('alice', 'SELECT', 'TABLE', { objectSchema: 'public', objectName: 'orders', grantable: true })]
    );
    await open('alice');
    const privileges = screen.getByTestId('db-access-privileges').textContent ?? '';
    expect(screen.getByTestId('db-access-grantable')).toBeTruthy();
    expect(privileges).not.toMatch(/SELECT \*/);
  });

  it('offers the roles the principal is not yet in, and still takes a typed name', async () => {
    catalog(
      'postgres',
      [
        { name: 'analysts', kind: 'role', canLogin: false, memberOf: [], members: ['alice'] },
        { name: 'readers', kind: 'role', canLogin: false, memberOf: [], members: [] },
        { name: 'ops', kind: 'group', canLogin: false, memberOf: [], members: [] },
        { name: 'alice', kind: 'user', canLogin: true, memberOf: ['analysts'], members: [] },
      ],
      [row('alice', 'analysts', 'ROLE', { objectName: 'analysts' })]
    );
    await open('alice');
    fireEvent.change(screen.getByTestId('db-access-grant-kind'), { target: { value: 'membership' } });

    const pick = screen.getByTestId('db-access-grant-role') as HTMLSelectElement;
    const offered = [...pick.options].map((o) => o.textContent);
    expect(offered).toEqual(['readers', 'ops', 'Other… (type a name)']);
    await waitFor(() =>
      expect(screen.getByTestId('db-access-grant-sql').textContent).toBe('GRANT "readers" TO "alice";')
    );
    expect(screen.queryByTestId('db-access-grant-name')).toBeNull();

    fireEvent.change(pick, { target: { value: pick.options[2]!.value } });
    fireEvent.change(screen.getByTestId('db-access-grant-name'), { target: { value: 'auditors' } });
    expect(screen.getByTestId('db-access-grant-sql').textContent).toBe('GRANT "auditors" TO "alice";');
  });

  it('grants everything only after the name is typed, and says what it confers', async () => {
    catalog(
      'mysql',
      [{ name: 'app@%', kind: 'user', canLogin: true, memberOf: [], members: [] }],
      []
    );
    await open('app@%');
    fireEvent.change(screen.getByTestId('db-access-grant-kind'), { target: { value: 'all' } });

    const target = screen.getByTestId('db-access-all-target') as HTMLSelectElement;
    expect([...target.options].map((o) => o.value)).toEqual(['server', 'database']);
    expect(screen.getByTestId('db-access-all-note').textContent).toMatch(/Critical.*every database/);
    expect(screen.getByTestId('db-access-grant-sql').textContent).toBe(
      "GRANT ALL PRIVILEGES ON *.* TO 'app'@'%';"
    );
    fireEvent.change(target, { target: { value: 'database' } });
    expect(screen.getByTestId('db-access-grant-sql').textContent).toBe(
      "GRANT ALL PRIVILEGES ON `demo_a`.* TO 'app'@'%';"
    );

    fireEvent.click(screen.getByTestId('db-access-grant'));
    const run = screen.getByTestId('db-access-confirm-run') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('db-access-confirm-type'), { target: { value: 'app' } });
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('db-access-confirm-type'), { target: { value: 'app@%' } });
    expect(run.disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect(executeSql).toHaveBeenCalled());
    expect((executeSql.mock.calls[0][1] as string[]).join('\n')).toMatch(/ON `demo_a`\.\*/);
  });

  it('does not offer allow-all where the engine has none', async () => {
    catalog('sqlite', [{ name: 'x', kind: 'user', canLogin: true, memberOf: [], members: [] }], []);
    render(<DatabaseAccessModal open onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('db-access-connection'), { target: { value: 'c1' } });
    expect(screen.queryByText('All privileges (allow-all)')).toBeNull();
  });
});
