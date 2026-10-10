/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether a reader can tell how to set a permission.
 *
 * The grid lists every object with its DML and DDL privileges, and a row that
 * holds none shows — in both columns. The action opening the grant editor was
 * labelled "Edit" on every row, which on an empty one describes nothing the
 * reader can see, so the only way to grant was invisible to the people looking
 * for it. These tests pin the label to the row's state.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DbPrivilege } from '@foxschema/ui-shared';

const loadSchema = vi.fn().mockResolvedValue({
  tables: [{ name: 'orders', objectType: 'TABLE' }],
});
vi.mock('@/shared/api/schemaApi', () => ({
  fetchSchemaList: vi.fn().mockResolvedValue(['public']),
  loadSchema: (...a: unknown[]) => loadSchema(...a),
}));
vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  useSqlEditorStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ sessionPasswords: {} }),
}));

import { DbAccessPermissionSections } from './DbAccessPermissionSections';

// The grid takes AccessPrincipal (which carries `type`), not the catalog's
// DbPrincipal — the panel maps between them.
const principal = { type: 'user' as const, name: 'app_rw', kind: 'user' };

const grantOn = (objectName: string): DbPrivilege =>
  ({
    grantee: 'app_rw',
    privilege: 'SELECT',
    objectType: 'TABLE',
    objectSchema: 'public',
    objectName,
    grantable: false,
    grantor: null,
    state: 'grant',
  }) as DbPrivilege;

const renderSections = (privileges: DbPrivilege[]) =>
  render(
    <DbAccessPermissionSections
      dialect="postgres"
      connectionId="c1"
      database="app"
      defaultSchema="public"
      principal={principal}
      privileges={privileges}
      canGrant
      grantSupported
      onConfirm={vi.fn()}
      onError={vi.fn()}
    />
  );

describe('how the grid offers to set a permission', () => {
  it('offers Grant on a row that holds nothing', async () => {
    // The row shows — in both columns; "Edit" described nothing the reader
    // could see, so the only way to grant was invisible.
    renderSections([]);
    fireEvent.click(screen.getByTestId('db-access-expand-table'));
    const action = await screen.findByTestId('db-access-edit-orders');
    expect(action.textContent).toContain('Grant');
    expect(action.getAttribute('title')).toMatch(/Grant privileges on orders/);
  });

  it('offers Edit once the row holds something', async () => {
    renderSections([grantOn('orders')]);
    fireEvent.click(screen.getByTestId('db-access-expand-table'));
    const action = await screen.findByTestId('db-access-edit-orders');
    expect(action.textContent).toContain('Edit');
    expect(action.textContent).not.toContain('Grant');
  });

  it('keeps Revoke unavailable while there is nothing to revoke', async () => {
    // The complement: offering Revoke on an empty row would be the same
    // mistake in the other direction.
    renderSections([]);
    fireEvent.click(screen.getByTestId('db-access-expand-table'));
    const revoke = (await screen.findByTestId('db-access-obj-revoke-orders')) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
  });

  it('explains what a dash in the row means', () => {
    renderSections([]);
    const help = screen.getByText(/Expand a section to load objects/);
    expect(help.textContent).toMatch(/holds none yet/);
  });

  it('still says the SQL is dialect-specific', () => {
    // The emitter note is the reason the preview is trustworthy; do not lose it
    // while rewording the sentence around it.
    renderSections([grantOn('orders')]);
    expect(screen.getByText(/Expand a section to load objects/).textContent).toMatch(
      /Postgres, MySQL, SQL Server, Oracle, Db2/
    );
  });
});
