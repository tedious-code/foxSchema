/**
 * Workspaces in a real browser against the running server.
 *
 * Runs as the suites' admin and always puts it back in its own workspace at
 * the end: the other suites read that account's saved connections, and a
 * leftover "current workspace" would hide every one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, clickWhen, waitFor, BASE_URL } from '../helpers/driver.js';
import { sessionCookie } from '../helpers/app-session.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';
const RUN = Date.now().toString(36);
const WS_NAME = `e2e-ws-${RUN}`;

let admin = '';
let driver: Page;
let personalId = '';
const created: string[] = [];

async function api(method: string, path: string, body?: unknown, cookie = admin) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function openMenu(): Promise<void> {
  await driver.goto(BASE_URL);
  await clickWhen(driver, byTestId('profile-menu-trigger'));
  await waitFor(driver, byTestId('workspace-menu'), 15_000);
}

beforeAll(async () => {
  admin = await sessionCookie();
  const list = await api('GET', '/workspaces');
  expect(list.status, JSON.stringify(list.json)).toBe(200);
  personalId = list.json.workspaces.find((w: { personal: boolean }) => w.personal).id;
  // Start where the other suites expect to be.
  await api('POST', `/workspaces/${personalId}/select`, {});
  driver = await buildDriver();
}, 120_000);

afterAll(async () => {
  if (driver) await quitDriver(driver);
  await api('POST', `/workspaces/${personalId}/select`, {});
  for (const id of created) await api('POST', `/workspaces/${id}/archive`, {});
});

describe('workspaces', () => {
  it('the profile menu shows the account’s own workspace as current', async () => {
    await openMenu();
    expect(await driver.locator(byTestId(`workspace-menu-item-${personalId}`)).getAttribute('aria-current')).toBe('true');
  });

  it('an admin creates a workspace from the menu and lands in it', async () => {
    await openMenu();
    await clickWhen(driver, byTestId('workspace-menu-create'));
    await driver.fill(byTestId('workspace-menu-create-name'), WS_NAME);
    await Promise.all([driver.waitForEvent('load'), clickWhen(driver, byTestId('workspace-menu-create-submit'))]);
    const list = await api('GET', '/workspaces');
    const ws = list.json.workspaces.find((w: { name: string }) => w.name === WS_NAME);
    expect(ws, JSON.stringify(list.json)).toBeTruthy();
    created.push(ws.id);
    expect(list.json.currentId).toBe(ws.id);
    await openMenu();
    expect(await driver.locator(byTestId(`workspace-menu-item-${ws.id}`)).getAttribute('aria-current')).toBe('true');
    await saveScreenshot(driver, 'workspaces-menu-new-current');
  });

  it('a connection saved in a workspace stays out of the others', async () => {
    const saved = await api('POST', '/connections', {
      name: `e2e-ws-conn-${RUN}`,
      dialect: 'sqlite',
      option: { database: `/tmp/e2e-ws-${RUN}.db` },
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const inTeam = (await api('GET', '/connections')).json.connections.map((c: { id: string }) => c.id);
    expect(inTeam).toEqual([saved.json.connection.id]);

    await api('POST', `/workspaces/${personalId}/select`, {});
    const inPersonal = (await api('GET', '/connections')).json.connections.map((c: { id: string }) => c.id);
    expect(inPersonal).not.toContain(saved.json.connection.id);
    expect(inPersonal.length).toBeGreaterThan(0);
  });

  it('workspace settings rename it and show its members', async () => {
    const id = created[0]!;
    await api('POST', `/workspaces/${id}/select`, {});
    await openMenu();
    await clickWhen(driver, byTestId('workspace-menu-settings'));
    await waitFor(driver, byTestId('workspace-settings-members'), 10_000);
    await driver.fill(byTestId('workspace-settings-name'), `${WS_NAME} renamed`);
    await clickWhen(driver, byTestId('workspace-settings-rename-submit'));
    await waitFor(driver, byTestId('workspace-settings-saved'), 10_000);
    expect((await api('GET', '/workspaces')).json.workspaces.find((w: { id: string }) => w.id === id).name).toBe(`${WS_NAME} renamed`);
    expect(await driver.locator(`${byTestId('workspace-settings-members')} li`).count()).toBe(1);
    await saveScreenshot(driver, 'workspaces-settings');
  });

  it('another account cannot open the workspace by id', async () => {
    const res = await api('POST', `/workspaces/${created[0]}/select`, {}, '');
    expect(res.status).toBe(401);
    // Signed in but not a member is covered by the server tests; the id answers 404 there.
  });
});
