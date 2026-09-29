/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';
import { AccessView } from './AccessView';

vi.mock('@/app/store/useSyncStore', () => {
  const state = {
    connections: [
      { id: 'c1', name: 'Demo PG', dialect: 'postgres', database: 'app', schema: 'public' },
      { id: 'c2', name: 'Demo MySQL', dialect: 'mysql', database: 'app' },
      { id: 'c3', name: 'Demo Db2', dialect: 'db2', database: 'SAMPLE' },
    ],
  };
  return {
    useSyncStore: (sel: (s: typeof state) => unknown) => sel(state),
  };
});

vi.mock('@/app/store/useSqlEditorStore', () => {
  const state = {
    sessionPasswords: {} as Record<string, string>,
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    setSql: vi.fn(),
    ensureConnectionSelected: vi.fn(),
    schemaCache: {
      c1: { status: 'ready', tables: [] as [] },
      c2: { status: 'ready', tables: [] as [] },
    },
  };
  return {
    useSqlEditorStore: (sel: (s: typeof state) => unknown) => sel(state),
  };
});

const fetchDbAccess = vi.fn();
const fetchSchemaList = vi.fn();
vi.mock('@/shared/api/schemaApi', () => ({
  fetchDbAccess: (...args: unknown[]) => fetchDbAccess(...args),
  fetchSchemaList: (...args: unknown[]) => fetchSchemaList(...args),
}));

beforeEach(() => {
  localStorage.removeItem('foxschema-access-connection');
  // Access tabs are gated by can(access.*). Without a seeded user, visibleSections
  // is empty and access-tab-* never mounts — same setup as AccessPermissionPanel.test.
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

describe('AccessView — User Management list + Builder handoff', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    fetchDbAccess.mockReset();
    fetchSchemaList.mockReset();
    fetchSchemaList.mockResolvedValue(['public']);
    fetchDbAccess.mockResolvedValue({
      dialect: 'postgres',
      schema: 'public',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [
        {
          name: 'alice',
          kind: 'user',
          canLogin: true,
          memberOf: ['readonly'],
          members: [],
        },
        {
          name: 'readonly',
          kind: 'role',
          canLogin: false,
          memberOf: [],
          members: ['alice'],
        },
      ],
      privileges: [],
    });
  });

  it('lands on Principals and hands off Add user from User Management', async () => {
    render(<AccessView />);

    expect(screen.getByTestId('access-permission-panel')).toBeTruthy();
    expect(screen.getByTestId('access-tab-permission').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('access-connection')).toBeTruthy();

    fireEvent.click(screen.getByTestId('access-tab-users'));
    expect(screen.getByTestId('user-management')).toBeTruthy();
    expect(screen.getByTestId('user-howto').textContent).toMatch(/How User Management works/);

    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });

    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('user-row-alice')).toBeTruthy());
    expect(screen.getByTestId('user-dialect-coach').textContent).toMatch(/PostgreSQL/i);
    expect(screen.getByTestId('user-row-alice').textContent).toMatch(/readonly/);
    expect(screen.getByTestId('user-row-readonly').textContent).toMatch(/role/i);

    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'analyst' } });

    expect(screen.getByTestId('user-sql').textContent).toMatch(/CREATE ROLE "analyst"/);
    const next = screen.getByTestId('user-grant-next') as HTMLButtonElement;
    expect(next.disabled).toBe(false);

    fireEvent.click(next);

    expect(screen.getByTestId('access-permission-panel')).toBeTruthy();
    expect(screen.getByTestId('access-tab-permission').getAttribute('aria-current')).toBe('page');
    expect((screen.getByTestId('access-permission-connection') as HTMLSelectElement).value).toBe(
      'c1'
    );
  });

  it('keeps one workspace credential across Users and Permission', async () => {
    render(<AccessView />);
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(screen.getByTestId('access-principals-sidebar')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('access-permission-row-alice')).toBeTruthy());
    expect((screen.getByTestId('access-connection') as HTMLSelectElement).value).toBe('c1');
    expect((screen.getByTestId('access-permission-connection') as HTMLSelectElement).value).toBe(
      'c1'
    );
    fireEvent.click(screen.getByTestId('access-tab-users'));
    await waitFor(() => expect(screen.getByTestId('user-row-alice')).toBeTruthy());
    expect((screen.getByTestId('access-connection') as HTMLSelectElement).value).toBe('c1');
  });

  it('previews DROP SQL when dropping a listed user', async () => {
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(screen.getByTestId('user-row-alice')).toBeTruthy());

    fireEvent.click(screen.getByTestId('user-row-alice'));
    fireEvent.click(screen.getByTestId('user-drop-selected'));

    expect(screen.getByTestId('user-sql').textContent).toMatch(/DROP USER "alice"/);
  });

  it('shows MySQL host when adding a MySQL user', async () => {
    fetchDbAccess.mockResolvedValue({
      dialect: 'mysql',
      schema: '',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [],
      privileges: [],
    });
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c2' } });
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    expect(screen.getByTestId('user-dialect-coach').textContent).toMatch(/name@host/i);
    fireEvent.click(screen.getByTestId('user-add-user'));
    expect(screen.getByTestId('user-host')).toBeTruthy();
  });

  it('shows Add user (OS) on Db2 with server CONNECT instructions', async () => {
    fetchDbAccess.mockResolvedValue({
      dialect: 'db2',
      schema: '',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [
        {
          name: 'ANALYSTS',
          kind: 'role',
          canLogin: false,
          memberOf: [],
          members: [],
        },
      ],
      privileges: [],
    });
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c3' } });
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());
    expect(screen.getByTestId('user-dialect-coach').textContent).toMatch(/Db2/i);
    expect(screen.getByTestId('user-add-user').textContent).toMatch(/Add user \(OS\)/);
    expect(screen.getByTestId('user-add-role')).toBeTruthy();
    expect(screen.queryByTestId('user-create-blocked')).toBeNull();

    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'report_user' } });
    fireEvent.change(screen.getByTestId('user-os-role'), { target: { value: 'analysts' } });

    const sql = screen.getByTestId('user-sql').textContent ?? '';
    // Server is the default now: most Db2 installations are a host you have a
    // shell on, not the compose container.
    expect(sql).toMatch(/sudo /);
    expect(sql).not.toMatch(/docker/);
    expect(sql).toMatch(/GRANT CONNECT ON DATABASE TO USER REPORT_USER/);

    // The container form is one selection away.
    fireEvent.change(screen.getByTestId('user-db2-run-mode'), { target: { value: 'docker' } });
    const dockerSql = screen.getByTestId('user-sql').textContent ?? '';
    expect(dockerSql).toMatch(/docker exec/);
    expect(dockerSql).toMatch(/foxschema-db2/);
    fireEvent.change(screen.getByTestId('user-db2-run-mode'), { target: { value: 'server' } });
    expect(sql).toMatch(/connect to SAMPLE/);
    expect(sql).toMatch(/GRANT ROLE ANALYSTS TO USER REPORT_USER/);

    const next = screen.getByTestId('user-grant-next') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(screen.getByTestId('access-permission-panel')).toBeTruthy();
  });

  it('previews OS password and disable steps when editing a Db2 user', async () => {
    fetchDbAccess.mockResolvedValue({
      dialect: 'db2',
      schema: '',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [
        {
          name: 'REPORT_USER',
          kind: 'user',
          canLogin: true,
          memberOf: [],
          members: [],
        },
      ],
      privileges: [],
    });
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c3' } });
    await waitFor(() => expect(screen.getByTestId('user-row-REPORT_USER')).toBeTruthy());

    fireEvent.click(screen.getByTestId('user-row-REPORT_USER'));
    fireEvent.click(screen.getByTestId('user-edit-selected'));
    expect(screen.getByTestId('user-sql').textContent).toMatch(/chpasswd/);

    fireEvent.click(screen.getByTestId('user-alteration-disable'));
    const disabled = screen.getByTestId('user-sql').textContent ?? '';
    expect(disabled).toMatch(/passwd -l report_user/i);
    expect(disabled).toMatch(/REVOKE CONNECT ON DATABASE FROM USER REPORT_USER/);

    fireEvent.click(screen.getByTestId('user-alteration-enable'));
    expect(screen.getByTestId('user-sql').textContent).toMatch(/passwd -u report_user/i);
  });

  it('hands off Grant access from a selected list row', async () => {
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(screen.getByTestId('user-row-alice')).toBeTruthy());

    fireEvent.click(screen.getByTestId('user-row-alice'));
    fireEvent.click(screen.getByTestId('user-grant-selected'));

    expect(screen.getByTestId('access-permission-panel')).toBeTruthy();
    expect(screen.getByTestId('access-tab-permission').getAttribute('aria-current')).toBe('page');
    expect((screen.getByTestId('access-permission-connection') as HTMLSelectElement).value).toBe(
      'c1'
    );
    await waitFor(() =>
      expect(screen.getByTestId('access-permission-principal').textContent).toMatch(/alice/)
    );
  });

  it('warns on Drop when the account has privileges or role membership', async () => {
    fetchDbAccess.mockResolvedValue({
      dialect: 'postgres',
      schema: 'public',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [
        {
          name: 'alice',
          kind: 'user',
          canLogin: true,
          memberOf: ['readonly'],
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
          state: 'grant',
        },
      ],
    });
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(screen.getByTestId('user-row-alice')).toBeTruthy());

    fireEvent.click(screen.getByTestId('user-row-alice'));
    fireEvent.click(screen.getByTestId('user-drop-selected'));

    const safety = screen.getByTestId('user-drop-safety');
    expect(safety.textContent).toMatch(/1 recorded privilege/);
    expect(safety.textContent).toMatch(/Member of: readonly/);
    expect(screen.getByTestId('user-sql').textContent).toMatch(/DROP USER "alice"/);
  });

  it('opens Edit on double-click', async () => {
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(screen.getByTestId('user-row-alice')).toBeTruthy());

    fireEvent.doubleClick(screen.getByTestId('user-row-alice'));
    expect(screen.getByTestId('user-action-form').textContent).toMatch(/Edit alice/i);
    expect(screen.getByTestId('user-sql').textContent).toMatch(/PASSWORD/);
  });

  /**
   * A slow catalog read must never repaint the list after the user has moved on.
   *
   * Found by the dialect E2E suite: the Db2 panel listed Oracle's accounts,
   * because Oracle's read was still in flight when the connection changed and
   * its response arrived afterwards. Every button on this screen — Drop, Edit,
   * Grant access — acts on the selected row, so showing one database's accounts
   * under another database's name is the worst failure this component has.
   *
   * Deterministic here, unlike in a browser: the first response is held open
   * until after the second connection has been chosen.
   */
  it('ignores a slow read that lands after the connection changed', async () => {
    const catalog = (dialect: string, principal: string) => ({
      dialect,
      schema: '',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [{ name: principal, kind: 'user', canLogin: true, memberOf: [], members: [] }],
      privileges: [],
    });

    fetchDbAccess.mockReset();
    // c1 answers late, and with a principal that exists only on it. The delay
    // is bounded so the response definitely lands during the test rather than
    // being left pending, which would hang teardown instead of asserting.
    fetchDbAccess.mockImplementation(async (ref: { connectionId: string }) => {
      if (ref.connectionId === 'c1') {
        await new Promise((r) => setTimeout(r, 150));
        return catalog('postgres', 'only_on_postgres');
      }
      return catalog('mysql', 'only_on_mysql');
    });

    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());

    // Move on while c1's read is still in flight.
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c2' } });
    await waitFor(() => expect(screen.getByTestId('user-row-only_on_mysql')).toBeTruthy());

    // Wait past c1's delay so its response has certainly arrived, then check
    // that it was discarded rather than painted over the current connection.
    await new Promise((r) => setTimeout(r, 400));

    expect(
      screen.queryByTestId('user-row-only_on_postgres'),
      "the previous connection's accounts must not appear under the new one"
    ).toBeNull();
    expect(screen.getByTestId('user-row-only_on_mysql')).toBeTruthy();
  });
});

describe('AccessView — letting a new account in', () => {
  beforeEach(() => {
    fetchDbAccess.mockReset();
    fetchSchemaList.mockReset();
    fetchDbAccess.mockResolvedValue({
      dialect: 'postgres',
      schema: '',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals: [],
      privileges: [],
    });
    fetchSchemaList.mockResolvedValue(['public', 'reporting']);
  });

  /**
   * Creating an account and letting it in were two screens.
   *
   * CREATE USER here, then the permissions tab — re-picking the same
   * connection and re-typing the same name to say "and it may reach this
   * schema". An account that cannot reach a database is not a finished
   * account, so the grants belong where the account is made.
   */
  it('grants the schemas picked while creating, in the same script', async () => {
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    await waitFor(() => expect(fetchSchemaList).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'report_user' } });

    // Before picking anything the script creates the account and stops there.
    await waitFor(() => expect(screen.getByTestId('user-sql')).toBeTruthy());
    expect(screen.getByTestId('user-sql').textContent ?? '').not.toMatch(/GRANT/i);

    const schemaBox = await screen.findByTestId('user-grant-schemas-item-reporting');
    fireEvent.click(schemaBox);

    await waitFor(() => {
      const sql = screen.getByTestId('user-sql').textContent ?? '';
      expect(sql, 'the picked schema produced no GRANT').toMatch(/GRANT/i);
      expect(sql).toMatch(/reporting/);
      expect(sql).toMatch(/report_user/);
    });
    // Still one script: the account and its way in, in the order to paste them.
    const text = screen.getByTestId('user-sql').textContent ?? '';
    expect(text.indexOf('CREATE')).toBeLessThan(text.search(/GRANT/i));
  });

  it('offers no schema picker on an engine with no schema-level GRANT', async () => {
    // MySQL, MariaDB, TiDB and Oracle have no schema-level GRANT — a MySQL
    // database *is* the schema. Offering the control there would generate SQL
    // the engine rejects.
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c2' } });
    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'report_user' } });

    await waitFor(() => expect(screen.getByTestId('user-access-grants')).toBeTruthy());
    expect(screen.queryByTestId('user-grant-schemas')).toBeNull();
    expect(screen.getByTestId('user-grant-databases')).toBeTruthy();
  });

  it('grants a MySQL database to the same name@host account it creates', async () => {
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c2' } });
    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'report_user' } });
    fireEvent.change(screen.getByTestId('user-host'), { target: { value: 'localhost' } });

    const databaseBox = await screen.findByTestId('user-grant-databases-item-app');
    fireEvent.click(databaseBox);

    await waitFor(() => {
      const sql = screen.getByTestId('user-sql').textContent ?? '';
      expect(sql).toMatch(/CREATE USER 'report_user'@'localhost'/);
      expect(sql).toMatch(/GRANT .* TO 'report_user'@'localhost'/);
      expect(sql).not.toMatch(/TO 'report_user'@'%'/);
    });
  });
});

describe('AccessView — Permission Diff stale catalog', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    fetchDbAccess.mockReset();
    fetchSchemaList.mockReset();
    fetchSchemaList.mockResolvedValue(['public']);
  });

  // EXECUTE is outside the default read-only desire, so Diff labels it "extra"
  // and the table name appears in the panel — that is how we tell catalogs apart.
  const privilege = (grantee: string, objectName: string): Record<string, unknown> => ({
    grantee,
    privilege: 'EXECUTE',
    objectType: 'TABLE',
    objectSchema: 'public',
    objectName,
    grantable: false,
    grantor: null,
    state: 'grant',
  });

  const catalog = (dialect: string, principal: string, table: string) => ({
    dialect,
    schema: 'public',
    mode: 'native',
    support: { mode: 'native', query: true, grant: true, hint: '' },
    principals: [{ name: principal, kind: 'user', canLogin: true, memberOf: [], members: [] }],
    privileges: [privilege(principal, table)],
  });

  /**
   * Switching connection must drop the previous catalog immediately.
   *
   * Diff builds reconciliation GRANT/REVOKE from `privileges`. Before this
   * fix, switching connection left those rows in place, so the panel kept
   * comparing against database A's grants while naming database B — and the
   * Copy SQL button handed the reader statements shaped by the wrong catalog.
   */
  it('clears reconciliation when the connection changes before a new load', async () => {
    fetchDbAccess.mockResolvedValue(catalog('postgres', 'alice', 'only_on_postgres'));

    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-diff'));

    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByTestId('diff-principal-name'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByTestId('diff-load-catalog'));

    await waitFor(() => expect(screen.getByTestId('diff-summary')).toBeTruthy());
    expect(screen.getByTestId('permission-diff').textContent).toMatch(/only_on_postgres/);

    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c2' } });

    await waitFor(() => expect(screen.getByTestId('diff-empty')).toBeTruthy());
    expect(screen.getByTestId('diff-empty').textContent).toMatch(/Load the catalog/);
    expect(screen.queryByTestId('diff-summary')).toBeNull();
    expect(screen.getByTestId('permission-diff').textContent).not.toMatch(/only_on_postgres/);
  });

  /**
   * A slow catalog read must not overwrite the current connection's diff.
   *
   * Same race User Management already guards: Oracle answers late, the reader
   * has moved on, and Diff would otherwise emit reconciliation SQL from the
   * superseded privileges under the new connection's dialect.
   */
  it('ignores a slow privilege catalog that lands after the connection changed', async () => {
    fetchDbAccess.mockImplementation(async (ref: { connectionId: string }) => {
      if (ref.connectionId === 'c1') {
        await new Promise((r) => setTimeout(r, 150));
        return catalog('postgres', 'alice', 'only_on_postgres');
      }
      return catalog('mysql', 'alice', 'only_on_mysql');
    });

    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-diff'));

    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByTestId('diff-principal-name'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByTestId('diff-load-catalog'));
    await waitFor(() => expect(fetchDbAccess).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: 'c2' } });
    // Principal is cleared with the panel state only for privileges; keep alice.
    fireEvent.change(screen.getByTestId('diff-principal-name'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByTestId('diff-load-catalog'));
    await waitFor(() => expect(screen.getByTestId('diff-summary')).toBeTruthy());
    expect(screen.getByTestId('permission-diff').textContent).toMatch(/only_on_mysql/);

    await new Promise((r) => setTimeout(r, 400));

    expect(
      screen.getByTestId('permission-diff').textContent,
      "the previous connection's privileges must not drive reconciliation"
    ).not.toMatch(/only_on_postgres/);
    expect(screen.getByTestId('permission-diff').textContent).toMatch(/only_on_mysql/);
  });
});

describe('AccessView — Permission stale catalog', () => {
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

  beforeEach(() => {
    fetchDbAccess.mockReset();
    fetchSchemaList.mockReset();
    fetchSchemaList.mockResolvedValue(['public']);
  });

  it('ignores a slow principal catalog after the connection changes', async () => {
    let resolveFirst!: (value: ReturnType<typeof catalog>) => void;
    const first = new Promise<ReturnType<typeof catalog>>((resolve) => {
      resolveFirst = resolve;
    });
    fetchDbAccess.mockImplementation((ref: { connectionId: string }) =>
      ref.connectionId === 'c1'
        ? first
        : Promise.resolve(catalog('mysql', 'only_on_mysql'))
    );

    render(<AccessView />);
    const connection = screen.getByTestId('access-connection');
    fireEvent.change(connection, { target: { value: 'c1' } });
    await waitFor(() =>
      expect(fetchDbAccess).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'c1' }),
        expect.anything()
      )
    );

    fireEvent.change(connection, { target: { value: 'c2' } });
    await waitFor(() =>
      expect(screen.getByTestId('access-permission-principal').textContent).toMatch(
        /only_on_mysql/
      )
    );

    await act(async () => {
      resolveFirst(catalog('postgres', 'only_on_postgres'));
      await first;
    });

    const principals = screen.getByTestId('access-permission-principal').textContent ?? '';
    expect(principals).toMatch(/only_on_mysql/);
    expect(principals).not.toMatch(/only_on_postgres/);
  });
});

describe('AccessView — User Management roles and allow-all', () => {
  const catalog = (dialect: string, principals: unknown[]) =>
    fetchDbAccess.mockResolvedValue({
      dialect,
      schema: 'public',
      mode: 'native',
      support: { mode: 'native', query: true, grant: true, hint: '' },
      principals,
      privileges: [],
    });

  beforeEach(() => {
    fetchDbAccess.mockReset();
    fetchSchemaList.mockReset();
    fetchSchemaList.mockResolvedValue(['public']);
  });

  async function openUsers(connectionId: string, row: string) {
    render(<AccessView />);
    fireEvent.click(screen.getByTestId('access-tab-users'));
    fireEvent.change(screen.getByTestId('access-connection'), { target: { value: connectionId } });
    await waitFor(() => expect(screen.getByTestId(`user-row-${row}`)).toBeTruthy());
  }

  it('puts a new account in the roles picked from the list', async () => {
    catalog('postgres', [
      { name: 'readonly', kind: 'role', canLogin: false, memberOf: [], members: [] },
      { name: 'writers', kind: 'role', canLogin: false, memberOf: [], members: [] },
    ]);
    await openUsers('c1', 'readonly');
    fireEvent.click(screen.getByTestId('user-add-user'));
    fireEvent.change(screen.getByTestId('user-name'), { target: { value: 'analyst' } });
    fireEvent.click(screen.getByTestId('user-member-of-item-readonly'));

    const sql = screen.getByTestId('user-sql').textContent ?? '';
    expect(sql).toMatch(/CREATE ROLE "analyst"/);
    expect(sql).toMatch(/GRANT "readonly" TO "analyst";/);
    expect(sql).not.toMatch(/writers/);
  });

  it('tags a superuser in the list', async () => {
    catalog('postgres', [
      { name: 'boss', kind: 'user', canLogin: true, memberOf: [], members: [], superuser: true },
      { name: 'alice', kind: 'user', canLogin: true, memberOf: [], members: [], superuser: false },
    ]);
    await openUsers('c1', 'boss');
    expect(screen.getByTestId('user-allow-all-boss').textContent).toBe('superuser');
    expect(screen.queryByTestId('user-allow-all-alice')).toBeNull();
  });

  it('drops a MySQL role by its account name, not as name@host@%', async () => {
    catalog('mysql', [{ name: 'reader@%', kind: 'role', canLogin: false, memberOf: [], members: [] }]);
    await openUsers('c2', 'reader@%');
    fireEvent.click(screen.getByTestId('user-row-reader@%'));
    fireEvent.click(screen.getByTestId('user-drop-selected'));
    expect(screen.getByTestId('user-sql').textContent).toMatch(/DROP ROLE 'reader'@'%';/);
  });
});
