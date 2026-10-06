import { describe, expect, it, vi } from 'vitest';
import { detectCodeCell, prepareCodeCellSource, runCodeCell } from './codeCellRunner';
import { transpileCodeCell } from '@/shared/api/sqlApi';

// TypeScript cells compile on the server (POST /sql/code-cell/transpile, tested
// in editor.routes.test.ts); here the same compiler call stands in for it.
vi.mock('@/shared/api/sqlApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/sqlApi')>()),
  transpileCodeCell: vi.fn((await import('./transpileLikeServer')).transpileLikeServer),
}));

describe('detectCodeCell', () => {
  it('detects js and ts fences', () => {
    expect(detectCodeCell(`-- @js\nreturn [];\n-- @end`)).toMatchObject({
      kind: 'js',
      closed: true,
    });
    expect(detectCodeCell(`-- @typescript\nreturn [];\n-- @end`)).toMatchObject({
      kind: 'ts',
      closed: true,
    });
    expect(detectCodeCell(`-- @node\nreturn [];\n-- @end`)).toMatchObject({
      kind: 'node',
      closed: true,
    });
    expect(detectCodeCell(`-- @nodets\nreturn [];\n-- @end`)).toMatchObject({
      kind: 'nodets',
      closed: true,
    });
  });

  it('skips leading @set when detecting', () => {
    const cell = detectCodeCell(`-- @set out = table\n-- @js\nreturn last;\n-- @end`);
    expect(cell).toMatchObject({ kind: 'js', closed: true });
    expect(cell?.body).toContain('return last');
  });

  it('returns null for plain SQL', () => {
    expect(detectCodeCell('SELECT 1;')).toBeNull();
  });

  it('marks unclosed fences', () => {
    expect(detectCodeCell(`-- @js\nreturn [];`)).toMatchObject({
      kind: 'js',
      closed: false,
    });
  });
});

describe('runCodeCell', () => {
  it('runs a JS cell via sync fallback when Worker is unavailable', async () => {
    const { result, directives } = await runCodeCell({
      statement: `-- @js
-- @set doubled = table
return last.rows.map((r) => ({ id: r[0], n: Number(r[0]) * 2 }));
-- @end`,
      last: { columns: ['id'], rows: [[5]], rowCount: 1 },
      variables: [],
      maxRows: 100,
    });
    expect(directives).toEqual([{ mode: 'table', name: 'doubled' }]);
    expect(result).toMatchObject({
      ok: true,
      columns: ['id', 'n'],
      rowCount: 1,
      hasNext: false,
    });
    if (result.ok) expect(result.rows).toEqual([[5, 10]]);
  });

  it('transpiles TypeScript cells before execution', async () => {
    vi.mocked(transpileCodeCell).mockClear();
    const { result } = await runCodeCell({
      statement: `-- @ts
const factor: number = 3;
const out = (last ? last.rows : []).map((r: unknown[]) => ({
  id: Number(r[0]),
  n: Number(r[0]) * factor,
}));
return out;
-- @end`,
      last: { columns: ['id'], rows: [[2], [4]], rowCount: 2 },
      variables: [],
      maxRows: 100,
    });
    if (!result.ok) {
      throw new Error(`TS cell failed: ${result.error}`);
    }
    expect(result).toMatchObject({ ok: true, rowCount: 2 });
    expect(result.columns).toEqual(['id', 'n']);
    expect(result.rows).toEqual([
      [2, 6],
      [4, 12],
    ]);
    expect(transpileCodeCell).toHaveBeenCalledTimes(1);
  });

  it('includes secret variables in the cell scope', async () => {
    const { result } = await runCodeCell({
      statement: `-- @js
return [{
  hasToken: Object.prototype.hasOwnProperty.call(vars, 'token'),
  token: vars.token.value,
  n: vars.n.value,
}];
-- @end`,
      last: null,
      variables: [
        {
          id: '1',
          name: 'token',
          kind: 'scalar',
          value: 'secret',
          secret: true,
          updatedAt: 1,
        },
        { id: '2', name: 'n', kind: 'scalar', value: 42, updatedAt: 1 },
      ],
      maxRows: 10,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.rows).toEqual([[true, 'secret', 42]]);
  });

  it('returns an error for non-code statements', async () => {
    const { result, directives } = await runCodeCell({
      statement: 'SELECT 1;',
      last: null,
      variables: [],
      maxRows: 10,
    });
    expect(directives).toEqual([]);
    expect(result).toMatchObject({ ok: false, error: 'Not a code cell' });
  });

  it('surfaces TypeScript transpile failures', async () => {
    const { result } = await runCodeCell({
      statement: `-- @ts
const x: = 1;
return [];
-- @end`,
      last: null,
      variables: [],
      maxRows: 10,
    });
    // Some TS parse errors still emit JS; accept either transpile or runtime failure.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('keeps prepareCodeCellSource body free of fence markers', () => {
    const prepared = prepareCodeCellSource(`-- @js
return [{ ok: true }];
-- @end`);
    expect(prepared).toMatchObject({
      ok: true,
      kind: 'js',
      body: 'return [{ ok: true }];',
      directives: [],
    });
  });
});
