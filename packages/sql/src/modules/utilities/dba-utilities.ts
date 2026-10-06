/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dialect-aware DBA utility probes for SQL Editor → Utilities:
 * - connection pool / server connection limits
 * - active user sessions
 * - system info (RAM / storage / CPU where the engine exposes it)
 * - table and index sizes
 *
 * Quality ladder mirrors index fragmentation: native DMV/catalog when available,
 * estimated otherwise, unsupported with a hint for embedded engines.
 *
 * ## Per-dialect modules
 *
 * The SQL lives next to each engine's migration dialect as
 * `providers/<name>/<name>.dba-utilities.ts`, registered in
 * `dba-utilities.registry.ts`. This file resolves the dialect and reshapes
 * driver rows; it knows no catalog table by name.
 */

export type {
  DbaProbeMode,
  DbaUtilityKind,
  DbaUtilitySupport,
  DbaUtilityQuery,
  DbaUtilityDialect,
  ConnectionPoolInfo,
  UserSessionRow,
  SystemInfoMetric,
  ObjectSizeRow,
} from './dba-utilities.types.js';
import type {
  DbaUtilityKind,
  DbaUtilityQuery,
  DbaUtilitySupport,
  ObjectSizeRow,
  ConnectionPoolInfo,
  UserSessionRow,
  SystemInfoMetric,
} from './dba-utilities.types.js';
import { resolveDbaUtilities } from './dba-utilities.registry.js';

const UNSUPPORTED: DbaUtilitySupport = {
  mode: 'unsupported',
  query: false,
  hint: 'This dialect does not expose a built-in probe for this utility.',
};

export function dialectSupportsDbaUtility(
  dialect: string,
  kind: DbaUtilityKind
): DbaUtilitySupport {
  return resolveDbaUtilities(dialect)?.support(kind) ?? UNSUPPORTED;
}

export function buildDbaUtilityQuery(opts: {
  dialect: string;
  kind: DbaUtilityKind;
  schema?: string;
}): DbaUtilityQuery | { error: string } {
  const impl = resolveDbaUtilities(opts.dialect);
  const support = impl?.support(opts.kind) ?? UNSUPPORTED;
  if (!impl || !support.query) {
    return { error: support.hint || 'Unsupported dialect for this utility.' };
  }
  return impl.build(opts.kind, {
    schema: (opts.schema || '').trim(),
    mode: support.mode === 'native' ? 'native' : 'estimated',
  });
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  return undefined;
}

export function normalizeConnectionPoolRows(
  rows: Record<string, unknown>[]
): ConnectionPoolInfo {
  const row = rows[0] ?? {};
  const maxConnections = num(pick(row, 'max_connections', 'maxConnections'));
  const currentConnections = num(pick(row, 'current_connections', 'currentConnections'));
  const activeConnections = num(pick(row, 'active_connections', 'activeConnections'));
  const availableConnections = num(pick(row, 'available_connections', 'availableConnections'));
  const waitCount = num(pick(row, 'wait_count', 'waitCount'));
  const details: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    const key = k.toLowerCase();
    if (
      key.includes('max_connection') ||
      key.includes('current_connection') ||
      key.includes('active_connection') ||
      key.includes('available_connection') ||
      key.includes('wait_count')
    ) {
      continue;
    }
    details.push({ key: k, value: String(v) });
  }
  const available =
    availableConnections ??
    (maxConnections != null && currentConnections != null
      ? Math.max(0, maxConnections - currentConnections)
      : null);
  return {
    maxConnections,
    currentConnections,
    activeConnections,
    availableConnections: available,
    waitCount,
    details,
  };
}

export function normalizeUserSessionRows(
  rows: Record<string, unknown>[]
): UserSessionRow[] {
  return rows.map((row) => ({
    sessionId: str(pick(row, 'session_id', 'sessionId', 'pid', 'id')) || '—',
    userName: str(pick(row, 'user_name', 'userName', 'usename', 'user', 'login_name')),
    clientHost: str(pick(row, 'client_host', 'clientHost', 'host', 'host_name', 'remotehost')),
    databaseName: str(pick(row, 'database_name', 'databaseName', 'datname', 'db')),
    state: str(pick(row, 'state', 'status', 'command')),
    waitEvent: str(pick(row, 'wait_event', 'waitEvent', 'wait_type', 'event')),
    queryText: str(pick(row, 'query_text', 'queryText', 'query', 'info', 'text')),
    connectedAt: str(pick(row, 'connected_at', 'connectedAt', 'backend_start', 'login_time')),
    applicationName: str(pick(row, 'application_name', 'applicationName', 'program_name', 'program')),
  }));
}

export function normalizeSystemInfoRows(rows: Record<string, unknown>[]): SystemInfoMetric {
  const row = rows[0] ?? {};
  const memoryTotalBytes = num(pick(row, 'memory_total_bytes', 'memoryTotalBytes'));
  const memoryAvailableBytes = num(pick(row, 'memory_available_bytes', 'memoryAvailableBytes'));
  let memoryUsedBytes = num(pick(row, 'memory_used_bytes', 'memoryUsedBytes'));
  if (memoryUsedBytes == null && memoryTotalBytes != null && memoryAvailableBytes != null) {
    memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryAvailableBytes);
  }
  const details: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    const key = k.toLowerCase();
    if (
      key.includes('cpu') ||
      key.includes('memory') ||
      key.includes('storage') ||
      key.includes('uptime') ||
      key.includes('server_version')
    ) {
      continue;
    }
    details.push({ key: k, value: String(v) });
  }
  return {
    cpuCount: num(pick(row, 'cpu_count', 'cpuCount')),
    cpuUsagePercent: num(pick(row, 'cpu_usage_percent', 'cpuUsagePercent')),
    memoryTotalBytes,
    memoryUsedBytes,
    memoryAvailableBytes,
    storageTotalBytes: num(pick(row, 'storage_total_bytes', 'storageTotalBytes')),
    storageUsedBytes: num(pick(row, 'storage_used_bytes', 'storageUsedBytes')),
    storageAvailableBytes: num(pick(row, 'storage_available_bytes', 'storageAvailableBytes')),
    uptimeSeconds: num(pick(row, 'uptime_seconds', 'uptimeSeconds')),
    serverVersion: str(pick(row, 'server_version', 'serverVersion', 'version')),
    details,
  };
}

export function normalizeObjectSizeRows(rows: Record<string, unknown>[]): ObjectSizeRow[] {
  return rows.map((row) => {
    const rawType = (str(pick(row, 'object_type', 'objectType')) || 'other').toLowerCase();
    const objectType: ObjectSizeRow['objectType'] =
      rawType === 'table' || rawType === 'index' ? rawType : 'other';
    return {
      schemaName: str(pick(row, 'schema_name', 'schemaName', 'schema')),
      objectName: str(pick(row, 'object_name', 'objectName', 'name', 'table')) || '—',
      objectType,
      tableName: str(pick(row, 'table_name', 'tableName', 'table')),
      totalBytes: num(pick(row, 'total_bytes', 'totalBytes', 'size')),
      dataBytes: num(pick(row, 'data_bytes', 'dataBytes')),
      indexBytes: num(pick(row, 'index_bytes', 'indexBytes')),
      rowCount: rowCountOrUnknown(pick(row, 'row_count', 'rowCount', 'rows', 'card')),
    };
  });
}

/**
 * A row count the engine could not supply, normalised to null.
 *
 * Postgres reports `pg_class.reltuples` as **-1** for a relation that has never
 * been ANALYZEd — a sentinel, not a count — so a freshly created table used to
 * render as "-1 rows" in the schema explorer and Index Management. No engine
 * has a meaningful negative cardinality, so any negative reads as unknown, and
 * unknown is what `formatRowCount` already prints as an em dash.
 */
function rowCountOrUnknown(v: unknown): number | null {
  const n = num(v);
  return n == null || n < 0 ? null : n;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let n = abs;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const signed = bytes < 0 ? '-' : '';
  return `${signed}${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** A percentage: one decimal below 10, whole numbers above, '—' when unknown. */
export function formatPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Stable thousands separators so UI and tests do not depend on host locale. */
export function formatRowCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** One table plus the indexes that belong to it, with rolled-up size stats. */
export interface TableSizeGroup {
  schemaName: string | null;
  tableName: string;
  rowCount: number | null;
  dataBytes: number | null;
  indexBytes: number | null;
  totalBytes: number | null;
  indexes: ObjectSizeRow[];
}

function sizeGroupKey(schemaName: string | null | undefined, tableName: string): string {
  return `${(schemaName ?? '').toLowerCase()}\0${tableName.toLowerCase()}`;
}

/**
 * Nest DBA size rows under their table. Table totals keep catalog data/index
 * bytes when present; otherwise index size is the sum of child index rows
 * (SQL Server reports heap/clustered as the table row with indexBytes 0).
 */
export function groupObjectSizes(rows: readonly ObjectSizeRow[]): TableSizeGroup[] {
  const map = new Map<string, TableSizeGroup>();

  const ensure = (schemaName: string | null, tableName: string): TableSizeGroup => {
    const key = sizeGroupKey(schemaName, tableName);
    let group = map.get(key);
    if (!group) {
      group = {
        schemaName,
        tableName,
        rowCount: null,
        dataBytes: null,
        indexBytes: null,
        totalBytes: null,
        indexes: [],
      };
      map.set(key, group);
    }
    return group;
  };

  for (const row of rows) {
    if (row.objectType === 'index') {
      const parent = row.tableName?.trim() || '(other indexes)';
      ensure(row.schemaName, parent).indexes.push(row);
      continue;
    }
    const name = (row.tableName || row.objectName).trim() || row.objectName;
    const group = ensure(row.schemaName, name);
    group.rowCount = row.rowCount ?? group.rowCount;
    group.dataBytes = row.dataBytes ?? group.dataBytes;
    group.indexBytes = row.indexBytes ?? group.indexBytes;
    group.totalBytes = row.totalBytes ?? group.totalBytes;
  }

  for (const group of map.values()) {
    const childIndexBytes = group.indexes.reduce<number | null>((acc, idx) => {
      const n = idx.indexBytes ?? idx.totalBytes;
      if (n == null || !Number.isFinite(n)) return acc;
      return (acc ?? 0) + n;
    }, null);
    if (childIndexBytes != null && (group.indexBytes == null || group.indexBytes === 0)) {
      group.indexBytes = childIndexBytes;
    }
    if (group.totalBytes == null && (group.dataBytes != null || group.indexBytes != null)) {
      group.totalBytes = (group.dataBytes ?? 0) + (group.indexBytes ?? 0);
    }
    group.indexes.sort((a, b) => a.objectName.localeCompare(b.objectName));
  }

  return [...map.values()].sort((a, b) => {
    const schemaCmp = (a.schemaName ?? '').localeCompare(b.schemaName ?? '', 'en', {
      sensitivity: 'base',
    });
    return schemaCmp !== 0
      ? schemaCmp
      : a.tableName.localeCompare(b.tableName, 'en', { sensitivity: 'base' });
  });
}

/** Keep a table if its name/schema or any nested index matches `query`. */
export function filterTableSizeGroups(
  groups: readonly TableSizeGroup[],
  query: string
): TableSizeGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  const out: TableSizeGroup[] = [];
  for (const group of groups) {
    const tableHit =
      group.tableName.toLowerCase().includes(q) ||
      (group.schemaName ?? '').toLowerCase().includes(q);
    const indexes = tableHit
      ? group.indexes
      : group.indexes.filter((idx) => idx.objectName.toLowerCase().includes(q));
    if (tableHit || indexes.length > 0) {
      out.push(tableHit ? group : { ...group, indexes });
    }
  }
  return out;
}

export type TableSizeLookup = (
  tableName: string,
  schemaName?: string | null
) => TableSizeGroup | undefined;

/**
 * Index size groups once for a lookup per table row. A list of N tables that
 * called `lookupTableSizeGroup` per row scanned all N for each: 460 ms per
 * render at 5,000 tables, on every keystroke in the SQL editor.
 * Matches case-insensitively; an exact schema + table match wins, then the
 * first group with that table name.
 */
export function indexTableSizeGroups(groups: readonly TableSizeGroup[]): TableSizeLookup {
  const byTable = new Map<string, TableSizeGroup>();
  const bySchemaTable = new Map<string, TableSizeGroup>();
  for (const g of groups) {
    const table = g.tableName.toLowerCase();
    const key = sizeGroupKey(g.schemaName, g.tableName);
    if (!byTable.has(table)) byTable.set(table, g);
    if (!bySchemaTable.has(key)) bySchemaTable.set(key, g);
  }
  return (tableName, schemaName) => {
    return (
      (schemaName && bySchemaTable.get(sizeGroupKey(schemaName, tableName))) ||
      byTable.get(tableName.toLowerCase())
    );
  };
}

/** One lookup; for a lookup per row, index once with `indexTableSizeGroups`. */
export function lookupTableSizeGroup(
  groups: readonly TableSizeGroup[],
  tableName: string,
  schemaName?: string | null
): TableSizeGroup | undefined {
  return indexTableSizeGroups(groups)(tableName, schemaName);
}

export function lookupIndexSizeRow(
  group: TableSizeGroup | undefined,
  indexName: string
): ObjectSizeRow | undefined {
  if (!group) return undefined;
  const name = indexName.toLowerCase();
  return group.indexes.find((idx) => idx.objectName.toLowerCase() === name);
}
