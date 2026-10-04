import type { Page } from 'playwright';
import { clickWhen, waitFor } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';

/**
 * Database Access Assistant (toolbar → Access) plus the SQL Editor
 * Utilities → Database Access modal.
 *
 * Access nav tabs today: Principals (`permission`), User Management (`users`),
 * Diff (`diff`). Older builder / inspector / report tabs were folded into
 * Principals.
 */
export class AccessPage {
  constructor(private page: Page) {}

  async openView(): Promise<void> {
    await clickWhen(this.page, byTestId('view-access-btn'));
    await waitFor(this.page, byTestId('access-view'), 20_000);
  }

  async openTab(tab: 'permission' | 'users' | 'diff'): Promise<void> {
    await clickWhen(this.page, byTestId(`access-tab-${tab}`));
  }

  /** Pick a saved credential in any Access / Database Access <select> by visible name.
   *  The Access workspace uses one chip (`access-connection`); panel-local
   *  dropdowns are used when a panel still has its own picker. */
  async selectConnection(selectTestId: string, nameSubstring: string): Promise<void> {
    const workspace = this.page.locator(byTestId('access-connection'));
    const select = (await workspace.isVisible().catch(() => false))
      ? workspace
      : this.page.locator(`[data-testid="${selectTestId}"]`);
    await select.waitFor({ state: 'visible', timeout: 10_000 });
    const value = await select.evaluate((el, want) => {
      const sel = el as HTMLSelectElement;
      const opt = [...sel.options].find((o) =>
        o.textContent?.toLowerCase().includes(want.toLowerCase())
      );
      return opt?.value ?? '';
    }, nameSubstring);
    if (!value) {
      throw new Error(`No option matching "${nameSubstring}" in [data-testid="${selectTestId}"]`);
    }
    await select.selectOption(value);
  }
}
