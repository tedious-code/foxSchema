import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { signInBrowser } from './app-session.js';

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

// Track which Browser owns each Page so quitDriver can close both.
const pageToBrowser = new Map<Page, Browser>();

/**
 * Launch a Chromium browser and return its first Page, signed in unless
 * `signedIn: false` (for the sign-in pages themselves). HEADLESS=false to watch.
 */
export async function buildDriver({ signedIn = true }: { signedIn?: boolean } = {}): Promise<Page> {
  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    // For machines whose preinstalled Chromium is not the build this
    // Playwright version downloads (CI images, cloud dev containers).
    ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  pageToBrowser.set(page, browser);
  // Every install requires sign-in; each suite's browser starts signed in.
  if (signedIn) await signInBrowser(page, BASE_URL);
  return page;
}

/** Close the page and the browser that owns it. Call this in afterAll instead of driver.quit(). */
export async function quitDriver(page: Page): Promise<void> {
  const browser = pageToBrowser.get(page);
  pageToBrowser.delete(page);
  await browser?.close();
}

/** Wait for a selector to appear in the DOM and return a Locator for it. */
export async function waitFor(page: Page, selector: string, timeoutMs = 10_000): Promise<Locator> {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  return page.locator(selector).first();
}

/** Click an element, waiting for it to be actionable first. */
export async function clickWhen(page: Page, selector: string): Promise<void> {
  await page.click(selector, { timeout: 15_000 });
}

/** Clear an input and type a new value. */
export async function fillInput(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value);
}
