import type { Page } from 'playwright';
import { clickWhen, waitFor, fillInput } from '../helpers/driver.js';
import type { DbConfig } from '../helpers/db-config.js';
import { ConnectionModal, type ConnectionFields } from './ConnectionModal.js';
import { byTestId } from '../helpers/test-ids.js';

/**
 * Page object for the SQL Editor workspace (view switcher + run against
 * saved credentials). Selectors match data-testid attributes in the React UI.
 */
export class SqlEditorPage {
  constructor(private page: Page) {}

  /** Dismiss session-password / write-confirm overlays that block clicks. */
  async dismissOverlays(): Promise<void> {
    const pwd = this.page.locator(byTestId('sql-session-password'));
    if (await pwd.isVisible().catch(() => false)) {
      await this.page.click(byTestId('sql-session-password-cancel'));
      await pwd.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    }
    const write = this.page.locator(byTestId('sql-write-confirm'));
    if (await write.isVisible().catch(() => false)) {
      // Cancel write confirm (backdrop click).
      await write.click({ position: { x: 8, y: 8 } });
      await write.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    }
    const rowForm = this.page.locator(byTestId('peek-row-editor'));
    if (await rowForm.isVisible().catch(() => false)) {
      await this.page.keyboard.press('Escape');
      await rowForm.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    }
    // First-run signup wizard (full-page, not a z-100 overlay).
    const skipSignup = this.page.getByRole('button', { name: /skip for now/i });
    if (await skipSignup.isVisible().catch(() => false)) {
      await skipSignup.click();
      await this.page.waitForTimeout(300);
    }
  }

  /**
   * Monaco is lazy-loaded with the SQL Editor pane (kept off first paint).
   * Callers that type into the buffer must wait for the chunk, not only the shell.
   */
  async waitForMonaco(timeoutMs = 60_000): Promise<void> {
    await this.page.waitForSelector('.monaco-editor textarea, .monaco-editor', {
      timeout: timeoutMs,
      state: 'visible',
    });
  }

  async openView(): Promise<void> {
    await clickWhen(this.page, byTestId('view-sql-editor-btn'));
    await waitFor(this.page, byTestId('sql-editor-view'));
    // Schema explorer may prompt for a password on auto-load — clear it so
    // later clicks aren't blocked. Callers that need the password should
    // submit via checkConnection / submitSessionPassword instead.
    await this.page.waitForTimeout(400);
    await this.dismissOverlays();
    await this.waitForMonaco();
  }

  /** Open the Database utilities workspace (not the SQL Editor sidebar). */
  async openUtilitiesView(): Promise<void> {
    await this.dismissOverlays();
    await clickWhen(this.page, byTestId('view-utilities-btn'));
    await waitFor(this.page, byTestId('utilities-view'), 10_000);
  }

  async isEditorVisible(): Promise<boolean> {
    return this.page.locator(byTestId('sql-editor-view')).isVisible();
  }

  async openCredentials(): Promise<void> {
    await clickWhen(this.page, byTestId('credentials-btn'));
    await waitFor(this.page, byTestId('cred-manager'));
  }

  async closeCredentials(): Promise<void> {
    await clickWhen(this.page, byTestId('cred-close-btn'));
    await this.page.waitForSelector(byTestId('cred-manager'), { state: 'detached', timeout: 10_000 });
  }

  /** Save a SQLite file path as a named credential. */
  async addSqliteCredential(name: string, dbPath: string): Promise<void> {
    // No host / port / user / password: SQLite is a file, and the form stops
    // pretending otherwise — those boxes are not rendered for a file dialect.
    await this.addCredential(name, { dialect: 'sqlite', database: dbPath });
  }

  /**
   * Save any dialect credential from Credentials → Add.
   * Fills the connection name, then reuses ConnectionModal.connect() (load schemas + save password).
   */
  async addCredential(name: string, cfg: ConnectionFields | DbConfig): Promise<void> {
    await this.openCredentials();
    await clickWhen(this.page, byTestId('cred-add-btn'));
    await waitFor(this.page, byTestId('conn-modal'));
    const modal = new ConnectionModal(this.page);
    // Dialect first — switching dialect can reset the form and wipe the name.
    await modal.selectDialect(cfg.dialect);
    await fillInput(this.page, byTestId('conn-name-input'), name);
    // A file dialect renders the path and nothing else — filling a hidden host
    // box is what broke this helper when the form stopped showing one. Dummy
    // E2E_*_HOST values (required by hasConfig) must not be typed into those
    // missing fields.
    const fileDialect = cfg.dialect === 'sqlite' || cfg.dialect === 'duckdb';
    if (!fileDialect) {
      if (cfg.host !== undefined) await modal.fillHost(cfg.host);
      if (cfg.port !== undefined) await modal.fillPort(cfg.port);
      if (cfg.username !== undefined) await modal.fillUsername(cfg.username);
      if (cfg.password !== undefined) await modal.fillPassword(cfg.password);
      if (cfg.password?.trim()) await modal.checkSavePassword();
      else await modal.uncheckSavePassword();
    }
    await modal.fillDatabase(cfg.database);
    // loadSchemas throws on conn-test-failed — never persist a bad credential.
    await modal.loadSchemas();
    if (cfg.schema) await modal.selectSchema(cfg.schema);
    await modal.save();
    await this.closeCredentials();
  }

  async checkConnection(name: string): Promise<void> {
    // The v3 sidebar ships every section collapsed, and a collapsed section
    // renders no content at all — so the checkbox is absent, not merely
    // scrolled out of view. Open Destinations before looking for it.
    await this.ensureSidebarSectionOpen('destinations');
    const sel = byTestId(`sql-conn-check-${name}`);
    await waitFor(this.page, sel, 15_000);
    const box = this.page.locator(sel);
    if (!(await box.isChecked())) await box.check();
  }

  async setSql(sql: string): Promise<void> {
    await this.dismissOverlays();
    // Ensure we are on the SQL Editor shell and Monaco has finished lazy load.
    if (!(await this.isEditorVisible().catch(() => false))) {
      await this.openView();
    } else {
      await this.waitForMonaco();
    }
    // Monaco uses a hidden textarea; focus then replace via select-all + type.
    const editor = this.page.locator('.monaco-editor').first();
    await editor.click();
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page.keyboard.press(`${mod}+KeyA`);
    await this.page.keyboard.press('Backspace');
    await this.page.keyboard.type(sql, { delay: 8 });
    // Debounced gutter + store onChange (~200ms).
    await this.page.waitForTimeout(350);
  }

  /**
   * Full editor text, whitespace-normalised for matching.
   *
   * Monaco virtualises: `.view-lines` only holds the rendered viewport, so
   * reading the DOM silently drops anything below the fold. The store persists
   * the active tab's SQL in full (up to 256KB), so prefer that and keep the DOM
   * as a fallback for the rare case where nothing is persisted yet.
   */
  async editorText(): Promise<string> {
    const raw = await this.page.evaluate(() => {
      const dom = () => {
        const lines = document.querySelector('.monaco-editor .view-lines');
        const ta = document.querySelector('.monaco-editor textarea') as HTMLTextAreaElement | null;
        return `${lines?.textContent ?? ''}\n${ta?.value ?? ''}`;
      };
      try {
        // The store writes 400 ms after the last change; flush it, the way
        // leaving the page does, so this reads what was just typed.
        window.dispatchEvent(new Event('pagehide'));
        const stored = localStorage.getItem('foxschema-sql-editor');
        if (!stored) return dom();
        const state = JSON.parse(stored)?.state;
        const tabs: Array<{ id?: string; sql?: string }> = state?.tabs ?? [];
        const active = tabs.find((t) => t.id === state?.activeTabId) ?? tabs[0];
        return active?.sql ? `${active.sql}\n${dom()}` : dom();
      } catch {
        return dom();
      }
    });
    return raw.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ');
  }

  private columnPicker() {
    return this.page.locator(byTestId('sql-select-column-picker'));
  }

  /**
   * Open the SELECT column picker the way a user does — click the SELECT/FROM
   * keyword in the editor. Falls back to the CtrlCmd+Shift+C shortcut when the
   * token click doesn't land (Monaco re-tokenises while typing).
   */
  async openColumnPicker(): Promise<void> {
    await this.dismissOverlays();
    // Dismiss any open autocomplete so the click reaches the keyword.
    await this.page.keyboard.press('Escape');
    const keyword = this.page
      .locator('.monaco-editor .view-line span span')
      .filter({ hasText: /^(SELECT|FROM)$/i })
      .first();
    if (await keyword.count()) {
      await keyword.click({ force: true }).catch(() => undefined);
    }
    if (await this.columnPicker().isVisible().catch(() => false)) {
      await this.page.waitForTimeout(250);
      return;
    }
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page.locator('.monaco-editor').first().click();
    await this.page.keyboard.press(`${mod}+Shift+KeyC`);
    await this.columnPicker().waitFor({ state: 'visible', timeout: 10_000 });
    await this.page.waitForTimeout(250);
  }

  async columnPickerVisible(): Promise<boolean> {
    return this.columnPicker().isVisible().catch(() => false);
  }

  /**
   * Teardown close via the header X. Deliberately not Escape or an outside
   * click — those are under test, and using them here would let one broken
   * dismiss path cascade into unrelated failures.
   */
  async closeColumnPicker(): Promise<void> {
    if (!(await this.columnPickerVisible())) return;
    await this.columnPicker().locator('button[aria-label="Close"]').click();
    await this.columnPicker().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  }

  /** Click somewhere outside the picker that cannot mutate the query (the active tab). */
  async clickOutsideColumnPicker(): Promise<void> {
    await this.page.locator('[data-testid="sql-editor-tabs"] [role="tab"]').first().click();
  }

  async pickerColumnLabels(): Promise<string[]> {
    return this.columnPicker().locator('li label span').allInnerTexts();
  }

  async pickerStatusText(): Promise<string> {
    return this.columnPicker().innerText();
  }

  async pickerSelectAllStar(): Promise<void> {
    await this.columnPicker().locator(byTestId('sql-select-all-star')).click();
    await this.page.waitForTimeout(300);
  }

  async pickerRemoveAll(): Promise<void> {
    await this.columnPicker().locator(byTestId('sql-select-remove-all')).click();
    await this.page.waitForTimeout(300);
  }

  /** Toggle one `alias.column` checkbox by its expression (case-insensitive testid). */
  async pickerToggleColumn(expr: string): Promise<void> {
    const box = this.columnPicker().locator(
      byTestId(`sql-select-col-${expr.toLowerCase()}`)
    );
    await box.waitFor({ state: 'visible', timeout: 10_000 });
    await box.click();
    await this.page.waitForTimeout(300);
  }

  async pickerColumnChecked(expr: string): Promise<boolean> {
    return this.columnPicker()
      .locator(byTestId(`sql-select-col-${expr.toLowerCase()}`))
      .isChecked();
  }

  async run(): Promise<void> {
    await this.dismissOverlays();
    await clickWhen(this.page, byTestId('sql-run-btn'));
  }

  async waitForResults(timeoutMs = 30_000): Promise<void> {
    await this.page.waitForSelector(
      '[data-testid="sql-results-by-credential"], [data-testid="sql-results-side-by-side"]',
      { timeout: timeoutMs }
    );
    // The container mounts as soon as the run starts, showing only the
    // credential headers, so waiting on it alone returns before any row
    // exists. Every credential drops its spinner when its run settles.
    await this.page
      .locator(byTestId('sql-results-running'))
      .last()
      .waitFor({ state: 'detached', timeout: timeoutMs })
      .catch(() => {});
  }

  async resultsText(): Promise<string> {
    const byCred = this.page.locator(byTestId('sql-results-by-credential'));
    const side = this.page.locator(byTestId('sql-results-side-by-side'));
    if (await byCred.isVisible()) return (await byCred.innerText()) ?? '';
    if (await side.isVisible()) return (await side.innerText()) ?? '';
    return '';
  }

  async addTab(): Promise<void> {
    await this.dismissOverlays();
    await clickWhen(this.page, byTestId('sql-tab-add'));
  }

  async openSyncView(): Promise<void> {
    await this.dismissOverlays();
    await clickWhen(this.page, byTestId('view-sync-btn'));
  }

  async setLayoutSideBySide(): Promise<void> {
    await this.dismissOverlays();
    await clickWhen(this.page, byTestId('sql-layout-side-by-side'));
    await waitFor(this.page, byTestId('sql-results-side-by-side'));
  }

  async setLayoutByCredential(): Promise<void> {
    await this.dismissOverlays();
    await clickWhen(this.page, byTestId('sql-layout-by-credential'));
  }

  /** Side-by-side Compare toolbar for statement index (default 0). */
  compareToggle(statementIndex = 0) {
    return this.page.locator(byTestId(`sql-result-compare-toggle-${statementIndex}`));
  }

  compareLegend(statementIndex = 0) {
    return this.page.locator(byTestId(`sql-result-compare-legend-${statementIndex}`));
  }

  compareBaselineSelect(statementIndex = 0) {
    return this.page.locator(byTestId(`sql-result-compare-baseline-${statementIndex}`));
  }

  compareDestSelect(statementIndex = 0) {
    return this.page.locator(byTestId(`sql-result-compare-dest-${statementIndex}`));
  }

  compareSyncScroll(statementIndex = 0) {
    return this.page.locator(byTestId(`sql-result-compare-sync-scroll-${statementIndex}`));
  }

  compareExportCsvAll(statementIndex = 0) {
    return this.page.locator(byTestId(`sql-result-compare-export-csv-${statementIndex}`));
  }

  compareMaximize(statementIndex = 0) {
    return this.page.locator(byTestId(`sql-result-compare-maximize-${statementIndex}`));
  }

  /** Count cells marked with a data-diff attribute in the results panel. */
  async diffCellCount(kind?: 'modified' | 'missing' | 'extra'): Promise<number> {
    const sel = kind
      ? `[data-testid="sql-results-side-by-side"] td[data-diff="${kind}"]`
      : '[data-testid="sql-results-side-by-side"] td[data-diff]';
    return this.page.locator(sel).count();
  }

  async tabCount(): Promise<number> {
    return this.page.locator('[data-testid="sql-editor-tabs"] [role="tab"]').count();
  }

  async statementStripVisible(): Promise<boolean> {
    return this.page.locator(byTestId('sql-statement-strip')).isVisible();
  }

  async confirmWriteIfShown(): Promise<boolean> {
    const dlg = this.page.locator(byTestId('sql-write-confirm'));
    try {
      await dlg.waitFor({ state: 'visible', timeout: 5_000 });
    } catch {
      return false;
    }
    await clickWhen(this.page, byTestId('sql-write-confirm-btn'));
    await dlg.waitFor({ state: 'detached', timeout: 10_000 });
    return true;
  }

  async writeConfirmReadonlyWarnVisible(): Promise<boolean> {
    return this.page.locator(byTestId('sql-readonly-write-warn')).isVisible();
  }

  async schemaExplorerVisible(): Promise<boolean> {
    return this.page.locator(byTestId('sql-schema-explorer')).isVisible();
  }

  /** Expand TABLES group and open the blueprint for a table by name. */
  async openTableBlueprint(tableName: string): Promise<void> {
    await this.dismissOverlays();
    await this.closeBlueprint().catch(() => undefined);
    // The schema tree lives in the SQL Editor workspace. A caller coming from
    // Utilities (Clone Table, Index Management) is on a screen that has no
    // sidebar at all, so go back before looking for the tree.
    await this.openView();
    await this.ensureSidebarSectionOpen('schema');
    const explorer = this.page.locator(byTestId('sql-schema-explorer'));
    await explorer.waitFor({ state: 'visible', timeout: 15_000 });
    // Expand TABLES group only when the table name is not already visible
    // (a second click would collapse it).
    const alreadyVisible = await explorer.getByText(tableName, { exact: true }).count();
    if (alreadyVisible === 0) {
      const group = explorer.locator(byTestId('sql-schema-group-TABLE'));
      if (await group.count()) {
        await group.locator('button').first().click().catch(() => undefined);
      }
    }
    await this.page.waitForFunction(
      (name) => {
        const root = document.querySelector('[data-testid="sql-schema-explorer"]');
        return !!root && new RegExp(name, 'i').test(root.textContent ?? '');
      },
      tableName,
      { timeout: 45_000 }
    );
    // Edit sits on the right of the object row (always visible).
    const nameLabel = explorer.getByText(tableName, { exact: true }).first();
    await nameLabel.scrollIntoViewIfNeeded();
    const row = nameLabel.locator('xpath=ancestor::div[./button[@data-testid="sql-open-blueprint"] or .//button[@data-testid="sql-open-blueprint"]][1]');
    await row.locator(byTestId('sql-open-blueprint')).click({ force: true });
    await waitFor(this.page, byTestId('table-blueprint-modal'), 15_000);
  }

  async openNewTableBlueprint(): Promise<void> {
    await this.dismissOverlays();
    // Prefer Schema header action; fall back to explorer New control.
    const header = this.page.locator(byTestId('sql-schema-new-table'));
    if (await header.count()) {
      await header.click();
    } else {
      await clickWhen(this.page, byTestId('sql-new-table'));
    }
    await waitFor(this.page, byTestId('table-blueprint-modal'), 15_000);
  }

  async blueprintInsertSql(): Promise<void> {
    await clickWhen(this.page, byTestId('blueprint-insert-sql'));
  }

  async closeBlueprint(): Promise<void> {
    const modal = this.page.locator(byTestId('table-blueprint-modal'));
    if (!(await modal.isVisible().catch(() => false))) return;
    const closeBtn = this.page.locator(byTestId('blueprint-close'));
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    } else {
      // Click the backdrop (outer modal shell closes on click).
      await modal.click({ position: { x: 4, y: 4 } });
    }
    await modal.waitFor({ state: 'detached', timeout: 8_000 });
  }

  async clickPageNext(): Promise<void> {
    await clickWhen(this.page, byTestId('sql-page-next'));
  }

  async clickPagePrev(): Promise<void> {
    await clickWhen(this.page, byTestId('sql-page-prev'));
  }

  async pageNextEnabled(): Promise<boolean> {
    const btn = this.page.locator(byTestId('sql-page-next'));
    if (!(await btn.isVisible().catch(() => false))) return false;
    return !(await btn.isDisabled());
  }

  /** Wipe persisted editor tabs so tests start from a clean Query 1. */
  async resetPersistedEditorState(): Promise<void> {
    await this.page.evaluate(() => {
      // Flush a pending write first, or the reload's own flush would write the
      // old tabs back after they were removed.
      window.dispatchEvent(new Event('pagehide'));
      localStorage.removeItem('foxschema-sql-editor');
      localStorage.removeItem('foxschema-sql-sidebar-sections');
      localStorage.removeItem('foxschema-sql-sidebar-section-heights');
      localStorage.removeItem('foxschema-sql-sidebar-order');
      localStorage.removeItem('foxschema-sql-sidebar-order-schema-top-v1');
      localStorage.removeItem('foxschema-sql-sidebar-exclusive-v1');
      // Width and collapsed state too: a run that inherits a narrow sidebar
      // from an earlier one is testing a different layout than the next run,
      // which is how a real explorer layout bug surfaced here as an
      // intermittent "element is not visible" instead of every time.
      localStorage.removeItem('foxschema-sql-sidebar-width');
      localStorage.removeItem('foxschema-sql-sidebar-collapsed');
    });
  }

  /** Ensure a sidebar section is expanded (Destinations / Schema / …).
   *  `utilities` / `files` open the Utilities workspace. */
  async ensureSidebarSectionOpen(id: string): Promise<void> {
    await this.dismissOverlays();
    if (id === 'utilities' || id === 'files') {
      await this.openUtilitiesView();
      return;
    }
    // Not every caller is on a screen that has the SQL Editor sidebar — the
    // Utilities workspace has none — so a missing section means "nothing to
    // expand", not a failure. Throwing here would turn callers that merely
    // want the section open *if it exists* into hard errors.
    const section = this.page.locator(byTestId(`sql-sidebar-${id}`));
    const present = await section
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!present) return;
    const toggle = this.page.locator(byTestId(`sql-sidebar-toggle-${id}`));
    const aria = await toggle.getAttribute('aria-expanded').catch(() => null);
    if (aria === 'false') await toggle.click();
  }

  /** Open Data Peek for a table from the Schema tree (modifier-click the row). */
  async openDataPeek(tableName: string): Promise<void> {
    await this.dismissOverlays();
    // The v3 sidebar collapses every section, and a collapsed section renders
    // no explorer at all — open Schema before reaching into its tree.
    await this.ensureSidebarSectionOpen('schema');
    const explorer = this.page.locator(byTestId('sql-schema-explorer'));
    await explorer.waitFor({ state: 'visible', timeout: 15_000 });
    await this.page.waitForFunction(
      (name) => {
        const root = document.querySelector('[data-testid="sql-schema-explorer"]');
        return !!root && new RegExp(name, 'i').test(root.textContent ?? '');
      },
      tableName,
      { timeout: 60_000 }
    );
    const label = explorer.getByText(tableName, { exact: true }).first();
    await label.scrollIntoViewIfNeeded();
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await label.click({ modifiers: [modifier] });
    await waitFor(this.page, byTestId('data-peek'), 30_000);
    // Wait for the grid, since the CRUD controls only render once rows load.
    await this.page.waitForSelector('[data-testid^="data-peek-crud-"]', { timeout: 30_000 });
  }

  /** Click Add row on the first open Data Peek panel. */
  async openPeekAddRow(): Promise<void> {
    await this.page.locator('[data-testid^="data-peek-add-"]').first().click();
    await waitFor(this.page, byTestId('peek-row-editor'), 10_000);
  }

  async openIndexManagement(): Promise<void> {
    await this.openUtilitiesView();
    await clickWhen(this.page, byTestId('utilities-index-management'));
    await waitFor(this.page, byTestId('index-management-modal'), 15_000);
  }

  async openServerInsights(
    tab: 'pool' | 'sessions' | 'system' | 'sizes' = 'system'
  ): Promise<void> {
    await this.openUtilitiesView();
    const testId =
      tab === 'pool'
        ? 'utilities-connection-pool'
        : tab === 'sessions'
          ? 'utilities-user-connections'
          : tab === 'system'
            ? 'utilities-system-info'
            : 'utilities-object-sizes';
    await clickWhen(this.page, `[data-testid="${testId}"]`);
    await waitFor(this.page, byTestId('server-insights-modal'), 15_000);
    await waitFor(this.page, byTestId(`server-insights-tab-${tab}`), 5_000);
  }

  async closeServerInsights(): Promise<void> {
    const modal = this.page.locator(byTestId('server-insights-modal'));
    if (!(await modal.isVisible().catch(() => false))) return;
    const closeBtn = modal.locator('button[aria-label="Close"]');
    if (!(await closeBtn.isVisible().catch(() => false))) return;
    await closeBtn.click().catch(async () => {
      await this.page.keyboard.press('Escape');
    });
    await modal.waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
  }

  async openDatabaseAccess(): Promise<void> {
    await this.dismissOverlays();
    await this.openUtilitiesView();
    await clickWhen(this.page, byTestId('utilities-database-access'));
    await waitFor(this.page, byTestId('db-access-modal'), 15_000);
  }

  async closeDatabaseAccess(): Promise<void> {
    const modal = this.page.locator(byTestId('db-access-modal'));
    if (!(await modal.isVisible().catch(() => false))) return;
    const closeBtn = modal.locator('button[aria-label="Close"]');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click().catch(() => undefined);
      await modal.waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
      return;
    }
    // Overlay (legacy): backdrop click. Workspace pane: leave it docked.
    const box = await modal.boundingBox().catch(() => null);
    if (box && box.x <= 8 && box.y <= 8) {
      await modal.click({ position: { x: 4, y: 4 } }).catch(() => undefined);
      await modal.waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
    }
  }

  async closeIndexManagement(): Promise<void> {
    const modal = this.page.locator(byTestId('index-management-modal'));
    if (!(await modal.isVisible().catch(() => false))) return;
    const closeBtn = modal.locator('button[aria-label="Close"]');
    if (!(await closeBtn.isVisible().catch(() => false))) return;
    await closeBtn.click().catch(async () => {
      await modal.click({ position: { x: 4, y: 4 } });
    });
    await modal.waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
  }

  async openCloneTable(): Promise<void> {
    await this.dismissOverlays();
    await this.openUtilitiesView();
    await clickWhen(this.page, byTestId('utilities-clone-table'));
    await waitFor(this.page, byTestId('clone-table-modal'), 15_000);
  }

  async closeCloneTable(): Promise<void> {
    const modal = this.page.locator(byTestId('clone-table-modal'));
    if (!(await modal.isVisible().catch(() => false))) return;
    const closeBtn = modal.locator('button[aria-label="Close"]');
    if (!(await closeBtn.isVisible().catch(() => false))) return;
    await closeBtn.click().catch(async () => {
      await modal.getByRole('button', { name: /^close$/i }).click();
    });
    await modal.waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
  }

  /** Pick credential in Clone Table / Index Management by visible name substring.
   *  The Utilities workspace uses one chip (`utilities-connection`); tool-local
   *  dropdowns are used when a modal still has its own picker. */
  async selectUtilityConnection(nameSubstring: string, selectTestId: string): Promise<void> {
    const workspace = this.page.locator(byTestId('utilities-connection'));
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
      throw new Error(`No credential option matching "${nameSubstring}" in ${selectTestId}`);
    }
    await select.selectOption(value);
  }

  /**
   * Open the Clone Table picker and wait for a table to be listed.
   *
   * The picker is an Autocomplete: options render only while the list is
   * open, so this focuses the box, then narrows by typing so a large schema
   * cannot push the row past the visible window.
   */
  async waitForCloneTableOption(tableName: string, timeoutMs = 30_000): Promise<void> {
    const input = this.page.locator(byTestId('clone-table-name'));
    await input.waitFor({ state: 'visible', timeout: timeoutMs });
    await input.fill(tableName);
    await this.cloneTableOption(tableName).waitFor({ state: 'visible', timeout: timeoutMs });
  }

  /** Autocomplete rows carry data-value; match on it rather than on visible text plus hint. */
  private cloneTableOption(tableName: string) {
    return this.page.locator(`[role="option"][data-value="${tableName}"]`).first();
  }

  /** Pick a table in the Clone Table Autocomplete by exact name. */
  async selectCloneTable(tableName: string): Promise<void> {
    await this.waitForCloneTableOption(tableName);
    await this.cloneTableOption(tableName).click();
    await this.page.waitForFunction(
      (name) =>
        (document.querySelector('[data-testid="clone-table-name"]') as HTMLInputElement | null)
          ?.value === name,
      tableName,
      { timeout: 5_000 }
    );
  }

  async loadCloneTables(connectionName: string, tableName: string): Promise<void> {
    await this.selectUtilityConnection(connectionName, 'clone-table-connection');
    await this.page.locator(byTestId('clone-table-load')).click();
    // Second arg must be the pageFunction argument; options are the third arg.
    // Passing `{ timeout }` alone is treated as the arg and the default 30s applies.
    await this.page.waitForFunction(
      () => {
        const status = document.querySelector('[data-testid="clone-status"]')?.textContent ?? '';
        const err = document.querySelector('[data-testid="clone-error"]')?.textContent ?? '';
        const input = document.querySelector(
          '[data-testid="clone-table-name"]'
        ) as HTMLInputElement | null;
        // The picker is disabled-looking until the schema cache has tables.
        const ready = !!input && !/load tables first/i.test(input.placeholder);
        return err.length > 0 || /loaded/i.test(status) || ready;
      },
      undefined,
      { timeout: 45_000 }
    );
    const err =
      (await this.page.locator(byTestId('clone-error')).textContent().catch(() => '')) ?? '';
    if (err.trim()) throw new Error(`Clone Table load failed: ${err}`);
    await this.selectCloneTable(tableName);
  }
}
