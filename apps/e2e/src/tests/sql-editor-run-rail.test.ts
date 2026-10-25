/**
 * The run rail left of the SQL editor, in a real browser.
 *
 * #542 moved each statement's ▶ and run checkbox from the strip under the
 * editor into this rail and dropped what the strip said about each statement:
 * its In [n] number, Safe mode's warning on a write with no WHERE, selecting a
 * statement, and copying it with its values. Two statements on one line also
 * drew their controls on top of each other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const SQL = 'UPDATE t SET a = 1 WHERE id = 1;\nDELETE FROM t;\nSELECT 1; SELECT 2;\n';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

describe('SQL Editor · run rail', () => {
  let driver: Page;
  let sql: SqlEditorPage;

  beforeAll(async () => {
    driver = await buildDriver();
    sql = new SqlEditorPage(driver);
    await new AppPage(driver).open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector(byTestId('toolbar'));
    await sql.openView();
    await sql.waitForMonaco();
    await driver.locator('.monaco-editor').first().click();
    await driver.keyboard.press(`${mod}+KeyA`);
    await driver.keyboard.insertText(SQL);
    await driver.waitForSelector(byTestId('sql-statement-label-3'), { timeout: 15_000 });
  }, 180_000);

  afterAll(async () => {
    if (driver) await quitDriver(driver);
  });

  it('numbers each statement and marks the writes Safe mode will confirm', async () => {
    const label = (i: number) => driver.locator(byTestId(`sql-statement-label-${i}`));
    expect(await label(0).innerText()).toBe('1');
    expect(await label(0).getAttribute('data-dml')).toBe('UPD');
    expect(await label(1).innerText()).toBe('2!');
    expect(await label(1).getAttribute('data-dml')).toBe('DEL!');
    expect(await label(1).getAttribute('title')).toMatch(/no WHERE — may affect all rows/);
    expect(await label(1).evaluate((el) => getComputedStyle(el).color)).not.toBe(
      await label(2).evaluate((el) => getComputedStyle(el).color)
    );
    expect(await label(2).getAttribute('data-dml')).toBeNull();
    await saveScreenshot(driver, 'run-rail-labels');
  });

  it('gives two statements on one line a row each, both clickable', async () => {
    const box = async (i: number) => (await driver.locator(byTestId(`sql-statement-include-${i}`)).boundingBox())!;
    const [a, b] = [await box(2), await box(3)];
    expect(b.y - a.y).toBeGreaterThanOrEqual(14);
    await driver.locator(byTestId('sql-statement-include-2')).click();
    expect(await driver.locator(byTestId('sql-statement-include-2')).isChecked()).toBe(true);
    expect(await driver.locator(byTestId('sql-statement-include-3')).isChecked()).toBe(false);
    await driver.locator(byTestId('sql-statement-include-2')).click();
  });

  it('selects a statement when its number is clicked, so Run runs that one', async () => {
    await driver.locator(byTestId('sql-statement-label-1')).click();
    await expect.poll(() => driver.locator(byTestId('sql-run-btn')).innerText(), { timeout: 5_000 }).toMatch(/Run selection/);
  });

  it('copies a statement from its row', async () => {
    await driver.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await driver.locator(byTestId('sql-statement-label-1')).hover();
    await driver.locator(byTestId('sql-statement-copy-1')).click();
    await expect.poll(() => driver.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 }).toBe('DELETE FROM t;');
    await saveScreenshot(driver, 'run-rail-copied');
  });
});
