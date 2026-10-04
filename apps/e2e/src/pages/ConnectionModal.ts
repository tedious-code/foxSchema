import type { Page } from 'playwright';
import { fillInput } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';

export interface ConnectionFields {
  dialect: string;
  /** Omitted for file dialects — SQLite and DuckDB render no host / port. */
  host?: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  schema?: string;
}

/**
 * Page object for the ConnectionModal.
 * Assumes the modal is already open before calling any method.
 */
export class ConnectionModal {
  constructor(private page: Page) {}

  async selectDialect(dialect: string): Promise<void> {
    await this.page.selectOption(byTestId('conn-dialect-select'), dialect);
  }

  async fillHost(value: string): Promise<void> {
    await fillInput(this.page, byTestId('conn-host-input'), value);
  }

  async fillPort(value: number): Promise<void> {
    await fillInput(this.page, byTestId('conn-port-input'), String(value));
  }

  async fillDatabase(value: string): Promise<void> {
    await fillInput(this.page, byTestId('conn-database-input'), value);
  }

  async fillUsername(value: string): Promise<void> {
    await fillInput(this.page, byTestId('conn-username-input'), value);
  }

  async fillPassword(value: string): Promise<void> {
    await fillInput(this.page, byTestId('conn-password-input'), value);
  }

  async loadSchemas(): Promise<void> {
    await this.page.click(byTestId('conn-load-schema-btn'));
    // Wait for the outcome, never for the "testing" banner on the way to it.
    // The banner lasts only as long as the request: a SQLite file answers in
    // milliseconds, and a list fetched in the last 15s comes from the client
    // cache (`fetchSchemaList`) with no request at all, so the banner can come
    // and go between two polls. Waiting for it timed out the blueprint suite's
    // setup in a sweep with the schemas already loaded. The cache is also why
    // this does not wait for the HTTP response: there may not be one.
    await this.page.waitForSelector(
      '[data-testid="conn-test-success"], [data-testid="conn-test-failed"]',
      { timeout: 30_000 }
    );
    const failed = this.page.locator(byTestId('conn-test-failed'));
    if (await failed.isVisible().catch(() => false)) {
      const msg = (await failed.textContent().catch(() => null))?.trim() || 'unknown error';
      throw new Error(`Connection test failed: ${msg}`);
    }
  }

  /** The schema box is an Autocomplete: typing sets it, and blur snaps to a listed name. */
  async selectSchema(schema: string): Promise<void> {
    await fillInput(this.page, byTestId('conn-schema-input'), schema);
    await this.page.keyboard.press('Tab');
  }

  async save(): Promise<void> {
    await this.page.click(byTestId('conn-save-btn'));
    // Modal closes on success.
    await this.page.waitForSelector(byTestId('conn-modal'), {
      state: 'detached',
      timeout: 10_000,
    });
  }

  /** Close a stuck overlay so later steps are not blocked by pointer interception. */
  async dismissIfOpen(): Promise<void> {
    const modal = this.page.locator(byTestId('conn-modal'));
    if (!(await modal.isVisible().catch(() => false))) return;
    await this.page.keyboard.press('Escape').catch(() => undefined);
    if (await modal.isVisible().catch(() => false)) {
      const close = this.page.locator(
        '[data-testid="conn-modal"] [data-testid="conn-cancel"], [data-testid="conn-modal"] button[aria-label="Close"], [data-testid="conn-modal"] button.p-1'
      ).first();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ force: true }).catch(() => undefined);
      }
    }
    await modal.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  }

  async checkSavePassword(): Promise<void> {
    const box = this.page.locator(byTestId('conn-save-password'));
    if ((await box.count()) > 0 && !(await box.isChecked())) {
      await box.check();
    }
  }

  async uncheckSavePassword(): Promise<void> {
    const box = this.page.locator(byTestId('conn-save-password'));
    if ((await box.count()) > 0 && (await box.isChecked())) {
      await box.uncheck();
    }
  }

  /** Fill all fields then save. */
  async connect(fields: ConnectionFields): Promise<void> {
    await this.selectDialect(fields.dialect);
    const fileDialect = fields.dialect === 'sqlite' || fields.dialect === 'duckdb';
    if (!fileDialect) {
      await this.fillHost(fields.host ?? '');
      if (fields.port !== undefined) await this.fillPort(fields.port);
      await this.fillUsername(fields.username ?? '');
      await this.fillPassword(fields.password ?? '');
      // Empty password (e.g. local TiDB root) cannot be stored while “Save
      // password” is ticked — the modal blocks save. Untick in that case.
      if (fields.password?.trim()) await this.checkSavePassword();
      else await this.uncheckSavePassword();
    }
    await this.fillDatabase(fields.database);
    await this.loadSchemas();
    if (fields.schema) {
      await this.selectSchema(fields.schema);
    }
    await this.save();
  }
}
