/**
 * Backup & Restore in the Utilities workspace, in a real browser.
 *
 * The commands are unit-tested per engine; this checks the screen around
 * them: it says where the command runs, writes it for the chosen connection
 * without a password, keeps a saved folder as the user's default across a
 * reload, and hands SQL Server's BACKUP DATABASE to the SQL editor. On SQL
 * Server it also runs the backup on the server, finds it in msdb's history,
 * and points the restore at it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, clickWhen, waitFor } from '../helpers/driver.js';
import { getSourceConfig, hasConfig } from '../helpers/db-config.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { deleteSavedConnections } from '../helpers/sql-exec.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const runId = Date.now().toString(36);
const names: Record<string, string> = {};
let driver: Page;
let sql: SqlEditorPage;

async function openBackupFor(dialect: string): Promise<void> {
  await sql.openUtilitiesView();
  await clickWhen(driver, byTestId('utilities-backup'));
  // Saved connections load after the page does; after a reload the list can
  // still be empty when the workspace first paints.
  await driver.waitForFunction(
    (name) =>
      [...(document.querySelector('[data-testid="utilities-connection"]') as HTMLSelectElement | null)?.options ?? []].some((o) =>
        (o.textContent ?? '').includes(name)
      ),
    names[dialect]!,
    { timeout: 15_000 }
  );
  await sql.selectUtilityConnection(names[dialect]!, 'utilities-connection');
  await waitFor(driver, byTestId('backup-command-text'), 15_000);
}

const commandText = () => driver.locator(byTestId('backup-command-text')).innerText();

describe.skipIf(!hasConfig('postgres'))('Backup & Restore', () => {
  beforeAll(async () => {
    driver = await buildDriver();
    sql = new SqlEditorPage(driver);
    await new AppPage(driver).open();
    for (const dialect of ['postgres', 'sqlserver']) {
      if (!hasConfig(dialect)) continue;
      names[dialect] = `E2E Backup ${dialect} ${runId}`;
      await sql.addCredential(names[dialect]!, getSourceConfig(dialect)!);
    }
  }, 300_000);

  afterAll(async () => {
    await deleteSavedConnections(Object.values(names));
    if (driver) await quitDriver(driver);
  });

  it('says where pg_dump runs and writes it for this connection, with no password', async () => {
    const cfg = getSourceConfig('postgres')!;
    await openBackupFor('postgres');
    expect(await driver.locator(byTestId('backup-runs-on')).innerText()).toMatch(/Runs on your machine/);
    const command = await commandText();
    expect(command).toMatch(/^pg_dump /);
    expect(command).toContain(`--username ${cfg.username}`);
    expect(command).not.toContain(cfg.password || '\u0000never');
    expect(await driver.locator(byTestId('restore-command-text')).innerText()).toMatch(/^pg_restore /);
    // pg_dump runs on the reader's machine and Postgres keeps no record of it:
    // nothing to run or list on the server.
    expect(await driver.locator(byTestId('backup-server-actions')).count()).toBe(0);
    await saveScreenshot(driver, 'backup-restore-postgres');
  });

  it('keeps a saved folder as the default for the engine, across a reload', async () => {
    // Unique per run: a run that died before resetting leaves its folder saved,
    // and typing the saved value again leaves nothing to save.
    const folder = `/nas/e2e-${runId}`;
    await openBackupFor('postgres');
    await driver.locator(byTestId('backup-folder')).fill(folder);
    await driver.locator(byTestId('backup-save-default')).click();
    await driver.waitForFunction(
      () => /^Saved/.test(document.querySelector('[data-testid="backup-save-status"]')?.textContent ?? ''),
      undefined,
      { timeout: 10_000 }
    );

    await driver.reload();
    await openBackupFor('postgres');
    await driver.waitForFunction(
      () => /saved default/.test(document.querySelector('[data-testid="backup-save-status"]')?.textContent ?? ''),
      undefined,
      { timeout: 10_000 }
    );
    expect(await driver.locator(byTestId('backup-folder')).inputValue()).toBe(folder);
    expect(await commandText()).toContain(`--file=${folder}/`);

    // Leave the e2e account's default as the engine's own.
    await driver.locator(byTestId('backup-folder')).fill('./backups');
    await driver.locator(byTestId('backup-save-default')).click();
    await driver.waitForFunction(
      () => /^Saved/.test(document.querySelector('[data-testid="backup-save-status"]')?.textContent ?? ''),
      undefined,
      { timeout: 10_000 }
    );
  });

  it.skipIf(!hasConfig('sqlserver'))('runs SQL Server’s backup on the server, and opens it in the SQL editor', async () => {
    await openBackupFor('sqlserver');
    expect(await driver.locator(byTestId('backup-runs-on')).innerText()).toMatch(/database server/);
    expect(await commandText()).toMatch(/^BACKUP DATABASE \[/);
    await saveScreenshot(driver, 'backup-restore-sqlserver');
    await driver.locator(byTestId('backup-command-open-sql')).click();
    await waitFor(driver, byTestId('sql-editor-view'), 15_000);
  });

  it.skipIf(!hasConfig('sqlserver'))('runs SQL Server’s backup once confirmed, lists it, and restores the one picked', async () => {
    await openBackupFor('sqlserver');
    // A folder every SQL Server container has; the default must be made first.
    await driver.locator(byTestId('backup-folder')).fill('/var/opt/mssql/data');
    const restoreBefore = await driver.locator(byTestId('restore-command-text')).innerText();

    await driver.locator(byTestId('backup-run')).click();
    // Nothing runs until the reader has seen where the file goes.
    expect(await driver.locator(byTestId('backup-run-confirm-box')).innerText()).toContain(names.sqlserver!);
    await driver.locator(byTestId('backup-run-confirm')).click();
    await driver.waitForFunction(
      () =>
        /Backup finished/.test(document.querySelector('[data-testid="backup-run-status"]')?.textContent ?? '') ||
        document.querySelector('[data-testid="backup-run-error"]') !== null,
      undefined,
      { timeout: 120_000 }
    );
    const error = driver.locator(byTestId('backup-run-error'));
    expect(await error.count(), (await error.innerText().catch(() => '')) || 'no error').toBe(0);
    const file = (await driver.locator(byTestId('backup-run-status')).innerText()).replace(/^.*?: /, '').trim();
    expect(file).toMatch(/^\/var\/opt\/mssql\/data\/.+\.bak$/);

    // Listed straight after the run, newest first, from msdb.
    await driver.waitForSelector(
      [byTestId('backup-history-row-0'), byTestId('backup-history-empty'), byTestId('backup-history-error')].join(', '),
      { timeout: 30_000 }
    );
    const listed = driver.locator(byTestId('backup-history-row-0'));
    expect(await listed.count(), await driver.locator(byTestId('backup-server-actions')).innerText()).toBe(1);
    expect(await listed.innerText()).toContain(file);
    await driver.locator(byTestId('backup-history-pick-0')).click();
    expect(await driver.locator(byTestId('restore-command-text')).innerText()).toContain(`FROM DISK = N'${file}'`);
    await saveScreenshot(driver, 'backup-restore-sqlserver-picked');

    await driver.locator(byTestId('backup-history-clear-pick')).click();
    expect(await driver.locator(byTestId('restore-command-text')).innerText()).toBe(restoreBefore);
  }, 200_000);
});
