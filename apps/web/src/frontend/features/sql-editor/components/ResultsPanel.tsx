/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Results for one SQL Editor tab (By cred / Side-by-side layouts).
 * Side-by-side can Compare cell values across credentials (colored diffs).
 * Foreign-key cells can open Data Peek when schema FKs match the statement.
 * Single-table SELECT grids support add / edit / clone / delete (same DML path
 * as Data Peek) when the primary key is present in the result columns.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Loader2,
  Database,
  AlertCircle,
  GripVertical,
  RefreshCw,
  GitCompare,
  Maximize2,
  X,
  Download,
  BarChart2,
} from 'lucide-react';
import { useSqlEditorStore, type CredentialRun } from '@/app/store/useSqlEditorStore';
import { useSyncStore } from '@/app/store/useSyncStore';
import type { ResultsLayout } from '@/app/store/sqlEditorTabLogic';
import { DataGrid, PANE_DEFAULT_H_PX, PANE_DEFAULT_PX, PANE_MIN_H_PX, PANE_MIN_PX } from './DataGrid';
import { ResultChart } from './ResultChart';
import { chartableSeries } from '../lib/resultChart';
import type { SqlStatementResult } from '@/shared/api/sqlApi';
import { detectCodeCell } from '@/features/sql-editor/lib/codeCellRunner';
import { CODE_CELL_KIND_LABEL } from '@/shared/lib/sql-splitter';
import {
  foreignKeyLinksFor,
  foreignKeyLinksForSql,
  fkDrillTableName,
  singleTableForResultEdit,
} from '@/shared/lib/tablePreview';
import {
  attributeResultColumns,
  collapsedColumnsFor,
  rowKeyFor,
  tablesInOrigins,
} from '@foxschema/sql';
import {
  cellDiffKey,
  compareResultGrids,
  type CellDiffKind,
  type GridDiffSummary,
} from '@/features/sql-editor/lib/resultDataDiff';
import {
  alignResultGridsByKey,
  compareKeyAlignedGrids,
  type AlignRowOp,
} from '@/features/sql-editor/lib/resultKeyAlign';
import { migrateGridsAreComplete } from '@/features/sql-editor/lib/resultRowDiff';
import { sideBySideSectionCount } from '@/features/sql-editor/lib/resultsSections';
import { detectTriggerManagedColumns } from '@/features/sql-editor/lib/triggerManagedColumns';
import { resolvePeekKeyColumns } from '@/features/sql-editor/lib/rowDml';
import { buildSampleBookmarks } from '@/features/sql-editor/lib/sqlEditorSamples';
import { downloadMultiGridCsv } from '@/features/sql-editor/utils/exportCsv';
import { DataMigrateBar } from './DataMigrateBar';
import { usePeekGridCrud } from './usePeekGridCrud';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

/** Align ops → migrate vocabulary for combined CSV. */
function compareOpCsvLabel(op: AlignRowOp): string {
  if (op === 'update') return 'edit';
  if (op === 'delete') return 'add';
  if (op === 'insert') return 'delete';
  if (op === 'unresolved') return 'unknown';
  return 'match';
}

interface Props {
  runs: CredentialRun[];
  /** The statements the run executed, for grid labels ("Query 1 · SELECT …"). */
  statements: string[];
  /** 0-based source cell indices aligned with `statements` (for Out [n]). */
  statementIndices?: number[];
  layout: ResultsLayout;
  /** True while any execute is in flight for this tab. */
  refreshing?: boolean;
  /** Non-fatal run messages (e.g. `@set` failures). */
  warnings?: string[];
  /** Re-run for one credential, or all when omitted. */
  onRefresh?: (connectionId?: string) => void;
  /** Load another result page for a grid (server OFFSET; uses page cache). */
  onPage?: (args: {
    connectionId: string;
    statementIndex: number;
    pageIndex: number;
  }) => void;
  pageState?: Record<
    string,
    { pageIndex: number; hasNext: boolean; loading?: boolean; pageSize?: number }
  >;
}

const GAP_PX = 6; // space between pane and its resize grip

/** Attach document-level drag listeners; cleans up cursor/userSelect on mouseup. */
function bindAxisDrag(cursor: string, onMove: (ev: MouseEvent) => void): void {
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = cursor;
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

const statementLabel = (sql: string | undefined, outNumber: number): string => {
  // A section can exist before its statement is reported — side-by-side draws
  // one for a run that is still in flight. `Out [n]:` alone reads half-drawn.
  if (sql === undefined) return `Out [${outNumber}]: running…`;
  const cell = detectCodeCell(sql);
  if (cell) {
    return `Out [${outNumber}]: ${CODE_CELL_KIND_LABEL[cell.kind].long}`;
  }
  const compact = sql.replace(/\s+/g, ' ').trim();
  return `Out [${outNumber}]: ${compact.length > 48 ? compact.slice(0, 48) + '…' : compact}`;
};

const credentialLabel = (run: CredentialRun): string => `${run.name} [${run.dialect}]`;

type PaneItem =
  | {
      key: string;
      kind: 'grid';
      result: SqlStatementResult;
      label: string;
      exportName: string;
      connectionId: string;
      dialect: string;
      statementIndex: number;
      /** SQL that produced this grid — used for FK → Data Peek links + row edit. */
      statementSql?: string;
    }
  | { key: string; kind: 'running'; label: string; connectionId: string }
  | { key: string; kind: 'error'; label: string; error: string; connectionId: string };

/** Pane role when Compare is on — Source left, Target A/B… on the right. */
function comparePaneRole(
  connectionId: string,
  baselineId: string,
  _destId: string,
  okGrids: Extract<PaneItem, { kind: 'grid' }>[]
): string {
  if (connectionId === baselineId) return 'Source';
  const targets = okGrids.filter((g) => g.connectionId !== baselineId);
  if (targets.length <= 1) return 'Target';
  const idx = targets.findIndex((g) => g.connectionId === connectionId);
  if (idx < 0) return 'Target';
  return `Target ${String.fromCharCode(65 + idx)}`;
}

/** Source first, then destination, then any other panes. */
function orderPanesSourceLeft(
  list: PaneItem[],
  baselineId: string,
  destId: string
): PaneItem[] {
  if (!baselineId) return list;
  const source = list.filter((i) => i.connectionId === baselineId);
  const dest = destId ? list.filter((i) => i.connectionId === destId) : [];
  const rest = list.filter(
    (i) => i.connectionId !== baselineId && i.connectionId !== destId
  );
  return [...source, ...dest, ...rest];
}

function equalWidths(count: number, containerW: number): number[] {
  if (count <= 0) return [];
  const gripTotal = count * (8 + GAP_PX); // grip + gap per pane
  const avail = Math.max(count * PANE_MIN_PX, containerW - gripTotal);
  const each = Math.max(PANE_MIN_PX, Math.floor(avail / count));
  return Array.from({ length: count }, () => each);
}

const ResultGridPane: React.FC<{
  item: Extract<PaneItem, { kind: 'grid' }>;
  refreshing?: boolean;
  onRefresh?: (connectionId: string) => void;
  onPage?: Props['onPage'];
  pageState?: Props['pageState'];
  scrollSyncId?: string;
  scrollSync?: {
    register: (id: string, apply: (scrollTop: number) => void) => () => void;
    broadcast: (sourceId: string, scrollTop: number) => void;
  };
  hoverSync?: {
    register: (id: string, apply: (rowIdx: number | null) => void) => () => void;
    broadcast: (sourceId: string, rowIdx: number | null) => void;
  };
  /** Cross-connection compare highlights for this grid. */
  diffSummary?: GridDiffSummary | null;
  /** Suffix shown after the grid label (e.g. original / N differ). */
  compareBadge?: string | null;
  /** Key-aligned compare remaps rows — disable inline CRUD to avoid wrong targets. */
  compareLocked?: boolean;
  rowSync?: {
    isChecked: (rowIdx: number) => boolean | null;
    onToggle: (rowIdx: number, checked: boolean) => void;
  };
}> = ({
  item,
  refreshing,
  onRefresh,
  onPage,
  pageState,
  scrollSyncId,
  scrollSync,
  hoverSync,
  diffSummary = null,
  compareBadge = null,
  compareLocked = false,
  rowSync,
}) => {
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const openDataPeekFromFk = useSqlEditorStore((s) => s.openDataPeekFromFk);
  const openDataPeekForRow = useSqlEditorStore((s) => s.openDataPeekForRow);
  const connectionSchema = useSyncStore(
    (s) => s.connections.find((c) => c.id === item.connectionId)?.schema
  );
  const tables = schemaCache[item.connectionId]?.tables;

  const editTarget = useMemo(() => {
    if (!item.statementSql || detectCodeCell(item.statementSql)) {
      return { ok: false as const, reason: undefined as string | undefined };
    }
    return singleTableForResultEdit(item.statementSql, tables, connectionSchema);
  }, [item.statementSql, tables, connectionSchema]);

  const table = editTarget.ok ? editTarget.table : undefined;
  // Prefer the schema cache name (same as Data Peek entry.tableName from the explorer).
  const tableName = table?.name ?? '';

  // Match Data Peek: FK links come from the single editable table when known.
  const fkLinks = useMemo(() => {
    if (!item.result.ok) return [];
    if (table) return foreignKeyLinksFor(table, item.result.columns);
    if (!item.statementSql) return [];
    return foreignKeyLinksForSql(item.statementSql, tables, item.result.columns);
  }, [item.result, item.statementSql, table, tables]);

  /**
   * Which table each column came from.
   *
   * Only worth computing for a result the grid cannot already attribute on its
   * own: a single-table query has one answer for every column, and labelling
   * all forty of them `orders` is noise. A join is the case where the reader
   * genuinely cannot tell, so that is where the labels appear.
   */
  const origins = useMemo(() => {
    if (!item.result.ok || !item.statementSql) return [];
    if (editTarget.ok) return []; // single table — the header already implies it
    return attributeResultColumns({
      sql: item.statementSql,
      resultColumns: item.result.columns,
      tables: tables ?? [],
    });
  }, [item.result, item.statementSql, editTarget.ok, tables]);

  /**
   * Columns the join produced that never reached the grid.
   *
   * Rows arrive keyed by column name, so a join whose tables share one loses
   * all but the last. The grid then shows a row that reads as a single record
   * but mixes tables, with columns missing and nothing reported. Until the
   * drivers return rows positionally, the least this can do is say so.
   */
  const collapsed = useMemo(() => {
    if (!item.result.ok || !item.statementSql || editTarget.ok) return null;
    return collapsedColumnsFor({
      sql: item.statementSql,
      resultColumns: item.result.columns,
      tables: tables ?? [],
    });
  }, [item.result, item.statementSql, editTarget.ok, tables]);

  const columnSources = useMemo(() => {
    if (origins.length === 0) return undefined;
    const map = new Map<number, string>();
    for (const o of origins) if (o.table) map.set(o.index, o.table);
    // Nothing was attributable — no labels rather than an empty column of dots.
    return map.size > 0 ? map : undefined;
  }, [origins]);

  /**
   * The table a cell's row can be opened in.
   *
   * Recomputed per call rather than cached per column, because it depends on
   * the row: an outer join that did not match has a NULL key, and there is no
   * row to open for that one even though the column is attributed.
   */
  const openRowTarget = useCallback(
    (colIdx: number, rowIdx: number): string | undefined => {
      if (!item.result.ok || origins.length === 0) return undefined;
      const origin = origins.find((o) => o.index === colIdx);
      if (!origin?.table) return undefined;
      const schema = tables?.find((t) => t.name.toLowerCase() === origin.table!.toLowerCase());
      const row = item.result.rows[rowIdx];
      if (!schema || !row) return undefined;
      return rowKeyFor(schema, origins, row) ? schema.name : undefined;
    },
    [item.result, origins, tables]
  );

  const onOpenRow = useCallback(
    (colIdx: number, rowIdx: number) => {
      if (!item.result.ok) return;
      const origin = origins.find((o) => o.index === colIdx);
      if (!origin?.table) return;
      const schema = tables?.find((t) => t.name.toLowerCase() === origin.table!.toLowerCase());
      const row = item.result.rows[rowIdx];
      if (!schema || !row) return;
      const keys = rowKeyFor(schema, origins, row);
      if (!keys) return;
      void openDataPeekForRow(
        item.connectionId,
        schema.name,
        keys.map((k) => ({ column: k.column, value: k.value }))
      );
    },
    [item.result, item.connectionId, origins, tables, openDataPeekForRow]
  );

  const linkColumns = useMemo(() => {
    if (fkLinks.length === 0) return undefined;
    const map = new Map<number, string>();
    for (const l of fkLinks) map.set(l.columnIndex, fkDrillTableName(l.fk));
    return map;
  }, [fkLinks]);

  const onLinkClick = useCallback(
    (colIdx: number, rowIdx: number) => {
      if (!item.result.ok) return;
      const link = fkLinks.find((l) => l.columnIndex === colIdx);
      if (!link) return;
      const row = item.result.rows[rowIdx];
      if (!row) return;
      void openDataPeekFromFk(
        item.connectionId,
        link.fk,
        link.valueIndexes.map((i) => row[i])
      );
    },
    [item, fkLinks, openDataPeekFromFk]
  );

  const pageKey = `${item.connectionId}:${item.statementIndex}`;
  const page = pageState?.[pageKey];
  const pageIndex = page?.pageIndex ?? 0;

  const afterWrite = useCallback(async () => {
    // Same idea as Data Peek's runDataPeekEntry: refresh only this grid's page.
    const store = useSqlEditorStore.getState();
    const tab = store.resultsByTab[store.activeTabId];
    const sql = tab?.pageSqlByConnection?.[item.connectionId]?.[item.statementIndex];
    if (sql) {
      await store.reloadResultPage({
        connectionId: item.connectionId,
        statementIndex: item.statementIndex,
        pageIndex,
      });
      return;
    }
    // Fallback when paging SQL was not recorded (non-pageable / empty).
    onRefresh?.(item.connectionId);
  }, [item.connectionId, item.statementIndex, pageIndex, onRefresh]);

  const columns = item.result.ok ? item.result.columns : [];
  const rows = item.result.ok ? item.result.rows : [];
  const chartSeries = item.result.ok ? chartableSeries(item.result.columns, item.result.rows) : null;
  const [chartOn, setChartOn] = useState(false);

  const crud = usePeekGridCrud({
    connectionId: item.connectionId,
    dialect: item.dialect,
    tableName,
    table,
    columns,
    rows,
    // Match Data Peek: resultOk is about the grid, not whether schema resolved yet.
    // Key-aligned compare pads/reorders rows — keep CRUD off until Compare is off.
    resultOk: Boolean(item.result.ok) && !compareLocked,
    sessionKey: `${item.connectionId}:${item.statementIndex}:${pageIndex}`,
    resultEpoch: item.result,
    onAfterWrite: afterWrite,
    testId: (action) => `sql-result-${item.statementIndex}-${action}`,
  });

  const readOnlyReason = useMemo(() => {
    if (compareLocked && item.result.ok) return 'Turn off Compare data to edit rows';
    if (crud.showCrud || !item.result.ok) return undefined;
    const base = !editTarget.ok ? editTarget.reason : crud.editability.reason;
    if (!base) return undefined;
    // A join cannot be edited in place — the same base row can appear in many
    // grid rows. Say where editing *is* possible rather than stopping at "no".
    const sources = tablesInOrigins(origins);
    if (sources.length === 0) return base;
    return `${base} Right-click a cell to open its row in ${sources.join(', ')}, where it can be edited.`;
  }, [compareLocked, item.result.ok, crud.showCrud, crud.editability.reason, editTarget, origins]);

  const toolbarExtra = (
    <>
      {chartSeries && (
        <label
          className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-bold text-slate-300"
          title="Draw a bar chart from the first label and number columns of this page"
        >
          <input
            type="checkbox"
            data-testid={`sql-result-chart-toggle-${item.statementIndex}`}
            checked={chartOn}
            onChange={(e) => setChartOn(e.target.checked)}
            className="rounded border-slate-600 accent-sky-500"
          />
          <BarChart2 className="w-3.5 h-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
          Chart
        </label>
      )}
      {crud.crudButtons}
      {collapsed && (
        <span
          className="text-xs font-semibold text-amber-300 truncate max-w-[18rem]"
          data-testid={`sql-result-${item.statementIndex}-collapsed`}
          title={
            `${collapsed.lost} column${collapsed.lost === 1 ? '' : 's'} did not reach this grid: ` +
            `${collapsed.names.join(', ')} ${collapsed.names.length === 1 ? 'is' : 'are'} on more than one ` +
            'of the joined tables, and rows arrive keyed by column name, so only the last survives. ' +
            'Alias them in the SELECT list (o.id AS order_id) to see every column.'
          }
        >
          {collapsed.lost} column{collapsed.lost === 1 ? '' : 's'} hidden
        </span>
      )}
      {readOnlyReason && (
        <span
          className="text-xs font-semibold text-slate-400 truncate max-w-[14rem]"
          title={readOnlyReason}
          data-testid={`sql-result-${item.statementIndex}-readonly`}
        >
          Read-only
        </span>
      )}
    </>
  );

  const cellHighlight = useMemo(() => {
    if (!diffSummary || diffSummary.cells.size === 0) return undefined;
    const cells = diffSummary.cells;
    return (rowIdx: number, colIdx: number): CellDiffKind | null =>
      cells.get(cellDiffKey(rowIdx, colIdx)) ?? null;
  }, [diffSummary]);

  const gridLabel = compareBadge ? `${compareBadge} · ${item.label}` : item.label;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {crud.writeErrorBanner}
      {chartOn && chartSeries && (
        <ResultChart
          series={chartSeries}
          testId={`sql-result-chart-${item.statementIndex}`}
        />
      )}
      <DataGrid
        result={item.result}
        label={gridLabel}
        exportName={item.exportName}
        refreshing={refreshing}
        onRefresh={onRefresh ? () => onRefresh(item.connectionId) : undefined}
        scrollSyncId={scrollSyncId}
        scrollSync={scrollSync}
        hoverSync={hoverSync}
        pageIndex={pageIndex}
        pageSize={page?.pageSize}
        hasPrevPage={!refreshing && Boolean(page) && pageIndex > 0}
        hasNextPage={!refreshing && Boolean(page?.hasNext)}
        pageLoading={Boolean(refreshing || page?.loading)}
        onPrevPage={
          onPage && page && !refreshing
            ? () =>
                onPage({
                  connectionId: item.connectionId,
                  statementIndex: item.statementIndex,
                  pageIndex: Math.max(0, pageIndex - 1),
                })
            : undefined
        }
        onNextPage={
          onPage && page && !refreshing
            ? () =>
                onPage({
                  connectionId: item.connectionId,
                  statementIndex: item.statementIndex,
                  pageIndex: pageIndex + 1,
                })
            : undefined
        }
        linkColumns={linkColumns}
        onLinkClick={linkColumns ? onLinkClick : undefined}
        columnSources={columnSources}
        openRowTarget={columnSources ? openRowTarget : undefined}
        onOpenRow={columnSources ? onOpenRow : undefined}
        selectedRowIndex={crud.selectedRowIndex}
        onSelectRow={crud.onSelectRow}
        toolbarExtra={toolbarExtra}
        cellHighlight={cellHighlight}
        rowSync={rowSync}
      />
      {linkColumns && linkColumns.size > 0 && (
        <p
          className="mt-0.5 px-0.5 shrink-0 text-[10px] text-slate-500"
          data-testid="sql-results-fk-hint"
        >
          Underlined rust cells are foreign keys — click one to open Data Peek (related rows).
        </p>
      )}
      {crud.overlays}
    </div>
  );
};

const PaneBody: React.FC<{
  item: PaneItem;
  refreshing?: boolean;
  onRefresh?: (connectionId: string) => void;
  onPage?: Props['onPage'];
  pageState?: Props['pageState'];
  scrollSyncId?: string;
  scrollSync?: {
    register: (id: string, apply: (scrollTop: number) => void) => () => void;
    broadcast: (sourceId: string, scrollTop: number) => void;
  };
  hoverSync?: {
    register: (id: string, apply: (rowIdx: number | null) => void) => () => void;
    broadcast: (sourceId: string, rowIdx: number | null) => void;
  };
  diffSummary?: GridDiffSummary | null;
  compareBadge?: string | null;
  compareLocked?: boolean;
  rowSync?: {
    isChecked: (rowIdx: number) => boolean | null;
    onToggle: (rowIdx: number, checked: boolean) => void;
  };
}> = ({
  item,
  refreshing,
  onRefresh,
  onPage,
  pageState,
  scrollSyncId,
  scrollSync,
  hoverSync,
  diffSummary = null,
  compareBadge = null,
  compareLocked = false,
  rowSync,
}) => {
  if (item.kind === 'grid') {
    return (
      <ResultGridPane
        item={item}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onPage={onPage}
        pageState={pageState}
        scrollSyncId={scrollSyncId}
        scrollSync={scrollSync}
        hoverSync={hoverSync}
        diffSummary={diffSummary}
        compareBadge={compareBadge}
        compareLocked={compareLocked}
        rowSync={rowSync}
      />
    );
  }
  if (item.kind === 'running') {
    return (
      <div
        data-testid="sql-results-running"
        className="flex items-center gap-2 text-xs text-slate-500 h-full px-2"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" strokeWidth={SQL_ICON_STROKE} />{' '}
        {item.label}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div className="flex items-center gap-2 shrink-0">
        <div
          className="text-[10px] font-bold text-slate-500 uppercase tracking-wider truncate flex-1"
          title={item.label}
        >
          {item.label}
        </div>
        {onRefresh && (
          <button
            type="button"
            data-testid={`sql-pane-retry-${item.connectionId}`}
            title="Retry this server"
            disabled={refreshing}
            onClick={() => onRefresh(item.connectionId)}
            className="flex items-center gap-0.5 text-[10px] font-semibold text-slate-500 hover:text-cyan-400 transition shrink-0 disabled:opacity-40"
          >
            <RefreshCw
              className={`w-3 h-3 text-cyan-400 ${refreshing ? 'animate-spin' : ''}`}
              strokeWidth={SQL_ICON_STROKE}
            />{' '}
            Refresh
          </button>
        )}
      </div>
      <div className="flex items-start gap-2 text-xs text-rose-400 bg-rose-950/40 border border-rose-500/20 rounded-md px-3 py-2 flex-1 overflow-auto">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" strokeWidth={SQL_ICON_STROKE} />
        <span className="break-all">{item.error}</span>
      </div>
    </div>
  );
};

/**
 * Horizontal row of result panes (side-by-side layout). Every table has its own
 * drag grip on the right edge — widths are independent.
 */
const ResizablePaneRow: React.FC<{
  items: PaneItem[];
  rowKey: string;
  refreshing?: boolean;
  onRefresh?: (connectionId: string) => void;
  onPage?: Props['onPage'];
  pageState?: Props['pageState'];
  /** Per connectionId: cell diff summary when Compare is on. */
  diffByConnection?: Record<string, GridDiffSummary>;
  /** Per connectionId: label badge (original / N differ). */
  badgeByConnection?: Record<string, string>;
  /** Key-aligned compare remaps rows — lock inline CRUD. */
  compareLocked?: boolean;
  /** Per connectionId: row Sync column (destination grid). */
  rowSyncByConnection?: Record<
    string,
    {
      isChecked: (rowIdx: number) => boolean | null;
      onToggle: (rowIdx: number, checked: boolean) => void;
    }
  >;
  /** Fill parent height (fullscreen compare modal) instead of a fixed pane height. */
  fillAvailable?: boolean;
  /**
   * When set, forces scroll/hover sync on or off for all grids in this row.
   * When omitted, sync is on automatically whenever there are 2+ grids.
   */
  syncScroll?: boolean;
}> = ({
  items,
  rowKey,
  refreshing,
  onRefresh,
  onPage,
  pageState,
  diffByConnection,
  badgeByConnection,
  compareLocked = false,
  rowSyncByConnection,
  fillAvailable = false,
  syncScroll,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => items.map(() => PANE_DEFAULT_PX));
  const [rowHeight, setRowHeight] = useState(PANE_DEFAULT_H_PX);
  const sizedForKey = useRef<string | null>(null);
  /** Peer scrollTop bus — pixel sync without React re-renders (avoids lag on fast scroll). */
  const scrollPeersRef = useRef(new Map<string, (scrollTop: number) => void>());
  const scrollSync = useMemo(
    () => ({
      register: (id: string, apply: (scrollTop: number) => void) => {
        scrollPeersRef.current.set(id, apply);
        return () => {
          scrollPeersRef.current.delete(id);
        };
      },
      broadcast: (sourceId: string, scrollTop: number) => {
        for (const [id, apply] of scrollPeersRef.current) {
          if (id === sourceId) continue;
          apply(scrollTop);
        }
      },
    }),
    []
  );
  /** Peer hover-row bus — highlights the same row index across side-by-side grids. */
  const hoverPeersRef = useRef(new Map<string, (rowIdx: number | null) => void>());
  const hoverSync = useMemo(
    () => ({
      register: (id: string, apply: (rowIdx: number | null) => void) => {
        hoverPeersRef.current.set(id, apply);
        return () => {
          hoverPeersRef.current.delete(id);
        };
      },
      broadcast: (sourceId: string, rowIdx: number | null) => {
        for (const [id, apply] of hoverPeersRef.current) {
          if (id === sourceId) continue;
          apply(rowIdx);
        }
      },
    }),
    []
  );

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || items.length === 0) return;

    const applyEqual = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      // Re-equalize when the row identity changes (new query / layout), not on every resize.
      if (sizedForKey.current === rowKey) return;
      sizedForKey.current = rowKey;
      setWidths(equalWidths(items.length, w));
      for (const apply of scrollPeersRef.current.values()) apply(0);
      for (const apply of hoverPeersRef.current.values()) apply(null);
    };

    applyEqual();
    const ro = new ResizeObserver(() => {
      // If user hasn't customized yet for this rowKey, keep filling.
      if (sizedForKey.current !== rowKey) applyEqual();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, rowKey]);

  useEffect(() => {
    setWidths((prev) => {
      if (prev.length === items.length) return prev;
      if (prev.length < items.length) {
        return [...prev, ...Array.from({ length: items.length - prev.length }, () => PANE_DEFAULT_PX)];
      }
      return prev.slice(0, items.length);
    });
  }, [items.length]);

  const startPaneResize = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[index] ?? PANE_DEFAULT_PX;
    bindAxisDrag('col-resize', (ev) => {
      const next = Math.max(PANE_MIN_PX, startW + (ev.clientX - startX));
      setWidths((prev) => {
        if (prev[index] === next) return prev;
        const copy = [...prev];
        copy[index] = next;
        return copy;
      });
    });
  }, [widths]);

  const startRowHeightResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = rowHeight;
      bindAxisDrag('row-resize', (ev) => {
        setRowHeight(Math.max(PANE_MIN_H_PX, startH + (ev.clientY - startY)));
      });
    },
    [rowHeight]
  );

  if (items.length === 0) return null;

  const multiGrid = items.filter((x) => x.kind === 'grid').length > 1;
  const enableScrollSync = multiGrid && (syncScroll ?? true);

  return (
    <div
      className={`flex flex-col min-w-0 ${fillAvailable ? 'flex-1 min-h-0 h-full' : ''}`}
      data-testid="sql-result-pane-row-wrap"
    >
      <div
        ref={rowRef}
        className={`flex overflow-x-auto overflow-y-hidden items-stretch pb-1 gap-0 ${
          fillAvailable ? 'flex-1 min-h-0' : ''
        }`}
        style={
          fillAvailable
            ? { minHeight: PANE_MIN_H_PX }
            : { height: rowHeight, minHeight: PANE_MIN_H_PX }
        }
        data-testid="sql-result-pane-row"
      >
        {items.map((item, i) => (
          <React.Fragment key={item.key}>
            <div
              className="flex flex-col min-h-0 shrink-0"
              style={{ width: widths[i] ?? PANE_DEFAULT_PX, minWidth: PANE_MIN_PX }}
            >
              <PaneBody
                item={item}
                refreshing={refreshing}
                onRefresh={onRefresh}
                onPage={onPage}
                pageState={pageState}
                scrollSyncId={enableScrollSync ? item.connectionId : undefined}
                scrollSync={enableScrollSync ? scrollSync : undefined}
                hoverSync={enableScrollSync ? hoverSync : undefined}
                diffSummary={diffByConnection?.[item.connectionId] ?? null}
                compareBadge={badgeByConnection?.[item.connectionId] ?? null}
                compareLocked={compareLocked}
                rowSync={rowSyncByConnection?.[item.connectionId]}
              />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize table ${i + 1}`}
              data-testid="sql-pane-resize"
              title="Drag to resize this table"
              onMouseDown={(e) => startPaneResize(i, e)}
              className="w-2 shrink-0 cursor-col-resize self-stretch mx-0.5 rounded-sm bg-slate-800 hover:bg-cyan-600/70 active:bg-cyan-500 flex items-center justify-center group"
            >
              <GripVertical
                className="w-3 h-3 text-cyan-400 group-hover:text-cyan-200 pointer-events-none"
                strokeWidth={SQL_ICON_STROKE}
              />
            </div>
          </React.Fragment>
        ))}
      </div>
      {!fillAvailable ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize result row height"
          data-testid="sql-result-row-height-resize"
          title="Drag to resize result grid height"
          onMouseDown={startRowHeightResize}
          className="h-1.5 shrink-0 cursor-row-resize bg-slate-800 hover:bg-cyan-500/40 active:bg-cyan-500/60 transition-colors rounded-sm"
        />
      ) : null}
    </div>
  );
};

/**
 * Vertical stack of full-width result panes (By cred layout). Each statement
 * gets its own height grip — no horizontal side-by-side.
 */
const StackedPaneColumn: React.FC<{
  items: PaneItem[];
  refreshing?: boolean;
  onRefresh?: (connectionId: string) => void;
  onPage?: Props['onPage'];
  pageState?: Props['pageState'];
  /** Fill parent height (fullscreen results modal) instead of fixed pane heights. */
  fillAvailable?: boolean;
}> = ({ items, refreshing, onRefresh, onPage, pageState, fillAvailable = false }) => {
  const [heights, setHeights] = useState<number[]>(() => items.map(() => PANE_DEFAULT_H_PX));

  useEffect(() => {
    setHeights((prev) => {
      if (prev.length === items.length) return prev;
      if (prev.length < items.length) {
        return [
          ...prev,
          ...Array.from({ length: items.length - prev.length }, () => PANE_DEFAULT_H_PX),
        ];
      }
      return prev.slice(0, items.length);
    });
  }, [items.length]);

  const startHeightResize = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = heights[index] ?? PANE_DEFAULT_H_PX;
    bindAxisDrag('row-resize', (ev) => {
      const next = Math.max(PANE_MIN_H_PX, startH + (ev.clientY - startY));
      setHeights((prev) => {
        if (prev[index] === next) return prev;
        const copy = [...prev];
        copy[index] = next;
        return copy;
      });
    });
  }, [heights]);

  if (items.length === 0) return null;

  return (
    <div
      className={`flex flex-col gap-3 min-w-0 ${fillAvailable ? 'flex-1 min-h-0 h-full' : ''}`}
      data-testid="sql-result-pane-stack"
    >
      {items.map((item, i) => (
        <div
          key={item.key}
          className={`flex flex-col min-w-0 ${fillAvailable ? 'flex-1 min-h-0' : ''}`}
          data-testid={`sql-result-stack-item-${i}`}
        >
          <div
            className="flex flex-col min-h-0 min-w-0"
            style={
              fillAvailable
                ? { minHeight: PANE_MIN_H_PX, flex: '1 1 0%' }
                : { height: heights[i] ?? PANE_DEFAULT_H_PX, minHeight: PANE_MIN_H_PX }
            }
          >
            <PaneBody
              item={item}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onPage={onPage}
              pageState={pageState}
            />
          </div>
          {!fillAvailable ? (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={`Resize Out table ${i + 1} height`}
              data-testid="sql-result-stack-height-resize"
              title="Drag to resize this result height"
              onMouseDown={(e) => startHeightResize(i, e)}
              className="h-1.5 shrink-0 cursor-row-resize bg-slate-800 hover:bg-cyan-500/40 active:bg-cyan-500/60 transition-colors rounded-sm mt-1"
            />
          ) : null}
        </div>
      ))}
    </div>
  );
};

/**
 * One statement row in side-by-side layout, with optional cross-connection
 * data compare (cell colors vs a baseline credential).
 */
const SideBySideStatementSection: React.FC<{
  statementIndex: number;
  outTestId: number;
  headerLabel: string;
  items: PaneItem[];
  refreshing?: boolean;
  onRefresh?: (connectionId?: string) => void;
  onPage?: Props['onPage'];
  pageState?: Props['pageState'];
}> = ({
  statementIndex,
  outTestId,
  headerLabel,
  items,
  refreshing,
  onRefresh,
  onPage,
  pageState,
}) => {
  const okGrids = useMemo(
    () =>
      items.filter(
        (x): x is Extract<PaneItem, { kind: 'grid' }> => x.kind === 'grid' && Boolean(x.result.ok)
      ),
    [items]
  );
  const canCompare = okGrids.length >= 2;
  /** Off by default — side-by-side shows plain grids until the user opts into Compare. */
  const [compareOn, setCompareOn] = useState(false);
  /** Skip createdAt / updatedBy / etc. — values differ across DBs even when rows match. */
  const [skipTriggerCols, setSkipTriggerCols] = useState(true);
  const [baselineId, setBaselineId] = useState<string>('');
  const [destId, setDestId] = useState<string>('');
  /** Shared with Data migrate — Compare aligns rows by these keys. */
  const [keyNames, setKeyNames] = useState<string[]>([]);
  /** Row Sync checkboxes — which differing keys to include in migrate. */
  const [selectedSyncKeys, setSelectedSyncKeys] = useState<Set<string>>(() => new Set());
  /** Full-window modal for more grid space (compare or plain results). */
  const [maximized, setMaximized] = useState(false);
  /** When Compare is on: sync vertical scroll + hover across all grids (default on). */
  const [syncScroll, setSyncScroll] = useState(true);

  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const connections = useSyncStore((s) => s.connections);

  useEffect(() => {
    if (!canCompare) return;
    if (!baselineId || !okGrids.some((g) => g.connectionId === baselineId)) {
      setBaselineId(okGrids[0]!.connectionId);
    }
  }, [canCompare, okGrids, baselineId]);

  const compareActive = canCompare && compareOn && Boolean(baselineId);

  useEffect(() => {
    if (!compareActive) return;
    const others = okGrids.filter((g) => g.connectionId !== baselineId);
    if (!destId || !others.some((g) => g.connectionId === destId)) {
      setDestId(others[0]?.connectionId ?? '');
    }
  }, [compareActive, okGrids, baselineId, destId]);

  const sourceGrid = okGrids.find((g) => g.connectionId === baselineId);
  const destGrid = okGrids.find((g) => g.connectionId === destId);

  const defaultKeys = useMemo(() => {
    if (!sourceGrid?.result.ok) return [] as string[];
    const cols = sourceGrid.result.columns;
    if (cols.length === 0) return [];
    const destCols =
      destGrid?.result.ok
        ? new Set(destGrid.result.columns.map((c) => c.toLowerCase()))
        : null;
    const inBoth = (name: string) =>
      !destCols || destCols.has(name.toLowerCase());

    const conn = connections.find((c) => c.id === sourceGrid.connectionId);
    const tables = schemaCache[sourceGrid.connectionId]?.tables;
    const editTarget = sourceGrid.statementSql
      ? singleTableForResultEdit(sourceGrid.statementSql, tables, conn?.schema)
      : { ok: false as const };
    const table = editTarget.ok ? editTarget.table : undefined;
    // Only PK/unique columns that are actually in THIS result (and the dest grid).
    const resolved = resolvePeekKeyColumns(table, cols)
      .filter((k) => k.resultIndex >= 0 && inBoth(k.name))
      .map((k) => k.name);
    if (resolved.length) return resolved;
    const idCol = cols.find((c) => c.toLowerCase() === 'id' && inBoth(c));
    if (idCol) return [idCol];
    // Name-only / projection SELECTs: use the first shared (or source) column.
    const shared = destCols ? cols.filter((c) => destCols.has(c.toLowerCase())) : cols;
    return shared.slice(0, 1);
  }, [sourceGrid, destGrid, connections, schemaCache]);

  const defaultKeysKey = defaultKeys.join('\0');
  const keyNamesKey = keyNames.join('\0');
  const sourceColsKey = sourceGrid?.result.ok ? sourceGrid.result.columns.join('\0') : '';

  useEffect(() => {
    if (!compareActive) return;
    const cols = sourceGrid?.result.ok ? sourceGrid.result.columns : null;
    const destCols =
      destGrid?.result.ok ? destGrid.result.columns : null;
    const present = (name: string) =>
      Boolean(
        cols?.some((c) => c.toLowerCase() === name.toLowerCase()) &&
          (!destCols ||
            destCols.some((c) => c.toLowerCase() === name.toLowerCase()))
      );

    if (keyNames.length === 0 && defaultKeys.length > 0) {
      setKeyNames(defaultKeys);
      return;
    }
    // Drop schema PK names that aren't in the SELECT (classic: ID missing,
    // only ATTRIBUTENAME selected) so Keys/Sync/counts actually work.
    if (keyNames.length > 0 && cols && keyNames.some((k) => !present(k))) {
      const kept = keyNames.filter(present);
      setKeyNames(kept.length > 0 ? kept : defaultKeys);
    }
  }, [
    compareActive,
    defaultKeysKey,
    keyNamesKey,
    sourceColsKey,
    defaultKeys,
    keyNames,
    sourceGrid,
    destGrid,
  ]);

  const triggerIgnoreColumns = useMemo(() => {
    if (!skipTriggerCols) return [] as string[];
    const names = new Set<string>();
    for (const g of okGrids) {
      if (!g.result.ok) continue;
      for (const c of detectTriggerManagedColumns(g.result.columns)) names.add(c);
    }
    return [...names];
  }, [skipTriggerCols, okGrids]);

  const triggerIgnoreKey = triggerIgnoreColumns.join('\0');
  const ignoreOpts = useMemo(
    () =>
      triggerIgnoreColumns.length > 0
        ? { ignoreColumns: triggerIgnoreColumns }
        : undefined,
    [triggerIgnoreColumns]
  );

  // Both branches are already stable references — `keyNames` is state and
  // `defaultKeys` is a memo — so this identity only changes when the keys
  // actually change. That is why the memo below can depend on it directly
  // instead of joining it into a string.
  const effectiveKeys = keyNames.length ? keyNames : defaultKeys;

  /**
   * Whether each side holds its whole result: page 1, no next page, nothing
   * truncated. The same test Data migrate applies before it will write.
   */
  const sourceComplete = Boolean(
    sourceGrid?.result.ok &&
      migrateGridsAreComplete({
        sourcePageIndex:
          pageState?.[`${sourceGrid.connectionId}:${statementIndex}`]?.pageIndex ?? 0,
        destPageIndex: 0,
        sourceHasMore: Boolean(sourceGrid.result.hasNext || sourceGrid.result.truncated),
        destHasMore: false,
      })
  );
  const destComplete = Boolean(
    destGrid?.result.ok &&
      migrateGridsAreComplete({
        sourcePageIndex: 0,
        destPageIndex: pageState?.[`${destGrid.connectionId}:${statementIndex}`]?.pageIndex ?? 0,
        sourceHasMore: false,
        destHasMore: Boolean(destGrid.result.hasNext || destGrid.result.truncated),
      })
  );

  /** Key-align source ↔ dest (same pair as Data migrate) for a friendly visual. */
  const keyAligned = useMemo(() => {
    if (!compareActive || !sourceGrid?.result.ok || !destGrid?.result.ok) return null;
    if (effectiveKeys.length === 0) return null;
    return alignResultGridsByKey(
      { columns: sourceGrid.result.columns, rows: sourceGrid.result.rows },
      { columns: destGrid.result.columns, rows: destGrid.result.rows },
      effectiveKeys,
      { ...ignoreOpts, leftComplete: sourceComplete, rightComplete: destComplete }
    );
  }, [compareActive, sourceGrid, destGrid, effectiveKeys, ignoreOpts, sourceComplete, destComplete]);

  const { diffByConnection, badgeByConnection, legendBits, displayItems } = useMemo(() => {
    const diffByConnection: Record<string, GridDiffSummary> = {};
    const badgeByConnection: Record<string, string> = {};
    const legendBits: string[] = [];
    let displayItems = items;

    if (!compareActive) {
      return { diffByConnection, badgeByConnection, legendBits, displayItems };
    }
    const baselineItem = okGrids.find((g) => g.connectionId === baselineId);
    if (!baselineItem || !baselineItem.result.ok) {
      return { diffByConnection, badgeByConnection, legendBits, displayItems };
    }

    const baselineGrid = {
      columns: baselineItem.result.columns,
      rows: baselineItem.result.rows,
    };
    badgeByConnection[baselineId] = 'Source';

    if (keyAligned && destId) {
      const destItem = okGrids.find((g) => g.connectionId === destId);
      if (destItem?.result.ok) {
        const destGridLike = {
          columns: destItem.result.columns,
          rows: destItem.result.rows,
        };
        const pair = compareKeyAlignedGrids(
          baselineGrid,
          destGridLike,
          keyAligned,
          ignoreOpts
        );
        diffByConnection[baselineId] = pair.baseline;
        diffByConnection[destId] = pair.other;

        const keyLabel = keyAligned.keyNames.join('+');
        legendBits.push(`aligned by ${keyLabel}`);
        // Migrate vocabulary: source-only → Add, dest-only → Delete, both differ → Edit.
        if (keyAligned.updateCount > 0) legendBits.push(`${keyAligned.updateCount} edit`);
        if (keyAligned.deleteCount > 0) legendBits.push(`${keyAligned.deleteCount} add`);
        if (keyAligned.insertCount > 0) legendBits.push(`${keyAligned.insertCount} delete`);
        if (keyAligned.matchCount > 0) legendBits.push(`${keyAligned.matchCount} match`);
        if (keyAligned.unresolvedCount > 0) {
          legendBits.push(
            `${keyAligned.unresolvedCount} on one side only — the other side's result is cut ` +
              'off, so they may be further down; raise Rows/page to classify them'
          );
        }
        if (keyAligned.duplicateKeys > 0) {
          legendBits.push(
            `⚠ ${keyAligned.duplicateKeys} duplicate key${keyAligned.duplicateKeys === 1 ? '' : 's'} skipped`
          );
        }
        if (triggerIgnoreColumns.length > 0) {
          legendBits.push(`skipping ${triggerIgnoreColumns.join(', ')}`);
        }
        if (
          keyAligned.updateCount === 0 &&
          keyAligned.insertCount === 0 &&
          keyAligned.deleteCount === 0
        ) {
          legendBits.push('grids match by key');
        }

        const sourceRole = comparePaneRole(baselineId, baselineId, destId, okGrids);
        const destRole = comparePaneRole(destId, baselineId, destId, okGrids);
        badgeByConnection[baselineId] =
          keyAligned.deleteCount + keyAligned.updateCount === 0
            ? `${sourceRole} → ${destRole}`
            : `${sourceRole} → ${destRole} · ${keyAligned.updateCount} edit · ${keyAligned.deleteCount} add`;
        badgeByConnection[destId] =
          keyAligned.insertCount + keyAligned.updateCount === 0
            ? `${destRole} · match`
            : `${destRole} · ${keyAligned.updateCount} edit · ${keyAligned.insertCount} delete`;

        displayItems = orderPanesSourceLeft(
          items.map((item) => {
            if (item.kind !== 'grid' || !item.result.ok) return item;
            if (item.connectionId === baselineId) {
              return {
                ...item,
                result: {
                  ...item.result,
                  rows: keyAligned.leftRows,
                  rowCount: keyAligned.leftRows.length,
                },
              };
            }
            if (item.connectionId === destId) {
              return {
                ...item,
                result: {
                  ...item.result,
                  rows: keyAligned.rightRows,
                  rowCount: keyAligned.rightRows.length,
                },
              };
            }
            return item;
          }),
          baselineId,
          destId
        );

        for (const g of okGrids) {
          if (g.connectionId === baselineId || g.connectionId === destId || !g.result.ok) {
            continue;
          }
          const pairIdx = compareResultGrids(
            baselineGrid,
            { columns: g.result.columns, rows: g.result.rows },
            ignoreOpts
          );
          diffByConnection[g.connectionId] = pairIdx.other;
          const n = pairIdx.other.cells.size;
          const role = comparePaneRole(g.connectionId, baselineId, destId, okGrids);
          badgeByConnection[g.connectionId] =
            n === 0 ? `${role} · match (by index)` : `${role} · ${n} differ (by index)`;
        }

        return { diffByConnection, badgeByConnection, legendBits, displayItems };
      }
    }

    let totalModified = 0;
    let totalMissing = 0;
    let totalExtra = 0;
    const missingCols = new Set<string>();
    const extraCols = new Set<string>();

    for (const g of okGrids) {
      if (g.connectionId === baselineId || !g.result.ok) continue;
      const pair = compareResultGrids(
        baselineGrid,
        { columns: g.result.columns, rows: g.result.rows },
        ignoreOpts
      );
      const prev = diffByConnection[baselineId];
      if (!prev) {
        diffByConnection[baselineId] = pair.baseline;
      } else {
        for (const [k, kind] of pair.baseline.cells) {
          if (!prev.cells.has(k)) {
            prev.cells.set(k, kind);
            if (kind === 'modified') prev.modified += 1;
            else if (kind === 'missing') prev.missing += 1;
            else prev.extra += 1;
          }
        }
        for (const c of pair.baseline.missingColumns) {
          if (!prev.missingColumns.includes(c)) prev.missingColumns.push(c);
        }
        for (const c of pair.baseline.extraColumns) {
          if (!prev.extraColumns.includes(c)) prev.extraColumns.push(c);
        }
      }
      diffByConnection[g.connectionId] = pair.other;
      const n = pair.other.cells.size;
      const role = comparePaneRole(g.connectionId, baselineId, destId, okGrids);
      badgeByConnection[g.connectionId] = n === 0 ? `${role} · match` : `${role} · ${n} differ`;
      totalModified += pair.other.modified;
      totalMissing += pair.other.missing + pair.baseline.missing;
      totalExtra += pair.other.extra;
      for (const c of pair.other.missingColumns) missingCols.add(c);
      for (const c of pair.other.extraColumns) extraCols.add(c);
    }

    const baseCells = diffByConnection[baselineId]?.cells.size ?? 0;
    const sourceRole = comparePaneRole(baselineId, baselineId, destId, okGrids);
    badgeByConnection[baselineId] =
      baseCells === 0 ? `${sourceRole}` : `${sourceRole} · ${baseCells} differ`;

    legendBits.push('aligned by row index (pick Keys below for friendlier match)');
    if (totalModified > 0) legendBits.push(`${totalModified} edit`);
    if (totalMissing > 0) legendBits.push(`${totalMissing} add`);
    if (totalExtra > 0) legendBits.push(`${totalExtra} delete`);
    if (missingCols.size > 0) {
      legendBits.push(`cols only in source: ${[...missingCols].join(', ')}`);
    }
    if (extraCols.size > 0) {
      legendBits.push(`cols only in target: ${[...extraCols].join(', ')}`);
    }
    if (triggerIgnoreColumns.length > 0) {
      legendBits.push(`skipping ${triggerIgnoreColumns.join(', ')}`);
    }
    if (totalModified === 0 && totalMissing === 0 && totalExtra === 0) {
      legendBits.push('grids match');
    }

    displayItems = orderPanesSourceLeft(items, baselineId, destId);

    return { diffByConnection, badgeByConnection, legendBits, displayItems };
  }, [
    compareActive,
    items,
    okGrids,
    baselineId,
    destId,
    keyAligned,
    ignoreOpts,
    triggerIgnoreColumns,
  ]);

  const rowSyncByConnection = useMemo(() => {
    if (!compareActive || !keyAligned || !destId) return undefined;
    return {
      [destId]: {
        isChecked: (rowIdx: number): boolean | null => {
          const op = keyAligned.rowOps[rowIdx];
          if (op === 'match' || op === 'unresolved') return null;
          const label = keyAligned.rowKeyLabels[rowIdx];
          if (!label) return false;
          return selectedSyncKeys.has(label);
        },
        onToggle: (rowIdx: number, checked: boolean) => {
          const label = keyAligned.rowKeyLabels[rowIdx];
          if (!label) return;
          setSelectedSyncKeys((prev) => {
            const next = new Set(prev);
            if (checked) next.add(label);
            else next.delete(label);
            return next;
          });
        },
      },
    };
  }, [compareActive, keyAligned, destId, selectedSyncKeys]);

  const insertServerBeamSample = () => {
    const sample = buildSampleBookmarks().find((b) => b.id === 'sample-server-beam-chunked');
    if (!sample) return;
    useSqlEditorStore.getState().setSql(sample.sql);
  };

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Yield to Data Peek, which now stacks above this overlay and is
        // opened from inside it by clicking a foreign-key cell. Both listen on
        // window, so without this one Escape closes the peek the reader just
        // opened *and* the results behind it. Mirrors how the peek itself
        // yields to its own row editor and write confirm.
        if (useSqlEditorStore.getState().dataPeek) return;
        e.preventDefault();
        setMaximized(false);
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [maximized]);

  const paneRowKey = `side-${statementIndex}-${displayItems.map((x) => x.key).join('|')}-${
    keyAligned ? `key-${effectiveKeys.join('+')}` : 'idx'
  }${maximized ? '-max' : ''}`;

  const exportAllGridsCsv = useCallback(() => {
    const grids = displayItems.filter(
      (x): x is Extract<PaneItem, { kind: 'grid' }> =>
        x.kind === 'grid' && Boolean(x.result.ok)
    );
    if (grids.length === 0) return;
    const panes = grids.map((g) => {
      const role =
        compareActive && baselineId
          ? comparePaneRole(g.connectionId, baselineId, destId, okGrids)
          : g.label;
      return {
        label: role,
        columns: g.result.ok ? g.result.columns : [],
        rows: g.result.ok ? g.result.rows : [],
      };
    });
    const meta =
      compareActive && keyAligned
        ? {
            leadingColumns: ['op', 'key'],
            leadingRows: keyAligned.rowOps.map((op, i) => [
              compareOpCsvLabel(op),
              keyAligned.rowKeyLabels[i] ?? '',
            ]),
          }
        : undefined;
    downloadMultiGridCsv(`compare-stmt-${statementIndex + 1}`, panes, meta);
  }, [
    displayItems,
    compareActive,
    baselineId,
    destId,
    okGrids,
    keyAligned,
    statementIndex,
  ]);

  const compareGrids = (fillAvailable: boolean) => (
    <ResizablePaneRow
      items={displayItems}
      rowKey={paneRowKey}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onPage={onPage}
      pageState={pageState}
      diffByConnection={compareActive ? diffByConnection : undefined}
      badgeByConnection={compareActive ? badgeByConnection : undefined}
      compareLocked={Boolean(compareActive && keyAligned)}
      rowSyncByConnection={rowSyncByConnection}
      fillAvailable={fillAvailable}
      syncScroll={compareActive ? syncScroll : undefined}
    />
  );

  const migrateBar =
    compareActive && sourceGrid?.result.ok && destGrid?.result.ok ? (
      <DataMigrateBar
        statementIndex={statementIndex}
        source={{
          connectionId: sourceGrid.connectionId,
          dialect: sourceGrid.dialect,
          label: sourceGrid.label,
          columns: sourceGrid.result.columns,
          rows: sourceGrid.result.rows,
          statementSql: sourceGrid.statementSql,
          pageIndex:
            pageState?.[`${sourceGrid.connectionId}:${statementIndex}`]?.pageIndex ?? 0,
          hasMore: Boolean(sourceGrid.result.hasNext || sourceGrid.result.truncated),
        }}
        dest={{
          connectionId: destGrid.connectionId,
          dialect: destGrid.dialect,
          label: destGrid.label,
          columns: destGrid.result.columns,
          rows: destGrid.result.rows,
          statementSql: destGrid.statementSql,
          pageIndex:
            pageState?.[`${destGrid.connectionId}:${statementIndex}`]?.pageIndex ?? 0,
          hasMore: Boolean(destGrid.result.hasNext || destGrid.result.truncated),
        }}
        ignoreColumns={triggerIgnoreColumns}
        keyNames={effectiveKeys}
        onKeyNamesChange={setKeyNames}
        selectedSyncKeys={selectedSyncKeys}
        onSelectedSyncKeysChange={setSelectedSyncKeys}
        onAfterMigrate={() => onRefresh?.(destGrid.connectionId)}
        onOpenServerBeamSample={insertServerBeamSample}
      />
    ) : null;

  const compareHint = compareActive ? (
    <p
      className="text-[11px] font-semibold text-slate-500 px-0.5"
      data-testid={`sql-result-compare-hint-${statementIndex}`}
    >
      Rows line up by <span className="text-sky-400/90">Keys</span> (check columns in Data migrate).
      Source is on the <span className="text-sky-400/90">left</span>; Target is on the right with a{' '}
      <span className="text-sky-400/90">Sync</span> column (on by default for differing rows).{' '}
      <span className="text-sky-400/90">Sync scroll</span> keeps all grids aligned;{' '}
      <span className="text-sky-400/90">CSV all</span> downloads every grid in one file. Migrate
      needs Add / Edit / Delete checked (enabled when diffs exist) plus Sync rows. Cap: 500 ops —
      larger sets use Server Beam.
    </p>
  ) : null;

  return (
    <section
      className="flex flex-col gap-2 min-w-0"
      data-testid={`sql-result-stmt-${outTestId}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 shrink-0">
        <div className="text-xs font-bold text-slate-200 font-mono tracking-tight min-w-0 truncate">
          {headerLabel}
        </div>
        {canCompare && (
          <div
            className="flex flex-wrap items-center gap-2.5 text-xs font-bold text-slate-300 rounded-lg border border-sky-500/30 bg-gradient-to-r from-slate-900/80 via-slate-950/60 to-sky-950/40 px-2.5 py-1.5"
            data-testid={`sql-result-compare-toolbar-${statementIndex}`}
          >
            <label className="flex items-center gap-1.5 cursor-pointer select-none text-sky-200">
              <input
                type="checkbox"
                data-testid={`sql-result-compare-toggle-${statementIndex}`}
                checked={compareOn}
                onChange={(e) => setCompareOn(e.target.checked)}
                className="rounded border-sky-500/60 accent-sky-500"
              />
              <GitCompare className="w-4 h-4 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
              Compare data
            </label>
            {!compareOn && (
              <span className="text-slate-500 font-semibold text-[11px]">
                Turn on to highlight diffs and choose Add / Edit / Delete
              </span>
            )}
            {compareOn && (
              <label className="flex items-center gap-1.5 font-semibold">
                <span className="text-slate-400">Source</span>
                <select
                  data-testid={`sql-result-compare-baseline-${statementIndex}`}
                  value={baselineId}
                  onChange={(e) => setBaselineId(e.target.value)}
                  className="bg-slate-900 border border-slate-600 rounded-md px-2 py-0.5 text-xs font-bold text-slate-100 max-w-[12rem]"
                >
                  {okGrids.map((g) => (
                    <option key={g.connectionId} value={g.connectionId}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {compareOn && (
              <label
                className="flex items-center gap-1.5 cursor-pointer select-none font-semibold text-slate-300"
                title="Ignore trigger/audit columns (createdAt, updatedBy, …) in Compare highlights and Data migrate. Destinations often fill these differently."
              >
                <input
                  type="checkbox"
                  data-testid={`sql-result-compare-skip-trigger-${statementIndex}`}
                  checked={skipTriggerCols}
                  onChange={(e) => setSkipTriggerCols(e.target.checked)}
                  className="rounded border-slate-600 accent-sky-500"
                />
                Skip trigger cols
              </label>
            )}
            {compareActive && (
              <label
                className="flex items-center gap-1.5 cursor-pointer select-none font-semibold text-slate-300"
                title="Keep vertical scroll and hovered row in sync across all compare grids"
              >
                <input
                  type="checkbox"
                  data-testid={`sql-result-compare-sync-scroll-${statementIndex}`}
                  checked={syncScroll}
                  onChange={(e) => setSyncScroll(e.target.checked)}
                  className="rounded border-slate-600 accent-sky-500"
                />
                Sync scroll
              </label>
            )}
            {compareActive && (
              <button
                type="button"
                data-testid={`sql-result-compare-export-csv-${statementIndex}`}
                title="Export all compare grids as one CSV (columns prefixed by Source / Target)"
                onClick={exportAllGridsCsv}
                className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-950/40 px-2 py-0.5 text-sky-200 hover:bg-sky-900/50 font-semibold"
              >
                <Download className="w-3.5 h-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
                CSV all
              </button>
            )}
            {compareActive && okGrids.length > 2 && (
              <label className="flex items-center gap-1.5 font-semibold">
                <span className="text-slate-400">Destination</span>
                <select
                  data-testid={`sql-result-compare-dest-${statementIndex}`}
                  value={destId}
                  onChange={(e) => setDestId(e.target.value)}
                  className="bg-slate-900 border border-slate-600 rounded-md px-2 py-0.5 text-xs font-bold text-slate-100 max-w-[12rem]"
                >
                  {okGrids
                    .filter((g) => g.connectionId !== baselineId)
                    .map((g) => (
                      <option key={g.connectionId} value={g.connectionId}>
                        {g.label}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {compareActive && (
              <span
                className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-slate-400"
                data-testid={`sql-result-compare-legend-${statementIndex}`}
              >
                <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-950/50 px-1.5 py-0.5 text-amber-200">
                  <span className="w-2 h-2 rounded-sm bg-amber-500" /> edit
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-950/50 px-1.5 py-0.5 text-rose-200">
                  <span className="w-2 h-2 rounded-sm bg-rose-500" /> add
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-950/50 px-1.5 py-0.5 text-emerald-200">
                  <span className="w-2 h-2 rounded-sm bg-emerald-500" /> delete
                </span>
                <span
                  className="text-slate-500 font-semibold truncate max-w-[28rem]"
                  title={legendBits.join(' · ')}
                >
                  {legendBits.join(' · ')}
                </span>
              </span>
            )}
            {compareActive && !maximized && (
              <button
                type="button"
                data-testid={`sql-result-compare-maximize-${statementIndex}`}
                title="Maximize compare"
                aria-label="Maximize compare"
                onClick={() => setMaximized(true)}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-950/50 px-2 py-0.5 text-sky-200 hover:bg-sky-900/60"
              >
                <Maximize2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                Maximize
              </button>
            )}
          </div>
        )}
        {!compareActive && displayItems.some((x) => x.kind === 'grid') && !maximized && (
          <button
            type="button"
            data-testid={`sql-result-maximize-${statementIndex}`}
            title="Maximize results"
            aria-label="Maximize results"
            onClick={() => setMaximized(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-900/70 px-2 py-0.5 text-[11px] font-bold text-slate-300 hover:border-sky-500/40 hover:text-sky-200"
          >
            <Maximize2 className="w-3.5 h-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
            Maximize
          </button>
        )}
      </header>
      {!maximized && (
        <>
          {migrateBar}
          {compareGrids(false)}
          {compareHint}
        </>
      )}
      {maximized && (
        <p
          className="rounded-md border border-sky-500/30 bg-sky-950/30 px-2.5 py-2 text-[11px] font-semibold text-sky-200/90"
          data-testid={
            compareActive
              ? `sql-result-compare-maximized-hint-${statementIndex}`
              : `sql-result-maximized-hint-${statementIndex}`
          }
        >
          {compareActive ? 'Compare' : 'Results'} is open fullscreen — use{' '}
          <span className="text-sky-100">Close</span> or <span className="text-sky-100">Esc</span> to
          return.
        </p>
      )}
      {maximized &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex flex-col bg-slate-950/80 p-2 sm:p-3"
            data-testid={
              compareActive
                ? `sql-result-compare-modal-${statementIndex}`
                : `sql-result-modal-${statementIndex}`
            }
            role="dialog"
            aria-modal="true"
            aria-label={compareActive ? 'Compare data fullscreen' : 'Results fullscreen'}
          >
            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-sky-500/35 bg-slate-900 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2">
                {compareActive ? (
                  <GitCompare className="h-4 w-4 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
                ) : (
                  <Maximize2 className="h-4 w-4 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
                )}
                <span className="text-sm font-bold text-sky-200">
                  {compareActive ? 'Compare data' : 'Results'}
                </span>
                <span className="truncate text-xs font-semibold text-slate-400">{headerLabel}</span>
                {compareActive && (
                  <label
                    className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-semibold text-slate-300"
                    title="Keep vertical scroll and hovered row in sync across all compare grids"
                  >
                    <input
                      type="checkbox"
                      data-testid={`sql-result-compare-sync-scroll-modal-${statementIndex}`}
                      checked={syncScroll}
                      onChange={(e) => setSyncScroll(e.target.checked)}
                      className="rounded border-slate-600 accent-sky-500"
                    />
                    Sync scroll
                  </label>
                )}
                {compareActive && (
                  <button
                    type="button"
                    data-testid={`sql-result-compare-export-csv-modal-${statementIndex}`}
                    title="Export all compare grids as one CSV"
                    onClick={exportAllGridsCsv}
                    className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-950/40 px-2 py-0.5 text-xs font-bold text-sky-200 hover:bg-sky-900/50"
                  >
                    <Download className="h-3.5 w-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
                    CSV all
                  </button>
                )}
                <button
                  type="button"
                  data-testid={
                    compareActive
                      ? `sql-result-compare-close-${statementIndex}`
                      : `sql-result-close-${statementIndex}`
                  }
                  title="Close (Esc)"
                  aria-label={compareActive ? 'Close maximized compare' : 'Close maximized results'}
                  onClick={() => setMaximized(false)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-950/60 px-2.5 py-1 text-xs font-bold text-slate-200 hover:bg-slate-800"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={SQL_ICON_STROKE} />
                  Close
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2 sm:p-3">
                {migrateBar}
                <div className="flex min-h-0 flex-1 flex-col">{compareGrids(true)}</div>
                {compareHint}
              </div>
            </div>
          </div>,
          document.body
        )}
    </section>
  );
};

/**
 * One credential block in By-cred layout, with optional fullscreen maximize.
 */
const CredentialResultsSection: React.FC<{
  run: CredentialRun;
  items: PaneItem[];
  refreshing?: boolean;
  onRefresh?: (connectionId?: string) => void;
  onPage?: Props['onPage'];
  pageState?: Props['pageState'];
}> = ({ run, items, refreshing, onRefresh, onPage, pageState }) => {
  const [maximized, setMaximized] = useState(false);
  const hasGrids = run.status === 'done' && items.length > 0;

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Yield to Data Peek, which now stacks above this overlay and is
        // opened from inside it by clicking a foreign-key cell. Both listen on
        // window, so without this one Escape closes the peek the reader just
        // opened *and* the results behind it. Mirrors how the peek itself
        // yields to its own row editor and write confirm.
        if (useSqlEditorStore.getState().dataPeek) return;
        e.preventDefault();
        setMaximized(false);
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [maximized]);

  useEffect(() => {
    if (!hasGrids) setMaximized(false);
  }, [hasGrids]);

  const grids = (
    <StackedPaneColumn
      items={items}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onPage={onPage}
      pageState={pageState}
      fillAvailable={maximized}
    />
  );

  return (
    <section className="flex flex-col gap-2 min-w-0" data-testid={`sql-result-cred-${run.connectionId}`}>
      <header className="flex items-center gap-2 text-xs font-bold text-slate-200 shrink-0">
        <Database className="w-3.5 h-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
        {run.name}
        <span className="text-[10px] font-semibold text-slate-500 uppercase">[{run.dialect}]</span>
        {run.status === 'running' && (
          <Loader2
            data-testid="sql-results-running"
            className="w-3.5 h-3.5 animate-spin text-cyan-400"
            strokeWidth={SQL_ICON_STROKE}
          />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {hasGrids && !maximized && (
            <button
              type="button"
              data-testid={`sql-result-cred-maximize-${run.connectionId}`}
              title="Maximize results"
              aria-label="Maximize results"
              onClick={() => setMaximized(true)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-900/70 px-2 py-0.5 text-[10px] font-bold text-slate-300 hover:border-sky-500/40 hover:text-sky-200"
            >
              <Maximize2 className="w-3.5 h-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
              Maximize
            </button>
          )}
          {onRefresh && run.status !== 'running' && (
            <button
              type="button"
              data-testid="sql-cred-refresh"
              title="Refresh this server"
              disabled={refreshing}
              onClick={() => onRefresh(run.connectionId)}
              className="flex items-center gap-0.5 text-[10px] font-semibold text-slate-500 hover:text-cyan-400 transition disabled:opacity-40"
            >
              <RefreshCw
                className={`w-3 h-3 text-cyan-400 ${refreshing ? 'animate-spin' : ''}`}
                strokeWidth={SQL_ICON_STROKE}
              />{' '}
              Refresh
            </button>
          )}
        </div>
      </header>

      {run.status === 'error' && (
        <div className="flex items-start gap-2 text-xs text-rose-400 bg-rose-950/40 border border-rose-500/20 rounded-md px-3 py-2 max-w-2xl">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" strokeWidth={SQL_ICON_STROKE} />
          <span className="break-all">{run.error}</span>
        </div>
      )}

      {hasGrids && !maximized && grids}

      {maximized && (
        <p
          className="rounded-md border border-sky-500/30 bg-sky-950/30 px-2.5 py-2 text-[11px] font-semibold text-sky-200/90"
          data-testid={`sql-result-cred-maximized-hint-${run.connectionId}`}
        >
          Results are open fullscreen — use <span className="text-sky-100">Close</span> or{' '}
          <span className="text-sky-100">Esc</span> to return.
        </p>
      )}

      {maximized &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex flex-col bg-slate-950/80 p-2 sm:p-3"
            data-testid={`sql-result-cred-modal-${run.connectionId}`}
            role="dialog"
            aria-modal="true"
            aria-label={`Results fullscreen — ${run.name}`}
          >
            <div
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-sky-500/35 bg-slate-900 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2">
                <Database className="h-4 w-4 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
                <span className="text-sm font-bold text-sky-200">{run.name}</span>
                <span className="text-[10px] font-semibold text-slate-500 uppercase">
                  [{run.dialect}]
                </span>
                <button
                  type="button"
                  data-testid={`sql-result-cred-close-${run.connectionId}`}
                  title="Close (Esc)"
                  aria-label="Close maximized results"
                  onClick={() => setMaximized(false)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-950/60 px-2.5 py-1 text-xs font-bold text-slate-200 hover:bg-slate-800"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={SQL_ICON_STROKE} />
                  Close
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2 sm:p-3">{grids}</div>
            </div>
          </div>,
          document.body
        )}
    </section>
  );
};

/**
 * Results for one tab. `byCredential` stacks credentials, and statement grids
 * under each credential are also stacked vertically (not side by side).
 * `sideBySide` stacks statements with credential grids as columns.
 */
const ResultsPanelView: React.FC<Props> = ({
  runs,
  statements,
  statementIndices,
  layout,
  refreshing,
  warnings,
  onRefresh,
  onPage,
  pageState,
}) => {
  const outNumber = (i: number) => (statementIndices?.[i] ?? i) + 1;
  const outTestId = (i: number) => statementIndices?.[i] ?? i;
  if (runs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-600 text-xs gap-2 px-6 text-center">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
          Run a query to see results here — one section per checked credential.
        </div>
        <p className="max-w-md text-[11px] text-slate-500 leading-relaxed" data-testid="sql-results-peek-instruction">
          Tip: after Run, single-table SELECT grids can edit rows (when the key columns are in the result).
          Underlined rust foreign-key cells open <span className="text-slate-400">Data Peek</span>.
          Or Cmd/Ctrl-click a table in Schema to peek without writing SQL.
        </p>
      </div>
    );
  }

  const warningBanner =
    warnings && warnings.length > 0 ? (
      <div
        className="mx-4 mt-3 flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-950/40 px-3 py-2 text-xs text-amber-200/90"
        data-testid="sql-results-warnings"
        role="status"
      >
        {warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" strokeWidth={SQL_ICON_STROKE} />
            <span className="break-all">{w}</span>
          </div>
        ))}
      </div>
    ) : null;

  if (layout === 'sideBySide') {
    const stmtCount = sideBySideSectionCount(statements.length, runs);
    return (
      <div className="flex-1 overflow-y-auto flex flex-col gap-4 pb-4" data-testid="sql-results-side-by-side">
        {warningBanner}
        <div className="flex flex-col gap-4 px-4 pt-1">
        {Array.from({ length: stmtCount }, (_, i) => {
          const items: PaneItem[] = [];
          for (const run of runs) {
            if (run.status === 'running') {
              items.push({
                key: `${run.connectionId}-run`,
                kind: 'running',
                label: credentialLabel(run),
                connectionId: run.connectionId,
              });
              continue;
            }
            if (run.status === 'error') {
              items.push({
                key: `${run.connectionId}-err`,
                kind: 'error',
                label: credentialLabel(run),
                error: run.error ?? 'Error',
                connectionId: run.connectionId,
              });
              continue;
            }
            const result = run.results?.[i];
            if (!result) continue;
            items.push({
              key: `${run.connectionId}-q${i}`,
              kind: 'grid',
              result,
              label: credentialLabel(run),
              exportName: `${run.name}-q${i + 1}`,
              connectionId: run.connectionId,
              dialect: run.dialect,
              statementIndex: i,
              statementSql: statements[i],
            });
          }
          return (
            <SideBySideStatementSection
              key={i}
              statementIndex={i}
              outTestId={outTestId(i)}
              headerLabel={statementLabel(statements[i], outNumber(i))}
              items={items}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onPage={onPage}
              pageState={pageState}
            />
          );
        })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto flex flex-col gap-4 pb-4" data-testid="sql-results-by-credential">
      {warningBanner}
      <div className="flex flex-col gap-4 px-4 pt-1">
      {runs.map((run) => {
        const items: PaneItem[] =
          run.status === 'done' && run.results
            ? run.results.map((result, i) => ({
                key: `${run.connectionId}-q${i}`,
                kind: 'grid' as const,
                result,
                // These items only exist for a finished run, so a missing
                // statement is a gap in the record — not work still in flight.
                // Keep the bare label rather than claiming it is running.
                label: statementLabel(statements[i] ?? '', outNumber(i)),
                exportName: `${run.name}-q${i + 1}`,
                connectionId: run.connectionId,
                dialect: run.dialect,
                statementIndex: i,
                statementSql: statements[i],
              }))
            : [];

        return (
          <CredentialResultsSection
            key={run.connectionId}
            run={run}
            items={items}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onPage={onPage}
            pageState={pageState}
          />
        );
      })}
      </div>
    </div>
  );
};

/**
 * Memoised: typing in the editor re-rendered every visible results grid on
 * each keystroke, though nothing in them had changed. The editor passes stable
 * props, so the results now render only when they do.
 */
export const ResultsPanel = React.memo(ResultsPanelView);
