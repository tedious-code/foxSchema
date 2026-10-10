/**
 * Workspaces in a real browser against the running server.
 *
 * Runs as the suites' admin and always puts it back in its own workspace at
 * the end: the other suites read that account's saved connections, and a
 * leftover "current workspace" would hide every one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
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
const pages: Page[] = [];
const GUEST_EMAIL = `e2e-wsguest-${RUN}@foxschema.test`;
const GUEST_PASSWORD = `guest-${randomBytes(8).toString('hex')}`;
let guestId = '';
let sharedConnectionId = '';
let guestCookie = '';
const WALKER_EMAIL = `e2e-wswalker-${RUN}@foxschema.test`;
let walkerId = '';

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
  for (const page of pages) await quitDriver(page);
  if (guestId) await api('PUT', `/admin/users/${guestId}/active`, { active: false });
  if (walkerId) await api('PUT', `/admin/users/${walkerId}/active`, { active: false });
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
    sharedConnectionId = saved.json.connection.id;

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

  it('an invited account accepts from its own menu, joins with the invited role, and sees the shared connection', async () => {
    const teamId = created[0]!;
    const added = await api('POST', '/admin/users', { email: GUEST_EMAIL, password: GUEST_PASSWORD, role: 'viewer' });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    guestId = added.json.user.id;

    // The owner invites through Workspace settings.
    await api('POST', `/workspaces/${teamId}/select`, {});
    await openMenu();
    await clickWhen(driver, byTestId('workspace-menu-settings'));
    await driver.fill(byTestId('workspace-invite-email'), GUEST_EMAIL);
    await driver.selectOption(byTestId('workspace-invite-role'), 'editor');
    await clickWhen(driver, byTestId('workspace-invite-submit'));
    await waitFor(driver, `${byTestId('workspace-invites')} li`, 10_000);
    await saveScreenshot(driver, 'workspaces-invite-pending');
    await api('POST', `/workspaces/${personalId}/select`, {});

    // Not a member until it accepts.
    const login = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: GUEST_EMAIL, password: GUEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
    guestCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await api('POST', `/workspaces/${teamId}/select`, {}, guestCookie)).status).toBe(404);

    const guest = await buildDriver({ signedIn: false });
    pages.push(guest);
    const [name, ...rest] = guestCookie.split('=');
    await guest.context().addCookies([{ name: name!, value: rest.join('='), url: BASE_URL }]);
    await guest.goto(BASE_URL);
    // A first sign-in shows onboarding: wait for it or the app, and skip it.
    await guest.waitForSelector(`${byTestId('onboarding-skip')}, ${byTestId('profile-menu-trigger')}`, { timeout: 30_000 });
    const skip = guest.locator(byTestId('onboarding-skip'));
    if (await skip.count()) await skip.click();
    await clickWhen(guest, byTestId('profile-menu-trigger'));
    const inviteRow = guest.locator(`${byTestId('workspace-menu-invites')} [data-testid^="workspace-menu-invite-accept-"]`);
    await inviteRow.waitFor({ timeout: 15_000 });
    await saveScreenshot(guest, 'workspaces-invite-received');
    await Promise.all([guest.waitForEvent('load'), inviteRow.click()]);

    const mine = await api('GET', '/workspaces', undefined, guestCookie);
    expect(mine.json.currentId).toBe(teamId);
    expect(mine.json.workspaces.find((w: { id: string }) => w.id === teamId).role).toBe('editor');
    const conns = (await api('GET', '/connections', undefined, guestCookie)).json.connections.map((c: { id: string }) => c.id);
    expect(conns).toContain(sharedConnectionId);
  });

  it('an admin sees every workspace, opens one it is not in only by joining, and the members see it joined', async () => {
    const guestWs = (await api('GET', '/workspaces', undefined, guestCookie)).json.workspaces.find((w: { personal: boolean }) => w.personal);
    // Not a member yet: it cannot act there.
    expect((await api('POST', `/workspaces/${guestWs.id}/select`, {})).status).toBe(404);

    await driver.goto(BASE_URL);
    await clickWhen(driver, byTestId('profile-menu-trigger'));
    await clickWhen(driver, byTestId('profile-access-control'));
    await clickWhen(driver, byTestId('admin-tab-workspaces'));
    const row = byTestId(`admin-workspace-${guestWs.id}`);
    await waitFor(driver, row, 15_000);
    expect(await driver.locator(row).innerText()).toContain(`personal · ${GUEST_EMAIL}`);
    expect(await driver.locator(byTestId(`admin-workspace-open-${guestWs.id}`)).count()).toBe(0);
    await saveScreenshot(driver, 'workspaces-admin-tab');

    driver.once('dialog', (d) => void d.accept());
    await clickWhen(driver, byTestId(`admin-workspace-join-${guestWs.id}`));
    await waitFor(driver, byTestId(`admin-workspace-open-${guestWs.id}`), 10_000);
    const members = (await api('GET', `/workspaces/${guestWs.id}/members`, undefined, guestCookie)).json.members;
    expect(members.map((m: { email: string }) => m.email)).toContain('e2e-admin@foxschema.test');

    // Leave again; the guest's workspace is the guest's.
    const adminId = members.find((m: { email: string }) => m.email === 'e2e-admin@foxschema.test').userId;
    expect((await api('DELETE', `/workspaces/${guestWs.id}/members/${adminId}`, {})).status).toBe(200);
  });

  it('a public workspace is found and joined by anyone signed in, with its join role', async () => {
    const teamId = created[0]!;
    // The owner makes it public in its settings.
    await api('POST', `/workspaces/${teamId}/select`, {});
    await openMenu();
    await clickWhen(driver, byTestId('workspace-menu-settings'));
    driver.once('dialog', (d) => void d.accept());
    await driver.selectOption(byTestId('workspace-settings-visibility-select'), 'public');
    await waitFor(driver, byTestId('workspace-settings-join-role'), 10_000);
    expect(await driver.locator(byTestId('workspace-settings-join-role')).inputValue()).toBe('viewer');
    await saveScreenshot(driver, 'workspaces-public-settings');
    await api('POST', `/workspaces/${personalId}/select`, {});

    const password = `walk-${randomBytes(8).toString('hex')}`;
    const added = await api('POST', '/admin/users', { email: WALKER_EMAIL, password, role: 'editor' });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    walkerId = added.json.user.id;
    const login = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: WALKER_EMAIL, password }),
    });
    const walkerCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    const walker = await buildDriver({ signedIn: false });
    pages.push(walker);
    const [name, ...rest] = walkerCookie.split('=');
    await walker.context().addCookies([{ name: name!, value: rest.join('='), url: BASE_URL }]);
    await walker.goto(BASE_URL);
    await walker.waitForSelector(`${byTestId('onboarding-skip')}, ${byTestId('profile-menu-trigger')}`, { timeout: 30_000 });
    const skip = walker.locator(byTestId('onboarding-skip'));
    if (await skip.count()) await skip.click();
    await clickWhen(walker, byTestId('profile-menu-trigger'));
    await clickWhen(walker, byTestId('workspace-menu-browse'));
    await waitFor(walker, byTestId(`workspace-menu-public-${teamId}`), 10_000);
    await saveScreenshot(walker, 'workspaces-public-browse');
    await Promise.all([walker.waitForEvent('load'), clickWhen(walker, byTestId(`workspace-menu-public-join-${teamId}`))]);

    const me = await api('GET', '/auth/me', undefined, walkerCookie);
    expect(me.json.workspace).toMatchObject({ id: teamId, role: 'viewer' });
    // An editor account, but a viewer here: it reads the shared connection and cannot change schema.
    expect(me.json.user.permissions).not.toContain('editor.ddl');
    const conns = (await api('GET', '/connections', undefined, walkerCookie)).json.connections.map((c: { id: string }) => c.id);
    expect(conns).toContain(sharedConnectionId);

    // Back to private: the walker stays, nobody else finds it.
    expect((await api('PATCH', `/workspaces/${teamId}`, { visibility: 'private' })).status).toBe(200);
    expect((await api('GET', '/workspaces', undefined, walkerCookie)).json.workspaces.some((w: { id: string }) => w.id === teamId)).toBe(true);
    expect((await api('GET', '/workspaces/discover', undefined, guestCookie)).json.workspaces.some((w: { id: string }) => w.id === teamId)).toBe(false);
  });
});

