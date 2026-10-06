import { describe, expect, it } from 'vitest';
import { isScriptableObject, objectSourceScript } from './objectSourceScript';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';
import type { TableSchema } from '@/shared/lib/types';

function view(partial: Partial<TableSchema> & Pick<TableSchema, 'name'>): TableSchema {
  const { name, ...rest } = partial;
  return {
    name,
    objectType: 'VIEW',
    columns: [],
    indexes: [],
    foreignKeys: [],
    ...rest,
  } as TableSchema;
}

function routine(
  partial: Partial<TableSchema> & Pick<TableSchema, 'name' | 'objectType' | 'definition'>
): TableSchema {
  return {
    columns: [],
    indexes: [],
    foreignKeys: [],
    ...partial,
  } as TableSchema;
}

describe('objectSourceScript', () => {
  it('marks VIEW / PROCEDURE / FUNCTION as scriptable', () => {
    expect(isScriptableObject('VIEW')).toBe(true);
    expect(isScriptableObject('PROCEDURE')).toBe(true);
    expect(isScriptableObject('FUNCTION')).toBe(true);
    expect(isScriptableObject('TABLE')).toBe(false);
    expect(isScriptableObject('MQT')).toBe(false);
  });

  it('returns definition for a view and ensures a trailing semicolon', async () => {
    const sql = await objectSourceScript(
      view({ name: 'v_orders', definition: 'CREATE VIEW v_orders AS SELECT 1 AS id' }),
      'postgres'
    );
    expect(sql).toContain('v_orders');
    expect(sql.trimEnd().endsWith(';')).toBe(true);
  });

  it('falls back when definition is missing', async () => {
    const sql = await objectSourceScript(view({ name: 'v_empty' }), 'postgres');
    expect(sql).toMatch(/No definition available/i);
    expect(sql).toContain('v_empty');
  });

  it('opens a procedure as a single editor cell (inner semicolons stay in the body)', async () => {
    const sql = await objectSourceScript(
      routine({
        name: 'bump_qty',
        objectType: 'PROCEDURE',
        definition: `CREATE PROCEDURE bump_qty()
BEGIN
  UPDATE items SET qty = qty + 1 WHERE id = 1;
  SELECT qty FROM items WHERE id = 1;
END`,
      }),
      'mysql'
    );
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.kind).toBe('sql');
    expect(stmts[0]!.text).toMatch(/CREATE\s+PROCEDURE/i);
    expect(stmts[0]!.text).toMatch(/UPDATE\s+items/i);
  });

  it('opens a function as a single editor cell', async () => {
    const sql = await objectSourceScript(
      routine({
        name: 'status_label',
        objectType: 'FUNCTION',
        definition: `CREATE FUNCTION status_label(p_id INT) RETURNS VARCHAR(20)
BEGIN
  IF p_id IS NULL THEN RETURN 'empty'; END IF;
  RETURN 'ok';
END`,
      }),
      'mysql'
    );
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });
});
