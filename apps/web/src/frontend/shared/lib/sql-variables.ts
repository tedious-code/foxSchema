/** Max values kept when saving a result column as a list variable. */
export const SQL_VARIABLE_LIST_MAX = 500;
/** Max rows kept when saving a result as a table variable. */
export const SQL_VARIABLE_TABLE_MAX = 500;

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Matches `${{name}}` or `${{name.col}}` — not `$var` or `${x}`.
 * Group 1 = variable name, group 2 = optional column.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- false positive: fixed `${{` prefix; identifier classes are bounded
const VAR_REF_RE = /\$\{\{([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\}\}/g;

/** `-- @set name` / `-- @set name = column Col` / `-- @set name = table` */
const SET_LINE_RE =
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: anchored line; bounded identifier + simple alternatives
  /^--\s*@set\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(column\s+(\S+)|table))?\s*$/i;

export type SqlVariableKind = 'scalar' | 'list' | 'table';

/** Per-connection override for scalar / list (tables stay global). */
export type VariableOverride = {
  value?: unknown;
  values?: unknown[];
};

export interface SqlVariable {
  id: string;
  name: string;
  kind: SqlVariableKind;
  /** Present when kind === 'scalar'. */
  value?: unknown;
  /** Present when kind === 'list'. */
  values?: unknown[];
  /** Present when kind === 'table'. */
  columns?: string[];
  rows?: unknown[][];
  /** When true, UI masks the value; secret payloads are not persisted. */
  secret?: boolean;
  /** Optional scalar/list overrides keyed by connection id. */
  overrides?: Record<string, VariableOverride>;
  updatedAt: number;
}

/** JSON shape for export / import (no ids). */
export type SqlVariableExport = {
  name: string;
  kind: SqlVariableKind;
  secret?: boolean;
  value?: unknown;
  values?: unknown[];
  columns?: string[];
  rows?: unknown[][];
  overrides?: Record<string, VariableOverride>;
};

export type VariableRef = { name: string; column?: string };

function variableRefKey(name: string, column?: string): string {
  return column ? `${name}.${column}` : name;
}

/** Editor snippet for a variable or secret: `${{name}}` / `${{name.col}}`. */
export function variableRefText(name: string, column?: string): string {
  return '${{' + variableRefKey(name, column) + '}}';
}

export type SetDirective =
  | { mode: 'scalar'; name: string }
  | { mode: 'column'; name: string; column: string }
  | { mode: 'table'; name: string };

export function isValidVariableName(name: string): boolean {
  return VAR_NAME_RE.test(name);
}

export function normalizeVariableName(raw: string): string {
  return raw.trim();
}

/** Unique refs in order of first appearance (`name` or `name.col`). */
export function findVariableRefs(sql: string): VariableRef[] {
  const seen = new Set<string>();
  const out: VariableRef[] = [];
  VAR_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_REF_RE.exec(sql)) !== null) {
    const name = m[1]!;
    const column = m[2];
    const key = variableRefKey(name, column);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(column ? { name, column } : { name });
  }
  return out;
}

/** Expand one cell value to a SQL literal fragment. */
export function expandSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    // Always quote strings (including "true"/"false"/numeric text from drivers).
    return quoteSqlString(value);
  }
  if (value instanceof Date) return quoteSqlString(value.toISOString());
  if (typeof value === 'object') {
    try {
      return quoteSqlString(JSON.stringify(value));
    } catch {
      return quoteSqlString(String(value));
    }
  }
  return quoteSqlString(String(value));
}

function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function expandListValues(name: string, values: unknown[]): SubstituteResult {
  if (values.length === 0) {
    return { ok: false, error: `Variable "${name}" is an empty list` };
  }
  return { ok: true, sql: values.map(expandSqlLiteral).join(',') };
}

function expandTableValues(
  name: string,
  columns: string[],
  rows: unknown[][]
): SubstituteResult {
  if (rows.length === 0) {
    return { ok: false, error: `Variable "${name}" is an empty table` };
  }
  if (columns.length === 0) {
    return { ok: false, error: `Variable "${name}" has no columns` };
  }
  const tuples = rows.map((row) => {
    const cells = columns.map((_, i) => expandSqlLiteral(row[i]));
    return `(${cells.join(',')})`;
  });
  return { ok: true, sql: `VALUES ${tuples.join(',')}` };
}

function columnIndex(columns: string[], colName: string): number {
  const want = colName.toLowerCase();
  return columns.findIndex((c) => c.toLowerCase() === want);
}

/** True when a secret has no in-memory value (e.g. after reload). */
export function isSecretUnset(variable: SqlVariable): boolean {
  if (!variable.secret) return false;
  if (variable.kind === 'scalar') return variable.value === undefined;
  if (variable.kind === 'list') return !variable.values || variable.values.length === 0;
  return !variable.rows || variable.rows.length === 0;
}

/** Expand a bare variable (no `.col`). */
export function expandVariable(
  variable: SqlVariable
): { ok: true; sql: string } | { ok: false; error: string } {
  if (isSecretUnset(variable)) {
    return {
      ok: false,
      error: `Secret variable "${variable.name}" is unset — enter a value for this session`,
    };
  }
  if (variable.kind === 'scalar') {
    return { ok: true, sql: expandSqlLiteral(variable.value) };
  }
  if (variable.kind === 'list') {
    return expandListValues(variable.name, variable.values ?? []);
  }
  return expandTableValues(variable.name, variable.columns ?? [], variable.rows ?? []);
}

/** Expand `${{name}}` or `${{name.col}}`. */
export function expandVariableRef(
  variable: SqlVariable,
  column?: string
): { ok: true; sql: string } | { ok: false; error: string } {
  if (!column) return expandVariable(variable);

  if (variable.kind === 'table') {
    const cols = variable.columns ?? [];
    const idx = columnIndex(cols, column);
    if (idx < 0) {
      return {
        ok: false,
        error: `Variable "${variable.name}" has no column "${column}"`,
      };
    }
    return expandListValues(
      `${variable.name}.${column}`,
      columnToListValues(variable.rows ?? [], idx)
    );
  }

  if (variable.kind === 'list' || variable.kind === 'scalar') {
    return {
      ok: false,
      error: `Variable "${variable.name}" is ${variable.kind}; use ${variableRefText(variable.name)} without .${column}`,
    };
  }

  return { ok: false, error: `Variable "${variable.name}" cannot expand .${column}` };
}

export type SubstituteOk = { ok: true; sql: string };
export type SubstituteErr = { ok: false; error: string };
export type SubstituteResult = SubstituteOk | SubstituteErr;

export type SubstituteOptions = {
  /** Replace secret variable refs with `(secret)` instead of the real literal. */
  maskSecrets?: boolean;
};

/**
 * Replace `${{name}}` / `${{name.col}}` refs with SQL literals.
 * Unknown syntax (`$x`, `${x}`) is left unchanged.
 */
export function substituteVariables(
  sql: string,
  variables: SqlVariable[],
  opts?: SubstituteOptions
): SubstituteResult {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const refs = findVariableRefs(sql);
  const cache = new Map<string, string>();

  for (const ref of refs) {
    const key = variableRefKey(ref.name, ref.column);
    const v = byName.get(ref.name);
    if (!v) return { ok: false, error: `Undefined variable: ${ref.name}` };
    if (opts?.maskSecrets && v.secret) {
      cache.set(key, '(secret)');
      continue;
    }
    const expanded = expandVariableRef(v, ref.column);
    if (!expanded.ok) return expanded;
    cache.set(key, expanded.sql);
  }

  VAR_REF_RE.lastIndex = 0;
  const out = sql.replace(VAR_REF_RE, (_full, name: string, column?: string) => {
    return cache.get(variableRefKey(name, column))!;
  });
  return { ok: true, sql: out };
}

/**
 * Merge per-connection scalar/list overrides over the global base.
 * Table variables are unchanged.
 */
export function resolveVariablesForConnection(
  variables: SqlVariable[],
  connectionId: string
): SqlVariable[] {
  return variables.map((v) => {
    if (v.kind === 'table') return v;
    const o = v.overrides?.[connectionId];
    if (!o) return v;
    if (v.kind === 'scalar' && Object.prototype.hasOwnProperty.call(o, 'value')) {
      return { ...v, value: o.value };
    }
    if (v.kind === 'list' && o.values !== undefined) {
      return { ...v, values: o.values };
    }
    return v;
  });
}

/**
 * Secrets live in the vault (and this session). Persisting a name-only stub
 * put a deleted secret back in Variables after reload.
 */
export function stripSecretsForPersist(variables: SqlVariable[]): SqlVariable[] {
  return variables.filter((v) => !v.secret).map((v) => ({ ...v }));
}

/** Serialize variables for download; secret values are omitted. */
export function exportVariables(variables: SqlVariable[]): SqlVariableExport[] {
  return variables.map((v) => {
    const base: SqlVariableExport = {
      name: v.name,
      kind: v.kind,
      ...(v.secret ? { secret: true } : {}),
    };
    if (v.secret) return base;
    if (v.kind === 'scalar') {
      return {
        ...base,
        value: v.value,
        ...(v.overrides && Object.keys(v.overrides).length > 0
          ? { overrides: v.overrides }
          : {}),
      };
    }
    if (v.kind === 'list') {
      return {
        ...base,
        values: v.values,
        ...(v.overrides && Object.keys(v.overrides).length > 0
          ? { overrides: v.overrides }
          : {}),
      };
    }
    return {
      ...base,
      columns: v.columns,
      rows: v.rows,
    };
  });
}

/** Validate import JSON; returns normalized export items. */
export function parseImportedVariables(
  raw: unknown
): { ok: true; items: SqlVariableExport[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Import must be a JSON array of variables' };
  }
  const items: SqlVariableExport[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') {
      return { ok: false, error: 'Each import entry must be an object' };
    }
    const r = row as Record<string, unknown>;
    const name = typeof r.name === 'string' ? normalizeVariableName(r.name) : '';
    if (!isValidVariableName(name)) {
      return { ok: false, error: `Invalid variable name: ${String(r.name)}` };
    }
    const kind = r.kind;
    if (kind !== 'scalar' && kind !== 'list' && kind !== 'table') {
      return { ok: false, error: `Invalid kind for "${name}"` };
    }
    const secret = r.secret === true;
    const item: SqlVariableExport = { name, kind, ...(secret ? { secret: true } : {}) };
    if (!secret) {
      if (kind === 'scalar') item.value = r.value;
      if (kind === 'list') {
        if (!Array.isArray(r.values)) {
          return { ok: false, error: `List "${name}" needs a values array` };
        }
        item.values = r.values;
      }
      if (kind === 'table') {
        if (!Array.isArray(r.columns)) {
          return { ok: false, error: `Table "${name}" needs columns` };
        }
        item.columns = r.columns as string[];
        item.rows = Array.isArray(r.rows) ? (r.rows as unknown[][]) : [];
      }
      if (r.overrides && typeof r.overrides === 'object' && !Array.isArray(r.overrides)) {
        item.overrides = r.overrides as Record<string, VariableOverride>;
      }
    }
    items.push(item);
  }
  return { ok: true, items };
}

/**
 * Parse leading `-- @set …` comments and return them plus SQL with those lines removed.
 * Other leading comments / blank lines are kept in `sql`.
 */
export function parseSetDirectives(statement: string): {
  directives: SetDirective[];
  sql: string;
} {
  const lines = statement.split(/\r?\n/);
  const directives: SetDirective[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }
    const m = SET_LINE_RE.exec(trimmed);
    if (!m) break;
    const name = m[1]!;
    const rhs = m[2];
    const col = m[3];
    if (!rhs) {
      directives.push({ mode: 'scalar', name });
    } else if (/^table$/i.test(rhs.trim())) {
      directives.push({ mode: 'table', name });
    } else if (col) {
      directives.push({ mode: 'column', name, column: col });
    }
    i += 1;
  }

  // Drop consumed leading blank/@set lines; keep the rest (including blanks after).
  const sql = lines.slice(i).join('\n').replace(/^\n+/, '');
  return { directives, sql: sql.length ? sql : statement.trim() === '' ? '' : sql };
}

/** True when a line is a `-- @set …` directive. */
export function isSetCommentLine(line: string): boolean {
  return SET_LINE_RE.test(line.trim());
}

/**
 * Extract `-- @set …` lines from text between statements (splitter drops them
 * as separators). Other comments/blank lines are ignored.
 */
export function extractSetCommentLines(gap: string): string[] {
  const out: string[] = [];
  for (const line of gap.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (isSetCommentLine(t)) out.push(t);
  }
  return out;
}

/**
 * The statement splitter treats comments between statements as separators, so
 * `-- @set` lines never appear in statement text. Re-attach each inter-statement
 * `@set` block to the **following** statement (put `-- @set` above the SELECT).
 * Trailing `@set` lines after the last statement attach to that last statement.
 */
export function reattachSetComments(
  fullSql: string,
  stmts: Array<{ text: string; start: number; end: number }>
): string[] {
  if (stmts.length === 0) return [];
  return stmts.map((stmt, i) => {
    const prevEnd = i === 0 ? 0 : stmts[i - 1]!.end;
    const leading = extractSetCommentLines(fullSql.slice(prevEnd, stmt.start));
    const trailing =
      i === stmts.length - 1
        ? extractSetCommentLines(fullSql.slice(stmt.end))
        : [];
    const sets = [...leading, ...trailing];
    if (sets.length === 0) return stmt.text;
    return `${sets.join('\n')}\n${stmt.text}`;
  });
}

/** True when the SQL interpolates at least one secret variable. */
export function sqlRefsSecretVariable(sql: string, variables: SqlVariable[]): boolean {
  const secrets = new Set(variables.filter((v) => v.secret).map((v) => v.name));
  if (secrets.size === 0) return false;
  return findVariableRefs(sql).some((ref) => secrets.has(ref.name));
}

/**
 * SQL to persist in Recent: editor source if a secret was interpolated,
 * otherwise the filled run text. Never stores a secret payload.
 */
export function recentQuerySql(
  sourceSql: string,
  ranSql: string,
  variables: SqlVariable[]
): string {
  const source = sourceSql.trim();
  if (sqlRefsSecretVariable(source, variables)) return source;
  return ranSql.trim() || source;
}

/**
 * Strip @set lines, then substitute variables.
 * Pass `{ maskSecrets: true }` only for UI copy — execute must omit it.
 */
export function prepareStatement(
  statement: string,
  variables: SqlVariable[],
  opts?: SubstituteOptions
): { ok: true; sql: string; directives: SetDirective[] } | SubstituteErr {
  const { directives, sql: stripped } = parseSetDirectives(statement);
  if (!stripped.trim()) {
    return { ok: false, error: 'Statement is empty after removing @set directives' };
  }
  const sub = substituteVariables(stripped, variables, opts);
  if (!sub.ok) return sub;
  return { ok: true, sql: sub.sql, directives };
}

/**
 * Filled SQL for the results rail and copy: non-secret vars inlined, secrets
 * shown as `(secret)` so interpolated keys never appear in the UI.
 */
export function sqlForDisplay(statement: string, variables: SqlVariable[]): string {
  const prepared = prepareStatement(statement, variables, { maskSecrets: true });
  if (prepared.ok) return prepared.sql;
  return parseSetDirectives(statement).sql.trim() || statement;
}

export type SetUpdate = {
  name: string;
  kind: SqlVariableKind;
  value?: unknown;
  values?: unknown[];
  columns?: string[];
  rows?: unknown[][];
};

export type ApplySetResult =
  | { ok: true; updates: SetUpdate[] }
  | { ok: false; error: string };

/**
 * Build variable upserts from @set directives + a successful statement result.
 */
export function applySetDirectives(
  directives: SetDirective[],
  result: { columns: string[]; rows: unknown[][] }
): ApplySetResult {
  if (directives.length === 0) return { ok: true, updates: [] };
  const updates: SetUpdate[] = [];

  for (const d of directives) {
    if (d.mode === 'scalar') {
      if (result.rows.length === 0 || result.columns.length === 0) {
        return {
          ok: false,
          error: `@set ${d.name}: result has no cells to capture`,
        };
      }
      updates.push({
        name: d.name,
        kind: 'scalar',
        value: result.rows[0]![0],
      });
      continue;
    }
    if (d.mode === 'column') {
      const idx = columnIndex(result.columns, d.column);
      if (idx < 0) {
        return {
          ok: false,
          error: `@set ${d.name}: column "${d.column}" not in result`,
        };
      }
      const values = columnToListValues(result.rows, idx);
      if (values.length === 0) {
        return {
          ok: false,
          error: `@set ${d.name}: column "${d.column}" has no non-null values`,
        };
      }
      updates.push({ name: d.name, kind: 'list', values });
      continue;
    }
    // table
    if (result.columns.length === 0) {
      return { ok: false, error: `@set ${d.name}: result has no columns` };
    }
    const rows = result.rows.slice(0, SQL_VARIABLE_TABLE_MAX);
    updates.push({
      name: d.name,
      kind: 'table',
      columns: [...result.columns],
      rows,
    });
  }

  return { ok: true, updates };
}

/** Values from a result column suitable for a list variable (skip null/undefined). */
export function columnToListValues(rows: unknown[][], colIndex: number): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    if (out.length >= SQL_VARIABLE_LIST_MAX) break;
    const cell = row[colIndex];
    if (cell === null || cell === undefined) continue;
    out.push(cell);
  }
  return out;
}

/** Cap rows for a table variable. */
export function rowsForTableVariable(rows: unknown[][]): unknown[][] {
  return rows.slice(0, SQL_VARIABLE_TABLE_MAX);
}
