export {
  checkStatement,
  isWriteStatement,
  requiresWritePermission,
  firstKeyword,
  extractTableAliases,
  countReferencedTables,
  referencedTableNames,
  collectMultiTableWriteWarnings,
  statementVerb,
  isMutatingDmlStatement,
  isInsertWriteStatement,
  isPageableStatement,
  dmlLacksWhere,
  parseCodeCell,
  findCodeFences,
  stripJsStringsAndComments,
  stripCodeFenceMarkers,
  codeCellHasReturn,
  stripFullLineSqlComments,
  isCodeCellKind,
  isNodeCodeCellKind,
  codeCellNeedsTs,
  nodeCodeCellWireKind,
  isCodeCellLast,
  isCodeCellVars,
  CODE_CELL_KIND_LABEL,
} from '@foxschema/ui-shared';
export type {
  SplitStatement,
  StatementStatus,
  StatementKind,
  CodeCellKind,
  BrowserCodeCellKind,
  NodeCodeCellKind,
  TsCodeCellKind,
  CodeCellLast,
  CodeCellVars,
  CodeCellOk,
  CodeCellErr,
  CodeCellResult,
  MultiTableWriteWarning,
} from '@foxschema/ui-shared';

export {
  CODE_CELL_ALLOWED_PACKAGES,
  parseCodeCellImports,
  resolveCodeCellImportBindings,
  prepareCodeCellImports,
  normalizeCodeCellReturn,
  cloneCodeCellLast,
  runCodeCellBody,
} from '@foxschema/ui-shared';
export type {
  CodeCellAllowedPackage,
  CodeCellImportSpec,
  RunCodeCellBodyArgs,
} from '@foxschema/ui-shared';

import {
  splitSqlStatements as splitSqlStatementsUncached,
  parseFoxScript as parseFoxScriptUncached,
} from '@foxschema/ui-shared';
import type { SplitStatement, FoxScriptDocument } from '@foxschema/ui-shared';

/** Tiny LRU so keystroke paths (store + strip + gutter) reuse one split of the same buffer. */
const SPLIT_CACHE = new Map<string, SplitStatement[]>();
const SPLIT_CACHE_MAX = 4;

function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
  if (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export function splitSqlStatements(sql: string): SplitStatement[] {
  const hit = lruGet(SPLIT_CACHE, sql);
  if (hit) return hit;
  const stmts = splitSqlStatementsUncached(sql);
  lruSet(SPLIT_CACHE, sql, stmts, SPLIT_CACHE_MAX);
  return stmts;
}

/** Same LRU idea for FoxScript IDE paths (markers / virtual docs / semantic tokens). */
const FOX_CACHE = new Map<string, FoxScriptDocument>();
const FOX_CACHE_MAX = 4;

export function parseFoxScript(source: string): FoxScriptDocument {
  const hit = lruGet(FOX_CACHE, source);
  if (hit) return hit;
  const doc = parseFoxScriptUncached(source);
  lruSet(FOX_CACHE, source, doc, FOX_CACHE_MAX);
  return doc;
}

export {
  sqlTag,
  renderSqlQuery,
  identityInsertFor,
  identityInsertSupport,
  isSqlQuery,
  makeSqlQuery,
  placeholderStyleFor,
  quoteSqlIdentifier,
  compileFoxScriptPlan,
  foxScriptExecutableTexts,
} from '@foxschema/ui-shared';
export type {
  SqlQuery,
  SqlTag,
  RenderedSql,
  SqlPlaceholderStyle,
  FoxScriptBlock,
  FoxScriptCodeBlock,
  FoxScriptSqlBlock,
  FoxScriptDocument,
  FoxScriptDiagnostic,
  FoxScriptExecutionPlan,
  FoxScriptPlanStep,
  FoxScriptRange,
  FoxScriptBlockKind,
  CodeFenceRange,
} from '@foxschema/ui-shared';
