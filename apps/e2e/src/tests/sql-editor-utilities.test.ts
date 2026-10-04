/**
 * SQL Editor · Utilities sidebar, Clone Table, inline index edit (SQLite).
 * Covers recent features from Utilities-in-sidebar + Clone Table PRs.
 * Captures SEO screenshots under apps/e2e/screenshots and /opt/cursor/artifacts.
 */
import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { saveScreenshot, saveSeoScreenshot } from '../helpers/screenshot.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const DIR = `/tmp/foxschema-e2e-utilities-${Date.now().toString(36)}`;
const RUN = Date.now().toString(36);
const DB = join(DIR, 'utilities.db');
const NAME = `E2E Utilities ${RUN}`;
const LIVE_TABLE = 'orders';
const ARCHIVE_TABLE = 'orders_1';

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function seedDb(path: string): void {
  execFileSync('sqlite3', [path], {
    input: `
PRAGMA foreign_keys = ON;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT
);
CREATE UNIQUE INDEX ux_customers_email ON customers(email);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  note TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE INDEX ix_orders_customer ON orders(customer_id);
INSERT INTO customers (id, email, name) VALUES
  (1, 'a@example.com', 'Ada'),
  (2, 'b@example.com', 'Bob');
INSERT INTO orders (id, customer_id, note) VALUES
  (1, 1, 'first'),
  (2, 1, 'second'),
  (3, 2, 'third');
`,
  });
}

const ready = hasSqlite3();

describe.skipIf(!ready)('Utilities workspace + Clone Table (SQLite)', () => {
  let driver: Page;
  let app: AppPage;
  let sql: SqlEditorPage;

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    seedDb(DB);
    expect(existsSync(DB)).toBe(true);

    driver = await buildDriver();
    app = new AppPage(driver);
    sql = new SqlEditorPage(driver);

    await app.open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector('[data-testid="toolbar"]');

    await sql.addSqliteCredential(NAME, DB);
    await sql.openView();
    await sql.checkConnection(NAME);
    // Sidebar sections are an exclusive accordion: ticking a destination
    // closed Schema, and a closed section renders no explorer to read.
    await sql.ensureSidebarSectionOpen('schema');
    await driver.waitForFunction(
      () => {
        const root = document.querySelector('[data-testid="sql-schema-explorer"]');
        const t = root?.textContent ?? '';
        return /customers/i.test(t) && /orders/i.test(t);
      },
      { timeout: 45_000 }
    );
  }, 120_000);

  afterEach(async () => {
    await sql.closeCloneTable().catch(() => undefined);
    await sql.closeIndexManagement().catch(() => undefined);
    await sql.closeBlueprint().catch(() => undefined);
    await sql.dismissOverlays().catch(() => undefined);
  });

  afterAll(async () => {
    if (driver) await quitDriver(driver);
    rmSync(DIR, { recursive: true, force: true });
  });

  it('Utilities workspace lists Index Management and Clone Table', async () => {
    await sql.ensureSidebarSectionOpen('utilities');
    const utilities = driver.locator('[data-testid="sql-sidebar-utilities"]');
    expect(await utilities.locator('[data-testid="utilities-index-management"]').isVisible()).toBe(
      true
    );
    expect(await utilities.locator('[data-testid="utilities-clone-table"]').isVisible()).toBe(true);
    await saveSeoScreenshot(driver, 'sql-editor-utilities-sidebar');
  });

  it('opens Index Management from Utilities', async () => {
    await sql.openIndexManagement();
    const modal = driver.locator('[data-testid="index-management-modal"]');
    expect(await modal.isVisible()).toBe(true);
    await sql.selectUtilityConnection(NAME, 'index-mgmt-connection');
    await driver.locator('[data-testid="index-mgmt-load"]').click();
    await driver.waitForFunction(
      () => {
        const status = document.querySelector('[data-testid="index-mgmt-status"]');
        const groups = document.querySelector('[data-testid="index-mgmt-groups"]');
        const t = `${status?.textContent ?? ''}\n${groups?.textContent ?? ''}`;
        return /index/i.test(t) || /customer|order/i.test(t);
      },
      { timeout: 30_000 }
    );
    await saveScreenshot(driver, 'sql-editor-index-management');
    await sql.closeIndexManagement();
  });

  it('opens Clone Table from Utilities with SQL preview', async () => {
    await sql.openCloneTable();
    const modal = driver.locator('[data-testid="clone-table-modal"]');
    expect(await modal.isVisible()).toBe(true);
    await sql.loadCloneTables(NAME, LIVE_TABLE);

    await driver.waitForSelector('[data-testid="clone-sql-preview"]', { timeout: 10_000 });
    const preview = await driver.locator('[data-testid="clone-sql-preview"]').innerText();
    expect(preview.toLowerCase()).toMatch(/rename|alter table/);
    expect(preview.toLowerCase()).toMatch(/create\s+table/);
    expect(await driver.locator('[data-testid="clone-archive-preview"]').innerText()).toMatch(
      new RegExp(`${ARCHIVE_TABLE}`, 'i')
    );

    await driver.locator('[data-testid="clone-suffix-fixed"]').check();
    await driver.locator('[data-testid="clone-suffix-number"]').fill('1');
    expect(await driver.locator('[data-testid="clone-keep-indexes"]').isChecked()).toBe(true);

    await saveSeoScreenshot(driver, 'sql-editor-clone-table');
  });

  it('Insert SQL from Clone Table lands rename + create in the editor', async () => {
    await sql.openCloneTable();
    await sql.loadCloneTables(NAME, LIVE_TABLE);
    await driver.waitForSelector('[data-testid="clone-sql-preview"]', { timeout: 10_000 });
    await driver.locator('[data-testid="clone-insert-sql"]').click();
    await driver.waitForTimeout(500);
    await sql.closeCloneTable();

    const editorText = await sql.editorText();
    expect(editorText.toLowerCase()).toMatch(/rename|alter table/);
    expect(editorText.toLowerCase()).toMatch(/create\s+table/);
  });

  it('Clone Table from Utilities selects a table and shows archive preview', async () => {
    await sql.openCloneTable();
    const modal = driver.locator('[data-testid="clone-table-modal"]');
    expect(await modal.isVisible()).toBe(true);
    await sql.loadCloneTables(NAME, 'customers');
    await driver.waitForSelector('[data-testid="clone-archive-preview"]', { timeout: 10_000 });
    expect(await driver.locator('[data-testid="clone-archive-preview"]').innerText()).toMatch(
      /customers_1/i
    );
    await saveScreenshot(driver, 'sql-editor-clone-from-utilities');
  });

  it('Edit table opens index form under the selected index row', async () => {
    await sql.openTableBlueprint('customers');
    const modal = driver.locator('[data-testid="table-blueprint-modal"]');
    expect(await modal.isVisible()).toBe(true);

    const indexes = modal.locator('[data-testid="table-blueprint-indexes"]');
    await indexes.scrollIntoViewIfNeeded();
    const row = indexes.locator('[data-testid="blueprint-index-row-ux_customers_email"]');
    expect(await row.count()).toBeGreaterThan(0);
    await row.getByTitle('Edit index').click();

    await driver.waitForSelector('[data-testid="blueprint-index-form"]', { timeout: 5_000 });
    // Form should be nested under the selected row (inline), not only at section bottom.
    const formInRow = row.locator('[data-testid="blueprint-index-form"]');
    expect(await formInRow.count()).toBe(1);
    await saveScreenshot(driver, 'sql-editor-inline-index-edit');
    await sql.closeBlueprint();
  });

  it(
    'Apply clone renames orders → orders_1 and recreates empty orders',
    async () => {
      await sql.openCloneTable();
      await sql.loadCloneTables(NAME, LIVE_TABLE);
      await driver.waitForSelector('[data-testid="clone-sql-preview"]', { timeout: 10_000 });
      await expect
        .poll(async () => driver.locator('[data-testid="clone-apply"]').isEnabled(), {
          timeout: 5_000,
        })
        .toBe(true);

      await driver.locator('[data-testid="clone-apply"]').click();
      // Safe-mode opens WriteConfirmDialog before DDL runs.
      await sql.confirmWriteIfShown();

      // Playwright treats a lone `{ timeout }` object as the pageFunction arg, not
      // options — pass `undefined` then options so this cannot hang until Vitest's
      // 120s testTimeout (the daily cloud flake).
      await expect
        .poll(
          async () => {
            const status =
              (await driver.locator('[data-testid="clone-status"]').textContent().catch(() => '')) ??
              '';
            const err =
              (await driver.locator('[data-testid="clone-error"]').textContent().catch(() => '')) ??
              '';
            if (err.trim()) return `error:${err}`;
            if (/cloned/i.test(status)) return `ok:${status}`;
            return null;
          },
          { timeout: 60_000, interval: 250 }
        )
        .toMatch(/^ok:/);

      const status =
        (await driver.locator('[data-testid="clone-status"]').textContent().catch(() => '')) ?? '';
      expect(status.toLowerCase()).toMatch(/cloned/);
      expect(status.toLowerCase()).toMatch(/orders_1/);

      await saveSeoScreenshot(driver, 'sql-editor-clone-table-applied');
      await sql.closeCloneTable();

      // Best-effort schema refresh check (clone already verified via status).
      await sql.openView();
      await sql.ensureSidebarSectionOpen('schema');
      await driver
        .locator('[data-testid="sql-schema-explorer"] button[title="Reload schema"]')
        .click()
        .catch(() => undefined);
      await expect
        .poll(
          async () => driver.locator('[data-testid="sql-schema-explorer"]').innerText(),
          { timeout: 15_000 }
        )
        .toMatch(/orders_1/i);
    },
    180_000
  );

  it('Server Insights opens system info and table sizes on SQLite', async () => {
    await sql.openServerInsights('system');
    await sql.selectUtilityConnection(NAME, 'server-insights-connection');
    await driver.locator('[data-testid="server-insights-refresh"]').click();
    await driver.waitForTimeout(1500);
    const modal = driver.locator('[data-testid="server-insights-modal"]');
    expect(await modal.isVisible()).toBe(true);
    await saveSeoScreenshot(driver, 'sql-editor-server-insights-system');

    await driver.locator('[data-testid="server-insights-tab-sizes"]').click();
    await driver.waitForTimeout(1500);
    await saveSeoScreenshot(driver, 'sql-editor-server-insights-sizes');

    await driver.locator('[data-testid="server-insights-tab-pool"]').click();
    await driver.waitForTimeout(400);
    const body = await modal.innerText();
    expect(body.toLowerCase()).toMatch(/embedded|does not|unsupported|no server/i);

    await sql.closeServerInsights();
  });
});
