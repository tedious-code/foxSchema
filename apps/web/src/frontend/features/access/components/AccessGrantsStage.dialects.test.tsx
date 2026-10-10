/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Grants view on every engine that has grants.
 *
 * AccessPermissionPanel.test.tsx walks the whole panel on Postgres. This
 * renders the Grants stage alone, once per grant-capable engine, on a catalog
 * shaped the way that engine's privilege ladder returns it (its grantee
 * spelling, its object types, its database- or schema-wide grant), and asks
 * the same four things of each: one view with no mode switch; the grid opens
 * on what is held, routines included; what the grid cannot show is listed
 * under it; and the database- and schema-wide section is there to edit it.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DbPrincipal, DbPrivilege, DbPrivilegeObjectType } from '@foxschema/ui-shared';
import type { SchemaObject } from '../lib/useAllSchemaObjects';

let objects: SchemaObject[] = [];
vi.mock('@/features/access/lib/useAllSchemaObjects', () => ({
  useAllSchemaObjects: () => ({ groups: [], objects, loading: false, error: null, reload: () => undefined }),
}));
vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  useSqlEditorStore: (sel: (s: { sessionPasswords: Record<string, string> }) => unknown) => sel({ sessionPasswords: {} }),
}));

import { AccessGrantsStage } from './AccessGrantsStage';

interface Case {
  schema: string;
  /** The role as the engine's catalog names it. */
  principal: string;
  /** How the engine's catalog reports EXECUTE on a routine; absent: it has none. */
  routineType?: DbPrivilegeObjectType;
  /** Its database- or schema-wide grant, and how the also-holds line reads it. */
  wide: Pick<DbPrivilege, 'privilege' | 'objectType' | 'objectSchema' | 'objectName'> & { reads: string };
  /** The grid has no per-object cells on this engine, so the table grant is listed instead. */
  noCells?: boolean;
}

const pgLike = (database: string): Case => ({
  schema: 'public',
  principal: 'reporting',
  routineType: 'FUNCTION',
  wide: { privilege: 'CONNECT', objectType: 'DATABASE', objectSchema: null, objectName: database, reads: `CONNECT on database ${database}` },
});
const mysqlLike = (principal: string, routines: boolean): Case => ({
  schema: 'shop',
  principal,
  ...(routines ? { routineType: 'FUNCTION' as const } : {}),
  wide: { privilege: 'CREATE', objectType: 'SCHEMA', objectSchema: 'shop', objectName: null, reads: 'CREATE on schema shop' },
});
const mssql: Case = {
  schema: 'dbo',
  principal: 'reporting',
  // database_permissions reports OBJECT_OR_COLUMN for a routine.
  routineType: 'TABLE',
  wide: { privilege: 'CREATE TABLE', objectType: 'DATABASE', objectSchema: null, objectName: null, reads: 'CREATE TABLE on the database' },
};

/** Every engine whose Access panel offers the Grants view. */
const CASES: Record<string, Case> = {
  postgres: pgLike('shop'),
  yugabytedb: pgLike('yugabyte'),
  cockroachdb: pgLike('defaultdb'),
  redshift: { ...pgLike('dev'), routineType: undefined, wide: { privilege: 'USAGE', objectType: 'SCHEMA', objectSchema: 'public', objectName: null, reads: 'USAGE on schema public' } },
  mysql: mysqlLike('reporting@%', true),
  mariadb: mysqlLike('reporting', true),
  tidb: mysqlLike('reporting@%', false),
  sqlserver: mssql,
  azuresql: mssql,
  oracle: {
    schema: 'SALES',
    principal: 'REPORTING',
    routineType: 'TABLE',
    wide: { privilege: 'CREATE SESSION', objectType: 'SYSTEM', objectSchema: null, objectName: null, reads: 'CREATE SESSION (server-wide)' },
  },
  db2: {
    schema: 'SALES',
    principal: 'REPORTING',
    routineType: 'FUNCTION',
    wide: { privilege: 'CONNECT', objectType: 'DATABASE', objectSchema: null, objectName: null, reads: 'CONNECT on the database' },
  },
  clickhouse: {
    schema: 'shop',
    principal: 'reporting',
    wide: { privilege: 'CREATE TABLE', objectType: 'SCHEMA', objectSchema: 'shop', objectName: null, reads: 'CREATE TABLE on schema shop' },
    noCells: true,
  },
};

const row = (over: Partial<DbPrivilege> & Pick<DbPrivilege, 'grantee' | 'privilege'>): DbPrivilege => ({
  objectType: 'TABLE',
  objectSchema: null,
  objectName: null,
  grantable: false,
  grantor: null,
  state: 'grant',
  ...over,
});

afterEach(() => {
  cleanup();
  objects = [];
});

describe('AccessGrantsStage, every grant-capable engine', () => {
  for (const [dialect, c] of Object.entries(CASES)) {
    it(`${dialect}: one view, opened on what ${c.principal} holds, with the rest listed under it`, async () => {
      const table = dialect === 'oracle' || dialect === 'db2' ? 'ORDERS' : 'orders';
      const fn = dialect === 'oracle' || dialect === 'db2' ? 'TAX' : 'tax';
      objects = [
        { schema: c.schema, kind: 'table', name: table },
        ...(c.routineType ? [{ schema: c.schema, kind: 'function' as const, name: fn }] : []),
      ];
      const privileges: DbPrivilege[] = [
        row({ grantee: c.principal, privilege: 'SELECT', objectSchema: c.schema, objectName: table }),
        ...(c.routineType
          ? [row({ grantee: c.principal, privilege: 'EXECUTE', objectType: c.routineType, objectSchema: c.schema, objectName: fn })]
          : []),
        row({ grantee: c.principal, ...c.wide }),
      ];
      const principal: DbPrincipal = { name: c.principal, kind: 'role', canLogin: false, memberOf: [], members: [] };

      render(
        <AccessGrantsStage
          dialect={dialect}
          connectionId="c1"
          database="shop"
          defaultSchema={c.schema}
          principal={principal}
          privileges={privileges}
          canGrant
          grantSupported
          onConfirm={vi.fn()}
          onError={vi.fn()}
        />
      );

      // One view: no "Desired matrix" / "Live catalog" switch.
      expect(screen.getByTestId('access-grants-stage')).toBeTruthy();
      expect(screen.queryByTestId('access-grants-mode')).toBeNull();

      const cell = (kind: string, name: string, permission: string) =>
        screen.queryByTestId(`matrix-cell-cat-${objects.findIndex((o) => o.name === name)}-${c.schema}.${kind}.${name}-${permission}`) as HTMLInputElement | null;

      const also = await screen.findByTestId('access-grants-also-holds');
      expect(also.textContent).toContain(c.wide.reads);
      if (c.noCells) {
        // No per-object grid on this engine: the grant is named, not hidden.
        expect(also.textContent).toContain(`SELECT on ${c.schema}.${table}`);
      } else {
        await waitFor(() => expect(cell('table', table, 'read')?.checked).toBe(true));
        expect(cell('table', table, 'insert')?.checked).toBe(false);
        expect(also.textContent).not.toContain(`on ${c.schema}.${table}`);
      }
      if (c.routineType) {
        // A routine row with EXECUTE held opens ticked, whatever the catalog called it.
        await waitFor(() => expect(cell('function', fn, 'execute-function')?.checked).toBe(true));
        expect(also.textContent).not.toContain(fn);
      }
      // Nothing changed yet, so nothing to grant or revoke.
      expect(screen.getByTestId('access-grants-sql').textContent).toMatch(/Nothing to change/);

      // Database- and schema-wide grants are edited below the grid; the
      // per-object sections are the grid's job and are not repeated.
      if (c.noCells) {
        // No builder for this engine at all, and the section says so.
        expect(screen.getByTestId('db-access-permission-sections').textContent).toMatch(/does not support the Access permission builder/);
      } else {
        expect(screen.getByTestId('db-access-section-general')).toBeTruthy();
      }
      expect(screen.queryByTestId('db-access-section-table')).toBeNull();
    });
  }
});
