/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The editor range a rail number selects: the statement's own characters.
 * Whole lines would also take in a second statement written on the same
 * line, and Run then runs both.
 */
import type { SplitStatement } from '@/shared/lib/sql-splitter';

/** What this needs from a Monaco model. */
export interface OffsetModel {
  getPositionAt(offset: number): { lineNumber: number; column: number };
}

export interface StatementRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export function statementSelectionRange(stmt: Pick<SplitStatement, 'start' | 'end'>, model: OffsetModel): StatementRange {
  const from = model.getPositionAt(stmt.start);
  const to = model.getPositionAt(stmt.end);
  return {
    startLineNumber: from.lineNumber,
    startColumn: from.column,
    endLineNumber: to.lineNumber,
    endColumn: to.column,
  };
}
