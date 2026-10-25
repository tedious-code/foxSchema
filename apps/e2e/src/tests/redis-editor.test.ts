/**
 * Redis in the SQL editor, end to end: basic SQL, every built-in sample,
 * Compare data with Data migrate, and Data peek with its row editor.
 *
 * Three Redis databases in the dev container, all under a per-run key prefix:
 *
 *   db 0  "Redis A"  the main data set: a hash prefix, JSON documents, a list,
 *                    a set, a sorted set and a stream
 *   db 1  "Redis B"  the same hash prefix, differing from A, for Compare data
 *   db 2  "Redis S"  a sandbox the samples run against, so a sample that writes
 *                    cannot touch A or B
 *
 * Every assertion reads the rows the grid shows, or the keys Redis holds
 * afterwards (`redis-cli`), never just the absence of an error.
 *
 * Requires the web app + API and the dev Redis container (`foxschema-redis`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, clickWhen, waitFor } from '../helpers/driver.js';
import { sessionCookie } from '../helpers/app-session.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';
const RUN = Date.now().toString(36);
const P = `rt${RUN}`;
const T = {
  users: `${P}users`,
  docs: `${P}docs`,
  jobs: `${P}jobs`,
  tags: `${P}tags`,
  board: `${P}board`,
  log: `${P}log`,
};
const CONN = { a: `Redis A ${RUN}`, b: `Redis B ${RUN}`, s: `Redis S ${RUN}` };
/** One line per sample as it finishes (see the samples test). */
const SAMPLE_LOG = process.env.FOX_SAMPLE_LOG ?? join(tmpdir(), 'fox-redis-samples.log');

function redis(db: number, ...args: string[]): string {
  return execFileSync('docker', ['exec', '-i', 'foxschema-redis', 'redis-cli', '-n', String(db), ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function redisReachable(): boolean {
  try {
    return redis(0, 'PING') === 'PONG';
  } catch {
    return false;
  }
}

/** Every key in `db` matching `pattern`. */
function keys(db: number, pattern: string): string[] {
  const out = redis(db, '--scan', '--pattern', pattern);
  return out ? out.split('\n').filter(Boolean).sort() : [];
}

/** A hash as an object. */
function hash(db: number, key: string): Record<string, string> {
  const flat = redis(db, 'HGETALL', key).split('\n').filter((l) => l !== '');
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
  return out;
}

function seed(): void {
  const users: Array<[string, string, string]> = [
    ['1', 'Ana', 'free'],
    ['2', 'Bo', 'pro'],
    ['3', 'Cy', 'pro'],
    ['4', 'Di', 'free'],
    ['5', 'Ed', 'team'],
  ];
  for (const [id, name, plan] of users) redis(0, 'HSET', `${T.users}:${id}`, 'name', name, 'plan', plan);
  redis(0, 'SET', `${T.docs}:a`, JSON.stringify({ title: 'Hello', tags: ['x'], n: 1 }));
  redis(0, 'SET', `${T.docs}:b`, JSON.stringify({ title: 'World', n: 2 }));
  redis(0, 'RPUSH', T.jobs, JSON.stringify({ job: 'send', to: 'ana' }), JSON.stringify({ job: 'bill', to: 'bo' }), 'plain-entry');
  redis(0, 'SADD', T.tags, 'red', 'green', 'blue');
  redis(0, 'ZADD', T.board, '30', 'cy', '10', 'al', '20', 'bo');
  redis(0, 'XADD', T.log, '*', 'level', 'info', 'msg', 'started');
  redis(0, 'XADD', T.log, '*', 'level', 'warn', 'msg', 'slow');

  // B: user 1 the same, 2 changed, 6 only here; 3–5 only in A.
  redis(1, 'HSET', `${T.users}:1`, 'name', 'Ana', 'plan', 'free');
  redis(1, 'HSET', `${T.users}:2`, 'name', 'Bo', 'plan', 'free');
  redis(1, 'HSET', `${T.users}:6`, 'name', 'Fay', 'plan', 'pro');
}

function cleanup(): void {
  for (const db of [0, 1, 2]) for (const k of keys(db, `${P}*`)) redis(db, 'DEL', k);
}

describe.skipIf(!redisReachable())('SQL Editor · Redis', () => {
  let admin = '';
  const connectionIds: string[] = [];
  let driver: Page;
  let sql: SqlEditorPage;
  /** Keys in the samples' sandbox before they ran, so only what they made is removed. */
  let sandboxBefore = new Set<string>();

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: admin },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  /** Tick exactly these destinations. */
  async function destinations(...names: string[]): Promise<void> {
    await sql.ensureSidebarSectionOpen('destinations');
    for (const name of Object.values(CONN)) {
      const box = driver.locator(byTestId(`sql-conn-check-${name}`));
      await box.waitFor({ timeout: 15_000 });
      const want = names.includes(name);
      if ((await box.isChecked()) !== want) await box.click();
      // Plain polling: this also runs in beforeAll, where expect.poll is not allowed.
      const deadline = Date.now() + 10_000;
      while ((await box.isChecked()) !== want) {
        if (Date.now() > deadline) throw new Error(`${name} did not become ${want ? 'checked' : 'unchecked'}`);
        await driver.waitForTimeout(200);
      }
    }
  }

  /**
   * Run `text`; confirm the Safe mode prompt when it is a write. A statement
   * with no WHERE also needs its acknowledgement ticked before Confirm enables.
   */
  async function runSql(text: string, opts: { write?: boolean } = {}): Promise<void> {
    await sql.setSql(text);
    await sql.run();
    if (opts.write) {
      const ack = driver.locator(byTestId('sql-safe-no-where-ack-check'));
      if (await ack.isVisible({ timeout: 2_000 }).catch(() => false)) await ack.check();
      await sql.confirmWriteIfShown();
    }
    await sql.waitForResults(60_000);
  }

  /** The rows of every result grid on screen, as cell text, without the # column. */
  const gridRows = (): Promise<string[][]> =>
    driver.evaluate(() =>
      [...document.querySelectorAll('[data-testid="sql-data-grid"] tbody tr')]
        .filter((tr) => tr.querySelector('[data-testid="sql-row-num"]'))
        .map((tr) => [...tr.querySelectorAll('td')].slice(1).map((td) => (td.textContent ?? '').trim()))
    );

  /** Column headers of the first result grid. */
  const gridColumns = (): Promise<string[]> =>
    driver.evaluate(() =>
      [...(document.querySelector('[data-testid="sql-data-grid"]')?.querySelectorAll('[data-testid="sql-col-header"]') ?? [])].map(
        // A header reads "▲nametext": sort arrow, name, type badge (uppercase by CSS only).
        (th) => (th.textContent ?? '').trim().replace(/^[^A-Za-z_]+/, '').replace(/(text|num|bool|date|json)$/i, '')
      )
    );

  /** Error text the results show, statement errors and run errors alike. */
  const errors = (): Promise<string[]> =>
    driver.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-testid="sql-grid-error"], [data-testid="sql-result-error"], [data-testid="sql-run-error"]'
        ),
      ].map((e) =>
        (e.textContent ?? '').trim()
      )
    );

  /**
   * Wait for a run to finish, confirming a write when Safe mode asks (the
   * sandbox database takes it). True when it settled within `timeoutMs`.
   * The results container never mounts for a run refused before it starts,
   * so waiting on it would sit out the whole timeout for every refusal.
   */
  async function settle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const busy = () =>
      driver.evaluate(() =>
        Boolean(document.querySelector('[data-testid="sql-run-btn"] .animate-spin, [data-testid="sql-results-running"]'))
      );
    // A run refused before it starts never spins; give it 3 s to show it began.
    const startBy = Date.now() + 3_000;
    while (!(await busy()) && Date.now() < startBy) {
      if (await driver.locator(byTestId('sql-write-confirm')).isVisible()) break;
      await driver.waitForTimeout(100);
    }
    while (Date.now() < deadline) {
      if (await driver.locator(byTestId('sql-write-confirm')).isVisible()) {
        const ack = driver.locator(byTestId('sql-safe-no-where-ack-check'));
        if (await ack.isVisible()) await ack.check();
        await clickWhen(driver, byTestId('sql-write-confirm-btn'));
        await driver.waitForTimeout(300);
        continue;
      }
      if (!(await busy())) return true;
      await driver.waitForTimeout(250);
    }
    return false;
  }

  beforeAll(async () => {
    cleanup();
    seed();
    sandboxBefore = new Set(keys(2, '*'));
    admin = await sessionCookie();
    for (const [name, db] of [
      [CONN.a, '0'],
      [CONN.b, '1'],
      [CONN.s, '2'],
    ] as const) {
      const saved = await api('POST', '/connections', { name, dialect: 'redis', option: { host: '127.0.0.1', port: 6379, schema: db } });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      connectionIds.push(saved.json.connection.id);
    }

    driver = await buildDriver();
    sql = new SqlEditorPage(driver);
    await new AppPage(driver).open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector(byTestId('toolbar'));
    await sql.openView();
  }, 180_000);

  afterAll(async () => {
    if (driver) await quitDriver(driver);
    for (const id of connectionIds) await api('DELETE', `/connections/${id}`);
    cleanup();
    for (const k of keys(2, '*')) if (!sandboxBefore.has(k)) redis(2, 'DEL', k);
  });

  // ── Basic SQL ──────────────────────────────────────────────────────────

  describe('basic SQL', () => {
    beforeAll(async () => {
      await destinations(CONN.a);
    }, 60_000);

    it('SELECT * reads every hash under a prefix, its fields as columns', async () => {
      await runSql(`SELECT * FROM ${T.users};`);
      expect(await errors()).toEqual([]);
      const rows = await gridRows();
      expect(rows).toHaveLength(5);
      expect(new Set(await gridColumns())).toEqual(new Set(['id', 'name', 'plan']));
      expect(rows.map((r) => r.join(' ')).join('\n')).toMatch(/Ana[\s\S]*Ed|Ed[\s\S]*Ana/);
    }, 60_000);

    it('selects columns, filters by equality, and reads one key by id', async () => {
      await runSql(`SELECT id, name FROM ${T.users} WHERE plan = 'pro';`);
      expect(await gridColumns()).toEqual(['id', 'name']);
      expect((await gridRows()).map((r) => r[1]).sort()).toEqual(['Bo', 'Cy']);

      await runSql(`SELECT * FROM ${T.users} WHERE id = '4';`);
      const rows = await gridRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain('Di');
    }, 60_000);

    it('honours LIMIT and OFFSET', async () => {
      await runSql(`SELECT * FROM ${T.users} LIMIT 2;`);
      expect(await gridRows()).toHaveLength(2);
      await runSql(`SELECT * FROM ${T.users} LIMIT 10 OFFSET 3;`);
      expect(await gridRows()).toHaveLength(2);
    }, 60_000);

    it('pages the grid with Rows/page, Next and Prev', async () => {
      await driver.fill(byTestId('sql-max-rows'), '2');
      try {
        await runSql(`SELECT * FROM ${T.users};`);
        const seen = new Set<string>();
        const page1 = await gridRows();
        expect(page1).toHaveLength(2);
        page1.forEach((r) => seen.add(r[0]!));
        expect(await sql.pageNextEnabled()).toBe(true);

        await sql.clickPageNext();
        await expect.poll(async () => (await gridRows())[0]?.[0]).not.toBe(page1[0]![0]);
        (await gridRows()).forEach((r) => seen.add(r[0]!));
        await sql.clickPageNext();
        await expect.poll(async () => (await gridRows()).length).toBe(1);
        (await gridRows()).forEach((r) => seen.add(r[0]!));
        expect([...seen].sort()).toEqual(['1', '2', '3', '4', '5']);
        expect(await sql.pageNextEnabled()).toBe(false);

        await sql.clickPagePrev();
        await expect.poll(async () => (await gridRows()).length).toBe(2);
      } finally {
        await driver.fill(byTestId('sql-max-rows'), '200');
      }
    }, 90_000);

    it('INSERT, UPDATE and DELETE write the hash — and nothing else', async () => {
      await runSql(`INSERT INTO ${T.users} (id, name, plan) VALUES ('9', 'Zed', 'free');`, { write: true });
      expect(await errors()).toEqual([]);
      expect(hash(0, `${T.users}:9`)).toEqual({ name: 'Zed', plan: 'free' });

      await runSql(`UPDATE ${T.users} SET plan = 'pro' WHERE id = '9';`, { write: true });
      expect(hash(0, `${T.users}:9`)).toEqual({ name: 'Zed', plan: 'pro' });

      // A non-id predicate that does not hold leaves the row alone.
      await runSql(`UPDATE ${T.users} SET plan = 'team' WHERE id = '9' AND name = 'Nobody';`, { write: true });
      expect(hash(0, `${T.users}:9`).plan).toBe('pro');

      await runSql(`DELETE FROM ${T.users} WHERE id = '9';`, { write: true });
      expect(keys(0, `${T.users}:9`)).toEqual([]);
      expect(keys(0, `${T.users}:*`)).toHaveLength(5);
    }, 90_000);

    it.each([
      ['a DELETE with no WHERE', (t: typeof T) => `DELETE FROM ${t.users};`, true],
      ['a range predicate', (t: typeof T) => `SELECT * FROM ${t.users} WHERE id > 1;`, false],
      ['a join', (t: typeof T) => `SELECT * FROM ${t.users} u JOIN ${t.docs} d ON u.id = d.id;`, false],
      ['an OR', (t: typeof T) => `SELECT * FROM ${t.users} WHERE id = '1' OR id = '2';`, false],
      ['an aggregate', (t: typeof T) => `SELECT COUNT(*) FROM ${t.users};`, false],
    ] as const)('refuses %s with a message, and changes nothing', async (_label, build, write) => {
      await runSql(build(T), { write });
      const errs = await errors();
      expect(errs.length, 'no error shown').toBeGreaterThan(0);
      expect(errs.join('\n')).not.toMatch(/Paging failed/);
      expect(keys(0, `${T.users}:*`)).toHaveLength(5);
    }, 60_000);

    it('reads a list, a set, a sorted set and a stream as tables of their elements', async () => {
      await runSql(`SELECT * FROM "${T.jobs}";`);
      expect(await gridColumns()).toEqual(['index', 'job', 'to', 'value']);
      // A JSON element fills `job`; the plain one fills `value` (the grid prints NULL for the other).
      const cell = (v?: string) => (v && v !== 'NULL' ? v : '');
      expect((await gridRows()).map((r) => cell(r[1]) || cell(r[3]))).toEqual(['send', 'bill', 'plain-entry']);

      await runSql(`SELECT * FROM "${T.tags}";`);
      expect((await gridRows()).map((r) => r[0]).sort()).toEqual(['blue', 'green', 'red']);

      await runSql(`SELECT member, score FROM "${T.board}";`);
      expect((await gridRows()).map((r) => r[0])).toEqual(['al', 'bo', 'cy']);

      await runSql(`SELECT level, msg FROM "${T.log}" WHERE level = 'warn';`);
      expect(await gridRows()).toEqual([['warn', 'slow']]);
    }, 90_000);

    it('reads JSON documents as their fields', async () => {
      await runSql(`SELECT id, title, n, tags FROM ${T.docs};`);
      const rows = await gridRows();
      expect(rows.map((r) => r[1]).sort()).toEqual(['Hello', 'World']);
      expect(rows.find((r) => r[1] === 'Hello')?.[3]).toBe('["x"]');
    }, 60_000);

    it('refuses to write a collection or a JSON document, and leaves them unchanged', async () => {
      await runSql(`INSERT INTO "${T.jobs}" (id, job) VALUES ('9', 'x');`, { write: true });
      expect((await errors()).join('\n')).toMatch(/read-only/);
      expect(redis(0, 'LLEN', T.jobs)).toBe('3');

      await runSql(`UPDATE ${T.docs} SET title = 'x' WHERE id = 'a';`, { write: true });
      expect((await errors()).join('\n')).toMatch(/only hash keys are updated/);
      expect(JSON.parse(redis(0, 'GET', `${T.docs}:a`)).title).toBe('Hello');
      await saveScreenshot(driver, 'redis-editor-refusal');
    }, 60_000);
  });

  // ── Samples ───────────────────────────────────────────────────────────

  describe('built-in samples', () => {
    type Outcome = { id: string; title: string; ok: boolean; error: string };
    const outcomes: Outcome[] = [];

    beforeAll(async () => {
      writeFileSync(SAMPLE_LOG, '');
      await destinations(CONN.s);
      await sql.ensureSidebarSectionOpen('bookmarks');
      await clickWhen(driver, byTestId('sql-bookmark-install-samples'));
    }, 60_000);

    it('runs every sample against Redis: each finishes, and a failure says why', async () => {
      // The editor persists 400 ms after a change, under a key scoped to the
      // open workspace (`foxschema-sql-editor:<id>`); read whichever holds them.
      await driver.waitForTimeout(600);
      const samples: Array<{ id: string; title: string; sql: string }> = await driver.evaluate(() => {
        window.dispatchEvent(new Event('pagehide'));
        for (const key of Object.keys(localStorage).filter((k) => k.startsWith('foxschema-sql-editor'))) {
          const found = (JSON.parse(localStorage.getItem(key) ?? '{}')?.state?.bookmarks ?? []).filter(
            (b: { id: string }) => b.id.startsWith('sample-')
          );
          if (found.length) return found;
        }
        return [];
      });
      expect(samples.length).toBeGreaterThan(30);

      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      for (const s of samples) {
        // The sample's own text, not typed: typing runs Monaco's auto-indent
        // and bracket closing over it, and takes a minute for the long ones.
        await sql.waitForMonaco();
        await driver.locator('.monaco-editor').first().click();
        await driver.keyboard.press(`${mod}+KeyA`);
        await driver.keyboard.insertText(s.sql);
        await driver.waitForTimeout(350);
        // With nothing selected, Run runs the statement at the caret — here the
        // last cell. Select the whole buffer so every cell runs, in order.
        await driver.keyboard.press(`${mod}+KeyA`);
        await sql.run();
        const settled = await settle(45_000);
        const errs = settled ? await errors() : ['HUNG: still running after 45 s'];
        const o = { id: s.id, title: s.title, ok: errs.length === 0, error: errs.join(' | ').slice(0, 200) };
        outcomes.push(o);
        // Written as it goes, so a run that times out still says how far it got.
        appendFileSync(SAMPLE_LOG, `${o.ok ? 'OK  ' : 'FAIL'} ${o.id}${o.ok ? '' : ` — ${o.error}`}\n`);
        if (!settled) {
          // Nothing stops a run from the toolbar: start the editor over.
          await driver.reload();
          await driver.waitForSelector(byTestId('toolbar'));
          await sql.openView();
          await destinations(CONN.s);
        }
      }

      // Printed for the report: which samples run on Redis, and why the rest stop.
      console.log(
        '\nSamples on Redis:\n' +
          outcomes.map((o) => `${o.ok ? 'OK  ' : 'FAIL'} ${o.id}${o.ok ? '' : ` — ${o.error}`}`).join('\n')
      );

      // None may hang, and none may stop without saying why.
      // None may hang, hit the paging bug, or stop without saying why.
      for (const o of outcomes) {
        expect(o.error, o.id).not.toMatch(/^HUNG|Paging failed|Unsupported clause: \* FROM \(/);
        if (!o.ok) expect(o.error.length, `${o.id} failed silently`).toBeGreaterThan(0);
      }
      // Code-only samples (no SQL, no network) never touch the store: they must run.
      for (const id of ['sample-js-pure-grid', 'sample-js-try-catch', 'sample-js-faker-random-data']) {
        const o = outcomes.find((x) => x.id === id);
        if (o) expect(o.ok, `${id}: ${o.error}`).toBe(true);
      }
      // The A/B databases were never touched by a sample.
      expect(keys(0, `${T.users}:*`)).toHaveLength(5);
    }, 1_800_000);
  });

  // ── Compare data ──────────────────────────────────────────────────────

  describe('Compare data and Data migrate', () => {
    /** Pick the Compare Source by its Destination name. */
    async function chooseSource(name: string): Promise<void> {
      const select = sql.compareBaselineSelect(0);
      const value = await select.locator('option', { hasText: name }).first().getAttribute('value');
      if (!value) throw new Error(`no Compare source named ${name}`);
      await select.selectOption(value);
    }

    beforeAll(async () => {
      await destinations(CONN.a, CONN.b);
    }, 60_000);

    it('aligns the two databases by key and counts each kind of difference', async () => {
      await runSql(`SELECT * FROM ${T.users};`);
      expect(await errors()).toEqual([]);
      await sql.setLayoutSideBySide();
      await waitFor(driver, byTestId('sql-result-compare-toggle-0'), 20_000);
      if (!(await sql.compareToggle(0).isChecked())) await sql.compareToggle(0).click();
      await waitFor(driver, byTestId('sql-data-migrate-bar-0'), 20_000);
      // Source defaults to whichever Destination is listed first; make it A.
      await chooseSource(CONN.a);
      const direction = async () => {
        const bar = await driver.locator(byTestId('sql-data-migrate-bar-0')).innerText();
        const arrow = bar.indexOf('→');
        return bar.indexOf(CONN.a) < arrow && bar.indexOf(CONN.b) > arrow ? 'A→B' : 'B→A';
      };
      await expect.poll(direction, { timeout: 10_000 }).toBe('A→B');

      // Spelled out so the test-ID catalog can check each one exists.
      const CHIPS = {
        add: 'sql-data-migrate-chip-add-0',
        edit: 'sql-data-migrate-chip-edit-0',
        delete: 'sql-data-migrate-chip-delete-0',
      } as const;
      const chip = async (kind: keyof typeof CHIPS) =>
        Number(((await driver.locator(byTestId(CHIPS[kind])).innerText()).match(/\d+/) ?? ['0'])[0]);
      // A → B: 3, 4 and 5 are only in A (add), 2 differs (edit), 6 is only in B (delete).
      await expect.poll(() => chip('add'), { timeout: 15_000 }).toBe(3);
      expect(await chip('edit')).toBe(1);
      expect(await chip('delete')).toBe(1);
      expect(await sql.diffCellCount()).toBeGreaterThan(0);
      await saveScreenshot(driver, 'redis-compare');
    }, 90_000);

    it('applies the migrate to B, after which B holds exactly what A does', async () => {
      await clickWhen(driver, byTestId('sql-data-migrate-apply-0'));
      // Data migrate asks through its own Safe mode dialog, not the editor's.
      await clickWhen(driver, byTestId('sql-data-migrate-safe-confirm-apply'));
      await waitFor(driver, byTestId('sql-data-migrate-progress'), 20_000);
      const failures = driver.locator(byTestId('sql-data-migrate-failures-0'));
      await expect
        .poll(
          async () =>
            (await failures.count()) ? `FAILED: ${await failures.innerText()}` : keys(1, `${T.users}:*`).join(','),
          { timeout: 30_000 }
        )
        .toBe(keys(0, `${T.users}:*`).join(','));
      await saveScreenshot(driver, 'redis-migrate-applied');
      // The progress panel gives way to a toast once the run ends.
      const progress = driver.locator(byTestId('sql-data-migrate-progress-close'));
      if (await progress.isVisible()) await progress.click();
      for (const id of ['1', '2', '3', '4', '5']) {
        expect(hash(1, `${T.users}:${id}`), id).toEqual(hash(0, `${T.users}:${id}`));
      }
      expect(keys(1, `${T.users}:6`)).toEqual([]);
    }, 90_000);

    it('compares clean afterwards', async () => {
      await runSql(`SELECT * FROM ${T.users};`);
      await waitFor(driver, byTestId('sql-result-compare-toggle-0'), 20_000);
      if (!(await sql.compareToggle(0).isChecked())) await sql.compareToggle(0).click();
      await expect.poll(() => sql.diffCellCount(), { timeout: 15_000 }).toBe(0);
      await sql.setLayoutByCredential();
    }, 60_000);
  });

  // ── Data peek ─────────────────────────────────────────────────────────

  describe('Data peek', () => {
    const peekRows = (): Promise<string[][]> =>
      driver.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="data-peek-grid-"] [data-testid="sql-data-grid"] tbody tr')]
          .filter((tr) => tr.querySelector('[data-testid="sql-row-num"]'))
          .map((tr) => [...tr.querySelectorAll('td')].slice(1).map((td) => (td.textContent ?? '').trim()))
      );

    async function peek(table: string): Promise<void> {
      if (await driver.locator(byTestId('data-peek')).count()) {
        await clickWhen(driver, byTestId('data-peek-close'));
        await driver.locator(byTestId('data-peek')).waitFor({ state: 'detached' });
      }
      await sql.ensureSidebarSectionOpen('schema');
      const explorer = driver.locator(byTestId('sql-schema-explorer'));
      await waitFor(driver, byTestId(`sql-explorer-store-type-${table}`), 30_000);
      await explorer.getByText(table, { exact: true }).first().click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
      await waitFor(driver, byTestId('data-peek'), 30_000);
      await expect.poll(async () => (await peekRows()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    }

    beforeAll(async () => {
      await destinations(CONN.a);
    }, 60_000);

    it('peeks a hash prefix, filters it with WHERE, and pages it', async () => {
      await peek(T.users);
      expect(await peekRows()).toHaveLength(5);

      const where = driver.locator('[data-testid^="data-peek-where-"]').first();
      await where.fill("plan = 'pro'");
      await where.press('Enter');
      await expect.poll(async () => (await peekRows()).map((r) => r[1]).sort(), { timeout: 15_000 }).toEqual(['Bo', 'Cy']);
      await driver.locator('[data-testid^="data-peek-where-clear-"]').first().click();
      await expect.poll(async () => (await peekRows()).length, { timeout: 15_000 }).toBe(5);

      const limit = driver.locator('[data-testid^="data-peek-limit-"]').first();
      await limit.fill('2');
      await limit.press('Enter');
      await expect.poll(async () => (await peekRows()).length, { timeout: 15_000 }).toBe(2);
      const first = (await peekRows())[0]![0];
      await driver.locator(`[data-testid^="data-peek-grid-"] ${byTestId('sql-page-next')}`).first().click();
      await expect.poll(async () => (await peekRows())[0]?.[0], { timeout: 15_000 }).not.toBe(first);
      await limit.fill('50');
      await limit.press('Enter');
      await expect.poll(async () => (await peekRows()).length, { timeout: 15_000 }).toBe(5);
    }, 120_000);

    it('adds, edits and deletes a hash row through the row editor', async () => {
      // Add
      await clickWhen(driver, '[data-testid^="data-peek-add-"]');
      const form = driver.locator(byTestId('peek-row-editor'));
      await form.waitFor({ state: 'visible', timeout: 10_000 });
      await form.locator(byTestId('peek-row-field-id')).fill('8');
      await form.locator(byTestId('peek-row-field-name')).fill('Gus');
      await form.locator(byTestId('peek-row-field-plan')).fill('free');
      await clickWhen(driver, byTestId('peek-row-submit'));
      await clickWhen(driver, byTestId('peek-row-save'));
      await sql.confirmWriteIfShown();
      await form.waitFor({ state: 'detached', timeout: 15_000 });
      expect(hash(0, `${T.users}:8`)).toEqual({ name: 'Gus', plan: 'free' });
      await expect.poll(async () => (await peekRows()).length, { timeout: 15_000 }).toBe(6);

      // Edit: select Gus's row, change the plan.
      const gusRow = async () => (await peekRows()).findIndex((r) => r[1] === 'Gus');
      await expect.poll(gusRow).toBeGreaterThanOrEqual(0);
      await driver
        .locator(`[data-testid^="data-peek-grid-"] [data-testid="sql-row-${await gusRow()}"] td`)
        .nth(2)
        .click();
      await clickWhen(driver, '[data-testid^="data-peek-edit-"]');
      await form.waitFor({ state: 'visible', timeout: 10_000 });
      await form.locator(byTestId('peek-row-field-plan')).fill('team');
      await clickWhen(driver, byTestId('peek-row-submit'));
      await clickWhen(driver, byTestId('peek-row-save'));
      await sql.confirmWriteIfShown();
      await form.waitFor({ state: 'detached', timeout: 15_000 });
      await expect.poll(() => hash(0, `${T.users}:8`).plan, { timeout: 15_000 }).toBe('team');

      // Delete
      await expect.poll(gusRow).toBeGreaterThanOrEqual(0);
      await driver
        .locator(`[data-testid^="data-peek-grid-"] [data-testid="sql-row-${await gusRow()}"] td`)
        .nth(2)
        .click();
      await clickWhen(driver, '[data-testid^="data-peek-delete-"]');
      await sql.confirmWriteIfShown();
      await expect.poll(() => keys(0, `${T.users}:8`).length, { timeout: 15_000 }).toBe(0);
      await expect.poll(async () => (await peekRows()).length, { timeout: 15_000 }).toBe(5);
      await saveScreenshot(driver, 'redis-peek-crud');
    }, 180_000);

    it('peeks a list and a JSON prefix read-only, with no row editing offered', async () => {
      await peek(T.jobs);
      expect((await peekRows()).length).toBe(3);
      expect(await driver.locator('[data-testid^="data-peek-add-"]').count()).toBe(0);
      expect(await driver.locator(byTestId('data-peek')).innerText()).toMatch(/Read-only/);

      await peek(T.docs);
      expect((await peekRows()).map((r) => r.join(' ')).join('\n')).toMatch(/Hello[\s\S]*World|World[\s\S]*Hello/);
      expect(await driver.locator('[data-testid^="data-peek-add-"]').count()).toBe(0);
      await clickWhen(driver, byTestId('data-peek-close'));
    }, 120_000);
  });
});
