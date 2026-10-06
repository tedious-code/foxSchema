import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  FileCode2,
  Hash,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useSyncStore } from '@/app/store/useSyncStore';
import { SCHEMA_ROUTINE_SCOPE, useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { quoteIdentifierIfNeeded } from '@foxschema/ui-shared';
import { getProviderSettings } from '@/shared/lib/provider-settings';
import { TYPE_META } from '@/features/schema-diff';
import {
  filterCallParameters,
  getCompletionContext,
  insertAtCursor,
  mutateSql,
} from '../lib/sqlEditorBridge';
import {
  addTableWithAliasToFrom,
  existingShortAliasForTable,
  insertIntoSelectList,
} from '@/features/sql-editor/lib/selectClauseEdit';
import type { DbObjectType, TableSchema } from '@/shared/lib/types';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { TableBlueprintModal, type BlueprintMode } from './TableBlueprintModal';
import { isScriptableObject, objectSourceScript } from '../lib/objectSourceScript';
import { fetchDbaUtility } from '@/shared/api/schemaApi';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import {
  dialectSupportsDbaUtility,
  formatBytes,
  formatRowCount,
  groupObjectSizes,
  indexTableSizeGroups,
  lookupIndexSizeRow,
  type TableSizeGroup,
} from '@foxschema/ui-shared';

/** Imperative API for the Schema section header (New table). */
export interface SqlSchemaExplorerHandle {
  openCreateTable: () => void;
}

/** Categories shown in the SQL Editor schema browser (order = display order). */
const EXPLORER_GROUPS: { type: DbObjectType; title: string }[] = [
  { type: 'TABLE', title: 'Tables' },
  { type: 'VIEW', title: 'Views' },
  { type: 'MQT', title: 'MQTs' },
  { type: 'PROCEDURE', title: 'Procedures' },
  { type: 'FUNCTION', title: 'Functions' },
];

const EXPLORER_CONN_KEY = 'foxschema-sql-schema-explorer-connection';

/** Cmd on macOS, Ctrl elsewhere — used in titles so the hint matches the key. */
export function peekModifierLabel(): string {
  const platform =
    typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad/i.test(platform) ? 'Cmd' : 'Ctrl';
}

function readStoredExplorerId(): string {
  try {
    return localStorage.getItem(EXPLORER_CONN_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

function writeStoredExplorerId(id: string): void {
  try {
    if (id) localStorage.setItem(EXPLORER_CONN_KEY, id);
    else localStorage.removeItem(EXPLORER_CONN_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Slim schema tree for the SQL Editor. Categorized TABLE / VIEW / MQT /
 * PROCEDURE / FUNCTION.
 *
 * TABLE / MQT: click inserts the name; trailing Edit opens the blueprint.
 * VIEW / PROCEDURE / FUNCTION: click opens the source script in the editor
 * (view-only — no edit form in this version); trailing Source also opens it.
 *
 * The connection dropdown stays in sync with Destination servers: picking a
 * schema credential checks it as a destination, and changing destinations
 * moves the explorer onto a checked credential when needed.
 */
export const SqlSchemaExplorer = forwardRef<SqlSchemaExplorerHandle>(function SqlSchemaExplorer(
  _props,
  ref
) {
  const connections = useSyncStore((s) => s.connections);
  const connectionsLoaded = useSyncStore((s) => s.connectionsLoaded);
  const tabs = useSqlEditorStore((s) => s.tabs);
  const activeTabId = useSqlEditorStore((s) => s.activeTabId);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const openDataPeek = useSqlEditorStore((s) => s.openDataPeek);
  const shareDestinations = useSqlEditorStore((s) => s.shareDestinations);
  const sharedConnectionIds = useSqlEditorStore((s) => s.sharedConnectionIds);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const pendingPasswordId = useSqlEditorStore((s) => s.pendingPassword?.id);
  const setSql = useSqlEditorStore((s) => s.setSql);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);

  const tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;
  const selectedDestinationIds = shareDestinations
    ? sharedConnectionIds
    : tab.selectedConnectionIds;
  const preferredIds = useMemo(
    () => selectedDestinationIds.filter((id) => connections.some((c) => c.id === id)),
    [selectedDestinationIds, connections]
  );

  const [explorerId, setExplorerId] = useState<string>(() => readStoredExplorerId());
  const [expandedObj, setExpandedObj] = useState<Record<string, boolean>>({});
  const [expandedGroup, setExpandedGroup] = useState<Record<string, boolean>>({
    TABLE: true,
    VIEW: true,
    MQT: true,
    PROCEDURE: false,
    FUNCTION: false,
  });
  const [blueprintTable, setBlueprintTable] = useState<TableSchema | null>(null);
  const [blueprintMode, setBlueprintMode] = useState<BlueprintMode>('edit');
  const [sizeGroups, setSizeGroups] = useState<TableSizeGroup[]>([]);
  // Indexed once per load: every table row looks itself up on each render.
  const sizeOf = useMemo(() => indexTableSizeGroups(sizeGroups), [sizeGroups]);

  const selectExplorerId = (id: string) => {
    setExplorerId(id);
    writeStoredExplorerId(id);
    if (id) ensureConnectionSelected(id);
  };

  const openCreateTable = () => {
    setBlueprintMode('create');
    setBlueprintTable(null);
  };

  useImperativeHandle(ref, () => ({ openCreateTable }), []);

  useEffect(() => {
    if (!connectionsLoaded) return;

    if (connections.length === 0) {
      if (explorerId) {
        setExplorerId('');
        writeStoredExplorerId('');
      }
      return;
    }

    // Keep explorer on a password-pending credential until the prompt resolves.
    if (pendingPasswordId && pendingPasswordId === explorerId) return;

    if (explorerId && preferredIds.includes(explorerId)) {
      writeStoredExplorerId(explorerId);
      return;
    }

    if (preferredIds.length > 0) {
      const next = preferredIds[0]!;
      if (next !== explorerId) {
        setExplorerId(next);
        writeStoredExplorerId(next);
      }
      return;
    }

    if (explorerId && connections.some((c) => c.id === explorerId)) {
      writeStoredExplorerId(explorerId);
      return;
    }

    const stored = readStoredExplorerId();
    const next =
      (stored && connections.some((c) => c.id === stored) ? stored : '') ||
      connections[0]?.id ||
      '';
    if (next !== explorerId) setExplorerId(next);
    if (next) writeStoredExplorerId(next);
    else writeStoredExplorerId('');
  }, [connectionsLoaded, connections, preferredIds, explorerId, pendingPasswordId]);

  useEffect(() => {
    if (!explorerId) return;
    void ensureSchema(explorerId);
  }, [explorerId, ensureSchema]);

  const entry = explorerId ? schemaCache[explorerId] : undefined;
  const grouped = useMemo(() => {
    const list = entry?.tables ?? [];
    const map = new Map<DbObjectType, TableSchema[]>();
    for (const g of EXPLORER_GROUPS) map.set(g.type, []);
    for (const t of list) {
      const bucket = map.get(t.objectType);
      if (bucket) bucket.push(t);
    }
    for (const items of map.values()) {
      items.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [entry?.tables]);

  const totalCount = useMemo(
    () => EXPLORER_GROUPS.reduce((n, g) => n + (grouped.get(g.type)?.length ?? 0), 0),
    [grouped]
  );

  const conn = connections.find((c) => c.id === explorerId);
  const sessionPassword = explorerId ? sessionPasswords[explorerId] : undefined;

  useEffect(() => {
    if (!explorerId || entry?.status !== 'ready' || !conn) {
      setSizeGroups((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    if (!dialectSupportsDbaUtility(conn.dialect, 'sizes').query) {
      setSizeGroups((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // File dialects carry no password; waiting for one never resolved.
    if (!conn.hasPassword && connectionNeedsSecret(conn.dialect, conn.authMethod) && !sessionPassword) return;
    let cancelled = false;
    void fetchDbaUtility(
      { connectionId: explorerId, password: sessionPassword },
      { kind: 'sizes', schema: conn.schema }
    )
      .then((res) => {
        if (!cancelled) setSizeGroups(groupObjectSizes(res.sizes ?? []));
      })
      .catch(() => {
        if (!cancelled) setSizeGroups((prev) => (prev.length === 0 ? prev : []));
      });
    return () => {
      cancelled = true;
    };
  }, [explorerId, entry?.status, conn, sessionPassword]);
  let schemaMissingHint: string | null = null;
  if (conn) {
    try {
      const settings = getProviderSettings(conn.dialect);
      if (settings.schemaRequired && !conn.schema?.trim()) {
        schemaMissingHint = `${settings.label} needs a schema on the connection. Edit it under Credentials, pick a schema, then reload.`;
      }
    } catch {
      /* unknown dialect */
    }
  }

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1" data-testid="sql-schema-explorer">
      {!connectionsLoaded ? (
        <p className="text-xs font-medium text-slate-500">Loading connections…</p>
      ) : connections.length === 0 ? (
        <p className="text-xs font-medium text-slate-500">Save a connection to browse its tables.</p>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <select
              value={explorerId}
              onChange={(e) => selectExplorerId(e.target.value)}
              className="flex-1 min-w-0 bg-slate-950/80 border border-slate-700 rounded-md px-2 py-1 text-[12px] font-semibold text-slate-200 outline-none accent-focus"
              aria-label="Schema connection"
              data-testid="sql-schema-connection"
              title="Schema for this connection — stays in sync with Destination servers"
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  [{c.dialect}] {c.name || '(unnamed)'}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="Create new table (opens table blueprint)"
              disabled={!explorerId}
              data-testid="sql-new-table"
              onClick={openCreateTable}
              className="inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded-md text-[11px] font-bold text-emerald-300 bg-emerald-950/40 border border-emerald-700/50 hover:bg-emerald-900/50 disabled:opacity-40 transition"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
              New
            </button>
            <button data-testid="sql-reload-schema"
              type="button"
              title="Reload schema"
              disabled={!explorerId || entry?.status === 'loading'}
              onClick={() =>
                explorerId &&
                void ensureSchema(explorerId, { force: true, scope: entry?.scope })
              }
              className="p-1.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800/70 disabled:opacity-40 transition"
            >
              {entry?.status === 'loading' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" strokeWidth={SQL_ICON_STROKE} />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-cyan-400" strokeWidth={SQL_ICON_STROKE} />
              )}
            </button>
          </div>

          {schemaMissingHint && (
            <p className="text-[11px] text-amber-300 break-words font-medium" data-testid="sql-schema-missing">
              {schemaMissingHint}
            </p>
          )}
          {entry?.status === 'error' && (
            <p className="text-[11px] text-rose-400 break-words font-medium">{entry.error}</p>
          )}
          {entry?.status === 'loading' && totalCount === 0 && (
            <p className="text-[12px] font-medium text-slate-500 flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin text-cyan-400" strokeWidth={SQL_ICON_STROKE} /> Loading…
            </p>
          )}
          {entry?.status === 'ready' && totalCount === 0 && !schemaMissingHint && (
            <div className="flex flex-col gap-2 py-1" data-testid="sql-schema-empty">
              <p className="text-[12px] font-medium text-slate-500">
                No tables in this schema yet. Use New to open the table blueprint and add columns.
              </p>
              <button
                type="button"
                data-testid="sql-new-table-empty"
                disabled={!explorerId}
                onClick={openCreateTable}
                className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-bold text-emerald-200 bg-emerald-950/50 border border-emerald-600/40 hover:bg-emerald-900/60 disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                Create table
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 pr-0.5">
            {EXPLORER_GROUPS.map((g) => {
              const items = grouped.get(g.type) ?? [];
              const isRoutine = g.type === 'PROCEDURE' || g.type === 'FUNCTION';
              const routinesLoaded = (entry?.scope ?? []).includes('PROCEDURE');
              if (items.length === 0 && !isRoutine) return null;
              const open = expandedGroup[g.type] === true || (expandedGroup[g.type] !== false && !isRoutine);
              const meta = TYPE_META[g.type];
              return (
                <div key={g.type} data-testid={`sql-schema-group-${g.type}`}>
                  <button data-testid={`sql-schema-group-toggle-${g.type}`}
                    type="button"
                    onClick={() => {
                      const next = !open;
                      setExpandedGroup((m) => ({ ...m, [g.type]: next }));
                      if (next && isRoutine && !routinesLoaded && explorerId) {
                        void ensureSchema(explorerId, { scope: [...SCHEMA_ROUTINE_SCOPE] });
                      }
                    }}
                    className="w-full flex items-center gap-1.5 px-0.5 py-1 text-left sticky top-0 bg-slate-900 z-[1]"
                  >
                    {open ? (
                      <ChevronDown className="w-4 h-4 text-emerald-400 shrink-0" strokeWidth={SQL_ICON_STROKE} />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-emerald-400 shrink-0" strokeWidth={SQL_ICON_STROKE} />
                    )}
                    <span className="shrink-0">{meta.icon}</span>
                    <span className={`text-[12px] font-bold uppercase tracking-wider ${meta.color}`}>
                      {g.title}
                    </span>
                    <span className="text-[12px] font-mono text-slate-500">
                      ({isRoutine && !routinesLoaded ? '…' : items.length})
                    </span>
                    <span className="flex-1 h-px bg-slate-800/80 ml-1" />
                  </button>
                  {open && (
                    <div className="flex flex-col gap-0.5">
                      {items.map((t) => (
                        <ObjectNode
                          key={`${t.objectType}:${t.name}`}
                          table={t}
                          open={!!expandedObj[`${t.objectType}:${t.name}`]}
                          onToggle={() =>
                            setExpandedObj((m) => {
                              const k = `${t.objectType}:${t.name}`;
                              return { ...m, [k]: !m[k] };
                            })
                          }
                          dialect={conn?.dialect ?? 'sql'}
                          sizeGroup={sizeOf(t.name, conn?.schema)}
                          onOpenBlueprint={
                            t.objectType === 'TABLE' || t.objectType === 'MQT'
                              ? () => {
                                  setBlueprintMode('edit');
                                  setBlueprintTable(t);
                                }
                              : undefined
                          }
                          canPeek={
                            t.objectType === 'TABLE' ||
                            t.objectType === 'MQT' ||
                            t.objectType === 'VIEW'
                          }
                          onPeek={(name) => explorerId && void openDataPeek(explorerId, name)}
                          onOpenSource={
                            isScriptableObject(t.objectType)
                              ? () => void objectSourceScript(t, conn?.dialect ?? 'sql').then(setSql)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {(blueprintMode === 'create' || blueprintTable) && explorerId && (
            <TableBlueprintModal
              connectionId={explorerId}
              table={blueprintTable}
              mode={blueprintMode}
              dialect={conn?.dialect ?? 'sql'}
              onClose={() => {
                setBlueprintTable(null);
                setBlueprintMode('edit');
              }}
            />
          )}

        </>
      )}
    </div>
  );
});

const ObjectNode: React.FC<{
  table: TableSchema;
  open: boolean;
  onToggle: () => void;
  dialect: string;
  sizeGroup?: TableSizeGroup;
  onOpenBlueprint?: () => void;
  /** Data peek is only meaningful for row-bearing objects (not routines). */
  canPeek?: boolean;
  onPeek?: (tableName: string) => void;
  onOpenSource?: () => void;
}> = ({
  table,
  open,
  onToggle,
  dialect,
  sizeGroup,
  onOpenBlueprint,
  onOpenSource,
  canPeek,
  onPeek,
}) => {
  const meta = TYPE_META[table.objectType] ?? TYPE_META.TABLE;
  const insertName = quoteIdentifierIfNeeded(table.name, dialect);
  const isRoutine = table.objectType === 'PROCEDURE' || table.objectType === 'FUNCTION';
  const params = isRoutine ? filterCallParameters(table.parameters ?? []) : [];
  const columns = !isRoutine
    ? (table.columns ?? []).map((c) => ({ name: c.name, detail: c.type }))
    : [];
  const indexes = !isRoutine ? (table.indices ?? []) : [];
  const opensSource = Boolean(onOpenSource);
  const [openCols, setOpenCols] = useState(true);
  const [openIdx, setOpenIdx] = useState(true);

  const insertObject = () => {
    if (isRoutine) {
      insertAtCursor(routineInsertText(insertName, table.objectType, params));
      return;
    }
    // Tables/views: add into FROM with an auto alias (e.g. users u).
    const ok = mutateSql((sql) => addTableWithAliasToFrom(sql, insertName).sql);
    if (!ok) insertAtCursor(`${insertName} `);
  };

  const onNameClick = (e: React.MouseEvent) => {
    // Cmd (macOS) / Ctrl (Windows, Linux) + click = quick data peek.
    if (canPeek && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onPeek?.(table.name);
      return;
    }
    if (onOpenSource) {
      onOpenSource();
      return;
    }
    // Click the table name to expand columns + indexes (insert is the From button).
    onToggle();
  };

  const insertIdent = (name: string) => {
    insertAtCursor(`${quoteIdentifierIfNeeded(name, dialect)} `);
  };

  /** Prefer the short FROM alias when adding `alias.column` into SELECT. */
  const resolveTableAlias = (): string => {
    const sql = getCompletionContext().sql;
    return (
      existingShortAliasForTable(sql, table.name) ||
      existingShortAliasForTable(sql, insertName) ||
      insertName
    );
  };

  /** Add `alias.column` into the active SELECT list (or insert at cursor). */
  const insertColumnIntoSelect = (colName: string) => {
    const col = quoteIdentifierIfNeeded(colName, dialect);
    const expr = `${resolveTableAlias()}.${col}`;
    const ok = mutateSql((sql) => insertIntoSelectList(sql, expr));
    if (!ok) insertAtCursor(`${expr}, `);
  };

  return (
    <div className="min-w-0">
      {/*
       * The name is what the row is for, so it must never be the thing that
       * yields. It used to be the only thing that could: the trailing actions
       * are `shrink-0`, the name button was `flex-1 min-w-0`, so the whole
       * deficit landed on it. At the 288px default that left the name 45px
       * ("categories" needs 78, and rendered as "cate…"); at the 200px minimum
       * the sidebar allows, it rendered at *zero* width — eleven tables listed
       * and not one name on screen.
       *
       * So: a floor under the name, and `flex-wrap` to say what gives instead.
       * When the actions no longer fit beside a readable name they drop to
       * their own line rather than squeezing it. Nothing is hidden and no
       * behaviour changes — only which element absorbs the shortfall.
       */}
      <div className="flex flex-wrap items-center gap-0.5 min-w-0">
        <button data-testid={`sql-explorer-toggle-${table.name}`}
          type="button"
          onClick={onToggle}
          className="p-0.5 text-slate-500 hover:text-slate-300 shrink-0"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? (
            <ChevronDown className="w-4 h-4 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
          ) : (
            <ChevronRight className="w-4 h-4 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
          )}
        </button>
        <button
          type="button"
          data-testid={opensSource ? 'sql-open-object-source' : `sql-explorer-object-${table.name}`}
          title={
            opensSource
              ? `Open ${table.objectType.toLowerCase()} source in editor`
              : isRoutine
                ? `Insert ${table.name}(${params.map((p) => `${p.mode} ${p.name}`).join(', ')})`
                : canPeek
                  ? `Expand to show columns and indexes — ${peekModifierLabel()}-click to peek at its data`
                  : `Expand to show columns and indexes`
          }
          onClick={onNameClick}
          className="flex-1 flex items-center gap-1.5 min-w-[7rem] text-left text-[13px] font-semibold text-slate-200 hover:text-cyan-300 py-1"
        >
          <span className="shrink-0">{meta.icon}</span>
          <span className="flex flex-col min-w-0 flex-1">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="truncate font-mono font-bold">{table.name}</span>
              {!isRoutine && indexes.length > 0 && (
                <span className="shrink-0 text-[10px] font-mono font-medium text-slate-500">
                  {indexes.length} idx
                </span>
              )}
              {isRoutine && params.length > 0 && (
                <span className="shrink-0 text-[11px] font-mono font-medium text-slate-500 truncate max-w-[40%]">
                  ({params.length})
                </span>
              )}
            </span>
            {!isRoutine && sizeGroup && (
              <span
                className="text-[10px] font-mono font-medium text-slate-500 truncate"
                data-testid={`sql-explorer-table-stats-${table.name}`}
              >
                {formatRowCount(sizeGroup.rowCount)} rows · {formatBytes(sizeGroup.dataBytes)} data ·{' '}
                {formatBytes(sizeGroup.indexBytes)} idx
              </span>
            )}
          </span>
        </button>
        {/* One group, so the actions wrap as a unit instead of splitting apart. */}
        <span className="shrink-0 flex items-center gap-0.5">
          {onOpenBlueprint && (
            <button
              type="button"
              title={`Add ${table.name} to FROM with auto alias`}
              data-testid={`sql-explorer-from-${table.name}`}
              onClick={(e) => {
                e.stopPropagation();
                insertObject();
              }}
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-cyan-200 bg-cyan-950/60 border border-cyan-600/50 hover:bg-cyan-900/70 transition whitespace-nowrap"
            >
              From
            </button>
          )}
          {onOpenBlueprint && (
            <button
              type="button"
              title="Open table blueprint — add/edit columns"
              data-testid="sql-open-blueprint"
              onClick={(e) => {
                e.stopPropagation();
                onOpenBlueprint();
              }}
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-violet-200 bg-violet-950/60 border border-violet-600/50 hover:bg-violet-900/70 transition whitespace-nowrap"
            >
              <Columns3 className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
              Edit table
            </button>
          )}
          {opensSource && (
            <button
              type="button"
              title="Open source script in the editor (view only)"
              data-testid="sql-open-object-source-btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSource?.();
              }}
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-sky-200 bg-sky-950/60 border border-sky-600/50 hover:bg-sky-900/70 transition whitespace-nowrap"
            >
              <FileCode2 className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
              View source
            </button>
          )}
        </span>
      </div>
      {open && isRoutine && params.length === 0 && (
        <p className="ml-6 text-[12px] text-slate-600 mb-1">No parameters</p>
      )}
      {open && isRoutine && params.length > 0 && (
        <ul className="ml-6 border-l border-slate-700/80 pl-2.5 flex flex-col gap-0.5 mb-1">
          {params.map((p, i) => (
            <li key={`${p.mode}-${p.name}-${i}`}>
              <button data-testid={`sql-explorer-param-insert-${table.name}-${p.name}`}
                type="button"
                title={`Insert ${p.name} (${p.mode})`}
                onClick={() => insertIdent(p.name)}
                className="w-full flex items-center gap-1.5 min-w-0 text-left text-[12.5px] font-mono font-medium text-slate-300 hover:text-cyan-300 truncate py-1"
              >
                <span
                  className={`shrink-0 text-[10px] font-bold uppercase tracking-wide px-1 py-0.5 rounded border ${modeBadgeClass(p.mode)}`}
                >
                  {p.mode}
                </span>
                <span className="truncate font-bold">{p.name || `(arg ${i + 1})`}</span>
                {p.type ? (
                  <span className="text-slate-500 ml-auto shrink-0 font-sans text-[11px]">{p.type}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !isRoutine && columns.length > 0 && (
        <div className="ml-6 mb-0.5">
          <button data-testid={`sql-explorer-columns-toggle-${table.name}`}
            type="button"
            onClick={() => setOpenCols((v) => !v)}
            className="w-full flex items-center gap-1 px-0.5 py-0.5 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-300"
            aria-expanded={openCols}
          >
            {openCols ? (
              <ChevronDown className="w-3 h-3 text-sky-400/80" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <ChevronRight className="w-3 h-3 text-sky-400/80" strokeWidth={SQL_ICON_STROKE} />
            )}
            <Columns3 className="w-3 h-3 text-sky-400/80" strokeWidth={SQL_ICON_STROKE} />
            Columns
            <span className="font-mono font-medium">({columns.length})</span>
          </button>
          {openCols && (
            <ul className="border-l border-slate-700/80 pl-2.5 flex flex-col gap-0.5">
            {columns.map((col) => (
              <li key={col.name} className="flex items-center gap-1 min-w-0">
                <button data-testid={`sql-explorer-col-insert-${table.name}-${col.name}`}
                  type="button"
                  title={`Insert ${col.name} at cursor`}
                  onClick={() => insertIdent(col.name)}
                  className="flex-1 min-w-0 text-left text-[12.5px] font-mono font-medium text-slate-300 hover:text-cyan-300 truncate py-1"
                >
                  {col.name}
                  {col.detail ? (
                    <span className="text-slate-500 ml-1.5 font-sans text-[12px]">{col.detail}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  data-testid={`sql-explorer-col-select-${table.name}-${col.name}`}
                  title={`Add ${insertName}.${col.name} into SELECT`}
                  onClick={() => insertColumnIntoSelect(col.name)}
                  className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide text-cyan-300/90 border border-cyan-700/40 hover:bg-cyan-950/50"
                >
                  Sel
                </button>
              </li>
            ))}
            </ul>
          )}
        </div>
      )}
      {open && !isRoutine && indexes.length > 0 && (
        <div className="ml-6 mb-1" data-testid={`sql-explorer-indexes-${table.name}`}>
          <button data-testid={`sql-explorer-indexes-toggle-${table.name}`}
            type="button"
            onClick={() => setOpenIdx((v) => !v)}
            className="w-full flex items-center gap-1 px-0.5 py-0.5 text-left text-[10px] font-bold uppercase tracking-wide text-indigo-400/90 hover:text-indigo-200"
            aria-expanded={openIdx}
          >
            {openIdx ? (
              <ChevronDown className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <ChevronRight className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
            )}
            <Hash className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
            Indexes
            <span className="font-mono font-medium text-slate-500">({indexes.length})</span>
          </button>
          {openIdx && (
            <ul className="border-l border-indigo-900/60 pl-2.5 flex flex-col gap-0.5">
            {indexes.map((idx) => {
              const idxSize = lookupIndexSizeRow(sizeGroup, idx.name);
              return (
              <li key={idx.name} className="min-w-0">
                <button
                  type="button"
                  data-testid={`sql-explorer-index-${table.name}-${idx.name}`}
                  title={`Insert ${idx.name}`}
                  onClick={() => insertIdent(idx.name)}
                  className="w-full min-w-0 text-left text-[12.5px] font-mono font-medium text-slate-300 hover:text-indigo-300 truncate py-1"
                >
                  <span className="font-bold">{idx.name}</span>
                  <span className="ml-1.5 text-[10px] font-bold uppercase font-sans text-indigo-300/80">
                    {idx.unique ? 'unique' : 'non-unique'}
                  </span>
                  {idx.columns.length > 0 ? (
                    <span className="text-slate-500 ml-1.5 font-sans text-[11px]">
                      ({idx.columns.join(', ')})
                    </span>
                  ) : null}
                  {idxSize ? (
                    <span className="ml-1.5 text-[10px] font-sans text-slate-500">
                      {formatBytes(idxSize.indexBytes ?? idxSize.totalBytes)}
                      {idxSize.rowCount != null
                        ? ` · ${formatRowCount(idxSize.rowCount)} rows`
                        : ''}
                    </span>
                  ) : null}
                </button>
              </li>
              );
            })}
          </ul>
          )}
        </div>
      )}
    </div>
  );
};

function modeBadgeClass(mode: string): string {
  if (mode === 'OUT') return 'bg-amber-950/50 text-amber-300 border-amber-500/35';
  if (mode === 'INOUT') return 'bg-violet-950/50 text-violet-300 border-violet-500/35';
  return 'bg-cyan-950/50 text-cyan-300 border-cyan-500/35';
}

function routineInsertText(
  name: string,
  objectType: string,
  params: NonNullable<TableSchema['parameters']>
): string {
  const args = params
    .map((p) => {
      const label = p.name || p.mode;
      return `/* ${p.mode} ${label} */ ?`;
    })
    .join(', ');
  const callBody = args ? `(${args})` : '()';
  if (objectType === 'PROCEDURE') return `CALL ${name}${callBody}`;
  return `${name}${callBody}`;
}

