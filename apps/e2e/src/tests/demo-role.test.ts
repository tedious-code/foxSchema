/**
 * A published demo, in a real browser against the running server.
 *
 * One shared login with the Demo role: a visitor reads the login off the
 * sign-in page, sees the demo banner, and queries the sample database an
 * admin put in its workspace. Saving anything is refused, by the server.
 *
 * Runs as the suites' admin plus one throwaway demo account, and turns demo
 * mode off again at the end, since every other suite shares this install.
 *
 * Requires the web app + API (`npm run dev`) and a `sqlite3` CLI on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, clickWhen, waitFor, BASE_URL } from '../helpers/driver.js';
import { sessionCookie } from '../helpers/app-session.js';
import { apiCall, signInAs } from '../helpers/accounts.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const RUN = Date.now().toString(36);
// Per-run directory: the backend pools SQLite handles by file path.
const DIR = `/tmp/foxschema-e2e-demo-${RUN}`;
const DB = join(DIR, 'sample.db');
const CONNECTION = `Demo sample ${RUN}`;
const DEMO_EMAIL = `e2e-demo-${RUN}@foxschema.test`;
const DEMO_PASSWORD = `try-fox-${randomBytes(6).toString('hex')}`;
const HINT = `Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`;

let admin = '';
let adminId = '';
let demoId = '';
let demoWorkspace = '';
let demoCookie = '';
const pages: Page[] = [];

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const api = (method: string, path: string, body?: unknown, cookie = admin, headers: Record<string, string> = {}) =>
  apiCall(method, path, body, cookie, headers);

describe.skipIf(!hasSqlite3())('a published demo', () => {
  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    execFileSync('sqlite3', [DB], {
      input: `CREATE TABLE planets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
              INSERT INTO planets VALUES (1, 'Mercury'), (2, 'Venus'), (3, 'Earth');`,
    });

    admin = await sessionCookie();
    adminId = (await api('GET', '/auth/me')).json.user.id;
    const made = await api('POST', '/admin/users', { email: DEMO_EMAIL, password: DEMO_PASSWORD, role: 'demo' });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    demoId = made.json.user.id;

    // The demo cannot add connections: an admin joins its workspace, adds the
    // sample database, and leaves — the path docs/DEPLOYMENT.md describes.
    demoCookie = await signInAs(DEMO_EMAIL, DEMO_PASSWORD);
    demoWorkspace = (await api('GET', '/workspaces', undefined, demoCookie)).json.currentId;
    expect((await api('PUT', `/workspaces/${demoWorkspace}/members/${adminId}`, { role: 'owner' })).status).toBe(200);
    const saved = await api(
      'POST',
      '/connections',
      { name: CONNECTION, dialect: 'sqlite', option: { database: DB } },
      admin,
      { 'x-fox-workspace': demoWorkspace }
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect((await api('DELETE', `/workspaces/${demoWorkspace}/members/${adminId}`, {})).status).toBe(200);

    expect((await api('PUT', '/admin/sign-in/demo', { on: true, hint: HINT })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    for (const page of pages) await quitDriver(page);
    await api('PUT', '/admin/sign-in/demo', { on: false, hint: '' });
    if (demoId) await api('PUT', `/admin/users/${demoId}/active`, { active: false });
    rmSync(DIR, { recursive: true, force: true });
  });

  it('the sign-in page says it is a demo and shows the login to use', async () => {
    const page = await buildDriver({ signedIn: false });
    pages.push(page);
    await page.goto(BASE_URL);
    await waitFor(page, byTestId('auth-demo-hint'), 30_000);
    expect(await page.locator(byTestId('auth-demo-hint')).innerText()).toContain(HINT);
    await saveScreenshot(page, 'demo-sign-in');

    // A visitor signs in with exactly what the page shows.
    await page.fill(byTestId('auth-login-email'), DEMO_EMAIL);
    await page.fill('#auth-password', DEMO_PASSWORD);
    await clickWhen(page, byTestId('auth-login-submit'));
    await page.waitForSelector(`${byTestId('onboarding-skip')}, ${byTestId('demo-banner')}`, { timeout: 30_000 });
    const skip = page.locator(byTestId('onboarding-skip'));
    if (await skip.count()) await skip.click();
    await waitFor(page, byTestId('demo-banner'), 15_000);
    expect(await page.locator(byTestId('demo-banner')).innerText()).toMatch(/Nothing here can be saved/);
    await saveScreenshot(page, 'demo-banner');
  }, 120_000);

  it('a visitor queries the sample database the admin set up', async () => {
    const page = pages[0]!;
    const sql = new SqlEditorPage(page);
    await sql.openView();
    await sql.checkConnection(CONNECTION);
    await sql.setSql('SELECT name FROM planets ORDER BY id;');
    await sql.run();
    await sql.waitForResults();
    const text = await sql.resultsText();
    for (const planet of ['Mercury', 'Venus', 'Earth']) expect(text).toContain(planet);
    await saveScreenshot(page, 'demo-query');
  }, 120_000);

  it('saving anything is refused, and the profile is locked', async () => {
    const refused = [
      await api('POST', '/connections', { name: 'mine', dialect: 'sqlite', option: { database: '/tmp/x.db' } }, demoCookie),
      await api('POST', '/workspaces', { name: 'mine' }, demoCookie),
      await api('POST', '/auth/sign-out-others', {}, demoCookie),
    ];
    for (const r of refused) {
      expect(r.status, JSON.stringify(r.json)).toBe(403);
      expect(r.json.error).toMatch(/read-only/);
    }
    // A write SQL statement is refused by the permissions the Demo role lacks.
    const conn = (await api('GET', '/connections', undefined, demoCookie)).json.connections.find(
      (c: { name: string }) => c.name === CONNECTION
    );
    const write = await api('POST', '/sql/execute', { connectionId: conn.id, statements: ['DELETE FROM planets'] }, demoCookie);
    expect(write.status, JSON.stringify(write.json)).toBe(403);
    expect(execFileSync('sqlite3', [DB, 'SELECT COUNT(*) FROM planets'], { encoding: 'utf8' }).trim()).toBe('3');

    // The browser offers no way to sign the other visitors out.
    const page = pages[0]!;
    await page.goto(BASE_URL);
    await clickWhen(page, byTestId('profile-menu-trigger'));
    await waitFor(page, byTestId('profile-sign-out'), 10_000);
    expect(await page.locator(byTestId('profile-sign-out-others')).count()).toBe(0);
  }, 120_000);
});
