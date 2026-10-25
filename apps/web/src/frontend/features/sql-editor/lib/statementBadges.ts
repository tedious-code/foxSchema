/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the run rail says about each statement, and the text "Copy statement
 * with values" puts on the clipboard.
 *
 * Both came from the statement strip. Moving the run checks into a rail
 * beside the editor dropped them — and with them the red mark on a DELETE or
 * UPDATE that has no WHERE, which is the warning that matters before Run.
 */
import {
  CODE_CELL_KIND_LABEL,
  dmlLacksWhere,
  isCodeCellKind,
  isMutatingDmlStatement,
  statementVerb,
  type CodeCellKind,
  type SplitStatement,
} from '@/shared/lib/sql-splitter';
import { findVariableRefs, substituteVariables, type SqlVariable } from '@/shared/lib/sql-variables';

const DML_BADGE: Record<string, 'UPD' | 'DEL' | 'MRG'> = {
  update: 'UPD',
  delete: 'DEL',
  merge: 'MRG',
};

export interface StatementBadge {
  codeKind: CodeCellKind | null;
  /** Safe mode only: a write Run will ask to confirm, and whether it has no WHERE. */
  dml: { badge: 'UPD' | 'DEL' | 'MRG'; noWhere: boolean } | null;
}

export function statementBadge(stmt: SplitStatement, safeMode: boolean): StatementBadge {
  const codeKind = isCodeCellKind(stmt.kind) ? stmt.kind : null;
  if (codeKind || !safeMode) return { codeKind, dml: null };
  const verb = statementVerb(stmt.text);
  const badge = verb && isMutatingDmlStatement(stmt.text) ? DML_BADGE[verb] : undefined;
  return { codeKind, dml: badge ? { badge, noWhere: dmlLacksWhere(stmt.text) } : null };
}

/** The rail label's tooltip: which cell, what kind, and any Safe-mode warning. */
export function statementTitle(index: number, badge: StatementBadge): string {
  const kind = badge.codeKind ? `${CODE_CELL_KIND_LABEL[badge.codeKind].long} code cell` : 'SQL';
  const dml = badge.dml
    ? badge.dml.noWhere
      ? ` · ${badge.dml.badge}: no WHERE — may affect all rows`
      : ` · Safe mode: ${badge.dml.badge} asks for confirmation on Run`
    : '';
  return `In [${index + 1}] · ${kind}${dml}. Click to select it.`;
}

/** The statement with its `${{variables}}` filled in, secrets masked. */
export function statementCopyText(
  text: string,
  variables: SqlVariable[]
): { sql: string; error?: string; hasVars: boolean } {
  const hasVars = findVariableRefs(text).length > 0;
  if (!hasVars) return { sql: text, hasVars: false };
  const expanded = substituteVariables(text, variables, { maskSecrets: true });
  if (!expanded.ok) return { sql: text, error: expanded.error, hasVars: true };
  return { sql: expanded.sql, hasVars: true };
}
