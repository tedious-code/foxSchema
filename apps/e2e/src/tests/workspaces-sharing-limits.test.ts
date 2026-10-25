/**
 * Sharing a workspace lends no more than the sharer holds, and an archived
 * workspace can come back — in a real browser against the running server.
 *
 * A personal workspace's account runs who is in it whatever its own role, so
 * before the ceiling a viewer account could invite a colleague as owner, and
 * the colleague got DDL, DML and GRANT on the viewer's saved connections.
 *
 * Runs as the suites' admin plus two throwaway viewer accounts, and leaves the
 * admin in its own workspace, where the other suites expect it.
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
const SHARER_EMAIL = `e2e-wssharer-${RUN}@foxschema.test`;
const PEER_EMAIL = `e2e-wspeer-${RUN}@foxschema.test`;

let admin = '';
let adminPersonalId = '';
let sharer = { id: '', cookie: '' };
let peer = { id: '', cookie: '' };
const created: string[] = [];
const pages: Page[] = [];

async function api(method: string, path: string, body?: unknown, cookie = admin) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

/** A viewer account, signed in: its id and session cookie. */
async function viewerAccount(email: string): Promise<{ id: string; cookie: string }> {
  const password = `ws-${randomBytes(8).toString('hex')}`;
  const added = await api('POST', '/admin/users', { email, password, role: 'viewer' });
  expect(added.status, JSON.stringify(added.json)).toBe(200);
  const login = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  return { id: added.json.user.id, cookie: (login.headers.get('set-cookie') ?? '').split(';')[0]! };
}

/** A browser signed in with `cookie`, past onboarding. */
async function browserFor(cookie: string): Promise<Page> {
  const page = await buildDriver({ signedIn: false });
  pages.push(page);
  const [name, ...rest] = cookie.split('=');
  await page.context().addCookies([{ name: name!, value: rest.join('='), url: BASE_URL }]);
  await page.goto(BASE_URL);
  await page.waitForSelector(`${byTestId('onboarding-skip')}, ${byTestId('profile-menu-trigger')}`, { timeout: 30_000 });
  const skip = page.locator(byTestId('onboarding-skip'));
  if (await skip.count()) await skip.click();
  return page;
}

beforeAll(async () => {
  admin = await sessionCookie();
  const list = await api('GET', '/workspaces');
  expect(list.status, JSON.stringify(list.json)).toBe(200);
  adminPersonalId = list.json.workspaces.find((w: { personal: boolean }) => w.personal).id;
  await api('POST', `/workspaces/${adminPersonalId}/select`, {});
  sharer = await viewerAccount(SHARER_EMAIL);
  peer = await viewerAccount(PEER_EMAIL);
}, 120_000);

afterAll(async () => {
  for (const page of pages) await quitDriver(page);
  for (const id of [sharer.id, peer.id]) if (id) await api('PUT', `/admin/users/${id}/active`, { active: false });
  for (const id of created) await api('POST', `/workspaces/${id}/archive`, {});
  await api('POST', `/workspaces/${adminPersonalId}/select`, {});
});

describe('workspace sharing limits', () => {
  it('a viewer sharing its own workspace is offered viewer, and the server refuses more', async () => {
    const own = (await api('GET', '/workspaces', undefined, sharer.cookie)).json.workspaces.find(
      (w: { personal: boolean }) => w.personal
    );
    expect(own.role).toBe('viewer');

    // The settings dialog offers what the server will accept, and says why.
    const page = await browserFor(sharer.cookie);
    await clickWhen(page, byTestId('workspace-rail-btn'));
    await clickWhen(page, byTestId('workspace-menu-settings'));
    await waitFor(page, byTestId('workspace-invite-role'), 15_000);
    const offered = await page.evaluate(() =>
      [...(document.querySelector('[data-testid="workspace-invite-role"]') as HTMLSelectElement).options].map((o) => [
        o.value,
        !o.disabled,
      ])
    );
    expect(offered).toEqual([
      ['viewer', true],
      ['editor', false],
      ['owner', false],
    ]);
    expect(await page.locator(byTestId('workspace-invite-ceiling')).innerText()).toMatch(/up to viewer/);
    await saveScreenshot(page, 'workspaces-sharing-ceiling');

    // The server refuses the same, whatever the client sends.
    for (const role of ['owner', 'editor']) {
      const refused = await api('POST', `/workspaces/${own.id}/invites`, { email: PEER_EMAIL, role }, sharer.cookie);
      expect(refused.status, `${role}: ${JSON.stringify(refused.json)}`).toBe(403);
    }
    const sent = await api('POST', `/workspaces/${own.id}/invites`, { email: PEER_EMAIL, role: 'viewer' }, sharer.cookie);
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);

    // The colleague joins as a viewer and acts as one: it can read, not write.
    const accepted = await api('POST', `/workspaces/invites/${sent.json.invite.id}/accept`, {}, peer.cookie);
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect((await api('POST', `/workspaces/${own.id}/select`, {}, peer.cookie)).status).toBe(200);
    const me = (await api('GET', '/auth/me', undefined, peer.cookie)).json;
    expect(me.workspace).toMatchObject({ id: own.id, role: 'viewer' });
    for (const p of ['editor.dml', 'editor.ddl', 'editor.grant', 'schema.migrate']) {
      expect(me.user.permissions, p).not.toContain(p);
    }

    // Nor can the sharer raise it afterwards.
    const raised = await api('PUT', `/workspaces/${own.id}/members/${peer.id}`, { role: 'owner' }, sharer.cookie);
    expect(raised.status, JSON.stringify(raised.json)).toBe(403);
  }, 120_000);

  it('an admin restores an archived workspace from Access control', async () => {
    const made = await api('POST', '/workspaces', { name: `e2e-restore-${RUN}` });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = made.json.workspace.id as string;
    created.push(id);
    expect((await api('POST', `/workspaces/${id}/archive`, {})).status).toBe(200);
    expect((await api('GET', '/workspaces')).json.workspaces.some((w: { id: string }) => w.id === id)).toBe(false);

    const page = await buildDriver();
    pages.push(page);
    await page.goto(BASE_URL);
    await clickWhen(page, byTestId('profile-menu-trigger'));
    await clickWhen(page, byTestId('profile-access-control'));
    await clickWhen(page, byTestId('admin-tab-workspaces'));
    await clickWhen(page, byTestId('admin-workspaces-show-archived'));
    await clickWhen(page, byTestId(`admin-workspace-restore-${id}`));
    // Back: the row offers Members again instead of Restore.
    await waitFor(page, byTestId(`admin-workspace-members-${id}`), 15_000);
    expect(await page.locator(byTestId(`admin-workspace-restore-${id}`)).count()).toBe(0);
    await saveScreenshot(page, 'workspaces-admin-restored');

    expect((await api('GET', '/workspaces')).json.workspaces.find((w: { id: string }) => w.id === id)).toMatchObject({
      role: 'owner',
    });
  }, 120_000);
});
