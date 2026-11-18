/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  assessPeekEditability,
  buildPeekDelete,
  buildPeekInsert,
  buildPeekUpdate,
  draftToArray,
  originalRowForPeekEdit,
  firstCaseFoldedDuplicate,
  resolvePeekKeyColumns,
} from '@/features/sql-editor/lib/rowDml';
import type { TableSchema } from '@/shared/lib/types';

const usersTable: TableSchema = {
  name: 'public.users',
  objectType: 'TABLE',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true, identity: true },
    { name: 'email', type: 'text', nullable: false, primaryKey: false },
    { name: 'name', type: 'text', nullable: true, primaryKey: false },
  ],
  indices: [],
  foreignKeys: [],
  primaryKey: { columns: ['id'] },
};

describe('rowDml', () => {
  it('assesses editability from PK + result columns', () => {
    const ok = assessPeekEditability({
      dialect: 'postgres',
      table: usersTable,
      resultColumns: ['id', 'email', 'name'],
    });
    expect(ok.editable).toBe(true);
    expect(ok.keyColumns.map((k) => k.name)).toEqual(['id']);

    expect(
      assessPeekEditability({
        dialect: 'clickhouse',
        table: usersTable,
        resultColumns: ['id', 'email'],
      }).editable
    ).toBe(false);

    expect(
      assessPeekEditability({
        dialect: 'postgres',
        table: { ...usersTable, objectType: 'VIEW', primaryKey: undefined, columns: usersTable.columns.map((c) => ({ ...c, primaryKey: false })) },
        resultColumns: ['id', 'email'],
      }).editable
    ).toBe(false);
  });

  it('refuses to edit a result whose columns differ only by case', () => {
    // Postgres and Db2 both allow "ID" next to "id". Column lookup folds case,
    // so the key column would read its value from whichever came last and the
    // WHERE clause could match a different row.
    const ambiguous = assessPeekEditability({
      dialect: 'postgres',
      table: usersTable,
      resultColumns: ['ID', 'email', 'id'],
    });
    expect(ambiguous.editable).toBe(false);
    expect(ambiguous.reason).toMatch(/differing only by case/i);
    expect(firstCaseFoldedDuplicate(['a', 'B', 'b'])).toBe('b');
    expect(firstCaseFoldedDuplicate(['a', 'b'])).toBeNull();
  });

  it('refuses to edit when a binary/blob column is in the result', () => {
    // /sql/execute shows BYTEA as 0x… hex (and truncates long values). Clone
    // would INSERT that ASCII string and corrupt the column.
    const withBlob: TableSchema = {
      ...usersTable,
      columns: [
        ...usersTable.columns,
        { name: 'avatar', type: 'bytea', nullable: true, primaryKey: false },
      ],
    };
    const blocked = assessPeekEditability({
      dialect: 'postgres',
      table: withBlob,
      resultColumns: ['id', 'email', 'avatar'],
    });
    expect(blocked.editable).toBe(false);
    expect(blocked.reason).toMatch(/binary/i);
  });

  
  it('limits UPDATE SET to onlyColumns', () => {
    const keys = resolvePeekKeyColumns(usersTable, ['id', 'email', 'name']);
    const plan = buildPeekUpdate({
      tableName: 'public.users',
      dialect: 'postgres',
      columns: ['id', 'email', 'name'],
      originalRow: [1, 'a@x.com', 'Ada'],
      draftRow: [1, 'changed@x.com', 'Ada Lovelace'],
      keyColumns: keys,
      onlyColumns: ['name'],
    });
    expect('error' in plan).toBe(false);
    if ('error' in plan) return;
    expect(plan.sql).toMatch(/"name"\s*=/i);
    expect(plan.sql).not.toMatch(/"email"\s*=/i);
    expect(plan.params).toEqual(['Ada Lovelace', 1]);
  });

  it('builds UPDATE with bound params', () => {
    const keys = resolvePeekKeyColumns(usersTable, ['id', 'email', 'name']);
    const plan = buildPeekUpdate({
      tableName: 'public.users',
      dialect: 'postgres',
      columns: ['id', 'email', 'name'],
      originalRow: [1, 'a@x.com', 'Ada'],
      draftRow: [1, 'a@x.com', 'Ada Lovelace'],
      keyColumns: keys,
    });
    expect('error' in plan).toBe(false);
    if ('error' in plan) return;
    expect(plan.kind).toBe('update');
    expect(plan.sql).toMatch(/UPDATE/i);
    expect(plan.sql).toMatch(/"name"\s*=\s*\$1/i);
    expect(plan.sql).toMatch(/"id"\s*=\s*\$2/i);
    expect(plan.params).toEqual(['Ada Lovelace', 1]);
  });

  it('builds INSERT and DELETE', () => {
    const insert = buildPeekInsert({
      tableName: 'public.users',
      dialect: 'postgres',
      values: { email: 'b@x.com', name: 'Bob' },
      identityColumns: new Set(['id']),
    });
    expect('error' in insert).toBe(false);
    if ('error' in insert) return;
    expect(insert.sql).toMatch(/INSERT INTO/i);
    expect(insert.params).toEqual(['b@x.com', 'Bob']);

    const keys = resolvePeekKeyColumns(usersTable, ['id', 'email', 'name']);
    const del = buildPeekDelete({
      tableName: 'public.users',
      dialect: 'postgres',
      columns: ['id', 'email', 'name'],
      row: [7, 'c@x.com', 'Cy'],
      keyColumns: keys,
    });
    expect('error' in del).toBe(false);
    if ('error' in del) return;
    expect(del.sql).toMatch(/DELETE FROM/i);
    expect(del.params).toEqual([7]);
  });

  it('draftToArray preserves numeric types from original', () => {
    expect(draftToArray(['id', 'email'], { id: '3', email: 'x' }, [1, 'a'])).toEqual([3, 'x']);
  });

  it('draftToArray does not Number()-corrupt integers past MAX_SAFE_INTEGER', () => {
    // Driver handed back a small number; user edits to a 64-bit value that JS
    // cannot represent precisely as Number.
    expect(
      draftToArray(['qty'], { qty: '9007199254740993' }, [1])
    ).toEqual(['9007199254740993']);
    // Safe integers still coerce to number so drivers keep typed binds.
    expect(draftToArray(['qty'], { qty: '42' }, [1])).toEqual([42]);
  });

  it('originalRowForPeekEdit prefers the edit-open snapshot over a reshuffled grid', () => {
    const snapshot = [1, 'a@x.com', 'Ada'];
    const liveRows = [
      [2, 'b@x.com', 'Bob'],
      [1, 'a@x.com', 'Ada'],
    ];
    expect(
      originalRowForPeekEdit({ originalRow: snapshot, rowIndex: 0 }, liveRows)
    ).toBe(snapshot);

    const keys = resolvePeekKeyColumns(usersTable, ['id', 'email', 'name']);
    const plan = buildPeekUpdate({
      tableName: 'public.users',
      dialect: 'postgres',
      columns: ['id', 'email', 'name'],
      originalRow: originalRowForPeekEdit({ originalRow: snapshot, rowIndex: 0 }, liveRows)!,
      draftRow: [1, 'a@x.com', 'Ada Lovelace'],
      keyColumns: keys,
    });
    expect('error' in plan).toBe(false);
    if ('error' in plan) return;
    // WHERE must keep id=1 (snapshot), not id=2 now sitting at rowIndex 0.
    expect(plan.params).toEqual(['Ada Lovelace', 1]);
  });

  it('rejects NULL key values for UPDATE/DELETE', () => {
    const keys = resolvePeekKeyColumns(usersTable, ['id', 'email', 'name']);
    const del = buildPeekDelete({
      tableName: 'public.users',
      dialect: 'postgres',
      columns: ['id', 'email', 'name'],
      row: [null, 'c@x.com', 'Cy'],
      keyColumns: keys,
    });
    expect(del).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/NULL/i) })
    );

    const upd = buildPeekUpdate({
      tableName: 'public.users',
      dialect: 'postgres',
      columns: ['id', 'email', 'name'],
      originalRow: [undefined, 'a@x.com', 'Ada'],
      draftRow: [undefined, 'a@x.com', 'Ada Lovelace'],
      keyColumns: keys,
    });
    expect(upd).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/NULL/i) })
    );
  });

  it('skips partial and nullable unique indexes for row identity', () => {
    const noPk: TableSchema = {
      ...usersTable,
      primaryKey: undefined,
      columns: [
        { name: 'id', type: 'integer', nullable: true, primaryKey: false },
        { name: 'email', type: 'text', nullable: false, primaryKey: false },
        { name: 'name', type: 'text', nullable: true, primaryKey: false },
      ],
      indices: [
        {
          name: 'uq_email_live',
          columns: ['email'],
          unique: true,
          filter: 'deleted_at IS NULL',
        },
        {
          name: 'uq_id_nullable',
          columns: ['id'],
          unique: true,
        },
      ],
    };
    expect(resolvePeekKeyColumns(noPk, ['id', 'email', 'name'])).toEqual([]);
    expect(
      assessPeekEditability({
        dialect: 'postgres',
        table: noPk,
        resultColumns: ['id', 'email', 'name'],
      }).editable
    ).toBe(false);

    const solidUnique: TableSchema = {
      ...noPk,
      indices: [{ name: 'uq_email', columns: ['email'], unique: true }],
    };
    expect(resolvePeekKeyColumns(solidUnique, ['id', 'email', 'name']).map((k) => k.name)).toEqual([
      'email',
    ]);
  });

  describe('buildPeekInsert', () => {
    it('binds for the run, and writes values in only for copying', () => {
      const plan = buildPeekInsert({
        tableName: 'public.users',
        dialect: 'postgres',
        values: { id: 1, email: "o'reilly@test.com", name: 'User 1' },
      });
      expect('error' in plan).toBe(false);
      if ('error' in plan) return;
      expect(plan.kind).toBe('insert');
      expect(plan.sql).toBe('INSERT INTO "public"."users" ("id", "email", "name") VALUES ($1, $2, $3)');
      expect(plan.params).toEqual([1, "o'reilly@test.com", 'User 1']);
      expect(plan.literalSql).toBe(
        'INSERT INTO "public"."users" ("id", "email", "name") VALUES (1, \'o\'\'reilly@test.com\', \'User 1\')'
      );
    });

    it('keeps row values out of displaySql, which the Recent list and migrate record store', () => {
      const plan = buildPeekInsert({ tableName: 'public.users', dialect: 'postgres', values: { ssn: '123-45-6789' } });
      if ('error' in plan) throw new Error(plan.error);
      expect(plan.displaySql).toBe(plan.sql);
      expect(plan.displaySql).not.toContain('123-45-6789');
      // Data migrate appends its own `;` to each statement.
      expect(plan.displaySql.endsWith(';')).toBe(false);
    });

    it('writes literals each engine reads back as the same value', () => {
      const mysql = buildPeekInsert({ tableName: 'files', dialect: 'mysql', values: { path: 'C:\\temp\\' } });
      if ('error' in mysql) throw new Error(mysql.error);
      expect(mysql.literalSql).toBe("INSERT INTO `files` (`path`) VALUES ('C:\\\\temp\\\\')");

      const mssql = buildPeekInsert({
        tableName: 'dbo.people',
        dialect: 'sqlserver',
        values: { active: true, name: 'Zo\u00eb' },
      });
      if ('error' in mssql) throw new Error(mssql.error);
      expect(mssql.literalSql).toBe("INSERT INTO [dbo].[people] ([active], [name]) VALUES (1, N'Zo\u00eb')");
    });
  });
});
