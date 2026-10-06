/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Routine grants on every engine, one row each.
 *
 * The feature tests in db-access.test.ts and object-grid.held.test.ts pick the
 * engines that motivated a change. This file names every engine a connection
 * can use, so a new one, or an old one nobody thought of, has to be given an
 * answer here: what its privilege ladder reads for routines, the exact clause
 * its REVOKE writes, or the sentence it refuses with. An engine left out of
 * ENGINES fails the coverage test at the bottom.
 */
import { describe, expect, it } from 'vitest';
import { PROVIDER_SETTINGS } from '../../providers/provider-settings.js';
import {
  buildDbAccessPrivilegeQueries,
  buildGrantRevokeSql,
  dialectSupportsDbAccess,
  normalizeDbPrivileges,
  type DbPrivilege,
  type DbPrivilegeObjectType,
} from './db-access.js';
import { describeHeldPrivilege, splitHeldPrivileges, type GridObjectKind } from './object-grid.js';

type RoutineType = 'PROCEDURE' | 'FUNCTION' | 'ROUTINE';

interface EngineRow {
  /**
   * Where routine grants come from, as a pattern every ladder rung that reads
   * them matches, or the reason the engine's catalog has none to read.
   */
  routineCatalog: RegExp | { none: string };
  /**
   * `REVOKE EXECUTE` on `app.f` from role `r1`, per routine type: the exact
   * statement, or the refusal (matched as a pattern).
   */
  revoke: Record<RoutineType, string | { error: RegExp }>;
}

const PG_REVOKE: EngineRow['revoke'] = {
  PROCEDURE: 'REVOKE EXECUTE ON PROCEDURE "app"."f" FROM "r1";',
  FUNCTION: 'REVOKE EXECUTE ON FUNCTION "app"."f" FROM "r1";',
  // Only an aggregate reaches here without a kind; Postgres 11+ accepts ON
  // ROUTINE for any.
  ROUTINE: 'REVOKE EXECUTE ON ROUTINE "app"."f" FROM "r1";',
};
const MYSQL_REVOKE = (grantee: string): EngineRow['revoke'] => ({
  PROCEDURE: `REVOKE EXECUTE ON PROCEDURE \`app\`.\`f\` FROM ${grantee};`,
  FUNCTION: `REVOKE EXECUTE ON FUNCTION \`app\`.\`f\` FROM ${grantee};`,
  // MySQL has no ON ROUTINE; guessing one of the two revokes the wrong thing.
  ROUTINE: { error: /procedure or a function/ },
});
const MSSQL_REVOKE: EngineRow['revoke'] = {
  // SQL Server names every schema-scoped object the same way.
  PROCEDURE: 'REVOKE EXECUTE ON OBJECT::[app].[f] FROM [r1];',
  FUNCTION: 'REVOKE EXECUTE ON OBJECT::[app].[f] FROM [r1];',
  ROUTINE: 'REVOKE EXECUTE ON OBJECT::[app].[f] FROM [r1];',
};
const NO_GRANT = (why: RegExp): EngineRow['revoke'] => ({
  PROCEDURE: { error: why },
  FUNCTION: { error: why },
  ROUTINE: { error: why },
});

const PG_ROUTINES = /information_schema\.role_routine_grants[\s\S]*information_schema\.routines/;

/** Every engine a connection can be made to. */
const ENGINES: Record<string, EngineRow> = {
  postgres: { routineCatalog: PG_ROUTINES, revoke: PG_REVOKE },
  yugabytedb: { routineCatalog: PG_ROUTINES, revoke: PG_REVOKE },
  // ON ROUTINE is a syntax error on CockroachDB (v26).
  cockroachdb: { routineCatalog: PG_ROUTINES, revoke: { ...PG_REVOKE, ROUTINE: { error: /procedure or a function/ } } },
  redshift: { routineCatalog: PG_ROUTINES, revoke: PG_REVOKE },
  mysql: { routineCatalog: /mysql\.procs_priv/, revoke: MYSQL_REVOKE(`'r1'@'%'`) },
  // A MariaDB role has no host: 'r1'@'%' names a user that does not exist.
  mariadb: { routineCatalog: /mysql\.procs_priv/, revoke: MYSQL_REVOKE(`'r1'`) },
  // No stored routines, and no mysql.procs_priv to read (TiDB v8.5).
  tidb: {
    routineCatalog: { none: 'TiDB has no stored procedures or functions, and no mysql.procs_priv.' },
    revoke: NO_GRANT(/TiDB has no stored procedures or functions/),
  },
  // Object permissions, routines included, are rows of database_permissions.
  sqlserver: { routineCatalog: /sys\.database_permissions/, revoke: MSSQL_REVOKE },
  azuresql: { routineCatalog: /sys\.database_permissions/, revoke: MSSQL_REVOKE },
  oracle: {
    // DBA_TAB_PRIVS lists EXECUTE on procedures, functions and packages too.
    routineCatalog: /(DBA|ALL)_TAB_PRIVS/,
    revoke: {
      // Oracle names an object with no keyword; ON PROCEDURE is a syntax error.
      PROCEDURE: 'REVOKE EXECUTE ON "app"."f" FROM "r1";',
      FUNCTION: 'REVOKE EXECUTE ON "app"."f" FROM "r1";',
      ROUTINE: 'REVOKE EXECUTE ON "app"."f" FROM "r1";',
    },
  },
  db2: {
    routineCatalog: /SYSCAT\.ROUTINEAUTH/,
    revoke: {
      // Db2 rejects a routine REVOKE without RESTRICT (SQL0104N).
      PROCEDURE: 'REVOKE EXECUTE ON PROCEDURE "app"."f" FROM ROLE "r1" RESTRICT;',
      FUNCTION: 'REVOKE EXECUTE ON FUNCTION "app"."f" FROM ROLE "r1" RESTRICT;',
      ROUTINE: { error: /procedure or a function/ },
    },
  },
  clickhouse: {
    routineCatalog: { none: 'ClickHouse has no stored procedures; its SQL functions take no grants.' },
    revoke: NO_GRANT(/ClickHouse has no procedures or functions/),
  },
  sqlite: { routineCatalog: { none: 'No GRANT model: access is the file’s.' }, revoke: NO_GRANT(/no GRANT\/REVOKE/) },
  duckdb: { routineCatalog: { none: 'No GRANT model: access is the file’s.' }, revoke: NO_GRANT(/no GRANT\/REVOKE/) },
  redis: { routineCatalog: { none: 'ACLs, not SQL grants.' }, revoke: NO_GRANT(/Redis has them — ACL SETUSER/) },
  mongodb: { routineCatalog: { none: 'Roles, not SQL grants.' }, revoke: NO_GRANT(/MongoDB has them — db\.grantRolesToUser/) },
};

const ROUTINE_TYPES: RoutineType[] = ['PROCEDURE', 'FUNCTION', 'ROUTINE'];

/** File permissions (SQLite, DuckDB) or a non-SQL ACL language (Redis, MongoDB). */
const NO_SQL_GRANTS = new Set(['sqlite', 'duckdb', 'redis', 'mongodb']);

describe('routine privileges, every engine', () => {
  it('names every engine a connection can use', () => {
    expect(Object.keys(ENGINES).sort()).toEqual(Object.keys(PROVIDER_SETTINGS).sort());
  });

  for (const [dialect, row] of Object.entries(ENGINES)) {
    describe(dialect, () => {
      const ladder = buildDbAccessPrivilegeQueries({ dialect, schema: 'app' });

      if ('none' in row.routineCatalog) {
        it(`reads no routine grants (${row.routineCatalog.none})`, () => {
          for (const q of ladder) {
            expect(q.sql).not.toMatch(/routine|procs_priv|ROUTINEAUTH/i);
          }
        });
      } else {
        const catalog = row.routineCatalog;
        it(`reads routine grants on the first rung (${catalog.source})`, () => {
          // The first rung is what a login with ordinary rights gets; a fallback
          // that alone carries routines would show them only after a failure.
          expect(ladder[0]?.sql).toMatch(catalog);
        });
      }

      for (const type of ROUTINE_TYPES) {
        const expected = row.revoke[type];
        it(`REVOKE EXECUTE on a ${type.toLowerCase()}`, () => {
          const built = buildGrantRevokeSql({
            dialect,
            action: 'revoke',
            privilege: 'EXECUTE',
            objectType: type,
            objectSchema: 'app',
            objectName: 'f',
            grantee: 'r1',
            granteeKind: 'role',
          });
          if (typeof expected === 'string') {
            expect(built).toEqual({ sql: expected });
          } else {
            expect('error' in built ? built.error : built.sql).toMatch(expected.error);
          }
          // Whatever happens, a routine never becomes a TABLE grant.
          if ('sql' in built) expect(built.sql).not.toMatch(/ON TABLE/);
        });
      }

      it('grants with the same clause it revokes with', () => {
        for (const type of ROUTINE_TYPES) {
          const args = {
            dialect,
            privilege: 'EXECUTE',
            objectType: type,
            objectSchema: 'app',
            objectName: 'f',
            grantee: 'r1',
            granteeKind: 'role' as const,
          };
          const grant = buildGrantRevokeSql({ ...args, action: 'grant' });
          const revoke = buildGrantRevokeSql({ ...args, action: 'revoke' });
          if ('error' in revoke) {
            expect(grant).toEqual(revoke);
            continue;
          }
          expect('sql' in grant && grant.sql.replace(/^GRANT /, '').replace(/ TO /, ' ')).toBe(
            revoke.sql.replace(/^REVOKE /, '').replace(/ FROM /, ' ').replace(/ RESTRICT;$/, ';')
          );
        }
      });

      const grants = !NO_SQL_GRANTS.has(dialect);
      it(grants ? 'has a GRANT model' : 'has no SQL GRANT model, and says why', () => {
        const support = dialectSupportsDbAccess(dialect);
        expect(support.grant).toBe(grants);
        expect(support.query).toBe(grants);
        expect(support.hint.length).toBeGreaterThan(20);
      });
    });
  }
});

describe('normalizeDbPrivileges keeps the routine kind', () => {
  // Every spelling an engine's routine rung returns for the object type.
  const SPELLINGS: Array<[string, DbPrivilegeObjectType, string]> = [
    ['ROUTINE', 'ROUTINE', 'postgres aggregate (no routine_type)'],
    ['PROCEDURE', 'PROCEDURE', 'postgres routine_type, mysql.procs_priv, Db2 ROUTINETYPE P'],
    ['FUNCTION', 'FUNCTION', 'postgres routine_type, mysql.procs_priv, Db2 ROUTINETYPE F'],
    ['procedure', 'PROCEDURE', 'any engine answering in lower case'],
    ['function', 'FUNCTION', 'any engine answering in lower case'],
    // SQL Server and Oracle report a routine as an object; the grid matches it
    // by name, so it is still held — it just does not say which kind.
    ['OBJECT_OR_COLUMN', 'TABLE', 'sqlserver class_desc'],
  ];
  for (const [raw, kind, where] of SPELLINGS) {
    it(`${raw} → ${kind} (${where})`, () => {
      const [p] = normalizeDbPrivileges([
        { grantee: 'r1', privilege: 'EXECUTE', object_type: raw, object_schema: 'app', object_name: 'f' },
      ]);
      expect(p?.objectType).toBe(kind);
    });
  }

  it('reads Db2’s capitalised columns', () => {
    const [p] = normalizeDbPrivileges([
      { GRANTEE: 'R1', PRIVILEGE: 'EXECUTE', OBJECT_TYPE: 'PROCEDURE', OBJECT_SCHEMA: 'APP', OBJECT_NAME: 'F', GRANTABLE: 1 },
    ]);
    expect(p).toMatchObject({ grantee: 'R1', objectType: 'PROCEDURE', objectSchema: 'APP', objectName: 'F', grantable: true });
  });

  it('reads the positional MySQL routine row, whose grantee is quoted like information_schema’s', () => {
    // The UNION's column names come from the first branch, so the routine
    // branch's values arrive under TABLE_PRIVILEGES' aliases.
    const [p] = normalizeDbPrivileges([
      { grantee: `'r1'@'%'`, privilege: 'EXECUTE', object_type: 'FUNCTION', object_schema: 'app', object_name: 'f', grantable: 0 },
    ]);
    expect(p).toMatchObject({ grantee: 'r1@%', objectType: 'FUNCTION', grantable: false });
  });
});

describe('splitHeldPrivileges, per object type', () => {
  const priv = (over: Partial<DbPrivilege>): DbPrivilege => ({
    grantee: 'r1',
    privilege: 'SELECT',
    objectType: 'TABLE',
    objectSchema: 'app',
    objectName: 'orders',
    grantable: false,
    grantor: null,
    state: 'grant',
    ...over,
  });
  const objects: Array<{ schema: string; kind: GridObjectKind; name: string }> = [
    { schema: 'app', kind: 'table', name: 'orders' },
    { schema: 'app', kind: 'view', name: 'open_orders' },
    { schema: 'app', kind: 'procedure', name: 'close_day' },
    { schema: 'app', kind: 'function', name: 'tax' },
  ];

  /** [privilege row, where it lands: a grid key and cell, or the also-holds sentence] */
  const CASES: Array<[string, Partial<DbPrivilege>, { cell: [string, string] } | { elsewhere: string }]> = [
    ['SELECT on a table', {}, { cell: ['app.table.orders', 'read'] }],
    ['SELECT on a view', { objectName: 'open_orders' }, { cell: ['app.view.open_orders', 'read'] }],
    ['EXECUTE on a procedure', { privilege: 'EXECUTE', objectType: 'PROCEDURE', objectName: 'close_day' }, { cell: ['app.procedure.close_day', 'execute-procedure'] }],
    ['EXECUTE on a function', { privilege: 'EXECUTE', objectType: 'FUNCTION', objectName: 'tax' }, { cell: ['app.function.tax', 'execute-function'] }],
    ['EXECUTE on a ROUTINE (Postgres)', { privilege: 'EXECUTE', objectType: 'ROUTINE', objectName: 'tax' }, { cell: ['app.function.tax', 'execute-function'] }],
    ['EXECUTE reported as an object (SQL Server, Oracle)', { privilege: 'EXECUTE', objectType: 'TABLE', objectName: 'close_day' }, { cell: ['app.procedure.close_day', 'execute-procedure'] }],
    ['CONNECT on the database', { privilege: 'CONNECT', objectType: 'DATABASE', objectSchema: null, objectName: 'shop' }, { elsewhere: 'CONNECT on database shop' }],
    ['a database authority with no name (Db2)', { privilege: 'CONNECT', objectType: 'DATABASE', objectSchema: null, objectName: null }, { elsewhere: 'CONNECT on the database' }],
    ['USAGE on a schema', { privilege: 'USAGE', objectType: 'SCHEMA', objectSchema: 'app', objectName: null }, { elsewhere: 'USAGE on schema app' }],
    ['an instance-wide grant', { privilege: 'PROCESS', objectType: 'GLOBAL', objectSchema: null, objectName: null }, { elsewhere: 'PROCESS (server-wide)' }],
    ['a system privilege', { privilege: 'CREATE SESSION', objectType: 'SYSTEM', objectSchema: null, objectName: null }, { elsewhere: 'CREATE SESSION (server-wide)' }],
    ['a role membership', { privilege: 'reader', objectType: 'ROLE', objectSchema: null, objectName: 'reader' }, { elsewhere: 'member of reader' }],
    ['a grant on an object that is not a row', { objectName: 'audit_log' }, { elsewhere: 'SELECT on app.audit_log' }],
    ['a privilege no column shows', { privilege: 'VIEW DEFINITION' }, { elsewhere: 'VIEW DEFINITION on app.orders' }],
    ['EXECUTE on a table (no such cell)', { privilege: 'EXECUTE' }, { elsewhere: 'EXECUTE on app.orders' }],
    // DENY is never "held", even on a row the grid shows.
    ['DENY on a table', { state: 'deny' }, { elsewhere: 'DENY SELECT on app.orders' }],
    ['DENY EXECUTE on a procedure', { privilege: 'EXECUTE', objectType: 'PROCEDURE', objectName: 'close_day', state: 'deny' }, { elsewhere: 'DENY EXECUTE on app.close_day' }],
  ];

  for (const [label, over, where] of CASES) {
    it(label, () => {
      const p = priv(over);
      const { held, elsewhere } = splitHeldPrivileges([p], objects, 'postgres', 'app');
      if ('cell' in where) {
        const [key, cell] = where.cell;
        expect(held.get(key)).toEqual([cell]);
        expect(elsewhere).toEqual([]);
      } else {
        expect(held.size).toBe(0);
        expect(elsewhere).toEqual([p]);
        expect(describeHeldPrivilege(p)).toBe(where.elsewhere);
      }
    });
  }
});
