/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';
import { statementSelectionRange, type OffsetModel } from './statementSelection';

/** Monaco's getPositionAt over a plain string: 1-based lines and columns. */
function model(text: string): OffsetModel {
  return {
    getPositionAt(offset) {
      const before = text.slice(0, offset).split('\n');
      return { lineNumber: before.length, column: before[before.length - 1]!.length + 1 };
    },
  };
}

/** The text a range covers, for readable assertions. */
function covered(text: string, offset: { start: number; end: number }) {
  return text.slice(offset.start, offset.end);
}

describe('statementSelectionRange', () => {
  it('selects only its own statement when two share a line', () => {
    const sql = 'SELECT 1; SELECT 2;\nSELECT 3;';
    const [first, second] = splitSqlStatements(sql);
    expect(statementSelectionRange(first!, model(sql))).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 10,
    });
    expect(statementSelectionRange(second!, model(sql))).toEqual({
      startLineNumber: 1,
      startColumn: 11,
      endLineNumber: 1,
      endColumn: 20,
    });
    expect(covered(sql, second!)).toBe('SELECT 2;');
  });

  it('spans every line of a statement written over several', () => {
    const sql = '-- note\n  SELECT a,\n    b\n  FROM t;  ';
    const [stmt] = splitSqlStatements(sql);
    expect(statementSelectionRange(stmt!, model(sql))).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 10,
    });
  });
});
