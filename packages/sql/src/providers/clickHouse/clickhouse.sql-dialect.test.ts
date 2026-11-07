import { describe, expect, it } from 'vitest';
import { clickHouseSqlDialect, parseClickHouseKeyList } from './clickhouse.sql-dialect.js';
import type { TableSchema } from '../../interfaces/index.js';

describe('parseClickHouseKeyList', () => {
  it('splits a comma-separated sorting key', () => {
    expect(parseClickHouseKeyList('id, created_at')).toEqual(['id', 'created_at']);
  });

  it('keeps a nested function as one expression', () => {
    expect(parseClickHouseKeyList('cityHash64(id, 1), created_at')).toEqual([
      'cityHash64(id, 1)',
      'created_at',
    ]);
  });

  it('unwraps a parenthesized catalog list', () => {
    expect(parseClickHouseKeyList('(id, created_at)')).toEqual(['id', 'created_at']);
    expect(parseClickHouseKeyList('(cityHash64(id), created_at)')).toEqual([
      'cityHash64(id)',
      'created_at',
    ]);
  });

  it('treats tuple() as a single expression', () => {
    expect(parseClickHouseKeyList('tuple()')).toEqual(['tuple()']);
  });

  it('returns empty for a blank catalog value', () => {
    expect(parseClickHouseKeyList('')).toEqual([]);
    expect(parseClickHouseKeyList(undefined)).toEqual([]);
  });
});

describe('clickHouseSqlDialect CREATE TABLE suffix', () => {
  const table = (over: Partial<TableSchema> = {}): TableSchema => ({
    name: 'coupons',
    objectType: 'TABLE',
    columns: [],
    indices: [],
    foreignKeys: [],
    ...over,
  });

  it('defaults to MergeTree ORDER BY the quoted key', () => {
    expect(clickHouseSqlDialect.createTableSuffix?.(table(), ['id'], [])).toBe(
      ' ENGINE = MergeTree ORDER BY id'
    );
  });

  it('wraps a composite ORDER BY', () => {
    expect(clickHouseSqlDialect.createTableSuffix?.(table({ engine: 'MergeTree' }), ['id', 'code'], [])).toBe(
      ' ENGINE = MergeTree ORDER BY (id, code)'
    );
  });

  it('uses tuple() when there is no key', () => {
    expect(clickHouseSqlDialect.createTableSuffix?.(table(), [], [])).toBe(
      ' ENGINE = MergeTree ORDER BY tuple()'
    );
  });

  it('does not inline a PRIMARY KEY constraint', () => {
    expect(clickHouseSqlDialect.inlinePrimaryKeyConstraint).toBe(false);
  });

  it('emits an engine PRIMARY KEY only when it differs from ORDER BY', () => {
    const t = table({
      primaryKey: { name: 'PRIMARY_KEY', columns: ['id'] },
      orderBy: ['id', 'code'],
    });
    expect(clickHouseSqlDialect.createTableSuffix?.(t, ['id', 'code'], ['id'])).toBe(
      ' ENGINE = MergeTree PRIMARY KEY id ORDER BY (id, code)'
    );
  });

  it('treats ENGINE = MergeTree as the same engine as MergeTree', () => {
    const src = table({ engine: 'ENGINE = MergeTree', orderBy: ['id'] });
    const tgt = table({ engine: 'MergeTree', orderBy: ['id'] });
    expect(clickHouseSqlDialect.engineChangeStatements?.('coupons', src, tgt)).toEqual([]);
  });
});
