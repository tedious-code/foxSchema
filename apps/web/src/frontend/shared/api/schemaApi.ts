import type { ConnectionOptions } from '../lib/provider-settings';
import { api } from './client';
import type {
  DriverInfo,
  DbObjectType,
  SchemaCompareResult,
  MigrationStep,
  MigrationEvent,
  TableSchema,
} from '../lib/types';
import { nonSecretFingerprint, type DbPrincipal, type DbPrivilege } from '@foxschema/sql';
import { getApiBase, parseJsonBody, parseJsonResponse } from './apiBase';

// Re-exported for existing callers; the one copy lives in `@foxschema/sql`.
export { nonSecretFingerprint };


/** Either a saved connection (resolved server-side) or an inline ad-hoc option. */
export interface ConnectionRef {
  connectionId?: string;
  dialect?: string;
  option?: ConnectionOptions;
  schema?: string;
  /** Session password for a saved connection stored without one; merged server-side, never persisted. */
  password?: string;
}

const CACHE_MAX_ENTRIES = 64;

// --- Idempotency layer -----------------------------------------------------
// Collapses duplicate work so the UI (which re-checks drivers/schemas on many
// state changes) doesn't hammer the backend: concurrent identical requests
// share one promise, and idempotent reads are cached for a short TTL.
const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, { at: number; value: unknown; ttlMs: number }>();


/** Strip userinfo from a URI-like connection string before fingerprinting. */
function connectionStringFingerprint(connectionString: string | undefined): string {
  const raw = connectionString?.trim() ?? '';
  if (!raw) return '0';
  // `scheme://user:pass@host/...` → drop credentials; bare paths (sqlite) stay.
  const scrubbed = raw.replace(/\/\/([^/@]+)@/g, '//');
  return nonSecretFingerprint(scrubbed);
}

/**
 * Stable cache key that never embeds password or connectionString plaintext.
 * Includes schema and a password fingerprint so different schemas / session
 * passwords do not share inflight or TTL cache entries.
 */
export function cacheKeyForRef(ref: ConnectionRef): string {
  const schema = ref.schema ?? ref.option?.schema ?? '';
  const pwFp = nonSecretFingerprint(ref.password ?? ref.option?.password ?? '');
  const o = ref.option;
  if (ref.connectionId) {
    return `id:${ref.connectionId}|schema:${schema}|pw:${pwFp}`;
  }
  return [
    ref.dialect ?? '',
    o?.host ?? '',
    o?.port ?? '',
    o?.database ?? '',
    schema,
    o?.username ?? '',
    `cs:${connectionStringFingerprint(o?.connectionString)}`,
    `pw:${pwFp}`,
  ].join('|');
}

function pruneCache(now = Date.now()): void {
  for (const [key, hit] of cache) {
    if (hit.ttlMs > 0 && now - hit.at >= hit.ttlMs) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cacheGet(key: string, ttlMs: number): unknown | undefined {
  if (ttlMs <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= ttlMs) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU order
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;
  cache.delete(key);
  cache.set(key, { at: Date.now(), value, ttlMs });
  pruneCache();
}

function idempotent<T>(key: string, run: () => Promise<T>, ttlMs = 0): Promise<T> {
  const cached = cacheGet(key, ttlMs);
  if (cached !== undefined) return Promise.resolve(cached as T);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = run()
    .then((value) => {
      // Skip cache if invalidateCache dropped this entry mid-flight (or a force
      // refresh replaced it) — otherwise a stale GRANT catalog can land for 60s.
      if (inflight.get(key) === promise) {
        cacheSet(key, value, ttlMs);
      }
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/** Drop cached driver/schema results for a connection (e.g. after install or reconnect). */
export function invalidateCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    inflight.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

/** Runs the schema comparison server-side and returns only the diff result. */
export async function compareSchemas(
  source: ConnectionRef,
  target: ConnectionRef,
  scope: DbObjectType[]
): Promise<SchemaCompareResult> {
  // De-dupe concurrent identical compares (e.g. double-click); never cached
  const key = `compare:${cacheKeyForRef(source)}:${cacheKeyForRef(target)}:${scope.join(',')}`;
  return idempotent(key, async () =>
    parseJsonResponse<SchemaCompareResult>(
      await fetch(`${getApiBase()}/compare`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, target, scope }),
      })
    )
  );
}

/** Loads one schema's scoped objects (no comparison) for browse/search mode. */
export async function loadSchema(
  ref: ConnectionRef,
  scope: DbObjectType[]
): Promise<{ tables: TableSchema[]; warnings?: string[] }> {
  // De-dupe concurrent identical loads (e.g. double-click); never cached
  const key = `load:${cacheKeyForRef(ref)}:${scope.join(',')}`;
  return idempotent(key, async () =>
    parseJsonResponse<{ tables: TableSchema[]; warnings?: string[] }>(
      await fetch(`${getApiBase()}/schema/load`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...ref, scope }),
      })
    )
  );
}

export type IndexFragmentationApiRow = {
  indexName: string;
  fragmentationPercent: number | null;
  pageCount?: number | null;
  lastUsed?: string | null;
  scanCount?: number | null;
};

/** Bare index name after an optional schema/owner qualifier (`dbo.ix` → `ix`). */
function bareIndexName(name: string): string {
  const t = name.trim();
  const i = t.lastIndexOf('.');
  return i >= 0 ? t.slice(i + 1) : t;
}

/**
 * Match a schema-catalog index name to a fragmentation probe row.
 * Tolerates case differences and `schema.index` vs bare `index` names so
 * Utilities → Index Management does not show empty % when Edit Table works.
 */
export function matchIndexFragmentationRow(
  indexName: string,
  rows: ReadonlyArray<IndexFragmentationApiRow>
): IndexFragmentationApiRow | null {
  const want = indexName.trim();
  if (!want) return null;
  const wantLower = want.toLowerCase();
  const wantBare = bareIndexName(want).toLowerCase();
  for (const row of rows) {
    const n = (row.indexName ?? '').trim();
    if (!n) continue;
    if (n === want || n.toLowerCase() === wantLower) return row;
    if (bareIndexName(n).toLowerCase() === wantBare) return row;
  }
  return null;
}

export type IndexFragmentationResponse = {
  rows: IndexFragmentationApiRow[];
  source: 'default' | 'custom';
  mode: 'physical' | 'estimated' | 'unsupported';
  support?: {
    mode: string;
    query: boolean;
    defrag: boolean;
    hint: string;
    customSqlHint: string;
  };
  defrag?: Record<string, string[]>;
  customSqlTemplate?: string;
  warning?: string;
  error?: string;
  defaultFailed?: boolean;
};

/**
 * Fetch per-index fragmentation % for Edit Table. Tries dialect default first;
 * pass `customSql` to retry when the default probe fails (or `preferCustom`).
 */
export async function fetchIndexFragmentation(
  ref: ConnectionRef,
  opts: {
    table: string;
    schema?: string;
    customSql?: string;
    preferCustom?: boolean;
  }
): Promise<IndexFragmentationResponse> {
  const res = await fetch(`${getApiBase()}/schema/index-fragmentation`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...ref,
      table: opts.table,
      schema: opts.schema,
      customSql: opts.customSql,
      preferCustom: opts.preferCustom,
    }),
  });
  // Use parseJsonBody so failed probes still expose customSqlTemplate / support.
  const data = await parseJsonBody<IndexFragmentationResponse & { error?: string }>(res);
  if (!res.ok) {
    const err = new Error(data.error || `Index fragmentation failed (${res.status})`) as Error & {
      payload?: IndexFragmentationResponse;
    };
    err.payload = data;
    throw err;
  }
  return data;
}

export type IndexFragmentationBatchTableResult = {
  table: string;
  ok: boolean;
  error?: string;
  rows: IndexFragmentationApiRow[];
  defrag: Record<string, string[]>;
  mode?: 'physical' | 'estimated' | 'unsupported';
  source?: 'default' | 'custom';
  warning?: string;
};

export type IndexFragmentationBatchResponse = {
  dialect: string;
  schema: string;
  support?: IndexFragmentationResponse['support'];
  results: IndexFragmentationBatchTableResult[];
  customSqlTemplate?: string;
  error?: string;
};

/** Batch probe for Utilities → Index Management (up to 80 tables). */
export async function fetchIndexFragmentationBatch(
  ref: ConnectionRef,
  opts: { tables: string[]; schema?: string }
): Promise<IndexFragmentationBatchResponse> {
  const res = await fetch(`${getApiBase()}/schema/index-fragmentation-batch`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...ref,
      tables: opts.tables,
      schema: opts.schema,
    }),
  });
  const data = await parseJsonBody<IndexFragmentationBatchResponse & { error?: string }>(res);
  if (!res.ok) {
    throw new Error(data.error || `Index fragmentation batch failed (${res.status})`);
  }
  return data;
}

export type DbaUtilityKindApi = 'pool' | 'sessions' | 'system' | 'sizes';

export type DbaUtilityResponse = {
  kind: DbaUtilityKindApi;
  dialect: string;
  schema: string;
  mode: 'native' | 'estimated' | 'unsupported';
  support?: {
    mode: 'native' | 'estimated' | 'unsupported';
    query: boolean;
    hint: string;
  };
  pool?: {
    maxConnections: number | null;
    currentConnections: number | null;
    activeConnections: number | null;
    availableConnections: number | null;
    waitCount: number | null;
    details: Array<{ key: string; value: string }>;
  };
  sessions?: Array<{
    sessionId: string;
    userName: string | null;
    clientHost: string | null;
    databaseName: string | null;
    state: string | null;
    waitEvent: string | null;
    queryText: string | null;
    connectedAt: string | null;
    applicationName: string | null;
  }>;
  system?: {
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
  };
  sizes?: Array<{
    schemaName: string | null;
    objectName: string;
    objectType: 'table' | 'index' | 'other';
    tableName: string | null;
    totalBytes: number | null;
    dataBytes: number | null;
    indexBytes: number | null;
    rowCount: number | null;
  }>;
  warning?: string;
  error?: string;
};

/** Utilities → Server Insights (pool / sessions / system / sizes). */
export async function fetchDbaUtility(
  ref: ConnectionRef,
  opts: { kind: DbaUtilityKindApi; schema?: string }
): Promise<DbaUtilityResponse> {
  const res = await fetch(`${getApiBase()}/schema/dba-utility`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...ref,
      kind: opts.kind,
      schema: opts.schema,
    }),
  });
  const data = await parseJsonBody<DbaUtilityResponse & { error?: string }>(res);
  if (!res.ok) {
    throw new Error(data.error || `DBA utility failed (${res.status})`);
  }
  return data;
}

export type TableInsightResponse = {
  table: string;
  schema: string;
  dialect?: string;
  estimatedRows: number | null;
  /** Table + indexes as the catalog reports it; null where the engine has no dependable figure. */
  sizeBytes: number | null;
  columns: Array<{ name: string; nDistinct: number | null; nullFrac: number | null }>;
  mode: 'catalog' | 'unsupported';
  support: { mode: string; query: boolean; hint: string };
  warning?: string;
  error?: string;
};

const TABLE_INSIGHT_TTL_MS = 60_000;

export async function fetchTableInsight(
  ref: ConnectionRef,
  opts: { table: string; schema?: string }
): Promise<TableInsightResponse> {
  const schema = opts.schema ?? ref.schema;
  const key = `table-insight:${cacheKeyForRef({ ...ref, schema })}:${opts.table}`;
  return idempotent(
    key,
    async () => {
      const res = await fetch(`${getApiBase()}/schema/table-insight`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...ref,
          schema,
          table: opts.table,
        }),
      });
      const data = await parseJsonBody<TableInsightResponse>(res);
      if (!res.ok) {
        throw new Error(data.error || `Table insight failed (${res.status})`);
      }
      return data;
    },
    TABLE_INSIGHT_TTL_MS
  );
}

export type DbAccessResponse = {
  dialect: string;
  schema: string;
  mode: 'native' | 'estimated' | 'unsupported';
  support: { mode: string; query: boolean; grant: boolean; hint: string };
  principals: DbPrincipal[];
  privileges: DbPrivilege[];
  warning?: string;
  error?: string;
};

/** How long a Database Access catalog stays reused across Access tabs. */
export const DB_ACCESS_CACHE_TTL_MS = 60_000;

/** Drop cached GRANT catalogs (call after executing GRANT/REVOKE). */
export function invalidateDbAccessCache(connectionId?: string): void {
  if (connectionId) {
    invalidateCache(`db-access:id:${connectionId}`);
    return;
  }
  invalidateCache('db-access:');
}

/** Utilities / Access control → database users, groups, and privileges. */
export async function fetchDbAccess(
  ref: ConnectionRef,
  opts?: { schema?: string; force?: boolean }
): Promise<DbAccessResponse> {
  const schema = opts?.schema ?? ref.schema;
  const key = `db-access:${cacheKeyForRef({ ...ref, schema })}`;
  // Explicit Refresh must re-read — the 60s TTL is for tab sharing, not for
  // buttons whose title says "Reload … from the database".
  if (opts?.force) {
    cache.delete(key);
    inflight.delete(key);
  }
  return idempotent(
    key,
    async () => {
      const res = await fetch(`${getApiBase()}/schema/db-access`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...ref,
          schema,
        }),
      });
      const data = await parseJsonBody<DbAccessResponse & { error?: string }>(res);
      if (!res.ok) {
        throw new Error(data.error || `Database access failed (${res.status})`);
      }
      return data;
    },
    DB_ACCESS_CACHE_TTL_MS
  );
}

export async function checkDriver(dialect: string): Promise<DriverInfo> {
  // Driver-installed status rarely changes — cache for 30s, dedupe concurrent checks
  return idempotent(
    `driver:${dialect}`,
    async () => api.get<DriverInfo>('/driver/check', { query: { dialect } }),
    30000
  );
}

export async function installDriver(dialect: string): Promise<{ success: boolean; stdout?: string; error?: string }> {
  const result = await api.post<{ success: boolean; stdout?: string; error?: string }>(
    '/driver/install',
    { dialect }
  );
  // An install changes driver availability — drop the stale cached check
  invalidateCache(`driver:${dialect}`);
  return result;
}


export async function testConnection(ref: ConnectionRef): Promise<{ version?: string }> {
  const data = await api.post<{ success: boolean; version?: string; error?: string }>(`/connection/test`, ref);
  if (!data.success) {
    throw new Error(data.error ?? 'Connection test returned false');
  }

  return { version: data.version };
}

export async function fetchSchemaList(ref: ConnectionRef): Promise<string[]> {
  // Short cache: schema lists are stable within a session; dedupes the
  // back-to-back loads triggered by connect + compare-refresh
  const key = `schemas:${cacheKeyForRef(ref)}`;
  return idempotent(
    key,
    async () => {
      const data = await parseJsonResponse<{ schemas: string[] }>(
        await fetch(`${getApiBase()}/schema/list`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ref),
        })
      );
      return data.schemas;
    },
    15000
  );
}

/** Streams NDJSON migration progress events, invoking onEvent for each. */
export type LokeeCaptureEvent = {
  type: 'lokee';
  phase: 'before' | 'after';
  error?: string;
  changed?: boolean;
  versionNumber?: number;
  changeCount?: number;
  objectCount?: number;
};

export type MigrationStreamEvent = MigrationEvent | LokeeCaptureEvent;

export async function executeMigration(
  ref: ConnectionRef,
  steps: MigrationStep[],
  onEvent: (e: MigrationStreamEvent) => void,
  continueOnError?: boolean,
  /** Run the file at this commit instead of `steps` (the server ignores `steps` then). */
  git?: { repoId: string; branch?: string; commit: string; path: string }
): Promise<void> {
  const res = await fetch(`${getApiBase()}/migration/execute`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...ref, steps, continueOnError: !!continueOnError, ...(git ? { git } : {}) }),
  });

  if (!res.ok || !res.body) {
    // The server says why (commit required, wrong dialect…); show that, not just the status text.
    let message = `Migration request failed: ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) message = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) onEvent(JSON.parse(line) as MigrationStreamEvent);
    }
  }
}
