/**
 * Code that is no longer in the first download still arrives when it is used.
 *
 * The first page load now leaves out, among others, sql-formatter, the panels
 * that open on a click (credentials, applies history, the admin console), and
 * the packages a code cell can import. Unit tests replace or bypass those
 * dynamic imports; this runs them in a real browser against the dev server.
 *
 * Requires the web app + API (`npm run dev`) and a `sqlite3` CLI on PATH.
 * Skips when sqlite3 is unavailable so CI without the CLI stays green.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, clickWhen, waitFor } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';
import { deleteSavedConnections } from '../helpers/sql-exec.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const DIR = '/tmp/foxschema-e2e-lazy-loading';
const DB = join(DIR, 'lazy.db');
const NAME = `E2E Lazy ${Date.now().toString(36)}`;

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasSqlite3())('Loaded on demand', () => {
  let driver: Page;
  let sql: SqlEditorPage;

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    execFileSync('sqlite3', [DB], { input: 'CREATE TABLE t (id INTEGER PRIMARY KEY);\n' });

    driver = await buildDriver();
    sql = new SqlEditorPage(driver);
    await new AppPage(driver).open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector(byTestId('toolbar'));

    // The credential manager is itself loaded on its first open.
    await sql.addSqliteCredential(NAME, DB);
    await sql.openView();
    await sql.checkConnection(NAME);
  }, 180_000);

  afterAll(async () => {
    await deleteSavedConnections([NAME]);
    if (driver) await quitDriver(driver);
    rmSync(DIR, { recursive: true, force: true });
  });

  it('formats SQL and a TypeScript cell with formatters fetched on first use', async () => {
    await sql.setSql(
      'select id from t where id = 1;\n-- @ts\nconst rows: number[] = [1,2]\nreturn rows.map((n) => ({ n }))\n-- @end\n'
    );
    await driver.locator(byTestId('sql-format-btn')).click();
    await expect
      .poll(async () => driver.locator(byTestId('sql-format-note')).innerText().catch(() => ''), {
        timeout: 20_000,
      })
      .toMatch(/Formatted SQL \+ 1 JS\/TS cell/);
    const text = await sql.editorText();
    expect(text).toMatch(/SELECT/);
    // Prettier's babel-ts parser: types kept, spacing and semicolons added.
    expect(text).toContain('const rows: number[] = [1, 2];');
  });

  it('runs a code cell that imports lodash and date-fns', async () => {
    await sql.setSql(
      "-- @js\nimport { groupBy } from 'lodash-es';\nimport { format } from 'date-fns';\n" +
        'const odd = groupBy([1, 2, 3], (n) => n % 2)[1];\n' +
        "return [{ odd: odd.length, day: format(new Date(2020, 0, 2), 'yyyy-MM-dd') }];\n-- @end"
    );
    await sql.run();
    await sql.waitForResults();
    await expect.poll(async () => sql.resultsText(), { timeout: 30_000, interval: 250 }).toMatch(/2020-01-02/);
  });

  it('runs a TypeScript cell, compiled by the server rather than in the browser', async () => {
    await sql.setSql(
      '-- @ts\nconst rows: { n: number }[] = [{ n: 41 }];\nreturn rows.map((r) => ({ answer: r.n + 1 }));\n-- @end'
    );
    await sql.run();
    await sql.waitForResults();
    await expect.poll(async () => sql.resultsText(), { timeout: 30_000, interval: 250 }).toMatch(/42/);
  });

  it('opens the applies history and the admin console on their first click', async () => {
    await clickWhen(driver, byTestId('history-btn'));
    await waitFor(driver, byTestId('history-dialog'), 15_000);
    await clickWhen(driver, byTestId('history-dialog-close-btn'));

    await clickWhen(driver, byTestId('profile-menu-trigger'));
    await clickWhen(driver, byTestId('profile-access-control'));
    await waitFor(driver, byTestId('admin-access-panel'), 15_000);
    await clickWhen(driver, byTestId('admin-access-close'));
  });
});
