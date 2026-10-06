import { describe, expect, it } from 'vitest';
import { parseSqlSubset, subsetValue } from '@foxschema/ui-shared';
import { buildPeekDelete, buildPeekInsert, buildPeekUpdate } from '@/features/sql-editor/lib/rowDml';

/**
 * The viability test for MongoDB / Redis behind data migrate.
 *
 * The subset parser is only useful if it covers what this application actually
 * emits. Rather than assert that from reading rowDml.ts, generate with the real
 * builders — every dialect, every op — and require the parser to accept each
 * one and recover the same values. If a builder ever emits something richer,
 * this fails rather than the store silently mistranslating it.
 */

const DIALECTS = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlserver',
  'azuresql',
  'oracle',
  'db2',
  'sqlite',
  'cockroachdb',
  'yugabytedb',
  'redshift',
  'tidb',
];

const KEYS = [{ name: 'id', resultIndex: 0 }];
const COLUMNS = ['id', 'name', 'email'];

describe('the subset covers every statement data migrate emits', () => {
  it('INSERT, for every dialect', () => {
    for (const dialect of DIALECTS) {
      const built = buildPeekInsert({
        tableName: 'users',
        dialect,
        values: { id: 7, name: 'alice', email: 'a@example.com' },
      });
      expect('error' in built, dialect).toBe(false);
      if ('error' in built) continue;

      const parsed = parseSqlSubset(built.sql);
      expect(parsed.ok, `${dialect}: ${built.sql}`).toBe(true);
      if (!parsed.ok || parsed.intent.kind !== 'insert') continue;

      expect(parsed.intent.table, dialect).toBe('users');
      const values = parsed.intent.assignments.map((a) => ({
        column: a.column,
        value: subsetValue(a.value, built.params),
      }));
      expect(values, dialect).toEqual([
        { column: 'id', value: 7 },
        { column: 'name', value: 'alice' },
        { column: 'email', value: 'a@example.com' },
      ]);
    }
  });

  it('UPDATE, for every dialect', () => {
    for (const dialect of DIALECTS) {
      const built = buildPeekUpdate({
        tableName: 'users',
        dialect,
        columns: COLUMNS,
        originalRow: [7, 'old', 'old@example.com'],
        draftRow: [7, 'new', 'new@example.com'],
        keyColumns: KEYS,
      });
      expect('error' in built, dialect).toBe(false);
      if ('error' in built) continue;

      const parsed = parseSqlSubset(built.sql);
      expect(parsed.ok, `${dialect}: ${built.sql}`).toBe(true);
      if (!parsed.ok || parsed.intent.kind !== 'update') continue;

      // Only changed columns are set, and the key identifies the row.
      expect(parsed.intent.set.map((s) => s.column), dialect).toEqual(['name', 'email']);
      expect(parsed.intent.set.map((s) => subsetValue(s.value, built.params)), dialect).toEqual([
        'new',
        'new@example.com',
      ]);
      expect(parsed.intent.where.map((w) => w.column), dialect).toEqual(['id']);
      expect(subsetValue(parsed.intent.where[0]!.value, built.params), dialect).toBe(7);
    }
  });

  it('DELETE, for every dialect', () => {
    for (const dialect of DIALECTS) {
      const built = buildPeekDelete({
        tableName: 'users',
        dialect,
        columns: COLUMNS,
        row: [7, 'alice', 'a@example.com'],
        keyColumns: KEYS,
      });
      expect('error' in built, dialect).toBe(false);
      if ('error' in built) continue;

      const parsed = parseSqlSubset(built.sql);
      expect(parsed.ok, `${dialect}: ${built.sql}`).toBe(true);
      if (!parsed.ok || parsed.intent.kind !== 'delete') continue;

      expect(parsed.intent.where.map((w) => w.column), dialect).toEqual(['id']);
      expect(subsetValue(parsed.intent.where[0]!.value, built.params), dialect).toBe(7);
    }
  });

  it('composite keys survive the round trip', () => {
    const keys = [
      { name: 'tenant', resultIndex: 0 },
      { name: 'id', resultIndex: 1 },
    ];
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'oracle']) {
      const built = buildPeekDelete({
        tableName: 'orders',
        dialect,
        columns: ['tenant', 'id', 'total'],
        row: ['acme', 99, 12.5],
        keyColumns: keys,
      });
      if ('error' in built) throw new Error(`${dialect}: ${built.error}`);
      const parsed = parseSqlSubset(built.sql);
      expect(parsed.ok, dialect).toBe(true);
      if (!parsed.ok || parsed.intent.kind !== 'delete') continue;
      expect(parsed.intent.where.map((w) => w.column), dialect).toEqual(['tenant', 'id']);
      expect(
        parsed.intent.where.map((w) => subsetValue(w.value, built.params)),
        dialect
      ).toEqual(['acme', 99]);
    }
  });

  it('values that would break a string-built query still round-trip', () => {
    // The reason everything is bound: this value ends a literal if inlined.
    const built = buildPeekInsert({
      tableName: 'users',
      dialect: 'postgres',
      values: { id: 1, name: "O'Brien; DROP TABLE users--" },
    });
    if ('error' in built) throw new Error(built.error);
    const parsed = parseSqlSubset(built.sql);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.intent.kind !== 'insert') return;
    expect(subsetValue(parsed.intent.assignments[1]!.value, built.params)).toBe(
      "O'Brien; DROP TABLE users--"
    );
  });
});
