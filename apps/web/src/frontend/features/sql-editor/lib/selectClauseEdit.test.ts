import { describe, expect, it } from 'vitest';
import {
  addTableWithAliasToFrom,
  clearSelectList,
  currentSelectListItems,
  ensureAllFromTablesAliased,
  ensureTableHasAlias,
  findSelectListRange,
  insertIntoSelectList,
  isInFromTablePosition,
  isSelectOrFromKeyword,
  parseSelectListItems,
  removeFromSelectList,
  selectListIsStar,
  setSelectListToStar,
  shortAliasesByTable,
  suggestTableAlias,
} from '@/features/sql-editor/lib/selectClauseEdit';

/**
 * What the column picker does: schema cache knows bare table names, the FROM
 * clause may be schema-qualified. Falling through to the table name is the bug
 * this models — `ORDER.id` is the wrong prefix and invalid SQL besides.
 */
function pickerAliasFor(sql: string, schemaCacheTableName: string): string {
  const byTable = shortAliasesByTable(sql);
  const bare = schemaCacheTableName.includes('.')
    ? schemaCacheTableName.slice(schemaCacheTableName.lastIndexOf('.') + 1)
    : schemaCacheTableName;
  return (
    byTable.get(schemaCacheTableName.toLowerCase()) ?? byTable.get(bare.toLowerCase()) ?? bare
  );
}

describe('shortAliasesByTable', () => {
  it('resolves a schema-qualified FROM by bare name', () => {
    const byTable = shortAliasesByTable('SELECT * from Carter.ORDER ord ;');
    expect(byTable.get('carter.order')).toBe('ord');
    expect(byTable.get('order')).toBe('ord');
  });

  it('gives the picker the alias, not the table name', () => {
    // Regression: `Carter.ORDER ord` used to yield `ORDER` because the map was
    // keyed only by the qualified name while the schema cache had `ORDER`.
    expect(pickerAliasFor('SELECT * from Carter.ORDER ord ;', 'ORDER')).toBe('ord');
    expect(pickerAliasFor('SELECT * FROM carter.orders ord', 'orders')).toBe('ord');
    expect(pickerAliasFor('SELECT * FROM Sales.Order_Items oi', 'Order_Items')).toBe('oi');
  });

  it('still works for an unqualified FROM', () => {
    expect(pickerAliasFor('SELECT * FROM orders ord', 'orders')).toBe('ord');
  });

  it('falls back to the table name when no alias is written', () => {
    // extractTableAliases indexes the table under its own name, so the "alias"
    // here is just how the cell must be qualified: `order.id`.
    expect(pickerAliasFor('SELECT * FROM Carter.ORDER', 'ORDER')).toBe('order');
  });

  it('keeps each table separate across a join', () => {
    const sql =
      'SELECT * FROM Carter.ORDER ord JOIN Carter.ORDER_ITEM oi ON oi.order_id = ord.id';
    expect(pickerAliasFor(sql, 'ORDER')).toBe('ord');
    expect(pickerAliasFor(sql, 'ORDER_ITEM')).toBe('oi');
  });

  it('prefers the shortest alias when a table is written more than once', () => {
    const byTable = shortAliasesByTable(
      'SELECT * FROM Carter.ORDER ord JOIN Carter.ORDER o2 ON o2.id = ord.parent_id'
    );
    expect(byTable.get('order')).toBe('o2');
  });
});

describe('selectClauseEdit', () => {
  it('finds the SELECT list before FROM', () => {
    const sql = 'SELECT a, b FROM t';
    const r = findSelectListRange(sql);
    expect(r).not.toBeNull();
    expect(sql.slice(r!.listStart, r!.listEnd).trim()).toBe('a, b');
  });

  it('replaces bare * and appends additional columns', () => {
    expect(insertIntoSelectList('SELECT * FROM t', 'u.id')).toBe('SELECT u.id FROM t');
    expect(insertIntoSelectList('SELECT u.id FROM t', 'u.email')).toBe(
      'SELECT u.id, u.email FROM t'
    );
  });

  it('does not duplicate an already-selected column', () => {
    expect(insertIntoSelectList('SELECT u.id FROM t u', 'u.id')).toBe('SELECT u.id FROM t u');
  });

  it('skips DISTINCT / TOP n / TOP n PERCENT before the list', () => {
    const listOf = (sql: string) => {
      const r = findSelectListRange(sql);
      return r ? sql.slice(r.listStart, r.listEnd).trim() : null;
    };
    expect(listOf('SELECT DISTINCT a, b FROM t')).toBe('a, b');
    expect(listOf('SELECT TOP 10 a FROM t')).toBe('a');
    expect(listOf('SELECT TOP 10 PERCENT a FROM t')).toBe('a');
    // `10x` is not a TOP count, so nothing is skipped.
    expect(listOf('SELECT top10x FROM t')).toBe('top10x');
  });

  it('detects SELECT/FROM keyword under the caret', () => {
    const sql = 'SELECT * FROM t';
    expect(isSelectOrFromKeyword(sql, 0)).toBe('select');
    expect(isSelectOrFromKeyword(sql, 9)).toBe('from');
    expect(isSelectOrFromKeyword(sql, 14)).toBeNull();
  });

  it('parses select list items ignoring commas inside calls', () => {
    expect(parseSelectListItems('a, func(x, y), b')).toEqual(['a', 'func(x, y)', 'b']);
  });

  it('setSelectListToStar and clearSelectList', () => {
    expect(setSelectListToStar('SELECT u.id, u.email FROM t u')).toBe('SELECT * FROM t u');
    expect(selectListIsStar('SELECT * FROM t')).toBe(true);
    expect(clearSelectList('SELECT u.id FROM t u')).toBe('SELECT FROM t u');
    expect(currentSelectListItems('SELECT u.id, u.email FROM t u')).toEqual(['u.id', 'u.email']);
  });

  it('removeFromSelectList drops one expression', () => {
    expect(removeFromSelectList('SELECT u.id, u.email FROM t u', 'u.id')).toBe(
      'SELECT u.email FROM t u'
    );
    expect(removeFromSelectList('SELECT u.id FROM t u', 'u.id')).toBe('SELECT FROM t u');
  });

  it('suggestTableAlias builds readable unique aliases', () => {
    expect(suggestTableAlias('orders', new Set())).toBe('ord');
    expect(suggestTableAlias('users', new Set())).toBe('use');
    expect(suggestTableAlias('order_items', new Set())).toBe('oi');
    expect(suggestTableAlias('OrderItems', new Set())).toBe('oi');
    expect(suggestTableAlias('customer_addresses', new Set())).toBe('ca');
    // Prefer lengthening over numbering when the short stem is taken.
    expect(suggestTableAlias('orders', new Set(['ord']))).toBe('ords');
    expect(suggestTableAlias('orders', new Set(['ord', 'ords', 'or', 'o', 'orde', 'order', 'orders']))).toBe(
      'ord2'
    );
  });

  it('addTableWithAliasToFrom creates SELECT * FROM table alias', () => {
    const empty = addTableWithAliasToFrom('', 'users');
    expect(empty.added).toBe(true);
    expect(empty.sql).toMatch(/^SELECT \*\nFROM users \w+$/);

    const next = addTableWithAliasToFrom(empty.sql, 'orders');
    expect(next.added).toBe(true);
    expect(next.sql).toContain('FROM users');
    expect(next.sql).toContain(', orders');

    const again = addTableWithAliasToFrom(empty.sql, 'users');
    expect(again.added).toBe(false);
    expect(again.alias).toBe(empty.alias);
  });

  it('starts a new SELECT when the previous statement is finished', () => {
    const next = addTableWithAliasToFrom('SELECT * FROM DEMO_A.CATEGORIES cat;', 'COUPONS');
    expect(next.added).toBe(true);
    expect(next.sql).toBe('SELECT * FROM DEMO_A.CATEGORIES cat;\nSELECT *\nFROM COUPONS cou');
    expect(next.sql).not.toContain('cat;,');
  });

  it('ensureTableHasAlias upgrades bare FROM and rewrites SELECT quals', () => {
    const { sql, alias, changed } = ensureTableHasAlias(
      'SELECT orders.created_at, orders.customer_id from orders',
      'orders'
    );
    expect(changed).toBe(true);
    expect(alias).toBe('ord');
    expect(sql.toLowerCase()).toContain('from orders ord');
    expect(sql).toContain('ord.created_at');
    expect(sql).toContain('ord.customer_id');
    expect(sql).not.toMatch(/\borders\./i);
  });

  it('ensureAllFromTablesAliased aliases every bare FROM table', () => {
    const sql = ensureAllFromTablesAliased(
      'SELECT orders.created_at, orders.customer_id from orders'
    );
    expect(sql.toLowerCase()).toMatch(/from orders ord\b/);
    expect(ensureAllFromTablesAliased(sql)).toBe(sql); // idempotent
  });

  it('isInFromTablePosition detects FROM list vs WHERE', () => {
    expect(isInFromTablePosition('SELECT * FROM ord')).toBe(true);
    expect(isInFromTablePosition('SELECT * FROM orders o WHERE o.')).toBe(false);
    expect(isInFromTablePosition('SELECT orders.')).toBe(false);
  });
});
