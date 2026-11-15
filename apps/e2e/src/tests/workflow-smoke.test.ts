/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow smoke: rail entry, RBAC-visible panes for local admin, Engine panel.
 * Needs the web app at E2E_BASE_URL (default http://localhost:5173).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
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

    for (const tab of ['designer', 'workflows', 'runs', 'variables', 'credentials', 'engine'] as const) {
      expect(await workflow.tab(tab).isVisible()).toBe(true);
    }
  });

  it('opens the Engine pane and shows admission controls', async () => {
    const workflow = new WorkflowPage(driver);
    await workflow.openTab('engine');
    await driver.waitForSelector('[data-testid="workflow-engine-max-parallel"]', { timeout: 20_000 });
    expect(await driver.locator('[data-testid="workflow-engine"]').isVisible()).toBe(true);
    expect(await driver.locator('[data-testid="workflow-engine-health"]').isVisible()).toBe(true);
    expect(await driver.locator('[data-testid="workflow-engine-enabled"]').isVisible()).toBe(true);
  });

  it('reports the in-process engine as ready', async () => {
    const workflow = new WorkflowPage(driver);
    await workflow.openTab('engine');
    await driver.waitForSelector('[data-testid="workflow-engine-health"]', { timeout: 15_000 });
    const health = await driver.locator('[data-testid="workflow-engine-health"]').textContent();
    expect(health?.toLowerCase()).toMatch(/ready|ok|enabled|not taking runs/);
  });
});
