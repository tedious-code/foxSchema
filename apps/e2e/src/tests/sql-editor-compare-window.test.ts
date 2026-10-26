/**
 * Compare 2,000 rows: both sides read again in key order, every row inside the
 * window classified, and the result paged and filtered in the browser.
 *
 * The grids page each side on its own with OFFSET, so their pages do not line
 * up and a one-sided row on a cut-short side can only be "unresolved". A
 * compare run reads the first 2,000 rows of both sides by key instead.
 *
 * Fixture (every count below follows from it):
 *   source  ids 1–2,500, name n<id>
 *   target  the same, without 7, 1,500 and 2,300; names changed at 10, 20 and
 *           1,990; plus 2,600 and 2,601
 * In the window, source ends at id 2,000 and target at 2,002, so:
 *   Changed 3 · Only in source 2 (7, 1,500) · Only in target 0 ·
 *   Unresolved 2 (2,001 and 2,002, past the source's last key) ·
 *   Matching 1,995 · All 2,002
 *
 * Two SQLite files under a per-run directory. Requires the web app + API and
 * a `sqlite3` CLI on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const RUN = Date.now().toString(36);
const DIR = `/tmp/foxschema-e2e-compare-window-${RUN}`;
const SOURCE = { file: join(DIR, 'source.db'), name: `E2E Window Src ${RUN}` };
const TARGET = { file: join(DIR, 'target.db'), name: `E2E Window Tgt ${RUN}` };

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function seed(path: string, target: boolean): void {
  const missing = new Set([7, 1500, 2300]);
  const changed = new Set([10, 20, 1990]);
  const rows: string[] = [];
  for (let id = 1; id <= 2500; id++) {
    if (target && missing.has(id)) continue;
    rows.push(`(${id}, '${target && changed.has(id) ? `changed${id}` : `n${id}`}')`);
  }
  if (target) rows.push("(2600, 'n2600')", "(2601, 'n2601')");
  execFileSync('sqlite3', [path], {
    input: `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            INSERT INTO items (id, name) VALUES ${rows.join(',')};`,
  });
}

describe.skipIf(!hasSqlite3())('SQL Editor · Compare 2,000 rows', () => {
  let driver: Page;
  let sql: SqlEditorPage;
  const label = (id: string) => driver.locator(byTestId(id as never)).innerText();

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    seed(SOURCE.file, false);
    seed(TARGET.file, true);

    driver = await buildDriver();
    sql = new SqlEditorPage(driver);
    await new AppPage(driver).open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector(byTestId('toolbar'));
    await sql.addSqliteCredential(SOURCE.name, SOURCE.file);
    await sql.addSqliteCredential(TARGET.name, TARGET.file);
  }, 180_000);

  afterAll(async () => {
    if (driver) await quitDriver(driver);
    rmSync(DIR, { recursive: true, force: true });
  });

  it('compares the first 2,000 rows of both sides by key, classifying every row the window can decide', async () => {
    await sql.openView();
    await sql.checkConnection(SOURCE.name);
    await sql.checkConnection(TARGET.name);
    await sql.setSql('SELECT id, name FROM items;');
    await sql.run();
    await sql.waitForResults();
    await sql.setLayoutSideBySide();
    await sql.compareToggle(0).click();

    // The source is the first destination checked; the target, the other.
    const baseline = await driver.locator(byTestId('sql-result-compare-baseline-0')).inputValue();
    const sourceValue = await driver.evaluate(
      (name) =>
        [...(document.querySelector('[data-testid="sql-result-compare-baseline-0"]') as HTMLSelectElement).options].find(
          (o) => o.textContent?.includes(name)
        )?.value,
      SOURCE.name
    );
    if (sourceValue && sourceValue !== baseline) {
      await driver.locator(byTestId('sql-result-compare-baseline-0')).selectOption(sourceValue);
    }

    await driver.locator(byTestId('sql-result-compare-window-run-0')).click();
    await driver.waitForSelector(byTestId('sql-result-compare-window-summary-0'), { timeout: 60_000 });
    expect(await label('sql-result-compare-window-summary-0')).toMatch(
      /Compared 2,000 \(more follow\) source and 2,000 \(more follow\) target rows, ordered by id/
    );

    const count = async (f: string) => {
      const text = await label(`sql-result-compare-filter-${f}-0`);
      return Number(text.replace(/[^\d]/g, ''));
    };
    expect({
      changed: await count('changed'),
      source: await count('source'),
      target: await count('target'),
      unresolved: await count('unresolved'),
      matching: await count('matching'),
      all: await count('all'),
    }).toEqual({ changed: 3, source: 2, target: 0, unresolved: 2, matching: 1995, all: 2002 });
    await saveScreenshot(driver, 'compare-window-summary');
  }, 180_000);

  it('filters to the changed rows and pages the rest in the browser', async () => {
    await driver.locator(byTestId('sql-result-compare-filter-changed-0')).click();
    expect(await label('sql-result-compare-page-label-0')).toBe('page 1 of 1');
    const keys = await driver.evaluate(() =>
      [...document.querySelectorAll('[data-testid="sql-data-grid"]')][0]!
        .querySelectorAll('tbody tr [data-testid="sql-row-num"]').length
    );
    expect(keys).toBe(3);

    await driver.locator(byTestId('sql-result-compare-filter-all-0')).click();
    await driver.locator(byTestId('sql-result-compare-page-size-0')).selectOption('100');
    expect(await label('sql-result-compare-page-label-0')).toBe('page 1 of 21');
  }, 60_000);

  it('steps from one difference to the next across pages of matching rows', async () => {
    // Differences sit at ids 7, 10 and 20 (page 1), 1,500 (page 15) and 1,990 (page 20).
    await driver.locator(byTestId('sql-result-compare-diff-next-0')).click();
    expect(await label('sql-result-compare-page-label-0')).toBe('page 15 of 21');
    await driver.locator(byTestId('sql-result-compare-diff-next-0')).click();
    expect(await label('sql-result-compare-page-label-0')).toBe('page 20 of 21');
    expect(await driver.locator(byTestId('sql-result-compare-diff-next-0')).isDisabled()).toBe(true);
    await driver.locator(byTestId('sql-result-compare-diff-prev-0')).click();
    expect(await label('sql-result-compare-page-label-0')).toBe('page 15 of 21');
    await saveScreenshot(driver, 'compare-window-difference');
  }, 60_000);

  it('goes back to the loaded pages, where a cut-short side leaves one-sided rows unresolved', async () => {
    await driver.locator(byTestId('sql-result-compare-window-clear-0')).click();
    await driver.waitForSelector(byTestId('sql-result-compare-window-run-0'));
    expect(await driver.locator(byTestId('sql-result-compare-window-summary-0')).count()).toBe(0);
  }, 60_000);
});
