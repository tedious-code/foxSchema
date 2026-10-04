import type { Page } from 'playwright';
import { waitFor, clickWhen } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';

/**
 * Page object covering the execute → progress → history flow.
 */
export class MigrationPage {
  constructor(private page: Page) {}

  // ── Select-all checkbox in the schema tree panel ────────────────────────

  /** Check/uncheck the global "Deploy to Target" checkbox in the tree header. */
  async selectAllObjects(check: boolean): Promise<void> {
    const cb = this.page.locator('[data-testid="schema-tree"] input[type="checkbox"]').first();
    await cb.waitFor({ state: 'visible' });
    const current = await cb.isChecked();
    if (current !== check) await cb.click();
  }

  /** Check/uncheck the "No drops" (non-destructive) toggle in the tree header. */
  async setNonDestructive(check: boolean): Promise<void> {
    const cb = this.page.locator(byTestId('non-destructive-checkbox'));
    await cb.waitFor({ state: 'visible' });
    const current = await cb.isChecked();
    if (current !== check) await cb.click();
  }

  /**
   * Tick any safety-acknowledgment checkboxes currently rendered above the
   * Execute button (destructive drops, MySQL binlog risk). Each only renders
   * when its risk condition is active, so this is a no-op when absent —
   * safe to call unconditionally before every Execute click.
   */
  async acknowledgeSafetyWarnings(): Promise<void> {
    for (const testId of ['ack-destructive-drops', 'ack-mysql-binlog-risk']) {
      const cb = this.page.locator(`[data-testid="${testId}"]`);
      if (await cb.count() > 0 && !(await cb.isChecked())) {
        await cb.click();
      }
    }
  }

  // ── Execute button ──────────────────────────────────────────────────────

  async clickExecute(): Promise<void> {
    await clickWhen(this.page, byTestId('execute-btn'));
  }

  async isExecuteEnabled(): Promise<boolean> {
    const btn = await waitFor(this.page, byTestId('execute-btn'));
    return !(await btn.isDisabled());
  }

  // ── Confirm dialog ─────────────────────────────────────────────────────

  async isConfirmDialogVisible(): Promise<boolean> {
    return this.page.locator(byTestId('deploy-confirm-dialog')).isVisible();
  }

  /**
   * Confirm the deploy dialog when present.
   * Returns `'confirmed'` when the dialog was shown and dismissed via Confirm,
   * `'skipped'` when no dialog appeared (e.g. "don't ask again" / already deploying).
   * Throws if the dialog remains open after Confirm (deploy never started).
   */
  async confirmDeploy(): Promise<'confirmed' | 'skipped'> {
    const dialog = this.page.locator(byTestId('deploy-confirm-dialog'));
    const progressPanel = this.page.locator(byTestId('migration-progress-panel'));
    // Dialog mounts after Execute. If the user previously chose "don't ask
    // again", it never appears — progress may already be on screen.
    const appeared = await dialog
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      return 'skipped';
    }
    await clickWhen(this.page, byTestId('deploy-confirm-btn'));
    // Confirm must either close the dialog or reveal the progress panel.
    await Promise.race([
      dialog.waitFor({ state: 'hidden', timeout: 15_000 }),
      progressPanel.waitFor({ state: 'visible', timeout: 15_000 }),
    ]).catch(() => undefined);
    if (await dialog.isVisible().catch(() => false)) {
      throw new Error('Deploy confirm dialog still open after confirm — deploy did not start');
    }
    return 'confirmed';
  }

  // ── Migration progress panel ───────────────────────────────────────────

  async waitForMigrationPanel(timeoutMs = 10_000): Promise<void> {
    // Progress panel OR a still-open confirm dialog (caller should confirm first).
    await this.page.waitForSelector(
      '[data-testid="migration-progress-panel"], [data-testid="deploy-confirm-dialog"]',
      { timeout: timeoutMs }
    );
    if (await this.page.locator(byTestId('deploy-confirm-dialog')).isVisible()) {
      await clickWhen(this.page, byTestId('deploy-confirm-btn'));
      await this.page.waitForSelector(byTestId('migration-progress-panel'), {
        timeout: timeoutMs,
      });
    }
  }

  /** Wait until migration finishes (complete or failed). Returns 'complete' | 'failed'. */
  async waitForMigrationDone(timeoutMs = 120_000): Promise<'complete' | 'failed'> {
    await this.page.waitForSelector(
      '[data-testid="migration-complete"], [data-testid="migration-failed"]',
      { timeout: timeoutMs }
    );
    const failed = await this.page.locator(byTestId('migration-failed')).count();
    return failed > 0 ? 'failed' : 'complete';
  }

  async getMigrationProgressItems(): Promise<{ object: string | null; status: string | null }[]> {
    const items = await this.page.locator(byTestId('migration-progress-item')).all();
    return Promise.all(items.map(async (el) => ({
      object: await el.getAttribute('data-object'),
      status: await el.getAttribute('data-status'),
    })));
  }

  async getMigrationErrorText(): Promise<string> {
    try {
      const panel = await waitFor(this.page, byTestId('migration-progress-panel'), 3_000);
      return (await panel.textContent()) ?? '';
    } catch {
      return '';
    }
  }

  // ── History ────────────────────────────────────────────────────────────

  async openHistory(): Promise<void> {
    await clickWhen(this.page, byTestId('history-btn'));
    await waitFor(this.page, byTestId('history-dialog'));
  }

  async isHistoryVisible(): Promise<boolean> {
    return this.page.locator(byTestId('history-dialog')).isVisible();
  }

  async getHistoryRunCount(): Promise<number> {
    return this.page.locator(byTestId('history-run-item')).count();
  }

  async getLatestRunStatus(): Promise<string | null> {
    return this.page.locator(byTestId('history-run-item')).first().getAttribute('data-status');
  }

  /**
   * Wait for the history list to actually settle. Two races otherwise:
   * the dialog's loadList() fetch is async (counting items right after the
   * dialog opens can see 0), and the backend writes the final run status
   * AFTER streaming the migration 'done' event (so the first fetch can see
   * the run still RUNNING). Polls until at least one item exists with a
   * terminal status; returns that status.
   */
  async waitForLatestRunSettled(timeoutMs = 10_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let status: string | null = null;
    while (Date.now() < deadline) {
      if ((await this.getHistoryRunCount()) > 0) {
        status = await this.getLatestRunStatus();
        if (status && status !== 'RUNNING') return status;
      }
      // The dialog only fetches on open/refresh — nudge it so a late
      // history write still shows up within the polling window.
      await this.page.locator('[data-testid="history-dialog"] button[title="Refresh"]').click().catch(() => {});
      await this.page.waitForTimeout(500);
    }
    return status;
  }

  async closeHistory(): Promise<void> {
    await this.page.locator(byTestId('history-dialog-close-btn')).click();
    await this.page.waitForSelector(byTestId('history-dialog'), {
      state: 'detached',
      timeout: 5_000,
    });
  }
}
