/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backup history and server-side runs on every engine, one row each.
 *
 * backup.test.ts tests each engine's commands. This file asks the three
 * questions the Backup & Restore panel asks of every engine, and makes each
 * one answer: does it keep a history the panel can list, can the panel run
 * the backup (and with which permission), and what does a picked backup's key
 * do to the restore — including a key nobody should trust.
 */
import { describe, expect, it } from 'vitest';
import { DIALECTS } from '../../providers/provider-settings.js';
import { sqlStatementCategories } from '../sql-text/sql-splitter.js';
import { backupHistoryQuery, backupSupport, buildBackupCommands } from './backup.js';
import type { BackupCommands, BackupConnection, BackupRunsOn } from './backup.types.js';

interface EngineRow {
  runsOn: BackupRunsOn;
  /** The backup is SQL, so the panel can run it on this connection. */
  runnable: boolean;
  /** Where the engine records the backups it took, or why it has no record. */
  history: RegExp | { none: string };
  /** A key from that history, and what the restore then says. */
  pick?: { key: string; restoreNames: string };
}

const NO_RECORD = { none: 'a dump file on the client is just a file' };

/** Every engine Fox Schema connects to. */
const ENGINES: Record<string, EngineRow> = {
  postgres: { runsOn: 'client', runnable: false, history: NO_RECORD },
  yugabytedb: { runsOn: 'client', runnable: false, history: NO_RECORD },
  redshift: { runsOn: 'cloud', runnable: false, history: { none: 'snapshots are listed by the AWS console, not SQL' } },
  mysql: { runsOn: 'client', runnable: false, history: NO_RECORD },
  mariadb: { runsOn: 'client', runnable: false, history: NO_RECORD },
  tidb: { runsOn: 'client', runnable: false, history: NO_RECORD },
  azuresql: { runsOn: 'client', runnable: false, history: { none: 'SqlPackage exports are files; point-in-time restores are the portal’s' } },
  oracle: { runsOn: 'server', runnable: false, history: { none: 'Data Pump writes a dump file; RMAN catalogs are not read here' } },
  sqlite: { runsOn: 'client', runnable: false, history: NO_RECORD },
  mongodb: { runsOn: 'client', runnable: false, history: NO_RECORD },
  redis: { runsOn: 'client', runnable: false, history: NO_RECORD },
  cockroachdb: { runsOn: 'server', runnable: true, history: { none: 'SHOW BACKUPS needs the collection URI, not a catalog' } },
  duckdb: { runsOn: 'server', runnable: true, history: { none: 'EXPORT DATABASE writes a folder and records nothing' } },
  sqlserver: {
    runsOn: 'server',
    runnable: true,
    history: /msdb\.dbo\.backupset/,
    pick: { key: '/var/opt/mssql/backups/shop_old.bak', restoreNames: "FROM DISK = N'/var/opt/mssql/backups/shop_old.bak'" },
  },
  db2: {
    // Server-side, but a CLP command rather than SQL, so it is not run from here.
    runsOn: 'server',
    runnable: false,
    history: /SYSIBMADM\.DB_HISTORY/,
    pick: { key: '20261005220000', restoreNames: 'TAKEN AT 20261005220000' },
  },
  clickhouse: {
    runsOn: 'server',
    runnable: true,
    history: /system\.backups/,
    pick: { key: "Disk('backups', 'shop_old.zip')", restoreNames: "FROM Disk('backups', 'shop_old.zip')" },
  },
};

/** Keys that must never reach a restore as written. */
const HOSTILE_KEYS = [
  "'; DROP DATABASE shop; --",
  "Disk('a') ; DROP TABLE t",
  "Disk('a', 'b'); DROP TABLE t; --')",
  '2026100522000', // 13 digits: not a Db2 timestamp
  '202610052200001', // 15 digits
  '20261005 220000',
  '20261005220000; DROP',
  '$(rm -rf /)',
  '../../etc/passwd',
];

const conn = (dialect: string): BackupConnection => ({
  dialect,
  host: 'db.local',
  port: 5432,
  database: dialect === 'sqlite' || dialect === 'duckdb' ? '/data/shop.db' : 'shop',
  username: 'fox',
});
const NOW = new Date('2026-10-06T10:00:00Z');
const commands = (dialect: string, restoreFrom?: string): BackupCommands => {
  const built = buildBackupCommands(conn(dialect), { restoreFrom }, NOW);
  if ('error' in built) throw new Error(built.error);
  return built;
};

describe('backup history and server runs, every engine', () => {
  it('names every engine Fox Schema connects to', () => {
    expect(Object.keys(ENGINES).sort()).toEqual([...DIALECTS].sort());
  });

  for (const [dialect, row] of Object.entries(ENGINES)) {
    describe(dialect, () => {
      it(`runs on the ${row.runsOn}${row.runnable ? ', as SQL the panel can run' : ''}`, () => {
        expect(backupSupport(dialect)?.runsOn).toBe(row.runsOn);
        expect(row.runsOn === 'server' && commands(dialect).language === 'sql').toBe(row.runnable);
      });

      if (row.runnable) {
        it('classifies the backup as a schema change, so running it needs editor.ddl', () => {
          const categories = sqlStatementCategories(commands(dialect).backup);
          expect(categories.length).toBeGreaterThan(0);
          expect(new Set(categories)).toEqual(new Set(['ddl']));
        });
      }

      if ('none' in row.history) {
        it(`keeps no history to list (${row.history.none})`, () => {
          expect(backupSupport(dialect)?.history).toBeUndefined();
          expect(backupHistoryQuery(conn(dialect))).toBeNull();
        });
      } else {
        const source = row.history;
        it(`lists its history from ${source.source.replace(/\\/g, '')}, as a read`, () => {
          const sql = backupHistoryQuery(conn(dialect))!;
          expect(sql).toMatch(source);
          // `/sql/execute` runs a read with editor.run; anything wider would
          // make listing backups need the permission that takes them.
          expect(sqlStatementCategories(sql)).toEqual(['read']);
          for (const column of ['finished_at', 'location', 'size_bytes', 'restore_key']) {
            expect(sql.toLowerCase()).toContain(`as ${column}`);
          }
        });
      }

      if (row.pick) {
        const { key, restoreNames } = row.pick;
        it('restores a picked backup by its key', () => {
          expect(commands(dialect, key).restore).toContain(restoreNames);
          expect(commands(dialect).restore).not.toContain(restoreNames);
        });
      }

      for (const hostile of HOSTILE_KEYS) {
        it(`does not paste ${JSON.stringify(hostile)} into the restore`, () => {
          const plain = commands(dialect);
          const picked = commands(dialect, hostile);
          // The backup never depends on what was picked.
          expect(picked.backup).toBe(plain.backup);
          if (dialect === 'sqlserver') {
            // Any string is a path on SQL Server, so it is kept — as one
            // N'…' literal with its quotes doubled, never as SQL.
            const literal = `N'${hostile.replace(/'/g, "''")}'`;
            expect(picked.restore).toBe(plain.restore.replace(/N'[^']*\.bak'/, literal));
          } else {
            expect(picked.restore).toBe(plain.restore);
          }
        });
      }
    });
  }
});
