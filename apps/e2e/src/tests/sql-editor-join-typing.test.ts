/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Type a LEFT OUTER JOIN the way a person does, and check the popup at the
 * spots that used to go quiet: after LEFT, after JOIN, and after `=`.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

let driver: Page;
let app: AppPage;
let sql: SqlEditorPage;
const pageErrors: string[] = [];

async function suggestText(): Promise<string> {
  const widget = driver.locator('.suggest-widget').last();
  const visible = await widget.isVisible().catch(() => false);
  if (!visible) return '';
  return (await widget.innerText()).replace(/\s+/g, ' ');
}

/** Type one character at a time. A space or dot can accept a suggestion, so dismiss first. */
async function typeLiteral(text: string): Promise<void> {
  for (const ch of text) {
    if (ch === ' ' || ch === '.') await driver.keyboard.press('Escape');
    await driver.keyboard.type(ch, { delay: 12 });
  }
}

beforeAll(async () => {
  driver = await buildDriver();
  driver.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  driver.on('pageerror', (err) => pageErrors.push(String(err)));
  app = new AppPage(driver);
  sql = new SqlEditorPage(driver);
  await app.open();
  await sql.resetPersistedEditorState();
  await driver.reload();
  await driver.waitForSelector('[data-testid="toolbar"]');
  await sql.openView();
}, 120_000);

afterAll(async () => {
  await quitDriver(driver);
});

describe('typing a LEFT OUTER JOIN', () => {
  it('keeps JOIN, tables, and alias columns available, and does not ask for a password', async () => {
    await sql.dismissOverlays();
    const editor = driver.locator('.monaco-editor').first();
    await editor.click();
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await driver.keyboard.press(`${mod}+KeyA`);
    await driver.keyboard.press('Backspace');

    const autocomplete = await driver
      .locator('.monaco-editor textarea')
      .first()
      .getAttribute('autocomplete');
    expect(autocomplete).toBe('one-time-code');

    await typeLiteral('SELECT c.id, oc.coupon_id FROM demo_a.order_coupons oc left ');
    await driver.waitForTimeout(500);
    const afterLeft = await suggestText();
    const soFar = (await sql.editorText()).replace(/\s+/g, ' ');
    expect(
      afterLeft.toUpperCase(),
      `editor: ${soFar} errors: ${pageErrors.slice(0, 4).join(' | ')}`
    ).toMatch(/JOIN/);
    expect(afterLeft.toUpperCase()).toMatch(/OUTER/);
    await driver.keyboard.press('Escape');

    await typeLiteral('outer join ');
    await driver.waitForTimeout(500);
    const afterJoin = await suggestText();
    expect(afterJoin.length, 'no suggestions after JOIN').toBeGreaterThan(0);
    await driver.keyboard.press('Escape');

    await typeLiteral('demo_a.coupons c on c.id = ');
    await driver.waitForTimeout(500);
    const afterEq = (await suggestText()).toLowerCase();
    expect(afterEq, 'no suggestions after =').toMatch(/c\.|oc\.|id|count/);
    await driver.keyboard.press('Escape');

    await typeLiteral('oc.coupon_id;');
    await driver.keyboard.press('Escape');
    await driver.waitForTimeout(500);

    const text = (await sql.editorText()).replace(/\s+/g, ' ').toLowerCase();
    expect(text).toContain('from demo_a.order_coupons oc');
    expect(text).toContain('left outer join demo_a.coupons c');
    expect(text).toContain('on c.id = oc.coupon_id');
    expect(await driver.getByText('AutoFill for').count()).toBe(0);
  });
});
