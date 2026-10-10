/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Quick data peek: Cmd/Ctrl-click a table in the schema explorer to see its
 * rows without writing a query. Foreign-key cells are links — each FK column
 * can open its own panel below (siblings stack; same column replaces).
 * Each panel has WHERE / ORDER BY / LIMIT (auto-applies on edit/blur) and a drag resize handle.
 * FK drill panels show a Key chip (and All rows) to drop the bound key and fetch the whole table.
 * Editable tables (with PK) support add / edit / clone / delete; Safe mode shows WriteConfirmDialog.
 * Query-result grids reuse the same CRUD hook for single-table SELECTs.
 * Editor result grids can also open this peek via rust FK cell clicks.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, Loader2, X } from 'lucide-react';
import { useSqlEditorStore, type DataPeekEntry } from '@/features/sql-editor/state/useSqlEditorStore';
import {
  foreignKeyLinksFor,
  fkDrillTableName,
  fkKey,
  inboundForeignKeysFor,
  peekBaseFilterLabel,
} from '@/shared/lib/tablePreview';
import type { InboundForeignKey } from '@/shared/lib/tablePreview';
import { DataGrid } from './DataGrid';
import { usePeekGridCrud } from './usePeekGridCrud';
import { PeekInsight } from './PeekInsight';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import type { TableSchema } from '@/shared/lib/types';
import { useSyncStore } from '@/features/compare';

const DEFAULT_HEIGHT_ROOT = 360;
/** FK drill panels stack full-width; main body scrolls when many are open. */
const DEFAULT_HEIGHT_DRILL = 320;
const MIN_PANEL_HEIGHT = 200;
const MAX_PANEL_HEIGHT = 900;

/**
 * Quick data peek UI (see file header).
 */
const PeekFilterBar: React.FC<{
  entry: DataPeekEntry;
  disabled?: boolean;
}> = ({ entry, disabled }) => {
  const updateDataPeekFilters = useSqlEditorStore((s) => s.updateDataPeekFilters);
  const clearDataPeekBaseFilter = useSqlEditorStore((s) => s.clearDataPeekBaseFilter);
  const [where, setWhere] = useState(entry.whereClause);
  const [orderBy, setOrderBy] = useState(entry.orderByClause);
  const [limit, setLimit] = useState(String(entry.limit));
  // Refs so Apply / debounce always read the latest draft (Enter right after
  // clear must not re-submit the previous WHERE).
  const whereRef = useRef(where);
  const orderByRef = useRef(orderBy);
  const limitRef = useRef(limit);
  whereRef.current = where;
  orderByRef.current = orderBy;
  limitRef.current = limit;
  const baseFilter = peekBaseFilterLabel(entry.title, entry.tableName, entry.baseParams);

  useEffect(() => {
    setWhere(entry.whereClause);
    setOrderBy(entry.orderByClause);
    setLimit(String(entry.limit));
  }, [entry.id, entry.whereClause, entry.orderByClause, entry.limit]);

  const apply = useCallback(() => {
    const draftWhere = whereRef.current;
    const draftOrderBy = orderByRef.current;
    const draftLimit = limitRef.current;
    const parsed = Number.parseInt(draftLimit, 10);
    const nextLimit = Number.isFinite(parsed) ? parsed : entry.limit;
    // Skip no-op applies (e.g. blur after an already-committed clear).
    if (
      draftWhere === entry.whereClause &&
      draftOrderBy === entry.orderByClause &&
      nextLimit === entry.limit
    ) {
      return;
    }
    void updateDataPeekFilters(entry.id, {
      whereClause: draftWhere,
      orderByClause: draftOrderBy,
      limit: nextLimit,
    });
  }, [
    entry.id,
    entry.limit,
    entry.whereClause,
    entry.orderByClause,
    updateDataPeekFilters,
  ]);

  // Debounced auto-apply so clearing WHERE / editing filters refreshes the
  // grid without requiring a manual Apply click.
  useEffect(() => {
    const parsed = Number.parseInt(limit, 10);
    const nextLimit = Number.isFinite(parsed) ? parsed : entry.limit;
    if (
      where === entry.whereClause &&
      orderBy === entry.orderByClause &&
      nextLimit === entry.limit
    ) {
      return;
    }
    // Clearing WHERE should refresh promptly; other edits can wait briefly.
    const delay = where.trim() === '' && entry.whereClause.trim() !== '' ? 120 : 450;
    const timer = window.setTimeout(() => {
      apply();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    where,
    orderBy,
    limit,
    entry.whereClause,
    entry.orderByClause,
    entry.limit,
    apply,
  ]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 mb-1.5 shrink-0 px-0.5"
      data-testid={`data-peek-filters-${entry.id}`}
    >
      {baseFilter && (
        <div
          className="flex items-center gap-1 min-w-0 basis-full"
          data-testid={`data-peek-base-filter-${entry.id}`}
        >
          <span className="text-xs font-bold uppercase tracking-wide text-slate-400 shrink-0">
            Key
          </span>
          <span
            className="inline-flex items-center gap-1 min-w-0 max-w-full rounded border border-amber-800/60 bg-amber-950/30 px-1.5 py-0.5"
            title="FK drill filter — clear to query the whole table"
          >
            <span className="truncate text-sm font-mono font-bold text-amber-100/90">{baseFilter}</span>
            <button
              type="button"
              data-testid={`data-peek-base-filter-clear-${entry.id}`}
              title="Clear key filter and fetch all rows"
              aria-label={`Clear filter ${baseFilter}`}
              disabled={disabled}
              onClick={() => void clearDataPeekBaseFilter(entry.id)}
              className="shrink-0 p-0.5 rounded text-amber-200/70 hover:text-amber-50 hover:bg-amber-900/40 disabled:opacity-40"
            >
              <X className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
            </button>
          </span>
        </div>
      )}
      <label className="flex items-center gap-1 min-w-0 flex-[2] basis-[12rem]">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400 shrink-0">
          Where
        </span>
        <span className="relative flex-1 min-w-0">
          <input
            type="text"
            data-testid={`data-peek-where-${entry.id}`}
            placeholder="e.g. ARCHIVED = false — or clear to fetch all"
            value={where}
            disabled={disabled}
            onChange={(e) => setWhere(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => apply()}
            className="w-full min-w-0 rounded border border-slate-700 bg-slate-950 px-1.5 py-1.5 pr-7 text-sm font-mono font-semibold text-slate-100 placeholder:text-slate-600 focus:outline-none accent-focus"
          />
          {where.trim() !== '' && (
            <button
              type="button"
              data-testid={`data-peek-where-clear-${entry.id}`}
              title="Clear WHERE and fetch all rows"
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setWhere('');
                whereRef.current = '';
                void updateDataPeekFilters(entry.id, {
                  whereClause: '',
                  orderByClause: orderByRef.current,
                  limit: (() => {
                    const parsed = Number.parseInt(limitRef.current, 10);
                    return Number.isFinite(parsed) ? parsed : entry.limit;
                  })(),
                });
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <X className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
            </button>
          )}
        </span>
      </label>
      <label className="flex items-center gap-1 min-w-0 flex-1 basis-[9rem]">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400 shrink-0">
          Order by
        </span>
        <input
          type="text"
          data-testid={`data-peek-order-${entry.id}`}
          placeholder="ID DESC"
          value={orderBy}
          disabled={disabled}
          onChange={(e) => setOrderBy(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => apply()}
          className="w-full min-w-0 rounded border border-slate-700 bg-slate-950 px-1.5 py-1.5 text-sm font-mono font-semibold text-slate-100 placeholder:text-slate-600 focus:outline-none accent-focus"
        />
      </label>
      <label className="flex items-center gap-1 shrink-0">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">
          Limit
        </span>
        <input
          type="number"
          min={1}
          max={5000}
          data-testid={`data-peek-limit-${entry.id}`}
          value={limit}
          disabled={disabled}
          onChange={(e) => setLimit(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => apply()}
          className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1.5 text-sm font-mono font-bold text-slate-100 focus:outline-none accent-focus"
        />
      </label>
      <button
        type="button"
        data-testid={`data-peek-apply-${entry.id}`}
        disabled={disabled}
        onClick={apply}
        className="shrink-0 rounded border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-sm font-bold text-slate-100 hover:bg-slate-700 disabled:opacity-50"
      >
        Apply
      </button>
    </div>
  );
};

const PeekResizeHandle: React.FC<{
  entryId: string;
  heightPx: number;
}> = ({ entryId, heightPx }) => {
  const setDataPeekPanelHeight = useSqlEditorStore((s) => s.setDataPeekPanelHeight);
  const startY = useRef(0);
  const startH = useRef(heightPx);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    startY.current = e.clientY;
    startH.current = heightPx;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(
        MAX_PANEL_HEIGHT,
        Math.max(MIN_PANEL_HEIGHT, startH.current + (ev.clientY - startY.current))
      );
      setDataPeekPanelHeight(entryId, next);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize data peek panel"
      data-testid={`data-peek-resize-${entryId}`}
      onPointerDown={onPointerDown}
      className="h-2.5 shrink-0 cursor-ns-resize flex items-center justify-center group"
      title="Drag to resize"
    >
      <span className="block h-1 w-12 rounded-full bg-slate-600 group-hover:bg-cyan-500" />
    </div>
  );
};

const PeekGrid: React.FC<{
  entry: DataPeekEntry;
  tables: TableSchema[] | undefined;
  dialect: string;
  connectionId: string;
  /** Root table vs FK drill — drills get a taller default for usable grids. */
  variant: 'root' | 'drill';
  showFkHint: boolean;
  dragIndex: number;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDragLeave: (index: number) => void;
  onDrop: (fromIndex: number, toIndex: number) => void;
  onDragEnd: () => void;
  onClose?: () => void;
  /** True when a row editor / write confirm is open in any peek panel. */
  onOverlayOpenChange?: (open: boolean) => void;
}> = ({
  entry,
  tables,
  dialect,
  connectionId,
  variant,
  showFkHint,
  dragIndex,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onClose,
  onOverlayOpenChange,
}) => {
  const drillDataPeek = useSqlEditorStore((s) => s.drillDataPeek);
  const drillDataPeekInbound = useSqlEditorStore((s) => s.drillDataPeekInbound);
  const pageDataPeekEntry = useSqlEditorStore((s) => s.pageDataPeekEntry);
  const runDataPeekEntry = useSqlEditorStore((s) => s.runDataPeekEntry);
  const clearDataPeekBaseFilter = useSqlEditorStore((s) => s.clearDataPeekBaseFilter);
  const connectionSchema = useSyncStore(
    (s) => s.connections.find((c) => c.id === connectionId)?.schema
  );
  const [tab, setTab] = useState<'rows' | 'insight'>('rows');
  useEffect(() => {
    setTab('rows');
  }, [entry.id]);

  const table = useMemo(() => {
    if (!tables) return undefined;
    const wanted = entry.tableName.toLowerCase();
    const exact = tables.find((t) => t.name.toLowerCase() === wanted);
    if (exact) return exact;
    // A cross-schema FK drill sets tableName to `inventory.products`. Falling
    // back to a bare `products` in the connection schema would hand row-edit
    // the wrong PK/columns while the SELECT correctly hit the parent — the
    // same wrong-table class the qualify fix closes, just on the write side.
    // A qualified name still has to find its table, or the panel loses its
    // foreign keys: an FK drill sets tableName to `demo_a.customers` while the
    // catalog caches it bare as `customers`, so giving up here meant the second
    // peek in a chain showed no reference keys at all.
    //
    // The qualifier is checked rather than dropped. Matching a bare cache entry
    // for `inventory.products` while connected to `public` would hand row-edit
    // the wrong table's PK — the case the previous `return undefined` was
    // guarding, and the reason this compares instead of stripping.
    const dot = wanted.lastIndexOf('.');
    if (dot > 0) {
      const qualifier = wanted.slice(0, dot);
      const bare = wanted.slice(dot + 1);
      // Only enforced when the connection records a schema. On engines that do
      // not, demanding a match would reject every qualified name and lose the
      // keys for everyone — worse than the wrong-table risk it guards, which
      // needs two schemas holding the same table name to arise at all.
      const known = (connectionSchema ?? '').trim().toLowerCase();
      if (known && qualifier !== known) return undefined;
      return tables.find((t) => t.name.toLowerCase().replace(/^.*\./, '') === bare);
    }
    return tables.find((t) => t.name.toLowerCase().replace(/^.*\./, '') === wanted);
  }, [tables, entry.tableName, connectionSchema]);

  const links = useMemo(
    () => (entry.result?.ok ? foreignKeyLinksFor(table, entry.result.columns) : []),
    [table, entry.result]
  );

  const linkColumns = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of links) map.set(l.columnIndex, fkDrillTableName(l.fk));
    return map;
  }, [links]);

  /**
   * The other direction of the relation: children that point at this table,
   * paired with the result columns holding the parent values they match on.
   * An FK whose parent columns are not all in the grid is dropped — a partial
   * key would build a WHERE that matches the wrong child rows.
   */
  const inboundLinks = useMemo(() => {
    if (!entry.result?.ok) return [];
    const cols = entry.result.columns;
    const indexOf = (n: string) => cols.findIndex((c) => c.toLowerCase() === n.toLowerCase());
    return inboundForeignKeysFor(tables, entry.tableName, connectionSchema)
      .map((child) => {
        const valueIndexes = (child.fk.referencedColumns ?? []).map(indexOf);
        if (valueIndexes.length === 0 || valueIndexes.some((i) => i < 0)) return null;
        return { child, valueIndexes };
      })
      .filter((x): x is { child: InboundForeignKey; valueIndexes: number[] } => x !== null);
  }, [tables, entry.tableName, entry.result, connectionSchema]);

  const onLinkClick = useCallback(
    (colIdx: number, rowIdx: number) => {
      const link = links.find((l) => l.columnIndex === colIdx);
      if (!link || !entry.result?.ok) return;
      const row = entry.result.rows[rowIdx];
      if (!row) return;
      void drillDataPeek(entry.id, link.fk, link.valueIndexes.map((i) => row[i]));
    },
    [links, entry, drillDataPeek]
  );

  const heightPx =
    entry.panelHeightPx ?? (variant === 'drill' ? DEFAULT_HEIGHT_DRILL : DEFAULT_HEIGHT_ROOT);

  const afterWrite = useCallback(() => runDataPeekEntry(entry.id), [runDataPeekEntry, entry.id]);
  const columns = entry.result?.ok ? entry.result.columns : [];
  const rows = entry.result?.ok ? entry.result.rows : [];

  const crud = usePeekGridCrud({
    connectionId,
    dialect,
    tableName: entry.tableName,
    table,
    columns,
    rows,
    resultOk: Boolean(entry.result?.ok),
    sessionKey: `${entry.id}:${entry.pageIndex}`,
    resultEpoch: entry.result,
    onAfterWrite: afterWrite,
    testId: (action) => `data-peek-${action}-${entry.id}`,
  });

  // Declared after `crud` because it reads the selected row from it; still
  // above every early return, so hook order stays fixed.
  const onInboundClick = useCallback(
    (child: InboundForeignKey, valueIndexes: number[]) => {
      if (!entry.result?.ok) return;
      const row = entry.result.rows[crud.selectedRowIndex ?? -1];
      if (!row) return;
      void drillDataPeekInbound(
        entry.id,
        child,
        valueIndexes.map((i) => row[i])
      );
    },
    [entry, crud.selectedRowIndex, drillDataPeekInbound]
  );

  useEffect(() => {
    onOverlayOpenChange?.(crud.overlayOpen);
  }, [crud.overlayOpen, onOverlayOpenChange]);

  return (
    <div
      className={`px-2 pb-1 flex flex-col w-full shrink-0 transition-opacity ${
        isDragging ? 'opacity-50' : ''
      } ${isDragOver ? 'ring-2 ring-cyan-500/50 rounded-lg' : ''}`}
      style={{ height: heightPx }}
      data-testid={`data-peek-grid-${entry.id}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver(dragIndex);
      }}
      onDragLeave={() => onDragLeave(dragIndex)}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number.parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (Number.isFinite(from)) onDrop(from, dragIndex);
      }}
    >
      <div className="flex items-center gap-1.5 mb-1 shrink-0 min-w-0">
        <button
          type="button"
          draggable
          data-testid={`data-peek-drag-${entry.id}`}
          title="Drag to rearrange panels"
          aria-label={`Reorder ${entry.title}`}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(dragIndex));
            onDragStart(dragIndex);
          }}
          onDragEnd={onDragEnd}
          className="p-0.5 text-slate-500 hover:text-cyan-400 cursor-grab active:cursor-grabbing shrink-0"
        >
          <GripVertical className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
        </button>
        <span className="text-base font-bold text-slate-100 truncate flex-1" title={entry.title}>
          {entry.title}
        </span>
        {entry.baseParams.length > 0 && (
          <button
            type="button"
            data-testid={`data-peek-clear-key-${entry.id}`}
            title="Clear key filter and fetch all rows"
            aria-label="Clear key filter and fetch all rows"
            onClick={() => void clearDataPeekBaseFilter(entry.id)}
            className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-xs font-bold text-slate-200 hover:border-amber-700 hover:text-amber-100 hover:bg-amber-950/30"
          >
            All rows
          </button>
        )}
        {crud.crudButtons}
        {!crud.editability.editable && crud.editability.reason && entry.result?.ok && (
          <span
            className="hidden sm:inline text-xs font-semibold text-slate-400 truncate max-w-[14rem]"
            title={crud.editability.reason}
          >
            Read-only
          </span>
        )}
        {onClose && (
          <button
            type="button"
            data-testid={`data-peek-close-panel-${entry.id}`}
            title="Close this panel"
            aria-label={`Close ${entry.title}`}
            onClick={onClose}
            className="p-0.5 text-slate-500 hover:text-slate-200 shrink-0"
          >
            <X className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
          </button>
        )}
      </div>

      <div
        className="mb-1 shrink-0 inline-flex rounded-md border border-slate-700 overflow-hidden"
        data-testid={`data-peek-tabs-${entry.id}`}
      >
        <button
          type="button"
          data-testid={`data-peek-tab-rows-${entry.id}`}
          onClick={() => setTab('rows')}
          className={`px-2.5 py-0.5 text-[11px] font-semibold ${
            tab === 'rows' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Rows
        </button>
        <button
          type="button"
          data-testid={`data-peek-tab-insight-${entry.id}`}
          onClick={() => setTab('insight')}
          className={`px-2.5 py-0.5 text-[11px] font-semibold ${
            tab === 'insight' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Insight
        </button>
      </div>

      {/* Keep filters editable while a page reloads so clearing WHERE can apply. */}
      {tab === 'rows' && <PeekFilterBar entry={entry} />}

      {crud.writeErrorBanner}

      {tab === 'insight' && (
        <PeekInsight
          connectionId={connectionId}
          tableName={entry.tableName}
          schema={connectionSchema}
        />
      )}

      {tab === 'rows' && entry.status === 'loading' && !entry.result && (
        <div className="flex items-center gap-2 px-1 py-4 text-sm font-semibold text-slate-300">
          <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
          Loading {entry.title}…
        </div>
      )}

      {tab === 'rows' && (entry.status === 'error' || (entry.status !== 'loading' && !entry.result)) && (
        <div className="mx-0.5 my-1 rounded border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-sm font-semibold text-rose-300">
          {entry.error ?? 'Preview failed'}
        </div>
      )}

      {tab === 'rows' && entry.result?.ok && (
        <div className="flex-1 min-h-0 flex flex-col">
          <DataGrid
            result={entry.result}
            exportName={entry.tableName}
            pageIndex={entry.pageIndex}
            pageSize={entry.limit}
            pageLoading={entry.status === 'loading'}
            hasPrevPage={entry.pageIndex > 0}
            hasNextPage={Boolean(entry.result.hasNext ?? entry.result.truncated)}
            onPrevPage={() => void pageDataPeekEntry(entry.id, Math.max(0, entry.pageIndex - 1))}
            onNextPage={() => void pageDataPeekEntry(entry.id, entry.pageIndex + 1)}
            linkColumns={linkColumns.size > 0 ? linkColumns : undefined}
            onLinkClick={onLinkClick}
            selectedRowIndex={crud.selectedRowIndex}
            onSelectRow={crud.onSelectRow}
            emphasis
          />
          {inboundLinks.length > 0 && (
            <div
              className="mt-1 px-1 shrink-0 flex flex-wrap items-center gap-1"
              data-testid={`data-peek-referenced-by-${entry.id}`}
            >
              <span className="text-xs font-semibold text-slate-400">Referenced by</span>
              {inboundLinks.map(({ child, valueIndexes }) => {
                const ready = crud.selectedRowIndex != null;
                return (
                  <button
                    key={`${child.table}|${fkKey(child.fk)}`}
                    type="button"
                    disabled={!ready}
                    data-testid={`data-peek-refby-${child.table}-${fkKey(child.fk)}`}
                    title={
                      ready
                        ? `Rows of ${child.table} whose ${(child.fk.columns ?? []).join(', ')} match this row`
                        : 'Select a row first'
                    }
                    onClick={() => onInboundClick(child, valueIndexes)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                      ready
                        ? 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100'
                        : 'border-slate-800 text-slate-600 cursor-not-allowed'
                    }`}
                  >
                    {child.table}
                    <span className="ml-1 font-mono text-[10px] text-slate-500">
                      {(child.fk.columns ?? []).join(', ')}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {showFkHint && linkColumns.size > 0 && (
            <p className="mt-1 px-1 shrink-0 text-xs font-semibold text-slate-400">
              Underlined rust-colored cells are foreign keys — click several to open more panels.
              Drag the ⋮⋮ handle to arrange; scroll to move between them.
            </p>
          )}
        </div>
      )}

      <PeekResizeHandle entryId={entry.id} heightPx={heightPx} />

      {crud.overlays}
    </div>
  );
};

export const DataPeekPanel: React.FC = () => {
  const dataPeek = useSqlEditorStore((s) => s.dataPeek);
  const closeDataPeek = useSqlEditorStore((s) => s.closeDataPeek);
  const closeDataPeekFrom = useSqlEditorStore((s) => s.closeDataPeekFrom);
  const reorderDataPeekEntries = useSqlEditorStore((s) => s.reorderDataPeekEntries);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEntryCount = useRef(0);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [childOverlayOpen, setChildOverlayOpen] = useState(false);

  useEffect(() => {
    if (!dataPeek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Row editor / write confirm own Escape — do not close the whole peek.
      if (childOverlayOpen) return;
      closeDataPeek();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dataPeek, closeDataPeek, childOverlayOpen]);

  // When a new FK panel opens, scroll the main peek body so it comes into view.
  useEffect(() => {
    if (!dataPeek) {
      lastEntryCount.current = 0;
      return;
    }
    const count = dataPeek.entries.length;
    if (count > lastEntryCount.current) {
      const last = dataPeek.entries[count - 1];
      requestAnimationFrame(() => {
        const el = last
          ? scrollRef.current?.querySelector(`[data-testid="data-peek-grid-${last.id}"]`)
          : null;
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
    lastEntryCount.current = count;
  }, [dataPeek]);

  if (!dataPeek) return null;
  const tables = schemaCache[dataPeek.connectionId]?.tables;
  const entries = dataPeek.entries;

  return createPortal(
    <div
      /*
       * z-70 is pinned from both sides, so it is not free to change:
       *
       *   60  ResultsPanel fullscreen (`sql-result-modal-*`, `sql-result-cred-modal-*`)
       *   70  this panel
       *   95  PeekRowEditor, opened from inside this panel
       *  100  .modal-overlay — WriteConfirmDialog, opened from this panel's CRUD
       *
       * It used to be 50, below the fullscreen results. Those results carry the
       * foreign-key cells whose own footer says "click one to open Data Peek",
       * so clicking one mounted this panel *behind* the overlay: nothing
       * appeared to happen, and the panel was still open, swallowing the next
       * click. All four layers here are body-level portals, so the numbers are
       * compared directly rather than per-subtree.
       */
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-1.5 sm:p-3"
      data-testid="data-peek"
      onClick={closeDataPeek}
    >
      <div
        className="flex flex-col w-[min(99vw,1680px)] h-[min(96vh,980px)] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 shrink-0">
          <span className="text-sm font-bold uppercase tracking-wide text-cyan-400 shrink-0">
            Data peek
          </span>
          <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto">
            {entries.map((e) => (
              <span
                key={e.id}
                className="inline-flex items-center gap-1 shrink-0 max-w-[16rem] rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1"
                title={e.title}
              >
                <span className="truncate text-sm font-bold text-slate-200">{e.title}</span>
                {e.parentId && (
                  <button
                    type="button"
                    data-testid={`data-peek-crumb-close-${e.id}`}
                    title="Close panel"
                    aria-label={`Close ${e.title}`}
                    onClick={() => closeDataPeekFrom(e.id)}
                    className="text-slate-500 hover:text-slate-200"
                  >
                    <X className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
                  </button>
                )}
              </span>
            ))}
          </div>
          <span className="hidden sm:inline text-xs font-semibold text-slate-400 shrink-0">
            Drag ⋮⋮ to arrange
          </span>
          <button
            type="button"
            data-testid="data-peek-close"
            title="Close (Esc)"
            aria-label="Close data peek"
            onClick={closeDataPeek}
            className="p-1 text-slate-400 hover:text-slate-100 shrink-0"
          >
            <X className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
          </button>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain"
          data-testid="data-peek-scroll"
        >
          <div className="flex flex-col gap-3 py-2 px-1">
            {entries.map((e, index) => {
              const isRoot = !e.parentId;
              return (
                <div
                  key={e.id}
                  className={
                    isRoot
                      ? 'min-w-0 w-full shrink-0'
                      : 'min-w-0 w-full shrink-0 rounded-lg border border-slate-800 bg-slate-950/40'
                  }
                >
                  <PeekGrid
                    entry={e}
                    tables={tables}
                    dialect={dataPeek.dialect}
                    connectionId={dataPeek.connectionId}
                    variant={isRoot ? 'root' : 'drill'}
                    showFkHint={isRoot}
                    dragIndex={index}
                    isDragging={dragFrom === index}
                    isDragOver={dragOver === index && dragFrom !== null && dragFrom !== index}
                    onDragStart={setDragFrom}
                    onDragOver={(i) => {
                      if (dragOver !== i) setDragOver(i);
                    }}
                    onDragLeave={(i) => {
                      if (dragOver === i) setDragOver(null);
                    }}
                    onDrop={(fromIdx, toIndex) => {
                      if (fromIdx !== toIndex) {
                        reorderDataPeekEntries(fromIdx, toIndex);
                      }
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    onDragEnd={() => {
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                    onClose={isRoot ? undefined : () => closeDataPeekFrom(e.id)}
                    onOverlayOpenChange={setChildOverlayOpen}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
