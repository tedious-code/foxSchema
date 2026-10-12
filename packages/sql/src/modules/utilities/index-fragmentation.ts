/**
 * Dialect-aware index fragmentation probes for DBA guidance in Edit Table.
 *
 * Every registered dialect has a default probe (physical or estimated). Engines
 * without a native fragmentation metric still return index names with a null
 * percent so Refresh % / Utilities work everywhere; admins can paste custom SQL
 * that returns `index_name` + `fragmentation_percent` (+ optional `page_count`).
 *
 * Quality ladder:
 * - SQL Server / Azure SQL: physical % via dm_db_index_physical_stats
 * - PostgreSQL family: leaf_fragmentation via pgstatindex, from the pgstattuple
 *   extension. `pgstattuple` itself reports *table* statistics and has no
 *   leaf_fragmentation column — naming it here failed twice over: without the
 *   extension Postgres says the function does not exist, and with it installed
 *   the column does not exist either.
 * - MySQL family: table-level DATA_FREE ratio applied per index (estimate)
 * - DB2: empty-leaf ratio from SYSCAT.INDEXES (estimate)
 * - Oracle: weak estimate from ALL_INDEXES stats (prefer custom ANALYZE)
 * - SQLite / DuckDB / ClickHouse / Redshift: catalog listing + optional estimates
 *
 * ## Per-dialect modules
 *
 * The SQL lives next to each engine's migration dialect as
 * `providers/<name>/<name>.index-fragmentation.ts`, registered in
 * `index-fragmentation.registry.ts`. This file splits table names, reshapes
 * driver rows and checks custom SQL; it knows no catalog table by name.
 */

import { firstKeyword, sqlStatementCategories, sqlStatementCount } from '../sql-text/sql-splitter.js';
import { resolveIndexFragmentation } from './index-fragmentation.registry.js';
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationQuery,
  type IndexFragmentationRow,
  type IndexFragmentationSeverity,
  type IndexFragmentationSupport,
  type IndexTarget,
  type IndexUsageQuery,
} from './index-fragmentation.types.js';

export type {
  IndexFragmentationDialect,
  IndexFragmentationMode,
  IndexFragmentationQuery,
  IndexFragmentationRow,
  IndexFragmentationSeverity,
  IndexFragmentationSupport,
  IndexTarget,
  IndexUsageQuery,
} from './index-fragmentation.types.js';

/** Unknown dialects still get a probe attempt via custom SQL templates. */
const DEFAULT_UNSUPPORTED: IndexFragmentationSupport = {
  mode: 'estimated',
  query: true,
  defrag: false,
  hint: 'Generic dialect: try the default listing probe, then paste custom SQL for a real %.',
  customSqlHint: CUSTOM_HINT,
};

/** Look up fragmentation support for a dialect id. */
export function dialectSupportsIndexFragmentation(
  dialectName: string
): IndexFragmentationSupport {
  return resolveIndexFragmentation(dialectName)?.support ?? DEFAULT_UNSUPPORTED;
}

/**
 * Split `schema.table` (or bare `table`) using an optional connection default schema.
 * Strips common quoting characters from each part.
 */
export function splitSchemaTable(
  tableName: string,
  defaultSchema?: string
): { schema: string; table: string } {
  const raw = tableName.trim();
  const strip = (p: string) => p.replace(/^["`\[\]]+|["`\[\]]+$/g, '');
  if (!raw) return { schema: (defaultSchema ?? '').trim(), table: '' };
  const parts = raw.split('.').map(strip).filter(Boolean);
  if (parts.length >= 2) {
    return { schema: parts[parts.length - 2]!, table: parts[parts.length - 1]! };
  }
  return { schema: (defaultSchema ?? '').trim(), table: parts[0] ?? '' };
}

/**
 * DBA-oriented bands (aligned with common SQL Server rebuild guidance):
 * <10 ok, 10–30 warn (reorganize), ≥30 critical (rebuild).
 */
export function fragmentationSeverity(
  pct: number | null | undefined
): IndexFragmentationSeverity {
  if (pct == null || !Number.isFinite(pct)) return 'unknown';
  if (pct < 10) return 'ok';
  if (pct < 30) return 'warn';
  return 'critical';
}

function targetOf(opts: { dialect: string; schema?: string; table: string }): IndexTarget {
  const { schema, table } = splitSchemaTable(opts.table, opts.schema);
  return { dialect: opts.dialect.toLowerCase(), schema, table };
}

/** Build the default fragmentation SELECT for a dialect, or an error if unsupported. */
export function buildIndexFragmentationQuery(opts: {
  dialect: string;
  schema?: string;
  table: string;
}): IndexFragmentationQuery | { error: string } {
  const target = targetOf(opts);
  const impl = resolveIndexFragmentation(target.dialect);
  const support = impl?.support ?? DEFAULT_UNSUPPORTED;
  if (!support.query) return { error: support.hint };
  if (!target.table) return { error: 'Table name is required for index fragmentation.' };
  if (impl) return impl.probe(target);

  // Generic fallback: empty typed result — custom SQL still available.
  return {
    mode: 'estimated',
    params: [],
    sql: `SELECT CAST(NULL AS VARCHAR(128)) AS index_name, CAST(NULL AS FLOAT) AS fragmentation_percent, CAST(NULL AS TIMESTAMP) AS last_used, CAST(NULL AS BIGINT) AS scan_count WHERE 1 = 0`,
  };
}

/**
 * Extra SELECTs that fill `last_used` / `scan_count` from dialect usage catalogs.
 * Tried in order until one succeeds — a missing view or missing grant must not
 * fail the fragmentation probe (Oracle DBA_INDEX_USAGE is a common example).
 *
 * SQL Server / Azure SQL / DB2 already join usage into the main probe, so they
 * return an empty list here.
 */
export function buildIndexUsageQueries(opts: {
  dialect: string;
  schema?: string;
  table: string;
}): IndexUsageQuery[] {
  const target = targetOf(opts);
  if (!target.table) return [];
  return resolveIndexFragmentation(target.dialect)?.usageQueries(target) ?? [];
}

/** Overlay usage-catalog rows onto fragmentation rows, matched by index name. */
export function mergeIndexUsageRows(
  rows: IndexFragmentationRow[],
  usage: ReadonlyArray<IndexFragmentationRow>
): IndexFragmentationRow[] {
  if (usage.length === 0) return rows;
  const byName = new Map<string, IndexFragmentationRow>();
  for (const u of usage) {
    byName.set(u.indexName.toLowerCase(), u);
  }
  return rows.map((row) => {
    const u = byName.get(row.indexName.toLowerCase());
    if (!u) return row;
    return {
      ...row,
      lastUsed: row.lastUsed ?? u.lastUsed ?? null,
      scanCount: row.scanCount ?? u.scanCount ?? null,
    };
  });
}

function pickField(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in row) return row[key];
    const found = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found) return row[found];
  }
  return undefined;
}

function asFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Driver timestamps (Date, ISO string, dialect DATE) → ISO-8601, or null when
 * missing / the engine's "never used" sentinel (year before 1971, e.g. DB2 0001-01-01).
 */
export function normalizeIndexLastUsed(value: unknown): string | null {
  if (value == null || value === '') return null;
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value > 1e12 ? value : value * 1000);
  } else if (typeof value === 'string') {
    const t = value.trim();
    if (!t || /^0+1[-/]0*1[-/]0*1/.test(t)) return null;
    const parsed = new Date(t);
    date = Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (!date || !Number.isFinite(date.getTime())) return null;
  if (date.getUTCFullYear() < 1971) return null;
  return date.toISOString();
}

/** Normalize driver rows (any casing) into IndexFragmentationRow[]. */
export function normalizeIndexFragmentationRows(
  rows: ReadonlyArray<Record<string, unknown>>
): IndexFragmentationRow[] {
  const out: IndexFragmentationRow[] = [];
  for (const row of rows) {
    const nameRaw = pickField(row, [
      'index_name',
      'indexname',
      'indname',
      'name',
      'INDEX_NAME',
    ]);
    const indexName = nameRaw == null ? '' : String(nameRaw).trim();
    if (!indexName) continue;
    let pct = asFiniteNumber(
      pickField(row, [
        'fragmentation_percent',
        'fragmentationpercent',
        'avg_fragmentation_in_percent',
        'leaf_fragmentation',
        'frag_pct',
        'pct',
      ])
    );
    if (pct != null) {
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
    }
    const pageCount = asFiniteNumber(
      pickField(row, ['page_count', 'pagecount', 'nleaf', 'leaf_blocks'])
    );
    const lastUsed = normalizeIndexLastUsed(
      pickField(row, [
        'last_used',
        'lastused',
        'last_idx_scan',
        'last_access_time',
        'last_used_at',
        'lastusedate',
      ])
    );
    const scanCount = asFiniteNumber(
      pickField(row, [
        'scan_count',
        'scancount',
        'idx_scan',
        'user_seeks',
        'query_total',
        'total_access_count',
        'count_read',
        'count_star',
        'rows_read',
      ])
    );
    out.push({
      indexName,
      fragmentationPercent: pct,
      pageCount,
      lastUsed,
      scanCount,
    });
  }
  return out;
}

/**
 * What this engine calls the operation, for buttons and confirmations.
 *
 * "Defragment" is SQL Server's word. Postgres reindexes, MySQL optimises, Db2
 * reorgs — and the SQL emitted below has always been dialect-correct, so the
 * label was the only part still speaking one engine's language to all of them.
 * A reader who knows their own database should recognise the verb on the
 * button as the one they would have typed.
 */
export function indexMaintenanceVerb(dialect: string): string {
  // Nothing engine-specific to promise for unknown engines, so describe the intent.
  return resolveIndexFragmentation(dialect)?.maintenanceVerb ?? 'Rebuild';
}

/**
 * Suggest maintenance SQL for one index. Uses Microsoft-style bands when the
 * engine supports REBUILD vs REORGANIZE; otherwise a single dialect action.
 */
export function buildIndexDefragSql(opts: {
  dialect: string;
  schema?: string;
  table: string;
  indexName: string;
  fragmentationPercent?: number | null;
}): string[] {
  const target = targetOf(opts);
  const impl = resolveIndexFragmentation(target.dialect);
  if (!impl || !impl.support.defrag) return [];
  const idx = opts.indexName.trim();
  if (!target.table || !idx) return [];
  return impl.defragSql(target, idx, opts.fragmentationPercent);
}

/**
 * Quoted DROP INDEX (or dialect equivalent) for Utilities → Index Management.
 * Returns empty when the name/table is missing, the dialect has no secondary
 * indexes (Redshift), or the index backs a UNIQUE/PK constraint — those must
 * be dropped from Edit table as constraints, not with DROP INDEX.
 */
export function buildIndexDropSql(opts: {
  dialect: string;
  schema?: string;
  table: string;
  indexName: string;
  constraint?: boolean;
}): string[] {
  if (opts.constraint) return [];
  const target = targetOf(opts);
  const idx = opts.indexName.trim();
  if (!target.table || !idx) return [];
  const impl = resolveIndexFragmentation(target.dialect);
  if (impl) return impl.dropSql(target, idx);
  return [`DROP INDEX ${quoteIndexTarget(target).indexQualified(idx)};`];
}

/** Example custom SELECT admins can paste when the default probe fails. */
export function buildIndexFragmentationCustomTemplate(opts: {
  dialect: string;
  schema?: string;
  table: string;
}): string {
  const target = targetOf(opts);
  const impl = resolveIndexFragmentation(target.dialect);
  if (impl) return impl.customTemplate(target);
  return `SELECT 'idx_name' AS index_name, 0 AS fragmentation_percent;`;
}

/**
 * Reject unsafe custom probes on the stats endpoint: one read-only statement.
 *
 * The endpoint runs this SQL without the SQL editor's permission gate, so it
 * applies that gate's reading here: the shared tokenizer, as `dialect` reads
 * the text, and the same per-statement categories. A regex that removed
 * comments first did not know a `/*` inside a string is not a comment, and
 * `SELECT '/*', 1 INTO t FROM x -- *\/` hid its INTO that way and created a
 * table.
 */
export function isSafeIndexFragmentationCustomSql(sql: string, dialect?: string): true | string {
  const t = sql.trim();
  if (!t) return 'Custom SQL is empty.';
  if (t.length > 20_000) return 'Custom SQL is too long.';
  if (sqlStatementCount(t, dialect) > 1) {
    return 'Custom SQL must be a single statement.';
  }
  const verb = firstKeyword(t);
  if (verb !== 'select' && verb !== 'with') {
    return 'Custom SQL must be a SELECT (or WITH … SELECT) statement.';
  }
  // `WITH x AS (DELETE … RETURNING …) SELECT …` and `SELECT … INTO t` start
  // like reads but write.
  if (sqlStatementCategories(t, dialect).some((category) => category !== 'read')) {
    return 'Custom SQL must be read-only (no INSERT/UPDATE/DELETE/DDL, SELECT … INTO, or writes in CTEs).';
  }
  return true;
}
