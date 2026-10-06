/**
 * Send feedback, in a real browser.
 *
 * The dialog is unit-tested; this checks the path a reader takes: the profile
 * menu opens it (its code loaded on that first click), and "Open on GitHub"
 * opens one new tab on the public repo's new-issue page, filled in with what
 * was typed. `window.open` is replaced before the app loads so nothing reaches
 * github.com — the URL is what is under test, not GitHub.
 *
 * Needs only the web app + API (`npm run dev`); no database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, clickWhen, waitFor } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';

declare global {
  interface Window {
    __opened?: Array<{ url: string; target: string; features: string }>;
  }
}

describe('Send feedback', () => {
  let driver: Page;

  beforeAll(async () => {
    driver = await buildDriver();
    await driver.addInitScript(() => {
      window.__opened = [];
      window.open = ((url?: string | URL, target?: string, features?: string) => {
        window.__opened!.push({ url: String(url ?? ''), target: target ?? '', features: features ?? '' });
        return null;
      }) as typeof window.open;
    });
    await new AppPage(driver).open();
  }, 120_000);

  afterAll(async () => {
    if (driver) await quitDriver(driver);
  });

  it('opens from the profile menu and sends a pre-filled issue to GitHub in a new tab', async () => {
    await clickWhen(driver, byTestId('profile-menu-trigger'));
    await clickWhen(driver, byTestId('profile-send-feedback'));
    await waitFor(driver, byTestId('feedback-dialog'), 15_000);

    // The details it would add are on screen before anything is sent.
    const details = await driver.locator(byTestId('feedback-details')).innerText();
    expect(details).toMatch(/Fox Schema: \d+\.\d+\.\d+/);
    expect(details).toMatch(/Browser: .*Chrome/);

    await driver.locator(byTestId('feedback-kind-bug')).click();
    await driver.locator(byTestId('feedback-title')).fill('E2E feedback check');
    await driver.locator(byTestId('feedback-description')).fill('Typed in the e2e suite.\nSecond line & a #hash');
    await driver.locator(byTestId('feedback-open-github')).click();

    const opened = await driver.evaluate(() => window.__opened ?? []);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.target).toBe('_blank');
    const url = new URL(opened[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/tedious-code/foxSchema/issues/new');
    expect(url.searchParams.get('title')).toBe('[Bug] E2E feedback check');
    expect(url.searchParams.get('body')).toContain('Typed in the e2e suite.\nSecond line & a #hash');
    expect(url.searchParams.get('body')).toContain('App details');
    expect(await driver.locator(byTestId('feedback-sent')).count()).toBe(1);

    await driver.locator(byTestId('feedback-close')).click();
    expect(await driver.locator(byTestId('feedback-dialog')).count()).toBe(0);
  });
});
