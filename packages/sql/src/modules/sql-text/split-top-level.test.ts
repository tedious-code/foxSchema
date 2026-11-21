import { describe, expect, it } from 'vitest';
import { splitTopLevel } from './split-top-level.js';

describe('splitTopLevel', () => {
  it('splits on a top-level comma only', () => {
    expect(splitTopLevel("a, f(b, c), 'x,y', [d,e]", ',')).toEqual(['a', 'f(b, c)', "'x,y'", '[d,e]']);
  });

  it('splits on a keyword at word boundaries, any case', () => {
    expect(splitTopLevel("a = 1 and brand = 'AND' AND (b OR c)", 'AND')).toEqual([
      'a = 1',
      "brand = 'AND'",
      '(b OR c)',
    ]);
  });

  it('keeps doubled quotes inside a string', () => {
    expect(splitTopLevel("'it''s, fine', b", ',')).toEqual(["'it''s, fine'", 'b']);
  });

  it('splits a qualified name on dots', () => {
    expect(splitTopLevel('"my.schema".tbl', '.')).toEqual(['"my.schema"', 'tbl']);
  });
});
