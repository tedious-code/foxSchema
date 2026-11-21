/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The grid against what a principal already holds.
 *
 * The bug these pin: the grid opened empty for a role that held privileges, and
 * the SQL compared the ticks with the catalog — so ticking SELECT on one table
 * produced a REVOKE of everything else the role held, including grants the
 * grid could not even show (CONNECT on the database, USAGE on a schema).
 */
import { describe, expect, it } from 'vitest';
import { buildAccessSql } from './access-sql';
import type { DbPrivilege } from './db-access';
import {
  compileGridChanges,
  describeHeldPrivilege,
  gridObjectKey,
  heldGridPermissions,
  splitHeldPrivileges,
  type GridRow,
} from './object-grid';

const priv = (privilege: string, objectSchema: string | null, objectName: string | null, extra: Partial<DbPrivilege> = {}): DbPrivilege => ({
  grantee: 'reporting',
  privilege,
  objectType: 'TABLE',
  objectSchema,
  objectName,
  grantable: false,
  grantor: null,
  state: null,
  ...extra,
});
const objects = [
  { schema: 'public', kind: 'table' as const, name: 'orders' },
  { schema: 'public', kind: 'table' as const, name: 'Customers' },
  { schema: 'public', kind: 'view' as const, name: 'order_totals' },
  { schema: 'audit', kind: 'table' as const, name: 'orders' },
];
const sqlOf = (reqs: ReturnType<typeof compileGridChanges>['grant']) =>
  reqs.flatMap((r) => {
    const b = buildAccessSql(r, 'postgres');
    if ('error' in b) throw new Error(b.error);
    return b.statements.map((s) => s.sql);
  });

describe('heldGridPermissions', () => {
  it('maps object grants onto the cells that show them, case-insensitively', () => {
    const held = heldGridPermissions(
      [priv('SELECT', 'public', 'orders'), priv('INSERT', 'PUBLIC', 'ORDERS'), priv('SELECT', 'public', 'customers'), priv('REFERENCES', 'public', 'order_totals')],
      objects,
      'postgres'
    );
    expect(held.get(gridObjectKey(objects[0]!))).toEqual(['read', 'insert']);
    expect(held.get(gridObjectKey(objects[1]!))).toEqual(['read']);
    expect(held.get(gridObjectKey(objects[2]!))).toEqual(['reference']);
    expect(held.has(gridObjectKey(objects[3]!))).toBe(false);
  });

  it('reads ALL PRIVILEGES as every cell the engine can grant there', () => {
    const held = heldGridPermissions([priv('ALL PRIVILEGES', 'public', 'orders')], objects, 'postgres');
    // PostgreSQL has no per-object ALTER or DROP, so those cells stay empty.
    expect(held.get(gridObjectKey(objects[0]!))).toEqual(['read', 'insert', 'update', 'delete', 'reference', 'trigger-object']);
  });

  it('leaves out what a cell cannot show: scope-wide grants, DENY, unknown privileges', () => {
    const held = heldGridPermissions(
      [
        priv('CONNECT', null, 'shop', { objectType: 'DATABASE' }),
        priv('USAGE', 'public', null, { objectType: 'SCHEMA' }),
        priv('SELECT', 'public', 'orders', { state: 'deny' }),
        priv('TRUNCATE', 'public', 'orders'),
      ],
      objects,
      'postgres'
    );
    expect(held.size).toBe(0);
  });

  it('matches a schema-qualified grant to a catalog row that has no schema', () => {
    const held = heldGridPermissions([priv('SELECT', 'shop', 'orders')], [{ schema: '', kind: 'table', name: 'orders' }], 'mysql');
    expect(held.get(gridObjectKey({ schema: '', kind: 'table', name: 'orders' }))).toEqual(['read']);
  });

  it('keys a schema-less row with the grid’s fallback schema, as the grid looks it up', () => {
    const held = heldGridPermissions([priv('SELECT', 'shop', 'orders')], [{ schema: '', kind: 'table', name: 'orders' }], 'mysql', 'shop');
    expect(held.get(gridObjectKey({ schema: 'shop', kind: 'table', name: 'orders' }))).toEqual(['read']);
    // A known schema that disagrees is a different table.
    expect(heldGridPermissions([priv('SELECT', 'other', 'orders')], [{ schema: '', kind: 'table', name: 'orders' }], 'mysql', 'shop').size).toBe(0);
  });

  it('matches a grant without a schema by name, in every schema that has the object', () => {
    const held = heldGridPermissions([priv('SELECT', null, 'orders')], objects, 'mysql');
    expect(held.get(gridObjectKey(objects[0]!))).toEqual(['read']);
    expect(held.get(gridObjectKey(objects[3]!))).toEqual(['read']);
  });
});

describe('compileGridChanges', () => {
  const held = heldGridPermissions(
    [priv('SELECT', 'public', 'orders'), priv('INSERT', 'public', 'orders'), priv('SELECT', 'public', 'Customers')],
    objects,
    'postgres'
  );
  const options = { dialect: 'postgres', principal: { type: 'role' as const, name: 'reporting' }, schema: 'public' };
  const rowsAsHeld: GridRow[] = objects
    .filter((o) => o.schema === 'public')
    .map((o) => ({ ...o, permissions: held.get(gridObjectKey(o)) ?? [] }));

  it('changes nothing when the grid shows exactly what is held', () => {
    expect(compileGridChanges(rowsAsHeld, held, options)).toEqual({ grant: [], revoke: [] });
  });

  it('grants only the new tick, and revokes nothing it was not asked to', () => {
    const rows = rowsAsHeld.map((r) => (r.name === 'order_totals' ? { ...r, permissions: ['read' as const] } : r));
    const changes = compileGridChanges(rows, held, options);
    // USAGE on the schema comes with any Postgres object grant: without it the
    // object cannot be reached at all.
    expect(sqlOf(changes.grant)).toEqual(['GRANT USAGE ON SCHEMA "public" TO "reporting";', 'GRANT SELECT ON "public"."order_totals" TO "reporting";']);
    expect(changes.revoke).toEqual([]);
  });

  it('revokes a held box that was cleared, and only that one', () => {
    const rows = rowsAsHeld.map((r) => (r.name === 'orders' ? { ...r, permissions: ['read' as const] } : r));
    const changes = compileGridChanges(rows, held, options);
    expect(changes.grant).toEqual([]);
    expect(sqlOf(changes.revoke)).toEqual(['REVOKE INSERT ON "public"."orders" FROM "reporting";']);
  });

  it('never revokes from a row the reader removed from the grid', () => {
    const rows = rowsAsHeld.filter((r) => r.name !== 'orders');
    expect(compileGridChanges(rows, held, options).revoke).toEqual([]);
  });
});

describe('splitHeldPrivileges', () => {
  const objects = [{ schema: 'public', kind: 'table' as const, name: 'orders' }];
  const priv = (over: Partial<DbPrivilege>): DbPrivilege => ({
    grantee: 'report_user',
    privilege: 'SELECT',
    objectType: 'TABLE',
    objectSchema: 'public',
    objectName: 'orders',
    grantable: false,
    grantor: null,
    state: 'grant',
    ...over,
  });

  it('lists what the grid cannot show, and keeps what it can as held', () => {
    const { held, elsewhere } = splitHeldPrivileges(
      [
        priv({}),
        priv({ privilege: 'CONNECT', objectType: 'DATABASE', objectSchema: null, objectName: 'shop' }),
        priv({ privilege: 'USAGE', objectType: 'SCHEMA', objectSchema: null, objectName: 'public' }),
        priv({ privilege: 'SELECT', objectName: 'archive' }),
        priv({ privilege: 'DELETE', state: 'deny' }),
      ],
      objects,
      'postgres',
      'public'
    );
    expect(held.get(gridObjectKey(objects[0]!))).toEqual(['read']);
    expect(elsewhere.map(describeHeldPrivilege)).toEqual([
      'CONNECT on database shop',
      'USAGE on schema public',
      'SELECT on public.archive',
      'DENY DELETE on public.orders',
    ]);
  });

  it('agrees with heldGridPermissions on what is held', () => {
    const privileges = [priv({}), priv({ privilege: 'INSERT' })];
    expect(splitHeldPrivileges(privileges, objects, 'postgres', 'public').held).toEqual(
      heldGridPermissions(privileges, objects, 'postgres', 'public')
    );
  });
});

describe('routine rows open ticked', () => {
  it('reads a held EXECUTE onto the function’s row', () => {
    const objects = [{ schema: 'shop', kind: 'function' as const, name: 'tax' }];
    const held = heldGridPermissions(
      [
        {
          grantee: 'app',
          privilege: 'EXECUTE',
          objectType: 'FUNCTION',
          objectSchema: 'shop',
          objectName: 'tax',
          grantable: false,
          grantor: null,
          state: 'grant',
        },
      ],
      objects,
      'postgres',
      'shop'
    );
    expect(held.get(gridObjectKey(objects[0]!))).toEqual(['execute-function']);
  });
});
