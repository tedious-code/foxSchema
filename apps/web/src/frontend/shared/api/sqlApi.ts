import { getApiBase, parseJsonResponse } from './apiBase';
import { api } from './client';
import type { ConnectionRef } from './schemaApi';
import type { BrowserCodeCellKind, CodeCellLast, CodeCellVars } from '../lib/sql-splitter';

/** One statement's outcome from POST /sql/execute (mirrors backend sql-execute.ts). */
export type SqlStatementResult =
  | {
      ok: true;
      columns: string[];
      rows: unknown[][];
      rowCount: number;
      truncated: boolean;
      hasNext?: boolean;
      durationMs: number;
    }
  | { ok: false; error: string; durationMs: number };

/**
 * Run statements against ONE credential. The SQL Editor fans out across
 * selected credentials by calling this once per connection (Promise.allSettled
 * in the store), so a dead database can't stall the others' results.
 */
export async function executeSql(
  ref: ConnectionRef,
  statements: string[],
  maxRows?: number,
  offset?: number,
  /** Bind parameters per statement, aligned by index. */
  params?: unknown[][],
  /**
   * When set, the write came from Data Peek / query-result grid CRUD and the
   * matching `editor.datagrid.*` permission is required in addition to DML.
   */
  opts?: {
    datagridAction?: 'insert' | 'update' | 'delete';
    seek?: { columns: string[]; values: unknown[]; descending?: boolean | boolean[] };
  }
): Promise<{ results: SqlStatementResult[] }> {
  const data = await api.post<{ results?: SqlStatementResult[]; error?: string }>(`/sql/execute`, {
      ...ref,
      statements,
      maxRows,
      offset,
      params,
      ...(opts?.datagridAction ? { datagridAction: opts.datagridAction } : {}),
      ...(opts?.seek ? { seek: opts.seek } : {}),
    });
  if (!data.results) throw new Error(data.error || 'Query failed: no results returned.');
  return { results: data.results };
}

/** Server Beam endpoint on the wire (alias → saved connection). */
export type BeamEndpointPayload = {
  alias: string;
  connectionId: string;
  password?: string;
};

/** Body for POST /sql/code-cell. Wire `kind` is language only (`js`|`ts`); Node vs browser is implied by the route. */
export type ServerCodeCellPayload = {
  body: string;
  kind: BrowserCodeCellKind;
  last: CodeCellLast;
  vars: CodeCellVars;
  maxRows: number;
  timeoutMs?: number;
  /**
   * Connection the cell's `sql` bridge runs against. Omit to run a cell with
   * no database access (it still executes; `sql` just reports no connection).
   */
  ref?: ConnectionRef;
  /**
   * Server Beam: up to two `{ alias, connectionId }` endpoints for `sql.on`.
   * When set, the cell runs once across those servers (not per-Destination fan-out).
   */
  beam?: BeamEndpointPayload[];
  /** Mirrors Safe mode — the server rejects write/DDL from `sql` when false. */
  allowWrites?: boolean;
};

function responseError(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'error' in data) {
    const err = (data as { error: unknown }).error;
    if (typeof err === 'string' && err) return err;
  }
  return undefined;
}

function isUnknownMatrix(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every((r) => Array.isArray(r));
}

/** Parse a `/sql/code-cell` JSON body into `SqlStatementResult` (rejects malformed success payloads). */
export function parseSqlStatementResult(
  data: unknown
): { ok: true; value: SqlStatementResult } | { ok: false; error: string } {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Invalid code cell response' };
  }
  const o = data as Record<string, unknown>;
  if (typeof o.durationMs !== 'number' || !Number.isFinite(o.durationMs)) {
    return { ok: false, error: 'Invalid code cell response (durationMs)' };
  }
  if (o.ok === false) {
    if (typeof o.error !== 'string' || !o.error) {
      return { ok: false, error: 'Invalid code cell error response' };
    }
    return { ok: true, value: { ok: false, error: o.error, durationMs: o.durationMs } };
  }
  if (o.ok !== true) {
    return { ok: false, error: responseError(data) || 'Invalid code cell response' };
  }
  if (!Array.isArray(o.columns) || !o.columns.every((c) => typeof c === 'string')) {
    return { ok: false, error: 'Invalid code cell response (columns)' };
  }
  if (!isUnknownMatrix(o.rows)) {
    return { ok: false, error: 'Invalid code cell response (rows)' };
  }
  if (typeof o.rowCount !== 'number' || !Number.isFinite(o.rowCount)) {
    return { ok: false, error: 'Invalid code cell response (rowCount)' };
  }
  if (typeof o.truncated !== 'boolean') {
    return { ok: false, error: 'Invalid code cell response (truncated)' };
  }
  return {
    ok: true,
    value: {
      ok: true,
      columns: o.columns,
      rows: o.rows,
      rowCount: o.rowCount,
      truncated: o.truncated,
      hasNext: typeof o.hasNext === 'boolean' ? o.hasNext : false,
      durationMs: o.durationMs,
    },
  };
}

/**
 * Compile a browser TypeScript cell to JavaScript on the server, which never
 * runs it. Saves the browser the TypeScript compiler (3.4 MB).
 */
export async function transpileCodeCell(source: string): Promise<string> {
  const data = await api.post<{ js?: unknown }>(`/sql/code-cell/transpile`, { source });
  if (typeof data?.js !== 'string') throw new Error('The server returned no JavaScript for this cell.');
  return data.js;
}

/** Run a `-- @node` / `-- @nodets` cell on the FoxSchema server. */
export async function runCodeCellOnServer(
  payload: ServerCodeCellPayload
): Promise<SqlStatementResult> {
  const { ref, beam, ...rest } = payload;
  const data = await api.post<unknown>(`/sql/code-cell`, { ...ref, ...rest, ...(beam?.length ? { beam } : {}) });
  const parsed = parseSqlStatementResult(data);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}
