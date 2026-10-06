/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → Index Management: list indexes grouped by table, fetch
 * fragmentation via a credential, filter by table / %, defragment selected
 * or all matching indexes.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Database,
  Loader2,
  RefreshCw,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  buildIndexDefragSql,
  buildIndexDropSql,
  dialectSupportsDbaUtility,
  dialectSupportsIndexFragmentation,
  indexMaintenanceVerb,
  formatBytes,
  formatPct,
  formatRowCount,
  fragmentationSeverity,
  groupObjectSizes,
  indexTableSizeGroups,
  lookupIndexSizeRow,
  type TableSizeGroup,
} from '@foxschema/ui-shared';
import {
  fetchDbaUtility,
  fetchIndexFragmentationBatch,
  matchIndexFragmentationRow,
  type IndexFragmentationApiRow,
} from '@/shared/api/schemaApi';
import { executeSql } from '@/shared/api/sqlApi';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { useAuthStore } from '@/app/store/authStore';
import type { IndexInfo, TableSchema } from '@/shared/lib/types';
import { PROVIDER_SETTINGS, connectionNeedsSecret } from '@/shared/lib/provider-settings';
import {
  DEFAULT_INDEX_MGMT_SORT,
  averageFragmentation,
  formatIndexLastUsed,
  indexSortValue,
  latestLastUsedSortValue,
  nextIndexMgmtSort,
  pickLatestIndexUsage,
  sortGroupedIndexes,
  tableSortValue,
  type IndexMgmtSort,
  type IndexMgmtSortKey,
} from '@/features/utilities/lib/indexManagementGrid';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { connectionOptionLabel } from '@/shared/lib/dialectLabel';

interface Props {
  open: boolean;
  onClose?: () => void;
  /** Embed in Server Insights (no modal shell / credential picker). */
  embedded?: boolean;
  /** When set, the grid follows this credential instead of its own dropdown. */
  lockedConnectionId?: string;
}

type IndexRow = {
  key: string;
  tableName: string;
  index: IndexInfo;
  frag: IndexFragmentationApiRow | null;
  defragSql: string[];
  dropSql: string[];
  tableError?: string;
};

/**
 * Turn a before/after fragmentation reading into a sentence that distinguishes
 * the three outcomes a reader cannot otherwise tell apart.
 *
 * Running maintenance and seeing the same percentage looks exactly like a
 * button that does nothing — and usually it is not. An index with one leaf page
 * has no fragmentation to reclaim (Postgres reports NaN for it, which arrives
 * here as null), and an already-compact index legitimately does not move. Say
 * which happened.
 */
export function describeFragmentationChange(
  before: ReadonlyArray<number | null>,
  after: ReadonlyArray<number | null>
): string {
  const measured = (xs: ReadonlyArray<number | null>) =>
    xs.filter((x): x is number => x != null && Number.isFinite(x));
  const b = measured(before);
  const a = measured(after);

  if (b.length === 0 && a.length === 0) {
    return 'these indexes report no fragmentation figure — too small to measure, so there was nothing to reclaim.';
  }
  const avg = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
  const from = b.length ? avg(b) : null;
  const to = a.length ? avg(a) : null;
  if (from == null || to == null) return 'reloaded.';

  const delta = from - to;
  // Sub-0.5pt moves are noise on an estimate, not a result worth claiming.
  if (Math.abs(delta) < 0.5) {
    return from < 1
      ? 'these indexes were already compact, so the figure did not move.'
      : `fragmentation is unchanged at ${formatPct(from)} — this engine may need its statistics refreshed before the figure moves.`;
  }
  return delta > 0
    ? `fragmentation ${formatPct(from)} → ${formatPct(to)}.`
    : `fragmentation rose ${formatPct(from)} → ${formatPct(to)}, which usually means the rebuild is still settling.`;
}

function fragClass(severity: ReturnType<typeof fragmentationSeverity>): string {
  if (severity === 'ok') return 'text-emerald-300';
  if (severity === 'warn') return 'text-amber-300';
  if (severity === 'critical') return 'text-rose-300';
  return 'text-slate-400';
}

const LS_CONN = 'foxschema-utilities-index-mgmt-connection';

/** Utilities modal: credentials → indexes by table → filter → defragment. */
export const IndexManagementModal: React.FC<Props> = ({
  open,
  onClose,
  embedded = false,
  lockedConnectionId,
}) => {
  const connections = useSyncStore((s) => s.connections);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const canDropIndexes = useAuthStore(
    (s) => s.can('utility.index.drop') && s.can('editor.ddl')
  );

  const [connectionId, setConnectionId] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [minFragPct, setMinFragPct] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [fragByKey, setFragByKey] = useState<
    Record<string, { frag: IndexFragmentationApiRow | null; defragSql: string[]; tableError?: string }>
  >({});
  const [sizeGroups, setSizeGroups] = useState<TableSizeGroup[]>([]);
  // Indexed once per load: each table, and each index row while sorting, looks itself up.
  const sizeOf = useMemo(() => indexTableSizeGroups(sizeGroups), [sizeGroups]);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [loadingFrag, setLoadingFrag] = useState(false);
  const [runningDefrag, setRunningDefrag] = useState(false);
  const [runningDrop, setRunningDrop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDefrag, setConfirmDefrag] = useState<'selected' | 'filtered' | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<string[] | null>(null);
  const [sort, setSort] = useState<IndexMgmtSort>(DEFAULT_INDEX_MGMT_SORT);

  const initOpen = React.useRef(false);
  useEffect(() => {
    if (!open) {
      initOpen.current = false;
      return;
    }
    if (initOpen.current) return;
    initOpen.current = true;
    const saved = localStorage.getItem(LS_CONN) || '';
    const fallback = connections[0]?.id || '';
    const next = lockedConnectionId
      ? lockedConnectionId
      : connections.some((c) => c.id === saved)
        ? saved
        : fallback;
    setConnectionId(next);
    setError(null);
    setStatus(null);
    setFragByKey({});
    setSizeGroups([]);
    setSelected(new Set());
    setSort(DEFAULT_INDEX_MGMT_SORT);
  }, [open, connections, lockedConnectionId]);

  useEffect(() => {
    if (!open || !lockedConnectionId) return;
    setConnectionId(lockedConnectionId);
    setFragByKey({});
    setSizeGroups([]);
    setSelected(new Set());
  }, [open, lockedConnectionId]);

  const conn = connections.find((c) => c.id === connectionId) || null;
  // File dialects carry no password; asking for one blocked the utility outright.
  const needsPassword = Boolean(
    conn && !conn.hasPassword && connectionNeedsSecret(conn.dialect, conn.authMethod) && !sessionPasswords[connectionId]
  );
  const cache = connectionId ? schemaCache[connectionId] : undefined;
  /**
   * The failure to show, from whichever path found it.
   *
   * `error` is only set by loads this modal started. The schema is shared, so
   * the Schema panel can discover the database is unreachable first and cache
   * that — leaving the modal with a null error and an empty table, which it
   * then reported as "this schema has no indexes". An empty list and an
   * unreachable database are not the same answer.
   */
  const loadError = error || (cache?.status === 'error' ? cache.error ?? 'Failed to load schema' : null);
  /** The engine's own word for this maintenance, not SQL Server's for all of them. */
  const maintenanceVerb = indexMaintenanceVerb(conn?.dialect || '');
  const fragSupport = useMemo(
    () => dialectSupportsIndexFragmentation(conn?.dialect || ''),
    [conn?.dialect]
  );

  const tablesWithIndexes: TableSchema[] = useMemo(() => {
    const tables = cache?.tables ?? [];
    return tables
      .filter((t) => t.objectType === 'TABLE' || t.objectType === 'MQT')
      .filter((t) => (t.indices?.length ?? 0) > 0)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [cache?.tables]);

  const allRows: IndexRow[] = useMemo(() => {
    const dialect = conn?.dialect || '';
    const schema = conn?.schema?.trim() || '';
    const rows: IndexRow[] = [];
    for (const table of tablesWithIndexes) {
      for (const index of table.indices ?? []) {
        const key = `${table.name}::${index.name}`;
        const hit = fragByKey[key];
        const frag = hit?.frag ?? null;
        const defragSql =
          hit?.defragSql?.length
            ? hit.defragSql
            : buildIndexDefragSql({
                dialect,
                schema,
                table: table.name,
                indexName: index.name,
                fragmentationPercent: frag?.fragmentationPercent,
              });
        const dropSql = buildIndexDropSql({
          dialect,
          schema,
          table: table.name,
          indexName: index.name,
          constraint: index.constraint,
        });
        rows.push({
          key,
          tableName: table.name,
          index,
          frag,
          defragSql,
          dropSql,
          tableError: hit?.tableError,
        });
      }
    }
    return rows;
  }, [tablesWithIndexes, fragByKey, conn?.dialect, conn?.schema]);

  const filteredRows = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    const minPct = minFragPct.trim() === '' ? null : Number(minFragPct);
    return allRows.filter((row) => {
      if (q && !row.tableName.toLowerCase().includes(q) && !row.index.name.toLowerCase().includes(q)) {
        return false;
      }
      if (minPct != null && Number.isFinite(minPct)) {
        const pct = row.frag?.fragmentationPercent;
        if (pct == null || !Number.isFinite(pct) || pct < minPct) return false;
      }
      return true;
    });
  }, [allRows, tableFilter, minFragPct]);

  const grouped = useMemo(() => {
    const map = new Map<string, IndexRow[]>();
    for (const row of filteredRows) {
      const list = map.get(row.tableName) ?? [];
      list.push(row);
      map.set(row.tableName, list);
    }
    const groups = [...map.entries()].map(([tableName, rows]) => {
      const size = sizeOf(tableName, conn?.schema);
      return {
        tableName,
        rows,
        indexCount: rows.length,
        avgFrag: averageFragmentation(rows.map((r) => r.frag?.fragmentationPercent)),
        lastUsedMs: latestLastUsedSortValue(
          rows.map((r) => ({ lastUsed: r.frag?.lastUsed, scanCount: r.frag?.scanCount }))
        ),
        rowCount: size?.rowCount ?? null,
        dataBytes: size?.dataBytes ?? null,
        indexBytes: size?.indexBytes ?? null,
      };
    });
    return sortGroupedIndexes(
      groups,
      sort,
      (g) => tableSortValue(sort.key, g),
      (row, g) => {
        const size = sizeOf(g.tableName, conn?.schema);
        const idxSize = lookupIndexSizeRow(size, row.index.name);
        return indexSortValue(sort.key, {
          indexName: row.index.name,
          columns: row.index.columns.join(', '),
          type: row.index.constraint
            ? 'constraint'
            : row.index.unique
              ? 'unique'
              : 'duplicates ok',
          rowCount: idxSize?.rowCount ?? null,
          dataBytes: null,
          indexBytes: idxSize?.indexBytes ?? idxSize?.totalBytes ?? null,
          fragPct: row.frag?.fragmentationPercent ?? null,
          lastUsed: row.frag?.lastUsed ?? null,
          scanCount: row.frag?.scanCount ?? null,
        });
      },
      (row) => row.index.name
    );
  }, [filteredRows, sizeOf, sort, conn?.schema]);

  const groupedTableKey = grouped.map((g) => g.tableName).join('\0');

  // A table/index filter should reveal matching rows, not leave them collapsed.
  useEffect(() => {
    if (!tableFilter.trim() && !minFragPct.trim()) return;
    setExpanded(new Set(groupedTableKey.split('\0').filter(Boolean)));
  }, [tableFilter, minFragPct, groupedTableKey]);

  const applyFragBatch = useCallback(
    (
      results: Awaited<ReturnType<typeof fetchIndexFragmentationBatch>>['results'],
      dialect: string,
      schema: string | undefined,
      tables: TableSchema[]
    ) => {
      const next: typeof fragByKey = {};
      let okTables = 0;
      let failTables = 0;
      for (const result of results) {
        if (!result.ok) {
          failTables += 1;
          const table = tables.find((t) => t.name === result.table);
          for (const index of table?.indices ?? []) {
            next[`${result.table}::${index.name}`] = {
              frag: null,
              defragSql: buildIndexDefragSql({
                dialect,
                schema,
                table: result.table,
                indexName: index.name,
              }),
              tableError: result.error,
            };
          }
          continue;
        }
        okTables += 1;
        const table = tables.find((t) => t.name === result.table);
        for (const index of table?.indices ?? []) {
          const frag = matchIndexFragmentationRow(index.name, result.rows);
          const defragKey =
            (frag && (result.defrag[frag.indexName] || result.defrag[frag.indexName.toLowerCase()])) ||
            result.defrag[index.name] ||
            result.defrag[index.name.toLowerCase()];
          const defragSql =
            defragKey ??
            buildIndexDefragSql({
              dialect,
              schema,
              table: result.table,
              indexName: index.name,
              fragmentationPercent: frag?.fragmentationPercent,
            });
          next[`${result.table}::${index.name}`] = { frag, defragSql };
        }
      }
      setFragByKey(next);
      return { okTables, failTables };
    },
    []
  );

  const fetchFragmentation = useCallback(
    async (tables = tablesWithIndexes) => {
      if (!connectionId || !conn) return;
      if (needsPassword) {
        setError('Enter the session password for this credential first.');
        return;
      }
      const tableNames = tables.map((t) => t.name);
      if (tableNames.length === 0) {
        setError('No indexed tables in the loaded schema — click Load indexes first.');
        return;
      }
      setLoadingFrag(true);
      setError(null);
      setStatus(null);
      try {
        const chunks: string[][] = [];
        for (let i = 0; i < tableNames.length; i += 80) {
          chunks.push(tableNames.slice(i, i + 80));
        }
        const allResults: Awaited<ReturnType<typeof fetchIndexFragmentationBatch>>['results'] =
          [];
        for (const chunk of chunks) {
          const batch = await fetchIndexFragmentationBatch(
            {
              connectionId,
              password: sessionPasswords[connectionId] || undefined,
              schema: conn.schema?.trim() || undefined,
            },
            { tables: chunk, schema: conn.schema?.trim() || undefined }
          );
          allResults.push(...batch.results);
        }
        const { okTables, failTables } = applyFragBatch(
          allResults,
          conn.dialect,
          conn.schema,
          tables
        );
        setStatus(
          `Fragmentation loaded for ${okTables} table(s)` +
            (failTables ? `; ${failTables} failed` : '') +
            `. ${fragSupport.hint}`
        );
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingFrag(false);
      }
    },
    [
      connectionId,
      conn,
      needsPassword,
      tablesWithIndexes,
      sessionPasswords,
      fragSupport.hint,
      applyFragBatch,
    ]
  );

  const fetchSizes = useCallback(async () => {
    if (!connectionId || !conn || needsPassword) return;
    if (!dialectSupportsDbaUtility(conn.dialect, 'sizes').query) {
      setSizeGroups([]);
      return;
    }
    try {
      const result = await fetchDbaUtility(
        {
          connectionId,
          password: sessionPasswords[connectionId] || undefined,
        },
        { kind: 'sizes', schema: conn.schema?.trim() || undefined }
      );
      setSizeGroups(groupObjectSizes(result.sizes ?? []));
    } catch {
      setSizeGroups([]);
    }
  }, [connectionId, conn, needsPassword, sessionPasswords]);

  const loadSchema = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!connectionId) return;
      setLoadingSchema(true);
      setError(null);
      setStatus(null);
      try {
        ensureConnectionSelected(connectionId);
        await ensureSchema(connectionId, { force: opts?.force ?? true });
        const entry = useSqlEditorStore.getState().schemaCache[connectionId];
        if (entry?.status === 'error') {
          setError(entry.error || 'Failed to load schema');
          return;
        }
        const tables = (entry?.tables ?? [])
          .filter((t) => t.objectType === 'TABLE' || t.objectType === 'MQT')
          .filter((t) => (t.indices?.length ?? 0) > 0)
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name));
        const n = tables.reduce((acc, t) => acc + (t.indices?.length ?? 0), 0);
        setStatus(
          n === 0
            ? 'No indexes in this schema.'
            : `Loaded ${n} ${n === 1 ? 'index' : 'indexes'} from the schema catalog.`
        );
        setExpanded(new Set(tables.map((t) => t.name)));
        setLoadingSchema(false);
        const extra: Promise<void>[] = [];
        extra.push(fetchSizes());
        // Same path as Edit Table: load % automatically so Utilities is not empty.
        if (tables.length > 0 && conn && !needsPassword) {
          extra.push(fetchFragmentation(tables));
        }
        await Promise.all(extra);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingSchema(false);
      }
    },
    [
      connectionId,
      ensureConnectionSelected,
      ensureSchema,
      conn,
      needsPassword,
      fetchFragmentation,
      fetchSizes,
    ]
  );

  // On open (and when the credential changes), load indexes + fragmentation —
  // Edit Table already auto-refreshes %; Utilities must too.
  const lastAutoKey = React.useRef('');
  useEffect(() => {
    if (!open) {
      lastAutoKey.current = '';
      return;
    }
    if (!connectionId || needsPassword) {
      // Allow a retry once the session password is saved.
      if (needsPassword) lastAutoKey.current = '';
      return;
    }
    const key = connectionId;
    if (lastAutoKey.current === key) return;
    lastAutoKey.current = key;
    void loadSchema({ force: false });
  }, [open, connectionId, needsPassword, loadSchema]);

  /** Current fragmentation for the given rows, in the order given. */
  const readFragmentation = useCallback(
    (keys: string[]): Array<number | null> =>
      keys.map((k) => allRows.find((r) => r.key === k)?.frag?.fragmentationPercent ?? null),
    [allRows]
  );

  const runDefrag = useCallback(
    async (keys: string[]) => {
      if (!connectionId || !conn || keys.length === 0) return;
      if (needsPassword) {
        setError('Enter the session password for this credential first.');
        return;
      }
      const statements: string[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        const row = allRows.find((r) => r.key === key);
        if (!row?.defragSql.length) continue;
        for (const stmt of row.defragSql) {
          if (stmt.trim().startsWith('--')) continue;
          if (seen.has(stmt)) continue;
          seen.add(stmt);
          statements.push(stmt);
        }
      }
      if (statements.length === 0) {
        setError('No defragment SQL available for the selection.');
        return;
      }
      setRunningDefrag(true);
      setError(null);
      setStatus(null);
      // Read the numbers first so the outcome can be stated as a change rather
      // than left for the reader to eyeball. "Ran 5 statements" and an
      // unmoved percentage is indistinguishable from a broken button.
      const before = readFragmentation(keys);
      try {
        const { results } = await executeSql(
          {
            connectionId,
            password: sessionPasswords[connectionId] || undefined,
          },
          statements
        );
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          setError(
            failed
              .map((r) => ('error' in r ? r.error : 'failed'))
              .slice(0, 3)
              .join(' · ')
          );
        } else {
          const ran = `${maintenanceVerb.toLowerCase()}: ran ${statements.length} ${
            statements.length === 1 ? 'statement' : 'statements'
          }`;
          setSelected(new Set());
          // The refresh sets its own status when it lands, so setting ours
          // first meant the only confirmation the reader ever got was wiped
          // milliseconds later — the click looked like it did nothing. Wait
          // for the reload, then say what happened.
          await fetchFragmentation();
          setStatus(`${ran} — ${describeFragmentationChange(before, readFragmentation(keys))}`);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunningDefrag(false);
        setConfirmDefrag(null);
      }
    },
    [
      connectionId,
      conn,
      needsPassword,
      allRows,
      sessionPasswords,
      fetchFragmentation,
      maintenanceVerb,
      readFragmentation,
    ]
  );

  const runDrop = useCallback(
    async (keys: string[]) => {
      if (!connectionId || !conn || keys.length === 0) return;
      if (!canDropIndexes) {
        setError('Drop indexes requires the Drop indexes and Change schema permissions.');
        return;
      }
      if (needsPassword) {
        setError('Enter the session password for this credential first.');
        return;
      }
      const statements: string[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        const row = allRows.find((r) => r.key === key);
        if (!row?.dropSql.length) continue;
        for (const stmt of row.dropSql) {
          if (stmt.trim().startsWith('--')) continue;
          if (seen.has(stmt)) continue;
          seen.add(stmt);
          statements.push(stmt);
        }
      }
      if (statements.length === 0) {
        setError(
          'No DROP INDEX SQL for the selection. Constraint-backed indexes must be dropped from Edit table.'
        );
        return;
      }
      setRunningDrop(true);
      setError(null);
      setStatus(null);
      try {
        const { results } = await executeSql(
          {
            connectionId,
            password: sessionPasswords[connectionId] || undefined,
          },
          statements
        );
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          setError(
            failed
              .map((r) => ('error' in r ? r.error : 'failed'))
              .slice(0, 3)
              .join(' · ')
          );
        } else {
          setStatus(`Dropped ${statements.length} index(es). Reloading schema…`);
          setSelected(new Set());
          ensureConnectionSelected(connectionId);
          await ensureSchema(connectionId, { force: true });
          void fetchFragmentation();
          void fetchSizes();
          setStatus(`Dropped ${statements.length} index(es).`);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunningDrop(false);
        setConfirmDrop(null);
      }
    },
    [
      connectionId,
      conn,
      canDropIndexes,
      needsPassword,
      allRows,
      sessionPasswords,
      ensureConnectionSelected,
      ensureSchema,
      fetchFragmentation,
      fetchSizes,
    ]
  );

  const toggleExpand = (table: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filteredKeys = filteredRows.map((r) => r.key);
  const allFilteredSelected =
    filteredKeys.length > 0 && filteredKeys.every((k) => selected.has(k));

  if (!open) return null;

  const content = (
    <>
      {!embedded && (
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/50 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Database className="w-4 h-4 text-amber-400" />
              Index Management
            </h2>
            {/* Three sentences of instructions for a table that demonstrates
                itself. What the reader cannot guess is what this panel is for
                and what it can change — the rest they learn by clicking. */}
            <p className="text-[11px] text-slate-500 mt-0.5">
              Index health per table — how fragmented each one is, and when it was last used.
            </p>
          </div>
          <button data-testid="index-mgmt-close"
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

        <div className="px-5 py-3 border-b border-slate-800 space-y-2.5 shrink-0 bg-slate-950/30">
          <div className="flex flex-wrap items-end gap-2">
            {!lockedConnectionId && (
            <label className="flex flex-col gap-1 min-w-[14rem] flex-1">
              <span className={sectionLabelCls}>
                Credential
              </span>
              <select
                data-testid="index-mgmt-connection"
                value={connectionId}
                onChange={(e) => {
                  const id = e.target.value;
                  setConnectionId(id);
                  if (!lockedConnectionId) localStorage.setItem(LS_CONN, id);
                  setFragByKey({});
                  setSizeGroups([]);
                  setSelected(new Set());
                  setPasswordDraft('');
                  setError(null);
                }}
                className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus"
              >
                <option value="">— Select credential —</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {connectionOptionLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            )}
            {needsPassword && (
              <label className="flex flex-col gap-1 min-w-[10rem]">
                <span className={sectionLabelCls}>
                  Session password
                </span>
                <div className="flex gap-1">
                  <input
                    type="password"
                    data-testid="index-mgmt-password"
                    value={passwordDraft}
                    onChange={(e) => setPasswordDraft(e.target.value)}
                    placeholder="••••••••"
                    className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus font-mono w-36"
                  />
                  <button data-testid="index-mgmt-save"
                    type="button"
                    className="px-2.5 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100"
                    onClick={() => {
                      if (!connectionId || !passwordDraft) return;
                      // ensureConnectionSelected sets pendingPassword; submit stores it.
                      ensureConnectionSelected(connectionId);
                      submitSessionPassword(passwordDraft);
                      setPasswordDraft('');
                    }}
                  >
                    Save
                  </button>
                </div>
              </label>
            )}
            <button
              type="button"
              data-testid="index-mgmt-load"
              disabled={!connectionId || loadingSchema || needsPassword}
              onClick={() => void loadSchema({ force: true })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-50"
            >
              {loadingSchema ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Load indexes
            </button>
            <button
              type="button"
              data-testid="index-mgmt-fetch-frag"
              disabled={!connectionId || loadingFrag || tablesWithIndexes.length === 0 || needsPassword}
              onClick={() => void fetchFragmentation()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
            >
              {loadingFrag ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Fetch fragmentation
            </button>
          </div>

          {/* Filters and bulk actions only mean something once there are rows
              to filter and act on. Shown before that, they are six disabled
              controls between the reader and the one button that does anything
              — and three of them count "(0)" of a list that has not loaded. */}
          <div
            className={`flex flex-wrap items-end gap-2 ${grouped.length === 0 ? 'hidden' : ''}`}
          >
            <label
              className="flex flex-col gap-1 min-w-[12rem] flex-1"
              data-testid={embedded ? 'server-insights-size-filter' : undefined}
            >
              <span className={sectionLabelCls}>
                Filter table / index
              </span>
              <input
                data-testid="index-mgmt-table-filter"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                placeholder="e.g. ORDER"
                className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 w-36">
              <span className={sectionLabelCls}>
                Min frag %
              </span>
              <input
                data-testid="index-mgmt-min-frag"
                type="number"
                min={0}
                max={100}
                step={1}
                value={minFragPct}
                onChange={(e) => setMinFragPct(e.target.value)}
                placeholder="e.g. 10"
                className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus font-mono"
              />
            </label>
            <button
              type="button"
              data-testid="index-mgmt-expand-all"
              disabled={grouped.length === 0}
              onClick={() => setExpanded(new Set(grouped.map((g) => g.tableName)))}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <ChevronDown className="w-3.5 h-3.5" />
              Expand tables
            </button>
            <button
              type="button"
              data-testid="index-mgmt-collapse-all"
              disabled={grouped.length === 0}
              onClick={() => setExpanded(new Set())}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <ChevronRight className="w-3.5 h-3.5" />
              Collapse tables
            </button>
            <button
              type="button"
              data-testid="index-mgmt-select-filtered"
              disabled={filteredKeys.length === 0}
              onClick={() => {
                if (allFilteredSelected) setSelected(new Set());
                else setSelected(new Set(filteredKeys));
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {allFilteredSelected ? (
                <CheckSquare className="w-3.5 h-3.5" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )}
              {allFilteredSelected ? 'Clear selection' : 'Select filtered'}
            </button>
            {/* Some engines have no index maintenance at all — CockroachDB
                rejects REINDEX and says it does not require one, YugabyteDB
                has not implemented it. Offering the button anyway meant a
                click that failed with "No defragment SQL available for the
                selection", which reads as the feature being broken. Say the
                engine has nothing to run instead. */}
            {fragSupport.defrag ? (
              <>
                <button
                  type="button"
                  data-testid="index-mgmt-defrag-selected"
                  disabled={selected.size === 0 || runningDefrag || runningDrop}
                  onClick={() => setConfirmDefrag('selected')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-rose-500/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25 disabled:opacity-50"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  {maintenanceVerb} selected ({selected.size})
                </button>
                <button
                  type="button"
                  data-testid="index-mgmt-defrag-filtered"
                  disabled={filteredKeys.length === 0 || runningDefrag || runningDrop}
                  onClick={() => setConfirmDefrag('filtered')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  {maintenanceVerb} filtered ({filteredKeys.length})
                </button>
              </>
            ) : (
              <span
                data-testid="index-mgmt-no-defrag"
                className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-slate-400"
              >
                <Wrench className="w-3.5 h-3.5 text-slate-600" />
                No index maintenance on {conn?.dialect || 'this engine'} — it compacts indexes
                itself.
              </span>
            )}
            <button
              type="button"
              data-testid="index-mgmt-drop-selected"
              disabled={
                !canDropIndexes ||
                selected.size === 0 ||
                runningDefrag ||
                runningDrop
              }
              title={
                canDropIndexes
                  ? 'Drop selected secondary indexes. Constraint-backed indexes are skipped.'
                  : 'Requires Drop indexes and Change schema (grant these in Access control).'
              }
              onClick={() => {
                const keys = [...selected].filter((k) => {
                  const row = allRows.find((r) => r.key === k);
                  return Boolean(row?.dropSql.length);
                });
                if (keys.length === 0) {
                  setError(
                    'Nothing droppable in the selection. Constraint-backed indexes must be dropped from Edit table.'
                  );
                  return;
                }
                setConfirmDrop(keys);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Drop selected ({selected.size})
            </button>
          </div>

          {(loadError || status) && (
            <p
              className={`text-[11px] ${loadError ? 'text-rose-300' : 'text-slate-400'}`}
              data-testid="index-mgmt-status"
            >
              {loadError || status}
              {safeMode && (confirmDefrag || confirmDrop)
                ? ' Safe mode is on — confirm carefully before running rebuild/reorg or DROP INDEX.'
                : ''}
            </p>
          )}
        </div>

        <div
          className="flex-1 min-h-0 overflow-auto"
          data-testid={embedded ? 'server-insights-size-groups' : undefined}
        >
          {grouped.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              {/* An empty list and a failed read are not the same thing, and
                  saying "no indexes" for a database that could not be reached
                  sends the reader looking for missing indexes instead of a
                  missing connection. */}
              {!connectionId
                ? 'Select a credential to begin.'
                : loadError
                  ? 'Could not read the indexes.'
                  : loadingSchema
                    ? 'Reading indexes…'
                    : 'This schema has no indexes.'}
            </p>
          ) : (
            <table
              className="w-full text-left border-collapse"
              data-testid="index-mgmt-groups"
            >
              <thead className="sticky top-0 z-10">
                <tr
                  className="bg-slate-950 text-[10px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-800 shadow-[0_1px_0_0_rgb(30_41_59)]"
                  data-testid="index-mgmt-table-header"
                >
                  <th className="w-8 pl-3 pr-1 py-2 font-bold" aria-label="Select" />
                  <SortableTh
                    label="Table / index"
                    column="name"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2"
                  />
                  <SortableTh
                    label="Columns"
                    column="columns"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 hidden sm:table-cell"
                  />
                  <SortableTh
                    label="Type"
                    column="type"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 w-28"
                  />
                  <SortableTh
                    label="Indexes"
                    column="indexes"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 w-20"
                    align="right"
                  />
                  <SortableTh
                    label="Rows"
                    column="rows"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 w-24"
                    align="right"
                  />
                  <SortableTh
                    label="Data"
                    column="data"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 w-24"
                    align="right"
                  />
                  <SortableTh
                    label="Index size"
                    column="indexSize"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 w-24"
                    align="right"
                  />
                  <SortableTh
                    label="Frag %"
                    column="frag"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 w-20"
                    align="right"
                  />
                  <SortableTh
                    label="Last used"
                    column="lastUsed"
                    sort={sort}
                    onSort={(key) => setSort((s) => nextIndexMgmtSort(s, key))}
                    className="px-2 py-2 w-32"
                    align="right"
                  />
                  <th className="px-3 py-2 font-bold w-40 text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((group) => {
                  const { tableName, rows, indexCount, avgFrag } = group;
                  const openGroup = expanded.has(tableName);
                  const tableKeys = rows.map((r) => r.key);
                  const tableAllSelected =
                    tableKeys.length > 0 && tableKeys.every((k) => selected.has(k));
                  const tableSomeSelected = tableKeys.some((k) => selected.has(k));
                  const size = sizeOf(tableName, conn?.schema);
                  const avgSeverity = fragmentationSeverity(avgFrag);
                  const tableUsage = pickLatestIndexUsage(
                    rows.map((r) => ({
                      lastUsed: r.frag?.lastUsed,
                      scanCount: r.frag?.scanCount,
                    }))
                  );
                  return (
                    <React.Fragment key={tableName}>
                      <tr
                        className="bg-slate-900/90 border-y border-slate-800 cursor-pointer"
                        data-testid={`index-mgmt-group-${tableName}`}
                        data-expanded={openGroup ? 'true' : 'false'}
                        onClick={() => toggleExpand(tableName)}
                      >
                        <td className="pl-3 pr-1 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <button data-testid={`index-mgmt-table-toggle-${tableName}`}
                              type="button"
                              className="p-0.5 text-slate-400 hover:text-slate-100 shrink-0"
                              aria-expanded={openGroup}
                              aria-label={openGroup ? `Collapse ${tableName}` : `Expand ${tableName}`}
                            >
                              {openGroup ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button data-testid={`index-mgmt-table-select-${tableName}`}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (tableAllSelected) {
                                    for (const k of tableKeys) next.delete(k);
                                  } else {
                                    for (const k of tableKeys) next.add(k);
                                  }
                                  return next;
                                });
                              }}
                              className="text-slate-400 hover:text-slate-100 shrink-0"
                              aria-label={`Select indexes on ${tableName}`}
                            >
                              {tableAllSelected ? (
                                <CheckSquare className="w-3.5 h-3.5 text-amber-300" />
                              ) : tableSomeSelected ? (
                                <CheckSquare className="w-3.5 h-3.5 text-amber-300/50" />
                              ) : (
                                <Square className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 min-w-0">
                          <span className="font-mono text-sm font-semibold text-slate-100 truncate">
                            {tableName}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 hidden sm:table-cell" />
                        <td className="px-2 py-1.5 text-[10px] font-bold uppercase text-cyan-300/80">
                          table
                        </td>
                        <td
                          className="px-2 py-1.5 text-right tabular-nums font-semibold text-slate-100"
                          data-testid={`index-mgmt-table-index-count-${tableName}`}
                          title="Indexes on this table"
                        >
                          {indexCount}
                        </td>
                        <td
                          className="px-2 py-1.5 text-right tabular-nums font-semibold text-slate-100"
                          data-testid={`index-mgmt-table-rows-${tableName}`}
                        >
                          {formatRowCount(size?.rowCount)}
                        </td>
                        <td
                          className="px-2 py-1.5 text-right tabular-nums text-slate-200"
                          data-testid={`index-mgmt-table-data-${tableName}`}
                        >
                          {formatBytes(size?.dataBytes)}
                        </td>
                        <td
                          className="px-2 py-1.5 text-right tabular-nums text-slate-200"
                          data-testid={`index-mgmt-table-index-size-${tableName}`}
                        >
                          {formatBytes(size?.indexBytes)}
                        </td>
                        <td
                          className={`px-2 py-1.5 text-right font-bold tabular-nums ${fragClass(avgSeverity)}`}
                          data-testid={`index-mgmt-table-avg-frag-${tableName}`}
                          title="Average fragmentation of indexes on this table"
                        >
                          <span className="mr-1 text-[9px] font-bold uppercase tracking-wide text-slate-500">
                            avg
                          </span>
                          {formatPct(avgFrag)}
                        </td>
                        <td
                          className="px-2 py-1.5 text-right tabular-nums text-slate-300"
                          data-testid={`index-mgmt-table-last-used-${tableName}`}
                          title="Most recent index usage on this table"
                        >
                          {formatIndexLastUsed(tableUsage)}
                        </td>
                        <td />
                      </tr>
                      {openGroup &&
                        rows.map((row) => {
                          const severity = fragmentationSeverity(row.frag?.fragmentationPercent);
                          const idxSize = lookupIndexSizeRow(size, row.index.name);
                          return (
                            <tr
                              key={row.key}
                              className="border-b border-slate-800/70 bg-slate-950/40 hover:bg-slate-900/50 text-[12px]"
                              data-testid={`index-mgmt-row-${row.key}`}
                            >
                              <td className="pl-8 pr-1 py-2 align-top">
                                <button data-testid={`index-mgmt-toggle-selected-${row.key}`}
                                  type="button"
                                  onClick={() => toggleSelected(row.key)}
                                  className="text-slate-400 hover:text-slate-100"
                                  aria-label={`Select ${row.index.name}`}
                                >
                                  {selected.has(row.key) ? (
                                    <CheckSquare className="w-3.5 h-3.5 text-amber-300" />
                                  ) : (
                                    <Square className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </td>
                              <td className="px-2 py-2 align-top min-w-0">
                                <div className="font-mono font-semibold text-slate-200 truncate">
                                  {row.index.name}
                                </div>
                                <div className="font-mono text-slate-500 truncate sm:hidden">
                                  ({row.index.columns.join(', ')})
                                </div>
                                {row.tableError ? (
                                  <div className="text-[10px] text-rose-300/90 mt-0.5">
                                    {row.tableError}
                                  </div>
                                ) : null}
                              </td>
                              <td className="px-2 py-2 align-top hidden sm:table-cell">
                                <span className="font-mono text-slate-400 break-all">
                                  {row.index.columns.join(', ') || '—'}
                                  {row.index.filter?.trim()
                                    ? ` WHERE ${row.index.filter.trim()}`
                                    : ''}
                                </span>
                              </td>
                              <td className="px-2 py-2 align-top">
                                <span className="text-[10px] font-bold uppercase text-sky-300/80">
                                  {row.index.unique ? 'unique' : 'duplicates ok'}
                                </span>
                                {row.index.constraint ? (
                                  <span className="ml-1 text-[10px] font-bold uppercase text-amber-300/80">
                                    constraint
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-2 py-2 align-top text-right tabular-nums text-slate-600">
                                —
                              </td>
                              <td className="px-2 py-2 align-top text-right tabular-nums text-slate-400">
                                {formatRowCount(idxSize?.rowCount)}
                              </td>
                              <td className="px-2 py-2 align-top text-right tabular-nums text-slate-600">
                                —
                              </td>
                              <td className="px-2 py-2 align-top text-right tabular-nums text-slate-200">
                                {formatBytes(idxSize?.indexBytes ?? idxSize?.totalBytes)}
                              </td>
                              <td
                                className={`px-2 py-2 align-top text-right font-bold tabular-nums ${fragClass(severity)}`}
                                title={row.frag ? 'Fragmentation percent' : 'Fetch fragmentation'}
                              >
                                {formatPct(row.frag?.fragmentationPercent)}
                              </td>
                              <td
                                className="px-2 py-2 align-top text-right tabular-nums text-slate-300"
                                data-testid={`index-mgmt-last-used-${row.key}`}
                                title={
                                  row.frag?.scanCount != null
                                    ? `${row.frag.scanCount.toLocaleString()} scans/seeks`
                                    : 'Last used (when the engine reports it)'
                                }
                              >
                                {formatIndexLastUsed({
                                  lastUsed: row.frag?.lastUsed,
                                  scanCount: row.frag?.scanCount,
                                })}
                              </td>
                              <td className="px-3 py-2 align-top text-right">
                                <div className="inline-flex items-center justify-end gap-1">
                                  <button data-testid={`index-mgmt-defragment-${row.key}`}
                                    type="button"
                                    disabled={!row.defragSql.length || runningDefrag || runningDrop}
                                    title={row.defragSql.join('\n') || 'No defrag SQL'}
                                    onClick={() => void runDefrag([row.key])}
                                    className="inline-flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-[11px] font-bold text-slate-200 hover:border-amber-400/50 hover:text-amber-100 disabled:opacity-40"
                                  >
                                    <Wrench className="w-3 h-3" />
                                    Defragment
                                  </button>
                                  <button
                                    type="button"
                                    data-testid={`index-mgmt-drop-${row.key}`}
                                    disabled={
                                      !canDropIndexes ||
                                      !row.dropSql.length ||
                                      runningDefrag ||
                                      runningDrop
                                    }
                                    title={
                                      !canDropIndexes
                                        ? 'Requires Drop indexes and Change schema (Access control).'
                                        : row.index.constraint
                                          ? 'Constraint-backed index — drop it from Edit table.'
                                          : row.dropSql.join('\n') || 'No DROP INDEX SQL for this dialect'
                                    }
                                    onClick={() => setConfirmDrop([row.key])}
                                    className="inline-flex items-center gap-1 rounded border border-rose-500/40 px-2 py-1 text-[11px] font-bold text-rose-100 hover:border-rose-400/70 hover:bg-rose-500/15 disabled:opacity-40"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    Drop
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {confirmDefrag &&
          createPortal(
            <div
              className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4"
              onClick={() => setConfirmDefrag(null)}
            >
              <div
                className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                data-testid="index-mgmt-confirm-defrag"
              >
                <h3 className="text-sm font-bold text-slate-100 mb-2">Confirm defragment</h3>
                <p className="text-xs text-slate-400 mb-4">
                  Run rebuild / reorganize / optimize statements for{' '}
                  <span className="text-slate-200 font-semibold">
                    {confirmDefrag === 'selected' ? selected.size : filteredKeys.length}
                  </span>{' '}
                  index(es) on{' '}
                  <span className="font-mono text-amber-200">{conn?.name || 'credential'}</span>?
                  This may lock tables briefly.
                </p>
                <div className="flex justify-end gap-2">
                  <button data-testid="index-mgmt-cancel"
                    type="button"
                    className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
                    onClick={() => setConfirmDefrag(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="index-mgmt-confirm-defrag-run"
                    disabled={runningDefrag}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-rose-500/50 bg-rose-500/20 text-rose-50"
                    onClick={() =>
                      void runDefrag(
                        confirmDefrag === 'selected' ? [...selected] : filteredKeys
                      )
                    }
                  >
                    {runningDefrag ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Wrench className="w-3.5 h-3.5" />
                    )}
                    Run defragment
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}

        {confirmDrop &&
          createPortal(
            <div
              className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4"
              onClick={() => setConfirmDrop(null)}
            >
              <div
                className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                data-testid="index-mgmt-confirm-drop"
              >
                <h3 className="text-sm font-bold text-slate-100 mb-2">Confirm drop index</h3>
                <p className="text-xs text-slate-400 mb-4">
                  Run DROP INDEX for{' '}
                  <span className="text-slate-200 font-semibold">{confirmDrop.length}</span>{' '}
                  index(es) on{' '}
                  <span className="font-mono text-amber-200">{conn?.name || 'credential'}</span>?
                  This cannot be undone from here. Constraint-backed indexes are not included.
                  {safeMode ? ' Safe mode is on — confirm carefully.' : ''}
                </p>
                <div className="flex justify-end gap-2">
                  <button data-testid="index-mgmt-confirm-drop-cancel"
                    type="button"
                    className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
                    onClick={() => setConfirmDrop(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="index-mgmt-confirm-drop-run"
                    disabled={runningDrop}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-rose-500/50 bg-rose-500/20 text-rose-50"
                    onClick={() => void runDrop(confirmDrop)}
                  >
                    {runningDrop ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    Drop indexes
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}
    </>
  );

  if (embedded) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="index-management-embed"
      >
        {content}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      data-testid="index-management-overlay"
      onClick={onClose}
    >
      <div
        className="w-full max-w-7xl max-h-[90vh] flex flex-col bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
    </div>,
    document.body
  );
};

function SortableTh({
  label,
  column,
  sort,
  onSort,
  className = '',
  align = 'left',
}: {
  label: string;
  column: IndexMgmtSortKey;
  sort: IndexMgmtSort;
  onSort: (key: IndexMgmtSortKey) => void;
  className?: string;
  align?: 'left' | 'right';
}): React.ReactElement {
  const active = sort.key === column;
  return (
    <th
      className={`font-bold ${className}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        data-testid={`index-mgmt-sort-${column}`}
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-0.5 font-bold uppercase tracking-wide hover:text-slate-200 ${
          align === 'right' ? 'w-full justify-end' : ''
        } ${active ? 'text-amber-200' : 'text-slate-500'}`}
      >
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ChevronUp className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronDown className="w-3 h-3 shrink-0" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-40" />
        )}
      </button>
    </th>
  );
}
