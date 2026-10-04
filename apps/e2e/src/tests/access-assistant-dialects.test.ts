/**
 * Access Assistant · all configured dialects.
 *
 * Non-destructive: loads user catalog, opens Permission Builder / Diff tabs,
 * verifies SQL preview renders for richer grant scopes.
 */
import { describe, it, beforeAll, beforeEach, afterAll, afterEach, expect } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { getSourceConfig, hasConfig } from '../helpers/db-config.js';
import { saveScreenshot } from '../helpers/screenshot.js';
import { deleteSavedConnections } from '../helpers/sql-exec.js';
import { AppPage } from '../pages/AppPage.js';
import { SqlEditorPage } from '../pages/SqlEditorPage.js';

const ALL_DIALECTS = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlserver',
  'oracle',
  'db2',
  'sqlite',
  'cockroachdb',
  'yugabytedb',
  'azuresql',
  'clickhouse',
  'redshift',
  'tidb',
  'duckdb',
] as const;

const SUPPORTS_DB_ACCESS: readonly string[] = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlserver',
  'oracle',
  'db2',
  'cockroachdb',
  'yugabytedb',
  'azuresql',
  'clickhouse',
  'redshift',
  'tidb',
];

const SUPPORTS_GRANT_BUILDER: readonly string[] = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlserver',
  'oracle',
  'db2',
  'cockroachdb',
  'yugabytedb',
  'azuresql',
  'redshift',
  'tidb',
];

/** `E2E_DIALECTS=oracle,tidb` narrows a run to those engines. */
const only = (process.env.E2E_DIALECTS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const configured = ALL_DIALECTS.filter(
  (d) => hasConfig(d) && (only.length === 0 || only.includes(d))
);

describe.skipIf(configured.length === 0)('Access Assistant (all configured dialects)', () => {
  let driver: Page;
  let app: AppPage;
  let sql: SqlEditorPage;
  const credNameByDialect = new Map<string, string>();
  const unreachable = new Map<string, string>();
  const runId = Date.now().toString(36);

  beforeAll(async () => {
    driver = await buildDriver();
    app = new AppPage(driver);
    sql = new SqlEditorPage(driver);

    await app.open();
    await sql.resetPersistedEditorState();
    await driver.reload();
    await driver.waitForSelector('[data-testid="toolbar"]', { timeout: 30_000 });

  
  /**
   * A run that reached no database proved nothing, so it must not report green.
   *
   * Every per-dialect test skips when its connection could not be made, which is
   * right for one sick container — but when *all* of them skip, vitest still
   * reports the file as passed. That is how a suite comes to certify engines it
   * never touched: the API process had died, every connection failed, and forty
   * skipped tests looked like success.
   */
  it('reached at least one database', () => {
    expect(
      credNameByDialect.size,
      `no connection could be made to any of: ${configured.join(', ')}. ` +
        `Reasons: ${[...unreachable.entries()].map(([d, why]) => `${d}: ${why}`).join(' | ') || 'none recorded'}`
    ).toBeGreaterThan(0);
  });

  for (const dialect of configured) {
      const cfg = getSourceConfig(dialect)!;
      const name = `E2E Access ${dialect} ${runId}`;
      try {
        await sql.addCredential(name, cfg);
        credNameByDialect.set(dialect, name);
      } catch (err) {
        unreachable.set(dialect, err instanceof Error ? err.message : String(err));
        await driver.reload();
        await driver.waitForSelector('[data-testid="toolbar"]', { timeout: 30_000 });
      }
    }

    await driver.locator('[data-testid="view-access-btn"]').click();
    await driver.waitForSelector('[data-testid="access-view"]', { timeout: 20_000 });
  }, 300_000);

  afterEach(async () => {
    await driver.locator('[data-testid="access-tab-users"]').click().catch(() => undefined);
  });

  afterAll(async () => {
    await deleteSavedConnections([...credNameByDialect.values()]);
    if (driver) await quitDriver(driver);
  });

  /**
   * Access uses one workspace chip (`name · dialect`) for Users, Permission, and Diff.
   */
  const usersLabel = (dialect: string) => `${credNameByDialect.get(dialect)!} · ${dialect}`;

  async function selectConnection(dialect: string) {
    const label = usersLabel(dialect);
    const chip = driver.locator('[data-testid="access-connection"]');
    const select = (await chip.isVisible().catch(() => false))
      ? chip
      : driver.locator('[data-testid="user-connection"]');
    await select.selectOption({ label });
  }

  for (const dialect of configured) {
    describe(dialect, () => {
      beforeEach((ctx) => {
        if (!credNameByDialect.has(dialect)) ctx.skip();
      });

      it('User Management loads principals from catalog', async () => {
        await driver.locator('[data-testid="access-tab-users"]').click();
        await selectConnection(dialect);

        // Refresh is disabled for two different reasons — while a load is in
        // flight, and permanently on SQLite/DuckDB, which have no user catalog
        // at all. Waiting for it to settle tells them apart; treating the first
        // as the second waits 30s for a message that is never coming.
        await driver.waitForFunction(
          () => {
            const btn = document.querySelector('[data-testid="user-refresh"]');
            return (
              document.querySelector('[data-testid="user-unsupported"]') !== null ||
              (btn instanceof HTMLButtonElement && !btn.disabled)
            );
          },
          undefined,
          { timeout: 120_000 }
        );

        if ((await driver.locator('[data-testid="user-unsupported"]').count()) > 0) {
          expect(SUPPORTS_DB_ACCESS.includes(dialect), `${dialect} refused to list`).toBe(false);
          return;
        }
        await driver.locator('[data-testid="user-refresh"]').click();

        await driver.waitForSelector(
          '[data-testid^="user-row-"], [data-testid="user-list-error"],' +
            ' [data-testid="user-unsupported"], [data-testid="user-list-empty"]',
          { timeout: 120_000 }
        );

        const body = await driver.locator('[data-testid="user-management"]').innerText();
        expect(body.toLowerCase()).not.toMatch(/credential not found|password required/);

        if (SUPPORTS_DB_ACCESS.includes(dialect)) {
          // Read the refusal off the element that states one, not off the whole
          // panel: Oracle's coaching text says "Rename is not supported here",
          // which a body-wide /not support/ scan counted as a refusal to list.
          const unsupported = driver.locator('[data-testid="user-unsupported"]');
          expect(await unsupported.count(), `${dialect} should load principals`).toBe(0);
        }

        await saveScreenshot(driver, `access-users-${dialect}`);
      });

      it('Permission Diff tab loads and accepts desired state', async () => {
        if (!SUPPORTS_GRANT_BUILDER.includes(dialect)) return;

        await driver.locator('[data-testid="access-tab-diff"]').click();
        await driver.waitForSelector('[data-testid="permission-diff"]', { timeout: 15_000 });
        await driver
          .locator('[data-testid="access-connection"]')
          .selectOption({ label: usersLabel(dialect) });
        await driver.locator('[data-testid="diff-principal-name"]').fill('report_user');

        // The desired-state row offers only the scopes the engine can grant on,
        // so a schema box exists on the Postgres family and not on MySQL's,
        // where the row opens on Tables instead. Fill it when it is there and
        // otherwise take the default scope — the point of this test is that the
        // comparison runs, not which scope it runs at.
        const cfg = getSourceConfig(dialect)!;
        const diffSchema = driver.locator('[data-testid="diff-schema-0"]');
        if ((await diffSchema.count()) > 0) {
          await diffSchema.fill(cfg.schema || cfg.database);
        }

        await driver.locator('[data-testid="diff-load-catalog"]').click();

        // The wait used to accept the panel's own placeholder — "Load the
        // catalog" is on screen before anything is loaded, so it was satisfied
        // instantly and nothing after it asserted anything. Wait for a result:
        // a summary, the comparison table, or an explicit error.
        // `diff-empty` is the same element before and after loading — only its
        // wording changes — so waiting for it to exist would pass instantly on
        // the placeholder. Wait for an outcome instead.
        const settled = await driver
          .waitForFunction(
            () => {
              if (document.querySelector('[data-testid="diff-summary"]')) return true;
              if (document.querySelector('[data-testid="diff-table"]')) return true;
              if (document.querySelector('[data-testid="diff-load-error"]')) return true;
              const empty = document.querySelector('[data-testid="diff-empty"]');
              return empty !== null && /No privileges found/i.test(empty.textContent ?? '');
            },
            undefined,
            { timeout: 150_000 }
          )
          .then(() => true)
          .catch(() => false);
        // A bare test timeout says only "150s elapsed". This says what did not
        // happen, which is the difference between a slow engine and a panel
        // that finished and then showed nothing.
        expect(
          settled,
          `${dialect}: Permission Diff produced neither a comparison nor an answer within 150s`
        ).toBe(true);

        const failed = driver.locator(
          '[data-testid="diff-load-error"]'
        );
        if ((await failed.count()) > 0) {
          // A container that is down, or a catalog this account cannot read,
          // says so. Anything else is the diff itself being broken.
          expect(await failed.innerText(), `${dialect} failed to diff`).toMatch(
            /not responding|ECONNREFUSED|timed? ?out|terminated|refused|too many requests|permission|privileg|recovery mode|starting up|shutting down/i
          );
          return;
        }

        // Loading a catalog that comes back with no privileges is a real
        // outcome — Oracle and TiDB do exactly that here — but it has to be
        // said. It used to leave the panel repeating "Load the catalog", so the
        // button looked like it had done nothing.
        const empty = driver.locator('[data-testid="diff-empty"]');
        if ((await empty.count()) > 0) {
          expect(await empty.innerText(), `${dialect} loaded but says nothing`).toMatch(
            /No privileges found/i
          );
          return;
        }

        // `report_user` does not exist on these databases, so every desired
        // privilege is missing — the diff has to say so rather than report a
        // clean match, which is what an empty comparison would look like.
        const summary = await driver.locator('[data-testid="diff-summary"]').innerText();
        expect(summary.toLowerCase(), `${dialect} produced an empty diff`).toMatch(
          /missing|extra|match/
        );

        await saveScreenshot(driver, `access-diff-${dialect}`);
      }, 200_000);
    });
  }
});
