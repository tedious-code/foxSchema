import type { Page } from 'playwright';
import { BASE_URL, waitFor, clickWhen } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';

/**
 * Page object for the main Fox comparison workspace.
 * All selectors match the data-testid attributes set in the React components.
 */
export class AppPage {
  constructor(private page: Page) {}

  async open(): Promise<void> {
    await this.page.goto(BASE_URL);
    // First-run signup can appear after /signup/state (up to ~4s). Wait for
    // either the workspace or the wizard so we don't miss Skip.
    await this.page.waitForSelector(
      '[data-testid="toolbar"], [data-testid="signup-wizard-skip"], [data-testid="onboarding-skip"]',
      { timeout: 30_000 }
    );
    const skipSignup = this.page.locator(byTestId('signup-wizard-skip'));
    if (await skipSignup.isVisible().catch(() => false)) {
      await skipSignup.click();
      await this.page.waitForSelector(byTestId('toolbar'), { timeout: 20_000 });
    }
    // One-time signup / onboarding wizards can cover the toolbar.
    for (let i = 0; i < 3; i++) {
      const skipOnboarding = this.page.getByRole('button', { name: /skip|continue|get started|finish|done/i }).first();
      if (
        !(await this.page.locator(byTestId('toolbar')).isVisible().catch(() => false)) &&
        (await skipOnboarding.isVisible().catch(() => false))
      ) {
        await skipOnboarding.click();
        await this.page.waitForTimeout(300);
      }
      if (await this.page.locator(byTestId('toolbar')).isVisible().catch(() => false)) break;
    }
    await waitFor(this.page, byTestId('toolbar'), 20_000);
  }

  /**
   * Put the Sync workspace on screen.
   *
   * The app lands on Home now, not Sync, so the compare controls are not
   * mounted when a spec starts. Reaching straight for them failed as a 15s
   * `page.click` timeout on every dialect at once — which reads like the app is
   * broken rather than like the test is on the wrong screen.
   *
   * Idempotent: already on Sync, the rail button is a no-op.
   */
  async gotoSync(): Promise<void> {
    const rail = this.page.locator(byTestId('view-sync-btn'));
    if (await rail.isVisible().catch(() => false)) {
      await clickWhen(this.page, byTestId('view-sync-btn'));
    }
    // Two conditions, not one. TopToolbar gates the connection chips on
    // `activeView === 'sync' && syncPane === 'compare'`, and Sync can open on
    // the Snapshots pane — so selecting the workspace alone leaves the compare
    // controls unmounted and every click on them times out.
    const compare = this.page.locator(byTestId('sync-pane-compare-btn'));
    if (await compare.isVisible().catch(() => false)) {
      await clickWhen(this.page, byTestId('sync-pane-compare-btn'));
    }
    await waitFor(this.page, byTestId('source-config-btn'), 15_000);
  }

  // ── Source side ─────────────────────────────────────────────────────────

  async openSourceModal(): Promise<void> {
    await this.gotoSync();
    await clickWhen(this.page, byTestId('source-config-btn'));
    await waitFor(this.page, byTestId('conn-modal'));
  }

  async isSourceConnected(): Promise<boolean> {
    return this.page.locator(byTestId('source-connected-btn')).isVisible();
  }

  async waitForSourceConnected(timeoutMs = 15_000): Promise<void> {
    await this.page.waitForSelector(byTestId('source-connected-btn'), { timeout: timeoutMs });
  }

  // ── Target side ─────────────────────────────────────────────────────────

  async openTargetModal(): Promise<void> {
    await this.gotoSync();
    await clickWhen(this.page, byTestId('target-config-btn'));
    await waitFor(this.page, byTestId('conn-modal'));
  }

  async isTargetConnected(): Promise<boolean> {
    return this.page.locator(byTestId('target-connected-btn')).isVisible();
  }

  async waitForTargetConnected(timeoutMs = 15_000): Promise<void> {
    await this.page.waitForSelector(byTestId('target-connected-btn'), { timeout: timeoutMs });
  }

  // ── Comparison ─────────────────────────────────────────────────────────

  async runCompare(): Promise<void> {
    await clickWhen(this.page, byTestId('compare-btn'));
    await this.page.waitForSelector(byTestId('schema-tree'), { timeout: 30_000 });
  }

  async getDiffCount(): Promise<number> {
    return this.page.locator(byTestId('diff-item')).count();
  }

  async getDiffStatuses(): Promise<(string | null)[]> {
    const items = await this.page.locator(byTestId('diff-item')).all();
    return Promise.all(items.map((el) => el.getAttribute('data-status')));
  }

  async isSchemaTreeVisible(): Promise<boolean> {
    try {
      await this.page.waitForSelector(byTestId('schema-tree'), { timeout: 3_000 });
      return this.page.locator(byTestId('schema-tree')).isVisible();
    } catch {
      return false;
    }
  }

  // ── Banners ────────────────────────────────────────────────────────────

  async isErrorBannerVisible(): Promise<boolean> {
    return this.page.locator(byTestId('error-banner')).isVisible();
  }

  async getErrorBannerText(): Promise<string> {
    return (await this.page.locator(byTestId('error-banner')).textContent()) ?? '';
  }

  async isWarningBannerVisible(): Promise<boolean> {
    return this.page.locator(byTestId('warning-banner')).isVisible();
  }

  async dismissWarnings(): Promise<void> {
    await clickWhen(this.page, byTestId('dismiss-warnings-btn'));
  }
}
