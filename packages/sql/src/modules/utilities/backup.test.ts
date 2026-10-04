/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { DIALECTS } from '../../providers/provider-settings.js';
import {
  backupFileName,
  backupSupport,
  buildBackupCommands,
  defaultBackupSettings,
  normalizeBackupSettings,
  parseTableList,
} from './backup.js';
import type { BackupCommands, BackupConnection } from './backup.types.js';
import { joinPath, shellArg, sqlString } from './backup-helpers.js';

const NOW = new Date(2026, 9, 4, 15, 30, 5);
const conn = (dialect: string, extra: Partial<BackupConnection> = {}): BackupConnection => ({
  dialect,
  host: 'db.local',
  port: 5432,
  database: 'shop',
  schema: 'sales',
  username: 'fox',
  ...extra,
});
const ok = (result: BackupCommands | { error: string }): BackupCommands => {
  if ('error' in result) throw new Error(result.error);
  return result;
};

describe('backup support', () => {
  it('covers every engine Fox Schema connects to', () => {
    const missing = DIALECTS.filter((d) => !backupSupport(d));
    expect(missing).toEqual([]);
  });

  it('says where each command runs, and what its folder is', () => {
    for (const d of DIALECTS) {
      const s = backupSupport(d)!;
      expect(['client', 'server', 'cloud']).toContain(s.runsOn);
      if (s.runsOn === 'cloud') expect(s.folder).toBeNull();
      else expect(s.folder?.defaultValue, d).toBeTruthy();
      expect(s.formats.length, d).toBeGreaterThan(0);
      expect(s.scopes).toContain('full');
      expect(s.passwordNote, d).toBeTruthy();
    }
  });

  it('never puts a password in a command', () => {
    for (const d of DIALECTS) {
      const commands = ok(buildBackupCommands(conn(d), {}, NOW));
      const text = `${commands.backup}\n${commands.restore}`;
      expect(text, d).not.toMatch(/--password=|PGPASSWORD=|(^|\s)-p\S|IDENTIFIED BY|USING '/);
    }
  });

  it('refuses an engine it does not know, a missing database, or an empty folder', () => {
    expect(buildBackupCommands(conn('nosuch'), {}, NOW)).toEqual({ error: expect.stringMatching(/no backup commands/) });
    expect(buildBackupCommands(conn('postgres', { database: ' ' }), {}, NOW)).toEqual({ error: expect.stringMatching(/no database/) });
    // An empty folder falls back to the engine's default rather than writing to the root.
    expect(ok(buildBackupCommands(conn('postgres'), { folder: '' }, NOW)).location).toBe('./backups/shop_20261004_153005.dump');
  });
});

describe('settings', () => {
  it('start from each engine’s own defaults', () => {
    expect(defaultBackupSettings('postgres')).toEqual({ folder: './backups', format: 'custom', scope: 'full', compress: true, limitToSchema: false });
    expect(defaultBackupSettings('sqlserver').folder).toBe('/var/opt/mssql/backups');
    expect(defaultBackupSettings('oracle').folder).toBe('DATA_PUMP_DIR');
    expect(defaultBackupSettings('redshift').folder).toBe('');
  });

  it('drop what an engine cannot honour, from saved JSON of any shape', () => {
    expect(normalizeBackupSettings('sqlserver', { format: 'plain', scope: 'schema', compress: true, limitToSchema: true, folder: ' /bk ' })).toEqual({
      folder: '/bk',
      format: 'bak',
      scope: 'full',
      compress: true,
      limitToSchema: false,
    });
    expect(normalizeBackupSettings('postgres', 'nonsense')).toEqual(defaultBackupSettings('postgres'));
    expect(normalizeBackupSettings('postgres', { compress: 'yes' }).compress).toBe(true);
    expect(normalizeBackupSettings('postgres', { compress: false }).compress).toBe(false);
    expect(normalizeBackupSettings('postgres', { folder: 'x'.repeat(5000) }).folder).toHaveLength(1024);
  });

  it('names a backup after the database and the moment, safe in any tool', () => {
    expect(backupFileName('shop', NOW)).toBe('shop_20261004_153005');
    expect(backupFileName('/data/my shop.sqlite', NOW)).toBe('my_shop_20261004_153005');
    expect(backupFileName("'; drop", NOW)).toBe('drop_20261004_153005');
  });

  it('reads a table list typed with commas or lines', () => {
    expect(parseTableList('orders, customers\n orders\n\nitems')).toEqual(['orders', 'customers', 'items']);
  });
});

describe('quoting', () => {
  it('leaves plain shell words bare and single-quotes the rest', () => {
    expect(shellArg('./backups/shop.dump')).toBe('./backups/shop.dump');
    expect(shellArg('My Backups')).toBe("'My Backups'");
    expect(shellArg("it's")).toBe(`'it'\\''s'`);
    expect(sqlString("O'Neil")).toBe("'O''Neil'");
  });

  it('joins a path with the folder’s own separator', () => {
    expect(joinPath('./backups/', 'a.sql')).toBe('./backups/a.sql');
    expect(joinPath('C:\\Backups', 'a.bak')).toBe('C:\\Backups\\a.bak');
    expect(joinPath('\\\\nas\\share\\', 'a.bak')).toBe('\\\\nas\\share\\a.bak');
  });

  it('keeps every shell word whole on Oracle and Db2, whatever the reader typed', () => {
    const oracle = ok(buildBackupCommands(conn('oracle', { database: 'FREEPDB1' }), { fileName: 'x; rm -rf ~', folder: 'dp dir' }, NOW));
    expect(oracle.backup).toContain("'DIRECTORY=DP DIR' 'DUMPFILE=x; rm -rf ~.dmp' 'LOGFILE=x; rm -rf ~.log'");
    const db2 = ok(buildBackupCommands(conn('db2', { database: 'my db' }), {}, NOW));
    expect(db2.backup).toMatch(/^db2 BACKUP DATABASE 'MY DB' TO /);
  });

  it('quotes a folder with a space so the command does not split on it', () => {
    const c = ok(buildBackupCommands(conn('postgres'), { folder: '/srv/My Backups' }, NOW));
    expect(c.backup).toContain("--file='/srv/My Backups/shop_20261004_153005.dump'");
  });
});

describe('PostgreSQL', () => {
  it('dumps a custom archive and restores it with pg_restore', () => {
    const c = ok(buildBackupCommands(conn('postgres'), {}, NOW));
    expect(c.language).toBe('shell');
    expect(c.backup).toBe(
      'pg_dump --host db.local --port 5432 --username fox --format=custom --compress=9 --file=./backups/shop_20261004_153005.dump shop'
    );
    expect(c.restore).toBe(
      'pg_restore --host db.local --port 5432 --username fox --dbname=shop --clean --if-exists --no-owner ./backups/shop_20261004_153005.dump'
    );
  });

  it('pipes plain SQL through gzip and restores it through psql', () => {
    const c = ok(buildBackupCommands(conn('postgres'), { format: 'plain', compress: true, scope: 'schema' }, NOW));
    expect(c.backup).toBe(
      'pg_dump --host db.local --port 5432 --username fox --format=plain --schema-only shop | gzip > ./backups/shop_20261004_153005.sql.gz'
    );
    expect(c.restore).toBe('gunzip -c ./backups/shop_20261004_153005.sql.gz | psql --host db.local --port 5432 --username fox --dbname=shop');
  });

  it('limits to the schema, or names tables in it', () => {
    expect(ok(buildBackupCommands(conn('postgres'), { limitToSchema: true }, NOW)).backup).toContain('--schema=sales');
    const t = ok(buildBackupCommands(conn('postgres'), { tables: ['orders', 'audit.log'] }, NOW)).backup;
    expect(t).toContain('--table=sales.orders --table=audit.log');
    expect(t).not.toContain('--schema=');
  });

  it('uses ysql_dump and ysqlsh on YugabyteDB, plain SQL only', () => {
    const c = ok(buildBackupCommands(conn('yugabytedb'), { format: 'custom', compress: false }, NOW));
    expect(c.backup).toMatch(/^ysql_dump .*--format=plain/);
    expect(c.restore).toMatch(/^ysqlsh /);
  });
});

describe('MySQL family', () => {
  it('dumps in one transaction with routines, asking for the password', () => {
    const c = ok(buildBackupCommands(conn('mysql', { port: 3306 }), { compress: false }, NOW));
    expect(c.backup).toBe(
      'mysqldump --host=db.local --port=3306 --user=fox --password --single-transaction --routines --events shop > ./backups/shop_20261004_153005.sql'
    );
    expect(c.restore).toBe('mysql --host=db.local --port=3306 --user=fox --password shop < ./backups/shop_20261004_153005.sql');
  });

  it('writes data only without CREATE or triggers, and compresses through gzip', () => {
    const c = ok(buildBackupCommands(conn('mysql'), { scope: 'data', compress: true, tables: ['orders'] }, NOW));
    expect(c.backup).toContain('--no-create-info --skip-triggers shop orders | gzip > ');
    expect(c.backup).not.toContain('--routines');
    expect(c.restore).toMatch(/^gunzip -c .* \| mysql /);
  });

  it('uses MariaDB’s own tool names, and leaves routines out on TiDB', () => {
    expect(ok(buildBackupCommands(conn('mariadb'), {}, NOW)).backup).toMatch(/^mariadb-dump /);
    expect(ok(buildBackupCommands(conn('mariadb'), {}, NOW)).restore).toMatch(/mariadb --host/);
    const tidb = ok(buildBackupCommands(conn('tidb'), {}, NOW));
    expect(tidb.backup).not.toContain('--routines');
    expect(tidb.notes.join(' ')).toMatch(/Dumpling/);
  });
});

describe('SQL Server and Azure SQL', () => {
  it('backs up on the server, copy-only, and restores over the database single-user', () => {
    const c = ok(buildBackupCommands(conn('sqlserver', { database: "O'Brien]s" }), {}, NOW));
    expect(c.language).toBe('sql');
    expect(c.backup).toBe(
      "BACKUP DATABASE [O'Brien]]s]\n  TO DISK = N'/var/opt/mssql/backups/O_Brien_s_20261004_153005.bak'\n  WITH COPY_ONLY, INIT, CHECKSUM, COMPRESSION, STATS = 10;"
    );
    expect(c.restore.split('\n')[0]).toBe('USE [master];');
    expect(c.restore).toContain('SET SINGLE_USER WITH ROLLBACK IMMEDIATE');
    expect(c.restore).toContain('WITH REPLACE, RECOVERY');
  });

  it('exports a bacpac with SqlPackage on Azure SQL, and a dacpac for schema only', () => {
    const full = ok(buildBackupCommands(conn('azuresql'), {}, NOW));
    expect(full.backup).toMatch(/^SqlPackage \/Action:Export .*\/TargetFile:\.\/backups\/shop_20261004_153005\.bacpac$/);
    expect(full.restore).toContain('/TargetDatabaseName:shop_restored');
    const schema = ok(buildBackupCommands(conn('azuresql'), { scope: 'schema' }, NOW));
    expect(schema.backup).toContain('/Action:Extract');
    expect(schema.location).toMatch(/\.dacpac$/);
  });
});

describe('Oracle, Db2, ClickHouse, CockroachDB', () => {
  it('runs Data Pump into a DIRECTORY object, per schema', () => {
    const c = ok(buildBackupCommands(conn('oracle', { port: 1521, database: 'FREEPDB1', schema: 'demo_a' }), { scope: 'schema' }, NOW));
    expect(c.backup).toBe(
      'expdp fox@//db.local:1521/FREEPDB1 SCHEMAS=DEMO_A DIRECTORY=DATA_PUMP_DIR DUMPFILE=FREEPDB1_20261004_153005.dmp LOGFILE=FREEPDB1_20261004_153005.log CONTENT=METADATA_ONLY COMPRESSION=ALL'
    );
    expect(c.restore).toContain('TABLE_EXISTS_ACTION=REPLACE');
  });

  it('backs up a Db2 image into a server folder, or writes db2look DDL for schema only', () => {
    const full = ok(buildBackupCommands(conn('db2', { database: 'testdb' }), {}, NOW));
    expect(full.backup).toBe('db2 BACKUP DATABASE TESTDB TO /database/backups COMPRESS WITHOUT PROMPTING');
    expect(full.restore).toBe('db2 RESTORE DATABASE TESTDB FROM /database/backups REPLACE EXISTING WITHOUT PROMPTING');
    const ddl = ok(buildBackupCommands(conn('db2', { database: 'testdb' }), { scope: 'schema' }, NOW));
    expect(ddl.backup).toBe('db2look -d TESTDB -z SALES -e -o /database/backups/testdb_20261004_153005.sql');
  });

  it('backs up ClickHouse to a configured disk and restores beside the live database', () => {
    const c = ok(buildBackupCommands(conn('clickhouse'), {}, NOW));
    expect(c.backup).toBe("BACKUP DATABASE shop TO Disk('backups', 'shop_20261004_153005.zip');");
    expect(c.restore).toBe("RESTORE DATABASE shop AS shop_restored FROM Disk('backups', 'shop_20261004_153005.zip');");
  });

  it('backs up CockroachDB into a collection and restores under a new name', () => {
    const c = ok(buildBackupCommands(conn('cockroachdb'), {}, NOW));
    expect(c.backup).toBe("BACKUP DATABASE shop INTO 'nodelocal://1/backups/shop_20261004_153005' AS OF SYSTEM TIME '-10s';");
    expect(c.restore).toBe("RESTORE DATABASE shop FROM LATEST IN 'nodelocal://1/backups/shop_20261004_153005' WITH new_db_name = 'shop_restored';");
  });
});

describe('file engines, Redshift, MongoDB, Redis', () => {
  it('exports DuckDB as Parquet and imports it back', () => {
    const c = ok(buildBackupCommands(conn('duckdb', { database: '/data/app.duckdb' }), {}, NOW));
    expect(c.backup).toBe("EXPORT DATABASE './backups/app_20261004_153005' (FORMAT PARQUET);");
    expect(c.restore).toBe("IMPORT DATABASE './backups/app_20261004_153005';");
  });

  it('copies a live SQLite file with .backup, or dumps SQL', () => {
    const copy = ok(buildBackupCommands(conn('sqlite', { database: '/data/my app.db' }), {}, NOW));
    expect(copy.backup).toBe("sqlite3 '/data/my app.db' '.backup ./backups/my_app_20261004_153005.db'");
    expect(copy.restore).toBe("sqlite3 '/data/my app.db' '.restore ./backups/my_app_20261004_153005.db'");
    const dump = ok(buildBackupCommands(conn('sqlite', { database: 'a.db' }), { format: 'sql', compress: false }, NOW));
    expect(dump.backup).toBe('sqlite3 a.db .dump > ./backups/a_20261004_153005.sql');
  });

  it('snapshots a Redshift cluster named by its endpoint', () => {
    const c = ok(buildBackupCommands(conn('redshift', { host: 'analytics.abc123.us-east-1.redshift.amazonaws.com' }), {}, NOW));
    expect(c.backup).toBe(
      'aws redshift create-cluster-snapshot --cluster-identifier analytics --snapshot-identifier shop-20261004-153005 --region us-east-1'
    );
    expect(c.restore).toContain('--cluster-identifier analytics-restored');
    const unknown = ok(buildBackupCommands(conn('redshift', { host: 'localhost' }), {}, NOW));
    expect(unknown.backup).toContain("'<cluster-id>'");
  });

  it('archives MongoDB with mongodump and restores with --drop', () => {
    const c = ok(buildBackupCommands(conn('mongodb', { port: 27017 }), {}, NOW));
    expect(c.backup).toBe(
      'mongodump --host=db.local --port=27017 --username=fox --authenticationDatabase=admin --db=shop --archive=./backups/shop_20261004_153005.archive.gz --gzip'
    );
    expect(c.restore).toContain("--nsInclude='shop.*' --drop");
  });

  it('fetches a Redis snapshot, and says how to restore one since there is no command', () => {
    const c = ok(buildBackupCommands(conn('redis', { port: 6379 }), {}, NOW));
    expect(c.backup).toBe('redis-cli -h db.local -p 6379 --user fox --askpass --rdb ./backups/shop_20261004_153005.rdb');
    expect(c.restore.split('\n').every((l) => l.startsWith('#'))).toBe(true);
  });
});
