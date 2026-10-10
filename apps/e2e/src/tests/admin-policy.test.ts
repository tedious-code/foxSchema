/**
 * One admin or several, in a real browser against the running server.
 *
 * The suites share one dev database, so this never changes who the admins
 * are: it reads the policy the server holds, checks the App users tab shows
 * it, and exercises the refusal paths with a throwaway account it makes and
 * deactivates. The hand-over itself (Make admin) would demote the suites'
 * admin, so it is covered by the unit and component tests instead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, clickWhen, waitFor, BASE_URL } from '../helpers/driver.js';
import { sessionCookie } from '../helpers/app-session.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';
const EMAIL = `e2e-policy-${Date.now().toString(36)}@foxschema.test`;

let admin = '';
let driver: Page;
let userId = '';
let policy: { adminPolicy: 'one' | 'several'; source: string | null; activeAdmins: string[] };

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: admin },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function openAppUsers(): Promise<void> {
  // A fresh load each time, so every test reads what the server holds now.
  await driver.goto(BASE_URL);
  await clickWhen(driver, byTestId('profile-menu-trigger'));
  await clickWhen(driver, byTestId('profile-access-control'));
  await waitFor(driver, byTestId('admin-policy'), 15_000);
}

beforeAll(async () => {
  admin = await sessionCookie();
  const read = await api('GET', '/admin/policy');
  expect(read.status, JSON.stringify(read.json)).toBe(200);
  policy = read.json;
  const added = await api('POST', '/admin/users', { email: EMAIL, role: 'viewer' });
  expect(added.status, JSON.stringify(added.json)).toBe(200);
  userId = added.json.user.id;
  driver = await buildDriver();
}, 120_000);

afterAll(async () => {
  if (driver) await quitDriver(driver);
  if (userId) await api('PUT', `/admin/users/${userId}/active`, { active: false });
});

describe('one admin or several', () => {
  it('the App users tab shows the policy the server holds', async () => {
    await openAppUsers();
    const selected = await driver.locator(byTestId('admin-policy')).locator('[aria-checked="true"]').innerText();
    expect(selected.trim().toLowerCase()).toBe(policy.adminPolicy);
    const hint = await driver.locator(byTestId('admin-policy-hint')).innerText();
    expect(hint).toMatch(policy.adminPolicy === 'one' ? /only one account can be admin/i : /any admin can make/i);
    await saveScreenshot(driver, 'admin-policy-users-tab');
  });

  it(
    'with several admins active, switching to one is refused and names them (skipped unless the server has several)',
    async (ctx) => {
      if (policy.adminPolicy !== 'several' || policy.activeAdmins.length < 2) ctx.skip();
      await openAppUsers();
      await clickWhen(driver, byTestId('admin-policy-one'));
      const banner = driver.getByText(/active admins \(/);
      await banner.waitFor({ timeout: 10_000 });
      expect(await banner.innerText()).toContain(policy.activeAdmins[0]!);
      // Still several, on the server and on screen.
      expect((await api('GET', '/admin/policy')).json.adminPolicy).toBe('several');
      expect(await driver.locator(byTestId('admin-policy-several')).getAttribute('aria-checked')).toBe('true');
      await saveScreenshot(driver, 'admin-policy-switch-refused');
    }
  );

  it(
    'with several, a non-admin can be offered the admin role and there is no hand-over (skipped under one)',
    async (ctx) => {
      if (policy.adminPolicy !== 'several') ctx.skip();
      await openAppUsers();
      const option = driver.locator(`${byTestId(`admin-user-role-${userId}`)} option[value="admin"]`);
      expect(await option.isDisabled()).toBe(false);
      expect(await driver.locator(byTestId(`admin-transfer-admin-${userId}`)).count()).toBe(0);
    }
  );

  it(
    'with one, promoting is refused by the server and the screen offers Make admin instead (skipped under several)',
    async (ctx) => {
      if (policy.adminPolicy !== 'one') ctx.skip();
      const promoted = await api('PUT', `/admin/users/${userId}/role`, { role: 'admin' });
      expect(promoted.status).toBe(409);
      expect(promoted.json.error?.message ?? JSON.stringify(promoted.json)).toMatch(/allows one admin/i);
      await openAppUsers();
      const option = driver.locator(`${byTestId(`admin-user-role-${userId}`)} option[value="admin"]`);
      expect(await option.isDisabled()).toBe(true);
      await waitFor(driver, byTestId(`admin-transfer-admin-${userId}`), 10_000);
      await saveScreenshot(driver, 'admin-policy-one-make-admin');
    }
  );
});
