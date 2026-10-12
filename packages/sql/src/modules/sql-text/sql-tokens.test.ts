/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { sqlTokens, type SqlTokenOptions } from './sql-tokens.js';

/** The meaningful tokens of `sql`, as text. */
const code = (sql: string, options?: SqlTokenOptions) =>
  [...sqlTokens(sql, options)].filter((t) => t.kind !== 'space' && t.kind !== 'comment').map((t) => sql.slice(t.start, t.end));

describe('sqlTokens', () => {
  it('covers the text exactly, in order', () => {
    const sql = "SELECT 'a''b', \"q\" /* c */ -- d\nFROM $$x$$ t";
    const tokens = [...sqlTokens(sql)];
    expect(tokens.map((t) => sql.slice(t.start, t.end)).join('')).toBe(sql);
    expect(tokens.every((t, i) => i === 0 || t.start === tokens[i - 1]!.end)).toBe(true);
  });

  it('reads a MySQL executable comment as a comment unless asked', () => {
    expect(code("SELECT 1 /*!INTO OUTFILE '/tmp/x' */")).toEqual(['SELECT', '1']);
  });

  it('reads the inside of a MySQL executable comment as code when asked, version and all', () => {
    const options = { executableComments: true };
    expect(code("SELECT 1 /*!INTO OUTFILE '/tmp/x' */", options)).toEqual(['SELECT', '1', 'INTO', 'OUTFILE', "'/tmp/x'"]);
    expect(code('SELECT * FROM t /*!50001 FOR UPDATE */', options)).toEqual(['SELECT', '*', 'FROM', 't', 'FOR', 'UPDATE']);
    // Not executable: a plain comment, an optimizer hint, and the marker inside a string.
    expect(code('SELECT 1 /* INTO */', options)).toEqual(['SELECT', '1']);
    expect(code('/*+ INDEX(t i) */ SELECT 1', options)).toEqual(['SELECT', '1']);
    expect(code("SELECT '/*!INTO x*/'", options)).toEqual(['SELECT', "'/*!INTO x*/'"]);
  });

  it('still covers the text exactly with executable comments read as code', () => {
    const sql = 'SELECT 1 /*!50001 , 2 */ FROM t';
    const tokens = [...sqlTokens(sql, { executableComments: true })];
    expect(tokens.map((t) => sql.slice(t.start, t.end)).join('')).toBe(sql);
  });
});

describe('from an offset', () => {
  it('starts at the offset given, and lexes nothing before it', () => {
    const sql = "SELECT 'a;b'; DELETE FROM t";
    expect([...sqlTokens(sql, {}, sql.indexOf('DELETE'))].filter((t) => t.kind !== 'space').map((t) => t.upper)).toEqual([
      'DELETE',
      'FROM',
      'T',
    ]);
  });
});
