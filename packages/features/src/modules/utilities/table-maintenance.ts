/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dialect-aware table health probes (dead tuples, bloat, stale statistics)
 * and maintenance SQL generation (ANALYZE / VACUUM / OPTIMIZE / RUNSTATS).
 *
 * Browser-safe: pure string/data logic, no Node built-ins.
 */

export type TableMaintenanceAction = 'analyze' | 'vacuum' | 'optimize';

export interface TableMaintenanceSupport {
  supported: boolean;
  canAnalyze: boolean;
  canVacuum: boolean;
  canOptimize: boolean;
  canInspectHealth: boolean;
  hint: string;
}

export interface TableHealthProbeQuery {
  sql: string;
  params: unknown[];
}

export interface TableHealthRow {
  schemaName: string | null;
  tableName: string;
  liveRows: number | null;
  deadRows: number | null;
  deadRatioPct: number | null;
  bloatBytes: number | null;
  staleStats: boolean | null;
  lastAnalyzed: string | null;
  lastVacuumed: string | null;
}

const UNSUPPORTED: TableMaintenanceSupport = {
  supported: false,
  canAnalyze: false,
  canVacuum: false,
  canOptimize: false,
  canInspectHealth: false,
  hint: 'This dialect does not expose table health or statistics maintenance.',
};

/** Describe table health inspection & maintenance capabilities for a dialect. */
export function dialectSupportsTableMaintenance(dialect: string): TableMaintenanceSupport {
  switch ((dialect || '').trim().toLowerCase()) {
    case 'postgres':
    case 'yugabytedb':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: true,
        canOptimize: false,
        canInspectHealth: true,
        hint: 'PostgreSQL: pg_stat_user_tables dead tuples & timestamps + ANALYZE / VACUUM (ANALYZE).',
      };
    case 'cockroachdb':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: false,
        canOptimize: false,
        canInspectHealth: false,
        hint: 'CockroachDB: ANALYZE collects table statistics.',
      };
    case 'mysql':
    case 'mariadb':
    case 'tidb':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: false,
        canOptimize: true,
        canInspectHealth: true,
        hint: 'MySQL/MariaDB/TiDB: information_schema.TABLES DATA_FREE + ANALYZE TABLE / OPTIMIZE TABLE.',
      };
    case 'sqlserver':
    case 'azuresql':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: false,
        canOptimize: true,
        canInspectHealth: true,
        hint: 'SQL Server / Azure SQL: dm_db_stats_properties modification_counter + UPDATE STATISTICS / ALTER INDEX REORGANIZE.',
      };
    case 'oracle':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: true,
        canOptimize: false,
        canInspectHealth: true,
        hint: 'Oracle: ALL_TAB_STATISTICS STALE_STATS + DBMS_STATS.GATHER_TABLE_STATS / ALTER TABLE ... SHRINK SPACE.',
      };
    case 'db2':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: false,
        canOptimize: true,
        canInspectHealth: true,
        hint: 'DB2: SYSCAT.TABLES STATS_TIME + RUNSTATS / REORG TABLE.',
      };
    case 'sqlite':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: true,
        canOptimize: false,
        canInspectHealth: true,
        hint: 'SQLite: sqlite_master table listing + ANALYZE / VACUUM.',
      };
    case 'duckdb':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: false,
        canOptimize: false,
        canInspectHealth: true,
        hint: 'DuckDB: duckdb_tables() row estimates + ANALYZE.',
      };
    case 'clickhouse':
      return {
        supported: true,
        canAnalyze: false,
        canVacuum: false,
        canOptimize: true,
        canInspectHealth: true,
        hint: 'ClickHouse: system.tables active parts & bytes + OPTIMIZE TABLE ... FINAL.',
      };
    case 'redshift':
      return {
        supported: true,
        canAnalyze: true,
        canVacuum: true,
        canOptimize: false,
        canInspectHealth: false,
        hint: 'Redshift: ANALYZE / VACUUM.',
      };
    default:
      return UNSUPPORTED;
  }
}

/** Build a read-only query inspecting table row health, dead tuples, bloat, and stale stats. */
export function buildTableHealthProbeQuery(
  dialect: string,
  schema?: string,
): TableHealthProbeQuery | { error: string } {
  const d = (dialect || '').trim().toLowerCase();
  const support = dialectSupportsTableMaintenance(d);
  if (!support.canInspectHealth) {
    return { error: support.hint };
  }
  const s = (schema || '').trim();

  if (d === 'postgres' || d === 'yugabytedb') {
    return {
      sql: `
SELECT
  schemaname AS schema_name,
  relname AS table_name,
  n_live_tup AS live_rows,
  n_dead_tup AS dead_rows,
  NULL::bigint AS bloat_bytes,
  (last_analyze IS NULL AND last_autoanalyze IS NULL) AS stale_stats,
  COALESCE(last_analyze, last_autoanalyze)::text AS last_analyzed,
  COALESCE(last_vacuum, last_autovacuum)::text AS last_vacuumed
FROM pg_stat_user_tables
${s ? 'WHERE schemaname = $1' : ''}
ORDER BY n_dead_tup DESC, n_live_tup DESC
LIMIT 200;`.trim(),
      params: s ? [s] : [],
    };
  }

  if (d === 'mysql' || d === 'mariadb' || d === 'tidb') {
    return {
      sql: `
SELECT
  TABLE_SCHEMA AS schema_name,
  TABLE_NAME AS table_name,
  TABLE_ROWS AS live_rows,
  NULL AS dead_rows,
  DATA_FREE AS bloat_bytes,
  -- UPDATE_TIME is the last data change, not the last ANALYZE, and
  -- information_schema has no analyze timestamp to report instead.
  NULL AS stale_stats,
  NULL AS last_analyzed,
  NULL AS last_vacuumed
FROM information_schema.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
  ${s ? 'AND TABLE_SCHEMA = ?' : "AND TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')"}
ORDER BY DATA_FREE DESC, TABLE_ROWS DESC
LIMIT 200;`.trim(),
      params: s ? [s] : [],
    };
  }

  if (d === 'sqlserver' || d === 'azuresql') {
    return {
      sql: `
SELECT TOP 200
  s.name AS schema_name,
  t.name AS table_name,
  rc.live_rows,
  sx.modifications AS dead_rows,
  NULL AS bloat_bytes,
  CASE WHEN sx.modifications > 500 THEN 1 ELSE 0 END AS stale_stats,
  CONVERT(VARCHAR(30), sx.last_updated, 126) AS last_analyzed,
  NULL AS last_vacuumed
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
-- Row count and statistics are aggregated separately: joining sys.stats to
-- sys.partitions repeats every partition row once per statistics object.
OUTER APPLY (
  SELECT SUM(p.rows) AS live_rows
  FROM sys.partitions p
  WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)
) rc
OUTER APPLY (
  SELECT MAX(sp.modification_counter) AS modifications, MAX(sp.last_updated) AS last_updated
  FROM sys.stats st
  CROSS APPLY sys.dm_db_stats_properties(st.object_id, st.stats_id) sp
  WHERE st.object_id = t.object_id
) sx
${s ? 'WHERE s.name = @p0' : ''}
ORDER BY sx.modifications DESC, rc.live_rows DESC;`.trim(),
      params: s ? [s] : [],
    };
  }

  if (d === 'oracle') {
    return {
      sql: `
SELECT
  OWNER AS schema_name,
  TABLE_NAME AS table_name,
  NUM_ROWS AS live_rows,
  NULL AS dead_rows,
  NULL AS bloat_bytes,
  CASE WHEN STALE_STATS = 'YES' THEN 1 ELSE 0 END AS stale_stats,
  TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_analyzed,
  NULL AS last_vacuumed
FROM ALL_TAB_STATISTICS
WHERE OBJECT_TYPE = 'TABLE'
  ${s ? 'AND OWNER = UPPER(:1)' : "AND OWNER NOT IN ('SYS','SYSTEM')"}
ORDER BY LAST_ANALYZED ASC NULLS FIRST
FETCH FIRST 200 ROWS ONLY`.trim(),
      params: s ? [s] : [],
    };
  }

  if (d === 'db2') {
    return {
      sql: `
SELECT
  TRIM(TABSCHEMA) AS schema_name,
  TRIM(TABNAME) AS table_name,
  CARD AS live_rows,
  NULL AS dead_rows,
  NULL AS bloat_bytes,
  CASE WHEN STATS_TIME IS NULL THEN 1 ELSE 0 END AS stale_stats,
  VARCHAR_FORMAT(STATS_TIME, 'YYYY-MM-DD HH24:MI:SS') AS last_analyzed,
  NULL AS last_vacuumed
FROM SYSCAT.TABLES
WHERE TYPE = 'T'
  ${s ? 'AND TABSCHEMA = UPPER(?)' : "AND TABSCHEMA NOT LIKE 'SYS%'"}
ORDER BY STATS_TIME ASC NULLS FIRST
FETCH FIRST 200 ROWS ONLY`.trim(),
      params: s ? [s] : [],
    };
  }

  if (d === 'sqlite') {
    return {
      sql: `
SELECT
  'main' AS schema_name,
  name AS table_name,
  NULL AS live_rows,
  NULL AS dead_rows,
  NULL AS bloat_bytes,
  NULL AS stale_stats,
  NULL AS last_analyzed,
  NULL AS last_vacuumed
FROM sqlite_master
WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
ORDER BY name
LIMIT 200;`.trim(),
      params: [],
    };
  }

  if (d === 'duckdb') {
    return {
      sql: `
SELECT
  schema_name,
  table_name,
  estimated_size AS live_rows,
  NULL AS dead_rows,
  NULL AS bloat_bytes,
  NULL AS stale_stats,
  NULL AS last_analyzed,
  NULL AS last_vacuumed
FROM duckdb_tables()
${s ? 'WHERE schema_name = ?' : ''}
ORDER BY estimated_size DESC
LIMIT 200;`.trim(),
      params: s ? [s] : [],
    };
  }

  // ClickHouse
  return {
    sql: `
SELECT
  database AS schema_name,
  name AS table_name,
  total_rows AS live_rows,
  NULL AS dead_rows,
  NULL AS bloat_bytes,
  NULL AS stale_stats,
  NULL AS last_analyzed,
  NULL AS last_vacuumed
FROM system.tables
WHERE engine NOT IN ('View', 'MaterializedView', 'Memory')
  ${s ? 'AND database = $1' :"AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')"}
ORDER BY total_rows DESC
LIMIT 200;`.trim(),
    params: s ? [s] : [],
  };
}

function pickField(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  return undefined;
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toBool(v: unknown): boolean | null {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === 't' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === 'f' || s === '0' || s === 'no') return false;
  return null;
}

function toText(v: unknown): string | null {
  if (v == null) return null;
  const s = v instanceof Date ? v.toISOString() : String(v).trim();
  return s.length > 0 ? s : null;
}

/** Normalize catalog rows into uniform TableHealthRow[] entries. */
export function normalizeTableHealthRows(rows: readonly Record<string, unknown>[]): TableHealthRow[] {
  return rows
    .map((row) => {
      const liveRows = toNum(pickField(row, 'live_rows', 'liveRows'));
      const deadRows = toNum(pickField(row, 'dead_rows', 'deadRows'));
      let deadRatioPct: number | null = null;
      if (deadRows != null && liveRows != null && liveRows + deadRows > 0) {
        deadRatioPct = Number(((deadRows / (liveRows + deadRows)) * 100).toFixed(1));
      }
      return {
        schemaName: toText(pickField(row, 'schema_name', 'schemaName')),
        tableName: toText(pickField(row, 'table_name', 'tableName')) ?? '',
        liveRows,
        deadRows,
        deadRatioPct,
        bloatBytes: toNum(pickField(row, 'bloat_bytes', 'bloatBytes')),
        staleStats: toBool(pickField(row, 'stale_stats', 'staleStats')),
        lastAnalyzed: toText(pickField(row, 'last_analyzed', 'lastAnalyzed')),
        lastVacuumed: toText(pickField(row, 'last_vacuumed', 'lastVacuumed')),
      };
    })
    .filter((r) => r.tableName.length > 0);
}

function quotePart(dialect: string, ident: string): string {
  if (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'tidb' || dialect === 'clickhouse') {
    return `\`${ident.replace(/`/g, '``')}\``;
  }
  if (dialect === 'sqlserver' || dialect === 'azuresql') {
    return `[${ident.replace(/]/g, ']]')}]`;
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Generate a safe, dialect-specific maintenance SQL statement for a table
 * (`analyze`, `vacuum`, or `optimize`).
 */
export function buildTableMaintenanceSql(
  dialect: string,
  action: TableMaintenanceAction,
  target: { schema?: string | null; table: string },
): { sql: string; description: string } | { error: string } {
  const d = (dialect || '').trim().toLowerCase();
  const support = dialectSupportsTableMaintenance(d);
  if (!support.supported) {
    return { error: support.hint };
  }
  if (action === 'analyze' && !support.canAnalyze) {
    return { error: `${d} does not support ANALYZE.` };
  }
  if (action === 'vacuum' && !support.canVacuum) {
    return { error: `${d} does not support VACUUM.` };
  }
  if (action === 'optimize' && !support.canOptimize) {
    return { error: `${d} does not support OPTIMIZE / REORG.` };
  }

  const rawTable = (target.table || '').trim();
  if (!rawTable || /[\r\n\0]/.test(rawTable)) {
    return { error: 'A valid table name is required.' };
  }
  const rawSchema = (target.schema || '').trim();
  if (rawSchema && /[\r\n\0]/.test(rawSchema)) {
    return { error: 'Invalid schema name.' };
  }

  const qualified =
    rawSchema && d !== 'sqlite'
      ? `${quotePart(d, rawSchema)}.${quotePart(d, rawTable)}`
      : quotePart(d, rawTable);

  if (d === 'postgres' || d === 'yugabytedb') {
    return action === 'vacuum'
      ? { sql: `VACUUM (ANALYZE) ${qualified};`, description: `Reclaim dead tuples and refresh stats on ${rawTable}.` }
      : { sql: `ANALYZE ${qualified};`, description: `Refresh planner statistics on ${rawTable}.` };
  }

  if (d === 'cockroachdb' || d === 'duckdb' || d === 'redshift') {
    if (action === 'vacuum') {
      return { sql: `VACUUM ${qualified};`, description: `Reclaim space and sort ${rawTable}.` };
    }
    return { sql: `ANALYZE ${qualified};`, description: `Refresh statistics on ${rawTable}.` };
  }

  if (d === 'mysql' || d === 'mariadb' || d === 'tidb') {
    return action === 'optimize'
      ? { sql: `OPTIMIZE TABLE ${qualified};`, description: `Rebuild table storage and reclaim free space on ${rawTable}.` }
      : { sql: `ANALYZE TABLE ${qualified};`, description: `Update key distribution statistics on ${rawTable}.` };
  }

  if (d === 'sqlserver' || d === 'azuresql') {
    return action === 'optimize'
      ? { sql: `ALTER INDEX ALL ON ${qualified} REORGANIZE;`, description: `Reorganize all indexes on ${rawTable}.` }
      : { sql: `UPDATE STATISTICS ${qualified};`, description: `Update query optimizer statistics on ${rawTable}.` };
  }

  if (d === 'oracle') {
    // node-oracledb runs one statement per call and rejects a trailing `;` on
    // plain SQL, so everything Oracle gets here is a single PL/SQL block.
    if (action === 'vacuum') {
      const literal = qualified.replace(/'/g, "''");
      return {
        sql:
          `BEGIN EXECUTE IMMEDIATE 'ALTER TABLE ${literal} ENABLE ROW MOVEMENT'; ` +
          `EXECUTE IMMEDIATE 'ALTER TABLE ${literal} SHRINK SPACE COMPACT'; END;`,
        description: `Compact rows in ${rawTable} to defragment its segment.`,
      };
    }
    // Double-quoted names keep their case; DBMS_STATS uppercases bare ones.
    // With no schema, USER (the session user) is the owner — not a schema
    // literally named 'USER'.
    const ownerArg = rawSchema ? `'"${rawSchema.replace(/"/g, '').replace(/'/g, "''")}"'` : 'USER';
    const tableArg = `'"${rawTable.replace(/"/g, '').replace(/'/g, "''")}"'`;
    return {
      sql: `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => ${ownerArg}, tabname => ${tableArg}); END;`,
      description: `Gather Oracle optimizer statistics on ${rawTable}.`,
    };
  }

  if (d === 'db2') {
    // REORG and RUNSTATS are CLP commands, not SQL: through a driver they only
    // run via SYSPROC.ADMIN_CMD, which also needs a schema-qualified name.
    if (!rawSchema) {
      return { error: 'DB2 table maintenance needs a schema-qualified table.' };
    }
    const literal = qualified.replace(/'/g, "''");
    return action === 'optimize'
      ? {
          sql: `CALL SYSPROC.ADMIN_CMD('REORG TABLE ${literal}')`,
          description: `Reorganize table ${rawTable}.`,
        }
      : {
          sql: `CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE ${literal} WITH DISTRIBUTION AND DETAILED INDEXES ALL')`,
          description: `Collect DB2 RUNSTATS on ${rawTable}.`,
        };
  }

  if (d === 'sqlite') {
    return action === 'vacuum'
      ? { sql: 'VACUUM;', description: 'Rebuild the SQLite database file to reclaim free pages.' }
      : { sql: `ANALYZE ${qualified};`, description: `Update SQLite query planner stats on ${rawTable}.` };
  }

  // ClickHouse
  return {
    sql: `OPTIMIZE TABLE ${qualified} FINAL;`,
    description: `Merge active parts on ClickHouse table ${rawTable}.`,
  };
}
