/**
 * FoxScript document model — AST over the existing fence-aware SQL splitter.
 *
 * FoxScript is SQL-first with embedded `-- @js` / `-- @ts` / `-- @node` /
 * `-- @nodets` … `-- @end` cells. This module does **not** re-scan source;
 * it composes `splitSqlStatements` + `parseCodeCell` + `checkStatement` into
 * a structured tree with stable offsets for Monaco markers, virtual docs,
 * and (later) an execution plan.
 *
 * Execution still uses mapped source text today — the AST is the validation
 * and IDE spine, not a new runtime.
 */

import {
  checkStatement,
  isCodeCellKind,
  parseCodeCell,
  splitSqlStatements,
  type CodeCellKind,
  type SplitStatement,
  type StatementKind,
  type StatementStatus,
} from '@foxschema/sql';

export type FoxScriptBlockKind = StatementKind;

export interface FoxScriptRange {
  /** [start, end) character offsets in the source document. */
  start: number;
  end: number;
  /** 1-based lines (Monaco-compatible). */
  startLine: number;
  endLine: number;
}

export interface FoxScriptSqlBlock {
  type: 'sql';
  index: number;
  range: FoxScriptRange;
  text: string;
  terminated: boolean;
  status: StatementStatus;
}

export interface FoxScriptCodeBlock {
  type: 'code';
  index: number;
  range: FoxScriptRange;
  kind: CodeCellKind;
  /** Full fence text including markers. */
  text: string;
  /** Body between open and close markers (may still contain `-- @set`). */
  body: string;
  terminated: boolean;
  status: StatementStatus;
}

export type FoxScriptBlock = FoxScriptSqlBlock | FoxScriptCodeBlock;

export type FoxScriptDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface FoxScriptDiagnostic {
  severity: FoxScriptDiagnosticSeverity;
  message: string;
  range: FoxScriptRange;
  /** Stable code for tests / code actions. */
  code:
    | 'missing-end'
    | 'missing-return'
    | 'sql-incomplete'
    | 'empty-document';
  blockIndex: number;
}

export interface FoxScriptDocument {
  source: string;
  blocks: FoxScriptBlock[];
  diagnostics: FoxScriptDiagnostic[];
}

function rangeOf(stmt: SplitStatement): FoxScriptRange {
  return {
    start: stmt.start,
    end: stmt.end,
    startLine: stmt.startLine,
    endLine: stmt.endLine,
  };
}

/**
 * Parse a FoxScript buffer into blocks + structural diagnostics.
 * Empty / whitespace-only source → empty blocks and one info diagnostic.
 */
export function parseFoxScript(source: string): FoxScriptDocument {
  const trimmed = source.trim();
  if (!trimmed) {
    return {
      source,
      blocks: [],
      diagnostics: [
        {
          severity: 'info',
          message: 'Empty FoxScript document',
          range: { start: 0, end: 0, startLine: 1, endLine: 1 },
          code: 'empty-document',
          blockIndex: -1,
        },
      ],
    };
  }

  const statements = splitSqlStatements(source);
  // Code cells always need their `-- @end`; only a plain SQL statement's
  // trailing semicolon is optional, and only when nothing follows it.
  const lastIndex = statements.length - 1;
  const blocks: FoxScriptBlock[] = statements.map((stmt, index) => {
    const status = checkStatement(stmt, { last: index === lastIndex });
    const range = rangeOf(stmt);
    if (isCodeCellKind(stmt.kind)) {
      const parsed = parseCodeCell(stmt.text);
      return {
        type: 'code',
        index,
        range,
        kind: stmt.kind,
        text: stmt.text,
        body: parsed?.body ?? '',
        terminated: stmt.terminated,
        status,
      };
    }
    return {
      type: 'sql',
      index,
      range,
      text: stmt.text,
      terminated: stmt.terminated,
      status,
    };
  });

  const diagnostics: FoxScriptDiagnostic[] = [];
  for (const block of blocks) {
    for (const reason of block.status.reasons) {
      diagnostics.push({
        severity: 'warning',
        message: reason,
        range: block.range,
        code: diagnoseCode(reason, block),
        blockIndex: block.index,
      });
    }
  }

  return { source, blocks, diagnostics };
}

function diagnoseCode(
  reason: string,
  block: FoxScriptBlock
): FoxScriptDiagnostic['code'] {
  if (/missing -- @end/i.test(reason)) return 'missing-end';
  if (/return statement/i.test(reason)) return 'missing-return';
  if (block.type === 'sql') return 'sql-incomplete';
  return 'sql-incomplete';
}

/** Blocks that a Run / Play would execute, in order. */
export function foxScriptExecutableTexts(doc: FoxScriptDocument): string[] {
  return doc.blocks.map((b) => b.text);
}

/**
 * Lightweight execution plan: ordered steps mapped back to source.
 * Runtime still executes `source` text via existing SQL / code-cell paths.
 */
export interface FoxScriptPlanStep {
  index: number;
  kind: FoxScriptBlockKind;
  source: string;
  range: FoxScriptRange;
}

export interface FoxScriptExecutionPlan {
  steps: FoxScriptPlanStep[];
  /** True when any structural warning would make a "strict" run refuse. */
  hasStructuralWarnings: boolean;
}

export function compileFoxScriptPlan(doc: FoxScriptDocument): FoxScriptExecutionPlan {
  return {
    steps: doc.blocks.map((b) => ({
      index: b.index,
      kind: b.type === 'code' ? b.kind : 'sql',
      source: b.text,
      range: b.range,
    })),
    hasStructuralWarnings: doc.diagnostics.some((d) => d.severity === 'warning'),
  };
}
