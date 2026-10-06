import { beforeAll, describe, expect, it } from 'vitest';
import {
  formatCodeCellBody,
  formatEditorSql,
  formatSql,
  loadSqlFormatter,
  splitCodeFenceSlice,
} from './formatSql';

// Runs first, while sql-formatter has not been fetched by anything in this file.
it('returns SQL unchanged until sql-formatter has loaded, then formats it', async () => {
  expect(loadSqlFormatter.peek()).toBeUndefined();
  expect(formatSql('select id from orders', 'postgres')).toBe('select id from orders');
  await loadSqlFormatter();
  expect(formatSql('select id from orders', 'postgres')).toContain('SELECT');
});

describe('formatSql picks a grammar that parses each dialect', () => {
  beforeAll(async () => {
    await loadSqlFormatter();
  });

  // Each input is one the generic 'sql' grammar throws on, so falling back to
  // it returns the text unchanged — Format silently doing nothing.
  it.each([
    ['azuresql', 'select id from [dbo].[orders]'],
    ['cockroachdb', 'select id::int from orders'],
    ['yugabytedb', 'select id::int from orders'],
    ['redshift', 'select id::int from orders'],
  ])('%s', (dialect, sql) => {
    const out = formatSql(sql, dialect);
    expect(out).not.toBe(sql);
    expect(out).toContain('SELECT');
  });

  it('still returns unknown dialects unchanged rather than throwing', () => {
    expect(formatSql('select [x', 'nosuchdialect')).toBe('select [x');
  });
});

describe('splitCodeFenceSlice', () => {
  it('splits open / body / close', () => {
    const parts = splitCodeFenceSlice(`-- @js\nreturn 1;\n-- @end\n`, true);
    expect(parts.open).toBe('-- @js');
    expect(parts.body).toBe('return 1;');
    expect(parts.close).toBe('-- @end');
    expect(parts.trailingNl).toBe(true);
  });
});

describe('formatCodeCellBody', () => {
  it('pretty-prints javascript', async () => {
    const out = await formatCodeCellBody(
      `const x=1;return[{a:x,b:"hi"}]`,
      'js'
    );
    expect(out).toContain("const x = 1;");
    expect(out).toContain('return');
    expect(out).toMatch(/singleQuote|'/); // prettier singleQuote
    expect(out).toContain("'hi'");
  });

  it('pretty-prints typescript', async () => {
    const out = await formatCodeCellBody(
      `type Row={id:number};const rows:Row[]=[{id:1}];return rows;`,
      'ts'
    );
    expect(out).toContain('type Row');
    expect(out).toContain('number');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('leaves invalid code unchanged', async () => {
    const bad = 'const x = {';
    expect(await formatCodeCellBody(bad, 'js')).toBe(bad);
  });

  it('keeps leading -- @set and still prettier-formats the JS body', async () => {
    const out = await formatCodeCellBody(
      `-- @set doubled = table\nconst src=last?.rows??[];return{columns:['id','n'],rows:src.map((r)=>[r[0],Number(r[0])*2])};`,
      'js'
    );
    expect(out.startsWith('-- @set doubled = table')).toBe(true);
    expect(out).toContain('const src = last?.rows ?? [];');
    expect(out).toContain('Number(r[0]) * 2');
  });
});

describe('formatEditorSql', () => {
  it('formats JS fences with prettier and keeps markers', async () => {
    const input = `SELECT 1;\n-- @js\nconst x=1;return[{n:x}];\n-- @end\n`;
    const out = await formatEditorSql(input, 'postgres');
    expect(out).toContain('-- @js');
    expect(out).toContain('-- @end');
    expect(out).toMatch(/const x = 1/);
    expect(out.toUpperCase()).toContain('SELECT');
  });

  it('formats lodash-es groupBy cells with readable wraps', async () => {
    const input = `-- @js
import {groupBy,sumBy} from 'lodash-es';
const rows=last.rows.map((r)=>({kind:String(r[0]),n:Number(r[1])}));
const byKind=groupBy(rows,'kind');
return Object.keys(byKind).map((kind)=>({kind,count:byKind[kind].length,total:sumBy(byKind[kind],'n')}));
-- @end
`;
    const out = await formatEditorSql(input, 'postgres');
    expect(out).toContain(`import { groupBy, sumBy } from 'lodash-es';`);
    expect(out).toContain('kind: String(r[0]),');
    expect(out).toContain("total: sumBy(byKind[kind], 'n'),");
    expect(out.trimEnd().endsWith('-- @end')).toBe(true);
  });

  it('formats the ★ map-last sample (SQL + @set + minified JS)', async () => {
    const input = `SELECT 1 AS id, 'alice@example.com' AS email
UNION ALL
SELECT 2, 'bob@example.com';

-- @js
-- @set doubled = table
const src=last?.rows??[];return{columns:['id','email','n'],rows:src.map((r)=>[r[0],r[1],Number(r[0])*2])};
-- @end
`;
    const out = await formatEditorSql(input, 'sqlite');
    expect(out).toContain('-- @set doubled = table');
    expect(out).toContain('const src = last?.rows ?? [];');
    expect(out).toContain("columns: ['id', 'email', 'n'],");
  });
});
