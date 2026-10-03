/**
 * Migrations in Git, end to end in a real browser, against Postgres and a
 * real Git server (git http-backend, started here).
 *
 * Compare → Commit to Git (the exact file shown first) → push → Execute runs
 * it from the commit → Applies → Git shows it applied. Then a teammate pushes
 * a migration of their own: Fetch, Pull, and it appears as incoming; Run
 * applies it from its commit.
 *
 * Needs the Postgres demo databases (E2E_POSTGRES_*), and the dev API started
 * with FOX_GIT_ALLOW_HTTP=1 (the dev:api script sets it) since the local Git
 * server speaks plain HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { sessionCookie } from '../helpers/app-session.js';
import { getSourceConfig, getTargetConfig, hasConfig } from '../helpers/db-config.js';
import { tryCleanup } from '../helpers/sql-exec.js';
import { AppPage } from '../pages/AppPage.js';
import { ConnectionModal } from '../pages/ConnectionModal.js';
import { MigrationPage } from '../pages/MigrationPage.js';

/**
 * The real Git server the server's own tests use (packages/server), loaded at
 * runtime: the e2e TypeScript project may not include files outside it, and a
 * copy here would drift.
 */
interface TestGitServer {
  url: string;
  token: string;
  teammateCommit(branch: string, files: Record<string, string>, message: string): string;
  show(ref: string, path: string): string | null;
  close(): Promise<void>;
}
const GIT_SERVER_HELPER = new URL('../../../../packages/server/src/features/git/test-git-server.ts', import.meta.url).href;
async function startTestGitServer(): Promise<TestGitServer> {
  const mod = (await import(/* @vite-ignore */ GIT_SERVER_HELPER)) as { startTestGitServer: () => Promise<TestGitServer> };
  return mod.startTestGitServer();
}

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';
const AUDIT_TABLE = `e2e_git_audit_${Date.now()}`;

let server: TestGitServer;
let admin = '';
let repoId = '';
let driver: Page;
let app: AppPage;
let modal: ConnectionModal;
let migration: MigrationPage;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: admin },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

describe.skipIf(!hasConfig('postgres'))('Migrations in Git (Postgres)', () => {
  beforeAll(async () => {
    server = await startTestGitServer();
    admin = await sessionCookie();
    const created = await api('POST', '/git/repos', {
      name: `e2e ${Date.now()}`,
      remoteUrl: server.url,
      defaultBranch: 'main',
      token: server.token,
    });
    if (created.status !== 200) {
      throw new Error(
        `Could not add the test repository (${created.status} ${JSON.stringify(created.json)}). ` +
          'Is the dev API running with FOX_GIT_ALLOW_HTTP=1?'
      );
    }
    repoId = created.json.repo.id;
    driver = await buildDriver();
    driver.on('dialog', (d) => void d.accept());
    app = new AppPage(driver);
    modal = new ConnectionModal(driver);
    migration = new MigrationPage(driver);
  }, 120_000);

  afterAll(async () => {
    await tryCleanup('postgres', [`DROP TABLE IF EXISTS demo_b.${AUDIT_TABLE}`]);
    if (repoId) await api('DELETE', `/git/repos/${repoId}`);
    if (driver) await quitDriver(driver);
    await server?.close();
  });

  it('compares the Postgres demo schemas', async () => {
    await app.open();
    await app.openSourceModal();
    await modal.connect(getSourceConfig('postgres')!);
    await app.waitForSourceConnected(30_000);
    await app.openTargetModal();
    await modal.connect(getTargetConfig('postgres')!);
    await app.waitForTargetConnected(30_000);
    await app.waitForSourceConnected(30_000);
    await app.runCompare();
    expect(await app.getDiffCount()).toBeGreaterThan(0);
    await migration.setNonDestructive(true);
    await migration.selectAllObjects(true);
    await migration.acknowledgeSafetyWarnings();
  }, 120_000);

  it('commits the plan after showing the exact file, and pushes it', async () => {
    await driver.click('[data-testid="git-commit-btn"]');
    await driver.waitForSelector('[data-testid="git-commit-dialog"]');
    // This run's repository, not whichever sorts first: one left by an earlier run would win.
    await driver.selectOption('#git-commit-repo', repoId);
    await expect.poll(() => driver.inputValue('#git-commit-branch'), { timeout: 15_000 }).toBe('main');
    await driver.fill('#git-commit-note', 'Sync demo_b with demo_a');
    const preview = driver.locator('[data-testid="git-commit-preview"]');
    await preview.waitFor({ timeout: 15_000 });
    expect(await preview.textContent()).toContain('-- fox:migration v1\n-- note: Sync demo_b with demo_a');
    await driver.click('[data-testid="git-commit-push"]');
    await driver.waitForSelector('[data-testid="git-commit-dialog"]', { state: 'detached', timeout: 20_000 });

    const listed = await api('POST', `/git/repos/${repoId}/migrations`, { branch: 'main' });
    expect(listed.json.migrations).toHaveLength(1);
    expect(server.show('main', listed.json.migrations[0].path)).toContain('-- note: Sync demo_b with demo_a');
  }, 60_000);

  it('executes the plan from its commit', async () => {
    const execute = driver.locator('[data-testid="execute-btn"]');
    expect(await execute.textContent()).toMatch(/Execute committed [0-9a-f]{7}/);
    await migration.clickExecute();
    await migration.confirmDeploy();
    expect(await migration.waitForMigrationDone(120_000)).toBe('complete');
  }, 180_000);

  it('shows it applied in Applies → Git', async () => {
    await migration.openHistory();
    await driver.click('[data-testid="applies-git-btn"]');
    await driver.locator('[data-testid="git-branch-view"]').waitFor();
    await driver.getByLabel('Repository').selectOption(repoId);
    // The row itself: "Applied" also appears in the view's explanatory text.
    const row = driver.locator('[data-testid^="git-migration-"]', { hasText: 'Sync demo_b with demo_a' });
    await row.waitFor({ timeout: 15_000 });
    await expect.poll(() => row.textContent(), { timeout: 15_000 }).toMatch(/Applied/);
  }, 60_000);

  it("fetches and pulls a teammate's migration, and runs it from its commit", async () => {
    const preview = await api('POST', `/git/repos/${repoId}/preview`, {
      steps: [{ action: 'CREATE', objectType: 'TABLE', objectName: AUDIT_TABLE, statements: [`CREATE TABLE demo_b.${AUDIT_TABLE} (id int PRIMARY KEY)`] }],
      note: 'Add the audit table',
      dialect: 'postgres',
    });
    server.teammateCommit('main', { [preview.json.path]: preview.json.content }, 'Add the audit table');

    await driver.getByRole('button', { name: 'Fetch' }).click();
    await driver.waitForFunction(() => document.querySelector('[data-testid="git-ahead-behind"]')?.textContent?.startsWith('1 behind'), undefined, { timeout: 15_000 });
    await driver.getByRole('button', { name: 'Pull' }).click();
    const runButton = driver.locator(`[data-testid="git-run-${preview.json.fileName}"]`);
    await runButton.waitFor({ timeout: 15_000 });
    await runButton.click();
    await driver.waitForFunction(
      (file) => document.querySelector(`[data-testid="git-migration-${file}"]`)?.textContent?.includes('Applied'),
      preview.json.fileName,
      { timeout: 60_000 }
    );
    const applied = await api('POST', `/git/repos/${repoId}/migrations`, { branch: 'main', ...{ dialect: 'postgres', option: { host: getTargetConfig('postgres')!.host, port: getTargetConfig('postgres')!.port, database: getTargetConfig('postgres')!.database, username: getTargetConfig('postgres')!.username, password: getTargetConfig('postgres')!.password }, schema: 'demo_b' } });
    const theirs = applied.json.migrations.find((m: { path: string }) => m.path === preview.json.path);
    expect(theirs).toMatchObject({ incoming: false, applied: { status: 'SUCCESS' } });
  }, 120_000);
});
