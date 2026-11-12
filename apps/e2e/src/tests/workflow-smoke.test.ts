/**
 * Workflow smoke: rail entry, RBAC-visible panes for local admin, Engine panel.
 * Needs the web app at E2E_BASE_URL (default http://localhost:5173).
 * Engine health is asserted when workflow-server is reachable on :8081.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver, BASE_URL } from '../helpers/driver.js';
import { AppPage } from '../pages/AppPage.js';
import { WorkflowPage } from '../pages/WorkflowPage.js';
import { WORKFLOW_ON_RAIL } from '../helpers/features.js';

let driver: Page;

beforeAll(async () => {
  driver = await buildDriver();
});

afterAll(async () => {
  await quitDriver(driver);
});

describe.skipIf(!WORKFLOW_ON_RAIL)('Workflow workspace', () => {
  it('opens from the activity rail and shows owner panes', async () => {
    const app = new AppPage(driver);
    await app.open();
    const workflow = new WorkflowPage(driver);
    await workflow.openView();

    expect(await driver.locator('[data-testid="workflow-view"]').isVisible()).toBe(true);
    expect(await driver.locator('[data-testid="workflow-menu"]').isVisible()).toBe(true);

    // Local single-user is admin → every pane is allowed.
    for (const tab of ['designer', 'workflows', 'runs', 'variables', 'credentials', 'engine'] as const) {
      expect(await workflow.tab(tab).isVisible()).toBe(true);
    }
  });

  it('opens the Engine pane and shows health chrome', async () => {
    const workflow = new WorkflowPage(driver);
    await workflow.openTab('engine');
    // Loading state shares workflow-engine — wait until settings hydrate.
    await driver.waitForSelector('[data-testid="workflow-engine-endpoint"]', { timeout: 20_000 });
    expect(await driver.locator('[data-testid="workflow-engine"]').isVisible()).toBe(true);
    expect(await driver.locator('[data-testid="workflow-engine-endpoint"]').isVisible()).toBe(true);
    expect(await driver.locator('[data-testid="workflow-engine-health"]').isVisible()).toBe(true);
  });

  it('reports engine health when workflow-server is up', async () => {
    let engineUp = false;
    try {
      const res = await fetch('http://127.0.0.1:8081/health');
      engineUp = res.ok;
    } catch {
      engineUp = false;
    }
    if (!engineUp) {
      // Soft skip: engine is an optional second process in local/cloud setups.
      console.warn(`[workflow e2e] workflow-server not on :8081 — skipped health probe (BASE_URL=${BASE_URL})`);
      return;
    }

    const workflow = new WorkflowPage(driver);
    await workflow.openTab('engine');
    const refresh = driver.locator('[data-testid="workflow-engine-refresh-health"]');
    if (await refresh.isVisible().catch(() => false)) {
      await refresh.click();
    }
    await driver.waitForSelector('[data-testid="workflow-engine-health"]', { timeout: 15_000 });
    const health = await driver.locator('[data-testid="workflow-engine-health"]').textContent();
    expect(health?.toLowerCase()).toMatch(/ok|healthy|online|up|reachable|enabled/);
  });
});
