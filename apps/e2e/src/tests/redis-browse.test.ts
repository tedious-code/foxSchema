/**
 * Redis in the SQL editor, in a real browser against the running server.
 *
 * Three things were broken here, and this suite is what they look like fixed:
 *
 * - the schema explorer listed nothing ("No provider registered for dialect:
 *   redis"), so no key was browsable at all;
 * - every SELECT failed with "Paging failed … Unsupported clause", because the
 *   editor nested it in a page wrapper the Redis translator cannot read;
 * - a list, set, sorted set or stream read as `{ id, type }` only, and a JSON
 *   document as one `value` holding the whole text.
 *
 * Seeds its own keys under a per-run prefix in the dev container's Redis and
 * removes them afterwards. Skips when that container is not reachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, waitFor, BASE_URL } from '../helpers/driver.js';
import { sessionCookie } from '../helpers/app-session.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';
const RUN = Date.now().toString(36);
const P = `e2e${RUN}`;
const NAME = `E2E Redis ${RUN}`;
const KEYS = {
  users: `${P}-users`,
  docs: `${P}-docs`,
  jobs: `${P}-jobs`,
  board: `${P}-board`,
};

function redis(...args: string[]): string {
  return execFileSync('docker', ['exec', '-i', 'foxschema-redis', 'redis-cli', ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function redisReachable(): boolean {
  try {
    return redis('PING').trim() === 'PONG';
  } catch {
    return false;
  }
}

describe.skipIf(!redisReachable())('SQL Editor · Redis keys as tables', () => {
  let admin = '';
  let connectionId = '';
  let driver: Page;
  let sql: SqlEditorPage;

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: admin },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  beforeAll(async () => {
    redis('HSET', `${KEYS.users}:1`, 'name', 'Ana', 'plan', 'free');
    redis('HSET', `${KEYS.users}:2`, 'name', 'Bo', 'plan', 'pro');
    redis('SET', `${KEYS.docs}:a`, JSON.stringify({ title: 'Hello', meta: { v: 1 } }));
    redis('RPUSH', KEYS.jobs, JSON.stringify({ job: 'send', to: 'ana@x' }), JSON.stringify({ job: 'bill', to: 'bo@x' }));
    redis('ZADD', KEYS.board, '20', 'bo', '10', 'al');

    admin = await sessionCookie();
    const saved = await api('POST', '/connections', {
      name: NAME,
      dialect: 'redis',
      option: { host: '127.0.0.1', port: 6379, schema: '0' },
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    connectionId = saved.json.connection.id;

    driver = await buildDriver();
    sql = new SqlEditorPage(driver);
    await new AppPage(driver).open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector(byTestId('toolbar'));
    await sql.openView();
    await sql.checkConnection(NAME);
  }, 180_000);

  afterAll(async () => {
    if (driver) await quitDriver(driver);
    if (connectionId) await api('DELETE', `/connections/${connectionId}`);
    for (const key of [`${KEYS.users}:1`, `${KEYS.users}:2`, `${KEYS.docs}:a`, KEYS.jobs, KEYS.board]) {
      redis('DEL', key);
    }
  });

  it('the schema explorer lists prefixes and collection keys, each with its type', async () => {
    await sql.ensureSidebarSectionOpen('schema');
    for (const [name, type] of [
      [`${KEYS.users}`, 'hash'],
      [`${KEYS.docs}`, 'json'],
      [KEYS.jobs, 'list'],
      [KEYS.board, 'zset'],
    ] as const) {
      const badge = byTestId(`sql-explorer-store-type-${name}`);
      await waitFor(driver, badge, 30_000);
      expect((await driver.locator(badge).innerText()).toLowerCase()).toBe(type);
    }
    // A key has no DDL: no table blueprint for any of them, and no New table.
    expect(await driver.locator(`${byTestId('sql-schema-explorer')} ${byTestId('sql-open-blueprint')}`).count()).toBe(0);
    expect(await driver.locator(byTestId('sql-schema-new-table')).count()).toBe(0);
    await saveScreenshot(driver, 'redis-explorer');
  }, 120_000);

  it('a SELECT on a list key runs and shows its elements as rows', async () => {
    await sql.setSql(`SELECT * FROM "${KEYS.jobs}";`);
    await sql.run();
    await sql.waitForResults();
    const text = await sql.resultsText();
    expect(text).not.toMatch(/Paging failed|Unsupported clause/);
    for (const cell of ['send', 'bill', 'ana@x', 'bo@x']) expect(text).toContain(cell);
    await saveScreenshot(driver, 'redis-list-select');
  }, 120_000);

  it('a JSON document reads as its fields, and a sorted set by score', async () => {
    await sql.setSql(`SELECT * FROM ${KEYS.docs};`);
    await sql.run();
    await sql.waitForResults();
    const doc = await sql.resultsText();
    expect(doc).toContain('Hello');
    expect(doc).toContain('{"v":1}');

    await sql.setSql(`SELECT member, score FROM "${KEYS.board}";`);
    await sql.run();
    await sql.waitForResults();
    const board = await sql.resultsText();
    expect(board.indexOf('al')).toBeGreaterThan(-1);
    expect(board.indexOf('al')).toBeLessThan(board.indexOf('bo'));
  }, 120_000);

  it('Data peek opens a collection key from the explorer', async () => {
    const label = driver.locator(byTestId('sql-schema-explorer')).getByText(KEYS.jobs, { exact: true }).first();
    await label.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    await waitFor(driver, byTestId('data-peek'), 30_000);
    await driver.waitForFunction(
      () => /send/.test(document.querySelector('[data-testid="data-peek"]')?.textContent ?? ''),
      undefined,
      { timeout: 30_000 }
    );
    const peek = await driver.locator(byTestId('data-peek')).innerText();
    expect(peek).toContain('bill');
    expect(peek).not.toMatch(/Paging failed|Unsupported clause/);
    await saveScreenshot(driver, 'redis-peek-list');
  }, 120_000);
});
