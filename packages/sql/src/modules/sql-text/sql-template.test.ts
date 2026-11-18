import { describe, expect, it } from 'vitest';
import {
  inlineSqlParams,
  placeholderStyleFor,
  quoteIdentifierIfNeeded,
  renderSqlQuery,
  sqlLiteral,
  sqlTag as sql,
} from './sql-template.js';

describe('placeholderStyleFor', () => {
  it('maps each engine family to its placeholder syntax', () => {
    expect(placeholderStyleFor('postgres')).toBe('dollar');
    expect(placeholderStyleFor('redshift')).toBe('dollar');
    expect(placeholderStyleFor('cockroachdb')).toBe('dollar');
    // Adapter substitutes $N — must not emit ? (see clickhouse.adapter.ts).
    expect(placeholderStyleFor('clickhouse')).toBe('dollar');
    expect(placeholderStyleFor('oracle')).toBe('colon');
    expect(placeholderStyleFor('mysql')).toBe('question');
    expect(placeholderStyleFor('sqlite')).toBe('question');
    expect(placeholderStyleFor('db2')).toBe('question');
    // The T-SQL adapters bind @p0, @p1, … by name; `?` binds nothing there.
    expect(placeholderStyleFor('sqlserver')).toBe('at');
    expect(placeholderStyleFor('azuresql')).toBe('at');
    expect(placeholderStyleFor('mssql')).toBe('at');
  });
});

describe('renderSqlQuery', () => {
  it('binds interpolations instead of inlining them', () => {
    const id = 42;
    const out = renderSqlQuery(sql`SELECT * FROM users WHERE id = ${id}`, 'postgres');
    expect(out.text).toBe('SELECT * FROM users WHERE id = $1');
    expect(out.params).toEqual([42]);
  });

  it('never lets a quote in a value change the statement', () => {
    // The whole point: this is a broken statement under string interpolation.
    const out = renderSqlQuery(sql`SELECT * FROM t WHERE name = ${"O'Brien"}`, 'sqlite');
    expect(out.text).toBe('SELECT * FROM t WHERE name = ?');
    expect(out.params).toEqual(["O'Brien"]);
    expect(out.text).not.toContain("O'Brien");
  });

  it('keeps null / Date / object as bound values, not text', () => {
    const d = new Date('2026-01-02T03:04:05Z');
    const out = renderSqlQuery(sql`INSERT INTO t VALUES (${null}, ${d}, ${{ a: 1 }})`, 'mysql');
    expect(out.text).toBe('INSERT INTO t VALUES (?, ?, ?)');
    expect(out.params).toEqual([null, d, { a: 1 }]);
    expect(out.text).not.toContain('object Object');
  });

  it('numbers placeholders sequentially per dialect', () => {
    const q = sql`SELECT ${1}, ${2}, ${3}`;
    expect(renderSqlQuery(q, 'postgres').text).toBe('SELECT $1, $2, $3');
    expect(renderSqlQuery(q, 'oracle').text).toBe('SELECT :1, :2, :3');
    expect(renderSqlQuery(q, 'mysql').text).toBe('SELECT ?, ?, ?');
    expect(renderSqlQuery(q, 'clickhouse').text).toBe('SELECT $1, $2, $3');
    expect(renderSqlQuery(q, 'sqlserver').text).toBe('SELECT @p0, @p1, @p2');
  });

  it('expands a bare array into an IN list', () => {
    const out = renderSqlQuery(sql`SELECT * FROM t WHERE id IN ${[1, 2, 3]}`, 'postgres');
    expect(out.text).toBe('SELECT * FROM t WHERE id IN ($1, $2, $3)');
    expect(out.params).toEqual([1, 2, 3]);
  });

  it('builds a parameterized multi-row INSERT from objects', () => {
    const rows = [
      { id: 1, name: "O'Brien" },
      { id: 2, name: 'Ada' },
    ];
    const out = renderSqlQuery(sql`INSERT INTO users ${sql.values(rows)}`, 'postgres');
    expect(out.text).toBe('INSERT INTO users ("id", "name") VALUES ($1, $2), ($3, $4)');
    expect(out.params).toEqual([1, "O'Brien", 2, 'Ada']);
  });

  it('fills missing keys with null so every tuple has equal arity', () => {
    const out = renderSqlQuery(
      sql`INSERT INTO t ${sql.values([{ a: 1 }, { a: 2, b: 'x' }])}`,
      'sqlite'
    );
    expect(out.text).toBe('INSERT INTO t ("a", "b") VALUES (?, ?), (?, ?)');
    expect(out.params).toEqual([1, null, 2, 'x']);
  });

  it('quotes identifiers per dialect and never binds them', () => {
    const q = sql`SELECT * FROM ${sql.id('public', 'users')}`;
    expect(renderSqlQuery(q, 'postgres').text).toBe('SELECT * FROM "public"."users"');
    expect(renderSqlQuery(q, 'mysql').text).toBe('SELECT * FROM `public`.`users`');
    expect(renderSqlQuery(q, 'sqlserver').text).toBe('SELECT * FROM [public].[users]');
    expect(renderSqlQuery(q, 'postgres').params).toEqual([]);
  });

  it('escapes the quote character inside an identifier', () => {
    const out = renderSqlQuery(sql`SELECT * FROM ${sql.id('we"ird')}`, 'postgres');
    expect(out.text).toBe('SELECT * FROM "we""ird"');
  });

  it('composes nested queries with continuous placeholder numbering', () => {
    const where = sql`WHERE tenant = ${'acme'} AND active = ${true}`;
    const out = renderSqlQuery(sql`SELECT * FROM users ${where} LIMIT ${10}`, 'postgres');
    expect(out.text).toBe('SELECT * FROM users WHERE tenant = $1 AND active = $2 LIMIT $3');
    expect(out.params).toEqual(['acme', true, 10]);
  });

  it('passes sql.raw through verbatim', () => {
    const out = renderSqlQuery(sql`SELECT * FROM t ORDER BY ${sql.raw('created_at DESC')}`, 'sqlite');
    expect(out.text).toBe('SELECT * FROM t ORDER BY created_at DESC');
    expect(out.params).toEqual([]);
  });

  it('supports the MERGE-style shape a migration cell would write', () => {
    const values = [{ id: 1, email: 'a@b.c' }];
    const out = renderSqlQuery(
      sql`MERGE INTO ${sql.id('accounts')} AS t
          USING (SELECT ${values[0]!.id} AS id, ${values[0]!.email} AS email) AS s
          ON t.id = s.id
          WHEN MATCHED THEN UPDATE SET email = s.email`,
      'sqlserver'
    );
    expect(out.params).toEqual([1, 'a@b.c']);
    expect(out.text).toContain('MERGE INTO [accounts]');
    expect(out.text).toContain('SELECT @p0 AS id, @p1 AS email');
  });
});

describe('sql.values edge cases', () => {
  it('reports an empty batch plainly instead of emitting invalid SQL', () => {
    expect(() => renderSqlQuery(sql`INSERT INTO t ${sql.values([])}`, 'postgres')).toThrow(
      /at least one row/i
    );
  });

  it('reports rows with no columns', () => {
    expect(() => renderSqlQuery(sql`INSERT INTO t ${sql.values([{}])}`, 'postgres')).toThrow(
      /no columns/i
    );
  });
});

describe('quoteIdentifierIfNeeded', () => {
  it('leaves a plain name bare in every dialect', () => {
    for (const d of ['postgres', 'mysql', 'tidb', 'sqlserver', 'azuresql', 'oracle', 'sqlite']) {
      expect(quoteIdentifierIfNeeded('order_items', d)).toBe('order_items');
    }
  });

  it('backtick-quotes the whole MySQL family, TiDB included', () => {
    // A hand copy of this in the SQL editor's schema explorer left TiDB out and
    // produced "x" — a string literal to MySQL-mode TiDB, not a column.
    for (const d of ['mysql', 'mariadb', 'tidb', 'clickhouse']) {
      expect(quoteIdentifierIfNeeded('my col', d)).toBe('`my col`');
    }
    expect(quoteIdentifierIfNeeded('a`b', 'tidb')).toBe('`a``b`');
  });

  it('bracket-quotes the whole T-SQL family, Azure SQL included', () => {
    for (const d of ['sqlserver', 'mssql', 'azuresql']) {
      expect(quoteIdentifierIfNeeded('my col', d)).toBe('[my col]');
    }
    expect(quoteIdentifierIfNeeded('a]b', 'azuresql')).toBe('[a]]b]');
  });

  it('double-quotes everything else', () => {
    expect(quoteIdentifierIfNeeded('my col', 'postgres')).toBe('"my col"');
    expect(quoteIdentifierIfNeeded('a"b', 'oracle')).toBe('"a""b"');
  });

  it('quotes names a bare identifier cannot express', () => {
    expect(quoteIdentifierIfNeeded('1st', 'postgres')).toBe('"1st"');
    expect(quoteIdentifierIfNeeded('café', 'postgres')).toBe('"café"');
  });
});

describe('sqlLiteral', () => {
  it('writes NULL, bare numbers and doubled quotes everywhere', () => {
    expect(sqlLiteral(null, 'postgres')).toBe('NULL');
    expect(sqlLiteral(undefined, 'mysql')).toBe('NULL');
    expect(sqlLiteral(42, 'oracle')).toBe('42');
    expect(sqlLiteral(Number.NaN, 'postgres')).toBe('NULL');
    expect(sqlLiteral(BigInt('9007199254740993'), 'postgres')).toBe('9007199254740993');
    expect(sqlLiteral("O'Reilly", 'postgres')).toBe("'O''Reilly'");
  });

  it('writes booleans as 1/0 where the engine has no TRUE literal', () => {
    expect(sqlLiteral(true, 'postgres')).toBe('TRUE');
    expect(sqlLiteral(false, 'mysql')).toBe('FALSE');
    expect(sqlLiteral(true, 'sqlserver')).toBe('1');
    expect(sqlLiteral(false, 'azuresql')).toBe('0');
    expect(sqlLiteral(true, 'oracle')).toBe('1');
  });

  it('escapes backslashes where a backslash is an escape', () => {
    // 'C:\temp\' would leave MySQL's string open: the last backslash escapes the quote.
    expect(sqlLiteral('C:\\temp\\', 'mysql')).toBe("'C:\\\\temp\\\\'");
    expect(sqlLiteral('a\\b', 'clickhouse')).toBe("'a\\\\b'");
    expect(sqlLiteral('a\\b', 'postgres')).toBe("'a\\b'");
  });

  it('marks non-ASCII text national on SQL Server, and only that', () => {
    expect(sqlLiteral('Zo\u00eb \u6771\u4eac', 'sqlserver')).toBe("N'Zo\u00eb \u6771\u4eac'");
    expect(sqlLiteral('plain', 'sqlserver')).toBe("'plain'");
    expect(sqlLiteral('Zo\u00eb', 'postgres')).toBe("'Zo\u00eb'");
  });

  it('writes bytes as each engine spells a binary literal', () => {
    const bytes = Uint8Array.from([0xde, 0xad]);
    expect(sqlLiteral(bytes, 'postgres')).toBe("'\\xdead'");
    expect(sqlLiteral(bytes, 'sqlserver')).toBe('0xdead');
    expect(sqlLiteral(bytes, 'oracle')).toBe("HEXTORAW('dead')");
    expect(sqlLiteral(bytes, 'mysql')).toBe("X'dead'");
    // A Buffer after a JSON round trip.
    expect(sqlLiteral({ type: 'Buffer', data: [222, 173] }, 'sqlite')).toBe("X'dead'");
  });

  it('writes other objects as JSON text', () => {
    expect(sqlLiteral({ a: "it's" }, 'postgres')).toBe(`'{"a":"it''s"}'`);
  });
});

describe('inlineSqlParams', () => {
  it("replaces the dialect's own placeholders", () => {
    expect(inlineSqlParams('SELECT * FROM "t" WHERE "a" = $1 AND "b" = $2', [42, "O'C"], 'postgres')).toBe(
      'SELECT * FROM "t" WHERE "a" = 42 AND "b" = \'O\'\'C\''
    );
    expect(inlineSqlParams('SELECT * FROM `t` WHERE `a` = ? AND `b` = ?', [1, 'x'], 'mysql')).toBe(
      "SELECT * FROM `t` WHERE `a` = 1 AND `b` = 'x'"
    );
    expect(inlineSqlParams('SELECT * FROM [t] WHERE [a] = @p0 AND [b] = @p1', [9, true], 'sqlserver')).toBe(
      'SELECT * FROM [t] WHERE [a] = 9 AND [b] = 1'
    );
    expect(inlineSqlParams('SELECT * FROM t WHERE a = :1', [7], 'oracle')).toBe('SELECT * FROM t WHERE a = 7');
  });

  it('round-trips what renderSqlQuery bound', () => {
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'oracle', 'sqlite', 'clickhouse', 'db2']) {
      const query = sql`SELECT * FROM ${sql.id('t')} WHERE ${sql.id('a')} = ${10} AND ${sql.id('b')} = ${'z'}`;
      const bound = renderSqlQuery(query, dialect);
      expect(inlineSqlParams(bound.text, bound.params, dialect), dialect).toBe(
        renderSqlQuery(query, dialect, { inlineValues: true }).text
      );
    }
  });

  it('leaves another style alone: a ? is not a Postgres placeholder', () => {
    expect(inlineSqlParams('SELECT * FROM t WHERE a = $1 AND tags ? \'vip\'', [5], 'postgres')).toBe(
      "SELECT * FROM t WHERE a = 5 AND tags ? 'vip'"
    );
  });

  it('leaves placeholders inside strings, quoted names and comments alone', () => {
    expect(
      inlineSqlParams(`SELECT "$1", 'cost $1?' FROM t /* $1 */ WHERE a = $1 -- $1`, [3], 'postgres')
    ).toBe(`SELECT "$1", 'cost $1?' FROM t /* $1 */ WHERE a = 3 -- $1`);
    expect(inlineSqlParams("SELECT 'why?' AS q FROM t WHERE a = ?", [8], 'mysql')).toBe(
      "SELECT 'why?' AS q FROM t WHERE a = 8"
    );
    expect(inlineSqlParams("SELECT '10:1' FROM t WHERE a = :1", [2], 'oracle')).toBe(
      "SELECT '10:1' FROM t WHERE a = 2"
    );
  });

  it('leaves a placeholder with no value as it is', () => {
    expect(inlineSqlParams('SELECT $1, $2', [1], 'postgres')).toBe('SELECT 1, $2');
    expect(inlineSqlParams('SELECT $1', [], 'postgres')).toBe('SELECT $1');
  });
});

describe('renderSqlQuery inlineValues', () => {
  it('writes literals and returns no params', () => {
    const rendered = renderSqlQuery(
      sql`INSERT INTO ${sql.id('t')} ${sql.values([{ id: 1, name: "O'C", ok: false }])}`,
      'sqlserver',
      { inlineValues: true }
    );
    expect(rendered.text).toBe("INSERT INTO [t] ([id], [name], [ok]) VALUES (1, 'O''C', 0)");
    expect(rendered.params).toEqual([]);
  });
});
