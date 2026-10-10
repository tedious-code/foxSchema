/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data peek: the shape of a peek panel and the pure operations on a stack of
 * them. No store, no fetching, no React.
 *
 * `useSqlEditorStore.ts` is 2600 lines and 113 state fields, and the way out of
 * that is the one the repo has already used twice — `sqlEditorTabLogic.ts` and
 * `migrationReport.ts`: take the logic that does not need the store, put it
 * somewhere it can be tested directly, and leave the store as the part that
 * orchestrates. This is the data-peek slice of that.
 *
 * What moved here was worth moving: six actions each hand-built a
 * `DataPeekEntry` from the same skeleton, eight re-implemented the same
 * "replace the entry with this id" map, and the limit clamp — the one piece
 * with real edge cases — lived inline in a single action and had no test.
 */
import type { SqlStatementResult } from '@/shared/api/sqlApi';

/** Rows fetched per peek grid — a peek is a glance, not a report. */
export const DATA_PEEK_ROWS = 50;

/**
 * Ceiling on a user-typed page size. A peek panel renders every row it gets, so
 * this is the number that stops "50000" in the limit box from locking the tab.
 */
export const MAX_DATA_PEEK_LIMIT = 5000;

export interface DataPeekEntry {
  id: string;
  /** Heading, e.g. `public.users` or `customers · id = 7`. */
  title: string;
  /** Table the rows came from — drives the FK links on this grid. */
  tableName: string;
  /** Bound base query before user WHERE / ORDER BY filters. */
  baseSql: string;
  baseParams: unknown[];
  /** User filter text (no leading WHERE). */
  whereClause: string;
  /** User sort text (no leading ORDER BY). */
  orderByClause: string;
  /** Rows/page for this peek panel (sent as execute page size). */
  limit: number;
  /** 0-based page for server OFFSET / Last Id paging. */
  pageIndex: number;
  /** Page index the current `result` was loaded for (Last Id Next). */
  resultPageIndex?: number;
  /** Composed SQL actually executed. */
  sql: string;
  params: unknown[];
  status: 'loading' | 'ready' | 'error';
  result?: SqlStatementResult;
  error?: string;
  /** Parent peek this drill opened from (root has no parent). */
  parentId?: string;
  /**
   * Stable slot for sibling drills from the same parent + FK column.
   * Re-clicking the same FK replaces this panel; other FK columns stack.
   */
  drillKey?: string;
  /** Optional manual panel height (px); drag handle updates this. */
  panelHeightPx?: number;
  /**
   * Monotonic run id so a slow older execute can't overwrite a newer
   * filter/page result (e.g. clear WHERE then a late filtered response arrives).
   */
  runGeneration?: number;
}

export interface DataPeekFilterPatch {
  whereClause?: string;
  orderByClause?: string;
  limit?: number;
}

export interface DataPeekState {
  connectionId: string;
  dialect: string;
  entries: DataPeekEntry[];
}

/** Id for a new peek panel. Unique per panel; never rendered. */
export function newDataPeekEntryId(): string {
  return `peek-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Coerce a user-typed page size into something a panel can render.
 *
 * The limit box takes free text, so this sees NaN (empty or non-numeric),
 * negatives, zero, and fractions. Anything below one row would render an empty
 * grid that looks like "no rows" rather than "bad limit", so the floor is 1.
 */
export function clampDataPeekLimit(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_DATA_PEEK_LIMIT, Math.floor(value));
}

/**
 * Stable slot for a drill, so re-clicking the same FK on the same row replaces
 * that panel instead of stacking another copy of it.
 */
export function dataPeekDrillKey(
  fromEntryId: string,
  referencedTable: string,
  columns: readonly string[] | undefined
): string {
  return `${fromEntryId}|${referencedTable}|${(columns ?? []).join(',')}`;
}

/** A newly opened panel, before its first result arrives. */
export function createDataPeekEntry(input: {
  title: string;
  tableName: string;
  baseSql: string;
  baseParams: unknown[];
  sql: string;
  params: unknown[];
  parentId?: string;
  drillKey?: string;
}): DataPeekEntry {
  return {
    id: newDataPeekEntryId(),
    title: input.title,
    tableName: input.tableName,
    baseSql: input.baseSql,
    baseParams: input.baseParams,
    whereClause: '',
    orderByClause: '',
    limit: DATA_PEEK_ROWS,
    pageIndex: 0,
    sql: input.sql,
    params: input.params,
    status: 'loading',
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.drillKey === undefined ? {} : { drillKey: input.drillKey }),
  };
}

/**
 * `entries` with the one matching `id` replaced by `{...entry, ...patch}`.
 *
 * `patch` may be a function when the new values are derived from the current
 * ones — bumping `runGeneration` is the common case. That form is why this is
 * not simply a spread at each call site.
 */
export function patchDataPeekEntry(
  entries: readonly DataPeekEntry[],
  id: string,
  patch: Partial<DataPeekEntry> | ((entry: DataPeekEntry) => Partial<DataPeekEntry>)
): DataPeekEntry[] {
  return entries.map((e) =>
    e.id === id ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e
  );
}

/**
 * The next run id for a panel, used to invalidate an execute already in flight.
 *
 * Clearing a WHERE while the filtered query is still running used to let the
 * late response land on the now-unfiltered panel. Every edit bumps this, and
 * `isCurrentDataPeekRun` refuses a result whose generation is behind.
 */
export function nextDataPeekRunGeneration(entry: DataPeekEntry): number {
  return (entry.runGeneration ?? 0) + 1;
}

/** True when a returning execute still belongs to the panel as it is now. */
export function isCurrentDataPeekRun(
  entry: DataPeekEntry | undefined,
  generation: number | undefined
): boolean {
  if (!entry) return false;
  return (entry.runGeneration ?? 0) === (generation ?? 0);
}

/** Drop an entry and any drills that descend from it. */
export function removeDataPeekSubtree(
  entries: DataPeekEntry[],
  rootId: string
): DataPeekEntry[] {
  const drop = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entries) {
      if (e.parentId && drop.has(e.parentId) && !drop.has(e.id)) {
        drop.add(e.id);
        grew = true;
      }
    }
  }
  return entries.filter((e) => !drop.has(e.id));
}

/** Move one peek panel in the stacked list (visual arrange). */
export function moveDataPeekEntry(
  entries: DataPeekEntry[],
  fromIndex: number,
  toIndex: number
): DataPeekEntry[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= entries.length ||
    toIndex >= entries.length
  ) {
    return entries;
  }
  const next = [...entries];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}
