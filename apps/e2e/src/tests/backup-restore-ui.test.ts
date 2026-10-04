/**
 * Backup & Restore in the Utilities workspace, in a real browser.
 *
 * The commands are unit-tested per engine; this checks the screen around
 * them: it says where the command runs, writes it for the chosen connection
 * without a password, keeps a saved folder as the user's default across a
 * reload, and hands SQL Server's BACKUP DATABASE to the SQL editor.
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
});
