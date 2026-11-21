/**
 * Shared SQL Editor code-cell value shapes (browser + Node executors).
 * Pure types + runtime predicates — safe for browser builds (this is @foxschema/sql).
 */

/**
 * Display names per fence kind. One table so the statement strip, the results
 * header and any future surface cannot drift apart; the fence tag is the key
 * itself (`-- @nodets` … `-- @end`).
 */
export const CODE_CELL_KIND_LABEL = {
  js: { short: 'JS', long: 'JavaScript' },
  ts: { short: 'TS', long: 'TypeScript' },
  node: { short: 'NODE', long: 'Node.js' },
  nodets: { short: 'NODE-TS', long: 'Node TypeScript' },
} as const satisfies Record<string, { short: string; long: string }>;

/** Previous statement grid injected as `last` (null when none). */
export type CodeCellLast = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
} | null;

/** Structured-cloneable variable bag passed into cells (secrets omitted). */
export type CodeCellVars = Record<
  string,
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; values: unknown[] }
  | { kind: 'table'; columns: string[]; rows: unknown[][] }
>;

export type CodeCellOk = {
  ok: true;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
};

export type CodeCellErr = { ok: false; error: string };

export type CodeCellResult = CodeCellOk | CodeCellErr;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((c) => typeof c === 'string');
}

function isRowMatrix(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every((r) => Array.isArray(r));
}

/** True when `v` is null or a rectangular `{ columns, rows, rowCount }` grid. */
export function isCodeCellLast(v: unknown): v is CodeCellLast {
  if (v === null) return true;
  if (!isPlainObject(v)) return false;
  if (!isStringArray(v.columns)) return false;
  if (!isRowMatrix(v.rows)) return false;
  if (typeof v.rowCount !== 'number' || !Number.isFinite(v.rowCount)) return false;
  return true;
}

/** True when `v` is a vars bag with scalar/list/table field shapes. */
export function isCodeCellVars(v: unknown): v is CodeCellVars {
  if (!isPlainObject(v)) return false;
  for (const val of Object.values(v)) {
    if (!isPlainObject(val)) return false;
    const kind = val.kind;
    if (kind === 'scalar') {
      if (!('value' in val)) return false;
      continue;
    }
    if (kind === 'list') {
      if (!isUnknownArray(val.values)) return false;
      continue;
    }
    if (kind === 'table') {
      if (!isStringArray(val.columns) || !isRowMatrix(val.rows)) return false;
      continue;
    }
    return false;
  }
  return true;
}
