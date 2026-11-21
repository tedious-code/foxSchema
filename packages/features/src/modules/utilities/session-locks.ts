/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dialect-aware lock/blocking-chain probes and safe session control SQL
 * (cancel active query vs terminate blocking session).
 *
 * Browser-safe: pure string/data logic, no Node built-ins.
 */

export type SessionControlAction = 'cancel' | 'terminate';

export interface SessionLocksSupport {
  supported: boolean;
  canCancelQuery: boolean;
  canTerminateSession: boolean;
  hint: string;
}

export interface LockWaitProbeQuery {
  sql: string;
  params: unknown[];
}

export interface LockWaitRow {
  blockedSessionId: string;
  blockingSessionId: string;
  blockedUser: string | null;
  blockingUser: string | null;
  lockMode: string | null;
  lockedObject: string | null;
  waitSeconds: number | null;
  blockedQuery: string | null;
  blockingQuery: string | null;
}

export interface BlockingChain {
  rootBlockerSessionId: string;
  blockerUser: string | null;
  blockerQuery: string | null;
  directBlockedIds: string[];
  allBlockedIds: string[];
  blockedCount: number;
  maxWaitSeconds: number | null;
}

const UNSUPPORTED: SessionLocksSupport = {
  supported: false,
  canCancelQuery: false,
  canTerminateSession: false,
  hint: 'This dialect does not expose cross-session lock wait or kill controls.',
};

/** Describe lock-wait and session-control capabilities for a dialect. */
export function dialectSupportsSessionLocks(dialect: string): SessionLocksSupport {
  switch ((dialect || '').trim().toLowerCase()) {
    case 'postgres':
    case 'yugabytedb':
      return {
        supported: true,
        canCancelQuery: true,
        canTerminateSession: true,
        hint: 'PostgreSQL: pg_blocking_pids() lock wait probe + pg_cancel_backend / pg_terminate_backend.',
      };
    case 'cockroachdb':
      // Not wired yet: lock waits live in crdb_internal.cluster_locks, and
      // CANCEL QUERY / CANCEL SESSION take CockroachDB's own hex query and
      // session IDs, not the pg_stat_activity ids the Sessions tab lists.
      return {
        ...UNSUPPORTED,
        hint: 'CockroachDB: lock wait chains and cancel/kill are not supported here yet.',
      };
    case 'mysql':
    case 'mariadb':
    case 'tidb':
      return {
        supported: true,
        canCancelQuery: true,
        canTerminateSession: true,
        hint: 'MySQL/MariaDB/TiDB: lock wait probe + KILL QUERY / KILL.',
      };
    case 'sqlserver':
    case 'azuresql':
      return {
        supported: true,
        canCancelQuery: false,
        canTerminateSession: true,
        hint: 'SQL Server / Azure SQL: sys.dm_exec_requests blocking_session_id probe + KILL <spid>.',
      };
    case 'oracle':
      return {
        supported: true,
        canCancelQuery: true,
        canTerminateSession: true,
        hint: 'Oracle: V$SESSION blocking_session probe + ALTER SYSTEM CANCEL SQL / KILL SESSION.',
      };
    case 'db2':
      return {
        supported: true,
        canCancelQuery: false,
        canTerminateSession: true,
        hint: 'DB2: MON_GET_APPL_LOCKWAIT probe + FORCE APPLICATION (<handle>).',
      };
    case 'sqlite':
    case 'duckdb':
      return {
        ...UNSUPPORTED,
        hint: 'Embedded single-process engine: no server-wide lock wait or session kill.',
      };
    case 'clickhouse':
    case 'redshift':
      return {
        ...UNSUPPORTED,
        hint: 'Analytical engine does not expose transactional row-lock blocking trees.',
      };
    default:
      return UNSUPPORTED;
  }
}

/** Build a read-only SQL query returning current lock waits and their blockers. */
export function buildLockWaitProbeQuery(
  dialect: string,
): LockWaitProbeQuery | { error: string } {
  const d = (dialect || '').trim().toLowerCase();
  const support = dialectSupportsSessionLocks(d);
  if (!support.supported) {
    return { error: support.hint };
  }

  if (d === 'postgres' || d === 'yugabytedb') {
    return {
      sql: `
SELECT
  blocked.pid::text AS blocked_session_id,
  blocker.pid::text AS blocking_session_id,
  blocked.usename AS blocked_user,
  blocker.usename AS blocking_user,
  blocked.wait_event AS lock_mode,
  blocked.datname AS locked_object,
  EXTRACT(EPOCH FROM (NOW() - blocked.state_change))::int AS wait_seconds,
  LEFT(blocked.query, 500) AS blocked_query,
  LEFT(blocker.query, 500) AS blocking_query
FROM pg_stat_activity blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocker_pid
JOIN pg_stat_activity blocker ON blocker.pid = blocker_pid
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER BY wait_seconds DESC NULLS LAST;`.trim(),
      params: [],
    };
  }

  if (d === 'tidb') {
    // TiDB has no InnoDB lock tables; pessimistic lock waits are in
    // DATA_LOCK_WAITS, keyed by TiDB transaction ids that TIDB_TRX maps to
    // the connection ids KILL takes.
    return {
      sql: `
SELECT
  CAST(r.SESSION_ID AS CHAR) AS blocked_session_id,
  CAST(b.SESSION_ID AS CHAR) AS blocking_session_id,
  r.USER AS blocked_user,
  b.USER AS blocking_user,
  'LOCK_WAIT' AS lock_mode,
  r.DB AS locked_object,
  TIMESTAMPDIFF(SECOND, r.WAITING_START_TIME, NOW()) AS wait_seconds,
  LEFT(w.SQL_DIGEST_TEXT, 500) AS blocked_query,
  LEFT(b.CURRENT_SQL_DIGEST_TEXT, 500) AS blocking_query
FROM information_schema.DATA_LOCK_WAITS w
JOIN information_schema.TIDB_TRX r ON r.ID = w.TRX_ID
JOIN information_schema.TIDB_TRX b ON b.ID = w.CURRENT_HOLDING_TRX_ID
ORDER BY wait_seconds DESC;`.trim(),
      params: [],
    };
  }

  if (d === 'mysql' || d === 'mariadb') {
    const waitTable =
      d === 'mysql'
        ? 'performance_schema.data_lock_waits'
        : 'information_schema.INNODB_LOCK_WAITS';
    const trxTable =
      d === 'mysql'
        ? 'information_schema.innodb_trx'
        : 'information_schema.INNODB_TRX';
    if (d === 'mysql') {
      return {
        sql: `
SELECT
  CAST(r.trx_mysql_thread_id AS CHAR) AS blocked_session_id,
  CAST(b.trx_mysql_thread_id AS CHAR) AS blocking_session_id,
  p1.USER AS blocked_user,
  p2.USER AS blocking_user,
  dl.LOCK_MODE AS lock_mode,
  CONCAT(dl.OBJECT_SCHEMA, '.', dl.OBJECT_NAME) AS locked_object,
  TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS wait_seconds,
  LEFT(r.trx_query, 500) AS blocked_query,
  LEFT(b.trx_query, 500) AS blocking_query
FROM ${waitTable} w
JOIN ${trxTable} r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
JOIN ${trxTable} b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
LEFT JOIN performance_schema.data_locks dl ON dl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
LEFT JOIN information_schema.PROCESSLIST p1 ON p1.ID = r.trx_mysql_thread_id
LEFT JOIN information_schema.PROCESSLIST p2 ON p2.ID = b.trx_mysql_thread_id
ORDER BY wait_seconds DESC;`.trim(),
        params: [],
      };
    }
    return {
      sql: `
SELECT
  CAST(r.trx_mysql_thread_id AS CHAR) AS blocked_session_id,
  CAST(b.trx_mysql_thread_id AS CHAR) AS blocking_session_id,
  p1.USER AS blocked_user,
  p2.USER AS blocking_user,
  'LOCK_WAIT' AS lock_mode,
  NULL AS locked_object,
  TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS wait_seconds,
  LEFT(r.trx_query, 500) AS blocked_query,
  LEFT(b.trx_query, 500) AS blocking_query
FROM ${waitTable} w
JOIN ${trxTable} r ON r.trx_id = w.requesting_trx_id
JOIN ${trxTable} b ON b.trx_id = w.blocking_trx_id
LEFT JOIN information_schema.PROCESSLIST p1 ON p1.ID = r.trx_mysql_thread_id
LEFT JOIN information_schema.PROCESSLIST p2 ON p2.ID = b.trx_mysql_thread_id
ORDER BY wait_seconds DESC;`.trim(),
      params: [],
    };
  }

  if (d === 'sqlserver' || d === 'azuresql') {
    return {
      sql: `
SELECT
  CAST(r.session_id AS VARCHAR(20)) AS blocked_session_id,
  CAST(r.blocking_session_id AS VARCHAR(20)) AS blocking_session_id,
  s1.login_name AS blocked_user,
  s2.login_name AS blocking_user,
  r.wait_type AS lock_mode,
  r.wait_resource AS locked_object,
  CAST(r.wait_time / 1000 AS INT) AS wait_seconds,
  SUBSTRING(st1.text, 1, 500) AS blocked_query,
  SUBSTRING(st2.text, 1, 500) AS blocking_query
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions s1 ON s1.session_id = r.session_id
LEFT JOIN sys.dm_exec_sessions s2 ON s2.session_id = r.blocking_session_id
LEFT JOIN sys.dm_exec_connections c2 ON c2.session_id = r.blocking_session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st1
OUTER APPLY sys.dm_exec_sql_text(c2.most_recent_sql_handle) st2
WHERE r.blocking_session_id > 0
ORDER BY wait_seconds DESC;`.trim(),
      params: [],
    };
  }

  if (d === 'oracle') {
    return {
      sql: `
SELECT
  w.SID || ',' || w."SERIAL#" AS blocked_session_id,
  b.SID || ',' || b."SERIAL#" AS blocking_session_id,
  w.USERNAME AS blocked_user,
  b.USERNAME AS blocking_user,
  w.EVENT AS lock_mode,
  TO_CHAR(w.ROW_WAIT_OBJ#) AS locked_object,
  w.SECONDS_IN_WAIT AS wait_seconds,
  SUBSTR(sq1.SQL_TEXT, 1, 500) AS blocked_query,
  SUBSTR(sq2.SQL_TEXT, 1, 500) AS blocking_query
FROM V$SESSION w
JOIN V$SESSION b ON b.SID = w.BLOCKING_SESSION
LEFT JOIN V$SQL sq1 ON sq1.SQL_ID = w.SQL_ID AND sq1.CHILD_NUMBER = 0
LEFT JOIN V$SQL sq2 ON sq2.SQL_ID = b.SQL_ID AND sq2.CHILD_NUMBER = 0
WHERE w.BLOCKING_SESSION IS NOT NULL
ORDER BY w.SECONDS_IN_WAIT DESC`.trim(),
      params: [],
    };
  }

  // DB2
  return {
    sql: `
SELECT
  CHAR(REQ_APPLICATION_HANDLE) AS blocked_session_id,
  CHAR(HLD_APPLICATION_HANDLE) AS blocking_session_id,
  REQ_USERID AS blocked_user,
  HLD_USERID AS blocking_user,
  LOCK_MODE AS lock_mode,
  LOCK_OBJECT_TYPE AS locked_object,
  LOCK_WAIT_ELAPSED_TIME AS wait_seconds,
  NULL AS blocked_query,
  NULL AS blocking_query
FROM TABLE(MON_GET_APPL_LOCKWAIT(NULL, -2))
ORDER BY wait_seconds DESC`.trim(),
    params: [],
  };
}

function pickCol(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  return undefined;
}

function textOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize heterogeneous catalog rows into a uniform LockWaitRow[] shape. */
export function normalizeLockWaitRows(rows: readonly Record<string, unknown>[]): LockWaitRow[] {
  return rows
    .map((row) => ({
      blockedSessionId: textOrNull(pickCol(row, 'blocked_session_id', 'blockedSessionId')) ?? '',
      blockingSessionId: textOrNull(pickCol(row, 'blocking_session_id', 'blockingSessionId')) ?? '',
      blockedUser: textOrNull(pickCol(row, 'blocked_user', 'blockedUser')),
      blockingUser: textOrNull(pickCol(row, 'blocking_user', 'blockingUser')),
      lockMode: textOrNull(pickCol(row, 'lock_mode', 'lockMode')),
      lockedObject: textOrNull(pickCol(row, 'locked_object', 'lockedObject')),
      waitSeconds: numOrNull(pickCol(row, 'wait_seconds', 'waitSeconds')),
      blockedQuery: textOrNull(pickCol(row, 'blocked_query', 'blockedQuery')),
      blockingQuery: textOrNull(pickCol(row, 'blocking_query', 'blockingQuery')),
    }))
    .filter((r) => r.blockedSessionId.length > 0 && r.blockingSessionId.length > 0);
}

/**
 * Group lock wait edges into root-blocker chains, ordered by severity
 * (longest wait first, then most blocked sessions). Cycle-safe.
 */
export function buildBlockingChains(rows: readonly LockWaitRow[]): BlockingChain[] {
  if (rows.length === 0) return [];

  const blockedSet = new Set(rows.map((r) => r.blockedSessionId));
  const children = new Map<string, LockWaitRow[]>();
  const blockerInfo = new Map<string, { user: string | null; query: string | null }>();

  for (const row of rows) {
    const list = children.get(row.blockingSessionId) ?? [];
    list.push(row);
    children.set(row.blockingSessionId, list);
    if (!blockerInfo.has(row.blockingSessionId)) {
      blockerInfo.set(row.blockingSessionId, {
        user: row.blockingUser,
        query: row.blockingQuery,
      });
    }
  }

  // Root blockers are sessions blocking others that are not themselves blocked.
  // If every blocker is part of a cycle, fall back to all distinct blockers.
  const allBlockers = [...children.keys()];
  const roots = allBlockers.filter((id) => !blockedSet.has(id));
  const startNodes = roots.length > 0 ? roots : allBlockers;

  const chains: BlockingChain[] = [];
  for (const rootId of startNodes) {
    const directRows = children.get(rootId) ?? [];
    const directBlockedIds = [...new Set(directRows.map((r) => r.blockedSessionId))];
    const visited = new Set<string>([rootId]);
    const queue = [...directBlockedIds];
    const allBlockedIds: string[] = [];
    let maxWait: number | null = null;

    for (const r of directRows) {
      if (r.waitSeconds != null) {
        maxWait = maxWait == null ? r.waitSeconds : Math.max(maxWait, r.waitSeconds);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      allBlockedIds.push(current);
      for (const edge of children.get(current) ?? []) {
        if (edge.waitSeconds != null) {
          maxWait = maxWait == null ? edge.waitSeconds : Math.max(maxWait, edge.waitSeconds);
        }
        if (!visited.has(edge.blockedSessionId)) {
          queue.push(edge.blockedSessionId);
        }
      }
    }

    const meta = blockerInfo.get(rootId);
    chains.push({
      rootBlockerSessionId: rootId,
      blockerUser: meta?.user ?? null,
      blockerQuery: meta?.query ?? null,
      directBlockedIds,
      allBlockedIds,
      blockedCount: allBlockedIds.length,
      maxWaitSeconds: maxWait,
    });
  }

  return chains.sort((a, b) => {
    const waitDiff = (b.maxWaitSeconds ?? -1) - (a.maxWaitSeconds ?? -1);
    if (waitDiff !== 0) return waitDiff;
    const countDiff = b.blockedCount - a.blockedCount;
    if (countDiff !== 0) return countDiff;
    return a.rootBlockerSessionId.localeCompare(b.rootBlockerSessionId);
  });
}

/**
 * Generate a validated, dialect-specific statement to cancel a running query
 * or terminate a blocking session. Validates session identifiers strictly so
 * untrusted strings cannot inject SQL.
 */
export function buildSessionControlSql(
  dialect: string,
  action: SessionControlAction,
  sessionId: string,
): { sql: string; description: string } | { error: string } {
  const d = (dialect || '').trim().toLowerCase();
  const support = dialectSupportsSessionLocks(d);
  if (!support.supported) {
    return { error: support.hint };
  }
  if (action === 'cancel' && !support.canCancelQuery) {
    return { error: `${d} does not support cancelling an individual query without terminating the session.` };
  }

  const rawId = (sessionId || '').trim();
  if (!rawId) {
    return { error: 'Session ID is required.' };
  }

  if (d === 'oracle') {
    const match = rawId.match(/^(\d+),(\d+)$/);
    if (!match) {
      return { error: 'Oracle session ID must be "<SID>,<SERIAL#>" (digits only).' };
    }
    const [, sid, serial] = match;
    if (action === 'cancel') {
      return {
        sql: `ALTER SYSTEM CANCEL SQL '${sid}, ${serial}'`,
        description: `Cancel active SQL in Oracle session ${sid},${serial}.`,
      };
    }
    return {
      sql: `ALTER SYSTEM KILL SESSION '${sid},${serial}' IMMEDIATE`,
      description: `Terminate Oracle session ${sid},${serial}.`,
    };
  }


  if (!/^\d{1,12}$/.test(rawId)) {
    return { error: `Session ID for ${d} must be a positive integer.` };
  }

  if (d === 'postgres' || d === 'yugabytedb') {
    const fn = action === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend';
    return {
      sql: `SELECT ${fn}(${rawId});`,
      description:
        action === 'cancel'
          ? `Cancel active query on backend PID ${rawId}.`
          : `Terminate blocking backend PID ${rawId}.`,
    };
  }

  if (d === 'mysql' || d === 'mariadb' || d === 'tidb') {
    return action === 'cancel'
      ? { sql: `KILL QUERY ${rawId};`, description: `Cancel active query on thread ${rawId}.` }
      : { sql: `KILL ${rawId};`, description: `Terminate blocking connection thread ${rawId}.` };
  }

  if (d === 'sqlserver' || d === 'azuresql') {
    return {
      sql: `KILL ${rawId};`,
      description: `Terminate SQL Server session SPID ${rawId}.`,
    };
  }

  if (d === 'db2') {
    return {
      sql: `CALL SYSPROC.ADMIN_CMD('FORCE APPLICATION (${rawId})')`,
      description: `Force off DB2 application handle ${rawId}.`,
    };
  }

  return { error: support.hint };
}
