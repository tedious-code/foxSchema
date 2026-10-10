import React, { useState, useEffect, useMemo } from 'react';
import { useSyncStore } from '@/features/compare';
import { useShallow } from 'zustand/react/shallow';
import { useUiStore } from '@/app/store/uiStore';
import { Search, Layers } from 'lucide-react';
import type { TableDiff } from '@/shared/lib/types';
import { SchemaDiffTree } from '@/features/schema-diff/ui';
import { TYPE_META, TYPE_ORDER } from '@/features/schema-diff';

const MIN_WIDTH = 280;
const MAX_WIDTH = 640;

export const SchemaTreePanel: React.FC = () => {
  const syncPane = useUiStore((s) => s.syncPane);
  // Only these fields: a whole-store subscription re-rendered every row of the
  // tree on any store write, twice per object during a migration.
  const {
    compareResult,
    browseMode,
    browseSide,
    sourceConfig,
    targetConfig,
    selectedTable,
    setSelectedTable,
    filterStatus,
    setFilterStatus,
    searchTerm,
    setSearchTerm,
    typeFilter,
    toggleTypeFilter,
    clearTypeFilter,
    syncSelection,
    toggleSyncSelection,
    setAllSyncSelection,
    nonDestructive,
    setNonDestructive,
    continueOnError,
    setContinueOnError,
  } = useSyncStore(
    useShallow((s) => ({
      compareResult: s.compareResult,
      browseMode: s.browseMode,
      browseSide: s.browseSide,
      sourceConfig: s.sourceConfig,
      targetConfig: s.targetConfig,
      selectedTable: s.selectedTable,
      setSelectedTable: s.setSelectedTable,
      filterStatus: s.filterStatus,
      setFilterStatus: s.setFilterStatus,
      searchTerm: s.searchTerm,
      setSearchTerm: s.setSearchTerm,
      typeFilter: s.typeFilter,
      toggleTypeFilter: s.toggleTypeFilter,
      clearTypeFilter: s.clearTypeFilter,
      syncSelection: s.syncSelection,
      toggleSyncSelection: s.toggleSyncSelection,
      setAllSyncSelection: s.setAllSyncSelection,
      nonDestructive: s.nonDestructive,
      setNonDestructive: s.setNonDestructive,
      continueOnError: s.continueOnError,
      setContinueOnError: s.setContinueOnError,
    }))
  );

  const [panelWidth, setPanelWidth] = useState(340);
  // "Unchanged" is an independent toggle (not part of the All/Added/Removed/Modified
  // status filter). On by default, so the initial view shows every object.
  const [showUnchanged, setShowUnchanged] = useState(true);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: MouseEvent) => {
      setPanelWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Compute the filtered list even when compareResult is null so the selection-
  // sync effect can sit above the early return (rules of hooks).
  const query = searchTerm.trim().toLowerCase();
  // Memoized for two reasons: it is a dependency of the selection-sync effect
  // below, so an unstable identity re-ran that effect on every render; and the
  // filter itself builds a haystack of every column, index, FK and trigger name
  // per table, which is not work to repeat for an unrelated state change.
  const filteredTables = useMemo(() => {
    if (!compareResult) return [];
    return compareResult.tables.filter((table) => {
        if (query) {
          const haystack: (string | undefined)[] = [table.tableName];
          for (const c of table.columnDiffs) haystack.push(c.name);
          for (const i of table.indexDiffs) haystack.push(i.name);
          for (const fk of table.foreignKeyDiffs) {
            haystack.push(fk.name, fk.source?.referencedTable ?? fk.target?.referencedTable);
          }
          for (const tr of table.triggerDiffs ?? []) {
            haystack.push(tr.name, tr.source?.definition, tr.target?.definition);
          }
          haystack.push(table.definition, table.sourceTable?.definition, table.targetTable?.definition);
          if (!haystack.some((s) => s?.toLowerCase().includes(query))) return false;
        }
        if (typeFilter.length > 0 && !typeFilter.includes(table.objectType)) return false;
        // Browse mode has only UNCHANGED rows — always show them.
        if (browseMode) return true;
        // Rename-only indexes leave the table UNCHANGED (no MODIFY badge) but still
        // need to appear so the user can open the blueprint and opt in to migrate.
        if (table.status === 'UNCHANGED') {
          return showUnchanged || (table.indexDiffs ?? []).some((d) => d.nameOnly);
        }
        return filterStatus === 'ALL' || table.status === filterStatus;
    });
  }, [compareResult, query, typeFilter, browseMode, showUnchanged, filterStatus]);

  // After Compare, leave selection empty so Diff Briefing is the landing view.
  // Only clear a selection that filters have hidden — do not pick the first row.
  useEffect(() => {
    if (!compareResult) return;
    if (!selectedTable) return;
    const stillVisible = filteredTables.some((t) => t.tableName === selectedTable.tableName);
    if (stillVisible) return;
    setSelectedTable(null);
  }, [compareResult, filteredTables, selectedTable, setSelectedTable]);

  if (!compareResult) {
    // Browse is its own pane now, so the empty state has to name the thing the
    // reader is actually looking at rather than always saying "comparison".
    const browsing = syncPane === 'browse';
    return (
      <div
        data-testid="schema-tree-empty"
        className="w-80 border-r border-slate-800 flex flex-col items-center justify-center text-slate-500 p-6 bg-slate-900/30"
      >
        <Layers className="w-10 h-10 mb-3 text-slate-700 animate-bounce" />
        <p className="text-sm font-semibold text-slate-400">
          {browsing ? 'Nothing loaded' : 'No comparison yet'}
        </p>
        <p className="text-xs text-slate-600 text-center max-w-[220px] mt-1">
          {browsing
            ? 'Pick a connection above and click "Browse" to read its objects.'
            : 'Pick Original and Target in the chips, then Compare. The briefing opens here.'}
        </p>
      </div>
    );
  }

  const browseSchemaName = browseSide === 'target' ? targetConfig.schema : sourceConfig.schema;

  const changedTables = compareResult.tables.filter((t) => t.status !== 'UNCHANGED');
  const changedCount = changedTables.length;
  const includedCount = changedTables.filter((t) => syncSelection[t.tableName]).length;

  // Search matches across the whole object schema — the object name, its column,
  // index, foreign-key (and referenced table), and trigger names, plus the DDL
  // definition body. The definition is what makes views, functions, procedures,
  // and triggers searchable, since those objects have no columns of their own.
  const matchesSearch = (table: TableDiff) => {
    if (!query) return true;
    const haystack: (string | undefined)[] = [table.tableName];
    for (const c of table.columnDiffs) haystack.push(c.name);
    for (const i of table.indexDiffs) haystack.push(i.name);
    for (const fk of table.foreignKeyDiffs) {
      haystack.push(fk.name, fk.source?.referencedTable ?? fk.target?.referencedTable);
    }
    for (const tr of table.triggerDiffs ?? []) {
      haystack.push(tr.name, tr.source?.definition, tr.target?.definition);
    }
    // View / function / procedure bodies (and any object-level DDL)
    haystack.push(table.definition, table.sourceTable?.definition, table.targetTable?.definition);
    return haystack.some((s) => s?.toLowerCase().includes(query));
  };

  // When a row matches because of something other than its name, describe
  // where (column / index / FK / trigger / definition) so the result explains
  // why it surfaced. Returns null when the name itself matches (already
  // highlighted) or there's no query.
  // Group the filtered objects by type, in a stable order
  const getChangeSummaryStats = () => {
    const { added, removed, modified, unchanged } = compareResult.summary;
    return [
      { label: 'All',       count: compareResult.tables.length, color: 'text-slate-100',   status: 'ALL'       as const, toggle: false },
      { label: 'Added',     count: added,    color: 'text-emerald-400', status: 'ADDED'     as const, toggle: false },
      { label: 'Removed',   count: removed,  color: 'text-rose-400',   status: 'REMOVED'   as const, toggle: false },
      { label: 'Modified',  count: modified, color: 'text-amber-400',  status: 'MODIFIED'  as const, toggle: false },
      { label: 'Unchanged', count: unchanged,color: 'text-slate-400',  status: 'UNCHANGED' as const, toggle: true  },
    ];
  };

  return (
    <div
      data-testid="schema-tree"
      style={{ width: panelWidth }}
      className="relative shrink-0 border-r border-slate-800 bg-slate-905 flex flex-col h-full select-none"
    >
      {/* Overview Stats Dashboard */}
      <div className="p-4 border-b border-slate-800/80 bg-slate-950/40">
        <div className="flex justify-between items-center mb-3 gap-2">
          <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
            {browseMode ? (
              <>Browsing <span className="text-cyan-400 normal-case">{browseSchemaName}</span></>
            ) : (
              'Compare Results'
            )}
          </h2>
          <div className="flex items-center gap-2">
          {!browseMode && selectedTable && (
            <button
              type="button"
              data-testid="diff-briefing-open"
              onClick={() => setSelectedTable(null)}
              className="text-[10px] font-bold uppercase tracking-wide text-cyan-400 hover:text-cyan-300"
            >
              Briefing
            </button>
          )}
          <span className="text-sm text-slate-200 font-mono font-bold">
            {compareResult.tables.length} objects
          </span>
          </div>
        </div>

        {/* Stat cards double as the filter: All/Added/Removed/Modified are a
            single-select status filter; Unchanged is an independent toggle.
            Hidden in browse mode — there are no statuses to filter by. */}
        {!browseMode && (
        <div className="grid grid-cols-5 gap-1.5">
          {getChangeSummaryStats().map((stat) => {
            const active = stat.toggle ? showUnchanged : filterStatus === stat.status;
            return (
              <button data-testid={`schema-status-filter-${stat.status}`}
                key={stat.status}
                onClick={() => (stat.toggle ? setShowUnchanged((v) => !v) : setFilterStatus(stat.status))}
                title={stat.toggle ? 'Toggle unchanged objects' : `Show ${stat.label.toLowerCase()}`}
                className={`p-2 rounded border flex flex-col items-center justify-center text-center transition cursor-pointer ${
                  active
                    ? 'bg-slate-800 border-cyan-500/50 ring-1 ring-cyan-500/20'
                    : 'bg-slate-950/80 border-slate-800/50 hover:border-slate-700'
                }`}
              >
                <span className={`text-base font-extrabold leading-none ${stat.color}`}>{stat.count}</span>
                <span className="text-[9px] text-slate-500 font-medium leading-tight mt-1">{stat.label}</span>
              </button>
            );
          })}
        </div>
        )}
      </div>

      {/* Search Bar. The object-type filter used to live here as a row of
          pills, but this panel's width (280-640px, resizable) kept clipping
          it — it now lives in the top toolbar's wider scope bar (see
          TopToolbar's "Viewing" pills), which sets the same store field
          (typeFilter). */}
      <div className="p-3 border-b border-slate-800/80 bg-slate-950/20">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input data-testid="sql-schema-tree-search"
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search objects, columns, indexes..."
            className="w-full text-sm pl-8 pr-3 py-1.5 bg-slate-900 border border-slate-800 rounded-md focus:outline-none accent-focus text-slate-200"
          />
        </div>
      </div>

      {/* Browse's own type filter. Compare puts these pills in the top toolbar,
          which is full-width; Browse has no connection grid competing for that
          bar, and the reader is filtering a single database's contents, so the
          control belongs beside the list it filters. Written out here rather
          than shared with the toolbar's row: same data, different container and
          sizing, and one component bent to satisfy both would be worse than
          twenty lines that read plainly. */}
      {browseMode && (
        <div
          data-testid="browse-type-filter"
          className="px-3 py-2 border-b border-slate-800/80 bg-slate-950/30 flex flex-wrap items-center gap-1"
        >
          <button data-testid="sql-schema-tree-type-all"
            onClick={clearTypeFilter}
            className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition cursor-pointer ${
              typeFilter.length === 0
                ? 'bg-slate-800 text-slate-100 border-slate-600'
                : 'bg-slate-900/50 text-slate-500 border-slate-850 hover:text-slate-300'
            }`}
          >
            All
          </button>
          {TYPE_ORDER.filter((type) =>
            compareResult.tables.some((t) => t.objectType === type)
          ).map((type) => {
            const count = compareResult.tables.filter((t) => t.objectType === type).length;
            const active = typeFilter.includes(type);
            return (
              <button
                key={type}
                data-testid={`browse-type-${type}`}
                onClick={() => toggleTypeFilter(type)}
                title={`${TYPE_META[type].group} (${count})`}
                className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition cursor-pointer flex items-center gap-1 ${
                  active
                    ? 'bg-slate-800 text-slate-100 border-slate-600'
                    : 'bg-slate-900/50 text-slate-500 border-slate-850 hover:text-slate-300'
                }`}
              >
                <span className={TYPE_META[type].color}>{TYPE_META[type].icon}</span>
                {TYPE_META[type].group}
                <span className="text-slate-500">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Deployment Selection Header — hidden in browse mode (nothing to deploy) */}
      {!browseMode && (
      <div className="px-3 py-2 border-b border-slate-800/80 bg-slate-950/30 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0 whitespace-nowrap">
          <input data-testid="sql-schema-tree-include-all"
            type="checkbox"
            checked={changedCount > 0 && includedCount === changedCount}
            onChange={(e) => setAllSyncSelection(e.target.checked)}
            className="w-4 h-4 accent-cyan-500 cursor-pointer"
          />
          Deploy to Target
        </label>
        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          <label
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer text-[10px] font-semibold px-2 py-1 rounded border transition ${
              nonDestructive
                ? 'text-emerald-300 bg-emerald-950/50 border-emerald-500/40'
                : 'text-slate-500 bg-slate-950/40 border-slate-800 hover:border-slate-700'
            }`}
            title="Non-destructive: ADD/MODIFY only — never DROP columns, indexes, or tables"
          >
            <input
              data-testid="non-destructive-checkbox"
              type="checkbox"
              checked={nonDestructive}
              onChange={(e) => setNonDestructive(e.target.checked)}
              className="w-3 h-3 accent-emerald-500 cursor-pointer"
            />
            No drops
          </label>
          <label
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer text-[10px] font-semibold px-2 py-1 rounded border transition ${
              continueOnError
                ? 'text-amber-300 bg-amber-950/50 border-amber-500/40'
                : 'text-slate-500 bg-slate-950/40 border-slate-800 hover:border-slate-700'
            }`}
            title="Skip failures: an object that fails to deploy is skipped instead of aborting and rolling back the whole run. Objects depending on a skipped one will likely fail too."
          >
            <input
              data-testid="continue-on-error-checkbox"
              type="checkbox"
              checked={continueOnError}
              onChange={(e) => setContinueOnError(e.target.checked)}
              className="w-3 h-3 accent-amber-500 cursor-pointer"
            />
            Skip failures
          </label>
          <span className="text-xs text-slate-300 font-mono font-bold shrink-0">
            {includedCount} / {changedCount}
          </span>
        </div>
      </div>
      )}

      {/* The tree itself lives in SchemaDiffTree, shared with schema history. */}
      <div className="flex-1 overflow-y-auto p-2">
        <SchemaDiffTree
          tables={filteredTables}
          selectedName={selectedTable?.tableName ?? null}
          onSelect={setSelectedTable}
          query={query}
          showStatusBadge={!browseMode}
          selection={browseMode ? undefined : syncSelection}
          onToggleSelection={toggleSyncSelection}
          selectionTitle="Include this change in the deployment script"
        />
      </div>

      {/* Resize Handle */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-cyan-500/40 active:bg-cyan-500/60 transition-colors"
      />
    </div>
  );
};
