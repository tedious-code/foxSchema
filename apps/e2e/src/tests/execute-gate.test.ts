/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Execute with an unacknowledged narrowing change opens the narrowing review;
 * it does not deploy.
 *
 * The button stays clickable for that conflict on purpose (`executeGate`), so
 * the click is the only thing between the person and a migration that may
 * truncate data. It used to go straight to the plain confirm step, or with
 * "don't ask again" straight to running, while the button itself said to
 * acknowledge the change first.
 *
 * Postgres, two throwaway schemas: the target's `code varchar(100)` becomes
 * the source's `varchar(10)`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { getSourceConfig, hasConfig } from '../helpers/db-config.js';
import { runStatements, tryCleanup } from '../helpers/sql-exec.js';
import { sessionCookie } from '../helpers/app-session.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { ConnectionModal } from '../pages/ConnectionModal.js';
import { MigrationPage } from '../pages/MigrationPage.js';

const DIALECT = 'postgres';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const RUN = Date.now().toString(36);
const SRC = `gate_src_${RUN}`;
const TGT = `gate_tgt_${RUN}`;

async function connectionIds(): Promise<Set<string>> {
  const res = await fetch(`${BASE_URL}/api/connections`, { headers: { cookie: await sessionCookie() } });
  const body = (await res.json()) as { connections?: Array<{ id: string }> } | Array<{ id: string }>;
  const rows = Array.isArray(body) ? body : (body.connections ?? []);
  return new Set(rows.map((r) => r.id));
}

describe.skipIf(!hasConfig(DIALECT))('Execute with an unacknowledged narrowing change (Postgres)', () => {
  let driver: Page;
  let app: AppPage;
  let modal: ConnectionModal;
  let migration: MigrationPage;
  let before = new Set<string>();

  beforeAll(async () => {
    const outcomes = await runStatements(DIALECT, [
      `CREATE SCHEMA ${SRC}`,
      `CREATE SCHEMA ${TGT}`,
      `CREATE TABLE ${SRC}.items (id integer PRIMARY KEY, code varchar(10))`,
      `CREATE TABLE ${TGT}.items (id integer PRIMARY KEY, code varchar(100))`,
    ]);
    expect(outcomes.filter((o) => !o.ok).map((o) => o.error)).toEqual([]);
    before = await connectionIds();
    driver = await buildDriver();
    app = new AppPage(driver);
    modal = new ConnectionModal(driver);
    migration = new MigrationPage(driver);
  }, 60_000);

  afterAll(async () => {
    if (driver) await quitDriver(driver);
    await tryCleanup(DIALECT, [`DROP SCHEMA IF EXISTS ${SRC} CASCADE`, `DROP SCHEMA IF EXISTS ${TGT} CASCADE`]);
    const cookie = await sessionCookie();
    for (const id of await connectionIds()) {
      if (!before.has(id)) await fetch(`${BASE_URL}/api/connections/${id}`, { method: 'DELETE', headers: { cookie } });
    }
  });

  it('compares a target column that would narrow', async () => {
    const cfg = getSourceConfig(DIALECT)!;
    await app.open();
    // A "don't ask again" left by another run would skip the step this test reads.
    await driver.evaluate(() => localStorage.removeItem('foxschema-skip-deploy-confirm'));
    await app.openSourceModal();
    await modal.connect({ ...cfg, schema: SRC });
    await app.waitForSourceConnected(30_000);
    await app.openTargetModal();
    await modal.connect({ ...cfg, schema: TGT });
    await app.waitForTargetConnected(30_000);
    await app.waitForSourceConnected(30_000);
    await app.runCompare();
    expect(await app.getDiffCount()).toBeGreaterThan(0);
    await migration.selectAllObjects(true);
    // Acknowledges destructive drops (the plan for this change has one) and the
    // MySQL routine risk, but never the narrowing: that is what is under test.
    await migration.acknowledgeSafetyWarnings();
    // Without this the test would prove nothing: the narrowing must be seen.
    await driver.locator(byTestId('ack-narrowing-types')).waitFor({ state: 'visible', timeout: 15_000 });
    expect(await driver.locator(byTestId('ack-narrowing-types')).isChecked()).toBe(false);
  });

  it('opens the narrowing review on Execute, and deploys nothing', async () => {
    expect(await migration.isExecuteEnabled()).toBe(true);
    await migration.clickExecute();
    await driver.getByText('Narrowing column type changes').waitFor({ state: 'visible', timeout: 10_000 });
    expect(await migration.isConfirmDialogVisible()).toBe(false);
    expect(await driver.locator(byTestId('migration-progress-panel')).isVisible()).toBe(false);
    await driver.locator(byTestId('migrate-validation-warnings-close')).click();
  });

  it('goes on to confirm once the change is acknowledged', async () => {
    await driver.locator(byTestId('ack-narrowing-types')).check();
    await migration.clickExecute();
    await driver.locator(byTestId('deploy-confirm-dialog')).waitFor({ state: 'visible', timeout: 10_000 });
    // Cancel: this test is about the gate, not about running the migration.
    await driver.locator(byTestId('deploy-cancel-btn')).click();
    expect(await driver.locator(byTestId('migration-progress-panel')).isVisible()).toBe(false);
  });
});
