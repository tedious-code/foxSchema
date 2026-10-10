import { detectCodeCell } from '@/features/sql-editor/lib/codeCellRunner';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';

/**
 * `sql` split into statements. Each helper below takes the split as an optional
 * last argument: the editor already holds it, and splitting a large script
 * again in every helper on every keystroke was most of the typing cost.
 */
type Split = ReturnType<typeof splitSqlStatements>;
import { reattachSetComments } from '@/shared/lib/sql-variables';

export type ResultsLayout = 'byCredential' | 'sideBySide';

export interface SqlTab {
  id: string;
  title: string;
  sql: string;
  selectedConnectionIds: string[];
  /**
   * Indices into the current split of `sql`. Empty means "run the first
   * statement only" (agreed default). Not persisted.
   */
  checkedStatements: number[];
  /**
   * Cached `splitSqlStatements(sql).length` so setSql can update checks
   * without a second parse of the previous buffer. Not persisted.
   */
  statementCount: number;
  layout: ResultsLayout;
  /** When set, renaming the tab also renames this bookmark (and vice versa). */
  bookmarkId?: string;
}

export function newTabId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTab(partial?: Partial<SqlTab>): SqlTab {
  const sql = partial?.sql ?? '';
  return {
    id: partial?.id ?? newTabId(),
    title: partial?.title ?? 'Query 1',
    sql,
    selectedConnectionIds: partial?.selectedConnectionIds ?? [],
    checkedStatements: partial?.checkedStatements ?? [],
    statementCount:
      typeof partial?.statementCount === 'number'
        ? partial.statementCount
        : splitSqlStatements(sql).length,
    layout: partial?.layout ?? 'byCredential',
    bookmarkId: partial?.bookmarkId,
  };
}

/** Next title like Query 2, Query 3 — based on existing Query N titles. */
export function nextTabTitle(tabs: SqlTab[]): string {
  let max = 0;
  for (const t of tabs) {
    const m = /^Query\s+(\d+)$/i.exec(t.title.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Query ${max + 1}`;
}

export function addTab(tabs: SqlTab[]): { tabs: SqlTab[]; activeTabId: string } {
  const tab = createTab({ title: nextTabTitle(tabs) });
  return { tabs: [...tabs, tab], activeTabId: tab.id };
}

/** Move a tab from one index to another (no-op when indices are equal/out of range). */
export function moveTab(tabs: SqlTab[], fromIndex: number, toIndex: number): SqlTab[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= tabs.length ||
    toIndex >= tabs.length
  ) {
    return tabs;
  }
  const next = [...tabs];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

/**
 * Close a tab. Refuses to leave zero tabs (replaces the last with a fresh empty
 * one so SQL/results clear). Activates a neighbor when the closed tab was active.
 * Closing an already-empty sole tab is a no-op (same id) so the UI can disable ×.
 */
export function closeTab(
  tabs: SqlTab[],
  activeTabId: string,
  id: string
): { tabs: SqlTab[]; activeTabId: string } {
  if (tabs.length <= 1) {
    const only = tabs[0];
    if (!only || only.id !== id) return { tabs, activeTabId };
    if (!(only.sql ?? '').trim()) {
      return { tabs, activeTabId };
    }
    const alone = createTab({ title: 'Query 1' });
    return { tabs: [alone], activeTabId: alone.id };
  }
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return { tabs, activeTabId };
  const nextTabs = tabs.filter((t) => t.id !== id);
  if (activeTabId !== id) return { tabs: nextTabs, activeTabId };
  const neighbor = nextTabs[Math.min(idx, nextTabs.length - 1)]!;
  return { tabs: nextTabs, activeTabId: neighbor.id };
}

/**
 * When the statement count changes, clear checks so we don't keep stale
 * indices. Same count → keep checks, pruning any out-of-range index.
 * Callers pass counts from a single split (avoid re-parsing SQL here).
 */
export function checkedAfterSqlChange(
  prevCount: number,
  nextCount: number,
  prevChecked: number[]
): number[] {
  if (prevCount !== nextCount) return [];
  return prevChecked.filter((i) => i >= 0 && i < nextCount);
}

/**
 * Which statement the caret is in, for the "nothing checked, nothing selected"
 * default.
 *
 * Running statement 1 in that case is wrong the moment an editor holds more
 * than one query: a user who writes a page of SELECTs, adds an UPDATE at the
 * bottom and presses Run silently re-runs the first SELECT, and reads that as
 * "the editor won't run my UPDATE".
 *
 * A caret between two statements belongs to the one it follows — that is the
 * statement just typed. Before the first statement it belongs to the first.
 */
export function statementIndexAtOffset(
  sql: string,
  offset: number | null | undefined,
  split?: Split
): number | null {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
  const all = split ?? splitSqlStatements(sql);
  if (all.length === 0) return null;
  for (let i = 0; i < all.length; i++) {
    const statement = all[i]!;
    if (offset >= statement.start && offset <= statement.end) return i;
  }
  let previous: number | null = null;
  for (let i = 0; i < all.length; i++) {
    if (all[i]!.end < offset) previous = i;
  }
  return previous ?? 0;
}

/**
 * Statements to send on Run. Empty check set → the statement under the caret
 * (falling back to the first when the caret is unknown, e.g. the editor has
 * never been focused). Checked indices are sorted and de-duplicated.
 * Re-attaches inter-statement `-- @set` comments the splitter would drop.
 */
export function statementsToRun(
  sql: string,
  checkedStatements: number[],
  caretOffset?: number | null,
  split?: Split
): string[] {
  const all = split ?? splitSqlStatements(sql);
  if (all.length === 0) return [];
  const enriched = reattachSetComments(sql, all);
  const fallback = statementIndexAtOffset(sql, caretOffset, all) ?? 0;
  if (checkedStatements.length === 0) return [enriched[fallback] ?? enriched[0]!];
  const uniq = [...new Set(checkedStatements)]
    .filter((i) => i >= 0 && i < enriched.length)
    .sort((a, b) => a - b);
  if (uniq.length === 0) return [enriched[fallback] ?? enriched[0]!];
  return uniq.map((i) => enriched[i]!);
}

/** Source cell indices matching {@link statementsToRun} (for Out [n] labels). */
export function indicesToRun(
  sql: string,
  checkedStatements: number[],
  caretOffset?: number | null,
  split?: Split
): number[] {
  const all = split ?? splitSqlStatements(sql);
  if (all.length === 0) return [];
  // Must stay in step with statementsToRun or Out [n] labels the wrong cell.
  const fallback = statementIndexAtOffset(sql, caretOffset, all) ?? 0;
  if (checkedStatements.length === 0) return [fallback];
  const uniq = [...new Set(checkedStatements)]
    .filter((i) => i >= 0 && i < all.length)
    .sort((a, b) => a - b);
  if (uniq.length === 0) return [fallback];
  return uniq;
}

/**
 * All statements inside an editor selection (selection wins over the strip).
 * Falls back to the trimmed selection text when the splitter finds nothing.
 */
export function statementsFromSelection(selectedSql: string): string[] {
  const trimmed = selectedSql.trim();
  if (!trimmed) return [];
  const all = splitSqlStatements(trimmed);
  if (all.length === 0) return [trimmed];
  return reattachSetComments(trimmed, all);
}

/**
 * True when every statement is a JS/TS/Node code cell — no Destination server
 * is required (cells run in the browser worker or on the FoxSchema Node host).
 */
export function canExecuteWithoutDestination(statements: string[]): boolean {
  if (statements.length === 0) return false;
  return statements.every((s) => detectCodeCell(s) != null);
}

/**
 * Statements the Run button would send for the active tab (selection overrides strip).
 */
export function resolveRunStatements(
  sql: string,
  checkedStatements: number[],
  selectedSql: string | null | undefined,
  caretOffset?: number | null,
  split?: Split
): string[] {
  if (selectedSql?.trim()) return statementsFromSelection(selectedSql);
  return statementsToRun(sql, checkedStatements, caretOffset, split);
}

export function toggleStatementCheck(checked: number[], index: number): number[] {
  return checked.includes(index) ? checked.filter((i) => i !== index) : [...checked, index].sort((a, b) => a - b);
}

/**
 * Destination servers for a tab: either the shared list (all queries) or this
 * tab's own selection.
 */
export function effectiveConnectionIds(
  tab: SqlTab,
  shareDestinations: boolean,
  sharedConnectionIds: string[]
): string[] {
  return shareDestinations ? sharedConnectionIds : tab.selectedConnectionIds;
}

/** Shared-vs-per-tab destination write used by toggle / ensure / password submit. */
export function destinationIdsPatch(
  shareDestinations: boolean,
  tabs: SqlTab[],
  activeTabId: string,
  ids: string[]
): { sharedConnectionIds: string[] } | { tabs: SqlTab[] } {
  if (shareDestinations) return { sharedConnectionIds: ids };
  return {
    tabs: tabs.map((t) =>
      t.id === activeTabId ? { ...t, selectedConnectionIds: ids } : t
    ),
  };
}

/** Persistable tab slice (no checkedStatements / statementCount / results). */
export function persistableTabs(tabs: SqlTab[]): Array<Omit<SqlTab, 'checkedStatements' | 'statementCount'>> {
  return tabs.map(({ id, title, sql, selectedConnectionIds, layout, bookmarkId }) => ({
    id,
    title,
    sql,
    selectedConnectionIds,
    layout,
    ...(bookmarkId ? { bookmarkId } : {}),
  }));
}

/** Rehydrate persisted tabs — restore empty checks + recompute statementCount. */
export function hydrateTabs(
  raw: Array<Partial<SqlTab> & Pick<SqlTab, 'id'>>
): SqlTab[] {
  if (!raw.length) return [createTab({ title: 'Query 1' })];
  return raw.map((t, i) =>
    createTab({
      id: t.id,
      title: t.title ?? `Query ${i + 1}`,
      sql: t.sql ?? '',
      selectedConnectionIds: Array.isArray(t.selectedConnectionIds) ? t.selectedConnectionIds : [],
      layout: t.layout === 'sideBySide' ? 'sideBySide' : 'byCredential',
      checkedStatements: [],
      bookmarkId: typeof t.bookmarkId === 'string' ? t.bookmarkId : undefined,
    })
  );
}
