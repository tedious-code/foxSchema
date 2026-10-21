import { describe, expect, it } from 'vitest';
import {
  tableNameParts,
  buildTablePreview,
  buildForeignKeyDrilldown,
  fkDrillTableName,
  foreignKeyLinksFor,
  foreignKeyLinksForSql,
  composePeekSql,
  isSafePeekClause,
  joinPeekOrder,
  joinPeekWhere,
  splitPeekOrder,
  splitPeekWhere,
  peekBaseFilterLabel,
  singleTableForResultEdit,
  fromClauseIsMultiTable,
  findCachedTableForEdit,
  selectListSafeForResultEdit,
  sqlHasSetOperation,
} from './tablePreview';
import type { ForeignKeyInfo, TableSchema } from './types';

describe('tableNameParts', () => {
  it('splits schema-qualified names', () => {
    expect(tableNameParts('public.users')).toEqual(['public', 'users']);
    expect(tableNameParts('users')).toEqual(['users']);
  });

  it('keeps a dot inside a quoted segment', () => {
    expect(tableNameParts('"we.ird"."tbl"')).toEqual(['we.ird', 'tbl']);
    expect(tableNameParts('"say""hi"')).toEqual(['say"hi']);
  });
});

describe('buildTablePreview', () => {
  it('quotes per dialect and adds no LIMIT (the server pages)', () => {
    expect(buildTablePreview('public.users', 'postgres')).toEqual({
      sql: 'SELECT * FROM "public"."users"',
      params: [],
    });
    expect(buildTablePreview('users', 'mysql').sql).toBe('SELECT * FROM `users`');
    expect(buildTablePreview('users', 'sqlserver').sql).toBe('SELECT * FROM [users]');
  });
});

describe('buildForeignKeyDrilldown', () => {
  const fk: ForeignKeyInfo = {
    name: 'fk_o_c',
    columns: ['customer_id'],
    referencedTable: 'customers',
    referencedColumns: ['id'],
  };

  it('binds the value instead of inlining it', () => {
    const q = buildForeignKeyDrilldown(fk, [7], 'postgres');
    expect(q).toEqual({ sql: 'SELECT * FROM "customers" WHERE "id" = $1', params: [7] });
  });

  it('qualifies a cross-schema parent so the drill cannot hit a same-named local table', () => {
    const cross: ForeignKeyInfo = {
      name: 'fk_orders_products',
      columns: ['product_id'],
      referencedSchema: 'inventory',
      referencedTable: 'products',
      referencedColumns: ['id'],
    };
    const q = buildForeignKeyDrilldown(cross, [42], 'postgres');
    expect(q).toEqual({
      sql: 'SELECT * FROM "inventory"."products" WHERE "id" = $1',
      params: [42],
    });
    expect(fkDrillTableName(cross)).toBe('inventory.products');
    expect(fkDrillTableName(fk)).toBe('customers');
  });

  it('binds a hostile string safely', () => {
    const q = buildForeignKeyDrilldown(fk, ["x' OR 1=1 --"], 'sqlite');
    expect(q!.sql).toBe('SELECT * FROM "customers" WHERE "id" = ?');
    expect(q!.params).toEqual(["x' OR 1=1 --"]);
  });

  it('ANDs a composite key in order', () => {
    const composite: ForeignKeyInfo = {
      name: 'fk',
      columns: ['a', 'b'],
      referencedTable: 'p',
      referencedColumns: ['x', 'y'],
    };
    const q = buildForeignKeyDrilldown(composite, [1, 'two'], 'postgres');
    expect(q!.sql).toBe('SELECT * FROM "p" WHERE "x" = $1 AND "y" = $2');
    expect(q!.params).toEqual([1, 'two']);
  });

  it('refuses to build a link with no parent columns or a null value', () => {
    const noCols: ForeignKeyInfo = { ...fk, referencedColumns: [] };
    expect(buildForeignKeyDrilldown(noCols, [1], 'postgres')).toBeNull();
    expect(buildForeignKeyDrilldown(fk, [null], 'postgres')).toBeNull();
  });
});

describe('foreignKeyLinksFor', () => {
  const table = {
    name: 'orders',
    objectType: 'TABLE',
    columns: [],
    indices: [],
    foreignKeys: [
      { name: 'fk1', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] },
      { name: 'fk2', columns: ['a', 'b'], referencedTable: 'p', referencedColumns: ['x', 'y'] },
    ],
  } as unknown as TableSchema;

  it('matches column names case-insensitively (Oracle/Db2 fold to upper)', () => {
    const links = foreignKeyLinksFor(table, ['ID', 'CUSTOMER_ID', 'A', 'B']);
    expect(links.map((l) => l.fk.name)).toEqual(['fk1', 'fk2']);
    expect(links[0]!.columnIndex).toBe(1);
    expect(links[1]!.valueIndexes).toEqual([2, 3]);
  });

  it('skips a composite FK whose columns are not all selected', () => {
    const links = foreignKeyLinksFor(table, ['customer_id', 'a']);
    expect(links.map((l) => l.fk.name)).toEqual(['fk1']);
  });

  it('returns nothing when the table has no FKs', () => {
    expect(foreignKeyLinksFor(undefined, ['a'])).toEqual([]);
  });
});

describe('composePeekSql', () => {
  it('ANDs a WHERE onto a base SELECT', () => {
    const q = composePeekSql('SELECT * FROM "t"', [], { where: 'ARCHIVED = false' });
    expect(q).toEqual({
      sql: 'SELECT * FROM "t" WHERE (ARCHIVED = false)',
      params: [],
    });
  });

  it('ANDs onto an existing FK WHERE and keeps bound params', () => {
    const q = composePeekSql('SELECT * FROM "TECHNICIAN" WHERE "ID" = $1', [34], {
      where: 'ARCHIVED = false',
      orderBy: 'CREATEDAT DESC',
    });
    expect(q).toEqual({
      sql: 'SELECT * FROM "TECHNICIAN" WHERE "ID" = $1 AND (ARCHIVED = false) ORDER BY CREATEDAT DESC',
      params: [34],
    });
  });

  it('omits user WHERE when cleared so the base peek returns all matching rows', () => {
    const base = 'SELECT * FROM "TECHNICIAN" WHERE "ID" = $1';
    const filtered = composePeekSql(base, [34], { where: 'ARCHIVED = false' });
    expect(filtered).toEqual({
      sql: 'SELECT * FROM "TECHNICIAN" WHERE "ID" = $1 AND (ARCHIVED = false)',
      params: [34],
    });
    const cleared = composePeekSql(base, [34], { where: '   ' });
    expect(cleared).toEqual({ sql: base, params: [34] });
    const rootCleared = composePeekSql('SELECT * FROM "t"', [], { where: '' });
    expect(rootCleared).toEqual({ sql: 'SELECT * FROM "t"', params: [] });
  });

  it('rejects multi-statement and comment filters', () => {
    expect(isSafePeekClause('a = 1; DROP TABLE t')).toBe(false);
    expect(composePeekSql('SELECT * FROM t', [], { where: '1=1; --' })).toEqual({
      error: 'WHERE cannot contain ; or comments. AND several conditions together.',
    });
  });

  it('keeps several AND predicates and several sort columns', () => {
    const q = composePeekSql('SELECT * FROM t', [], {
      where: "status = 'gold' AND active = 1",
      orderBy: 'created_at DESC, id ASC',
    });
    expect(q).toEqual({
      sql: "SELECT * FROM t WHERE (status = 'gold' AND active = 1) ORDER BY created_at DESC, id ASC",
      params: [],
    });
  });
});

describe('peek filter rows', () => {
  it('splits WHERE on AND and ORDER BY on commas, keeping quotes and calls intact', () => {
    expect(splitPeekWhere("status = 'gold' AND name LIKE '%AND%' AND id > 1")).toEqual([
      "status = 'gold'",
      "name LIKE '%AND%'",
      'id > 1',
    ]);
    expect(splitPeekOrder('created_at DESC, COALESCE(a, b) ASC, id')).toEqual([
      { expr: 'created_at', dir: 'DESC' },
      { expr: 'COALESCE(a, b)', dir: 'ASC' },
      { expr: 'id', dir: '' },
    ]);
    expect(joinPeekWhere(['status = \'gold\'', '', 'active = 1'])).toBe(
      "status = 'gold' AND active = 1"
    );
    expect(
      joinPeekOrder([
        { expr: 'created_at', dir: 'DESC' },
        { expr: '', dir: 'ASC' },
        { expr: 'id', dir: '' },
      ])
    ).toBe('created_at DESC, id');
  });
});

describe('peekBaseFilterLabel', () => {
  it('returns null when the peek has no bound base params', () => {
    expect(peekBaseFilterLabel('USER', 'USER', [])).toBeNull();
  });

  it('reads the FK condition from the panel title', () => {
    expect(peekBaseFilterLabel('USER · ID = 33', 'USER', [33])).toBe('ID = 33');
    expect(peekBaseFilterLabel('public.orders · customer_id = 7', 'public.orders', [7])).toBe(
      'customer_id = 7'
    );
  });
});

describe('foreignKeyLinksForSql', () => {
  const orders = {
    name: 'orders',
    objectType: 'TABLE',
    columns: [],
    indices: [],
    foreignKeys: [
      {
        name: 'fk1',
        columns: ['customer_id'],
        referencedTable: 'customers',
        referencedColumns: ['id'],
      },
    ],
  } as unknown as TableSchema;

  it('links result FK columns from the statement’s FROM table', () => {
    const links = foreignKeyLinksForSql(
      'SELECT id, customer_id FROM orders',
      [orders],
      ['id', 'customer_id']
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.columnIndex).toBe(1);
    expect(links[0]!.fk.referencedTable).toBe('customers');
  });

  it('returns nothing when schema is missing the table', () => {
    expect(
      foreignKeyLinksForSql('SELECT * FROM orders', [], ['customer_id'])
    ).toEqual([]);
  });
});

describe('singleTableForResultEdit', () => {
  const users = {
    name: 'public.users',
    objectType: 'TABLE',
    columns: [],
    indices: [],
    foreignKeys: [],
  } as unknown as TableSchema;

  const bareUsers = {
    name: 'users',
    objectType: 'TABLE',
    columns: [],
    indices: [],
    foreignKeys: [],
  } as unknown as TableSchema;

  it('resolves a single-table SELECT', () => {
    const r = singleTableForResultEdit('SELECT id, email FROM public.users', [users]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.name).toBe('public.users');
  });

  it('rejects joins and non-SELECT statements', () => {
    expect(
      singleTableForResultEdit(
        'SELECT * FROM public.users u JOIN orders o ON o.user_id = u.id',
        [users]
      ).ok
    ).toBe(false);
    // Self-join: same physical table, still multi-table FROM.
    expect(
      singleTableForResultEdit(
        'SELECT a.id FROM public.users a JOIN public.users b ON a.id = b.id',
        [users]
      ).ok
    ).toBe(false);
    expect(fromClauseIsMultiTable('SELECT * FROM users a, users b')).toBe(true);
    expect(singleTableForResultEdit('UPDATE public.users SET email = x', [users]).ok).toBe(
      false
    );
    expect(singleTableForResultEdit('SELECT 1', [users]).ok).toBe(false);
  });

  it('allows WITH … SELECT when only one real table is referenced', () => {
    const r = singleTableForResultEdit(
      'WITH x AS (SELECT 1) SELECT * FROM public.users',
      [users]
    );
    expect(r.ok).toBe(true);
    // CTE-only SELECT has no schema table → not editable.
    expect(
      singleTableForResultEdit('WITH x AS (SELECT 1 AS n) SELECT n FROM x', [users]).ok
    ).toBe(false);
  });

  it('does not resolve a same-named outer CTE reference as a cached table', () => {
    const r = singleTableForResultEdit(
      'WITH users AS (SELECT id % 10 AS id FROM users) SELECT id FROM users ORDER BY id',
      [users]
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('No base table in this query.');
  });

  it('rejects UNION / EXCEPT / INTERSECT (rows may not exist in the base table)', () => {
    expect(sqlHasSetOperation('SELECT id FROM public.users UNION ALL SELECT 42')).toBe(true);
    expect(
      singleTableForResultEdit(
        'SELECT id, email FROM public.users UNION ALL SELECT 42, \'x\'',
        [users]
      ).ok
    ).toBe(false);
    expect(
      singleTableForResultEdit('SELECT id FROM public.users EXCEPT SELECT id FROM other', [users])
        .ok
    ).toBe(false);
  });

  it('rejects renamed / computed SELECT lists that would mis-bind PK values', () => {
    expect(selectListSafeForResultEdit('SELECT email AS id, name FROM public.users')).toBe(
      false
    );
    expect(selectListSafeForResultEdit('SELECT id, upper(email) AS email FROM public.users')).toBe(
      false
    );
    expect(selectListSafeForResultEdit('SELECT id, email FROM public.users')).toBe(true);
    expect(selectListSafeForResultEdit('SELECT u.id, u.email FROM public.users u')).toBe(true);
    expect(
      singleTableForResultEdit('SELECT email AS id, name FROM public.users', [users]).ok
    ).toBe(false);
  });

  it('rejects FROM subqueries', () => {
    expect(
      singleTableForResultEdit(
        'SELECT * FROM (SELECT email AS id FROM public.users) t',
        [users]
      ).ok
    ).toBe(false);
  });

  it('does not map sales.users onto a bare users cache entry from another schema', () => {
    expect(findCachedTableForEdit([bareUsers], 'sales.users', 'public')).toBeUndefined();
    expect(findCachedTableForEdit([bareUsers], 'sales.users')).toBeUndefined();
    expect(findCachedTableForEdit([bareUsers], 'public.users', 'public')?.name).toBe('users');
    expect(findCachedTableForEdit([bareUsers], 'users')?.name).toBe('users');
    expect(
      singleTableForResultEdit('SELECT id, email FROM sales.users', [bareUsers], 'public').ok
    ).toBe(false);
    expect(
      singleTableForResultEdit('SELECT id, email FROM public.users', [bareUsers], 'public').ok
    ).toBe(true);
  });
});
