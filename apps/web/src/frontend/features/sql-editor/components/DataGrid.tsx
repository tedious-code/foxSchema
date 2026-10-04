/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Result DataGrid (paper surface, paging, FK drill links for Data Peek).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ClipboardCopy, Download, GripVertical, RefreshCw } from 'lucide-react';
import type { SqlStatementResult } from '@/shared/api/sqlApi';
import { CELL_DIFF_CLASS, type CellDiffKind } from '@/features/sql-editor/lib/resultDataDiff';
import { columnToListValues, rowsForTableVariable } from '@/shared/lib/sql-variables';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { toast } from '@/app/store/toastStore';
import {
  pickColumns,
  selectionCellCount,
  selectionHasCell,
  sliceGridRange,
  sliceGridSelection,
  toTsv,
  type GridRange,
  type GridSelection,
} from '@/features/sql-editor/utils/copyGrid';
import { writeClipboard } from '@/shared/utils/clipboard';
import {
  EMPTY_VIEW,
  applyGridView,
  nextSort,
  operatorNeedsValue,
  viewIsActive,
  describeGridView,
  type FilterOperator,
  type GridViewState,
} from '@/features/sql-editor/utils/gridView';
import { downloadCsv } from '@/features/sql-editor/utils/exportCsv';
import { downloadJson } from '@/features/sql-editor/utils/exportJson';
import {
  downloadFixedWidthText,
  downloadYaml,
} from '@/features/sql-editor/utils/exportText';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

const CELL_MAX = 200;
const COL_MIN_PX = 96;
const COL_DEFAULT_PX = 128;
const COL_MAX_PX = 220;
const COL_LONG_TEXT_PX = 200;
/** Upper bound when double-clicking a header to fit content. */
const COL_FIT_MAX_PX = 720;
const ROW_NUM_PX = 48;
const SYNC_COL_PX = 44;
/** Fixed row height for windowing (must match rendered row). Off-screen pages live in pageCache LRU, not the DOM. */
/**
 * Shared empties for a result that did not come back.
 *
 * `result.ok ? result.columns : []` looks harmless and is not: the literal is a
 * new array on every render, so six hooks downstream saw a changed dependency
 * each time and redid their work. The `ok` branch is already stable — it is the
 * same array off the same result object — so pinning the other branch makes
 * both stable without a hook.
 */
const NO_COLUMNS: string[] = [];
const NO_ROWS: unknown[][] = [];

const ROW_H_PX = 28;
/** Taller rows for Data Peek’s larger/bolder type. */
const ROW_H_EMPHASIS_PX = 34;
const OVERSCAN = 8;

const LONG_TEXT_NAME =
  /^(description|reason|comment|comments|note|notes|message|messages|remark|remarks|detail|details|summary|body|content|text|memo|explanation|error|errmsg|err_msg)$/i;

type CellKind = 'null' | 'number' | 'boolean' | 'datetime' | 'binary' | 'string';

const KIND_CELL_CLASS: Record<CellKind, string> = {
  null: 'italic text-[var(--fox-grid-muted)]',
  number: 'tabular-nums text-[var(--fox-grid-number)] font-semibold',
  boolean: 'text-[var(--fox-grid-boolean)]',
  datetime: 'text-[var(--fox-grid-datetime)]',
  binary: 'text-[var(--fox-grid-binary)]',
  string: 'text-[var(--fox-grid-ink)]',
};

const KIND_HEADER_CLASS: Record<Exclude<CellKind, 'null'>, string> = {
  number: 'text-[var(--fox-grid-number)]',
  boolean: 'text-[var(--fox-grid-boolean)]',
  datetime: 'text-[var(--fox-grid-datetime)]',
  binary: 'text-[var(--fox-grid-binary)]',
  string: 'text-[var(--fox-grid-muted)]',
};

const KIND_LABEL: Record<Exclude<CellKind, 'null'>, string> = {
  number: 'num',
  boolean: 'bool',
  datetime: 'date',
  binary: 'bin',
  string: 'text',
};

// Anchored digit/date forms — no nested quantifiers that can ReDoS.
const ISO_DATE_RE =
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: fully anchored, bounded optional groups
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// eslint-disable-next-line security/detect-unsafe-regex -- false positive: simple digit classes, fully anchored
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const BINARY_RE = /^0x[0-9a-fA-F…]+$/;

function inferCellKind(value: unknown): CellKind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return 'string';
    if (s === 'true' || s === 'false') return 'boolean';
    if (BINARY_RE.test(s)) return 'binary';
    if (ISO_DATE_RE.test(s)) return 'datetime';
    if (NUMERIC_STRING_RE.test(s) && s.length <= 40) return 'number';
    return 'string';
  }
  return 'string';
}

function inferColumnKind(sampleValues: unknown[]): Exclude<CellKind, 'null'> {
  const counts: Record<Exclude<CellKind, 'null'>, number> = {
    number: 0,
    boolean: 0,
    datetime: 0,
    binary: 0,
    string: 0,
  };
  for (const v of sampleValues) {
    const k = inferCellKind(v);
    if (k === 'null') continue;
    counts[k] += 1;
  }
  let best: Exclude<CellKind, 'null'> = 'string';
  let bestN = -1;
  for (const k of Object.keys(counts) as Exclude<CellKind, 'null'>[]) {
    if (counts[k] > bestN) {
      best = k;
      bestN = counts[k];
    }
  }
  return best;
}

function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function rangeHasCell(sel: GridRange, row: number, col: number): boolean {
  const r0 = Math.min(sel.row0, sel.row1);
  const r1 = Math.max(sel.row0, sel.row1);
  const c0 = Math.min(sel.col0, sel.col1);
  const c1 = Math.max(sel.col0, sel.col1);
  return row >= r0 && row <= r1 && col >= c0 && col <= c1;
}

function rangeCellCount(sel: GridRange): number {
  return (Math.abs(sel.row1 - sel.row0) + 1) * (Math.abs(sel.col1 - sel.col0) + 1);
}

function reorder(order: number[], from: number, to: number): number[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) {
    return order;
  }
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

function defaultWidthFor(colName: string, sampleValues: unknown[]): number {
  const headerPx = colName.length * 8 + 40;
  let contentPx = 0;
  for (const v of sampleValues) {
    if (v === null || v === undefined) continue;
    contentPx = Math.max(contentPx, Math.min(String(v).length, 40) * 7.2);
  }
  const isLongText =
    LONG_TEXT_NAME.test(colName.trim()) ||
    /desc|reason|comment|message|remark|note|detail/i.test(colName);
  const raw = Math.max(headerPx, contentPx, COL_DEFAULT_PX);
  const cap = isLongText ? COL_LONG_TEXT_PX : COL_MAX_PX;
  return Math.min(cap, Math.max(COL_MIN_PX, Math.round(raw)));
}

function computeColWidths(columns: string[], rows: unknown[][]): number[] {
  const sample = rows.slice(0, 40);
  return columns.map((name, i) => defaultWidthFor(name, sample.map((r) => r[i])));
}

function computeColKinds(columns: string[], rows: unknown[][]): Exclude<CellKind, 'null'>[] {
  const sample = rows.slice(0, 40);
  return columns.map((_, i) => inferColumnKind(sample.map((r) => r[i])));
}

/** Fast display text — no React element per cell. */
function cellDisplay(value: unknown): { text: string; title: string; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: 'NULL', title: 'NULL', isNull: true };
  }
  const raw = typeof value === 'string' ? value : String(value);
  if (raw.length > CELL_MAX) {
    return { text: `${raw.slice(0, CELL_MAX)}…`, title: raw, isNull: false };
  }
  return { text: raw, title: raw, isNull: false };
}

function fitWidthFor(colName: string, sampleValues: unknown[]): number {
  const headerPx = colName.length * 8 + 40;
  let contentPx = 0;
  for (const v of sampleValues) {
    if (v === null || v === undefined) continue;
    contentPx = Math.max(contentPx, Math.min(String(v).length, 120) * 7.2);
  }
  const raw = Math.max(headerPx, contentPx, COL_DEFAULT_PX);
  return Math.min(COL_FIT_MAX_PX, Math.max(COL_MIN_PX, Math.round(raw)));
}

function savePromptTitle(mode: 'scalar' | 'list' | 'table'): string {
  if (mode === 'scalar') return 'Save cell as variable';
  if (mode === 'list') return 'Save column as list';
  return 'Save result as table';
}

function GridToolbar({
  label,
  refreshing,
  onRefresh,
  onExport,
  onExportJson,
  onExportYaml,
  onExportText,
  onCopy,
  onChooseColumns,
  copyScope,
  viewControls,
  emphasis,
  toolbarExtra,
}: {
  label?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  onExport?: () => void;
  /** Download the grid as an array of row objects. */
  onExportJson?: () => void;
  /** Download as a YAML sequence of mappings. */
  onExportYaml?: () => void;
  /** Download as fixed-width text, which stays aligned when pasted. */
  onExportText?: () => void;
  /** Copy the grid, the current cell selection, or headers only. */
  onCopy?: (mode: boolean | 'headers') => void;
  /** Open the column chooser. */
  onChooseColumns?: () => void;
  /** `n of m` when a column subset is active, so the filter is never hidden. */
  copyScope?: { picked: number; total: number } | null;
  /** Sort/filter toggle, scope note, and Apply — rendered by the grid. */
  viewControls?: React.ReactNode;
  emphasis?: boolean;
  /** Row CRUD controls (query results / Data Peek). */
  toolbarExtra?: React.ReactNode;
}): React.ReactElement {
  const chrome = emphasis
    ? 'text-xs font-bold'
    : 'text-[10px] font-semibold';
  const [openMenu, setOpenMenu] = useState<'copy' | 'export' | null>(null);
  // Close the header dropdown on any outside click, the same way the grid's
  // cell/column context menu does.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [openMenu]);
  return (
    <div className="flex items-center gap-2 mb-1 shrink-0">
      {label && (
        <div
          className={`${emphasis ? 'text-xs' : 'text-[10px]'} font-bold text-slate-500 uppercase tracking-wider truncate flex-1`}
          title={label}
        >
          {label}
        </div>
      )}
      {!label && toolbarExtra ? <div className="flex-1 min-w-0" /> : null}
      {toolbarExtra}
      {onRefresh && (
        <button
          type="button"
          data-testid="sql-pane-refresh"
          title="Refresh this server"
          disabled={refreshing}
          onClick={onRefresh}
          className={`flex items-center gap-0.5 ${chrome} text-slate-500 hover:text-cyan-400 transition shrink-0 disabled:opacity-40`}
        >
          <RefreshCw className={`w-3 h-3 text-cyan-400 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={SQL_ICON_STROKE} /> Refresh
        </button>
      )}
      {onCopy && (
        <div className="relative shrink-0 flex items-center">
          <button
            type="button"
            data-testid="sql-grid-copy-btn"
            title="Copy selected cells, or all rows (Cmd/Ctrl-C in the grid)"
            onClick={() => onCopy(false)}
            className={`flex items-center gap-0.5 ${chrome} text-slate-500 hover:text-cyan-400 transition`}
          >
            <ClipboardCopy className="w-3 h-3 text-sky-400" strokeWidth={SQL_ICON_STROKE} /> Copy
            {copyScope && (
              <span
                data-testid="sql-grid-copy-scope"
                className="ml-0.5 text-amber-300"
                title={`Copying ${copyScope.picked} of ${copyScope.total} columns`}
              >
                {copyScope.picked}/{copyScope.total}
              </span>
            )}
          </button>
          <button
            type="button"
            data-testid="sql-grid-copy-menu-btn"
            aria-label="Copy options"
            aria-expanded={openMenu === 'copy'}
            title="Copy options"
            onClick={(e) => {
              e.stopPropagation();
              setOpenMenu((cur) => (cur === 'copy' ? null : 'copy'));
            }}
            className={`${chrome} text-slate-500 hover:text-cyan-400 transition px-0.5`}
          >
            <ChevronDown className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
          </button>
          {openMenu === 'copy' && (
            <div
              data-testid="sql-grid-copy-menu"
              className="absolute right-0 top-full z-50 mt-1 min-w-[168px] rounded-md border border-slate-700 bg-slate-900 shadow-lg py-1 text-[11px]"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                data-testid="sql-grid-copy-values"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  onCopy(false);
                  setOpenMenu(null);
                }}
              >
                Copy values
              </button>
              <button
                type="button"
                data-testid="sql-grid-copy-headers"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  onCopy(true);
                  setOpenMenu(null);
                }}
              >
                Copy with headers
              </button>
              <button
                type="button"
                data-testid="sql-grid-copy-headers-only"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  onCopy('headers');
                  setOpenMenu(null);
                }}
              >
                Copy headers
              </button>
              {onChooseColumns && (
                <>
                  <div className="my-1 border-t border-slate-700" />
                  <button
                    type="button"
                    data-testid="sql-grid-copy-choose-cols"
                    className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                    onClick={() => {
                      onChooseColumns();
                      setOpenMenu(null);
                    }}
                  >
                    Choose columns…
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {viewControls}
      {onExport && (
        <div className="relative shrink-0 flex items-center">
          <button
            type="button"
            data-testid="sql-grid-export-btn"
            title="Export CSV"
            onClick={onExport}
            className={`flex items-center gap-0.5 ${chrome} text-slate-500 hover:text-cyan-400 transition`}
          >
            <Download className="w-3 h-3 text-sky-400" strokeWidth={SQL_ICON_STROKE} /> CSV
          </button>
          {onExportJson && (
            <button
              type="button"
              data-testid="sql-grid-export-menu-btn"
              aria-label="Export options"
              aria-expanded={openMenu === 'export'}
              title="Export options"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu((cur) => (cur === 'export' ? null : 'export'));
              }}
              className={`${chrome} text-slate-500 hover:text-cyan-400 transition px-0.5`}
            >
              <ChevronDown className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
            </button>
          )}
          {openMenu === 'export' && onExportJson && (
            <div
              data-testid="sql-grid-export-menu"
              className="absolute right-0 top-full z-50 mt-1 min-w-[168px] rounded-md border border-slate-700 bg-slate-900 shadow-lg py-1 text-[11px]"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                data-testid="sql-grid-export-csv"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  onExport();
                  setOpenMenu(null);
                }}
              >
                Export CSV
              </button>
              <button
                type="button"
                data-testid="sql-grid-export-json"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  onExportJson();
                  setOpenMenu(null);
                }}
              >
                Export JSON
              </button>
              {onExportYaml && (
                <button
                  type="button"
                  data-testid="sql-grid-export-yaml"
                  className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    onExportYaml();
                    setOpenMenu(null);
                  }}
                >
                  Export YAML
                </button>
              )}
              {onExportText && (
                <button
                  type="button"
                  data-testid="sql-grid-export-text"
                  className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    onExportText();
                    setOpenMenu(null);
                  }}
                >
                  Export text (aligned)
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Result grid — virtualized rows, column-level type colors (no per-cell regex).
 * Right-click a cell or column header to save as a SQL Editor variable.
 */
export const DataGrid: React.FC<{
  result: SqlStatementResult;
  label?: string;
  exportName?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Sync vertical scroll by pixel with sibling grids (direct DOM — no React lag). */
  scrollSyncId?: string;
  scrollSync?: {
    register: (id: string, apply: (scrollTop: number) => void) => () => void;
    broadcast: (sourceId: string, scrollTop: number) => void;
  };
  /** Sync hovered row index with sibling grids (same id as scrollSyncId). */
  hoverSync?: {
    register: (id: string, apply: (rowIdx: number | null) => void) => () => void;
    broadcast: (sourceId: string, rowIdx: number | null) => void;
  };
  /** 0-based page index for server-side paging. */
  pageIndex?: number;
  /** Rows requested per page (Max rows / Rows/page). */
  pageSize?: number;
  hasPrevPage?: boolean;
  hasNextPage?: boolean;
  pageLoading?: boolean;
  onPrevPage?: () => void;
  onNextPage?: () => void;
  /**
   * Column indexes whose cells act as drill-through links (foreign keys in the
   * data peek). Value is the parent table name, used for the tooltip.
   */
  linkColumns?: Map<number, string>;
  onLinkClick?: (colIdx: number, rowIdx: number) => void;
  /**
   * Source table per result column, for joined results — `index → table`.
   *
   * A join returns three columns called `id` and the header cannot tell them
   * apart. Shown beside the type, so the row does not get taller.
   */
  columnSources?: Map<number, string>;
  /**
   * For a joined grid: the table this cell's row can be opened in, or
   * undefined when it cannot (no primary key in the result, or a NULL key from
   * an outer join that did not match).
   */
  openRowTarget?: (colIdx: number, rowIdx: number) => string | undefined;
  onOpenRow?: (colIdx: number, rowIdx: number) => void;
  /** Highlight a selected result row (Data Peek / editable query results). */
  selectedRowIndex?: number | null;
  onSelectRow?: (rowIdx: number) => void;
  /** Extra toolbar controls (add / edit / clone / delete). */
  toolbarExtra?: React.ReactNode;
  /**
   * Larger, bolder type (Data Peek). Editor result panes keep the default
   * compact grid so side-by-side compares stay dense.
   */
  emphasis?: boolean;
  /**
   * Cross-connection data compare: return a highlight kind for a cell
   * (`modified` / `missing` / `extra`), or null when unchanged.
   */
  cellHighlight?: (rowIdx: number, colIdx: number) => CellDiffKind | null;
  /** Compare migrate: per-row Sync checkbox (sticky right); null = matching row. */
  rowSync?: {
    isChecked: (rowIdx: number) => boolean | null;
    onToggle: (rowIdx: number, checked: boolean) => void;
  };
}> = React.memo(
  ({
    result,
    label,
    exportName = 'query-result',
    refreshing,
    onRefresh,
    scrollSyncId,
    scrollSync,
    hoverSync,
    pageIndex = 0,
    pageSize,
    hasPrevPage,
    hasNextPage,
    pageLoading,
    onPrevPage,
    onNextPage,
    linkColumns,
    onLinkClick,
    columnSources,
    openRowTarget,
    onOpenRow,
    selectedRowIndex = null,
    onSelectRow,
    toolbarExtra,
    emphasis = false,
    cellHighlight,
    rowSync,
  }) => {
  const upsertVariable = useSqlEditorStore((s) => s.upsertVariable);
  const rowH = emphasis ? ROW_H_EMPHASIS_PX : ROW_H_PX;
  const sourceColumns = result.ok ? result.columns : NO_COLUMNS;
  const sourceRows = result.ok ? result.rows : NO_ROWS;

  /**
   * Sorting and filtering applied to the rows already loaded.
   *
   * Instant, and only ever about this page — which is why `onApplyView` exists
   * beside it to push the same state into the query. The toolbar says which of
   * the two the user is looking at, because a filter that silently searches one
   * page while looking like it searched the table is a filter that lies.
   */
  const [view, setView] = useState<GridViewState>(EMPTY_VIEW);
  const [showFilters, setShowFilters] = useState(false);
  /** Matches GridToolbar's own type scale, which is local to that component. */
  const toolbarChrome = emphasis ? 'text-xs font-bold' : 'text-[10px] font-semibold';

  // A fresh result set is a different table; carrying a filter across would
  // hide rows the user never filtered.
  useEffect(() => {
    setView(EMPTY_VIEW);
  }, [result]);

  const viewIndices = useMemo(() => applyGridView(sourceRows, view), [sourceRows, view]);
  /** Identical to `sourceRows` when nothing is set, so the common path copies nothing. */
  const viewRows = useMemo(
    () => (viewIsActive(view) ? viewIndices.map((i) => sourceRows[i]!) : sourceRows),
    [sourceRows, viewIndices, view]
  );
  const hiddenByFilter = sourceRows.length - viewRows.length;

  /**
   * Translate between where a row sits on screen and where it sits in `result`.
   *
   * Everything the grid hands outward — select, edit, delete, FK drill, open in
   * table, compare highlighting, migrate checkboxes, hover sync — is indexed by
   * the caller against `result.rows`. Sorting or filtering changes only what is
   * drawn, so passing the on-screen position outward would act on whichever
   * record happened to land in that slot. That is the wrong row edited, the
   * wrong row deleted, and the wrong parent opened.
   *
   * Both directions are identity while no view is active, which is the common
   * case and costs nothing.
   */
  const toSourceRow = useCallback(
    (viewIdx: number) => viewIndices[viewIdx] ?? viewIdx,
    [viewIndices]
  );
  const viewPositionOf = useMemo(() => {
    if (!viewIsActive(view)) return null;
    const back = new Map<number, number>();
    viewIndices.forEach((sourceIdx, viewIdx) => back.set(sourceIdx, viewIdx));
    return back;
  }, [viewIndices, view]);
  const toViewRow = useCallback(
    (sourceIdx: number | null | undefined) =>
      sourceIdx == null ? null : (viewPositionOf ? (viewPositionOf.get(sourceIdx) ?? null) : sourceIdx),
    [viewPositionOf]
  );

  const [colOrder, setColOrder] = useState<number[]>(() => identityOrder(sourceColumns.length));
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [colWidths, setColWidths] = useState<number[]>(() =>
    computeColWidths(sourceColumns, sourceRows)
  );
  const [fittedCols, setFittedCols] = useState<Set<number>>(() => new Set());
  const [menu, setMenu] = useState<
    | { kind: 'cell'; x: number; y: number; colIdx: number; rowIdx: number; value: unknown }
    | { kind: 'column'; x: number; y: number; colIdx: number }
    | { kind: 'grid'; x: number; y: number }
    | null
  >(null);
  /**
   * Source column indices to copy, in the order the user picked them.
   * `null` means "the whole grid, in display order" — the default.
   */
  const [copyColumns, setCopyColumns] = useState<number[] | null>(null);
  const [colPickerOpen, setColPickerOpen] = useState(false);
  /** Rectangular cell selection in display-column space. */
  /**
   * The selection, as a list of rectangles.
   *
   * A drag still makes one; Cmd/Ctrl-click adds another, so scattered cells
   * can be picked. Empty means nothing is selected — the old `null`.
   */
  const [cellSel, setCellSel] = useState<GridSelection>([]);
  const selAnchor = useRef<{ row: number; col: number } | null>(null);
  const dragSelecting = useRef(false);
  // A column choice belongs to the result it was made against. Re-running with
  // a different shape must fall back to the whole grid rather than silently
  // copying whichever columns happen to sit at those indices now.
  const columnSignature = sourceColumns.join('\0');
  useEffect(() => {
    setCopyColumns(null);
    setColPickerOpen(false);
    setCellSel([]);
    selAnchor.current = null;
  }, [columnSignature]);

  useEffect(() => {
    const up = () => {
      dragSelecting.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  const [savePrompt, setSavePrompt] = useState<
    | { mode: 'scalar'; value: unknown; defaultName: string }
    | { mode: 'list'; colIdx: number; defaultName: string }
    | { mode: 'table'; defaultName: string }
    | null
  >(null);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(320);
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  const rafRef = useRef(0);
  /** True while this grid's scrollTop is being driven by a peer (skip re-broadcast). */
  const syncLock = useRef(false);

  const colKey = sourceColumns.join('\0');
  const colKinds = useMemo(
    () => computeColKinds(sourceColumns, sourceRows),
    [sourceColumns, sourceRows]
  );

  /**
   * Latest columns and rows, for the reset effect below.
   *
   * That effect is keyed on `colKey` — the column *names* — on purpose: paging
   * through a table hands back a new rows array with the same columns, and
   * re-running the reset would throw away the user's scroll position and column
   * widths on every page. So it must read the current data without depending on
   * it, which is what a ref is for. Listing `sourceRows` in the dependency array
   * would satisfy the linter and break paging.
   */
  const latest = useRef({ columns: sourceColumns, rows: sourceRows });
  latest.current = { columns: sourceColumns, rows: sourceRows };

  useEffect(() => {
    const { columns, rows } = latest.current;
    setColOrder(identityOrder(columns.length));
    setColWidths(computeColWidths(columns, rows));
    setFittedCols(new Set());
    setDragFrom(null);
    setDragOver(null);
    setScrollTop(0);
    setHoverRow(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [colKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 320);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [result.ok, sourceColumns.length]);

  // Register with the side-by-side scroll bus: peers set our DOM scrollTop
  // directly (no React state round-trip) so fast scrolls stay locked.
  useEffect(() => {
    if (!scrollSync || !scrollSyncId) return;
    const apply = (top: number) => {
      const el = scrollRef.current;
      if (!el) return;
      if (Math.abs(el.scrollTop - top) < 0.5) return;
      syncLock.current = true;
      el.scrollTop = top;
      // Match leader: DOM is live; virtualization state updates once per frame.
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setScrollTop(top);
        // Unlock after the programmatic scroll event has had a chance to fire.
        requestAnimationFrame(() => {
          syncLock.current = false;
        });
      });
    };
    return scrollSync.register(scrollSyncId, apply);
  }, [scrollSync, scrollSyncId]);

  // Peer hover row — local state only (no parent re-render).
  useEffect(() => {
    if (!hoverSync || !scrollSyncId) return;
    // Peers speak in source positions; this grid draws in view positions.
    return hoverSync.register(scrollSyncId, (sourceIdx) => setHoverRow(toViewRow(sourceIdx)));
  }, [hoverSync, scrollSyncId, toViewRow]);

  const publishHoverRow = useCallback(
    (rowIdx: number | null) => {
      setHoverRow(rowIdx);
      if (hoverSync && scrollSyncId) {
        hoverSync.broadcast(scrollSyncId, rowIdx == null ? null : toSourceRow(rowIdx));
      }
    },
    [hoverSync, scrollSyncId, toSourceRow]
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Broadcast immediately (pixel-accurate) so peers track during fast flings.
    if (!syncLock.current && scrollSync && scrollSyncId) {
      scrollSync.broadcast(scrollSyncId, el.scrollTop);
    }
    // Throttle only the local virtualization state update.
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(el.scrollTop);
    });
  }, [scrollSync, scrollSyncId]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const startColResize = useCallback((colIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[colIdx] ?? COL_DEFAULT_PX;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(COL_FIT_MAX_PX, Math.max(COL_MIN_PX, startW + (ev.clientX - startX)));
      setColWidths((prev) => {
        const copy = [...prev];
        while (copy.length <= colIdx) copy.push(COL_DEFAULT_PX);
        copy[colIdx] = next;
        return copy;
      });
      setFittedCols((prev) => {
        if (!prev.has(colIdx)) return prev;
        const n = new Set(prev);
        n.delete(colIdx);
        return n;
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [colWidths]);

  const onHeaderDoubleClick = useCallback(
    (colIdx: number) => {
      const name = sourceColumns[colIdx] ?? '';
      const sample = sourceRows.slice(0, 80).map((r) => r[colIdx]);
      setColWidths((prev) => {
        const copy = [...prev];
        while (copy.length <= colIdx) copy.push(COL_DEFAULT_PX);
        if (fittedCols.has(colIdx)) {
          copy[colIdx] = defaultWidthFor(name, sample);
        } else {
          copy[colIdx] = fitWidthFor(name, sample);
        }
        return copy;
      });
      setFittedCols((prev) => {
        const n = new Set(prev);
        if (n.has(colIdx)) n.delete(colIdx);
        else n.add(colIdx);
        return n;
      });
    },
    [fittedCols, sourceColumns, sourceRows]
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  useEffect(() => {
    if (savePrompt) {
      setSaveName(savePrompt.defaultName);
      setSaveError(null);
      queueMicrotask(() => saveInputRef.current?.select());
    }
  }, [savePrompt]);

  const commitSave = () => {
    if (!savePrompt) return;
    const existing = useSqlEditorStore.getState().variables.find((v) => v.name === saveName.trim());
    if (existing && !window.confirm(`Overwrite variable "${saveName.trim()}"?`)) return;

    let err: string | null;
    if (savePrompt.mode === 'scalar') {
      err = upsertVariable({ name: saveName, kind: 'scalar', value: savePrompt.value });
    } else if (savePrompt.mode === 'list') {
      const values = columnToListValues(viewRows, savePrompt.colIdx);
      err = upsertVariable({ name: saveName, kind: 'list', values });
    } else {
      err = upsertVariable({
        name: saveName,
        kind: 'table',
        columns: [...sourceColumns],
        rows: rowsForTableVariable(viewRows),
      });
    }
    if (err) {
      setSaveError(err);
      return;
    }
    setSavePrompt(null);
    setMenu(null);
  };

  const filterFor = (col: number) => view.filters.find((f) => f.column === col);
  const setFilter = (col: number, operator: FilterOperator, value: string) => {
    setView((prev) => {
      const rest = prev.filters.filter((f) => f.column !== col);
      const empty = operatorNeedsValue(operator) && value === '';
      return { ...prev, filters: empty ? rest : [...rest, { column: col, operator, value }] };
    });
  };

  if (!result.ok) {
    return (
      <div className="w-full min-w-0 flex flex-col">
        <GridToolbar
          label={label}
          refreshing={refreshing}
          onRefresh={onRefresh}
          toolbarExtra={toolbarExtra}
        />
        <div className="flex items-start gap-2 text-xs text-rose-400 bg-rose-950/40 border border-rose-500/20 rounded-md px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" strokeWidth={SQL_ICON_STROKE} />
          <span className="break-all">{result.error}</span>
        </div>
      </div>
    );
  }

  const order =
    colOrder.length === sourceColumns.length ? colOrder : identityOrder(sourceColumns.length);
  const orderedColumns = order.map((i) => sourceColumns[i]!);
  const syncColPx = rowSync ? SYNC_COL_PX : 0;
  const tableWidth =
    ROW_NUM_PX +
    order.reduce((sum, i) => sum + (colWidths[i] ?? COL_DEFAULT_PX), 0) +
    syncColPx;
  const colCount = 1 + order.length + (rowSync ? 1 : 0);

  const totalRows = viewRows.length;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / rowH) + OVERSCAN * 2;
  const end = Math.min(totalRows, start + visibleCount);
  const padTop = start * rowH;
  const padBottom = Math.max(0, (totalRows - end) * rowH);

  /** Rows in the user's on-screen column order — what copy and export both use. */
  const orderedRowsForOutput = () => viewRows.map((row) => order.map((i) => row[i]));

  const exportOrdered = () => {
    downloadCsv(exportName, orderedColumns, orderedRowsForOutput());
  };

  const exportOrderedJson = () => {
    downloadJson(exportName, orderedColumns, orderedRowsForOutput());
  };

  const exportOrderedYaml = () => {
    downloadYaml(exportName, orderedColumns, orderedRowsForOutput());
  };

  const exportOrderedText = () => {
    downloadFixedWidthText(exportName, orderedColumns, orderedRowsForOutput());
  };

  /**
   * What copy sends: the cell selection if one exists, otherwise the whole
   * grid in display order, or — once the user has picked columns — exactly
   * those, in the order they picked them.
   *
   * `copyColumns` holds source indices rather than display positions so that
   * dragging a column afterwards cannot silently change the selection.
   */
  const copyPayload = (ignoreSel = false): { columns: string[]; rows: unknown[][] } => {
    if (!ignoreSel && cellSel.length > 0)
      return sliceGridSelection(sourceColumns, viewRows, cellSel, order);
    return copyColumns === null
      ? { columns: orderedColumns, rows: orderedRowsForOutput() }
      : pickColumns(sourceColumns, viewRows, copyColumns);
  };

  const copyToClipboard = async (
    mode: boolean | 'headers',
    opts?: { ignoreSel?: boolean; range?: GridRange }
  ) => {
    const { columns, rows } = opts?.range
      ? sliceGridRange(sourceColumns, viewRows, opts.range, order)
      : copyPayload(opts?.ignoreSel);
    if (columns.length === 0) {
      toast({
        tone: 'warning',
        title: 'Nothing to copy',
        body:
          cellSel.length > 0 && !opts?.ignoreSel
            ? 'Select at least one cell.'
            : 'Pick at least one column in Choose columns.',
      });
      return;
    }
    const headersOnly = mode === 'headers';
    const withHeaders = mode === true || headersOnly;
    const text = toTsv(withHeaders ? columns : null, headersOnly ? [] : rows);
    const ok = await writeClipboard(text);
    if (!ok) {
      toast({
        tone: 'warning',
        title: 'Copy failed',
        body: 'The browser blocked clipboard access. Click the grid and try again.',
      });
      return;
    }
    const n = headersOnly ? columns.length : rows.length;
    const selForTitle: GridSelection = opts?.range
      ? [opts.range]
      : !opts?.ignoreSel
        ? cellSel
        : [];
    const title = headersOnly
      ? `Copied ${n} header${n === 1 ? '' : 's'}`
      : selForTitle.length > 0 && selectionCellCount(selForTitle) === 1
        ? 'Copied cell'
        : `Copied ${n} row${n === 1 ? '' : 's'}`;
    toast({
      tone: 'success',
      title,
      body: withHeaders && !headersOnly ? 'Headers included — paste into Excel or Sheets.' : undefined,
      durationMs: 2_000,
    });
  };

  const copyOrdered = (mode: boolean | 'headers') => {
    void copyToClipboard(mode);
  };

  const copyCellValue = async (value: unknown) => {
    const ok = await writeClipboard(toTsv(null, [[value]]));
    if (!ok) {
      toast({
        tone: 'warning',
        title: 'Copy failed',
        body: 'The browser blocked clipboard access. Click the grid and try again.',
      });
      return;
    }
    toast({ tone: 'success', title: 'Copied cell', durationMs: 2_000 });
  };

  /**
   * Start or extend a selection.
   *
   * `extend` (shift) grows the newest rectangle from the anchor. `additive`
   * (Cmd/Ctrl) leaves the existing rectangles alone and starts another, which
   * is what makes a scattered pick possible.
   */
  const beginCellSel = (row: number, col: number, extend: boolean, additive = false) => {
    const anchor = extend && selAnchor.current ? selAnchor.current : { row, col };
    if (!extend || !selAnchor.current) selAnchor.current = { row, col };
    const next: GridRange = { row0: anchor.row, col0: anchor.col, row1: row, col1: col };
    setCellSel((prev) => {
      if (additive) return [...prev, next];
      // Extending replaces the rectangle being dragged, not the earlier ones.
      if (extend && prev.length > 0) return [...prev.slice(0, -1), next];
      return [next];
    });
  };

  const selectRow = (row: number, extend: boolean, additive = false) => {
    const lastCol = Math.max(0, order.length - 1);
    const anchorRow = extend && selAnchor.current ? selAnchor.current.row : row;
    if (!extend || !selAnchor.current) selAnchor.current = { row, col: 0 };
    const next: GridRange = { row0: anchorRow, row1: row, col0: 0, col1: lastCol };
    setCellSel((prev) => {
      if (additive) return [...prev, next];
      if (extend && prev.length > 0) return [...prev.slice(0, -1), next];
      return [next];
    });
  };

  /** Every cell of one column — what double-clicking its header selects. */
  const selectColumn = (visualIdx: number, additive = false) => {
    const lastRow = Math.max(0, viewRows.length - 1);
    const next: GridRange = { row0: 0, row1: lastRow, col0: visualIdx, col1: visualIdx };
    selAnchor.current = { row: 0, col: visualIdx };
    setCellSel((prev) => (additive ? [...prev, next] : [next]));
  };

  return (
    <div className="w-full min-w-0 h-full flex flex-col min-h-0">
      <GridToolbar
        label={label}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onExport={sourceColumns.length > 0 ? exportOrdered : undefined}
        onExportJson={sourceColumns.length > 0 ? exportOrderedJson : undefined}
        viewControls={
          sourceColumns.length > 0 ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                data-testid="sql-grid-filter-toggle"
                title="Filter and sort the rows on this page"
                onClick={() => setShowFilters((v) => !v)}
                className={`${toolbarChrome} transition ${
                  showFilters || viewIsActive(view) ? 'text-cyan-300' : 'text-slate-500 hover:text-cyan-400'
                }`}
              >
                Filter
              </button>
              {viewIsActive(view) && (
                <>
                  {/* Says plainly that this is one page, not the table. */}
                  <span
                    data-testid="sql-grid-view-scope"
                    className="text-[10px] font-semibold text-amber-300"
                    title={describeGridView(sourceColumns, view)}
                  >
                    {hiddenByFilter > 0 ? `${hiddenByFilter} hidden · ` : ''}this page only
                  </span>
                  <button
                    type="button"
                    data-testid="sql-grid-clear-view"
                    title="Clear sort and filters"
                    onClick={() => setView(EMPTY_VIEW)}
                    className={`${toolbarChrome} text-slate-500 hover:text-slate-300 transition`}
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          ) : undefined
        }
        onExportYaml={sourceColumns.length > 0 ? exportOrderedYaml : undefined}
        onExportText={sourceColumns.length > 0 ? exportOrderedText : undefined}
        onCopy={sourceColumns.length > 0 ? copyOrdered : undefined}
        onChooseColumns={sourceColumns.length > 0 ? () => setColPickerOpen(true) : undefined}
        copyScope={
          copyColumns === null
            ? null
            : { picked: copyColumns.length, total: sourceColumns.length }
        }
        toolbarExtra={toolbarExtra}
        emphasis={emphasis}
      />
      <div
        ref={scrollRef}
        data-testid="sql-data-grid"
        tabIndex={0}
        className="fox-sql-grid flex-1 min-h-0 border border-[var(--fox-grid-border)] rounded-lg shadow-sm bg-[var(--fox-grid-bg)] text-[var(--fox-grid-ink)] focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40"
        style={{ overflowX: 'auto', overflowY: 'auto' }}
        onScroll={onScroll}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && cellSel.length > 0) {
            setCellSel([]);
            selAnchor.current = null;
            e.preventDefault();
            return;
          }
          if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return;
          if (sourceColumns.length === 0) return;
          // Never hijack a real text selection — highlighting one cell's text
          // and pressing Cmd-C must still copy just that text.
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) return;
          e.preventDefault();
          void copyToClipboard(e.shiftKey);
        }}
        onMouseLeave={() => {
          if (hoverRow !== null) publishHoverRow(null);
        }}
        onContextMenu={(e) => {
          // Empty area / row-number context: save whole result as table.
          if ((e.target as HTMLElement).closest('td, th')) return;
          e.preventDefault();
          setMenu({ kind: 'grid', x: e.clientX, y: e.clientY });
        }}
      >
        {sourceColumns.length === 0 ? (
          <div className={`px-3 py-2 ${emphasis ? 'text-sm font-semibold' : 'text-xs'} text-[var(--fox-grid-muted)] italic`}>
            0 rows (column names unavailable for empty results)
          </div>
        ) : (
          <table
            className={`text-left border-collapse whitespace-nowrap table-fixed ${
              emphasis ? 'text-sm font-semibold' : 'text-xs'
            }`}
            style={{ width: tableWidth, minWidth: '100%' }}
          >
            <colgroup>
              <col style={{ width: ROW_NUM_PX, minWidth: ROW_NUM_PX }} />
              {order.map((colIdx) => (
                <col
                  key={colIdx}
                  style={{
                    width: colWidths[colIdx] ?? COL_DEFAULT_PX,
                    minWidth: COL_MIN_PX,
                  }}
                />
              ))}
              {rowSync ? (
                <col style={{ width: SYNC_COL_PX, minWidth: SYNC_COL_PX }} />
              ) : null}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-[var(--fox-grid-bg-header)] border-b border-[var(--fox-grid-border)] text-[var(--fox-grid-ink)]">
                <th
                  className={`sticky left-0 z-20 px-1.5 py-1.5 text-center font-bold text-[var(--fox-grid-muted)] bg-[var(--fox-grid-bg-header)] border-r border-[var(--fox-grid-border)] select-none ${
                    emphasis ? 'text-xs' : ''
                  }`}
                  style={{ width: ROW_NUM_PX, minWidth: ROW_NUM_PX }}
                  title="Row number — right-click to save result as table"
                  aria-label="Row number"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ kind: 'grid', x: e.clientX, y: e.clientY });
                  }}
                >
                  #
                </th>
                {order.map((colIdx, visualIdx) => {
                  const name = sourceColumns[colIdx]!;
                  const w = colWidths[colIdx] ?? COL_DEFAULT_PX;
                  const kind = colKinds[colIdx] ?? 'string';
                  const isOver = dragOver === visualIdx && dragFrom !== visualIdx;
                  return (
                    <th
                      key={`${colIdx}-${name}`}
                      draggable
                      data-testid="sql-col-header"
                      title={
                        (columnSources?.get(colIdx)
                          ? `${columnSources.get(colIdx)}.${name} (${KIND_LABEL[kind]})`
                          : `${name} (${KIND_LABEL[kind]})`) +
                        ' — drag to reorder; double-click to select the column; ' +
                        'double-click the edge to fit/reset width; right-click for list variable'
                      }
                      onDoubleClick={(e) => {
                        // Selects the column. Fitting the width is still a
                        // double-click, on the resize edge just right of here,
                        // which had that handler already.
                        e.preventDefault();
                        selectColumn(visualIdx, e.metaKey || e.ctrlKey);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ kind: 'column', x: e.clientX, y: e.clientY, colIdx });
                      }}
                      onDragStart={(e) => {
                        setDragFrom(visualIdx);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(visualIdx));
                        if (e.currentTarget instanceof HTMLElement) {
                          e.dataTransfer.setDragImage(e.currentTarget, 12, 12);
                        }
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        if (dragOver !== visualIdx) setDragOver(visualIdx);
                      }}
                      onDragLeave={() => {
                        if (dragOver === visualIdx) setDragOver(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from =
                          dragFrom ?? Number.parseInt(e.dataTransfer.getData('text/plain'), 10);
                        if (Number.isFinite(from)) {
                          setColOrder((prev) =>
                            reorder(
                              prev.length === sourceColumns.length
                                ? prev
                                : identityOrder(sourceColumns.length),
                              from,
                              visualIdx
                            )
                          );
                        }
                        setDragFrom(null);
                        setDragOver(null);
                      }}
                      onDragEnd={() => {
                        setDragFrom(null);
                        setDragOver(null);
                      }}
                      style={{ width: w, minWidth: COL_MIN_PX, maxWidth: w }}
                      className={`relative px-2 py-1.5 font-bold tracking-wide text-left cursor-grab active:cursor-grabbing select-none overflow-hidden bg-[var(--fox-grid-bg-header)] ${
                        dragFrom === visualIdx ? 'opacity-50' : ''
                      } ${isOver ? 'bg-[var(--fox-grid-bg-header-active)] ring-2 ring-inset ring-cyan-500/60' : ''}`}
                    >
                      <span className="inline-flex items-center gap-1 max-w-full pr-1">
                        <GripVertical className="w-3 h-3 text-cyan-500 shrink-0" strokeWidth={SQL_ICON_STROKE} aria-hidden />
                        {/* Its own control rather than a click on the header:
                            the header is draggable and double-click selects the
                            column, so a bare click there is already spoken for. */}
                        <button
                          type="button"
                          data-testid={`sql-col-sort-${colIdx}`}
                          aria-label={`Sort by ${name}`}
                          title={
                            view.sort?.column === colIdx
                              ? `Sorted ${view.sort.direction === 'asc' ? 'ascending' : 'descending'} — click to ${view.sort.direction === 'asc' ? 'reverse' : 'clear'}`
                              : `Sort by ${name} (this page)`
                          }
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setView((prev) => ({ ...prev, sort: nextSort(prev.sort, colIdx) }));
                          }}
                          className={`shrink-0 leading-none ${
                            view.sort?.column === colIdx ? 'text-cyan-300' : 'text-slate-600 hover:text-slate-300'
                          }`}
                        >
                          {view.sort?.column === colIdx && view.sort.direction === 'desc' ? '▼' : '▲'}
                        </button>
                        <span className="min-w-0 flex flex-col leading-tight">
                          <span className="truncate text-[var(--fox-grid-ink)]">{name}</span>
                          <span
                            className={`${emphasis ? 'text-[10px] font-bold' : 'text-[9px] font-semibold'} uppercase tracking-wider truncate ${KIND_HEADER_CLASS[kind]}`}
                          >
                            {columnSources?.get(colIdx) ? (
                              <>
                                <span
                                  data-testid={`sql-col-source-${colIdx}`}
                                  className="text-violet-300/90"
                                >
                                  {columnSources.get(colIdx)}
                                </span>
                                <span className="opacity-60"> · </span>
                              </>
                            ) : null}
                            {KIND_LABEL[kind]}
                          </span>
                        </span>
                      </span>
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize column ${name}`}
                        data-testid="sql-col-resize"
                        title="Drag to resize column; double-click to fit/reset width"
                        onMouseDown={(e) => startColResize(colIdx, e)}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onHeaderDoubleClick(colIdx);
                        }}
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-cyan-500/50"
                      />
                    </th>
                  );
                })}
                {rowSync ? (
                  <th
                    data-testid="sql-col-sync-header"
                    className={`sticky right-0 z-20 px-1 py-1.5 text-center font-bold tracking-wide text-sky-300 bg-sky-950/90 border-l border-sky-500/40 select-none ${
                      emphasis ? 'text-xs' : 'text-[10px]'
                    }`}
                    style={{ width: SYNC_COL_PX, minWidth: SYNC_COL_PX }}
                    title="Include this row in Data migrate (destination grid)"
                  >
                    Sync
                  </th>
                ) : null}
              </tr>
              {showFilters && (
                <tr data-testid="sql-filter-row" className="bg-[var(--fox-grid-bg-header)]">
                  <th className="sticky left-0 z-20 px-1 bg-[var(--fox-grid-bg-header)]" />
                  {order.map((colIdx) => {
                    const active = filterFor(colIdx);
                    const op = active?.operator ?? 'contains';
                    return (
                      <th key={`f-${colIdx}`} className="px-1 py-1 font-normal align-top">
                        <div className="flex items-center gap-1">
                          <select
                            data-testid={`sql-filter-op-${colIdx}`}
                            aria-label={`Filter operator for ${sourceColumns[colIdx] ?? ''}`}
                            value={op}
                            onChange={(e) =>
                              setFilter(colIdx, e.target.value as FilterOperator, active?.value ?? '')
                            }
                            className="bg-slate-950 border border-slate-700 rounded text-[10px] text-slate-200 max-w-[4.5rem]"
                          >
                            <option value="contains">has</option>
                            <option value="equals">=</option>
                            <option value="notEquals">≠</option>
                            <option value="startsWith">starts</option>
                            <option value="endsWith">ends</option>
                            <option value="gt">&gt;</option>
                            <option value="gte">≥</option>
                            <option value="lt">&lt;</option>
                            <option value="lte">≤</option>
                            <option value="isNull">is null</option>
                            <option value="isNotNull">not null</option>
                          </select>
                          {operatorNeedsValue(op) && (
                            <input
                              data-testid={`sql-filter-value-${colIdx}`}
                              aria-label={`Filter ${sourceColumns[colIdx] ?? ''}`}
                              value={active?.value ?? ''}
                              onChange={(e) => setFilter(colIdx, op, e.target.value)}
                              placeholder="filter…"
                              className="min-w-0 flex-1 bg-slate-950 border border-slate-700 rounded px-1 text-[10px] text-slate-100 placeholder:text-slate-600"
                            />
                          )}
                        </div>
                      </th>
                    );
                  })}
                  {rowSync ? <th className="sticky right-0 z-20 bg-sky-950/90" /> : null}
                </tr>
              )}
            </thead>
            <tbody className={`font-mono bg-[var(--fox-grid-bg)] ${emphasis ? 'font-semibold' : ''}`}>
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={colCount} className="p-0 border-0" />
                </tr>
              )}
              {viewRows.slice(start, end).map((row, offset) => {
                const i = start + offset;
                const size = pageSize && pageSize > 0 ? pageSize : viewRows.length;
                const absRow = pageIndex * size + i + 1;
                const stripe = i % 2 === 1;
                // `selectedRowIndex` is a source position; compare in the same space.
                const selected = toViewRow(selectedRowIndex) === i;
                const rowHovered = hoverRow === i;
                const rowBg = selected
                  ? 'bg-amber-500/15'
                  : rowHovered
                    ? 'bg-[var(--fox-grid-bg-hover)]'
                    : stripe
                      ? 'bg-[var(--fox-grid-bg-stripe)]'
                      : 'bg-[var(--fox-grid-bg)]';
                return (
                  <tr
                    key={i}
                    data-testid={selected ? `sql-row-selected-${i}` : `sql-row-${i}`}
                    className={`${rowBg} hover:bg-[var(--fox-grid-bg-hover)] group border-b border-[var(--fox-grid-border-soft)] ${
                      onSelectRow ? 'cursor-pointer' : ''
                    } ${selected ? 'ring-1 ring-inset ring-amber-500/40' : ''}`}
                    style={{ height: rowH }}
                    onClick={() => onSelectRow?.(toSourceRow(i))}
                    onMouseEnter={() => {
                      if (hoverRow !== i) publishHoverRow(i);
                    }}
                  >
                    <td
                      className={`sticky left-0 z-[5] px-1.5 text-center tabular-nums text-[var(--fox-grid-muted)] ${rowBg} group-hover:bg-[var(--fox-grid-bg-hover)] border-r border-[var(--fox-grid-border-soft)] select-none ${
                        emphasis ? 'text-xs font-bold' : 'text-[10px]'
                      }`}
                      style={{ width: ROW_NUM_PX, minWidth: ROW_NUM_PX }}
                      data-testid="sql-row-num"
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        dragSelecting.current = true;
                        selectRow(i, e.shiftKey, e.metaKey || e.ctrlKey);
                      }}
                      onMouseEnter={() => {
                        if (dragSelecting.current) selectRow(i, true);
                      }}
                      onContextMenu={(e) => {
                        // The container's handler bails inside any td, so
                        // without this the row-number column is a dead zone —
                        // right-clicking it would offer nothing at all.
                        e.preventDefault();
                        setMenu({ kind: 'grid', x: e.clientX, y: e.clientY });
                      }}
                    >
                      {absRow}
                    </td>
                    {order.map((colIdx, visualIdx) => {
                      const cell = row[colIdx];
                      const w = colWidths[colIdx] ?? COL_DEFAULT_PX;
                      const { text, title, isNull } = cellDisplay(cell);
                      const kind = isNull ? 'null' : (colKinds[colIdx] ?? 'string');
                      const hl = cellHighlight?.(toSourceRow(i), colIdx) ?? null;
                      const hlClass = hl ? CELL_DIFF_CLASS[hl] : '';
                      const inSel = selectionHasCell(cellSel, i, visualIdx);
                      const cellBg = hlClass || `${rowBg} group-hover:bg-[var(--fox-grid-bg-hover)]`;
                      return (
                        <td
                          key={colIdx}
                          data-diff={hl ?? undefined}
                          data-selected={inSel ? 'true' : undefined}
                          className={`px-3 overflow-hidden text-ellipsis ${cellBg} ${KIND_CELL_CLASS[kind]} ${
                            emphasis && kind === 'string' ? 'font-semibold' : ''
                          } ${emphasis && kind === 'number' ? 'font-bold' : ''} ${
                            inSel ? 'bg-sky-500/20 ring-1 ring-inset ring-sky-400/60' : ''
                          }`}
                          style={{ width: w, minWidth: COL_MIN_PX, maxWidth: w }}
                          title={hl ? `${hl}: ${title}` : title}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            if ((e.target as HTMLElement).closest('button, input, a')) return;
                            dragSelecting.current = true;
                            beginCellSel(i, visualIdx, e.shiftKey, e.metaKey || e.ctrlKey);
                          }}
                          onDoubleClick={(e) => {
                            // The whole row, without hunting for its number cell.
                            if ((e.target as HTMLElement).closest('button, input, a')) return;
                            e.preventDefault();
                            selectRow(i, false, e.metaKey || e.ctrlKey);
                          }}
                          onMouseEnter={() => {
                            if (dragSelecting.current) beginCellSel(i, visualIdx, true);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (!selectionHasCell(cellSel, i, visualIdx)) {
                              beginCellSel(i, visualIdx, false);
                            }
                            setMenu({
                              kind: 'cell',
                              x: e.clientX,
                              y: e.clientY,
                              colIdx,
                              rowIdx: toSourceRow(i),
                              value: cell,
                            });
                          }}
                        >
                          {linkColumns?.has(colIdx) && !isNull ? (
                            <button
                              type="button"
                              data-testid={`grid-fk-link-${i}-${colIdx}`}
                              title={`Show ${linkColumns.get(colIdx)} for ${text}`}
                              // `i` indexes the rows array; `absRow` is the
                              // 1-based number shown in the # column and would
                              // read the NEXT row's value.
                              onClick={(e) => {
                                e.stopPropagation();
                                onLinkClick?.(colIdx, toSourceRow(i));
                              }}
                              // Rust ID color + solid underline — pale cyan was unreadable.
                              className="underline decoration-solid underline-offset-2 decoration-2 decoration-[var(--fox-grid-link)] text-[var(--fox-grid-link)] font-bold hover:brightness-110"
                            >
                              {text}
                            </button>
                          ) : (
                            text
                          )}
                        </td>
                      );
                    })}
                    {rowSync ? (
                      <td
                        className={`sticky right-0 z-[5] px-1 text-center ${rowBg} group-hover:bg-[var(--fox-grid-bg-hover)] border-l border-sky-500/30 bg-sky-950/40`}
                        style={{ width: SYNC_COL_PX, minWidth: SYNC_COL_PX }}
                      >
                        {(() => {
                          const syncVal = rowSync.isChecked(toSourceRow(i));
                          if (syncVal === null) {
                            return (
                              <span
                                className="text-[var(--fox-grid-muted)] select-none"
                                title="Row matches by key"
                              >
                                —
                              </span>
                            );
                          }
                          return (
                            <input
                              type="checkbox"
                              data-testid={`sql-row-sync-check-${i}`}
                              checked={syncVal}
                              onChange={(e) => {
                                e.stopPropagation();
                                rowSync.onToggle(toSourceRow(i), e.target.checked);
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded border-sky-500/60 accent-sky-500"
                              title="Include in migrate"
                            />
                          );
                        })()}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={colCount} className="p-0 border-0" />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div
        className={`flex items-center gap-2 mt-1 text-slate-400 shrink-0 flex-wrap ${
          emphasis ? 'text-xs font-semibold' : 'text-[10px]'
        }`}
      >
        <span>
          {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
          {pageSize ? ` / page of ${pageSize}` : ''}
          {typeof pageIndex === 'number' ? ` · page ${pageIndex + 1}` : ''}
          {' · '}
          {result.durationMs} ms
        </span>
        {result.truncated && (
          <span className="text-amber-400 font-bold">
            truncated — use Next page or raise Rows/page
          </span>
        )}
        {(onPrevPage || onNextPage) && (
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              data-testid="sql-page-prev"
              disabled={!hasPrevPage || pageLoading}
              onClick={onPrevPage}
              className={`px-1.5 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-40 ${
                emphasis ? 'font-bold' : 'font-semibold'
              }`}
            >
              Prev
            </button>
            <button
              type="button"
              data-testid="sql-page-next"
              disabled={!hasNextPage || pageLoading}
              onClick={onNextPage}
              className={`px-1.5 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-40 ${
                emphasis ? 'font-bold' : 'font-semibold'
              }`}
            >
              {pageLoading ? '…' : 'Next'}
            </button>
          </span>
        )}
      </div>

      {colPickerOpen && (
        <div
          data-testid="sql-grid-copy-columns"
          className="fixed z-[120] left-1/2 top-24 -translate-x-1/2 w-72 max-h-80 flex flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl text-[11px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-slate-800 shrink-0">
            <ClipboardCopy className="w-3 h-3 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
            <span className="font-bold text-slate-200">Columns to copy</span>
            <button
              type="button"
              aria-label="Close"
              data-testid="sql-grid-copy-columns-close"
              className="ml-auto text-slate-500 hover:text-slate-200"
              onClick={() => setColPickerOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-slate-800/80 shrink-0">
            <button
              type="button"
              data-testid="sql-grid-copy-columns-all"
              className="px-2 py-0.5 rounded text-[10px] font-bold border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition"
              onClick={() => setCopyColumns(null)}
            >
              All (grid order)
            </button>
            <button
              type="button"
              data-testid="sql-grid-copy-columns-none"
              className="px-2 py-0.5 rounded text-[10px] font-bold border border-slate-700 text-slate-300 hover:border-rose-500/40 hover:text-rose-200 transition"
              onClick={() => setCopyColumns([])}
            >
              None
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {order.map((srcIdx) => {
              const rank = copyColumns ? copyColumns.indexOf(srcIdx) : -1;
              const checked = copyColumns === null || rank >= 0;
              return (
                <label
                  key={srcIdx}
                  className="flex items-center gap-2 px-2.5 py-1 hover:bg-slate-800/70 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    data-testid={`sql-grid-copy-col-${sourceColumns[srcIdx]}`}
                    checked={checked}
                    onChange={() => {
                      setCopyColumns((cur) => {
                        // First tick converts the implicit "everything" into an
                        // explicit list so unticking one column keeps the rest.
                        const base = cur ?? [...order];
                        return base.includes(srcIdx)
                          ? base.filter((i) => i !== srcIdx)
                          : [...base, srcIdx];
                      });
                    }}
                  />
                  <span className="truncate text-slate-200">{sourceColumns[srcIdx]}</span>
                  {rank >= 0 && (
                    // Selection order is copy order, so show where it lands.
                    <span className="ml-auto text-[10px] font-bold text-amber-300">
                      {rank + 1}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-slate-800 shrink-0">
            <button
              type="button"
              data-testid="sql-grid-copy-columns-values"
              className="px-2 py-0.5 rounded text-[10px] font-bold border border-slate-700 text-slate-200 hover:border-cyan-500/50 hover:text-cyan-200 transition"
              onClick={() => {
                void copyToClipboard(false, { ignoreSel: true });
                setColPickerOpen(false);
              }}
            >
              Copy values
            </button>
            <button
              type="button"
              data-testid="sql-grid-copy-columns-headers"
              className="px-2 py-0.5 rounded text-[10px] font-bold border border-slate-700 text-slate-200 hover:border-cyan-500/50 hover:text-cyan-200 transition"
              onClick={() => {
                void copyToClipboard(true, { ignoreSel: true });
                setColPickerOpen(false);
              }}
            >
              With headers
            </button>
          </div>
          <div className="px-2.5 py-1.5 border-t border-slate-800 text-[10px] text-slate-500 shrink-0">
            Numbers show copy order — tick in the order you want.
          </div>
        </div>
      )}

      {menu && (
        <div
          data-testid="sql-grid-context-menu"
          className="fixed z-50 min-w-[160px] rounded-md border border-slate-700 bg-slate-900 shadow-lg py-1 text-[11px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {sourceColumns.length > 0 && (
            <>
              {menu.kind === 'cell' && openRowTarget?.(menu.colIdx, menu.rowIdx) && (
                <button
                  type="button"
                  data-testid="sql-grid-ctx-open-row"
                  className="w-full text-left px-3 py-1.5 text-violet-200 hover:bg-slate-800"
                  onClick={() => {
                    onOpenRow?.(menu.colIdx, menu.rowIdx);
                    setMenu(null);
                  }}
                >
                  Open {openRowTarget(menu.colIdx, menu.rowIdx)} row
                </button>
              )}
              {menu.kind === 'cell' && (
                <button
                  type="button"
                  data-testid="sql-grid-ctx-copy-cell"
                  className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    void copyCellValue(menu.value);
                    setMenu(null);
                  }}
                >
                  Copy cell
                </button>
              )}
              {menu.kind === 'column' && (
                <>
                  <button
                    type="button"
                    data-testid="sql-grid-ctx-copy-header"
                    className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                    onClick={() => {
                      const name = sourceColumns[menu.colIdx] ?? '';
                      void writeClipboard(toTsv([name], [])).then((ok) => {
                        toast({
                          tone: ok ? 'success' : 'warning',
                          title: ok ? 'Copied header' : 'Copy failed',
                          durationMs: 2_000,
                        });
                      });
                      setMenu(null);
                    }}
                  >
                    Copy header
                  </button>
                  <button
                    type="button"
                    data-testid="sql-grid-ctx-copy-column"
                    className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                    onClick={() => {
                      const visual = order.indexOf(menu.colIdx);
                      if (visual >= 0) {
                        const range = {
                          row0: 0,
                          row1: Math.max(0, viewRows.length - 1),
                          col0: visual,
                          col1: visual,
                        };
                        setCellSel([range]);
                        selAnchor.current = { row: 0, col: visual };
                        void copyToClipboard(false, { range });
                      }
                      setMenu(null);
                    }}
                  >
                    Copy column
                  </button>
                  <button
                    type="button"
                    data-testid="sql-grid-ctx-copy-column-headers"
                    className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                    onClick={() => {
                      const visual = order.indexOf(menu.colIdx);
                      if (visual >= 0) {
                        const range = {
                          row0: 0,
                          row1: Math.max(0, viewRows.length - 1),
                          col0: visual,
                          col1: visual,
                        };
                        setCellSel([range]);
                        selAnchor.current = { row: 0, col: visual };
                        void copyToClipboard(true, { range });
                      }
                      setMenu(null);
                    }}
                  >
                    Copy column with header
                  </button>
                </>
              )}
              <button
                type="button"
                data-testid="sql-grid-ctx-copy-values"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  void copyToClipboard(false, { ignoreSel: menu.kind === 'grid' });
                  setMenu(null);
                }}
              >
                {cellSel.length > 0 && menu.kind !== 'grid' ? 'Copy selected values' : 'Copy values'}
              </button>
              <button
                type="button"
                data-testid="sql-grid-ctx-copy-headers"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  void copyToClipboard(true, { ignoreSel: menu.kind === 'grid' });
                  setMenu(null);
                }}
              >
                {cellSel.length > 0 && menu.kind !== 'grid' ? 'Copy selected with headers' : 'Copy with headers'}
              </button>
              <button
                type="button"
                data-testid="sql-grid-ctx-copy-headers-only"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  void copyToClipboard('headers', { ignoreSel: menu.kind === 'grid' });
                  setMenu(null);
                }}
              >
                {cellSel.length > 0 && menu.kind !== 'grid' ? 'Copy selected headers' : 'Copy headers'}
              </button>
              <button
                type="button"
                data-testid="sql-grid-ctx-choose-cols"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  setColPickerOpen(true);
                  setMenu(null);
                }}
              >
                Choose columns…
              </button>
              <div className="my-1 border-t border-slate-700" />
            </>
          )}
          {menu.kind === 'cell' ? (
            <>
              <button data-testid="sql-grid-save-cell-as"
                type="button"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  const colName = sourceColumns[menu.colIdx] ?? 'value';
                  setSavePrompt({
                    mode: 'scalar',
                    value: menu.value,
                    defaultName: colName.replace(/[^A-Za-z0-9_]/g, '_') || 'value',
                  });
                  setMenu(null);
                }}
              >
                Save cell as variable…
              </button>
              <button data-testid="sql-grid-save-result-as"
                type="button"
                className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  setSavePrompt({ mode: 'table', defaultName: 'result' });
                  setMenu(null);
                }}
              >
                Save result as table…
              </button>
            </>
          ) : menu.kind === 'column' ? (
            <button data-testid="sql-grid-save-column-as"
              type="button"
              className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
              onClick={() => {
                const colName = sourceColumns[menu.colIdx] ?? 'values';
                setSavePrompt({
                  mode: 'list',
                  colIdx: menu.colIdx,
                  defaultName: `${colName.replace(/[^A-Za-z0-9_]/g, '_') || 'values'}_list`,
                });
                setMenu(null);
              }}
            >
              Save column as list…
            </button>
          ) : (
            <button data-testid="sql-grid-save-result-as-mode"
              type="button"
              className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-800"
              onClick={() => {
                setSavePrompt({
                  mode: 'table',
                  defaultName: 'result',
                });
                setMenu(null);
              }}
            >
              Save result as table…
            </button>
          )}
        </div>
      )}

      {savePrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          data-testid="sql-variable-save-dialog"
          onClick={() => setSavePrompt(null)}
        >
          <div
            className="w-72 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-semibold text-slate-200 mb-2">
              {savePromptTitle(savePrompt.mode)}
            </div>
            <input data-testid="sql-grid-save-name"
              ref={saveInputRef}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSave();
                if (e.key === 'Escape') setSavePrompt(null);
              }}
              placeholder="variable_name"
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 outline-none accent-focus mb-2"
            />
            {saveError && (
              <p className="text-[10px] text-rose-400 mb-2" role="alert">
                {saveError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button data-testid="sql-grid-cancel"
                type="button"
                onClick={() => setSavePrompt(null)}
                className="text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="sql-variable-save-confirm"
                onClick={commitSave}
                className="text-[11px] font-semibold text-cyan-400 hover:text-cyan-300 px-2 py-1"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

DataGrid.displayName = 'DataGrid';

export const PANE_MIN_PX = 240;
export const PANE_DEFAULT_PX = 420;
export const PANE_MIN_H_PX = 160;
export const PANE_DEFAULT_H_PX = 360;
export { ROW_H_PX };
