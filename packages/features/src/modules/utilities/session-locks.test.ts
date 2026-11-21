/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  buildBlockingChains,
  buildLockWaitProbeQuery,
  buildSessionControlSql,
  dialectSupportsSessionLocks,
  normalizeLockWaitRows,
} from './session-locks.js';

describe('session-locks utility', () => {
  it('reports capability support accurately across server and embedded engines', () => {
    expect(dialectSupportsSessionLocks('postgres')).toMatchObject({
      supported: true,
      canCancelQuery: true,
      canTerminateSession: true,
    });
    expect(dialectSupportsSessionLocks('sqlserver')).toMatchObject({
      supported: true,
      canCancelQuery: false,
      canTerminateSession: true,
    });
    expect(dialectSupportsSessionLocks('sqlite').supported).toBe(false);
    expect(dialectSupportsSessionLocks('clickhouse').supported).toBe(false);
  });

  it('builds dialect-specific lock-wait probe queries', () => {
    const pg = buildLockWaitProbeQuery('postgres');
    expect('sql' in pg && pg.sql).toContain('pg_blocking_pids');

    const my = buildLockWaitProbeQuery('mysql');
    expect('sql' in my && my.sql).toContain('performance_schema.data_lock_waits');

    const mssql = buildLockWaitProbeQuery('sqlserver');
    expect('sql' in mssql && mssql.sql).toContain('blocking_session_id');

    const ora = buildLockWaitProbeQuery('oracle');
    expect('sql' in ora && ora.sql).toContain('V$SESSION');

    const db2 = buildLockWaitProbeQuery('db2');
    expect('sql' in db2 && db2.sql).toContain('MON_GET_APPL_LOCKWAIT');

    expect('error' in buildLockWaitProbeQuery('sqlite')).toBe(true);
  });

  it('normalizes rows and builds multi-hop blocking chains ordered by max wait', () => {
    const rows = normalizeLockWaitRows([
      {
        blocked_session_id: '201',
        blocking_session_id: '101',
        blocked_user: 'app',
        blocking_user: 'etl',
        lock_mode: 'Lock',
        locked_object: 'orders',
        wait_seconds: 12,
        blocked_query: 'UPDATE orders SET status = 1',
        blocking_query: 'ALTER TABLE orders ADD COLUMN note TEXT',
      },
      {
        blocked_session_id: '301',
        blocking_session_id: '201',
        blocked_user: 'api',
        blocking_user: 'app',
        lock_mode: 'Lock',
        locked_object: 'orders',
        wait_seconds: 5,
      },
      {
        blocked_session_id: '401',
        blocking_session_id: '102',
        wait_seconds: 40,
      },
    ]);

    const chains = buildBlockingChains(rows);
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatchObject({
      rootBlockerSessionId: '102',
      blockedCount: 1,
      maxWaitSeconds: 40,
    });
    expect(chains[1]).toMatchObject({
      rootBlockerSessionId: '101',
      blockerUser: 'etl',
      directBlockedIds: ['201'],
      allBlockedIds: ['201', '301'],
      blockedCount: 2,
      maxWaitSeconds: 12,
    });
  });

  it('handles lock cycles without infinite looping', () => {
    const rows = normalizeLockWaitRows([
      { blocked_session_id: '10', blocking_session_id: '20', wait_seconds: 3 },
      { blocked_session_id: '20', blocking_session_id: '10', wait_seconds: 7 },
    ]);
    const chains = buildBlockingChains(rows);
    expect(chains.length).toBeGreaterThan(0);
    expect(chains[0]!.maxWaitSeconds).toBe(7);
  });

  it('generates safe dialect control SQL and rejects injection attempts', () => {
    expect(buildSessionControlSql('postgres', 'cancel', '4215')).toMatchObject({
      sql: 'SELECT pg_cancel_backend(4215);',
    });
    expect(buildSessionControlSql('postgres', 'terminate', '4215')).toMatchObject({
      sql: 'SELECT pg_terminate_backend(4215);',
    });
    expect(buildSessionControlSql('mysql', 'cancel', '99')).toMatchObject({
      sql: 'KILL QUERY 99;',
    });
    expect(buildSessionControlSql('sqlserver', 'terminate', '55')).toMatchObject({
      sql: 'KILL 55;',
    });
    expect('error' in buildSessionControlSql('sqlserver', 'cancel', '55')).toBe(true);
    // node-oracledb rejects a trailing `;` on plain SQL.
    expect(buildSessionControlSql('oracle', 'terminate', '128,4431')).toMatchObject({
      sql: "ALTER SYSTEM KILL SESSION '128,4431' IMMEDIATE",
    });
    expect(buildSessionControlSql('oracle', 'cancel', '128,4431')).toMatchObject({
      sql: "ALTER SYSTEM CANCEL SQL '128, 4431'",
    });
    // FORCE APPLICATION is a CLP command; drivers run it through ADMIN_CMD.
    expect(buildSessionControlSql('db2', 'terminate', '77')).toMatchObject({
      sql: "CALL SYSPROC.ADMIN_CMD('FORCE APPLICATION (77)')",
    });

    // Injection rejection
    expect('error' in buildSessionControlSql('postgres', 'terminate', '1); DROP TABLE users; --')).toBe(true);
    expect('error' in buildSessionControlSql('oracle', 'terminate', "1,2' OR '1'='1")).toBe(true);
    expect('error' in buildSessionControlSql('db2', 'terminate', "77)') --")).toBe(true);
  });

  it('does not offer CockroachDB lock chains or kill, whose ids it cannot match', () => {
    const support = dialectSupportsSessionLocks('cockroachdb');
    expect(support).toMatchObject({ supported: false, canCancelQuery: false, canTerminateSession: false });
    expect('error' in buildLockWaitProbeQuery('cockroachdb')).toBe(true);
    expect('error' in buildSessionControlSql('cockroachdb', 'terminate', 'abc123')).toBe(true);
  });

  it('reads TiDB lock waits from its own tables, not InnoDB ones', () => {
    const tidb = buildLockWaitProbeQuery('tidb');
    expect('sql' in tidb && tidb.sql).toContain('information_schema.DATA_LOCK_WAITS');
    expect('sql' in tidb && tidb.sql).toContain('information_schema.TIDB_TRX');
    expect('sql' in tidb && tidb.sql).not.toMatch(/INNODB_/i);
    const mariadb = buildLockWaitProbeQuery('mariadb');
    expect('sql' in mariadb && mariadb.sql).toContain('INNODB_LOCK_WAITS');
  });
});
