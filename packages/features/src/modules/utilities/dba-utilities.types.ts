/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared types for the DBA utility probes. Dialect modules import from here,
 * not from `dba-utilities.ts`, so the registry can load them without a cycle.
 */

export type DbaProbeMode = 'native' | 'estimated' | 'unsupported';

export type DbaUtilityKind = 'pool' | 'sessions' | 'system' | 'sizes';

export interface DbaUtilitySupport {
  mode: DbaProbeMode;
  query: boolean;
  hint: string;
}

export type DbaQueryMode = Exclude<DbaProbeMode, 'unsupported'>;

export interface DbaUtilityQuery {
  sql: string;
  params: unknown[];
  mode: DbaQueryMode;
}

export interface ConnectionPoolInfo {
  maxConnections: number | null;
  currentConnections: number | null;
  activeConnections: number | null;
  availableConnections: number | null;
  waitCount: number | null;
  details: Array<{ key: string; value: string }>;
}

export interface UserSessionRow {
  sessionId: string;
  userName: string | null;
  clientHost: string | null;
  databaseName: string | null;
  state: string | null;
  waitEvent: string | null;
  queryText: string | null;
  connectedAt: string | null;
  applicationName: string | null;
}

export interface SystemInfoMetric {
  cpuCount: number | null;
  cpuUsagePercent: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  memoryAvailableBytes: number | null;
  storageTotalBytes: number | null;
  storageUsedBytes: number | null;
  storageAvailableBytes: number | null;
  uptimeSeconds: number | null;
  serverVersion: string | null;
  details: Array<{ key: string; value: string }>;
}

export interface ObjectSizeRow {
  schemaName: string | null;
  objectName: string;
  objectType: 'table' | 'index' | 'other';
  tableName: string | null;
  totalBytes: number | null;
  dataBytes: number | null;
  indexBytes: number | null;
  rowCount: number | null;
}

export interface DbaProbeOptions {
  /** Trimmed schema filter; empty when the caller did not name one. */
  schema: string;
  /** The support mode, already narrowed away from `unsupported`. */
  mode: DbaQueryMode;
}

/**
 * One engine's DBA probes: what it can answer, and the SELECT for each.
 *
 * `build` is only called for kinds whose `support(kind).query` is true; a
 * dialect still returns `{ error }` for a kind it cannot express so a wrong
 * registry entry surfaces as a message rather than a driver exception.
 */
export interface DbaUtilityDialect {
  readonly id: string;
  support(kind: DbaUtilityKind): DbaUtilitySupport;
  build(kind: DbaUtilityKind, opts: DbaProbeOptions): DbaUtilityQuery | { error: string };
}

/** Build a support table from one hint per kind, marking some kinds estimated. */
export function probeSupport(
  hints: Record<DbaUtilityKind, string>,
  estimated: readonly DbaUtilityKind[] = ['system']
): (kind: DbaUtilityKind) => DbaUtilitySupport {
  return (kind) => ({
    mode: estimated.includes(kind) ? 'estimated' : 'native',
    query: true,
    hint: hints[kind],
  });
}

/** The error a dialect returns when asked for a probe it never registered. */
export function noProbe(kind: DbaUtilityKind): { error: string } {
  const label: Record<DbaUtilityKind, string> = {
    pool: 'connection-pool',
    sessions: 'user-sessions',
    system: 'system-info',
    sizes: 'object-size',
  };
  return { error: `No ${label[kind]} probe for this dialect.` };
}
