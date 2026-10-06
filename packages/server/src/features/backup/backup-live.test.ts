/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backups taken, listed and restored by the real database servers.
 *
 * backup-history.matrix.test.ts proves the text each engine is given. This runs
 * it: the backup the panel's "Run backup now" sends, the history query its
 * "List backups" sends, and a restore built from the key of the backup that
 * history returned — so a key that does not round-trip from the server's own
 * record into a restore the server accepts fails here.
 *
 * Nothing is restored over a live database: SQL Server checks the picked file
 * with RESTORE VERIFYONLY, Db2 checks the picked image with db2ckbkp, and
 * ClickHouse and CockroachDB restore under a new name, as their commands do.
 *
 * Gated behind FOX_IT_DB=1:
 *
 *   docker compose up -d
 *   FOX_IT_DB=1 npx vitest run packages/server/src/features/backup/backup-live.test.ts
 *
 * An engine that does not answer is skipped by name, with the reason.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ConnectionFactory, getAdapter } from '@foxschema/db';
import {
  backupHistoryQuery,
  buildBackupCommands,
  normalizeBackupHistory,
  type BackupCommands,
  type BackupConnection,
  type ConnectionOptions,
} from '@foxschema/sql';

const RUN = process.env.FOX_IT_DB === '1';
const TAG = Date.now().toString(36).slice(-5);
const run = promisify(execFile);

type Ctx = { skip: (note?: string) => void };

const ok = (built: BackupCommands | { error: string }): BackupCommands => {
  if ('error' in built) throw new Error(built.error);
  return built;
};

/** Each statement on one connection, naming the one the server rejects. */
async function exec(dialect: string, options: ConnectionOptions, statements: string[]): Promise<unknown[]> {
  const connection = await ConnectionFactory.create(dialect, options, { pooled: false });
  const adapter = getAdapter(dialect);
  const results: unknown[] = [];
  try {
    for (const sql of statements) {
      try {
        results.push(await adapter.query(connection, sql.replace(/;\s*$/, ''), []));
      } catch (err) {
        throw new Error(`${dialect} rejected:\n${sql}\n\n${(err as Error).message.split('\n')[0]}`);
      }
    }
  } finally {
    await ConnectionFactory.close(dialect, connection).catch(() => undefined);
  }
  return results;
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? (result as Record<string, unknown>[]) : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);

/** The first number in a COUNT(*) row, whatever the driver called the column. */
const countOf = (result: unknown): number => Number(Object.values(rowsOf(result)[0] ?? {})[0]);

/** Probe once per engine; a failure is a skip with the server's own words. */
async function reachable(ctx: Ctx, dialect: string, options: ConnectionOptions, probe = 'SELECT 1'): Promise<void> {
  try {
    await ConnectionFactory.executeQuery(dialect, options, probe);
  } catch (err) {
    ctx.skip(`${dialect} is not reachable: ${(err as Error).message.split('\n')[0]}`);
  }
}

/** A shell command inside a compose container, or a skip saying why it cannot run. */
async function inContainer(ctx: Ctx, container: string, user: string, command: string): Promise<string> {
  try {
    const { stdout } = await run('docker', ['exec', '-u', user, container, 'bash', '-lc', command], { maxBuffer: 1 << 24 });
    return stdout;
  } catch (err) {
    const e = err as { code?: string; stdout?: string; stderr?: string; message: string };
    if (e.code === 'ENOENT') ctx.skip('the docker CLI is not on PATH, and this step runs in the container');
    throw new Error(`${container}: ${command}\n${e.stdout ?? ''}${e.stderr ?? e.message}`);
  }
}

const cleanups: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean().catch(() => undefined);
  await ConnectionFactory.closeAll().catch(() => undefined);
});

describe.runIf(RUN)('backups on the real engines', () => {
  it('sqlserver: runs the backup, lists it first, and the picked file verifies', async (ctx) => {
    const admin: ConnectionOptions = { host: 'localhost', port: 1433, database: 'master', username: 'sa', password: 'FoxPass123!', ssl: { enabled: false } };
    await reachable(ctx, 'sqlserver', admin);
    const db = `fxbk_${TAG}`;
    await exec('sqlserver', admin, [`CREATE DATABASE ${db}`]);
    cleanups.push(() => exec('sqlserver', admin, [`DROP DATABASE IF EXISTS ${db}`]));
    const options = { ...admin, database: db };
    const conn: BackupConnection = { dialect: 'sqlserver', database: db };
    // The data folder exists in every SQL Server container; the panel's
    // default (/var/opt/mssql/backups) must be made first.
    const settings = { folder: '/var/opt/mssql/data', compress: true };

    const commands = ok(buildBackupCommands(conn, settings));
    await exec('sqlserver', options, [commands.backup]);

    const history = normalizeBackupHistory(rowsOf(await exec('sqlserver', options, [backupHistoryQuery(conn)!]).then((r) => r[0])));
    expect(history[0]?.location, 'the backup just taken is the newest on record').toBe(commands.location);

    const restore = ok(buildBackupCommands(conn, { ...settings, restoreFrom: history[0]!.restoreKey })).restore;
    const from = /FROM DISK = N'(?:[^']|'')*'/.exec(restore)?.[0];
    expect(from).toBe(`FROM DISK = N'${commands.location}'`);
    // The restore's own FROM clause, checked by the server without restoring.
    await exec('sqlserver', admin, [`RESTORE VERIFYONLY ${from}`]);
  });

  it('db2: the CLP backup is listed in DB_HISTORY, and TAKEN AT names that image', async (ctx) => {
    const options: ConnectionOptions = { host: 'localhost', port: 50000, database: 'foxdb', username: 'db2inst1', password: 'foxpass', schema: 'DB2INST1' };
    await reachable(ctx, 'db2', options, 'SELECT 1 FROM SYSIBM.SYSDUMMY1');
    const conn: BackupConnection = { dialect: 'db2', database: 'foxdb' };
    const folder = `/database/backups/fx_${TAG}`;
    const commands = ok(buildBackupCommands(conn, { folder, scope: 'full', compress: false }));
    expect(commands.backup).toBe(`db2 BACKUP DATABASE FOXDB TO ${folder} WITHOUT PROMPTING`);

    // An offline backup needs every connection closed, this test's pools too.
    await ConnectionFactory.closeAll();
    cleanups.push(() => run('docker', ['exec', 'foxschema-db2', 'rm', '-rf', folder]));
    // The folder must exist and be the instance owner's (the panel's hint says
    // so); the compose image has no /database/backups.
    await inContainer(ctx, 'foxschema-db2', 'root', `mkdir -p ${folder} && chown db2inst1 ${folder}`);
    // The compose healthcheck connects every 15 s, and an offline backup
    // refuses to start while it is (SQL1035N), so force and retry.
    await inContainer(
      ctx,
      'foxschema-db2',
      'db2inst1',
      `for i in 1 2 3 4 5 6; do db2 force application all >/dev/null; sleep 1; ${commands.backup} && exit 0; sleep 4; done; exit 1`
    );

    const rows = await ConnectionFactory.executeQuery<Record<string, unknown>>('db2', options, backupHistoryQuery(conn)!);
    const newest = normalizeBackupHistory(rows)[0];
    expect(newest?.restoreKey).toMatch(/^\d{14}$/);
    expect(newest?.location).toBe(folder);

    const restore = ok(buildBackupCommands(conn, { folder, restoreFrom: newest!.restoreKey })).restore;
    expect(restore).toBe(`db2 RESTORE DATABASE FOXDB FROM ${folder} TAKEN AT ${newest!.restoreKey} REPLACE EXISTING WITHOUT PROMPTING`);
    // The image that timestamp names exists and is sound.
    const image = (await inContainer(ctx, 'foxschema-db2', 'db2inst1', `ls ${folder} | grep '\\.${newest!.restoreKey}\\.'`)).trim();
    expect(image).toMatch(new RegExp(`^FOXDB\\..*\\.${newest!.restoreKey}\\.001$`));
    const check = await inContainer(ctx, 'foxschema-db2', 'db2inst1', `db2ckbkp ${folder}/${image}`);
    expect(check).toMatch(/Image Verification Complete - successful/);
  }, 300_000);

  it('clickhouse: backs up to the allowed disk, lists it, and restores the picked backup beside the live one', async (ctx) => {
    const admin: ConnectionOptions = { host: 'localhost', port: 8123, database: 'default', username: 'default', password: 'foxpass' };
    await reachable(ctx, 'clickhouse', admin);
    const db = `fxbk_${TAG}`;
    await exec('clickhouse', admin, [
      `CREATE DATABASE ${db}`,
      `CREATE TABLE ${db}.t (id UInt32) ENGINE = MergeTree ORDER BY id`,
      `INSERT INTO ${db}.t SELECT number FROM numbers(25)`,
    ]);
    cleanups.push(() => exec('clickhouse', admin, [`DROP DATABASE IF EXISTS ${db}_restored`, `DROP DATABASE IF EXISTS ${db}`]));
    const conn: BackupConnection = { dialect: 'clickhouse', database: db };
    const commands = ok(buildBackupCommands(conn, {}));
    try {
      await exec('clickhouse', admin, [commands.backup]);
    } catch (err) {
      const message = (err as Error).message;
      // Only the configuration the commands' note names is a reason to skip.
      if (/allowed_disk|not allowed|Unknown disk|DISK_NOT_FOUND|UNKNOWN_DISK/i.test(message)) {
        ctx.skip(`clickhouse has no backup disk allowed (<backups><allowed_disk>): ${message.split('\n').pop()}`);
      }
      throw err;
    }

    const history = normalizeBackupHistory(rowsOf((await exec('clickhouse', admin, [backupHistoryQuery(conn)!]))[0]));
    const file = commands.location.split(':')[1]!;
    const picked = history.find((e) => e.restoreKey.includes(file));
    expect(picked?.restoreKey, 'the backup just taken is on record').toBe(`Disk('backups', '${file}')`);

    const restore = ok(buildBackupCommands(conn, { restoreFrom: picked!.restoreKey })).restore;
    expect(restore).toBe(`RESTORE DATABASE ${db} AS ${db}_restored FROM Disk('backups', '${file}');`);
    await exec('clickhouse', admin, [restore]);
    expect(countOf((await exec('clickhouse', admin, [`SELECT count() FROM ${db}_restored.t`]))[0])).toBe(25);
  });

  it('duckdb: EXPORT DATABASE, then IMPORT DATABASE into an empty file, keeps every row', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fx-duckdb-backup-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'source.duckdb');
    const target = path.join(dir, 'target.duckdb');
    await exec('duckdb', { database: source }, [
      'CREATE TABLE orders (id INTEGER, note VARCHAR)',
      "INSERT INTO orders SELECT range, 'n' || range FROM range(40)",
      'CREATE TABLE items (id INTEGER)',
      'INSERT INTO items SELECT range FROM range(7)',
    ]);
    const commands = ok(buildBackupCommands({ dialect: 'duckdb', database: source }, { folder: dir }));
    await exec('duckdb', { database: source }, [commands.backup]);
    await exec('duckdb', { database: target }, [commands.restore]);
    const [orders, items] = await exec('duckdb', { database: target }, ['SELECT count(*) FROM orders', 'SELECT count(*) FROM items']);
    expect([countOf(orders), countOf(items)]).toEqual([40, 7]);
  });

  it('cockroachdb: BACKUP INTO a nodelocal collection, RESTORE under a new name', async (ctx) => {
    const admin: ConnectionOptions = { host: 'localhost', port: 26257, database: 'defaultdb', username: 'root', schema: 'public' };
    await reachable(ctx, 'cockroachdb', admin);
    const db = `fxbk_${TAG}`;
    await exec('cockroachdb', admin, [
      `CREATE DATABASE ${db}`,
      `CREATE TABLE ${db}.public.t (id INT PRIMARY KEY)`,
      `INSERT INTO ${db}.public.t SELECT generate_series(1, 12)`,
    ]);
    cleanups.push(() => exec('cockroachdb', admin, [`DROP DATABASE IF EXISTS ${db}_restored CASCADE`, `DROP DATABASE IF EXISTS ${db} CASCADE`]));
    // The backup reads AS OF SYSTEM TIME '-10s', so the data must be older than that.
    await new Promise((resolve) => setTimeout(resolve, 11_000));

    const commands = ok(buildBackupCommands({ dialect: 'cockroachdb', database: db }, { folder: `nodelocal://1/fx_${TAG}` }));
    await exec('cockroachdb', admin, [commands.backup]);
    await exec('cockroachdb', admin, [commands.restore]);
    expect(countOf((await exec('cockroachdb', admin, [`SELECT count(*) FROM ${db}_restored.public.t`]))[0])).toBe(12);
  }, 120_000);
});
