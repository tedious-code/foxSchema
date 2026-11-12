import { describe, expect, it } from 'vitest';
import {
  applySetDirectives,
  columnToListValues,
  expandSqlLiteral,
  exportVariables,
  findVariableRefs,
  isSecretUnset,
  isValidVariableName,
  parseImportedVariables,
  parseSetDirectives,
  prepareStatement,
  reattachSetComments,
  recentQuerySql,
  resolveVariablesForConnection,
  sqlForDisplay,
  stripSecretsForPersist,
  substituteVariables,
  variableRefText,
  type SqlVariable,
  SQL_VARIABLE_LIST_MAX,
} from './sql-variables';

function scalar(name: string, value: unknown, extra?: Partial<SqlVariable>): SqlVariable {
  return { id: name, name, kind: 'scalar', value, updatedAt: 1, ...extra };
}

function list(name: string, values: unknown[], extra?: Partial<SqlVariable>): SqlVariable {
  return { id: name, name, kind: 'list', values, updatedAt: 1, ...extra };
}

function table(name: string, columns: string[], rows: unknown[][]): SqlVariable {
  return { id: name, name, kind: 'table', columns, rows, updatedAt: 1 };
}

describe('sql-variables', () => {
  it('validates names', () => {
    expect(isValidVariableName('user_id')).toBe(true);
    expect(isValidVariableName('_x')).toBe(true);
    expect(isValidVariableName('A1')).toBe(true);
    expect(isValidVariableName('1bad')).toBe(false);
    expect(isValidVariableName('bad-name')).toBe(false);
    expect(isValidVariableName('')).toBe(false);
  });

  it('builds ${{name}} snippets for insert-at-cursor', () => {
    expect(variableRefText('tok')).toBe('${{tok}}');
    expect(variableRefText('t', 'id')).toBe('${{t.id}}');
  });

  it('finds ${{name}} and ${{name.col}} refs; ignores $var / ${x}', () => {
    expect(findVariableRefs('SELECT $var, ${x}, ${{a}}, ${{b.c}}, ${{a}}')).toEqual([
      { name: 'a' },
      { name: 'b', column: 'c' },
    ]);
  });

  it('expands scalars with SQL quoting (strings always quoted)', () => {
    expect(expandSqlLiteral(42)).toBe('42');
    expect(expandSqlLiteral(true)).toBe('true');
    expect(expandSqlLiteral(null)).toBe('NULL');
    expect(expandSqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(expandSqlLiteral('hello')).toBe("'hello'");
    expect(expandSqlLiteral('true')).toBe("'true'");
    expect(expandSqlLiteral('false')).toBe("'false'");
  });

  it('substitutes scalar and list', () => {
    const vars = [scalar('user_id', 7), list('ids', [1, 2, "a'b"])];
    const r = substituteVariables(
      'SELECT * FROM t WHERE id = ${{user_id}} AND x IN (${{ids}})',
      vars
    );
    expect(r).toEqual({
      ok: true,
      sql: "SELECT * FROM t WHERE id = 7 AND x IN (1,2,'a''b')",
    });
  });

  it('substitutes table as VALUES and table.col as list', () => {
    const t = table('t', ['id', 'name'], [
      [1, "a'b"],
      [2, 'x'],
    ]);
    expect(substituteVariables('INSERT INTO x SELECT * FROM (${{t}}) v', [t])).toEqual({
      ok: true,
      sql: "INSERT INTO x SELECT * FROM (VALUES (1,'a''b'),(2,'x')) v",
    });
    expect(substituteVariables('WHERE id IN (${{t.id}})', [t])).toEqual({
      ok: true,
      sql: 'WHERE id IN (1,2)',
    });
  });

  it('fails on missing variable / column / empty list', () => {
    expect(substituteVariables('SELECT ${{missing}}', [])).toEqual({
      ok: false,
      error: 'Undefined variable: missing',
    });
    expect(substituteVariables('SELECT ${{ids}}', [list('ids', [])])).toEqual({
      ok: false,
      error: 'Variable "ids" is an empty list',
    });
    expect(
      substituteVariables('SELECT ${{t.nope}}', [table('t', ['id'], [[1]])])
    ).toEqual({
      ok: false,
      error: 'Variable "t" has no column "nope"',
    });
  });

  it('leaves non-template dollars alone', () => {
    const r = substituteVariables("SELECT '$var', '${x}', 1", [scalar('x', 1)]);
    expect(r).toEqual({ ok: true, sql: "SELECT '$var', '${x}', 1" });
  });

  it('columnToListValues skips nulls and caps length', () => {
    const rows = [
      [1, null],
      [2, 'a'],
      [null, 'b'],
      [3, undefined],
    ];
    expect(columnToListValues(rows, 0)).toEqual([1, 2, 3]);
    expect(columnToListValues(rows, 1)).toEqual(['a', 'b']);

    const many = Array.from({ length: SQL_VARIABLE_LIST_MAX + 20 }, (_, i) => [i]);
    expect(columnToListValues(many, 0)).toHaveLength(SQL_VARIABLE_LIST_MAX);
  });

  it('parseSetDirectives strips @set lines and keeps SQL', () => {
    const src = `-- @set orderid
-- @set ids = column id
-- @set t = table
SELECT id FROM t WHERE x = 1;`;
    const parsed = parseSetDirectives(src);
    expect(parsed.directives).toEqual([
      { mode: 'scalar', name: 'orderid' },
      { mode: 'column', name: 'ids', column: 'id' },
      { mode: 'table', name: 't' },
    ]);
    expect(parsed.sql.trim()).toBe('SELECT id FROM t WHERE x = 1;');
  });

  it('prepareStatement strips @set then substitutes', () => {
    const r = prepareStatement(
      `-- @set x
SELECT * FROM t WHERE id = ${'${{user_id}}'};`,
      [scalar('user_id', 9)]
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.directives).toEqual([{ mode: 'scalar', name: 'x' }]);
      expect(r.sql).toBe('SELECT * FROM t WHERE id = 9;');
    }
  });

  it('reattachSetComments restores @set lines the splitter drops', () => {
    const full = `SELECT 1 AS id;
-- @set ids = column id
SELECT 2 AS id;
-- @set t = table
SELECT 3 AS a, 4 AS b;`;
    const stmts = [
      { text: 'SELECT 1 AS id;', start: 0, end: full.indexOf(';') + 1 },
      {
        text: 'SELECT 2 AS id;',
        start: full.indexOf('SELECT 2'),
        end: full.indexOf('SELECT 2') + 'SELECT 2 AS id;'.length,
      },
      {
        text: 'SELECT 3 AS a, 4 AS b;',
        start: full.indexOf('SELECT 3'),
        end: full.length,
      },
    ];
    const enriched = reattachSetComments(full, stmts);
    expect(enriched[0]).toBe('SELECT 1 AS id;');
    expect(enriched[1]).toContain('-- @set ids = column id');
    expect(enriched[1]).toContain('SELECT 2 AS id;');
    expect(parseSetDirectives(enriched[1]!).directives).toEqual([
      { mode: 'column', name: 'ids', column: 'id' },
    ]);
    expect(enriched[2]).toContain('-- @set t = table');
    expect(parseSetDirectives(enriched[2]!).directives).toEqual([
      { mode: 'table', name: 't' },
    ]);
  });

  it('applySetDirectives builds scalar / list / table updates', () => {
    const result = {
      columns: ['ID', 'NAME'],
      rows: [
        [10, 'a'],
        [20, 'b'],
      ],
    };
    expect(applySetDirectives([{ mode: 'scalar', name: 'x' }], result)).toEqual({
      ok: true,
      updates: [{ name: 'x', kind: 'scalar', value: 10 }],
    });
    expect(
      applySetDirectives([{ mode: 'column', name: 'ids', column: 'id' }], result)
    ).toEqual({
      ok: true,
      updates: [{ name: 'ids', kind: 'list', values: [10, 20] }],
    });
    expect(applySetDirectives([{ mode: 'table', name: 't' }], result)).toEqual({
      ok: true,
      updates: [
        {
          name: 't',
          kind: 'table',
          columns: ['ID', 'NAME'],
          rows: [
            [10, 'a'],
            [20, 'b'],
          ],
        },
      ],
    });
  });

  it('resolveVariablesForConnection merges scalar/list overrides', () => {
    const vars: SqlVariable[] = [
      scalar('x', 1, { overrides: { c1: { value: 99 }, c2: { value: 2 } } }),
      list('ids', [1], { overrides: { c1: { values: [7, 8] } } }),
      table('t', ['a'], [[1]]),
    ];
    const forC1 = resolveVariablesForConnection(vars, 'c1');
    expect(forC1.find((v) => v.name === 'x')?.value).toBe(99);
    expect(forC1.find((v) => v.name === 'ids')?.values).toEqual([7, 8]);
    expect(forC1.find((v) => v.name === 't')?.rows).toEqual([[1]]);
    expect(resolveVariablesForConnection(vars, 'missing').find((v) => v.name === 'x')?.value).toBe(
      1
    );
  });

  it('stripSecretsForPersist drops secret variables so a delete stays gone after reload', () => {
    const secret = scalar('tok', 'shh', { secret: true, overrides: { c1: { value: 'x' } } });
    const plain = scalar('n', 1);
    const stripped = stripSecretsForPersist([secret, plain]);
    expect(stripped).toEqual([expect.objectContaining({ name: 'n', value: 1 })]);
    expect(stripped.some((v) => v.secret || v.name === 'tok')).toBe(false);

    const exported = exportVariables([secret, plain]);
    expect(exported[0]).toEqual({ name: 'tok', kind: 'scalar', secret: true });
    expect(exported[1]).toEqual({ name: 'n', kind: 'scalar', value: 1 });
  });

  it('maskSecrets substitutes (secret) for display', () => {
    const v = scalar('tok', 'shh', { secret: true });
    expect(substituteVariables('SELECT ${{tok}}', [v], { maskSecrets: true })).toEqual({
      ok: true,
      sql: 'SELECT (secret)',
    });
    expect(substituteVariables('SELECT ${{tok}}', [v])).toEqual({
      ok: true,
      sql: "SELECT 'shh'",
    });
  });

  it('parseImportedVariables validates and accepts secret stubs', () => {
    const r = parseImportedVariables([
      { name: 'a', kind: 'scalar', value: 1 },
      { name: 'tok', kind: 'scalar', secret: true, value: 'leak' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0]).toEqual({ name: 'a', kind: 'scalar', value: 1 });
      expect(r.items[1]).toEqual({ name: 'tok', kind: 'scalar', secret: true });
    }
    expect(parseImportedVariables({ nope: true }).ok).toBe(false);
  });

  it('unset secret fails substitution', () => {
    const v = scalar('tok', undefined, { secret: true });
    expect(substituteVariables('SELECT ${{tok}}', [v])).toEqual({
      ok: false,
      error: 'Secret variable "tok" is unset — enter a value for this session',
    });
  });

  it('resolveVariablesForConnection can override scalar to null', () => {
    const vars = [scalar('x', 1, { overrides: { c1: { value: null } } })];
    const resolved = resolveVariablesForConnection(vars, 'c1');
    expect(resolved[0]!.value).toBeNull();
    expect(substituteVariables('SELECT ${{x}}', resolved)).toEqual({
      ok: true,
      sql: 'SELECT NULL',
    });
  });

  it('prepareStatement uses per-connection resolved values', () => {
    const base = scalar('user_id', 1, { overrides: { prod: { value: 42 } } });
    const forProd = resolveVariablesForConnection([base], 'prod');
    const r = prepareStatement('SELECT * FROM t WHERE id = ${{user_id}};', forProd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toBe('SELECT * FROM t WHERE id = 42;');
  });

  it('stripSecretsForPersist drops secret list and table variables too', () => {
    const secretList = list('ids', [1, 2], { secret: true });
    const secretTable: SqlVariable = {
      id: 't',
      name: 't',
      kind: 'table',
      secret: true,
      columns: ['id', 'name'],
      rows: [[1, 'a']],
      updatedAt: 1,
    };
    const plain = scalar('n', 1);
    const stripped = stripSecretsForPersist([secretList, secretTable, plain]);
    expect(stripped.map((v) => v.name)).toEqual(['n']);
  });

  it('exportVariables includes list/table bodies and omits empty overrides', () => {
    const vars: SqlVariable[] = [
      list('ids', [1, 2], { overrides: { c1: { values: [9] } } }),
      table('t', ['a'], [[1]]),
      scalar('x', 1, { overrides: {} }),
    ];
    const exported = exportVariables(vars);
    expect(exported[0]).toEqual({
      name: 'ids',
      kind: 'list',
      values: [1, 2],
      overrides: { c1: { values: [9] } },
    });
    expect(exported[1]).toEqual({ name: 't', kind: 'table', columns: ['a'], rows: [[1]] });
    expect(exported[2]).toEqual({ name: 'x', kind: 'scalar', value: 1 });
  });

  it('parseImportedVariables round-trips list and table; rejects bad list', () => {
    const ok = parseImportedVariables([
      { name: 'ids', kind: 'list', values: [1, 2] },
      { name: 't', kind: 'table', columns: ['id'], rows: [[1]] },
    ]);
    expect(ok).toEqual({
      ok: true,
      items: [
        { name: 'ids', kind: 'list', values: [1, 2] },
        { name: 't', kind: 'table', columns: ['id'], rows: [[1]] },
      ],
    });
    expect(parseImportedVariables([{ name: 'bad', kind: 'list' }]).ok).toBe(false);
    expect(parseImportedVariables([{ name: '1bad', kind: 'scalar' }]).ok).toBe(false);
  });

  it('prepareStatement can mask secrets for display without failing when unset', () => {
    const v = scalar('tok', undefined, { secret: true });
    const r = prepareStatement('SELECT ${{tok}}', [v], { maskSecrets: true });
    expect(r).toEqual({ ok: true, sql: 'SELECT (secret)', directives: [] });
  });

  it('sqlForDisplay fills public vars and masks secrets', () => {
    const vars = [scalar('id', 7), scalar('tok', 'shh', { secret: true })];
    expect(sqlForDisplay('SELECT ${{id}}, ${{tok}}', vars)).toBe('SELECT 7, (secret)');
  });

  it('recentQuerySql keeps editor source when a secret was interpolated', () => {
    const vars = [scalar('id', 7), scalar('tok', 'shh', { secret: true })];
    expect(
      recentQuerySql(
        'SELECT ${{id}} WHERE t = ${{tok}}',
        "SELECT 7 WHERE t = 'shh'",
        vars
      )
    ).toBe('SELECT ${{id}} WHERE t = ${{tok}}');
    expect(recentQuerySql('SELECT ${{id}}', 'SELECT 7', [scalar('id', 7)])).toBe('SELECT 7');
  });

  it('maskSecrets only masks secret refs in mixed SQL', () => {
    const vars = [scalar('tok', 'shh', { secret: true }), scalar('n', 3)];
    expect(
      substituteVariables('SELECT ${{tok}}, ${{n}}', vars, { maskSecrets: true })
    ).toEqual({ ok: true, sql: 'SELECT (secret), 3' });
  });

  it('applySetDirectives fails with clear errors', () => {
    expect(applySetDirectives([{ mode: 'scalar', name: 'x' }], { columns: [], rows: [] })).toEqual(
      {
        ok: false,
        error: '@set x: result has no cells to capture',
      }
    );
    expect(
      applySetDirectives([{ mode: 'column', name: 'ids', column: 'missing' }], {
        columns: ['id'],
        rows: [[1]],
      })
    ).toEqual({
      ok: false,
      error: '@set ids: column "missing" not in result',
    });
  });

  it('export → parseImportedVariables keeps secret stubs without leaked values', () => {
    const exported = exportVariables([
      scalar('tok', 'should-not-leak', { secret: true }),
      list('ids', [1], { secret: true }),
    ]);
    const parsed = parseImportedVariables(exported);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.items).toEqual([
        { name: 'tok', kind: 'scalar', secret: true },
        { name: 'ids', kind: 'list', secret: true },
      ]);
    }
  });
});
