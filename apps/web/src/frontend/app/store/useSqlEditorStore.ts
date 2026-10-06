/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Editor client store (tabs, execute, schema cache, Data Peek).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { executeSql, type SqlStatementResult } from '@/shared/api/sqlApi';
import {
  DATA_PEEK_ROWS,
  MAX_DATA_PEEK_LIMIT,
  clampDataPeekLimit,
  createDataPeekEntry,
  dataPeekDrillKey,
  isCurrentDataPeekRun,
  moveDataPeekEntry,
  newDataPeekEntryId,
  nextDataPeekRunGeneration,
  patchDataPeekEntry,
  removeDataPeekSubtree,
  type DataPeekEntry,
  type DataPeekFilterPatch,
  type DataPeekState,
} from './sqlEditorDataPeek';
import { seekFromLastRow, tableForOrderBy } from '@/features/sql-editor/lib/resultSeek';
import { supportsDialectFeature } from '@/shared/lib/dialect-features';
import type { SavedConnectionSummary } from '@/shared/api/authApi';
import { resolveAppSecrets } from '@/shared/api/appSecretsApi';
import { loadSchema } from '@/shared/api/schemaApi';
import {
  collectMultiTableWriteWarnings,
  isInsertWriteStatement,
  isMutatingDmlStatement,
  isPageableStatement,
  isWriteStatement,
  splitSqlStatements,
} from '@/shared/lib/sql-splitter';
import type { CodeCellLast } from '@/features/sql-editor/lib/codeCellExec';
import { detectCodeCell, runCodeCell, usesServerBeam } from '@/features/sql-editor/lib/codeCellRunner';
import { beamAliasesForCount, MAX_SERVERS } from '@foxschema/shared';
import { buildSampleBookmarks } from '@/features/sql-editor/lib/sqlEditorSamples';
import {
  buildForeignKeyDrilldown,
  buildInboundDrilldown,
  buildOrphanPeek,
  fkKey,
  buildRowLookup,
  buildTablePreview,
  composePeekSql,
  fkDrillTableName,
} from '@/shared/lib/tablePreview';
import type { InboundForeignKey } from '@/shared/lib/tablePreview';
import {
  getSessionPassword,
  sessionPasswordMap,
  setSessionPassword,
} from '@/shared/lib/sessionPasswords';
import type { DbObjectType, ForeignKeyInfo } from '@/shared/lib/types';

function sessionPasswordFor(
  connectionId: string,
  map: Record<string, string>
): string | undefined {
  return getSessionPassword(connectionId) || map[connectionId] || undefined;
}
import { mergeVaultSecretsIntoVariables } from '@/features/sql-editor/lib/mergeVaultSecrets';
import {
  applySetDirectives,
  exportVariables,
  isValidVariableName,
  normalizeVariableName,
  parseImportedVariables,
  parseSetDirectives,
  prepareStatement,
  resolveVariablesForConnection,
  stripSecretsForPersist,
  type SetDirective,
  type SqlVariable,
  type SqlVariableExport,
  type SqlVariableKind,
  type VariableOverride,
} from '@/shared/lib/sql-variables';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { useSyncStore } from './useSyncStore';
import { SQL_EDITOR_PERSIST_KEY, SQL_EDITOR_PERSIST_VERSION, useRecentQueries } from './recentQueries';
import { deferredLocalStorage } from '@/shared/lib/deferredLocalStorage';
import type { SchemaCacheEntry } from '@/features/sql-editor/lib/sqlEditorBridge';
import {
  getCaretOffset,
  getSelectedSql,
  setSqlInsertFallback,
} from '@/features/sql-editor/lib/sqlEditorBridge';
import {
  addTab as addTabLogic,
  checkedAfterSqlChange,
  closeTab as closeTabLogic,
  createTab,
  destinationIdsPatch,
  effectiveConnectionIds,
  hydrateTabs,
  moveTab as moveTabLogic,
  newTabId,
  persistableTabs,
  canExecuteWithoutDestination,
  indicesToRun,
  resolveRunStatements,
  statementsToRun,
  toggleStatementCheck,
  type ResultsLayout,
  type SqlTab,
} from './sqlEditorTabLogic';

export type { SqlVariable, SqlVariableKind, SqlVariableExport, VariableOverride };

/**
 * Dialects whose adapters are SELECT-only — writes fail with a friendly error.
 *
 * Was a local Set that named SQLite, which is wrong: `sqlLite.adapter.ts`
 * opens the file read-write on purpose, because "the SQL editor runs user
 * DDL/DML against SQLite too, and a read-only handle fails those". Warning
 * that a SQLite target is read-only sent the reader looking for a problem that
 * was not there. It also disagreed with the *other* read-only list one file
 * over, which named ClickHouse alone.
 */
const isReadOnlyDialect = (dialect: string) =>
  !supportsDialectFeature(dialect, 'rowEditing');

type ExecutionTarget = Pick<
  SavedConnectionSummary,
  'id' | 'name' | 'dialect' | 'hasPassword' | 'authMethod'
>;

/** Synthetic run target when executing code cells with no Destination checked. */
const LOCAL_CODE_RUN_TARGET: ExecutionTarget = {
  id: '__local__',
  name: 'Local',
  dialect: 'editor',
  hasPassword: true,
};

/** Saved SQL script bookmark (persisted). */
export interface SqlBookmark {
  id: string;
  title: string;
  sql: string;
  selectedConnectionIds: string[];
  updatedAt: number;
}

/** Recently executed query (persisted, capped). */
export interface RecentQuery {
  id: string;
  sql: string;
  /** Tab title at run time (optional label). */
  title: string;
  /** Exact destinations used by this run; reopening must not follow today's selection. */
  selectedConnectionIds: string[];
  ranAt: number;
}

const MAX_RECENT_QUERIES = 40;

/** One checked credential's execution state for a tab's last run. */
export interface CredentialRun {
  connectionId: string;
  name: string;
  dialect: string;
  status: 'running' | 'done' | 'error';
  /** Connection-level failure (unreachable, bad password) — statement results absent. */
  error?: string;
  /** Per-statement outcomes, in statement order. */
  results?: SqlStatementResult[];
}

export interface TabResults {
  ranStatements: string[];
  /**
   * 0-based source cell indices aligned with `ranStatements` (for `Out [n]`).
   * Omitted for selection runs where indices are local to the selection.
   */
  ranStatementIndices?: number[];
  runs: CredentialRun[];
  /** Non-fatal messages (e.g. `@set` failures) for this run. */
  warnings?: string[];
  /**
   * Bumped on each execute start. Stale `loadResultPage` responses must not
   * apply when this no longer matches the epoch captured at fetch start.
   */
  pageEpoch?: number;
  /**
   * Per-connection prepared SQL for each statement index — used for Next/Prev page
   * without re-substituting variables.
   */
  pageSqlByConnection?: Record<string, string[]>;
  /** Cache of result pages: `${connectionId}:${statementIndex}:${pageIndex}` → result. */
  pageCache?: Record<string, SqlStatementResult>;
  /** UI page cursor + hasNext: `${connectionId}:${statementIndex}`. */
  pageMeta?: Record<string, ResultPageMeta>;
}

/** True when a page fetch may still write into this tab's results. */
export function isCurrentPageEpoch(
  expectedEpoch: number,
  currentEpoch: number | undefined
): boolean {
  return currentEpoch === expectedEpoch;
}

/** Per-statement result page cursor (server OFFSET paging). */
export interface ResultPageMeta {
  pageIndex: number;
  hasNext: boolean;
  loading?: boolean;
  pageSize: number;
}

function pageMetaKey(connectionId: string, statementIndex: number): string {
  return `${connectionId}:${statementIndex}`;
}

function pageCacheKey(connectionId: string, statementIndex: number, pageIndex: number): string {
  return `${pageMetaKey(connectionId, statementIndex)}:${pageIndex}`;
}

/** Max cached pages per statement (current page + a few neighbors). */
const MAX_PAGES_PER_STATEMENT = 5;
/** Soft TTL for loaded schema explorer entries. */
const SCHEMA_CACHE_TTL_MS = 15 * 60 * 1000;
/** Max connections kept in schemaCache (LRU by loadedAt). */
const SCHEMA_CACHE_MAX = 8;
/** SQL Editor explorer first paint — routines load when those groups open. */
export const SCHEMA_WARM_SCOPE = ['TABLE', 'VIEW', 'MQT'] as const;
export const SCHEMA_ROUTINE_SCOPE = ['PROCEDURE', 'FUNCTION'] as const;
const schemaLoadInflight = new Map<string, Promise<void>>();
/** Cap persisted tab/bookmark SQL to avoid QuotaExceededError. */
export const MAX_PERSISTED_SQL_CHARS = 256 * 1024;
/** Cap persisted bookmark count. */
export const MAX_PERSISTED_BOOKMARKS = 100;

/** Keep at most `maxPages` pages for one statement, preferring those near `keepAroundPage`. */
export function boundPageCache(
  cache: Record<string, SqlStatementResult>,
  connectionId: string,
  statementIndex: number,
  keepAroundPage: number,
  maxPages = MAX_PAGES_PER_STATEMENT
): Record<string, SqlStatementResult> {
  const prefix = `${pageMetaKey(connectionId, statementIndex)}:`;
  const keys = Object.keys(cache).filter((k) => k.startsWith(prefix));
  if (keys.length <= maxPages) return cache;
  const ranked = keys
    .map((k) => {
      const page = Number(k.slice(prefix.length));
      return { k, page, dist: Math.abs(page - keepAroundPage) };
    })
    .sort((a, b) => b.dist - a.dist || b.page - a.page);
  const next = { ...cache };
  while (ranked.length > maxPages) {
    const drop = ranked.shift();
    if (!drop) break;
    delete next[drop.k];
  }
  return next;
}

export function truncatePersistedSql(sql: string, max = MAX_PERSISTED_SQL_CHARS): string {
  if (sql.length <= max) return sql;
  return sql.slice(0, max);
}

/** Drop expired schema entries and enforce max connection count (LRU by loadedAt). */
export function pruneSchemaCache(
  cache: Record<string, SchemaCacheEntry>,
  now = Date.now()
): Record<string, SchemaCacheEntry> {
  const next: Record<string, SchemaCacheEntry> = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (
      entry.status === 'ready' &&
      typeof entry.loadedAt === 'number' &&
      now - entry.loadedAt >= SCHEMA_CACHE_TTL_MS
    ) {
      continue;
    }
    next[id] = entry;
  }
  const ready = Object.entries(next)
    .filter(([, e]) => e.status === 'ready')
    .sort((a, b) => (a[1].loadedAt ?? 0) - (b[1].loadedAt ?? 0));
  while (ready.length > SCHEMA_CACHE_MAX) {
    const drop = ready.shift();
    if (!drop) break;
    delete next[drop[0]];
  }
  return next;
}

/** Password prompt for a connection saved without one (session-only). */
export interface PendingPasswordPrompt {
  id: string;
  name: string;
  /** When true, resume execute() after the password is submitted. */
  resumeExecute: boolean;
  /** When set, resume only refreshes these credentials. */
  connectionIds?: string[];
  /** When set, resume runs only these statement indices (per-cell Play). */
  statementIndices?: number[];
}

export interface ReadonlyWriteTarget {
  name: string;
  dialect: string;
}

/**
 * Data peek's shape and its pure operations live in `sqlEditorDataPeek.ts`.
 * Re-exported here because `DataPeekEntry` is imported from this module by
 * `DataPeekPanel.tsx`, `ResultsPanel.tsx` and `dataPeekSubtree.test.ts`, and a
 * slice extraction should not churn its callers.
 */
export {
  DATA_PEEK_ROWS,
  MAX_DATA_PEEK_LIMIT,
  clampDataPeekLimit,
  createDataPeekEntry,
  dataPeekDrillKey,
  isCurrentDataPeekRun,
  moveDataPeekEntry,
  newDataPeekEntryId,
  nextDataPeekRunGeneration,
  patchDataPeekEntry,
  removeDataPeekSubtree,
  type DataPeekEntry,
  type DataPeekFilterPatch,
  type DataPeekState,
};

interface SqlEditorState {
  tabs: SqlTab[];
  activeTabId: string;
  /** Results keyed by tab id — never persisted. */
  resultsByTab: Record<string, TabResults>;
  /** Session-only passwords. NEVER persisted. */
  sessionPasswords: Record<string, string>;
  /** Loaded schemas by connection id — never persisted. */
  schemaCache: Record<string, SchemaCacheEntry>;
  /** Tab currently executing (null when idle). */
  runningTabId: string | null;
  pendingWriteConfirm: {
    tabId: string;
    writeStatements: string[];
    credentialCount: number;
    /** Checked credentials whose dialect cannot execute writes. */
    readonlyTargets: ReadonlyWriteTarget[];
    /** Write statements that meet the multi-table threshold (SELECT/JOIN reads omitted). */
    multiTableStatements: Array<{ text: string; tableCount: number; tables: string[] }>;
    /** When set, confirm resumes execute for only these credentials. */
    connectionIds?: string[];
    /** When set, confirm resumes execute for only these statement indices. */
    statementIndices?: number[];
  } | null;
  pendingPassword: PendingPasswordPrompt | null;
  maxRows: number;
  /**
   * When true, confirm before UPDATE / DELETE / MERGE (and other writes).
   * Default on — turn off only when you intentionally want unguarded runs.
   */
  safeMode: boolean;
  /**
   * Prompt when a *write* statement references this many (or more) tables.
   * SELECT / JOIN reads skip this check. Suggests wrapping related writes in a
   * transaction. `0` disables the check.
   */
  multiTableConfirmThreshold: number;
  /**
   * When true, every query tab shares `sharedConnectionIds`.
   * When false, each tab keeps its own `selectedConnectionIds`.
   */
  shareDestinations: boolean;
  sharedConnectionIds: string[];
  /** Named saved scripts — persisted. */
  bookmarks: SqlBookmark[];
  /** Recent runs for quick reuse — persisted. */
  recentQueries: RecentQuery[];
  /** Global SQL Editor variables (`${{name}}`) — persisted. */
  variables: SqlVariable[];

  activeTab: () => SqlTab;
  /** Destination server ids for the active tab (respects shareDestinations). */
  activeConnectionIds: () => string[];
  setSql: (sql: string) => void;
  toggleConnection: (id: string) => void;
  /**
   * Ensure a destination credential is checked for the active tab (add-only).
   * Used to keep the Schema explorer selection aligned with Destination servers.
   * May open the session-password prompt when the credential has no stored password.
   */
  ensureConnectionSelected: (id: string) => void;
  setShareDestinations: (share: boolean) => void;
  setSafeMode: (on: boolean) => void;
  setMultiTableConfirmThreshold: (n: number) => void;
  openRecentQuery: (id: string) => void;
  clearRecentQueries: () => void;
  toggleStatement: (index: number) => void;
  setLayout: (layout: ResultsLayout) => void;
  addTab: () => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  /** Drag-reorder query tabs. No-op when indices are equal/out of range. */
  moveTab: (fromIndex: number, toIndex: number) => void;
  submitSessionPassword: (password: string) => void;
  cancelPasswordPrompt: () => void;
  setMaxRows: (n: number) => void;
  ensureSchema: (
    connectionId: string,
    opts?: { force?: boolean; scope?: readonly string[] }
  ) => Promise<void>;
  /**
   * Re-run SQL.
   * - `connectionIds` — refresh only those credentials (keeps other panes).
   * - `statementIndices` — run only these split indices (per-cell Play; ignores
   *   strip checks and editor selection).
   */
  execute: (opts?: {
    confirmedWrites?: boolean;
    connectionIds?: string[];
    statementIndices?: number[];
  }) => Promise<void>;
  /** Load a cached or server page for one statement result grid. */
  loadResultPage: (args: {
    connectionId: string;
    statementIndex: number;
    pageIndex: number;
  }) => Promise<void>;
  /**
   * Re-fetch the current page for one statement (bypass page cache).
   * Used after row CRUD on a query-result grid — same idea as runDataPeekEntry.
   */
  reloadResultPage: (args: {
    connectionId: string;
    statementIndex: number;
    pageIndex: number;
  }) => Promise<void>;
  cancelWriteConfirm: () => void;
  clearResults: () => void;
  saveBookmark: (opts?: { title?: string }) => void;
  openBookmark: (id: string) => void;
  renameBookmark: (id: string, title: string) => void;
  deleteBookmark: (id: string) => void;
  /** Merge built-in JS/TS/Node sample bookmarks (by stable id). Returns how many were added/updated. */
  installSampleBookmarks: () => number;

  /**
   * Cmd/Ctrl-click data peek: a stack of grids, each drilled from the one above
   * via a foreign key. Never persisted — it is a look, not a document.
   */
  dataPeek: DataPeekState | null;
  openDataPeek: (connectionId: string, tableName: string) => Promise<void>;
  /**
   * Open Data Peek from an editor-result FK cell (no schema Cmd/Ctrl-click).
   * Seeds the stack with the parent rows for that key.
   */
  openDataPeekFromFk: (
    connectionId: string,
    fk: ForeignKeyInfo,
    values: unknown[]
  ) => Promise<void>;
  /**
   * Open the child rows whose foreign key points at a parent row that is gone.
   *
   * A scan, unlike the rest of Peek's catalog reads, so it is reached only by
   * asking for it from the Insight tab.
   */
  openDataPeekOrphans: (
    connectionId: string,
    childTable: string,
    fk: ForeignKeyInfo
  ) => Promise<void>;
  /**
   * Open one row of one table, given its key — the way out of a joined result.
   *
   * A join cannot be edited: its rows are not rows of any single table, and a
   * fanned-out parent appears many times over. Re-fetching the row from its own
   * table gives a single-table grid, which the existing CRUD path can edit
   * safely without the join ever becoming writable.
   */
  openDataPeekForRow: (
    connectionId: string,
    tableName: string,
    keys: readonly { column: string; value: unknown }[]
  ) => Promise<void>;
  drillDataPeek: (
    fromEntryId: string,
    fk: ForeignKeyInfo,
    values: unknown[]
  ) => Promise<void>;
  /** The other direction: rows that reference the row you are looking at. */
  drillDataPeekInbound: (
    fromEntryId: string,
    child: InboundForeignKey,
    values: unknown[]
  ) => Promise<void>;
  closeDataPeek: () => void;
  /** Drop `entryId` and every grid below it (click a breadcrumb to go back). */
  closeDataPeekFrom: (entryId: string) => void;
  /** Apply WHERE / ORDER BY / LIMIT on one peek panel and re-run. */
  updateDataPeekFilters: (entryId: string, patch: DataPeekFilterPatch) => Promise<void>;
  /**
   * Drop the FK drilldown predicate baked into baseSql (e.g. `ID = 33`) and
   * re-run as `SELECT * FROM <table>` plus any user WHERE / ORDER BY.
   */
  clearDataPeekBaseFilter: (entryId: string) => Promise<void>;
  /** Persist a dragged panel height. */
  setDataPeekPanelHeight: (entryId: string, heightPx: number) => void;
  /** Drag panels to rearrange the vertical stack. */
  reorderDataPeekEntries: (fromIndex: number, toIndex: number) => void;
  /** Load another OFFSET page for one peek panel. */
  pageDataPeekEntry: (entryId: string, pageIndex: number) => Promise<void>;
  /** Internal: (re)run one peek entry's query. */
  runDataPeekEntry: (entryId: string) => Promise<void>;
  /** Create or overwrite a variable by name. Returns error string or null. */
  upsertVariable: (input: {
    name: string;
    kind: SqlVariableKind;
    value?: unknown;
    values?: unknown[];
    columns?: string[];
    rows?: unknown[][];
    secret?: boolean;
    overrides?: Record<string, VariableOverride>;
    /** When set, rename/update that id instead of matching by name. */
    id?: string;
  }) => string | null;
  deleteVariable: (id: string) => void;
  setVariableSecret: (id: string, secret: boolean) => void;
  setVariableOverride: (
    id: string,
    connectionId: string,
    override: VariableOverride | null
  ) => void;
  /** Merge imported variables by name. Returns error or null. */
  importVariables: (raw: unknown, opts?: { overwrite?: boolean }) => string | null;
  exportVariablesJson: () => string;
}

const firstTab = createTab({ title: 'Query 1' });

export type { ResultsLayout, SqlTab };

export const useSqlEditorStore = create<SqlEditorState>()(
  persist(
    (set, get) => ({
      tabs: [firstTab],
      activeTabId: firstTab.id,
      resultsByTab: {},
      sessionPasswords: {},
      schemaCache: {},
      runningTabId: null,
      pendingWriteConfirm: null,
      pendingPassword: null,
      maxRows: 200,
      safeMode: true,
      multiTableConfirmThreshold: 3,
      shareDestinations: true,
      sharedConnectionIds: [],
      bookmarks: [],
      recentQueries: [],
      variables: [],

      activeTab: () => {
        const { tabs, activeTabId } = get();
        return tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;
      },

      activeConnectionIds: () => {
        const { tabs, activeTabId, shareDestinations, sharedConnectionIds } = get();
        const tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;
        return effectiveConnectionIds(tab, shareDestinations, sharedConnectionIds);
      },

      setSql: (sql) => {
        const { tabs, activeTabId } = get();
        set({
          tabs: tabs.map((t) => {
            if (t.id !== activeTabId) return t;
            // One split of the new buffer; previous count is cached on the tab.
            const statementCount = splitSqlStatements(sql).length;
            return {
              ...t,
              sql,
              statementCount,
              checkedStatements: checkedAfterSqlChange(
                t.statementCount,
                statementCount,
                t.checkedStatements
              ),
            };
          }),
        });
      },

      setShareDestinations: (share) => {
        const { tabs, activeTabId, sharedConnectionIds } = get();
        const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;
        if (share) {
          // Adopt the active tab's destinations as the shared set.
          set({
            shareDestinations: true,
            sharedConnectionIds: [...active.selectedConnectionIds],
          });
          return;
        }
        // Push shared destinations onto every tab so nothing is lost.
        set({
          shareDestinations: false,
          tabs: tabs.map((t) => ({
            ...t,
            selectedConnectionIds: [...sharedConnectionIds],
          })),
        });
      },

      toggleConnection: (id) => {
        const { tabs, activeTabId, shareDestinations, sharedConnectionIds } = get();
        const tab = tabs.find((t) => t.id === activeTabId);
        if (!tab) return;

        const current = shareDestinations ? sharedConnectionIds : tab.selectedConnectionIds;
        if (current.includes(id)) {
          set(
            destinationIdsPatch(
              shareDestinations,
              tabs,
              activeTabId,
              current.filter((x) => x !== id)
            )
          );
          return;
        }

        get().ensureConnectionSelected(id);
      },

      ensureConnectionSelected: (id) => {
        const { tabs, activeTabId, sessionPasswords, shareDestinations, sharedConnectionIds } =
          get();
        const tab = tabs.find((t) => t.id === activeTabId);
        if (!tab || !id) return;

        const current = shareDestinations ? sharedConnectionIds : tab.selectedConnectionIds;
        if (current.includes(id)) return;

        const conn = useSyncStore.getState().connections.find((c) => c.id === id);
        // A file database has no password to be missing. Prompting for one
        // left the destination checkbox refusing to tick, so SQLite could not
        // be run against at all.
        if (
          conn &&
          !conn.hasPassword &&
          connectionNeedsSecret(conn.dialect, conn.authMethod) &&
          !sessionPasswordFor(id, sessionPasswords)
        ) {
          set({
            pendingPassword: {
              id,
              name: conn.name || conn.dialect,
              resumeExecute: false,
            },
          });
          return;
        }

        set(destinationIdsPatch(shareDestinations, tabs, activeTabId, [...current, id]));
        void get().ensureSchema(id);
      },

      toggleStatement: (index) => {
        const { tabs, activeTabId } = get();
        set({
          tabs: tabs.map((t) =>
            t.id === activeTabId
              ? { ...t, checkedStatements: toggleStatementCheck(t.checkedStatements, index) }
              : t
          ),
        });
      },

      setLayout: (layout) => {
        const { tabs, activeTabId } = get();
        set({
          tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, layout } : t)),
        });
      },

      addTab: () => {
        const next = addTabLogic(get().tabs);
        set(next);
      },

      closeTab: (id) => {
        const { tabs, activeTabId, resultsByTab } = get();
        const next = closeTabLogic(tabs, activeTabId, id);
        const { [id]: _removed, ...restResults } = resultsByTab;
        set({ ...next, resultsByTab: restResults });
      },

      setActiveTab: (id) => {
        if (get().tabs.some((t) => t.id === id)) set({ activeTabId: id });
      },

      moveTab: (fromIndex, toIndex) => {
        const next = moveTabLogic(get().tabs, fromIndex, toIndex);
        if (next !== get().tabs) set({ tabs: next });
      },

      renameTab: (id, title) => {
        const trimmed = title.trim() || 'Query';
        const { tabs, bookmarks } = get();
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return;

        // Prefer an explicit link; otherwise match the bookmark we saved from this SQL.
        let linkId = tab.bookmarkId;
        if (!linkId) {
          const byTitleAndSql = bookmarks.find(
            (b) => b.title === tab.title && b.sql === tab.sql
          );
          const bySqlAlone = bookmarks.filter((b) => b.sql === tab.sql);
          linkId =
            byTitleAndSql?.id ??
            (bySqlAlone.length === 1 ? bySqlAlone[0]!.id : undefined);
        }

        set({
          tabs: tabs.map((t) =>
            t.id === id
              ? { ...t, title: trimmed, ...(linkId ? { bookmarkId: linkId } : {}) }
              : t
          ),
          bookmarks: linkId
            ? bookmarks.map((b) =>
                b.id === linkId ? { ...b, title: trimmed, updatedAt: Date.now() } : b
              )
            : bookmarks,
        });
      },

      submitSessionPassword: (password) => {
        const { pendingPassword, tabs, activeTabId, shareDestinations, sharedConnectionIds } =
          get();
        if (!pendingPassword) return;
        const { id, resumeExecute, connectionIds, statementIndices } = pendingPassword;
        const trimmed = password.trim();
        if (!trimmed) return;

        const current = shareDestinations
          ? sharedConnectionIds
          : (tabs.find((t) => t.id === activeTabId)?.selectedConnectionIds ?? []);
        const destPatch = current.includes(id)
          ? {}
          : destinationIdsPatch(shareDestinations, tabs, activeTabId, [...current, id]);

        setSessionPassword(id, trimmed);
        set({
          sessionPasswords: sessionPasswordMap(),
          pendingPassword: null,
          ...destPatch,
        });
        // Keep Schema Sync source/target configs warm with the same session password.
        const sync = useSyncStore.getState();
        if (sync.selectedSourceConnectionId === id) {
          sync.applySavedConnection('source', id, trimmed);
        }
        if (sync.selectedTargetConnectionId === id) {
          sync.applySavedConnection('target', id, trimmed);
        }
        if (resumeExecute) {
          void get().execute({
            ...(connectionIds?.length ? { connectionIds } : {}),
            ...(statementIndices?.length ? { statementIndices } : {}),
          });
        } else {
          void get().ensureSchema(id, { force: true });
        }
      },

      cancelPasswordPrompt: () => set({ pendingPassword: null }),

      setMaxRows: (n) => set({ maxRows: Math.min(5000, Math.max(1, Math.floor(n) || 200)) }),

      setSafeMode: (on) => set({ safeMode: on }),

      setMultiTableConfirmThreshold: (n) =>
        set({
          multiTableConfirmThreshold: Math.max(0, Math.min(50, Math.floor(Number(n) || 0))),
        }),

      openRecentQuery: (id) => {
        const { recentQueries, tabs, shareDestinations } = get();
        const entry = recentQueries.find((r) => r.id === id);
        if (!entry) return;
        const selectedConnectionIds = [...entry.selectedConnectionIds];
        const tab = createTab({
          title: entry.title?.trim() || 'Recent query',
          sql: entry.sql,
          selectedConnectionIds,
        });
        set({
          tabs: [...tabs, tab],
          activeTabId: tab.id,
          // Shared mode drives execution from this global list, so restore it
          // as well as the tab-local copy. Otherwise the reopened SQL silently
          // follows whichever database happens to be selected now.
          ...(shareDestinations ? { sharedConnectionIds: selectedConnectionIds } : {}),
        });
      },

      clearRecentQueries: () => set({ recentQueries: [] }),

      ensureSchema: async (connectionId, { force = false, scope } = {}) => {
        const wanted = [...(scope && scope.length ? scope : SCHEMA_WARM_SCOPE)];
        const inflightKey = `${connectionId}:${wanted.join(',')}`;
        const running = schemaLoadInflight.get(inflightKey);
        if (running) return running;

        const work = (async () => {
        const prunedStart = pruneSchemaCache(get().schemaCache);
        if (Object.keys(prunedStart).length !== Object.keys(get().schemaCache).length) {
          set({ schemaCache: prunedStart });
        }
        const existing = get().schemaCache[connectionId];
        const have = new Set(existing?.scope ?? []);
        const scopeOk = wanted.every((t) => have.has(t));
        const fresh =
          existing?.status === 'ready' &&
          typeof existing.loadedAt === 'number' &&
          Date.now() - existing.loadedAt < SCHEMA_CACHE_TTL_MS;
        if (!force && scopeOk && existing?.status === 'ready' && fresh) {
          return;
        }

        const conn = useSyncStore.getState().connections.find((c) => c.id === connectionId);
        if (!conn) {
          set({
            schemaCache: pruneSchemaCache({
              ...get().schemaCache,
              [connectionId]: { status: 'error', error: 'Connection not found' },
            }),
          });
          return;
        }

        const { sessionPasswords } = get();
        if (
          !conn.hasPassword &&
          connectionNeedsSecret(conn.dialect, conn.authMethod) &&
          !sessionPasswordFor(connectionId, sessionPasswords)
        ) {
          set({
            pendingPassword: {
              id: connectionId,
              name: conn.name || conn.dialect,
              resumeExecute: false,
            },
            schemaCache: pruneSchemaCache({
              ...get().schemaCache,
              [connectionId]: {
                status: 'error',
                error: 'Password required — enter it when prompted, then reload schema.',
              },
            }),
          });
          return;
        }

        set({
          schemaCache: pruneSchemaCache({
            ...get().schemaCache,
            [connectionId]: {
              status: 'loading',
              tables: existing?.tables,
              scope: existing?.scope ?? wanted,
            },
          }),
        });

        try {
          const { tables: loaded } = await loadSchema(
            { connectionId, password: sessionPasswordFor(connectionId, sessionPasswords) },
            wanted as DbObjectType[]
          );
          const incoming = new Set(wanted);
          // Merge against the cache at completion time. Different scope loads
          // intentionally use different in-flight keys and can overlap; using
          // the snapshot from before either request awaited lets the slower
          // response erase objects written by the faster one.
          set((state) => {
            const current = state.schemaCache[connectionId];
            const kept = (current?.tables ?? []).filter(
              (table) => !incoming.has(table.objectType)
            );
            const mergedScope = [...new Set([...(current?.scope ?? []), ...wanted])];
            return {
              schemaCache: pruneSchemaCache({
                ...state.schemaCache,
                [connectionId]: {
                  status: 'ready',
                  tables: [...kept, ...loaded],
                  scope: mergedScope,
                  loadedAt: Date.now(),
                },
              }),
            };
          });
        } catch (error: unknown) {
          set({
            schemaCache: pruneSchemaCache({
              ...get().schemaCache,
              [connectionId]: {
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                scope: existing?.scope ?? wanted,
              },
            }),
          });
        }
        })();

        schemaLoadInflight.set(inflightKey, work);
        try {
          await work;
        } finally {
          if (schemaLoadInflight.get(inflightKey) === work) schemaLoadInflight.delete(inflightKey);
        }
      },

      cancelWriteConfirm: () => set({ pendingWriteConfirm: null }),

      clearResults: () => {
        const { activeTabId, resultsByTab } = get();
        const { [activeTabId]: _cleared, ...rest } = resultsByTab;
        set({ resultsByTab: rest });
      },

      execute: async ({ confirmedWrites = false, connectionIds, statementIndices } = {}) => {
        const {
          tabs,
          activeTabId,
          sessionPasswords,
          maxRows,
          runningTabId,
          shareDestinations,
          sharedConnectionIds,
          safeMode,
          multiTableConfirmThreshold,
        } = get();
        if (runningTabId) return;

        const tab = tabs.find((t) => t.id === activeTabId);
        if (!tab) return;

        const destIds = effectiveConnectionIds(tab, shareDestinations, sharedConnectionIds);
        const selected = useSyncStore
          .getState()
          .connections.filter((c) => destIds.includes(c.id));
        const selectedConnections =
          connectionIds && connectionIds.length > 0
            ? selected.filter((c) => connectionIds.includes(c.id))
            : selected;

        // Per-cell Play: run exactly those indices (ignore strip checks + selection).
        const selectedSql = getSelectedSql();
        // Only consulted when nothing is checked and nothing is selected — then
        // Run means "this statement", not "the first one in the buffer".
        const caretOffset = getCaretOffset();
        const fromSelection =
          !(statementIndices && statementIndices.length > 0) && Boolean(selectedSql?.trim());
        const rawStatements =
          statementIndices && statementIndices.length > 0
            ? statementsToRun(tab.sql, statementIndices)
            : resolveRunStatements(tab.sql, tab.checkedStatements, selectedSql, caretOffset);
        // Align Out [n] with In [n] when running from strip / Play (not selection).
        const sourceIndices = fromSelection
          ? null
          : indicesToRun(
              tab.sql,
              statementIndices && statementIndices.length > 0
                ? statementIndices
                : tab.checkedStatements,
              caretOffset
            );

        // Code cells (JS/TS/Node) can run with no Destination; SQL still needs one.
        let connections: ExecutionTarget[] = selectedConnections;
        if (connections.length === 0) {
          if (!canExecuteWithoutDestination(rawStatements)) {
            const prev = get().resultsByTab[tab.id];
            set({
              resultsByTab: {
                ...get().resultsByTab,
                [tab.id]: {
                  ranStatements: prev?.ranStatements ?? [],
                  ranStatementIndices: prev?.ranStatementIndices,
                  runs: prev?.runs ?? [],
                  warnings: ['Check a Destination server to run SQL cells.'],
                  pageEpoch: prev?.pageEpoch,
                  pageCache: prev?.pageCache,
                  pageMeta: prev?.pageMeta,
                  pageSqlByConnection: prev?.pageSqlByConnection,
                },
              },
            });
            return;
          }
          connections = [LOCAL_CODE_RUN_TARGET];
        }

        const needingPassword = connections.find(
          (c) =>
            !c.hasPassword &&
            connectionNeedsSecret(c.dialect, c.authMethod) &&
            !sessionPasswordFor(c.id, sessionPasswords)
        );
        if (needingPassword) {
          set({
            pendingPassword: {
              id: needingPassword.id,
              name: needingPassword.name || needingPassword.dialect,
              resumeExecute: true,
              connectionIds: connectionIds?.length ? connectionIds : undefined,
              statementIndices: statementIndices?.length ? statementIndices : undefined,
            },
          });
          return;
        }

        // Safe mode: confirm on stripped SQL (ignore @set lines; vars may resolve mid-run).
        const strippedForConfirm = rawStatements.map((s) => parseSetDirectives(s).sql);
        const writeStatements = strippedForConfirm.filter((s) => isWriteStatement(s));
        // Insert-only writes skip Safe Mode; UPDATE/DELETE/MERGE and DDL still confirm.
        const confirmWrites = writeStatements.filter((s) => !isInsertWriteStatement(s));
        const mutatingDml = confirmWrites.filter((s) => isMutatingDmlStatement(s));
        const multiTableStatements = safeMode
          ? collectMultiTableWriteWarnings(strippedForConfirm, multiTableConfirmThreshold)
          : [];
        const needsConfirm =
          safeMode &&
          !confirmedWrites &&
          (mutatingDml.length > 0 ||
            confirmWrites.length > 0 ||
            multiTableStatements.length > 0);
        if (needsConfirm) {
          const readonlyTargets = connections
            .filter((c) => isReadOnlyDialect(c.dialect))
            .map((c) => ({ name: c.name || c.dialect, dialect: c.dialect }));
          set({
            pendingWriteConfirm: {
              tabId: tab.id,
              writeStatements: confirmWrites,
              credentialCount: connections.length,
              readonlyTargets,
              multiTableStatements,
              connectionIds: connectionIds?.length ? connectionIds : undefined,
              // Pin what was confirmed. Resuming re-derives from the editor, so
              // without this the caret (or strip checks) could move between
              // "Run" and "Confirm" and a different statement than the one
              // listed in the dialog would execute.
              statementIndices: statementIndices?.length
                ? statementIndices
                : (sourceIndices ?? undefined),
            },
          });
          return;
        }

        const tabId = tab.id;
        const targetIds = new Set(connections.map((c) => c.id));
        const existing = get().resultsByTab[tabId];
        const partial = Boolean(connectionIds?.length && existing);

        const runningStub = (c: (typeof connections)[number]): CredentialRun => ({
          connectionId: c.id,
          name: c.name || c.dialect,
          dialect: c.dialect,
          status: 'running',
        });

        let nextRuns: CredentialRun[];
        if (partial && existing) {
          nextRuns = existing.runs.map((r) =>
            targetIds.has(r.connectionId)
              ? {
                  connectionId: r.connectionId,
                  name: r.name,
                  dialect: r.dialect,
                  status: 'running' as const,
                }
              : r
          );
          for (const c of connections) {
            if (!nextRuns.some((r) => r.connectionId === c.id)) {
              nextRuns.push(runningStub(c));
            }
          }
        } else {
          nextRuns = connections.map(runningStub);
        }

        // Accumulate per-connection results as we run statements sequentially.
        const resultsByConn = new Map<string, SqlStatementResult[]>();
        const pageSqlByConn = new Map<string, string[]>();
        for (const c of connections) {
          resultsByConn.set(c.id, []);
          pageSqlByConn.set(c.id, []);
        }

        const pageEpoch = (get().resultsByTab[tabId]?.pageEpoch ?? 0) + 1;
        set({
          pendingWriteConfirm: null,
          runningTabId: tabId,
          resultsByTab: {
            ...get().resultsByTab,
            [tabId]: {
              ranStatements: [],
              ranStatementIndices: [],
              runs: nextRuns,
              warnings: [],
              pageEpoch,
              pageCache: {},
              pageMeta: {},
              pageSqlByConnection: {},
            },
          },
        });

        const patchRun = (id: string, patch: Partial<CredentialRun>) =>
          set((state) => {
            const current = state.resultsByTab[tabId];
            if (!current) return state;
            return {
              resultsByTab: {
                ...state.resultsByTab,
                [tabId]: {
                  ...current,
                  runs: current.runs.map((r) => (r.connectionId === id ? { ...r, ...patch } : r)),
                },
              },
            };
          });

        const setRanStatements = (stmts: string[], indices: number[]) =>
          set((state) => {
            const current = state.resultsByTab[tabId];
            if (!current) return state;
            return {
              resultsByTab: {
                ...state.resultsByTab,
                [tabId]: {
                  ...current,
                  ranStatements: stmts,
                  ranStatementIndices: indices,
                },
              },
            };
          });

        const appendWarning = (msg: string) =>
          set((state) => {
            const current = state.resultsByTab[tabId];
            if (!current) return state;
            return {
              resultsByTab: {
                ...state.resultsByTab,
                [tabId]: {
                  ...current,
                  warnings: [...(current.warnings ?? []), msg],
                },
              },
            };
          });

        // Vault secrets (local + cloud) merge into vars for this Run; session Variables win on name clash.
        let runVariables = get().variables;
        try {
          const vault = await resolveAppSecrets();
          for (const [name, msg] of Object.entries(vault.errors)) {
            appendWarning(`Secret "${name}": ${msg}`);
          }
          runVariables = mergeVaultSecretsIntoVariables(get().variables, vault.secrets);
        } catch (err: unknown) {
          appendWarning(
            `App Secrets unavailable: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const ranDisplay: string[] = [];
        const ranIndexDisplay: number[] = [];
        let aborted: string | null = null;

        const lastGridFrom = (prev: SqlStatementResult[]): CodeCellLast => {
          const prior = prev[prev.length - 1];
          return prior?.ok
            ? { columns: prior.columns, rows: prior.rows, rowCount: prior.rowCount }
            : null;
        };

        const setPageSql = (connectionId: string, index: number, sql: string) => {
          const sqlList = pageSqlByConn.get(connectionId) ?? [];
          while (sqlList.length < index) sqlList.push('');
          sqlList[index] = sql;
          pageSqlByConn.set(connectionId, sqlList);
        };

        const applySetsFromFirstOk = (directives: SetDirective[], index: number) => {
          if (directives.length === 0) return;
          for (const c of connections) {
            const res = resultsByConn.get(c.id)?.[index];
            if (!res?.ok) continue;
            const sets = applySetDirectives(directives, res);
            if (sets.ok) {
              for (const u of sets.updates) get().upsertVariable(u);
            } else {
              appendWarning(sets.error);
            }
            break;
          }
        };

        for (let si = 0; si < rawStatements.length; si++) {
          const raw = rawStatements[si]!;

          if (detectCodeCell(raw)) {
            ranDisplay.push(raw);
            ranIndexDisplay.push(sourceIndices?.[si] ?? si);
            setRanStatements([...ranDisplay], [...ranIndexDisplay]);

            let codeDirectives: SetDirective[] = [];
            const isLastStmt = si === rawStatements.length - 1;

            // Server Beam (`sql.on`) runs once across up to two Destinations
            // (order = source, then target) instead of fan-out per credential.
            if (usesServerBeam(raw)) {
              // Do NOT silently truncate: which physical server each alias
              // points at decides where a migration writes, so an ambiguous
              // selection must stop the run rather than pick two arbitrarily.
              const tooMany = connections.length > MAX_SERVERS;
              const beamConns = connections.slice(0, MAX_SERVERS);
              const aliases = beamAliasesForCount(beamConns.length);
              const beam = beamConns.map((c, i) => ({
                alias: aliases[i]!,
                connectionId: c.id,
                password: sessionPasswordFor(c.id, sessionPasswords),
              }));
              const primary = beamConns[0];
              if (tooMany) {
                appendWarning(
                  `Server Beam uses at most ${MAX_SERVERS} Destinations, but ${connections.length} are checked. ` +
                    'Uncheck the extras so source and target are unambiguous, then re-run.'
                );
              } else if (!primary) {
                appendWarning(
                  'Server Beam needs at least one Destination checked (source). ' +
                    'For cross-server copy, check two — first is source, second is target.'
                );
              } else {
                // Say out loud which server each alias resolved to. `sql.on('target')`
                // writing to the wrong database is the failure this feature can
                // cause, and alias order comes from the list, not the click order.
                appendWarning(
                  `Server Beam → ${beam
                    .map((b, i) => `${b.alias} = ${beamConns[i]!.name}`)
                    .join(', ')}`
                );
                const prev = resultsByConn.get(primary.id) ?? [];
                try {
                  const { result, directives } = await runCodeCell({
                    statement: raw,
                    last: lastGridFrom(prev),
                    variables: resolveVariablesForConnection(runVariables, primary.id),
                    maxRows,
                    ref: {
                      connectionId: primary.id,
                      password: sessionPasswordFor(primary.id, sessionPasswords),
                    },
                    beam,
                    allowWrites: !safeMode,
                  });
                  codeDirectives = directives;
                  for (const c of beamConns) {
                    const list = resultsByConn.get(c.id) ?? [];
                    list.push(result);
                    resultsByConn.set(c.id, list);
                    setPageSql(c.id, si, '');
                    patchRun(c.id, {
                      status: isLastStmt ? 'done' : 'running',
                      results: [...list],
                      error: result.ok ? undefined : result.error,
                    });
                  }
                } catch (error: unknown) {
                  const msg = error instanceof Error ? error.message : String(error);
                  for (const c of beamConns) {
                    const list = resultsByConn.get(c.id) ?? [];
                    list.push({ ok: false, error: msg, durationMs: 0 });
                    resultsByConn.set(c.id, list);
                    patchRun(c.id, { status: 'error', error: msg, results: [...list] });
                  }
                }
              }
              applySetsFromFirstOk(codeDirectives, si);
              continue;
            }

            await Promise.allSettled(
              connections.map(async (c) => {
                const prev = resultsByConn.get(c.id) ?? [];
                try {
                  const { result, directives } = await runCodeCell({
                    statement: raw,
                    last: lastGridFrom(prev),
                    variables: resolveVariablesForConnection(runVariables, c.id),
                    maxRows,
                    // A `-- @node` cell's `sql` runs on the same credential the
                    // rest of the run uses, under the same Safe-mode policy.
                    ref: { connectionId: c.id, password: sessionPasswordFor(c.id, sessionPasswords) },
                    allowWrites: !safeMode,
                  });
                  codeDirectives = directives;
                  prev.push(result);
                  resultsByConn.set(c.id, prev);
                  setPageSql(c.id, si, ''); // code cells are not re-pageable
                  patchRun(c.id, {
                    status: isLastStmt ? 'done' : 'running',
                    results: [...prev],
                    error: result.ok ? undefined : result.error,
                  });
                } catch (error: unknown) {
                  const msg = error instanceof Error ? error.message : String(error);
                  prev.push({ ok: false, error: msg, durationMs: 0 });
                  resultsByConn.set(c.id, prev);
                  patchRun(c.id, {
                    status: 'error',
                    error: msg,
                    results: [...prev],
                  });
                }
              })
            );

            applySetsFromFirstOk(codeDirectives, si);
            continue;
          }

          const { directives } = parseSetDirectives(raw);

          type Prep =
            | { ok: true; sql: string }
            | { ok: false; error: string };
          const preparedByConn = new Map<string, Prep>();
          for (const c of connections) {
            const vars = resolveVariablesForConnection(runVariables, c.id);
            const prepared = prepareStatement(raw, vars);
            preparedByConn.set(
              c.id,
              prepared.ok
                ? { ok: true, sql: prepared.sql }
                : { ok: false, error: prepared.error }
            );
          }

          const firstOk = [...preparedByConn.values()].find((p) => p.ok);
          const firstErr = [...preparedByConn.values()].find((p) => !p.ok);
          if (!firstOk) {
            aborted = firstErr && !firstErr.ok ? firstErr.error : 'Variable substitution failed';
            for (const c of connections) {
              const prep = preparedByConn.get(c.id)!;
              const prev = resultsByConn.get(c.id) ?? [];
              const filler: SqlStatementResult = {
                ok: false,
                error: prep.ok ? aborted : prep.error,
                durationMs: 0,
              };
              while (prev.length < si) {
                prev.push({ ok: false, error: 'Skipped', durationMs: 0 });
              }
              prev.push(filler);
              resultsByConn.set(c.id, prev);
              patchRun(c.id, {
                status: 'error',
                error: prep.ok ? aborted : prep.error,
                results: [...prev],
              });
            }
            break;
          }

          ranDisplay.push(firstOk.sql);
          ranIndexDisplay.push(sourceIndices?.[si] ?? si);
          setRanStatements([...ranDisplay], [...ranIndexDisplay]);

          await Promise.allSettled(
            connections.map(async (c) => {
              const prev = resultsByConn.get(c.id) ?? [];
              const prep = preparedByConn.get(c.id)!;
              if (!prep.ok) {
                prev.push({ ok: false, error: prep.error, durationMs: 0 });
                resultsByConn.set(c.id, prev);
                patchRun(c.id, {
                  status: 'error',
                  error: prep.error,
                  results: [...prev],
                });
                return;
              }
              try {
                const { results } = await executeSql(
                  { connectionId: c.id, password: sessionPasswordFor(c.id, sessionPasswords) },
                  [prep.sql],
                  maxRows,
                  0
                );
                const one = results[0] ?? {
                  ok: false as const,
                  error: 'No result returned',
                  durationMs: 0,
                };
                prev.push(one);
                resultsByConn.set(c.id, prev);
                // Only pageable SQL can re-run with OFFSET; write CTEs / INSERT
                // must not enable Next (wrapping them breaks engines).
                setPageSql(c.id, si, isPageableStatement(prep.sql) ? prep.sql : '');
                const last = si === rawStatements.length - 1;
                patchRun(c.id, {
                  status: last ? 'done' : 'running',
                  results: [...prev],
                  error: undefined,
                });
              } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                prev.push({ ok: false, error: msg, durationMs: 0 });
                resultsByConn.set(c.id, prev);
                patchRun(c.id, {
                  status: 'error',
                  error: msg,
                  results: [...prev],
                });
              }
            })
          );

          // @set from the first successful credential result (connection list order).
          // Writes the global base value (not a per-connection override).
          applySetsFromFirstOk(directives, si);
        }

        // Mark any still-running connections as done.
        for (const c of connections) {
          const run = get().resultsByTab[tabId]?.runs.find((r) => r.connectionId === c.id);
          if (run?.status === 'running') {
            patchRun(c.id, {
              status: aborted ? 'error' : 'done',
              error: aborted ?? run.error,
              results: resultsByConn.get(c.id),
            });
          }
        }

        // Seed page 0 cache from this run (avoids re-fetch on Prev after Next).
        // Pin pageSize to this run so Next/Prev stay aligned if Max rows changes later.
        let pageCache: Record<string, SqlStatementResult> = {};
        const pageMeta: Record<string, ResultPageMeta> = {};
        const pageSqlByConnection: Record<string, string[]> = {};
        for (const c of connections) {
          pageSqlByConnection[c.id] = pageSqlByConn.get(c.id) ?? [];
          const results = resultsByConn.get(c.id) ?? [];
          results.forEach((res, si) => {
            const key = pageMetaKey(c.id, si);
            pageCache[pageCacheKey(c.id, si, 0)] = res;
            pageCache = boundPageCache(pageCache, c.id, si, 0);
            const pageable = Boolean(pageSqlByConnection[c.id]?.[si]);
            pageMeta[key] = {
              pageIndex: 0,
              pageSize: maxRows,
              hasNext: pageable && Boolean(res.ok && (res.hasNext || res.truncated)),
            };
          });
        }
        set((state) => {
          const current = state.resultsByTab[tabId];
          if (!current) return state;
          // Record a recent query when at least one statement ran.
          const sqlSnippet = (current.ranStatements ?? []).join('\n').trim() || tab.sql.trim();
          let recentQueries = state.recentQueries;
          if (sqlSnippet) {
            const entry: RecentQuery = {
              id: newTabId(),
              sql: truncatePersistedSql(sqlSnippet),
              title: tab.title || 'Query',
              selectedConnectionIds: connections
                .map((connection) => connection.id)
                .filter((id) => id !== LOCAL_CODE_RUN_TARGET.id),
              ranAt: Date.now(),
            };
            recentQueries = [
              entry,
              ...state.recentQueries.filter((r) => r.sql !== entry.sql),
            ].slice(0, MAX_RECENT_QUERIES);
          }
          return {
            resultsByTab: {
              ...state.resultsByTab,
              [tabId]: {
                ...current,
                pageCache,
                pageMeta,
                pageSqlByConnection,
              },
            },
            recentQueries,
            runningTabId: null,
          };
        });
      },

      loadResultPage: async ({ connectionId, statementIndex, pageIndex }) => {
        const { resultsByTab, activeTabId, maxRows, sessionPasswords, runningTabId } = get();
        const tabId = activeTabId;
        const current = resultsByTab[tabId];
        if (!current || runningTabId === tabId) return;
        const epoch = current.pageEpoch ?? 0;
        const metaKey = pageMetaKey(connectionId, statementIndex);
        const cacheKey = pageCacheKey(connectionId, statementIndex, pageIndex);
        const cached = current.pageCache?.[cacheKey];
        const pageSize = current.pageMeta?.[metaKey]?.pageSize ?? maxRows;
        const sql = current.pageSqlByConnection?.[connectionId]?.[statementIndex];
        if (!cached && !sql) return;

        const setMeta = (patch: Partial<ResultPageMeta>) =>
          set((state) => {
            const cur = state.resultsByTab[tabId];
            if (!cur || !isCurrentPageEpoch(epoch, cur.pageEpoch)) return state;
            const prev = cur.pageMeta?.[metaKey];
            return {
              resultsByTab: {
                ...state.resultsByTab,
                [tabId]: {
                  ...cur,
                  pageMeta: {
                    ...(cur.pageMeta ?? {}),
                    [metaKey]: {
                      pageIndex: prev?.pageIndex ?? 0,
                      hasNext: prev?.hasNext ?? false,
                      pageSize: prev?.pageSize ?? pageSize,
                      ...patch,
                    },
                  },
                },
              },
            };
          });

        const applyResult = (res: SqlStatementResult, hasNext: boolean) => {
          set((state) => {
            const cur = state.resultsByTab[tabId];
            if (!cur || !isCurrentPageEpoch(epoch, cur.pageEpoch)) return state;
            const merged = { ...(cur.pageCache ?? {}), [cacheKey]: res };
            const pageCache = boundPageCache(
              merged,
              connectionId,
              statementIndex,
              pageIndex
            );
            return {
              resultsByTab: {
                ...state.resultsByTab,
                [tabId]: {
                  ...cur,
                  pageCache,
                  pageMeta: {
                    ...(cur.pageMeta ?? {}),
                    [metaKey]: { pageIndex, hasNext, loading: false, pageSize },
                  },
                  // Keep only the current page on runs.results; pageCache holds revisits.
                  runs: cur.runs.map((r) => {
                    if (r.connectionId !== connectionId || !r.results) return r;
                    const results = [...r.results];
                    results[statementIndex] = res;
                    return { ...r, results };
                  }),
                },
              },
            };
          });
        };

        if (cached) {
          applyResult(cached, Boolean(cached.ok && (cached.hasNext || cached.truncated)));
          return;
        }

        setMeta({ loading: true });
        try {
          const prevCached = current.pageCache?.[pageCacheKey(connectionId, statementIndex, pageIndex - 1)];
          const tables = get().schemaCache[connectionId]?.tables;
          const seek =
            pageIndex > 0 && prevCached && prevCached.ok && prevCached.rows.length
              ? seekFromLastRow({
                  sql: sql!,
                  table: tableForOrderBy(sql!, tables),
                  resultColumns: prevCached.columns,
                  lastRow: prevCached.rows[prevCached.rows.length - 1]!,
                })
              : null;
          const offset = seek ? 0 : pageIndex * pageSize;
          const { results } = await executeSql(
            { connectionId, password: sessionPasswordFor(connectionId, sessionPasswords) },
            [sql!],
            pageSize,
            offset,
            undefined,
            seek ? { seek } : undefined
          );
          const one = results[0] ?? {
            ok: false as const,
            error: 'No result returned',
            durationMs: 0,
          };
          applyResult(one, Boolean(one.ok && (one.hasNext || one.truncated)));
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          applyResult({ ok: false, error: msg, durationMs: 0 }, false);
        }
      },

      reloadResultPage: async ({ connectionId, statementIndex, pageIndex }) => {
        const tabId = get().activeTabId;
        const current = get().resultsByTab[tabId];
        if (!current) return;
        const prefix = `${pageMetaKey(connectionId, statementIndex)}:`;
        set({
          resultsByTab: {
            ...get().resultsByTab,
            [tabId]: {
              ...current,
              pageCache: Object.fromEntries(
                Object.entries(current.pageCache ?? {}).filter(([k]) => !k.startsWith(prefix))
              ),
            },
          },
        });
        await get().loadResultPage({ connectionId, statementIndex, pageIndex });
      },

      saveBookmark: (opts) => {
        const { tabs, activeTabId, bookmarks, shareDestinations, sharedConnectionIds } = get();
        const tab = tabs.find((t) => t.id === activeTabId);
        if (!tab) return;
        const title = (opts?.title ?? tab.title).trim() || 'Bookmark';
        const selectedConnectionIds = [
          ...effectiveConnectionIds(tab, shareDestinations, sharedConnectionIds),
        ];
        const existing =
          (tab.bookmarkId ? bookmarks.find((b) => b.id === tab.bookmarkId) : undefined) ??
          bookmarks.find((b) => b.title.toLowerCase() === title.toLowerCase());
        const entry: SqlBookmark = {
          id: existing?.id ?? newTabId(),
          title,
          sql: tab.sql,
          selectedConnectionIds,
          updatedAt: Date.now(),
        };
        const next = existing
          ? bookmarks.map((b) => (b.id === existing.id ? entry : b))
          : [entry, ...bookmarks];
        set({
          bookmarks: next,
          tabs: tabs.map((t) =>
            t.id === activeTabId ? { ...t, bookmarkId: entry.id, title } : t
          ),
        });
      },

      openBookmark: (id) => {
        const { bookmarks, tabs, shareDestinations } = get();
        const bm = bookmarks.find((b) => b.id === id);
        if (!bm) return;
        // Reuse an open tab already linked to this bookmark.
        const existingTab = tabs.find((t) => t.bookmarkId === id);
        if (existingTab) {
          const patch: Partial<SqlEditorState> = { activeTabId: existingTab.id };
          if (shareDestinations) {
            patch.sharedConnectionIds = [...bm.selectedConnectionIds];
          }
          set(patch);
          return;
        }
        const tab = createTab({
          title: bm.title,
          sql: bm.sql,
          selectedConnectionIds: [...bm.selectedConnectionIds],
          bookmarkId: bm.id,
        });
        const patch: Partial<SqlEditorState> = {
          tabs: [...tabs, tab],
          activeTabId: tab.id,
        };
        if (shareDestinations) {
          patch.sharedConnectionIds = [...bm.selectedConnectionIds];
        }
        set(patch);
      },

      renameBookmark: (id, title) => {
        const trimmed = title.trim() || 'Bookmark';
        const { bookmarks, tabs } = get();
        set({
          bookmarks: bookmarks.map((b) =>
            b.id === id ? { ...b, title: trimmed, updatedAt: Date.now() } : b
          ),
          // Keep any open tab linked to this bookmark in sync.
          tabs: tabs.map((t) => (t.bookmarkId === id ? { ...t, title: trimmed } : t)),
        });
      },

      deleteBookmark: (id) => {
        set({
          bookmarks: get().bookmarks.filter((b) => b.id !== id),
          tabs: get().tabs.map((t) =>
            t.bookmarkId === id ? { ...t, bookmarkId: undefined } : t
          ),
        });
      },

      dataPeek: null,

      openDataPeek: async (connectionId, tableName) => {
        const conn = useSyncStore.getState().connections.find((c) => c.id === connectionId);
        if (!conn) return;
        const built = buildTablePreview(tableName, conn.dialect);
        const composed = composePeekSql(built.sql, built.params, {});
        if ('error' in composed) return;
        const entry = createDataPeekEntry({
          title: tableName,
          tableName,
          baseSql: built.sql,
          baseParams: built.params,
          sql: composed.sql,
          params: composed.params,
        });
        set({ dataPeek: { connectionId, dialect: conn.dialect, entries: [entry] } });
        await get().runDataPeekEntry(entry.id);
      },

      openDataPeekFromFk: async (connectionId, fk, values) => {
        const conn = useSyncStore.getState().connections.find((c) => c.id === connectionId);
        if (!conn) return;
        const built = buildForeignKeyDrilldown(fk, values, conn.dialect);
        if (!built) return;
        const composed = composePeekSql(built.sql, built.params, {});
        if ('error' in composed) return;
        const parentTable = fkDrillTableName(fk);
        const label = (fk.referencedColumns ?? [])
          .map((c, i) => `${c} = ${String(values[i])}`)
          .join(', ');
        const entry = createDataPeekEntry({
          title: `${parentTable} · ${label}`,
          tableName: parentTable,
          baseSql: built.sql,
          baseParams: built.params,
          sql: composed.sql,
          params: composed.params,
        });
        set({ dataPeek: { connectionId, dialect: conn.dialect, entries: [entry] } });
        await get().runDataPeekEntry(entry.id);
      },

      openDataPeekOrphans: async (connectionId, childTable, fk) => {
        const conn = useSyncStore.getState().connections.find((c) => c.id === connectionId);
        if (!conn) return;
        const built = buildOrphanPeek(childTable, fk, conn.dialect);
        if (!built) return;
        const composed = composePeekSql(built.sql, built.params, {});
        if ('error' in composed) return;
        const entry = createDataPeekEntry({
          title: `${childTable} · orphans via ${fkKey(fk)}`,
          tableName: childTable,
          baseSql: built.sql,
          baseParams: built.params,
          sql: composed.sql,
          params: composed.params,
        });
        set({ dataPeek: { connectionId, dialect: conn.dialect, entries: [entry] } });
        await get().runDataPeekEntry(entry.id);
      },

      openDataPeekForRow: async (connectionId, tableName, keys) => {
        const conn = useSyncStore.getState().connections.find((c) => c.id === connectionId);
        if (!conn) return;
        const built = buildRowLookup(tableName, keys, conn.dialect);
        if (!built) return;
        const composed = composePeekSql(built.sql, built.params, {});
        if ('error' in composed) return;
        const label = keys.map((k) => `${k.column} = ${String(k.value)}`).join(', ');
        const entry = createDataPeekEntry({
          title: `${tableName} · ${label}`,
          tableName,
          baseSql: built.sql,
          baseParams: built.params,
          sql: composed.sql,
          params: composed.params,
        });
        set({ dataPeek: { connectionId, dialect: conn.dialect, entries: [entry] } });
        await get().runDataPeekEntry(entry.id);
      },

      drillDataPeek: async (fromEntryId, fk, values) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const built = buildForeignKeyDrilldown(fk, values, peek.dialect);
        if (!built) return;
        const composed = composePeekSql(built.sql, built.params, {});
        if ('error' in composed) return;
        const parentTable = fkDrillTableName(fk);
        const label = (fk.referencedColumns ?? [])
          .map((c, i) => `${c} = ${String(values[i])}`)
          .join(', ');
        const drillKey = dataPeekDrillKey(fromEntryId, parentTable, fk.columns);
        const entry = createDataPeekEntry({
          title: `${parentTable} · ${label}`,
          tableName: parentTable,
          baseSql: built.sql,
          baseParams: built.params,
          sql: composed.sql,
          params: composed.params,
          parentId: fromEntryId,
          drillKey,
        });
        // Same FK column → replace that panel (and its children). Other FK
        // columns from the same parent stay open as sibling peeks.
        let entries = peek.entries;
        const existing = entries.find((e) => e.drillKey === drillKey);
        if (existing) {
          entries = removeDataPeekSubtree(entries, existing.id);
        }
        set({ dataPeek: { ...peek, entries: [...entries, entry] } });
        await get().runDataPeekEntry(entry.id);
      },

      drillDataPeekInbound: async (fromEntryId, child, values) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const built = buildInboundDrilldown(child, values, peek.dialect);
        if (!built) return;
        const composed = composePeekSql(built.sql, built.params, {});
        if ('error' in composed) return;
        const label = (child.fk.columns ?? [])
          .map((c, i) => `${c} = ${String(values[i])}`)
          .join(', ');
        // `<` marks the inbound direction in the key, so drilling a child that
        // happens to share the parent's FK shape replaces the right panel
        // instead of collapsing the two into one.
        const drillKey = `${fromEntryId}|<|${child.table}|${(child.fk.columns ?? []).join(',')}`;
        const entry = createDataPeekEntry({
          title: `${child.table} · ${label}`,
          tableName: child.table,
          baseSql: built.sql,
          baseParams: built.params,
          sql: composed.sql,
          params: composed.params,
          parentId: fromEntryId,
          drillKey,
        });
        let entries = peek.entries;
        const existing = entries.find((e) => e.drillKey === drillKey);
        if (existing) {
          entries = removeDataPeekSubtree(entries, existing.id);
        }
        set({ dataPeek: { ...peek, entries: [...entries, entry] } });
        await get().runDataPeekEntry(entry.id);
      },

      updateDataPeekFilters: async (entryId, patch) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const entry = peek.entries.find((e) => e.id === entryId);
        if (!entry) return;
        const whereClause = patch.whereClause ?? entry.whereClause;
        const orderByClause = patch.orderByClause ?? entry.orderByClause;
        const limit = clampDataPeekLimit(patch.limit ?? entry.limit);
        const composed = composePeekSql(entry.baseSql, entry.baseParams, {
          where: whereClause,
          orderBy: orderByClause,
        });
        if ('error' in composed) {
          set({
            dataPeek: {
              ...peek,
              entries: patchDataPeekEntry(peek.entries, entryId, (e) => ({
                whereClause,
                orderByClause,
                limit,
                pageIndex: 0,
                // Invalidate any in-flight execute for this panel.
                runGeneration: nextDataPeekRunGeneration(e),
                status: 'error' as const,
                error: composed.error,
              })),
            },
          });
          return;
        }
        set({
          dataPeek: {
            ...peek,
            entries: patchDataPeekEntry(peek.entries, entryId, (e) => ({
              whereClause,
              orderByClause,
              limit,
              pageIndex: 0,
              sql: composed.sql,
              params: composed.params,
              // Invalidate any in-flight execute for this panel.
              runGeneration: nextDataPeekRunGeneration(e),
              status: 'loading' as const,
              error: undefined,
            })),
          },
        });
        await get().runDataPeekEntry(entryId);
      },

      clearDataPeekBaseFilter: async (entryId) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const entry = peek.entries.find((e) => e.id === entryId);
        if (!entry || entry.baseParams.length === 0) return;
        const built = buildTablePreview(entry.tableName, peek.dialect);
        const composed = composePeekSql(built.sql, built.params, {
          where: entry.whereClause,
          orderBy: entry.orderByClause,
        });
        if ('error' in composed) {
          set({
            dataPeek: {
              ...peek,
              entries: patchDataPeekEntry(peek.entries, entryId, (e) => ({
                runGeneration: nextDataPeekRunGeneration(e),
                status: 'error' as const,
                error: composed.error,
              })),
            },
          });
          return;
        }
        set({
          dataPeek: {
            ...peek,
            entries: patchDataPeekEntry(peek.entries, entryId, (e) => ({
              title: entry.tableName,
              baseSql: built.sql,
              baseParams: built.params,
              pageIndex: 0,
              sql: composed.sql,
              params: composed.params,
              runGeneration: nextDataPeekRunGeneration(e),
              status: 'loading' as const,
              error: undefined,
            })),
          },
        });
        await get().runDataPeekEntry(entryId);
      },

      setDataPeekPanelHeight: (entryId, heightPx) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const clamped = Math.min(900, Math.max(220, Math.round(heightPx)));
        set({
          dataPeek: {
            ...peek,
            entries: patchDataPeekEntry(peek.entries, entryId, { panelHeightPx: clamped }),
          },
        });
      },

      reorderDataPeekEntries: (fromIndex, toIndex) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const entries = moveDataPeekEntry(peek.entries, fromIndex, toIndex);
        if (entries === peek.entries) return;
        set({ dataPeek: { ...peek, entries } });
      },

      pageDataPeekEntry: async (entryId, pageIndex) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const entry = peek.entries.find((e) => e.id === entryId);
        if (!entry) return;
        const nextPage = Math.max(0, Math.floor(pageIndex));
        if (nextPage === entry.pageIndex && entry.status === 'ready') return;
        set({
          dataPeek: {
            ...peek,
            entries: patchDataPeekEntry(peek.entries, entryId, (e) => ({
              pageIndex: nextPage,
              runGeneration: nextDataPeekRunGeneration(e),
              status: 'loading' as const,
              error: undefined,
            })),
          },
        });
        await get().runDataPeekEntry(entryId);
      },

      runDataPeekEntry: async (entryId) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const entry = peek.entries.find((e) => e.id === entryId);
        if (!entry) return;
        const runGeneration = (entry.runGeneration ?? 0) + 1;
        const sql = entry.sql;
        const params = entry.params;
        const pageSize = Math.min(5000, Math.max(1, entry.limit || DATA_PEEK_ROWS));
        const pageIndex = Math.max(0, entry.pageIndex || 0);
        const resultPage = entry.resultPageIndex ?? (entry.result ? 0 : -1);
        const seek =
          pageIndex === resultPage + 1 && entry.result?.ok && entry.result.rows.length
            ? seekFromLastRow({
                sql,
                table: tableForOrderBy(sql, get().schemaCache[peek.connectionId]?.tables),
                resultColumns: entry.result.columns,
                lastRow: entry.result.rows[entry.result.rows.length - 1]!,
              })
            : null;
        const offset = seek ? 0 : pageIndex * pageSize;
        // Mark this generation before awaiting so concurrent runs can detect staleness.
        set({
          dataPeek: {
            ...peek,
            entries: patchDataPeekEntry(peek.entries, entryId, {
              runGeneration,
              status: 'loading',
            }),
          },
        });
        const patchIfCurrent = (next: Partial<DataPeekEntry>) => {
          const cur = get().dataPeek;
          if (!cur) return;
          const live = cur.entries.find((e) => e.id === entryId);
          if (!isCurrentDataPeekRun(live, runGeneration)) return;
          set({
            dataPeek: {
              ...cur,
              entries: patchDataPeekEntry(cur.entries, entryId, next),
            },
          });
        };
        try {
          const { results } = await executeSql(
            {
              connectionId: peek.connectionId,
              password: sessionPasswordFor(peek.connectionId, get().sessionPasswords),
            },
            [sql],
            pageSize,
            offset,
            [params],
            seek ? { seek } : undefined
          );
          const result = results[0];
          if (!result) {
            patchIfCurrent({ status: 'error', error: 'No result returned' });
            return;
          }
          patchIfCurrent(
            result.ok
              ? { status: 'ready', result, resultPageIndex: pageIndex }
              : { status: 'error', error: result.error, result }
          );
        } catch (error: unknown) {
          patchIfCurrent({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },

      closeDataPeek: () => set({ dataPeek: null }),

      closeDataPeekFrom: (entryId) => {
        const peek = get().dataPeek;
        if (!peek) return;
        const target = peek.entries.find((e) => e.id === entryId);
        if (!target) return;
        // Closing the root dismisses the whole peek.
        if (!target.parentId) {
          set({ dataPeek: null });
          return;
        }
        set({
          dataPeek: {
            ...peek,
            entries: removeDataPeekSubtree(peek.entries, entryId),
          },
        });
      },

      installSampleBookmarks: () => {
        const samples = buildSampleBookmarks();
        const { bookmarks } = get();
        const sampleIds = new Set(samples.map((s) => s.id));
        const prevById = new Map(bookmarks.map((b) => [b.id, b]));
        let touched = 0;
        for (const sample of samples) {
          const prev = prevById.get(sample.id);
          if (!prev || prev.sql !== sample.sql || prev.title !== sample.title) {
            touched += 1;
          }
        }
        // Keep user bookmarks first; samples at the end so they stay easy to find.
        const user = bookmarks.filter((b) => !sampleIds.has(b.id));
        set({ bookmarks: [...user, ...samples] });
        return touched;
      },

      upsertVariable: (input) => {
        const name = normalizeVariableName(input.name);
        if (!isValidVariableName(name)) {
          return 'Name must match [A-Za-z_][A-Za-z0-9_]*';
        }
        const allowEmptyList = input.secret === true;
        if (
          input.kind === 'list' &&
          (!input.values || input.values.length === 0) &&
          !allowEmptyList
        ) {
          return 'List variable needs at least one value';
        }
        if (input.kind === 'table' && (!input.columns || input.columns.length === 0)) {
          return 'Table variable needs columns';
        }
        const { variables } = get();
        const byId = input.id ? variables.find((v) => v.id === input.id) : undefined;
        const nameClash = variables.find(
          (v) => v.name === name && (!byId || v.id !== byId.id)
        );
        const existing = byId ?? (!input.id ? nameClash : undefined);
        const makeEntry = (id: string): SqlVariable => ({
          id,
          name,
          kind: input.kind,
          value: input.kind === 'scalar' ? input.value : undefined,
          values: input.kind === 'list' ? [...(input.values ?? [])] : undefined,
          columns: input.kind === 'table' ? [...(input.columns ?? [])] : undefined,
          rows:
            input.kind === 'table'
              ? (input.rows ?? []).map((r) => [...r])
              : undefined,
          secret: input.secret !== undefined ? input.secret : existing?.secret,
          overrides:
            input.overrides !== undefined
              ? input.overrides
              : existing?.overrides
                ? { ...existing.overrides }
                : undefined,
          updatedAt: Date.now(),
        });
        if (nameClash && !byId) {
          const entry = makeEntry(nameClash.id);
          set({
            variables: variables.map((v) => (v.id === nameClash.id ? entry : v)),
          });
          return null;
        }
        if (nameClash && byId) {
          return `Variable "${name}" already exists`;
        }
        if (byId) {
          const entry = makeEntry(byId.id);
          set({
            variables: variables.map((v) => (v.id === byId.id ? entry : v)),
          });
          return null;
        }
        set({ variables: [makeEntry(newTabId()), ...variables] });
        return null;
      },

      deleteVariable: (id) => {
        set({ variables: get().variables.filter((v) => v.id !== id) });
      },

      setVariableSecret: (id, secret) => {
        set({
          variables: get().variables.map((v) =>
            v.id === id ? { ...v, secret, updatedAt: Date.now() } : v
          ),
        });
      },

      setVariableOverride: (id, connectionId, override) => {
        set({
          variables: get().variables.map((v) => {
            if (v.id !== id || v.kind === 'table') return v;
            const next = { ...(v.overrides ?? {}) };
            if (override === null) {
              delete next[connectionId];
            } else {
              next[connectionId] = override;
            }
            return {
              ...v,
              overrides: Object.keys(next).length > 0 ? next : undefined,
              updatedAt: Date.now(),
            };
          }),
        });
      },

      exportVariablesJson: () =>
        JSON.stringify(exportVariables(get().variables), null, 2),

      importVariables: (raw, opts) => {
        const parsed = parseImportedVariables(raw);
        if (!parsed.ok) return parsed.error;
        const overwrite = opts?.overwrite !== false;
        for (const item of parsed.items) {
          const existing = get().variables.find((v) => v.name === item.name);
          if (existing && !overwrite) continue;
          if (item.secret) {
            const err = get().upsertVariable({
              id: existing?.id,
              name: item.name,
              kind: item.kind,
              secret: true,
              value: item.kind === 'scalar' ? undefined : undefined,
              values: item.kind === 'list' ? [] : undefined,
              columns: item.kind === 'table' ? item.columns ?? existing?.columns ?? ['col'] : undefined,
              rows: item.kind === 'table' ? [] : undefined,
            });
            if (err) return err;
            continue;
          }
          const err = get().upsertVariable({
            id: existing?.id,
            name: item.name,
            kind: item.kind,
            secret: false,
            value: item.value,
            values: item.values,
            columns: item.columns,
            rows: item.rows,
            overrides: item.overrides,
          });
          if (err) return err;
        }
        return null;
      },
    }),
    {
      name: SQL_EDITOR_PERSIST_KEY,
      version: SQL_EDITOR_PERSIST_VERSION,
      // Written 400 ms after the last change (and when the page is hidden),
      // not on every keystroke: the snapshot is 90 kB to 1 MB.
      storage: deferredLocalStorage(),
      // Persist tabs + destinations mode + bookmarks + recent + variables. Never passwords/results.
      // Secret variable payloads are stripped (session-only values).
      partialize: (state) => {
        const tabs = persistableTabs(state.tabs).map((t) => ({
          ...t,
          sql: truncatePersistedSql(t.sql),
        }));
        const bookmarks = [...state.bookmarks]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_PERSISTED_BOOKMARKS)
          .map((b) => ({ ...b, sql: truncatePersistedSql(b.sql) }));
        const recentQueries = [...state.recentQueries]
          .sort((a, b) => b.ranAt - a.ranAt)
          .slice(0, MAX_RECENT_QUERIES)
          .map((r) => ({ ...r, sql: truncatePersistedSql(r.sql) }));
        return {
          tabs,
          activeTabId: state.activeTabId,
          maxRows: state.maxRows,
          safeMode: state.safeMode,
          multiTableConfirmThreshold: state.multiTableConfirmThreshold,
          shareDestinations: state.shareDestinations,
          sharedConnectionIds: state.sharedConnectionIds,
          bookmarks,
          recentQueries,
          variables: stripSecretsForPersist(state.variables),
        };
      },
      migrate: (persisted, fromVersion) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        // v1: flat { sql, selectedConnectionIds, maxRows }
        if (fromVersion < 2) {
          const tab = createTab({
            title: 'Query 1',
            sql: typeof p.sql === 'string' ? p.sql : '',
            selectedConnectionIds: Array.isArray(p.selectedConnectionIds)
              ? (p.selectedConnectionIds as string[])
              : [],
          });
          return {
            tabs: [tab],
            activeTabId: tab.id,
            maxRows: typeof p.maxRows === 'number' ? p.maxRows : 200,
            safeMode: true,
            shareDestinations: true,
            sharedConnectionIds: Array.isArray(p.selectedConnectionIds)
              ? (p.selectedConnectionIds as string[])
              : [],
            bookmarks: [],
            variables: [],
          };
        }
        if (fromVersion < 3) {
          const tabs = Array.isArray(p.tabs) ? p.tabs : [];
          const first = tabs[0] as { selectedConnectionIds?: string[] } | undefined;
          return {
            ...p,
            safeMode: true,
            shareDestinations: true,
            sharedConnectionIds: Array.isArray(first?.selectedConnectionIds)
              ? first.selectedConnectionIds
              : [],
            bookmarks: [],
            variables: [],
          };
        }
        if (fromVersion < 4) {
          return { ...p, variables: [] };
        }
        // v5: secret/overrides fields are optional; strip any leaked secret payloads.
        if (fromVersion < 5) {
          const vars = Array.isArray(p.variables) ? (p.variables as SqlVariable[]) : [];
          return { ...p, variables: stripSecretsForPersist(vars) };
        }
        // v6: table-blueprint / composite-FK era — keep editor persist stable; coerce
        // arrays so older partial blobs still hydrate. Schema FK shapes are normalized
        // server-side via normalizeTableSchemas (not stored in this persist key).
        if (fromVersion < 6) {
          const vars = Array.isArray(p.variables) ? (p.variables as SqlVariable[]) : [];
          return {
            ...p,
            tabs: Array.isArray(p.tabs) ? p.tabs : [],
            bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [],
            sharedConnectionIds: Array.isArray(p.sharedConnectionIds)
              ? p.sharedConnectionIds
              : [],
            variables: stripSecretsForPersist(vars),
            safeMode: typeof p.safeMode === 'boolean' ? p.safeMode : true,
            shareDestinations:
              typeof p.shareDestinations === 'boolean' ? p.shareDestinations : true,
            maxRows: typeof p.maxRows === 'number' ? p.maxRows : 200,
          };
        }
        // v7: recent queries + multi-table confirm threshold.
        if (fromVersion < 7) {
          return {
            ...p,
            recentQueries: Array.isArray(p.recentQueries) ? p.recentQueries : [],
            multiTableConfirmThreshold:
              typeof p.multiTableConfirmThreshold === 'number'
                ? p.multiTableConfirmThreshold
                : 3,
          };
        }
        // v8: recent runs remember the exact database destinations they used.
        // Old entries fail closed with none selected instead of inheriting the
        // current destination and risking a write to the wrong database.
        if (fromVersion < 8) {
          const recent = Array.isArray(p.recentQueries)
            ? (p.recentQueries as Array<Record<string, unknown>>)
            : [];
          return {
            ...p,
            recentQueries: recent.map((entry) => ({
              ...entry,
              selectedConnectionIds: Array.isArray(entry.selectedConnectionIds)
                ? entry.selectedConnectionIds.filter((id) => typeof id === 'string')
                : [],
            })),
          };
        }
        return p;
      },
      // Always rehydrate checkedStatements (not persisted) and drop malformed tabs.
      merge: (persistedState, currentState) => {
        if (!persistedState || typeof persistedState !== 'object') return currentState;
        const p = persistedState as {
          tabs?: Array<Partial<SqlTab> & Pick<SqlTab, 'id'>>;
          activeTabId?: string;
          maxRows?: number;
          safeMode?: boolean;
          multiTableConfirmThreshold?: number;
          shareDestinations?: boolean;
          sharedConnectionIds?: string[];
          bookmarks?: SqlBookmark[];
          recentQueries?: RecentQuery[];
          variables?: SqlVariable[];
        };
        const tabs = hydrateTabs(Array.isArray(p.tabs) ? p.tabs : []);
        const activeTabId =
          typeof p.activeTabId === 'string' && tabs.some((t) => t.id === p.activeTabId)
            ? p.activeTabId
            : tabs[0]!.id;
        const bookmarks = Array.isArray(p.bookmarks)
          ? p.bookmarks
              .filter(
                (b) =>
                  b &&
                  typeof b.id === 'string' &&
                  typeof b.title === 'string' &&
                  typeof b.sql === 'string'
              )
              .map((b) => ({ ...b, sql: truncatePersistedSql(b.sql) }))
              .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
              .slice(0, MAX_PERSISTED_BOOKMARKS)
          : [];

        // Relink tabs↔bookmarks by unique SQL match, and sync bookmark title to the tab.
        const healedTabs = tabs.map((t) => {
          const capped = { ...t, sql: truncatePersistedSql(t.sql) };
          if (capped.bookmarkId && bookmarks.some((b) => b.id === capped.bookmarkId)) return capped;
          const matches = bookmarks.filter((b) => b.sql === capped.sql);
          if (matches.length !== 1) return capped;
          return { ...capped, bookmarkId: matches[0]!.id };
        });
        const healedBookmarks = bookmarks.map((b) => {
          const tab = healedTabs.find((t) => t.bookmarkId === b.id);
          if (!tab || tab.title === b.title) return b;
          return { ...b, title: tab.title, updatedAt: Date.now() };
        });

        const variables = stripSecretsForPersist(
          Array.isArray(p.variables)
            ? p.variables.filter(
                (v) =>
                  v &&
                  typeof v.id === 'string' &&
                  typeof v.name === 'string' &&
                  isValidVariableName(v.name) &&
                  (v.kind === 'scalar' || v.kind === 'list' || v.kind === 'table')
              )
            : []
        );

        const recentQueries = Array.isArray(p.recentQueries)
          ? p.recentQueries
              .filter(
                (r) =>
                  r &&
                  typeof r.id === 'string' &&
                  typeof r.sql === 'string' &&
                  typeof r.ranAt === 'number'
              )
              .map((r) => ({
                id: r.id,
                sql: truncatePersistedSql(r.sql),
                title: typeof r.title === 'string' ? r.title : 'Query',
                selectedConnectionIds: Array.isArray(r.selectedConnectionIds)
                  ? r.selectedConnectionIds.filter((id) => typeof id === 'string')
                  : [],
                ranAt: r.ranAt,
              }))
              .sort((a, b) => b.ranAt - a.ranAt)
              .slice(0, MAX_RECENT_QUERIES)
          : [];

        return {
          ...currentState,
          tabs: healedTabs,
          activeTabId,
          maxRows: typeof p.maxRows === 'number' ? p.maxRows : currentState.maxRows,
          safeMode: typeof p.safeMode === 'boolean' ? p.safeMode : true,
          multiTableConfirmThreshold:
            typeof p.multiTableConfirmThreshold === 'number'
              ? p.multiTableConfirmThreshold
              : 3,
          shareDestinations:
            typeof p.shareDestinations === 'boolean' ? p.shareDestinations : true,
          sharedConnectionIds: Array.isArray(p.sharedConnectionIds)
            ? p.sharedConnectionIds.filter((id) => typeof id === 'string')
            : [],
          bookmarks: healedBookmarks,
          recentQueries,
          variables,
        };
      },
    }
  )
);

// The shell's copy of recent queries (app/store/recentQueries.ts) follows this
// store from the moment it loads; before that it reads the saved snapshot.
useRecentQueries.setState({ recentQueries: useSqlEditorStore.getState().recentQueries });
useSqlEditorStore.subscribe((state, prev) => {
  if (state.recentQueries !== prev.recentQueries) {
    useRecentQueries.setState({ recentQueries: state.recentQueries });
  }
});

/**
 * Catch SQL inserted while no editor pane is mounted.
 *
 * Clone Table and the table blueprint both live in the Utilities workspace,
 * where SqlEditorPane is unmounted and its insert handler is null. Without
 * this the text was dropped while the modal said it had been inserted.
 * Appending to the active tab puts it where the reader is sent next.
 */
setSqlInsertFallback((text) => {
  const { tabs, activeTabId, setSql } = useSqlEditorStore.getState();
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const existing = active?.sql ?? '';
  setSql(existing.trim() ? `${existing.replace(/\s*$/, '')}\n${text}` : text);
});
