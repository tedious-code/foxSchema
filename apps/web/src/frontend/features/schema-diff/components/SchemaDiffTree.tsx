/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The diff tree, grouped by object type — shared by every comparison.
 *
 * Extracted from `SchemaTreePanel`, which reads nineteen fields straight out of
 * `useSyncStore` and mixes migrate controls into the same component. That made
 * it unusable anywhere but the live workspace: rendering it for two *stored*
 * versions would have clobbered the user's in-flight comparison.
 *
 * This half takes props only. `SchemaTreePanel` keeps the store wiring, the
 * filter chrome and the deploy controls and passes the result down; the version
 * history renders the same tree for two points in the past. One component, two
 * sources of data.
 *
 * Selection is optional on purpose. The workspace uses it to pick objects to
 * deploy; history uses the identical mechanism to pick objects to revert. Those
 * are the same gesture over the same shape, so they are the same code.
 */
import React from 'react';
import type { TableDiff } from '@/shared/lib/types';
import { highlightMatch } from '@/features/schema-diff/lib/highlight';
import { TYPE_META, TYPE_ORDER } from './objectTypeMeta';

export { TYPE_META, TYPE_ORDER, type TypeMeta } from './objectTypeMeta';

export function statusBadgeClass(status: TableDiff['status']): string {
  switch (status) {
    case 'ADDED':
      return 'bg-emerald-950/60 text-emerald-400 border-emerald-500/20';
    case 'REMOVED':
      return 'bg-rose-950/60 text-rose-400 border-rose-500/20';
    case 'MODIFIED':
      return 'bg-amber-950/60 text-amber-400 border-amber-500/20';
    default:
      return 'bg-slate-900/60 text-slate-500 border-slate-700/30';
  }
}

/**
 * Where a search matched, when it did not match the object's own name.
 *
 * Without this a search for a column name lists tables whose names look
 * unrelated, and the reader cannot tell why any of them are there.
 */
export function matchLocationOf(table: TableDiff, query: string): string | null {
  if (!query || table.tableName.toLowerCase().includes(query)) return null;
  const col = table.columnDiffs.find((c) => c.name.toLowerCase().includes(query));
  if (col) return `column: ${col.name}`;
  const idx = table.indexDiffs.find((i) => i.name.toLowerCase().includes(query));
  if (idx) return `index: ${idx.name}`;
  const fk = table.foreignKeyDiffs.find((f) => f.name.toLowerCase().includes(query));
  if (fk) return `foreign key: ${fk.name}`;
  const trg = (table.triggerDiffs ?? []).find((t) => t.name.toLowerCase().includes(query));
  if (trg) return `trigger: ${trg.name}`;
  return 'definition';
}

/**
 * Tables in the order the tree draws them — grouped by type, tables first.
 *
 * Callers that pair the tree with a detail pane need this: the raw array order
 * is not the display order, so defaulting a selection to `tables[0]` picks a
 * row that is not the one at the top of the list.
 */
export function orderTablesForDisplay(tables: readonly TableDiff[]): TableDiff[] {
  return TYPE_ORDER.flatMap((type) => tables.filter((t) => t.objectType === type));
}

export interface SchemaDiffTreeProps {
  /** Already filtered by the caller — this component does not decide what to show. */
  tables: TableDiff[];
  selectedName?: string | null;
  onSelect?: (table: TableDiff) => void;
  /** Search term, lower-cased, for match highlighting. */
  query?: string;
  /** Browse mode has only UNCHANGED rows, so the badge is noise. */
  showStatusBadge?: boolean;
  /**
   * Per-object tick state. Present means checkboxes render — the workspace uses
   * it for "deploy this", history for "revert this".
   */
  selection?: Record<string, boolean>;
  onToggleSelection?: (tableName: string) => void;
  /** Tooltip on the checkbox; the two callers mean different things by it. */
  selectionTitle?: string;
  emptyMessage?: string;
}

/**
 * The tree used to nest each table's indexes underneath its name, expandable.
 *
 * It duplicated the blueprint, which lists the same indexes with the deploy
 * checkboxes that actually do something — the tree copy was read-only. Two
 * renderings of one thing is what `SchemaDiffTree` was extracted to stop, and
 * the nested list pushed the object names the tree exists for off the screen.
 *
 * The `N idx` count stays on the name line: it is a summary, not a second copy.
 */
export function SchemaDiffTree({
  tables,
  selectedName,
  onSelect,
  query = '',
  showStatusBadge = true,
  selection,
  onToggleSelection,
  selectionTitle = 'Include this change',
  emptyMessage = 'No matching schema objects.',
}: SchemaDiffTreeProps): React.ReactElement {
  const groups = TYPE_ORDER.map((type) => ({
    type,
    items: tables.filter((t) => t.objectType === type),
  })).filter((g) => g.items.length > 0);

  if (groups.length === 0) {
    return <div className="text-center py-8 text-slate-600 text-sm">{emptyMessage}</div>;
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.type}>
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1 sticky top-0 z-[1] bg-slate-950/95">
            {TYPE_META[group.type].icon}
            <span
              className={`text-xs font-bold uppercase tracking-wider ${TYPE_META[group.type].color}`}
            >
              {TYPE_META[group.type].group}
            </span>
            <span className="text-xs text-slate-600 font-mono">({group.items.length})</span>
            <div className="flex-1 h-px bg-slate-800/80" />
          </div>

          <div className="space-y-1">
            {group.items.map((table) => (
              <DiffTreeRow
                key={table.tableName}
                table={table}
                isSelected={selectedName === table.tableName}
                checkbox={selection && table.status !== 'UNCHANGED' ? !!selection[table.tableName] : null}
                query={query}
                showStatusBadge={showStatusBadge}
                selectionTitle={selectionTitle}
                onSelect={onSelect}
                onToggleSelection={onToggleSelection}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One object's line. Memoised on plain values: the Compare tree holds
 * thousands, and ticking one re-rendered all of them (25 ms at 2,500, and
 * again on every search keystroke).
 */
const DiffTreeRow = React.memo(function DiffTreeRow({
  table,
  isSelected,
  checkbox,
  query,
  showStatusBadge,
  selectionTitle,
  onSelect,
  onToggleSelection,
}: {
  table: TableDiff;
  isSelected: boolean;
  /** Tick state when this row has a checkbox, null when it has none. */
  checkbox: boolean | null;
  query: string;
  showStatusBadge: boolean;
  selectionTitle: string;
  onSelect?: (table: TableDiff) => void;
  onToggleSelection?: (tableName: string) => void;
}) {
  const matchedIn = matchLocationOf(table, query);
  const indexes = table.indexDiffs ?? [];
  return (
    <div
      data-testid="diff-item"
      data-object={table.tableName}
      data-status={table.status}
      onClick={() => onSelect?.(table)}
      className={`rounded-lg border transition ${onSelect ? 'cursor-pointer' : ''} ${
        isSelected
          ? 'bg-slate-800/80 border-slate-700/80 shadow-md shadow-indigo-500/5'
          : 'bg-slate-950/30 border-transparent hover:border-slate-800/80 hover:bg-slate-900/40'
      }`}
    >
      <div className="group flex items-center justify-between p-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {checkbox === null && <span className="w-5 shrink-0" />}
          {checkbox !== null ? (
            <input data-testid={`diff-tree-toggle-selection-${table.tableName}`}
              type="checkbox"
              checked={checkbox}
              onChange={() => onToggleSelection?.(table.tableName)}
              onClick={(e) => e.stopPropagation()}
              title={selectionTitle}
              className="w-4 h-4 accent-cyan-500 cursor-pointer shrink-0"
            />
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="shrink-0">{TYPE_META[table.objectType].icon}</span>
          <div className="flex flex-col min-w-0">
            <span
              className={`text-sm font-semibold truncate ${
                isSelected ? 'text-slate-100' : 'text-slate-300 group-hover:text-slate-200'
              }`}
            >
              {highlightMatch(table.tableName, query)}
            </span>
            {matchedIn && (
              <span className="text-[10px] text-slate-500 truncate" title={`Search matched in ${matchedIn}`}>
                matched in {matchedIn}
              </span>
            )}
          </div>
          {indexes.length > 0 && (
            <span
              className="text-[10px] font-mono text-slate-500 shrink-0"
              title="Index count. The indexes themselves, with their deploy checkboxes, are in the blueprint."
            >
              {indexes.length} idx
            </span>
          )}
        </div>

        {showStatusBadge && (
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ml-2 ${statusBadgeClass(
              table.status
            )}`}
          >
            {table.status}
          </span>
        )}
      </div>
    </div>
  );
});
