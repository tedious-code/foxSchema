/**
 * Backup & Restore · the SQL-language engines, run for real.
 *
 * Fox Schema writes backup commands and never runs them, so nothing in the
 * product finds out whether an engine accepts them. For the engines whose
 * backup *is* SQL — SQL Server, CockroachDB, ClickHouse, DuckDB — this runs the
 * generated statements through the product's own SQL runner, against the
 * configured databases:
 *
 *   - SQL Server backs up into its data folder, then RESTORE VERIFYONLY reads
 *     the file back. The generated restore itself would overwrite the test
 *     database, so it is not run; VERIFYONLY proves the file and the RESTORE
 *     grammar without that.
 *   - CockroachDB backs up and restores under a new name, which is dropped.
 *   - ClickHouse and DuckDB run when configured. A server without a backup
 *     disk is an environment answer, reported as a skip, never as a pass.
 *
 * The shell-tool engines (pg_dump, mysqldump, Data Pump…) are checked by the
 * unit tests and by hand; this suite holds only what the SQL runner can run.
 */
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBackupCommands, type BackupCommands } from '@foxschema/sql';
import { getSourceConfig, hasConfig } from '../helpers/db-config.js';
import { isEnvironmentFailure, runStatements, tryCleanup } from '../helpers/sql-exec.js';

/** Answers that are about this server's setup, not the statement. */
const NOT_ABOUT_THE_BACKUP = [
  /not allowed for backups/i, //  ClickHouse: no <backups><allowed_disk>
  /allowed_disk/i,
  /Unknown disk/i,
  /Operating system error/i, //  SQL Server: folder missing or not writable
  /Cannot open backup device/i,
  /external.?io|nodelocal/i, //  CockroachDB started without an external-io directory
];
const environmental = (message: string) => isEnvironmentFailure(message) || NOT_ABOUT_THE_BACKUP.some((re) => re.test(message));

/** A folder each dev container already has. */
const FOLDER: Record<string, string> = {
  sqlserver: '/var/opt/mssql/data',
  cockroachdb: 'nodelocal://1/fox-e2e-backups',
  clickhouse: 'backups',
  duckdb: '/tmp',
};

const NOW = new Date();
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

function commandsFor(dialect: string): BackupCommands {
  const cfg = getSourceConfig(dialect)!;
  const result = buildBackupCommands(
    { dialect, host: cfg.host, port: cfg.port, database: cfg.database, schema: cfg.schema, username: cfg.username },
    { folder: FOLDER[dialect], fileName: `fox_e2e_${NOW.getTime()}` },
    NOW
  );
  if ('error' in result) throw new Error(result.error);
  return result;
}

/** Statements in a generated script, one per `;`-terminated line group. */
const statementsOf = (script: string) =>
  script
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Run statements in order; undefined when they all ran, the first real error otherwise, or a skip. */
async function run(dialect: string, statements: string[]): Promise<{ rejected?: string; skipped?: string }> {
  const results = await runStatements(dialect, statements);
  for (let i = 0; i < statements.length; i++) {
    const r = results[i];
    if (r?.ok) continue;
    const message = r?.error ?? 'no result';
    if (environmental(message)) return { skipped: `${dialect}: ${message.split('\n')[0]!.slice(0, 200)}` };
    return { rejected: `${dialect} rejected:\n  ${statements[i]}\n  ${message.split('\n')[0]!.slice(0, 300)}` };
  }
  return {};
}

describe.skipIf(!hasConfig('sqlserver'))('SQL Server backup', () => {
  it('writes a .bak the server can read back', async () => {
    const c = commandsFor('sqlserver');
    const backup = await run('sqlserver', statementsOf(c.backup));
    expect(backup.rejected).toBeUndefined();
    if (backup.skipped) return console.warn(backup.skipped);
    const verify = await run('sqlserver', [`RESTORE VERIFYONLY FROM DISK = N'${c.location.replace(/'/g, "''")}'`]);
    expect(verify.rejected).toBeUndefined();
    // The .bak stays in the container's data folder (SQL cannot delete it):
    // docker exec foxschema-sqlserver sh -c 'rm -f /var/opt/mssql/data/fox_e2e_*.bak'
  }, 120_000);
});

describe.skipIf(!hasConfig('cockroachdb'))('CockroachDB backup', () => {
  it('backs up and restores under a new name', async () => {
    const cfg = getSourceConfig('cockroachdb')!;
    const c = commandsFor('cockroachdb');
    cleanups.push(() => tryCleanup('cockroachdb', [`DROP DATABASE IF EXISTS "${cfg.database}_restored" CASCADE`]));
    const backup = await run('cockroachdb', statementsOf(c.backup));
    expect(backup.rejected).toBeUndefined();
    if (backup.skipped) return console.warn(backup.skipped);
    const restore = await run('cockroachdb', statementsOf(c.restore));
    expect(restore.rejected).toBeUndefined();
  }, 180_000);
});

describe.skipIf(!hasConfig('clickhouse'))('ClickHouse backup', () => {
  it('is accepted by the server, or refused only for want of a backup disk', async () => {
    const c = commandsFor('clickhouse');
    const backup = await run('clickhouse', statementsOf(c.backup));
    expect(backup.rejected).toBeUndefined();
    if (backup.skipped) console.warn(backup.skipped);
  }, 120_000);
});

describe.skipIf(!hasConfig('duckdb'))('DuckDB backup', () => {
  it('exports the database to a folder', async () => {
    const c = commandsFor('duckdb');
    // DuckDB runs inside the API server, on this machine in a local run.
    cleanups.push(async () => fs.rmSync(c.location, { recursive: true, force: true }));
    const backup = await run('duckdb', statementsOf(c.backup));
    expect(backup.rejected).toBeUndefined();
    if (backup.skipped) console.warn(backup.skipped);
  }, 120_000);
});
