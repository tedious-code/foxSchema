/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The rule these encode: name what would otherwise be nameless, and change
 * nothing else. A missing grid column is a small problem; rewriting somebody's
 * query wrongly is a much larger one, so every ambiguous shape is left alone.
 */
import { describe, expect, it } from 'vitest';
import { autoAliasSelectColumns } from './select-alias.js';

const alias = (sql: string) => autoAliasSelectColumns(sql).sql;

describe('names expressions the driver would not', () => {
  it('aliases bare literals, which Postgres calls ?column? for every one', () => {
    const out = autoAliasSelectColumns('SELECT 1, 2');
    expect(out.sql).toBe('SELECT 1 AS literal, 2 AS literal_2');
    expect(out.added).toEqual(['literal', 'literal_2']);
  });

  it('uses the function name so the header reads like the query', () => {
    expect(alias('SELECT count(*), max(price) FROM t')).toBe(
      'SELECT count(*) AS count, max(price) AS max FROM t'
    );
  });

  it('keeps generated names unique when the same function repeats', () => {
    expect(alias('SELECT count(*), count(id) FROM t')).toBe(
      'SELECT count(*) AS count, count(id) AS count_2 FROM t'
    );
  });

  it('does not collide with an alias the user already chose', () => {
    expect(alias('SELECT 1 + 1 AS count, count(*) FROM t')).toBe(
      'SELECT 1 + 1 AS count, count(*) AS count_2 FROM t'
    );
  });

  it('names a CASE expression', () => {
    expect(alias('SELECT CASE WHEN x > 1 THEN 1 ELSE 0 END FROM t')).toBe(
      'SELECT CASE WHEN x > 1 THEN 1 ELSE 0 END AS case FROM t'
    );
  });
});

describe('leaves alone what is already fine', () => {
  it.each([
    ['plain columns', 'SELECT id, name FROM t'],
    ['qualified columns', 'SELECT t.id, t.name FROM t'],
    ['quoted columns', 'SELECT "id", `name`, [x] FROM t'],
    ['star', 'SELECT * FROM t'],
    ['qualified star', 'SELECT t.* FROM t'],
    ['explicit alias', 'SELECT count(*) AS total FROM t'],
    ['implicit alias', 'SELECT count(*) total FROM t'],
    ['not a select', 'UPDATE t SET x = 1'],
    ['insert', "INSERT INTO t (a) VALUES (1)"],
  ])('%s', (_label, sql) => {
    const out = autoAliasSelectColumns(sql);
    expect(out.changed, sql).toBe(false);
    expect(out.sql).toBe(sql);
  });
});

describe('parses the list without being fooled', () => {
  it('ignores commas inside function calls', () => {
    expect(alias('SELECT coalesce(a, b, c) FROM t')).toBe('SELECT coalesce(a, b, c) AS coalesce FROM t');
  });

  it('ignores a comma inside a string literal', () => {
    expect(alias("SELECT concat(a, ','), id FROM t")).toBe(
      "SELECT concat(a, ',') AS concat, id FROM t"
    );
  });

  it('does not treat a subquery FROM as the end of the outer list', () => {
    expect(alias('SELECT (SELECT max(x) FROM u), id FROM t')).toBe(
      'SELECT (SELECT max(x) FROM u) AS col_1, id FROM t'
    );
  });

  it('stops at the top-level FROM, leaving the rest untouched', () => {
    const out = alias('SELECT 1 + 1 FROM t WHERE x = 2 ORDER BY 1');
    expect(out).toBe('SELECT 1 + 1 AS col_1 FROM t WHERE x = 2 ORDER BY 1');
  });

  it('handles a SELECT with no FROM at all', () => {
    expect(alias('SELECT 1 + 1')).toBe('SELECT 1 + 1 AS col_1');
  });

  it('stops at the statement’s own semicolon, which the editor sends', () => {
    // Read as part of the last item, the `;` hid its alias, so this became
    // `SELECT 100 AS seed; AS col_1` — two statements, and broken on every engine.
    expect(autoAliasSelectColumns('SELECT 100 AS seed;')).toEqual({ sql: 'SELECT 100 AS seed;', changed: false, added: [] });
    expect(alias("SELECT 'bonus' AS label, 2 AS n;")).toBe("SELECT 'bonus' AS label, 2 AS n;");
    expect(alias('SELECT 1, 2;')).toBe('SELECT 1 AS literal, 2 AS literal_2;');
    expect(alias('SELECT 1 + 1 ;\n')).toBe('SELECT 1 + 1 AS col_1;\n');
    // A `;` inside a string is not the end.
    expect(alias("SELECT 'a;b';")).toBe("SELECT 'a;b' AS literal;");
  });

  it('keeps DISTINCT and TOP where they are', () => {
    expect(alias('SELECT DISTINCT 1 + 1 FROM t')).toBe('SELECT DISTINCT 1 + 1 AS col_1 FROM t');
    expect(alias('SELECT TOP 10 1 + 1 FROM t')).toBe('SELECT TOP 10 1 + 1 AS col_1 FROM t');
  });

  it('gives up rather than guess on an unbalanced statement', () => {
    // Half-typed SQL is normal in an editor; mangling it would be worse than
    // leaving the grid a column short.
    const broken = 'SELECT count(*, id FROM t';
    expect(autoAliasSelectColumns(broken).changed).toBe(false);
  });
});
