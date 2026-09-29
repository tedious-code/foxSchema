/**
 * Invite → sign up → forgot password → reset → sign in, in a real browser.
 *
 * The admin side goes through the API as the suites' admin account; the
 * person being invited uses signed-out browsers, as they would. Each run makes
 * its own throwaway account and deactivates it at the end. Email is not set
 * up on a dev install, so codes come back to the admin who issued them, which
 * is how an admin passes one on by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, BASE_URL } from '../helpers/driver.js';
import { sessionCookie } from '../helpers/app-session.js';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';
const EMAIL = `e2e-invite-${Date.now()}@foxschema.test`;
const FIRST_PASSWORD = `first-${randomBytes(6).toString('hex')}`;
const SECOND_PASSWORD = `second-${randomBytes(6).toString('hex')}`;

let admin = '';
let userId = '';
const pages: Page[] = [];

async function api(method: string, path: string, body?: unknown, cookie = admin) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function signedOutPage(): Promise<Page> {
  const page = await buildDriver({ signedIn: false });
  pages.push(page);
  return page;
}

/** Past the sign-in pages: the onboarding wizard (first sign-in) or the workspace. */
async function expectSignedIn(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="onboarding-skip"], [data-testid="toolbar"]', { timeout: 20_000 });
}

beforeAll(async () => {
  admin = await sessionCookie();
}, 60_000);

afterAll(async () => {
  for (const page of pages) await quitDriver(page);
  if (userId) await api('PUT', `/admin/users/${userId}/active`, { active: false });
});

describe('invite, forgot password and reset', () => {
  it('an invited person signs up from the link and chooses their own password', async () => {
    const invited = await api('POST', '/admin/users', { email: EMAIL, role: 'viewer' });
    expect(invited.status, JSON.stringify(invited.json)).toBe(200);
    userId = invited.json.user.id;
    const code = invited.json.invite.code as string;

    const page = await signedOutPage();
    await page.goto(`${BASE_URL}/#invite=${code}`);
    await page.waitForSelector('[data-testid="auth-redeem-form"]', { timeout: 15_000 });
    // The code is taken off the address bar once read.
    expect(new URL(page.url()).hash).toBe('');
    expect(await page.inputValue('#auth-redeem-email')).toBe(EMAIL);

    await page.fill('#auth-new-password', FIRST_PASSWORD);
    await page.fill('#auth-confirm', FIRST_PASSWORD);
    await page.click('[data-testid="auth-redeem-form"] button[type="submit"]');
    await expectSignedIn(page);

    // The invite works once.
    expect((await api('POST', '/auth/password/code', { code }, '')).status).toBe(404);
  });

  it('forgot password answers without saying whether the account exists', async () => {
    const page = await signedOutPage();
    await page.goto(BASE_URL);
    await page.waitForSelector('[data-testid="auth-login-form"]');
    await page.fill('#auth-email', EMAIL);
    await page.click('[data-testid="auth-forgot-link"]');
    expect(await page.inputValue('#auth-forgot-email')).toBe(EMAIL);
    await page.click('[data-testid="auth-forgot-form"] button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-forgot-sent"]');
    expect(await page.textContent('[data-testid="auth-forgot-sent"]')).toContain(`If ${EMAIL} has an account`);
  });

  it('a reset code sets a new password; the old one stops working', async () => {
    const issued = await api('POST', `/admin/users/${userId}/code`, {});
    expect(issued.json.purpose).toBe('reset');

    const page = await signedOutPage();
    await page.goto(BASE_URL);
    await page.click('[data-testid="auth-have-code"]');
    await page.fill('#auth-code', issued.json.code);
    await page.click('[data-testid="auth-code-form"] button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-redeem-form"]');
    await page.fill('#auth-new-password', SECOND_PASSWORD);
    await page.fill('#auth-confirm', SECOND_PASSWORD);
    await page.click('[data-testid="auth-redeem-form"] button[type="submit"]');
    await expectSignedIn(page);

    expect((await api('POST', '/auth/login', { email: EMAIL, password: FIRST_PASSWORD }, '')).status).toBe(401);
    expect((await api('POST', '/auth/login', { email: EMAIL, password: SECOND_PASSWORD }, '')).status).toBe(200);
  });

  it('signs in with the new password on the sign-in page', async () => {
    const page = await signedOutPage();
    await page.goto(BASE_URL);
    await page.fill('#auth-email', EMAIL);
    await page.fill('#auth-password', SECOND_PASSWORD);
    await page.click('[data-testid="auth-login-form"] button[type="submit"]');
    await expectSignedIn(page);
  });
});
