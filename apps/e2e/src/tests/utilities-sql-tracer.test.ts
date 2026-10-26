/**
 * Utilities → SQL Tracer, end to end.
 *
 * Fox activity (SQLite): a trace on a saved connection shows the statements
 * run on that connection through the API — what another person or another
 * tab does — with secrets masked, and a failure marked.
 *
 * Live (PostgreSQL): a statement still running on the engine shows from its
 * session list, masked the same way, and the tracer's own probe never does.
 *
 * Statements are sent through /api/sql/execute rather than the editor because
 * opening the editor would close the Utilities screen, and closing it stops
 * the trace. Requires the web app + API, a `sqlite3` CLI for the first part
 * and E2E_SOURCE_POSTGRES_* for the second.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { buildDriver, clickWhen, quitDriver } from '../helpers/driver.js';
import { getSourceConfig, hasConfig } from '../helpers/db-config.js';
import { sessionCookie } from '../helpers/app-session.js';
import { deleteSavedConnections, runStatements } from '../helpers/sql-exec.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const RUN = Date.now().toString(36);
const DIR = `/tmp/foxschema-e2e-tracer-${RUN}`;
const SQLITE = { file: join(DIR, 'traced.db'), name: `E2E Tracer SQLite ${RUN}` };
const PG_NAME = `E2E Tracer PG ${RUN}`;

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function connectionIdOf(name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/connections`, { headers: { cookie: await sessionCookie() } });
  const body = (await res.json()) as Array<{ id: string; name: string }> | { connections: Array<{ id: string; name: string }> };
  const rows = Array.isArray(body) ? body : body.connections;
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`no saved connection named ${name}`);
  return row.id;
}

/** Run statements on a saved connection, as the SQL editor does. */
async function runOnSaved(connectionId: string, statements: string[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/sql/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await sessionCookie() },
    body: JSON.stringify({ connectionId, statements }),
  });
  if (!res.ok) throw new Error(`execute failed: ${res.status} ${await res.text()}`);
}

describe('Utilities · SQL Tracer', () => {
  let driver: Page;
  let sql: SqlEditorPage;
  const made: string[] = [];

  const rowTexts = () =>
    driver.$$eval('[data-testid^="sql-tracer-row-"]', (rows) => rows.map((r) => r.lastElementChild?.textContent ?? ''));

  async function openTracerOn(name: string): Promise<void> {
    await sql.openUtilitiesView();
    await clickWhen(driver, byTestId('utilities-sql-tracer'));
    await driver.waitForFunction(
      (n) =>
        [...((document.querySelector('[data-testid="utilities-connection"]') as HTMLSelectElement | null)?.options ?? [])].some((o) =>
          (o.textContent ?? '').includes(n)
        ),
      name,
      { timeout: 15_000 }
    );
    await sql.selectUtilityConnection(name, 'utilities-connection');
    await driver.waitForSelector(byTestId('sql-tracer-panel'));
  }

  beforeAll(async () => {
    driver = await buildDriver();
    sql = new SqlEditorPage(driver);
    await new AppPage(driver).open();
  }, 120_000);

  afterAll(async () => {
    await deleteSavedConnections(made);
    rmSync(DIR, { recursive: true, force: true });
    if (driver) await quitDriver(driver);
  });

  describe.skipIf(!hasSqlite3())('Fox activity', () => {
    let connectionId = '';

    beforeAll(async () => {
      rmSync(DIR, { recursive: true, force: true });
      mkdirSync(DIR, { recursive: true });
      execFileSync('sqlite3', [SQLITE.file], { input: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);' });
      await sql.addSqliteCredential(SQLITE.name, SQLITE.file);
      made.push(SQLITE.name);
      connectionId = await connectionIdOf(SQLITE.name);
    }, 120_000);

    it('shows each statement run on the connection, masked, until stopped', async () => {
      await openTracerOn(SQLITE.name);
      await driver.locator(byTestId('sql-tracer-mode')).selectOption('fox');
      await clickWhen(driver, byTestId('sql-tracer-start'));
      await driver.waitForSelector(byTestId('sql-tracer-stop'));

      await runOnSaved(connectionId, [
        `INSERT INTO items (id, name) VALUES (1, 'tracer-${RUN}')`,
        `SELECT name FROM items /* PASSWORD 'hunter2' */`,
        'SELECT * FROM no_such_table',
      ]);

      await driver.waitForFunction(() => document.querySelectorAll('[data-testid^="sql-tracer-row-"]').length >= 3, null, {
        timeout: 15_000,
      });
      const texts = await rowTexts();
      expect(texts[0]).toContain(`tracer-${RUN}`);
      expect(texts[1]).toContain("PASSWORD '***'");
      expect(texts.join('\n')).not.toContain('hunter2');

      // The failed one carries its error in the detail pane.
      await driver.locator(byTestId('sql-tracer-row-3')).click();
      await driver.waitForSelector(byTestId('sql-tracer-detail'));
      expect(await driver.locator(byTestId('sql-tracer-detail')).innerText()).toMatch(/no such table/i);
      await saveScreenshot(driver, 'sql-tracer-fox-activity');

      await clickWhen(driver, byTestId('sql-tracer-stop'));
      await driver.waitForSelector(byTestId('sql-tracer-start'));
      expect(await driver.locator(byTestId('sql-tracer-status')).innerText()).toContain('Stopped');

      // Nothing more arrives once stopped.
      await runOnSaved(connectionId, ['SELECT 42']);
      await driver.waitForTimeout(2_500);
      expect((await rowTexts()).some((t) => t.includes('42'))).toBe(false);
    }, 90_000);
  });

  describe.skipIf(!hasConfig('postgres'))('Live (PostgreSQL)', () => {
    beforeAll(async () => {
      await sql.addCredential(PG_NAME, getSourceConfig('postgres')!);
      made.push(PG_NAME);
    }, 120_000);

    it('shows a statement still running, masked, and not its own probe', async () => {
      await openTracerOn(PG_NAME);
      await driver.locator(byTestId('sql-tracer-mode')).selectOption('live');
      await clickWhen(driver, byTestId('sql-tracer-start'));
      await driver.waitForSelector(byTestId('sql-tracer-stop'));

      const marker = `tracer-${RUN}`;
      // Not awaited: it has to be running while the tracer reads the sessions.
      const running = runStatements('postgres', [`SELECT pg_sleep(6) /* ${marker} PASSWORD 'hunter2' */`]);

      await driver.waitForFunction(
        (m) =>
          [...document.querySelectorAll('[data-testid^="sql-tracer-row-"]')].some((r) => (r.textContent ?? '').includes(m)),
        marker,
        { timeout: 15_000 }
      );
      const texts = await rowTexts();
      const mine = texts.find((t) => t.includes(marker))!;
      expect(mine).toContain("PASSWORD '***'");
      expect(texts.join('\n')).not.toContain('hunter2');
      expect(texts.some((t) => /pg_stat_activity/i.test(t))).toBe(false);
      await saveScreenshot(driver, 'sql-tracer-live-postgres');

      await clickWhen(driver, byTestId('sql-tracer-stop'));
      await running;
    }, 90_000);
  });
});
