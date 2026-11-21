import { describe, expect, it } from 'vitest';
import { isCodeCellLast, isCodeCellVars } from './code-cell-types.js';

describe('isCodeCellLast', () => {
  it('accepts null and well-formed grids', () => {
    expect(isCodeCellLast(null)).toBe(true);
    expect(
      isCodeCellLast({ columns: ['a'], rows: [[1], [2]], rowCount: 2 })
    ).toBe(true);
  });

  it('rejects non-string columns or non-matrix rows', () => {
    expect(isCodeCellLast({ columns: [1], rows: [[1]], rowCount: 1 })).toBe(false);
    expect(isCodeCellLast({ columns: ['a'], rows: [1], rowCount: 1 })).toBe(false);
    expect(isCodeCellLast({ columns: ['a'], rows: [[1]], rowCount: 'x' })).toBe(false);
    expect(isCodeCellLast({})).toBe(false);
  });
});

describe('isCodeCellVars', () => {
  it('accepts scalar / list / table shapes', () => {
    expect(
      isCodeCellVars({
        n: { kind: 'scalar', value: 1 },
        ids: { kind: 'list', values: [1, 2] },
        t: { kind: 'table', columns: ['a'], rows: [[9]] },
      })
    ).toBe(true);
    expect(isCodeCellVars({})).toBe(true);
  });

  it('rejects missing payload fields', () => {
    expect(isCodeCellVars({ n: { kind: 'scalar' } })).toBe(false);
    expect(isCodeCellVars({ ids: { kind: 'list' } })).toBe(false);
    expect(isCodeCellVars({ t: { kind: 'table', columns: ['a'] } })).toBe(false);
    expect(isCodeCellVars({ bad: { kind: 'other' } })).toBe(false);
    expect(isCodeCellVars([])).toBe(false);
  });
});
