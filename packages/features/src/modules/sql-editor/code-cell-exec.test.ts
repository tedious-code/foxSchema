import { describe, expect, it } from 'vitest';
import {
  assertCodeCellSandboxSafe,
  normalizeCodeCellReturn,
  runCodeCellBody,
} from './code-cell-exec.js';

describe('assertCodeCellSandboxSafe', () => {
  it('allows ordinary transform cells', () => {
    expect(assertCodeCellSandboxSafe('return last.rows.map((r) => ({ id: r[0] }));').ok).toBe(
      true
    );
    expect(
      assertCodeCellSandboxSafe(`import _ from 'lodash';\nreturn _.map([1], (n) => ({ n }));`).ok
    ).toBe(true);
  });

  it('blocks dynamic import / require / eval / Function / .constructor', () => {
    expect(assertCodeCellSandboxSafe('return await import("node:fs");').ok).toBe(false);
    expect(assertCodeCellSandboxSafe('return require("fs");').ok).toBe(false);
    expect(assertCodeCellSandboxSafe('return eval("1");').ok).toBe(false);
    expect(assertCodeCellSandboxSafe('const e = (0, eval);\nreturn e("1");').ok).toBe(false);
    expect(assertCodeCellSandboxSafe('return Function("return 1")();').ok).toBe(false);
    expect(assertCodeCellSandboxSafe('const F = Function;\nreturn F("return 1")();').ok).toBe(
      false
    );
    expect(
      assertCodeCellSandboxSafe(`return (function(){}).constructor('return process')();`).ok
    ).toBe(false);
    expect(
      assertCodeCellSandboxSafe(`const F = (async function () {}).constructor;\nreturn F;`).ok
    ).toBe(false);
    expect(
      assertCodeCellSandboxSafe(`const F = (async function () {})["constructor"];\nreturn F;`).ok
    ).toBe(false);
    expect(
      assertCodeCellSandboxSafe(
        `const F = Reflect.get(async function () {}, "constructor");\nreturn F;`
      ).ok
    ).toBe(false);
  });

  it('does not false-positive on the word import inside a string', () => {
    expect(assertCodeCellSandboxSafe(`return [{ note: "do not import(fs)" }];`).ok).toBe(true);
  });
});

describe('runCodeCellBody sandbox gate', () => {
  it('fails closed before executing a dynamic import', async () => {
    const r = await runCodeCellBody({
      body: `const fs = await import('node:fs');\nreturn [{ x: 1 }];`,
      last: null,
      vars: {},
      maxRows: 10,
      preamble: '',
      modules: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dynamic import/i);
  });
});

describe('normalizeCodeCellReturn', () => {
  it('keeps explicit { columns, rows } grids', () => {
    const r = normalizeCodeCellReturn(
      { columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']] },
      100
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns).toEqual(['id', 'name']);
      expect(r.rows).toEqual([
        [1, 'a'],
        [2, 'b'],
      ]);
    }
  });

  it('treats a single plain object as one row (not a broken grid)', () => {
    const r = normalizeCodeCellReturn({ id: 7, email: 'a@b.c' }, 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns).toEqual(['id', 'email']);
      expect(r.rows).toEqual([[7, 'a@b.c']]);
      expect(r.rowCount).toBe(1);
    }
  });

  it('does not mis-classify data objects that mention columns/rows keys', () => {
    const r = normalizeCodeCellReturn({ columns: 3, rows: 5, label: 'x' }, 100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.columns).toEqual(['columns', 'rows', 'label']);
      expect(r.rows).toEqual([[3, 5, 'x']]);
    }
  });

  it('wraps scalar returns under a value column', () => {
    expect(normalizeCodeCellReturn(42, 100)).toEqual({
      ok: true,
      columns: ['value'],
      rows: [[42]],
      rowCount: 1,
      truncated: false,
    });
    expect(normalizeCodeCellReturn('hi', 100)).toMatchObject({
      ok: true,
      columns: ['value'],
      rows: [['hi']],
    });
    expect(normalizeCodeCellReturn(true, 100)).toMatchObject({
      rows: [[true]],
    });
    expect(normalizeCodeCellReturn(10n, 100)).toMatchObject({
      rows: [['10']],
    });
  });

  it('wraps Date scalars as ISO strings', () => {
    const d = new Date('2026-08-02T00:00:00.000Z');
    const r = normalizeCodeCellReturn(d, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toEqual([['2026-08-02T00:00:00.000Z']]);
  });

  it('accepts arrays of scalars and mixed object/scalar rows', () => {
    const scalars = normalizeCodeCellReturn([1, 2, null], 100);
    expect(scalars.ok).toBe(true);
    if (scalars.ok) {
      expect(scalars.columns).toEqual(['value']);
      expect(scalars.rows).toEqual([[1], [2], [null]]);
    }

    const mixed = normalizeCodeCellReturn([{ id: 1 }, 9], 100);
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.columns.sort()).toEqual(['id', 'value'].sort());
      expect(mixed.rowCount).toBe(2);
    }
  });
});
