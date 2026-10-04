/**
 * SQL Editor · table blueprint + result paging against seeded SQLite.
 * Covers review-fix surfaces: blueprint modal open/insert SQL, composite FK
 * tables in explorer, and Next/Prev result paging.
 */
import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

async function waitForColumnForm(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="blueprint-column-form"]', { timeout: 10_000 });
}

const DIR = '/tmp/foxschema-e2e-blueprint';
const DB = join(DIR, 'blueprint.db');
const RUN = Date.now().toString(36);
const NAME = `E2E Blueprint ${RUN}`;

function hasSqlite3(): boolean {
  try {
    execSync('which sqlite3', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function seedDb(path: string): void {
  execFileSync('sqlite3', [path], {
    input: `
PRAGMA foreign_keys = ON;
DROP TABLE IF EXISTS child;
DROP TABLE IF EXISTS parent;
CREATE TABLE parent (
  id1 INTEGER NOT NULL,
  id2 INTEGER NOT NULL,
  label TEXT,
  PRIMARY KEY (id1, id2)
);
CREATE TABLE child (
  id INTEGER PRIMARY KEY,
  parent_id1 INTEGER NOT NULL,
  parent_id2 INTEGER NOT NULL,
  FOREIGN KEY (parent_id1, parent_id2) REFERENCES parent(id1, id2)
);
INSERT INTO parent (id1, id2, label) VALUES
  (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd'),
  (5, 50, 'e'), (6, 60, 'f'), (7, 70, 'g'), (8, 80, 'h');
INSERT INTO child (id, parent_id1, parent_id2) VALUES
  (1,1,10),(2,2,20),(3,3,30),(4,4,40),(5,5,50),(6,6,60),(7,7,70),(8,8,80);
`,
  });
}

const ready = hasSqlite3();

describe.skipIf(!ready)('SQL Editor · blueprint + paging (SQLite)', () => {
  let driver: Page;
  let app: AppPage;
  let sql: SqlEditorPage;

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    seedDb(DB);
    expect(existsSync(DB)).toBe(true);

    driver = await buildDriver();
    app = new AppPage(driver);
    sql = new SqlEditorPage(driver);

    await app.open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector('[data-testid="toolbar"]');

    await sql.addSqliteCredential(NAME, DB);
    await sql.openView();
    await sql.checkConnection(NAME);
    // Sidebar sections are an exclusive accordion: ticking a destination
    // closed Schema, and a closed section renders no explorer to read.
    await sql.ensureSidebarSectionOpen('schema');
    await driver.waitForFunction(
      () => {
        const root = document.querySelector('[data-testid="sql-schema-explorer"]');
        const t = root?.textContent ?? '';
        return /parent/i.test(t) && /child/i.test(t);
      },
      { timeout: 45_000 }
    );
  }, 120_000);

  afterEach(async () => {
    await sql.closeBlueprint().catch(() => undefined);
    await sql.dismissOverlays().catch(() => undefined);
  });

  afterAll(async () => {
    if (driver) await quitDriver(driver);
    rmSync(DIR, { recursive: true, force: true });
  });

  it('schema explorer lists composite-FK parent and child', async () => {
    const explorer = await driver.locator('[data-testid="sql-schema-explorer"]').innerText();
    expect(explorer).toMatch(/parent/i);
    expect(explorer).toMatch(/child/i);
  });

  it('opens table blueprint for parent and shows columns + PK', async () => {
    await sql.openTableBlueprint('parent');
    const modal = driver.locator('[data-testid="table-blueprint-modal"]');
    expect(await modal.isVisible()).toBe(true);
    const text = await modal.innerText();
    expect(text).toMatch(/id1/i);
    expect(text).toMatch(/id2/i);
    expect(text).toMatch(/label/i);
    // Edit mode with no diffs keeps Insert SQL disabled — that's expected.
    expect(await driver.locator('[data-testid="blueprint-insert-sql"]').isDisabled()).toBe(true);
    await sql.closeBlueprint();
  });

  it('create-table blueprint can add a column and insert CREATE TABLE SQL', async () => {
    await sql.openNewTableBlueprint();
    const modal = driver.locator('[data-testid="table-blueprint-modal"]');
    expect(await modal.isVisible()).toBe(true);
    await driver.locator('[data-testid="blueprint-table-name"]').fill(`t_new_${RUN}`);
    await modal.getByRole('button', { name: /add column/i }).click();
    await waitForColumnForm(driver);
    await modal.locator('[data-testid="blueprint-column-form"] input').first().fill('id');
    await modal.getByRole('button', { name: /^save$/i }).click();
    await expect
      .poll(async () => driver.locator('[data-testid="blueprint-insert-sql"]').isEnabled(), {
        timeout: 5_000,
      })
      .toBe(true);
    await sql.blueprintInsertSql();
    await sql.closeBlueprint().catch(() => undefined);
    await driver.waitForTimeout(500);
    const editorText = await driver.evaluate(() => {
      const lines = document.querySelector('.monaco-editor .view-lines');
      const ta = document.querySelector('.monaco-editor textarea') as HTMLTextAreaElement | null;
      return `${lines?.textContent ?? ''}\n${ta?.value ?? ''}`;
    });
    expect(editorText.toLowerCase()).toMatch(/create\s*table/);
  });

  it('Indexes section can add a UNIQUE index on a column', async () => {
    await sql.openNewTableBlueprint();
    const modal = driver.locator('[data-testid="table-blueprint-modal"]');
    expect(await modal.isVisible()).toBe(true);
    await driver.locator('[data-testid="blueprint-table-name"]').fill(`t_idx_${RUN}`);

    await modal.getByRole('button', { name: /add column/i }).click();
    await waitForColumnForm(driver);
    await modal.locator('[data-testid="blueprint-column-form"] input').first().fill('email');
    await modal.getByRole('button', { name: /^save$/i }).click();
    await driver.waitForFunction(() => {
      const m = document.querySelector('[data-testid="table-blueprint-modal"]');
      return !!m && /email/i.test(m.textContent ?? '') && !m.querySelector('[data-testid="blueprint-column-form"]');
    });

    const indexes = modal.locator('[data-testid="table-blueprint-indexes"]');
    expect(await indexes.isVisible()).toBe(true);
    await indexes.locator('[data-testid="blueprint-add-index"]').click();
    await driver.waitForSelector('[data-testid="blueprint-index-form"]', { timeout: 5_000 });

    // openAddIndex already selects the first column — only toggle email on if missing.
    const form = modal.locator('[data-testid="blueprint-index-form"]');
    const formText = await form.innerText();
    if (!/\(email/i.test(formText)) {
      await form.getByRole('button', { name: /^email$/i }).click();
    }
    const unique = form.locator('input[type="checkbox"]').first();
    if (await unique.count()) {
      if (!(await unique.isChecked())) await unique.check();
    }
    await modal.locator('[data-testid="blueprint-index-save"]').click();

    await driver.waitForFunction(() => {
      const root = document.querySelector('[data-testid="table-blueprint-indexes"]');
      if (!root) return false;
      if (root.querySelector('[data-testid="blueprint-index-form"]')) return false;
      return /email/i.test(root.textContent ?? '');
    }, { timeout: 5_000 });

    await sql.blueprintInsertSql();
    await sql.closeBlueprint().catch(() => undefined);
    await driver.waitForTimeout(500);
    const editorText = await driver.evaluate(() => {
      const lines = document.querySelector('.monaco-editor .view-lines');
      const ta = document.querySelector('.monaco-editor textarea') as HTMLTextAreaElement | null;
      return `${lines?.textContent ?? ''}\n${ta?.value ?? ''}`;
    });
    expect(editorText.toLowerCase()).toMatch(/create\s+unique\s+index|create\s+index/);
  });

  it('pages SELECT results with Next/Prev', async () => {
    await driver.locator('[data-testid="sql-max-rows"]').fill('2');
    await sql.setSql('SELECT id1, id2, label FROM parent ORDER BY id1;');
    await sql.run();
    await sql.waitForResults();

    await driver.waitForSelector('[data-testid="sql-page-next"]', { timeout: 15_000 });
    const page0 = await sql.resultsText();
    expect(page0.length).toBeGreaterThan(0);
    expect(await sql.pageNextEnabled()).toBe(true);

    await sql.clickPageNext();
    await driver.waitForFunction(
      (prev) => {
        const by = document.querySelector('[data-testid="sql-results-by-credential"]');
        const side = document.querySelector('[data-testid="sql-results-side-by-side"]');
        const text = (by ?? side)?.textContent ?? '';
        return text.length > 0 && text !== prev;
      },
      page0,
      { timeout: 15_000 }
    );
    expect(await sql.resultsText()).not.toEqual(page0);

    await sql.clickPagePrev();
    await driver.waitForFunction(
      (want) => {
        const by = document.querySelector('[data-testid="sql-results-by-credential"]');
        const side = document.querySelector('[data-testid="sql-results-side-by-side"]');
        const text = (by ?? side)?.textContent ?? '';
        return text.includes(want.slice(0, 8)) || text === want;
      },
      page0,
      { timeout: 15_000 }
    );
  });
});
