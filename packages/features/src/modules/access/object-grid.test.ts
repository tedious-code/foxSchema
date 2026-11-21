/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The grid's job is to stop the UI offering privileges an engine cannot grant,
 * and to turn what was ticked into the narrowest SQL that expresses it.
 *
 * Two failure modes matter more than the rest. A cell offered where the engine
 * has no GRANT for it produces SQL that fails at the database, after the UI said
 * it would work. And a request compiled to a broader scope than the reader
 * ticked grants access nobody asked for — the worst outcome a permissions tool
 * can have, because it looks like success.
 */
import { describe, expect, it } from 'vitest';
import { buildAccessSql } from './access-sql';
import {
  cellSupport,
  compileObjectGrid,
  expandToInstance,
  qualifyDatabaseSql,
  gridColumnsFor,
  prunedPermissions,
  type GridRow,
} from './object-grid';
import type { PermissionRequest } from './intent';

const user = { type: 'user' as const, name: 'report_user' };

const compile = (rows: GridRow[], dialect: string): PermissionRequest[] =>
  compileObjectGrid(rows, { dialect, principal: user, action: 'grant', schema: 'app' });

const sqlFor = (req: PermissionRequest, dialect: string): string => {
  const r = buildAccessSql(req, dialect);
  if ('error' in r) throw new Error(`${dialect}: ${r.error}`);
  return r.statements.map((s) => s.sql).join('\n');
};

describe('which cells an engine can express', () => {
  it('refuses ALTER and DROP on a PostgreSQL table, because they are ownership', () => {
    // This is the case that makes a per-dialect table necessary rather than a
    // uniform grid: there is no GRANT in PostgreSQL that confers either.
    expect(cellSupport('postgres', 'table', 'alter-object').available).toBe(false);
    expect(cellSupport('postgres', 'table', 'drop-object').available).toBe(false);
    expect(cellSupport('postgres', 'table', 'alter-object').reason).toMatch(/owning it/i);
  });

  it('allows both on a MySQL table, where they are real privileges', () => {
    expect(cellSupport('mysql', 'table', 'alter-object').available).toBe(true);
    expect(cellSupport('mysql', 'table', 'drop-object').available).toBe(true);
  });

  it('treats MariaDB like MySQL', () => {
    // accessFamily() keeps MariaDB distinct, so a missing entry would silently
    // report every MariaDB cell as unsupported.
    expect(cellSupport('mariadb', 'table', 'drop-object').available).toBe(true);
    expect(cellSupport('mariadb', 'table', 'index-object').available).toBe(true);
  });

  it('allows ALTER but not DROP where only ALTER exists per object', () => {
    for (const dialect of ['sqlserver', 'oracle', 'db2']) {
      expect(cellSupport(dialect, 'table', 'alter-object').available).toBe(true);
      expect(cellSupport(dialect, 'table', 'drop-object').available).toBe(false);
    }
  });

  it('follows the dialect aliases', () => {
    // Azure SQL is SQL Server; CockroachDB is Postgres-wire.
    expect(cellSupport('azuresql', 'table', 'alter-object').available).toBe(true);
    expect(cellSupport('cockroachdb', 'table', 'alter-object').available).toBe(false);
  });

  it('says so plainly for an engine with no object GRANT model at all', () => {
    const support = cellSupport('sqlite', 'table', 'read');
    expect(support.available).toBe(false);
    expect(support.reason).toMatch(/no GRANT model/i);
  });

  it('always gives a reason with an unavailable cell', () => {
    // The reason is the whole point of drawing a disabled checkbox instead of
    // hiding it: a missing control teaches the reader nothing.
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'oracle', 'db2', 'sqlite']) {
      for (const kind of ['table', 'view', 'procedure', 'function'] as const) {
        for (const { permission, support } of gridColumnsFor(dialect, kind)) {
          if (!support.available) {
            expect(support.reason, `${dialect}/${kind}/${permission}`).not.toBe('');
          }
        }
      }
    }
  });

  it('offers no CREATE column on any object row', () => {
    // CREATE cannot be granted on a named object: it does not exist yet.
    for (const kind of ['table', 'view', 'procedure', 'function'] as const) {
      const cols = gridColumnsFor('mysql', kind).map((c) => c.permission);
      expect(cols).not.toContain('create-object');
    }
  });
});

describe('compiling a grid into requests', () => {
  it('collapses rows that share a privilege set into one statement', () => {
    const requests = compile(
      [
        { kind: 'table', name: 'orders', permissions: ['read'] },
        { kind: 'table', name: 'customers', permissions: ['read'] },
        { kind: 'table', name: 'audit', permissions: ['read', 'insert'] },
      ],
      'postgres'
    );
    expect(requests).toHaveLength(2);
    const readOnly = requests.find((r) => r.permissions.length === 1)!;
    expect(readOnly.scope).toMatchObject({ type: 'tables', tables: ['orders', 'customers'] });
  });

  it('does not merge rows of different kinds even with identical privileges', () => {
    // A procedure and a table both ticked for ALTER are different statements;
    // merging them would name a routine in a table grant.
    const requests = compile(
      [
        { kind: 'table', name: 'orders', permissions: ['alter-object'] },
        { kind: 'procedure', name: 'reprice', permissions: ['alter-object'] },
      ],
      'mysql'
    );
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.scope.type).sort()).toEqual(['routines', 'tables']);
  });

  it('does not merge across schemas', () => {
    const requests = compile(
      [
        { kind: 'table', name: 'orders', schema: 'sales', permissions: ['read'] },
        { kind: 'table', name: 'orders', schema: 'archive', permissions: ['read'] },
      ],
      'postgres'
    );
    expect(requests).toHaveLength(2);
  });

  it('drops ticks the engine cannot express rather than emitting them', () => {
    const requests = compile(
      [{ kind: 'table', name: 'orders', permissions: ['read', 'drop-object'] }],
      'postgres'
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.permissions).toEqual(['read']);
  });

  it('drops a row whose every tick is unavailable, instead of an empty GRANT', () => {
    const requests = compile(
      [{ kind: 'table', name: 'orders', permissions: ['drop-object'] }],
      'postgres'
    );
    expect(requests).toEqual([]);
  });

  it('ignores blank names and rows with nothing ticked', () => {
    const requests = compile(
      [
        { kind: 'table', name: '   ', permissions: ['read'] },
        { kind: 'table', name: 'orders', permissions: [] },
      ],
      'postgres'
    );
    expect(requests).toEqual([]);
  });

  it('lists a repeated object once', () => {
    // `ON a, a` is an error in some engines and confusing in all of them.
    const requests = compile(
      [
        { kind: 'table', name: 'orders', permissions: ['read'] },
        { kind: 'table', name: 'orders', permissions: ['read'] },
      ],
      'postgres'
    );
    expect(requests[0]!.scope).toMatchObject({ tables: ['orders'] });
  });

  it('groups the same way however the ticks were ordered', () => {
    const a = compile([{ kind: 'table', name: 'x', permissions: ['read', 'insert'] }], 'postgres');
    const b = compile([{ kind: 'table', name: 'x', permissions: ['insert', 'read'] }], 'postgres');
    expect(a[0]!.scope).toEqual(b[0]!.scope);
  });

  it('falls back to the builder schema when a row carries none', () => {
    const requests = compile([{ kind: 'table', name: 'orders', permissions: ['read'] }], 'postgres');
    expect(requests[0]!.scope).toMatchObject({ schema: 'app' });
  });
});

describe('the compiled SQL is no broader than what was ticked', () => {
  // Every one of these engines previously had no routines branch, so an
  // EXECUTE tick on two procedures fell through to a schema- or database-wide
  // grant. The SQL looked plausible and granted far more than was asked.
  const twoProcedures: GridRow[] = [
    { kind: 'procedure', name: 'reprice', permissions: ['execute-procedure'] },
    { kind: 'procedure', name: 'rebill', permissions: ['execute-procedure'] },
  ];

  it.each(['postgres', 'mysql', 'sqlserver', 'oracle', 'db2'])(
    'names each routine on %s instead of granting schema-wide',
    (dialect) => {
      const requests = compile(twoProcedures, dialect);
      expect(requests).toHaveLength(1);
      const sql = sqlFor(requests[0]!, dialect);

      expect(sql).toMatch(/reprice/);
      expect(sql).toMatch(/rebill/);
      // The exact shapes that used to appear instead.
      expect(sql).not.toMatch(/ALL ROUTINES/i);
      expect(sql).not.toMatch(/\.\*/);
    }
  );

  it('uses ALTER ROUTINE on a MySQL routine, not the table ALTER', () => {
    const requests = compile(
      [{ kind: 'procedure', name: 'reprice', permissions: ['execute-procedure', 'alter-object'] }],
      'mysql'
    );
    const sql = sqlFor(requests[0]!, 'mysql');
    expect(sql).toMatch(/ALTER ROUTINE/);
    expect(sql).toMatch(/ON PROCEDURE `app`\.`reprice`/);
  });

  it('names PROCEDURE and FUNCTION apart where the engine requires it', () => {
    const requests = compile(
      [
        { kind: 'procedure', name: 'reprice', permissions: ['execute-procedure'] },
        { kind: 'function', name: 'net_total', permissions: ['execute-function'] },
      ],
      'postgres'
    );
    const sql = requests.map((r) => sqlFor(r, 'postgres')).join('\n');
    expect(sql).toMatch(/ON PROCEDURE "app"\."reprice"/);
    expect(sql).toMatch(/ON FUNCTION "app"\."net_total"/);
  });

  it('emits the per-object privileges the engine does have', () => {
    const requests = compile(
      [{ kind: 'table', name: 'orders', permissions: ['read', 'index-object', 'drop-object'] }],
      'mysql'
    );
    const sql = sqlFor(requests[0]!, 'mysql');
    expect(sql).toMatch(/SELECT/);
    expect(sql).toMatch(/INDEX/);
    expect(sql).toMatch(/DROP/);
    expect(sql).toMatch(/ON `app`\.`orders`/);
  });

  it('grants TRIGGER on PostgreSQL but never INDEX', () => {
    // PostgreSQL has a TRIGGER privilege and no INDEX one; the pair is a good
    // check that the table is read per privilege rather than per engine.
    expect(cellSupport('postgres', 'table', 'trigger-object').available).toBe(true);
    expect(cellSupport('postgres', 'table', 'index-object').available).toBe(false);
    const requests = compile(
      [{ kind: 'table', name: 'orders', permissions: ['trigger-object', 'index-object'] }],
      'postgres'
    );
    const sql = sqlFor(requests[0]!, 'postgres');
    expect(sql).toMatch(/TRIGGER/);
    expect(sql).not.toMatch(/INDEX/);
  });
});

describe('prunedPermissions', () => {
  it('keeps only what the engine can grant on that kind', () => {
    expect(prunedPermissions('postgres', 'table', ['read', 'alter-object'])).toEqual(['read']);
    expect(prunedPermissions('mysql', 'table', ['read', 'alter-object'])).toEqual([
      'read',
      'alter-object',
    ]);
  });
});

describe('instance scope', () => {
  const base: PermissionRequest = {
    principal: user,
    action: 'grant',
    permissions: ['read'],
    scope: { type: 'database', database: 'app' },
  };

  it('repeats the grant once per database on the connection', () => {
    const out = expandToInstance(base, ['app', 'reporting', 'archive']);
    expect(out).toHaveLength(3);
    expect(out.map((r) => (r.scope as { database: string }).database)).toEqual([
      'app',
      'reporting',
      'archive',
    ]);
    // The rest of the request must survive the fan-out unchanged.
    expect(out.every((r) => r.permissions.includes('read'))).toBe(true);
  });

  it('leaves the request alone when no databases are known', () => {
    // Better one statement the reader can edit than none at all.
    expect(expandToInstance(base, [])).toEqual([base]);
    expect(expandToInstance(base, ['  '])).toEqual([base]);
  });

  it('keeps one Db2 CONNECT per database after qualification', () => {
    const reqs = expandToInstance(
      { ...base, permissions: ['connect'] },
      ['app', 'reporting']
    );
    const sqls = reqs.map((r) => {
      const built = buildAccessSql(r, 'db2');
      if ('error' in built) throw new Error(built.error);
      return qualifyDatabaseSql(built.statements[0]!.sql, r.scope);
    });
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).not.toBe(sqls[1]);
    expect(sqls.join('\n')).toMatch(/run in app/);
    expect(sqls.join('\n')).toMatch(/run in reporting/);
  });
});

describe('qualifyDatabaseSql', () => {
  it('leaves SQL that already names the database', () => {
    const sql = 'GRANT CONNECT ON DATABASE app TO report_user;';
    expect(qualifyDatabaseSql(sql, { type: 'database', database: 'app' })).toBe(sql);
  });

  it('annotates SQL that does not name the database', () => {
    // Db2 and SQL Server GRANT CONNECT against the current database.
    const sql = 'GRANT CONNECT ON DATABASE TO USER REPORT_USER;';
    expect(qualifyDatabaseSql(sql, { type: 'database', database: 'reporting' })).toBe(
      `-- run in reporting\n${sql}`
    );
  });

  it('does not annotate table or schema grants', () => {
    const sql = 'GRANT SELECT ON app.orders TO report_user;';
    expect(qualifyDatabaseSql(sql, { type: 'schema', schema: 'app' })).toBe(sql);
  });
});
