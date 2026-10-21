/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Opening a workflow in the designer and saving it keeps what the designer
 * does not edit — a pipe's timeout, the workflow's version, error handler,
 * display name, the trust its origin records, and a retry policy beyond its
 * attempts. Saving used to drop each: an imported workflow came back
 * `authored`, renamed to its id, with the engine's default retry.
 *
 * Needs the web app at E2E_BASE_URL and workflow-server on :8081 with no
 * service token (loopback dev); skips when the engine is not there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, clickWhen, quitDriver, waitFor } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';
import { AppPage } from '../pages/AppPage.js';
import { WorkflowPage } from '../pages/WorkflowPage.js';

const ENGINE = 'http://127.0.0.1:8081/api';
const ID = 'e2e-designer-carry';
const HANDLER = 'e2e-designer-carry-handler';

const doc = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
  pipelines: [
    {
      id: 'main',
      name: 'Main',
      pipes: [
        {
          id: 'start',
          type: 'source.triggerPayload',
          role: 'source',
          config: {},
          timeoutMs: 1234,
          // Beyond the attempts the canvas edits: a save used to drop the rest.
          retry: { attempts: 5, backoff: 'fixed', maxDelayMs: 900, jitter: false, on: 'all' },
        },
      ],
      edges: [],
    },
  ],
  ...extra,
});

async function engine(method: string, path: string, body?: unknown) {
  const res = await fetch(`${ENGINE}${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

let driver: Page;
let engineUp = false;

beforeAll(async () => {
  engineUp = await fetch('http://127.0.0.1:8081/health').then((r) => r.ok, () => false);
  if (!engineUp) return;
  expect((await engine('PUT', `/workflows/${HANDLER}`, doc(HANDLER))).status).toBe(200);
  const seeded = await engine(
    'PUT',
    `/workflows/${ID}`,
    doc(ID, { name: 'Carry check', version: 4, origin: 'imported', errorHandler: { workflowId: HANDLER } }),
  );
  expect(seeded.status, JSON.stringify(seeded.json)).toBe(200);
  driver = await buildDriver();
});

afterAll(async () => {
  if (driver) await quitDriver(driver);
  if (engineUp) {
    await engine('DELETE', `/workflows/${ID}`);
    await engine('DELETE', `/workflows/${HANDLER}`);
  }
});

describe('workflow designer round trip', () => {
  it('keeps every field it does not edit through a load and a save', async (ctx) => {
    if (!engineUp) ctx.skip();
    await new AppPage(driver).open();
    const workflow = new WorkflowPage(driver);
    await workflow.openView();
    await workflow.openTab('designer');

    await (await waitFor(driver, byTestId('workflow-designer-id'))).fill(ID);
    await clickWhen(driver, byTestId('workflow-designer-load'));
    await driver.waitForFunction(
      (selector) => !(document.querySelector(selector) as HTMLButtonElement | null)?.disabled,
      byTestId('workflow-designer-save'),
      { timeout: 15_000 },
    );
    const saved = driver.waitForResponse(
      (response) => response.request().method() === 'PUT' && response.url().includes(`/workflow/engine/workflows/${ID}`),
      { timeout: 15_000 },
    );
    await clickWhen(driver, byTestId('workflow-designer-save'));
    expect((await saved).status()).toBe(200);

    const after = (await engine('GET', `/workflows/${ID}`)).json;
    expect(after).toMatchObject({
      name: 'Carry check',
      version: 4,
      origin: 'imported',
      errorHandler: { workflowId: HANDLER },
    });
    expect(after.pipelines[0].pipes[0].timeoutMs).toBe(1234);
    expect(after.pipelines[0].pipes[0].retry).toEqual({ attempts: 5, backoff: 'fixed', maxDelayMs: 900, jitter: false, on: 'all' });
  });

  it('shows only the trigger sections that have a form, and no dead buttons', async (ctx) => {
    if (!engineUp) ctx.skip();
    await clickWhen(driver, byTestId('workflow-designer-triggers'));
    const dialog = await waitFor(driver, byTestId('workflow-trigger-config'));
    expect(await driver.locator(byTestId('workflow-trigger-config-note')).isVisible()).toBe(true);
    expect(await dialog.getByRole('button', { name: 'Test trigger' }).count()).toBe(0);
    expect(await dialog.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
    const sections = await driver.locator('[data-testid^="workflow-trigger-config-section-"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    expect(sections).toEqual([
      'workflow-trigger-config-section-general',
      'workflow-trigger-config-section-input parameters',
    ]);
    await driver.screenshot({ path: process.env.E2E_SHOT ?? '/tmp/workflow-trigger-dialog.png' });
  });

  it('keeps the section you are in while you type in a trigger', async (ctx) => {
    // The dialog used to re-sync its selection from props in an effect; with
    // the triggers among its dependencies, every keystroke snapped it back to
    // General. Mounted only while open, it starts once and stays put.
    if (!engineUp) ctx.skip();
    const section = driver.locator('[data-testid="workflow-trigger-config-section-input parameters"]');
    await section.click();
    await driver.locator(`${byTestId('workflow-trigger-config')} .monaco-editor .view-lines`).click();
    await driver.keyboard.type('{"region": "west"}');
    expect(await section.getAttribute('class')).toContain('active');
    expect(await driver.locator(`${byTestId('workflow-trigger-config')} .monaco-editor`).isVisible()).toBe(true);
  });
});
