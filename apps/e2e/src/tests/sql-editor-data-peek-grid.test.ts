/**
 * Data Peek grid, end to end against SQLite.
 *
 * What a reader does with a peek: page through a table, narrow it with WHERE,
 * sort it, follow a foreign key to the parent row and back to the children
 * that point at a row, and close what they opened. Each test asserts on the
 * rows the panel shows, read out of the grid itself, so a filter that applied
 * to the wrong panel or a page that never loaded cannot pass.
 *
 * Fixture: 3 regions, 12 customers (region_id and referrer_id are foreign
 * keys), 30 orders (customer_id). Every value is a function of the id, so each
 * expectation below can be worked out from the id alone.
 *
 * Requires the web app + API (`npm run dev`) and a `sqlite3` CLI on PATH.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const RUN = Date.now().toString(36);
// Per-run directory: the backend pools SQLite handles by file path, so reusing
// one across runs writes through a handle pointing at a deleted inode.
const DIR = `/tmp/foxschema-e2e-peek-grid-${RUN}`;
const DB = join(DIR, 'peek.db');
const NAME = `E2E Peek Grid ${RUN}`;

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FIXTURE = `
PRAGMA foreign_keys = ON;
CREATE TABLE region (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE customer (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  region_id INTEGER REFERENCES region(id),
  referrer_id INTEGER REFERENCES customer(id),
  tier TEXT NOT NULL
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  total INTEGER NOT NULL,
  status TEXT NOT NULL
);
INSERT INTO region (id, name) VALUES (1, 'North'), (2, 'South'), (3, 'East');
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12)
INSERT INTO customer (id, name, region_id, referrer_id, tier)
SELECT i, printf('c%02d', i), ((i - 1) % 3) + 1, CASE WHEN i = 1 THEN NULL ELSE 1 END,
       CASE WHEN i % 4 = 0 THEN 'gold' ELSE 'basic' END
FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
INSERT INTO orders (id, customer_id, total, status)
SELECT i, ((i - 1) % 12) + 1, i * 10, CASE WHEN i % 3 = 0 THEN 'paid' ELSE 'open' END
FROM n;
`;

describe.skipIf(!hasSqlite3())('SQL Editor · Data Peek grid', () => {
  let driver: Page;
  let app: AppPage;
  let sql: SqlEditorPage;

  /** Ids of the open panels, in screen order. */
  const panelIds = (): Promise<string[]> =>
    driver.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="data-peek-grid-"]')].map((el) =>
        (el.getAttribute('data-testid') ?? '').slice('data-peek-grid-'.length)
      )
    );

  /** The rows a panel shows, as cell text, without the row-number column. */
  const rowsOf = (id: string): Promise<string[][]> =>
    driver.evaluate((pid) => {
      const grid = document.querySelector(
        `[data-testid="data-peek-grid-${pid}"] [data-testid="sql-data-grid"]`
      );
      if (!grid) return [];
      return [...grid.querySelectorAll('tbody tr')]
        .filter((tr) => tr.querySelector('[data-testid="sql-row-num"]'))
        .map((tr) =>
          [...tr.querySelectorAll('td')].slice(1).map((td) => (td.textContent ?? '').trim())
        );
    }, id);

  /** The first column of every row — the id, for each table here. */
  const idsOf = async (id: string): Promise<string[]> => (await rowsOf(id)).map((r) => r[0] ?? '');

  /** The row numbers the grid prints in its # column. */
  const rowNumbersOf = (id: string): Promise<string[]> =>
    driver.evaluate(
      (pid) =>
        [
          ...document.querySelectorAll(
            `[data-testid="data-peek-grid-${pid}"] [data-testid="sql-row-num"]`
          ),
        ].map((td) => (td.textContent ?? '').trim()),
      id
    );

  /** The panel's own text — title, footer, error. */
  const textOf = (id: string): Promise<string> =>
    driver.locator(byTestId(`data-peek-grid-${id}`)).innerText();

  /** "page N" from the grid footer, or null when no grid is showing. */
  const pageOf = async (id: string): Promise<number | null> => {
    const m = /· page (\d+)/.exec(await textOf(id));
    return m ? Number(m[1]) : null;
  };

  /** Type into a filter box and press Enter, which applies at once. */
  async function filter(id: string, box: 'where' | 'order' | 'limit', value: string): Promise<void> {
    const input = driver.locator(byTestId(`data-peek-${box}-${id}`));
    await input.fill(value);
    await input.press('Enter');
  }

  /** Open a fresh peek on `table` and return its root panel id. */
  async function peek(table: string): Promise<string> {
    if (await driver.locator(byTestId('data-peek')).count()) {
      await driver.locator(byTestId('data-peek-close')).click();
      await driver.locator(byTestId('data-peek')).waitFor({ state: 'detached' });
    }
    await sql.openDataPeek(table);
    const [root] = await panelIds();
    expect(root, `no panel opened for ${table}`).toBeTruthy();
    await expect.poll(() => rowsOf(root!), { timeout: 20_000 }).not.toHaveLength(0);
    return root!;
  }

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    execFileSync('sqlite3', [DB], { input: FIXTURE });

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
  }, 180_000);

  afterAll(async () => {
    if (driver) await quitDriver(driver);
    rmSync(DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await driver.unrouteAll({ behavior: 'ignoreErrors' });
  });

  it('pages through a table at the limit typed, numbering rows across pages', async () => {
    const root = await peek('orders');
    await filter(root, 'limit', '10');
    await expect.poll(() => idsOf(root)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(await pageOf(root)).toBe(1);

    const panel = driver.locator(byTestId(`data-peek-grid-${root}`));
    await panel.locator(byTestId('sql-page-next')).click();
    await expect.poll(() => idsOf(root)).toEqual(['11', '12', '13', '14', '15', '16', '17', '18', '19', '20']);
    expect(await pageOf(root)).toBe(2);
    // The # column continues from page one instead of restarting at 1.
    expect((await rowNumbersOf(root))[0]).toBe('11');

    await panel.locator(byTestId('sql-page-next')).click();
    await expect.poll(() => idsOf(root).then((ids) => ids[0])).toBe('21');
    expect((await idsOf(root))[9]).toBe('30');

    await panel.locator(byTestId('sql-page-prev')).click();
    await expect.poll(() => (idsOf(root)).then((ids) => ids[0])).toBe('11');
    expect(await pageOf(root)).toBe(2);
  }, 90_000);

  it('filters with WHERE, and the clear button brings every row back', async () => {
    const root = await peek('orders');
    await filter(root, 'where', "status = 'paid'");
    // Every third order is paid.
    await expect
      .poll(() => idsOf(root))
      .toEqual(['3', '6', '9', '12', '15', '18', '21', '24', '27', '30']);

    await driver.locator(byTestId(`data-peek-where-clear-${root}`)).click();
    await expect.poll(() => rowsOf(root).then((r) => r.length), { timeout: 15_000 }).toBeGreaterThan(10);
    expect(await driver.locator(byTestId(`data-peek-where-${root}`)).inputValue()).toBe('');
  }, 60_000);

  it('a filter starts again from page one', async () => {
    const root = await peek('orders');
    await filter(root, 'limit', '5');
    await expect.poll(() => idsOf(root)).toHaveLength(5);
    await driver.locator(byTestId(`data-peek-grid-${root}`)).locator(byTestId('sql-page-next')).click();
    await expect.poll(() => pageOf(root)).toBe(2);

    await filter(root, 'where', 'total >= 200');
    // Orders 20..30 have total >= 200; page one of five of them.
    await expect.poll(() => idsOf(root)).toEqual(['20', '21', '22', '23', '24']);
    expect(await pageOf(root)).toBe(1);
  }, 60_000);

  it('sorts with ORDER BY', async () => {
    const root = await peek('orders');
    await filter(root, 'order', 'total DESC');
    await expect.poll(() => idsOf(root).then((ids) => ids.slice(0, 3))).toEqual(['30', '29', '28']);
  }, 60_000);

  it('refuses a WHERE that carries a second statement, and recovers when fixed', async () => {
    const root = await peek('orders');
    await filter(root, 'where', 'id = 1; DELETE FROM orders');
    await expect.poll(() => textOf(root)).toMatch(/single predicate/i);
    // Nothing ran: the table still has all thirty orders.
    expect(
      execFileSync('sqlite3', [DB, 'SELECT COUNT(*) FROM orders'], { encoding: 'utf8' }).trim()
    ).toBe('30');

    await filter(root, 'where', 'id = 7');
    await expect.poll(() => idsOf(root)).toEqual(['7']);
    expect(await textOf(root)).not.toMatch(/single predicate/i);
  }, 60_000);

  it('shows the database error for a WHERE it cannot run, and recovers when fixed', async () => {
    const root = await peek('orders');
    await filter(root, 'where', 'no_such_column = 1');
    await expect.poll(() => textOf(root)).toMatch(/no_such_column/i);
    await filter(root, 'where', 'customer_id = 12');
    // Customer 12 owns orders 12 and 24.
    await expect.poll(() => idsOf(root)).toEqual(['12', '24']);
  }, 60_000);

  it('keeps the Limit box showing the limit in force', async () => {
    const root = await peek('orders');
    const limit = driver.locator(byTestId(`data-peek-limit-${root}`));

    // Out of range is clamped, and the box says so instead of keeping the typo.
    await filter(root, 'limit', '99999');
    await expect.poll(() => limit.inputValue()).toBe('5000');
    await filter(root, 'limit', '99999');
    await expect.poll(() => limit.inputValue()).toBe('5000');

    await filter(root, 'limit', '0');
    await expect.poll(() => idsOf(root)).toEqual(['1']);
    await expect.poll(() => limit.inputValue()).toBe('1');

    // An emptied box goes back to the limit still applied when it loses focus.
    await limit.fill('');
    await limit.blur();
    await expect.poll(() => limit.inputValue()).toBe('1');
    expect(await idsOf(root)).toEqual(['1']);
  }, 60_000);

  it('follows a foreign key into a keyed panel, replaces it per column, and stacks other columns', async () => {
    const root = await peek('customer');
    const columns = await driver.evaluate(
      (pid) =>
        [
          ...document.querySelectorAll(
            `[data-testid="data-peek-grid-${pid}"] [data-testid="sql-col-header"]`
          ),
        ]
          // A header reads "▲region_idnum": sort arrow, name, type badge.
          .map((th) => (th.textContent ?? '').trim().toLowerCase().replace(/^[^a-z_]+/, '')),
      root
    );
    const regionCol = columns.findIndex((c) => c.startsWith('region_id'));
    const referrerCol = columns.findIndex((c) => c.startsWith('referrer_id'));
    expect(regionCol, `columns: ${columns.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(referrerCol).toBeGreaterThanOrEqual(0);

    const rootPanel = driver.locator(byTestId(`data-peek-grid-${root}`));
    // Row 0 is customer 1 → region 1.
    await rootPanel.locator(byTestId(`grid-fk-link-0-${regionCol}`)).click();
    await expect.poll(() => panelIds()).toHaveLength(2);
    const [, region1] = await panelIds();
    await expect.poll(() => rowsOf(region1!)).toEqual([['1', 'North']]);
    expect(await driver.locator(byTestId(`data-peek-base-filter-${region1}`)).innerText()).toMatch(
      /id = 1/
    );

    // Row 1 is customer 2 → region 2, replacing the region panel, not adding one.
    await rootPanel.locator(byTestId(`grid-fk-link-1-${regionCol}`)).click();
    await expect.poll(async () => (await panelIds()).length).toBe(2);
    const [, region2] = await panelIds();
    expect(region2).not.toBe(region1);
    await expect.poll(() => rowsOf(region2!)).toEqual([['2', 'South']]);

    // A different FK column of the same row opens a sibling panel.
    await rootPanel.locator(byTestId(`grid-fk-link-1-${referrerCol}`)).click();
    await expect.poll(async () => (await panelIds()).length).toBe(3);
    const referrer = (await panelIds())[2]!;
    await expect.poll(() => idsOf(referrer)).toEqual(['1']);

    // All rows drops the bound key and fetches the whole parent table.
    await driver.locator(byTestId(`data-peek-clear-key-${region2}`)).click();
    await expect.poll(() => idsOf(region2!)).toEqual(['1', '2', '3']);
    expect(await driver.locator(byTestId(`data-peek-base-filter-${region2}`)).count()).toBe(0);
  }, 90_000);

  it('lists the children that point at the selected row', async () => {
    const root = await peek('customer');
    const chip = driver.locator('[data-testid^="data-peek-refby-orders-"]').first();
    await chip.waitFor({ state: 'visible', timeout: 15_000 });
    expect(await chip.isDisabled(), 'chip should wait for a row to be chosen').toBe(true);

    // Customer 5 (row 4) owns orders 5, 17 and 29.
    await driver
      .locator(byTestId(`data-peek-grid-${root}`))
      .locator('[data-testid="sql-row-4"] td')
      .nth(2)
      .click();
    await expect.poll(() => chip.isDisabled()).toBe(false);
    await chip.click();
    await expect.poll(async () => (await panelIds()).length).toBe(2);
    const child = (await panelIds())[1]!;
    await expect.poll(() => idsOf(child)).toEqual(['5', '17', '29']);
  }, 60_000);

  it('closing a panel closes the panels opened from it; closing the root closes the peek', async () => {
    const root = await peek('orders');
    const rootPanel = driver.locator(byTestId(`data-peek-grid-${root}`));
    // orders.customer_id is the second column.
    await rootPanel.locator(byTestId('grid-fk-link-0-1')).click();
    await expect.poll(async () => (await panelIds()).length).toBe(2);
    const customer = (await panelIds())[1]!;
    await expect.poll(() => idsOf(customer)).toEqual(['1']);

    // customer 1's region_id is the third column.
    await driver.locator(byTestId(`data-peek-grid-${customer}`)).locator(byTestId('grid-fk-link-0-2')).click();
    await expect.poll(async () => (await panelIds()).length).toBe(3);

    await driver.locator(byTestId(`data-peek-close-panel-${customer}`)).click();
    await expect.poll(() => panelIds()).toEqual([root]);

    await driver.locator(byTestId('data-peek-close')).click();
    await driver.locator(byTestId('data-peek')).waitFor({ state: 'detached', timeout: 10_000 });
  }, 60_000);

  it('Escape clears a cell selection first, and only then closes the peek', async () => {
    const root = await peek('orders');
    const rootPanel = driver.locator(byTestId(`data-peek-grid-${root}`));
    await rootPanel.locator('[data-testid="sql-row-2"] td').nth(3).click();
    await expect.poll(() => rootPanel.locator('td[data-selected="true"]').count()).toBeGreaterThan(0);

    await driver.keyboard.press('Escape');
    await expect.poll(() => rootPanel.locator('td[data-selected="true"]').count()).toBe(0);
    expect(
      await driver.locator(byTestId('data-peek')).count(),
      'Escape meant for the cell selection closed the whole peek'
    ).toBe(1);

    await driver.keyboard.press('Escape');
    await driver.locator(byTestId('data-peek')).waitFor({ state: 'detached', timeout: 10_000 });
  }, 60_000);

  it('Escape in the save-as-variable dialog closes the dialog, not the peek', async () => {
    const root = await peek('orders');
    const rootPanel = driver.locator(byTestId(`data-peek-grid-${root}`));
    await rootPanel.locator('[data-testid="sql-row-0"] td').nth(3).click({ button: 'right' });
    await driver.locator(byTestId('sql-grid-save-cell-as')).click();
    const name = driver.locator(byTestId('sql-grid-save-name'));
    await name.waitFor({ state: 'visible' });
    await name.press('Escape');

    await driver.locator(byTestId('sql-variable-save-dialog')).waitFor({ state: 'detached' });
    expect(
      await driver.locator(byTestId('data-peek')).count(),
      'Escape meant for the dialog closed the whole peek'
    ).toBe(1);
  }, 60_000);

  it('after a failed page fetch, the page number matches the rows still shown', async () => {
    const root = await peek('orders');
    await filter(root, 'limit', '10');
    await expect.poll(() => idsOf(root)).toHaveLength(10);
    expect(await pageOf(root)).toBe(1);

    // The next execute fails the way a dropped connection or a 429 does.
    await driver.route('**/api/sql/execute', (route) => route.abort('failed'), { times: 1 });
    await driver.locator(byTestId(`data-peek-grid-${root}`)).locator(byTestId('sql-page-next')).click();
    await expect.poll(() => textOf(root)).toMatch(/fail|error/i);

    const ids = await idsOf(root);
    if (ids.length > 0) {
      // Rows 1-10 are still on screen, so the panel must still call them page 1,
      // numbered from 1 — not page 2 numbered 11-20.
      expect(ids[0]).toBe('1');
      expect(await pageOf(root)).toBe(1);
      expect((await rowNumbersOf(root))[0]).toBe('1');
    }

    // Next works once the connection is back.
    await driver.locator(byTestId(`data-peek-grid-${root}`)).locator(byTestId('sql-page-next')).click();
    await expect.poll(() => idsOf(root).then((r) => r[0])).toBe('11');
    expect(await pageOf(root)).toBe(2);
  }, 60_000);

  it('keeps the filter across a visit to Insight', async () => {
    const root = await peek('orders');
    await filter(root, 'where', "status = 'paid' AND total > 200");
    await expect.poll(() => idsOf(root)).toEqual(['21', '24', '27', '30']);

    await driver.locator(byTestId(`data-peek-tab-insight-${root}`)).click();
    await driver.locator(byTestId('data-peek-insight')).waitFor({ state: 'visible', timeout: 15_000 });
    await driver.locator(byTestId(`data-peek-tab-rows-${root}`)).click();

    expect(await driver.locator(byTestId(`data-peek-where-${root}`)).inputValue()).toBe(
      "status = 'paid' AND total > 200"
    );
    await expect.poll(() => idsOf(root)).toEqual(['21', '24', '27', '30']);
  }, 60_000);
});
