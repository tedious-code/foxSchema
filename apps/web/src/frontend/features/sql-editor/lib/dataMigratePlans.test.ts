/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  buildDataMigratePlans,
  buildDestSnapshotJson,
  buildRestorePlansFromSnapshot,
  isUsableDataMigrateSnapshot,
  snapshotTargetConnectionId,
} from '@/features/sql-editor/lib/dataMigratePlans';
import type { ClassifiedRowDiff } from '@/features/sql-editor/lib/resultRowDiff';
import { DIALECT_MAP, identityInsertFor } from '@foxschema/ui-shared';

const DEST_CONN = 'conn-dest-b';

function snapshotFor(ops: ClassifiedRowDiff[], cols = ['id', 'name']) {
  return buildDestSnapshotJson({
    tableName: 'customers',
    dialect: 'sqlite',
    connectionId: DEST_CONN,
    destColumns: cols,
    sourceColumns: cols,
    keyNames: ['id'],
    includeIdentity: true,
    ops,
  });
}

describe('buildDataMigratePlans', () => {
  const cols = ['id', 'name'];
  const ops: ClassifiedRowDiff[] = [
    { op: 'insert', keyLabel: 'id=3', sourceRow: [3, 'New'] },
    {
      op: 'update',
      keyLabel: 'id=1',
      sourceRow: [1, 'Alice'],
      destRow: [1, 'Bob'],
    },
    { op: 'delete', keyLabel: 'id=4', destRow: [4, 'Gone'] },
  ];

  it('builds insert/update/delete plans for sqlite', () => {
    const { plans, errors } = buildDataMigratePlans({
      tableName: 'customers',
      dialect: 'sqlite',
      sourceColumns: cols,
      destColumns: cols,
      keyNames: ['id'],
      ops,
      includeIdentity: true,
      identityColumns: new Set(['id']),
    });
    expect(errors).toEqual([]);
    expect(plans).toHaveLength(3);
    expect(plans[0]!.plan.kind).toBe('insert');
    expect(plans[0]!.plan.sql.toLowerCase()).toContain('insert into');
    expect(plans[1]!.plan.kind).toBe('update');
    expect(plans[1]!.plan.sql.toLowerCase()).toContain('update');
    expect(plans[2]!.plan.kind).toBe('delete');
    expect(plans[2]!.plan.sql.toLowerCase()).toContain('delete from');
  });

  it('snapshots dest rows for update/delete and source rows for insert', () => {
    const json = snapshotFor(ops);
    const parsed = JSON.parse(json) as {
      rows: Array<{ _op: string }>;
      includeIdentity: boolean;
      connectionId: string;
    };
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows.map((r) => r._op).sort()).toEqual(['delete', 'insert', 'update']);
    expect(parsed.includeIdentity).toBe(true);
    expect(parsed.connectionId).toBe(DEST_CONN);
  });

  it('omits identity columns from INSERT when includeIdentity is false', () => {
    const { plans, errors } = buildDataMigratePlans({
      tableName: 'customers',
      dialect: 'sqlite',
      sourceColumns: cols,
      destColumns: cols,
      keyNames: ['id'],
      ops: [{ op: 'insert', keyLabel: 'id=3', sourceRow: [3, 'New'] }],
      includeIdentity: false,
      identityColumns: new Set(['id']),
    });
    expect(errors).toEqual([]);
    expect(plans).toHaveLength(1);
    const sql = plans[0]!.plan.sql.toLowerCase();
    expect(sql).toContain('insert');
    expect(sql).toContain('name');
    // Must not bind/preserve the source id when Include identity is off.
    expect(sql).not.toMatch(/\bid\b/);
    expect(plans[0]!.plan.params).toEqual(['New']);
  });

  it('omits ignored trigger columns from INSERT and UPDATE SQL', () => {
    const auditCols = ['id', 'name', 'createdAt', 'updatedBy'];
    const auditOps: ClassifiedRowDiff[] = [
      {
        op: 'insert',
        keyLabel: 'id=9',
        sourceRow: [9, 'New', '2020-01-01', 'src'],
      },
      {
        op: 'update',
        keyLabel: 'id=1',
        sourceRow: [1, 'Alice', '2020-01-01', 'src'],
        destRow: [1, 'Bob', '2024-01-01', 'dst'],
      },
    ];
    const { plans, errors } = buildDataMigratePlans({
      tableName: 'customers',
      dialect: 'sqlite',
      sourceColumns: auditCols,
      destColumns: auditCols,
      keyNames: ['id'],
      ops: auditOps,
      includeIdentity: true,
      identityColumns: new Set(['id']),
      ignoreColumns: ['createdAt', 'updatedBy'],
    });
    expect(errors).toEqual([]);
    expect(plans).toHaveLength(2);
    const insertSql = plans[0]!.plan.sql.toLowerCase();
    const updateSql = plans[1]!.plan.sql.toLowerCase();
    expect(insertSql).not.toContain('createdat');
    expect(insertSql).not.toContain('updatedby');
    expect(updateSql).not.toContain('createdat');
    expect(updateSql).not.toContain('updatedby');
    expect(insertSql).toContain('name');
    expect(updateSql).toContain('name');
  });
});

describe('buildRestorePlansFromSnapshot', () => {
  const cols = ['id', 'name'];
  const ops: ClassifiedRowDiff[] = [
    { op: 'insert', keyLabel: 'id=3', sourceRow: [3, 'New'] },
    {
      op: 'update',
      keyLabel: 'id=1',
      sourceRow: [1, 'Alice'],
      destRow: [1, 'Bob'],
    },
    { op: 'delete', keyLabel: 'id=4', destRow: [4, 'Gone'] },
  ];

  it('reverses successful insert/update/delete from Backup', () => {
    const snapshotJson = snapshotFor(ops);
    const { plans, errors } = buildRestorePlansFromSnapshot({
      snapshotJson,
      successfulOps: [
        { op: 'insert', key: 'id=3' },
        { op: 'update', key: 'id=1' },
        { op: 'delete', key: 'id=4' },
      ],
    });
    expect(errors).toEqual([]);
    expect(plans).toHaveLength(3);
    // Reverse order: delete→insert, update→update, insert→delete
    expect(plans.map((p) => p.op)).toEqual(['insert', 'update', 'delete']);
    expect(plans[0]!.plan.sql.toLowerCase()).toContain('insert');
    expect(plans[1]!.plan.sql.toLowerCase()).toContain('update');
    expect(plans[2]!.plan.sql.toLowerCase()).toContain('delete');
  });

  it('records the destination connection id for Restore binding', () => {
    const snapshotJson = snapshotFor(ops);
    expect(snapshotTargetConnectionId(snapshotJson)).toBe(DEST_CONN);
    expect(isUsableDataMigrateSnapshot(snapshotJson)).toBe(true);
  });

  it('rejects truncated / non-JSON History snapshots', () => {
    const bad = `${snapshotFor(ops).slice(0, 40)}\n… (truncated)`;
    expect(isUsableDataMigrateSnapshot(bad)).toBe(false);
    expect(snapshotTargetConnectionId(bad)).toBeUndefined();
  });

  it('skips insert restore when identity was not preserved', () => {
    const snapshotJson = buildDestSnapshotJson({
      tableName: 'customers',
      dialect: 'sqlite',
      connectionId: DEST_CONN,
      destColumns: cols,
      sourceColumns: cols,
      keyNames: ['id'],
      includeIdentity: false,
      ops: [{ op: 'insert', keyLabel: 'id=3', sourceRow: [3, 'New'] }],
    });
    const { plans, errors } = buildRestorePlansFromSnapshot({
      snapshotJson,
      successfulOps: [{ op: 'insert', key: 'id=3' }],
    });
    expect(plans).toHaveLength(0);
    expect(errors[0]).toMatch(/Include identity/i);
  });

  it('restores update to the pre-apply dest values', () => {
    const snapshotJson = snapshotFor([
      {
        op: 'update',
        keyLabel: 'id=1',
        sourceRow: [1, 'Alice'],
        destRow: [1, 'Bob'],
      },
    ]);
    const { plans, errors } = buildRestorePlansFromSnapshot({
      snapshotJson,
      successfulOps: [{ op: 'update', key: 'id=1' }],
    });
    expect(errors).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.op).toBe('update');
    // SET name back to Bob (pre-migrate dest), WHERE id = 1
    expect(plans[0]!.plan.params).toContain('Bob');
    expect(plans[0]!.plan.params).toContain(1);
    expect(plans[0]!.plan.sql.toLowerCase()).toMatch(/update.*set.*name/s);
  });

  it('re-inserts a deleted dest row on restore', () => {
    const snapshotJson = snapshotFor([
      { op: 'delete', keyLabel: 'id=4', destRow: [4, 'Gone'] },
    ]);
    const { plans, errors } = buildRestorePlansFromSnapshot({
      snapshotJson,
      successfulOps: [{ op: 'delete', key: 'id=4' }],
    });
    expect(errors).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.op).toBe('insert');
    expect(plans[0]!.plan.params).toEqual([4, 'Gone']);
  });

  it('ignores FAILED ops and reports missing snapshot rows', () => {
    const snapshotJson = snapshotFor([
      { op: 'delete', keyLabel: 'id=4', destRow: [4, 'Gone'] },
    ]);
    const { plans, errors } = buildRestorePlansFromSnapshot({
      snapshotJson,
      successfulOps: [
        { op: 'delete', key: 'id=4' },
        { op: 'update', key: 'id=missing' },
      ],
    });
    expect(plans).toHaveLength(1);
    expect(errors.some((e) => /no snapshot row/i.test(e))).toBe(true);
  });

  it('accepts legacy snapshots that only stored update/delete rows', () => {
    const legacy = JSON.stringify({
      columns: cols,
      rows: [{ _op: 'delete', _key: 'id=4', id: 4, name: 'Gone' }],
    });
    const { plans, errors } = buildRestorePlansFromSnapshot({
      snapshotJson: legacy,
      successfulOps: [{ op: 'delete', key: 'id=4' }],
      tableName: 'customers',
      dialect: 'sqlite',
    });
    expect(errors).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.op).toBe('insert');
    expect(snapshotTargetConnectionId(legacy)).toBeUndefined();
  });
});

describe('data migrate across every dialect', () => {
  // Data migrate always writes to the destination, so the destination dialect
  // decides everything: quoting, placeholders and what has to happen for an
  // explicit identity value to be accepted. These run the same rows against
  // every registered dialect so a new one cannot be added without an answer.
  const cols = ['id', 'name'];
  const ops: ClassifiedRowDiff[] = [
    { op: 'insert', keyLabel: 'id=3', sourceRow: [3, 'New'] },
    { op: 'update', keyLabel: 'id=1', sourceRow: [1, 'Alice'], destRow: [1, 'Bob'] },
    { op: 'delete', keyLabel: 'id=4', destRow: [4, 'Gone'] },
  ];

  const build = (dialect: string, includeIdentity: boolean, generation?: string) =>
    buildDataMigratePlans({
      tableName: 'customers',
      dialect,
      sourceColumns: cols,
      destColumns: cols,
      keyNames: ['id'],
      ops,
      includeIdentity,
      identityColumns: new Set(['id']),
      identityGeneration: generation,
    });

  const DIALECTS = Object.keys(DIALECT_MAP);

  it('has more than one dialect to check', () => {
    // Guards the it.each blocks below from silently checking nothing.
    expect(DIALECTS.length).toBeGreaterThanOrEqual(14);
  });

  it.each(DIALECTS)('%s builds all three ops with values bound', (dialect) => {
    const { plans, errors } = build(dialect, false);
    expect(errors, dialect).toEqual([]);
    expect(plans.map((p) => p.op), dialect).toEqual(['insert', 'update', 'delete']);
    for (const { plan } of plans) {
      // A row value reaching the statement as text would be an injection, and
      // would also break on any value containing a quote.
      expect(plan.sql, `${dialect} ${plan.kind}`).not.toContain("'Alice'");
      expect(plan.params.length, `${dialect} ${plan.kind}`).toBeGreaterThan(0);
    }
  });

  it.each(DIALECTS)('%s omits the identity column when identity is off', (dialect) => {
    const insert = build(dialect, false).plans.find((p) => p.op === 'insert')!;
    // The destination assigns the id, so the column must not be named at all —
    // sending it would preserve source ids against what the switch says.
    expect(insert.plan.sql.toLowerCase(), dialect).not.toMatch(/\bid\b/);
    expect(insert.plan.params, dialect).toEqual(['New']);
  });

  it.each(DIALECTS)('%s writes the identity column when identity is on', (dialect) => {
    const insert = build(dialect, true, 'ALWAYS').plans.find((p) => p.op === 'insert')!;
    expect(insert.plan.params, dialect).toEqual([3, 'New']);
  });

  it.each(['postgres', 'cockroachdb', 'yugabytedb'])(
    '%s carries the overriding clause in the statement itself',
    (dialect) => {
      const insert = build(dialect, true, 'ALWAYS').plans.find((p) => p.op === 'insert')!;
      expect(insert.plan.sql).toContain('OVERRIDING SYSTEM VALUE');
    }
  );

  it.each(['sqlserver', 'azuresql'])(
    '%s leaves the statement plain — the session is what changes',
    (dialect) => {
      // SET IDENTITY_INSERT is issued by the server around the ops, not folded
      // into the INSERT. If it ever appeared here it would be rejected by
      // /data-migrate/execute, which admits DML only.
      const insert = build(dialect, true, 'ALWAYS').plans.find((p) => p.op === 'insert')!;
      expect(insert.plan.sql).not.toMatch(/IDENTITY_INSERT/i);
      expect(insert.plan.sql).not.toContain('OVERRIDING');
      expect(identityInsertFor(dialect, 'ALWAYS').kind).toBe('toggle');
    }
  );

  it.each(['mysql', 'mariadb', 'tidb', 'sqlite', 'clickhouse', 'duckdb'])(
    '%s needs no ceremony at all',
    (dialect) => {
      const insert = build(dialect, true, 'ALWAYS').plans.find((p) => p.op === 'insert')!;
      expect(insert.plan.sql).not.toContain('OVERRIDING');
      expect(identityInsertFor(dialect, 'ALWAYS').kind).toBe('native');
    }
  );

  it.each(['db2', 'oracle', 'redshift'])(
    '%s cannot take an explicit identity value, and says why',
    (dialect) => {
      const support = identityInsertFor(dialect, 'ALWAYS');
      expect(support.kind).toBe('unsupported');
      // Shown to the user instead of a driver code, so it has to name a way out.
      expect(support.reason).toBeTruthy();
    }
  );

  it('treats a BY DEFAULT column as plain everywhere that has the concept', () => {
    for (const dialect of ['postgres', 'oracle', 'db2', 'cockroachdb', 'yugabytedb']) {
      expect(identityInsertFor(dialect, 'BY DEFAULT').kind, dialect).toBe('native');
    }
    const insert = build('postgres', true, 'BY DEFAULT').plans.find((p) => p.op === 'insert')!;
    expect(insert.plan.sql).not.toContain('OVERRIDING SYSTEM VALUE');
  });

  it('quotes and binds for the destination, not the source, across dialects', () => {
    // A cross-dialect migrate reads from one engine and writes to another. The
    // statements run on the destination, so both quoting and placeholder style
    // must be the destination's.
    const sqlserver = build('sqlserver', false).plans[0]!.plan.sql;
    expect(sqlserver).toContain('[customers]');
    // The SQL Server adapter binds @p0, @p1, …; a `?` there binds nothing.
    expect(sqlserver).toContain('@p0');

    const postgres = build('postgres', false).plans[0]!.plan.sql;
    expect(postgres).toContain('"customers"');
    expect(postgres).toContain('$1');

    const mysql = build('mysql', false).plans[0]!.plan.sql;
    expect(mysql).toContain('`customers`');

    const oracle = build('oracle', false).plans[0]!.plan.sql;
    expect(oracle).toContain('"customers"');
    expect(oracle).toContain(':1');
  });
});
