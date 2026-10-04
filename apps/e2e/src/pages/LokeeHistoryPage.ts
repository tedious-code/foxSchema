/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Page object for Schema Sync → History (Lokee schema version graph).
 */
import type { Page } from 'playwright';
import { clickWhen, waitFor } from '../helpers/driver.js';
import { clickRateLimited } from '../helpers/rate-limited.js';
import { byTestId } from '../helpers/test-ids.js';

export class LokeeHistoryPage {
  constructor(private page: Page) {}

  async openHistoryPane(): Promise<void> {
    const historyView = this.page.locator(byTestId('lokee-weave-view'));
    if (await historyView.isVisible().catch(() => false)) return;
    const syncBtn = this.page.locator(byTestId('view-sync-btn'));
    if (await syncBtn.isVisible().catch(() => false)) {
      await clickWhen(this.page, byTestId('view-sync-btn'));
    }
    await clickWhen(this.page, byTestId('sync-pane-history-btn'));
    await waitFor(this.page, byTestId('lokee-weave-view'), 20_000);
  }

  async openComparePane(): Promise<void> {
    // Snapshots is its own workspace now, and the toolbar's pane switcher only
    // exists while `activeView === 'sync'`. Coming back from Snapshots means
    // selecting Sync first — reaching straight for the Compare pill waited 15s
    // for a control that is not on that screen, which is what failed this test
    // on every dialect at once.
    const rail = this.page.locator(byTestId('view-sync-btn'));
    if (await rail.isVisible().catch(() => false)) {
      await clickWhen(this.page, byTestId('view-sync-btn'));
    }
    await clickWhen(this.page, byTestId('sync-pane-compare-btn'));
  }

  async snapshotTarget(): Promise<void> {
    // The button lives on the Sync workspace's compare pane. A second snapshot
    // is usually taken after looking at the first one, from Snapshots, where
    // the button is not on screen at all.
    await this.openComparePane();
    // Wait for the capture request's answer, not for the UI: the toolbar's
    // compare controls leave the DOM when capture bumps the Lokee epoch, and
    // "button idle" can be true before the request has even been sent.
    await clickRateLimited(this.page, {
      label: 'Snapshot',
      path: /\/api\/lokee\/capture$/,
      click: () => this.pressWhenEnabled('lokee-snapshot-target-btn'),
    });
  }

  /** Wait until the button is on screen and enabled, then press it. */
  private async pressWhenEnabled(testId: string, timeout = 15_000): Promise<void> {
    const btn = this.page.locator(`[data-testid="${testId}"]`);
    await btn.waitFor({ state: 'visible', timeout });
    await this.page.waitForFunction(
      (id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el instanceof HTMLButtonElement && !el.disabled;
      },
      testId,
      { timeout }
    );
    await btn.click();
  }

  async waitForVersionCount(n: number, timeoutMs = 30_000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const el = document.querySelector('[data-testid="lokee-summary"]');
        // innerText, not textContent: the summary is a row of sibling spans, so
        // textContent runs them together as "…2 versions10 objects…" and the
        // trailing \b never matches — `s` meets `1`, both word characters.
        const text = (el as HTMLElement | null)?.innerText ?? '';
        return new RegExp(`\\b${expected}\\s+versions?\\b`, 'i').test(text);
      },
      n,
      { timeout: timeoutMs }
    );
  }

  async waitForGraph(timeoutMs = 30_000): Promise<void> {
    // Ask the toggle whether the graph is on, rather than inferring it from
    // whether the graph is on screen: while a database's history is loading the
    // graph is absent either way, and a click made on that guess landed after
    // the load and switched a graph that was already on, off.
    const toggle = this.page.locator(byTestId('lokee-graph-toggle'));
    await toggle.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
      await clickWhen(this.page, byTestId('lokee-graph-toggle'));
    }
    await waitFor(this.page, byTestId('lokee-weave-page'), timeoutMs);
    await this.page.locator('[data-testid^="rf-version-"]').first().waitFor({ timeout: timeoutMs });
  }

  async hasStandaloneLokeeTab(): Promise<boolean> {
    return this.page.locator('[data-testid="view-lokee-weave-btn"]').isVisible();
  }

  async selectSavedTargetByName(name: string): Promise<void> {
    const trigger = this.page.locator(byTestId('target-saved-select-trigger'));
    await trigger.waitFor({ state: 'visible', timeout: 15_000 });
    await trigger.click();
    const filter = this.page.locator(byTestId('target-saved-select-filter'));
    await filter.waitFor({ state: 'visible', timeout: 5_000 });
    await filter.fill(name);
    const option = this.page
      .locator('[data-testid^="target-saved-select-option-"]')
      .filter({ hasText: name })
      .first();
    await option.waitFor({ state: 'visible', timeout: 15_000 });
    await option.click();
  }

  /** Single owner of the object-node selector, shared by every accessor below. */
  private objectNode(name: string) {
    return this.page.locator('[data-testid^="rf-object-"]').filter({ hasText: name }).first();
  }

  async clickObjectNamed(name: string): Promise<void> {
    const node = this.objectNode(name);
    await node.waitFor({ state: 'visible', timeout: 15_000 });
    try {
      await node.click({ timeout: 5_000 });
    } catch {
      // React Flow clips its pane, so a node in a far-right column can sit
      // outside the viewport. Fit the graph and click again for real — a
      // dispatched synthetic click would bypass the actionability check, which
      // is the one thing this test exists to prove a user can do.
      await this.page.locator('.react-flow__controls-fitview').click({ timeout: 5_000 });
      await node.click({ timeout: 5_000 });
    }
    await this.waitForInspectorLoaded();
  }

  /**
   * The inspector shell renders immediately and fills in after an async fetch,
   * so callers must not read it until the payload is in. `data-state` is set by
   * the component; matching on it beats string-matching the loading copy.
   */
  async waitForInspectorLoaded(timeoutMs = 20_000): Promise<void> {
    await this.page.waitForSelector('[data-testid="lokee-object-inspector"][data-state="ready"]', {
      timeout: timeoutMs,
    });
  }

  async objectNamedVisible(name: string, timeoutMs = 5_000): Promise<boolean> {
    return this.objectNode(name)
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
  }

  /** Sections render only once loaded, so callers must await the inspector first. */
  async inspectorHasSection(section: 'growth' | 'source' | 'history'): Promise<boolean> {
    return this.page.locator(byTestId(`lokee-inspector-${section}`)).isVisible();
  }

  /**
   * Columns / indexes / keys / triggers are `SchemaBlueprint` now — the same
   * component Compare Schema renders — so they carry `blueprint-*` ids wherever
   * they appear rather than an inspector-specific one.
   */
  async blueprintHasSection(
    section: 'summary' | 'columns' | 'primary-key' | 'indexes' | 'foreign-keys' | 'triggers'
  ): Promise<boolean> {
    return this.page.locator(byTestId(`blueprint-${section}`)).isVisible();
  }

  async inspectorText(): Promise<string> {
    return (await this.page.locator(byTestId('lokee-object-inspector')).innerText()) ?? '';
  }

  async summaryText(): Promise<string> {
    return (await this.page.locator(byTestId('lokee-summary')).innerText()) ?? '';
  }

  async selectHistoryDatabaseContaining(text: string): Promise<void> {
    const select = this.page.locator(byTestId('lokee-database-select'));
    await select.waitFor({ state: 'visible', timeout: 20_000 });
    const option = select.locator('option', { hasText: text });
    await option.waitFor({ state: 'attached', timeout: 20_000 });
    const value = await option.getAttribute('value');
    if (!value) throw new Error(`No history database option matching ${text}`);
    await select.selectOption(value);
  }

  async versionCount(): Promise<number> {
    const text = await this.summaryText();
    const match = text.match(/(\d+)\s+versions?\b/i);
    return match ? Number(match[1]) : 0;
  }

  async typeFilterVisible(type: string): Promise<boolean> {
    return this.page.locator(byTestId(`lokee-rf-type-${type}`)).isVisible();
  }

  async enableType(type: string): Promise<void> {
    const box = this.page.locator(byTestId(`lokee-rf-type-${type}`));
    await box.waitFor({ state: 'visible', timeout: 10_000 });
    if (!(await box.isChecked())) await box.check();
  }

  // ── Compare versions → revert ────────────────────────────────────────────

  /** Pick the Original side by its visible label (e.g. "Version 1"). */
  async selectOriginalVersion(label: string): Promise<void> {
    await this.selectVersionOption('lokee-original-version', label);
  }

  /** Pick Target by label. Use `selectTargetCurrent()` for the latest snapshot. */
  async selectTargetVersion(label: string): Promise<void> {
    await this.selectVersionOption('lokee-target-version', label);
  }

  async selectTargetCurrent(): Promise<void> {
    const select = this.page.locator(byTestId('lokee-target-version'));
    await select.waitFor({ state: 'visible', timeout: 20_000 });
    await select.selectOption('');
  }

  private async selectVersionOption(testId: string, label: string): Promise<void> {
    const select = this.page.locator(`[data-testid="${testId}"]`);
    await select.waitFor({ state: 'visible', timeout: 20_000 });
    const option = select.locator('option', { hasText: label });
    await option.waitFor({ state: 'attached', timeout: 20_000 });
    const value = await option.getAttribute('value');
    if (value == null) throw new Error(`No ${testId} option matching ${label}`);
    await select.selectOption(value);
  }

  async originalVersionLabels(): Promise<string[]> {
    const select = this.page.locator(byTestId('lokee-original-version'));
    await select.waitFor({ state: 'visible', timeout: 20_000 });
    return select.locator('option').allTextContents();
  }

  async graphVersionNodeCount(): Promise<number> {
    return this.page.locator('[data-testid^="rf-version-"]').count();
  }

  async compareVersionsButtonVisible(): Promise<boolean> {
    return this.page.locator(byTestId('lokee-compare-versions-btn')).isVisible();
  }

  async openCompareModal(): Promise<void> {
    await clickWhen(this.page, byTestId('lokee-compare-versions-btn'));
    await this.page.waitForSelector('[data-testid="lokee-version-compare"][data-state="ready"]', {
      timeout: 30_000,
    });
  }

  async compareTab(tab: 'DIFF' | 'DDL_DIFF' | 'SQL'): Promise<void> {
    await clickWhen(this.page, byTestId(`lokee-cmp-tab-${tab}`));
  }

  async migrationSqlText(): Promise<string> {
    await this.compareTab('SQL');
    const pane = this.page.locator(byTestId('lokee-cmp-ddl'));
    await pane.waitFor({ state: 'visible', timeout: 20_000 });
    return pane.innerText();
  }

  /**
   * Apply the revert. A lossy plan parks the button on "Review data loss…",
   * which navigates to Migration SQL rather than running — acknowledge there,
   * then press it again. A safe plan runs on the first press.
   */
  async executeRevert(): Promise<void> {
    const run = this.page.locator(byTestId('lokee-cmp-run-revert'));
    await clickRateLimited(this.page, {
      label: 'Revert',
      path: /\/api\/lokee\/databases\/[^/]+\/revert$/,
      click: async () => {
        await run.waitFor({ state: 'visible', timeout: 20_000 });
        await this.page.waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="lokee-cmp-run-revert"]');
            return el instanceof HTMLButtonElement && !el.disabled;
          },
          { timeout: 30_000 }
        );
        // A lossy plan parks the button on "Review data loss…", which opens
        // Migration SQL rather than running. A retry after a refusal finds the
        // box already ticked and the button ready to run.
        if ((await run.innerText()).includes('Review data loss')) {
          await run.click();
          const ack = this.page.locator(byTestId('lokee-cmp-confirm-lossy'));
          await ack.waitFor({ state: 'visible', timeout: 10_000 });
          await ack.check();
        }
        await run.click();
      },
    });
  }

  /** Visible toast text, so a failed revert reports the driver's reason. */
  async toastText(): Promise<string> {
    const toasts = this.page.locator(byTestId('app-toast'));
    const count = await toasts.count();
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      parts.push((await toasts.nth(i).innerText().catch(() => '')) ?? '');
    }
    return parts.join(' | ');
  }

  async compareModalOpen(): Promise<boolean> {
    return this.page.locator(byTestId('lokee-version-compare')).isVisible();
  }

  async closeCompareModal(): Promise<void> {
    if (!(await this.compareModalOpen())) return;
    await clickWhen(this.page, byTestId('lokee-version-compare-close'));
    await this.page.waitForSelector(byTestId('lokee-version-compare'), {
      state: 'detached',
      timeout: 15_000,
    });
  }

  async compareSummaryText(): Promise<string> {
    const el = this.page.locator(byTestId('lokee-cmp-summary'));
    await el.waitFor({ state: 'visible', timeout: 20_000 });
    return (await el.innerText()) ?? '';
  }

  async compareIdenticalVisible(): Promise<boolean> {
    return this.page.locator(byTestId('lokee-cmp-identical')).isVisible();
  }

  /**
   * The compare summary's object counts. The summary is the shared
   * `+N ~N −N` briefing chips (DiffBriefingChips), not words.
   */
  async compareChangeCounts(): Promise<{ added: number; modified: number; removed: number }> {
    const text = await this.compareSummaryText();
    const count = (glyph: string): number => {
      const m = text.match(new RegExp(`${glyph}\\s*(\\d+)`));
      if (!m) throw new Error(`No ${glyph} count in compare summary: ${JSON.stringify(text)}`);
      return Number(m[1]);
    };
    return { added: count('\\+'), modified: count('~'), removed: count('−') };
  }

  /**
   * The run button's label once planning has settled. The label changes as
   * the plan for the current selection arrives, so reading it straight after
   * a tick can catch "Planning…" instead of the decision.
   */
  async settledRunRevertLabel(timeout = 30_000): Promise<string> {
    const run = this.page.locator(byTestId('lokee-cmp-run-revert'));
    await run.waitFor({ state: 'visible', timeout: 20_000 });
    const deadline = Date.now() + timeout;
    let label = (await run.innerText()) ?? '';
    while (/Planning…/.test(label) && Date.now() < deadline) {
      await this.page.waitForTimeout(200);
      label = (await run.innerText()) ?? '';
    }
    return label;
  }

  async runRevertButtonText(): Promise<string> {
    const run = this.page.locator(byTestId('lokee-cmp-run-revert'));
    await run.waitFor({ state: 'visible', timeout: 20_000 });
    return (await run.innerText()) ?? '';
  }

  async runRevertDisabled(): Promise<boolean> {
    const run = this.page.locator(byTestId('lokee-cmp-run-revert'));
    await run.waitFor({ state: 'visible', timeout: 20_000 });
    return run.isDisabled();
  }

  /** Tick/untick a changed object in the shared SchemaDiffTree. */
  async toggleCompareObject(tableName: string): Promise<void> {
    const row = this.page.locator(`[data-testid="diff-item"][data-object="${tableName}"]`);
    await row.waitFor({ state: 'visible', timeout: 20_000 });
    const box = row.locator('input[type="checkbox"]');
    await box.waitFor({ state: 'visible', timeout: 10_000 });
    await box.click();
  }

  /**
   * Tick every changed object. Required before Execute: an empty tick set is
   * refused rather than silently widening to the whole schema, which is what
   * used to revert an entire database from a dialog with nothing selected.
   */
  async selectAllCompareObjects(): Promise<void> {
    await clickWhen(this.page, byTestId('lokee-cmp-select-all'));
  }

  async compareObjectNames(): Promise<string[]> {
    const items = this.page.locator(byTestId('diff-item'));
    try {
      await items.first().waitFor({ state: 'visible', timeout: 20_000 });
    } catch (error) {
      // "no diff rows" and "the dialog says the versions are identical" look
      // the same from a timeout, and they have opposite causes.
      const open = await this.compareModalOpen();
      const identical = await this.compareIdenticalVisible().catch(() => false);
      const summary = await this.compareSummaryText().catch(() => '');
      throw new Error(
        `No objects in the compare tree. modalOpen=${open} identical=${identical} summary=${summary}`,
        { cause: error }
      );
    }
    const count = await items.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      names.push((await items.nth(i).getAttribute('data-object')) ?? '');
    }
    return names.filter(Boolean);
  }

  async captureFromHistoryBar(): Promise<void> {
    await clickRateLimited(this.page, {
      label: 'Capture',
      path: /\/api\/lokee\/capture$/,
      click: () => this.pressWhenEnabled('lokee-capture-btn'),
    });
  }

  /** "↩ reverted to vN" labels on the version nodes, newest first. */
  async revertedToLabels(): Promise<string[]> {
    const marks = this.page.locator('[data-testid^="rf-version-revert-"]');
    const count = await marks.count();
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      out.push((await marks.nth(i).innerText().catch(() => '')) ?? '');
    }
    return out;
  }
}
