import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type { ColumnInfo, TableSchema } from '@/shared/lib/types';
import { executeSql } from '@/shared/api/sqlApi';
import {
  fetchIndexFragmentation,
  matchIndexFragmentationRow,
  type IndexFragmentationApiRow,
  type IndexFragmentationResponse,
} from '@/shared/api/schemaApi';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { insertAtCursor } from '../lib/sqlEditorBridge';
import { WriteConfirmDialog } from './WriteConfirmDialog';
import { Autocomplete } from '@/shared/components/Autocomplete';
import {
  appendFkTriggerSql,
  applyTypeSize,
  classifyColumnType,
  columnTypeKindClasses,
  defaultDialectColumnType,
  dialectBooleanDefaultOptions,
  dialectColumnConstraints,
  dialectFkActions,
  dialectFkConstraintSupport,
  dialectIdentitySupport,
  dialectIndexSupport,
  dialectTriggerForm,
  diffBlueprintColumns,
  generateCreateTableSql,
  generateDropTableSql,
  generateTableBlueprintSql,
  executableSqlStatements,
  isBooleanBitType,
  isIntegerAutoIncrementType,
  listDialectDataTypes,
  matchFkReferencedColumns,
  moveFkColumnsLockstep,
  moveOrderedName,
  normalizeIndexOrders,
  parseTypeSize,
  pkColumnsFromTable,
  sameStringList,
  suggestFkName,
  suggestIndexName,
  suggestTriggerName,
  withAutoIncrement,
  type BlueprintFkDraft,
  type BlueprintIndexDraft,
  type BlueprintTriggerDraft,
  type FkReferentialAction,
  type IndexColumnOrder,
} from '../lib/tableBlueprintSql';
import type { ForeignKeyInfo, IndexInfo, TriggerInfo } from '@/shared/lib/types';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { TYPE_META } from '@/features/schema-diff';
import { useSyncStore } from '@/features/compare';
import {
  buildIndexDefragSql,
  buildIndexFragmentationCustomTemplate,
  dialectSupportsIndexFragmentation,
  fragmentationSeverity,
} from '@foxschema/ui-shared';
import { dialectFamily } from '@foxschema/ui-shared';

function fragBadgeClass(severity: ReturnType<typeof fragmentationSeverity>): string {
  if (severity === 'ok') return 'text-emerald-300/90 border-emerald-500/40 bg-emerald-950/40';
  if (severity === 'warn') return 'text-amber-200 border-amber-500/40 bg-amber-950/40';
  if (severity === 'critical') return 'text-rose-200 border-rose-500/45 bg-rose-950/45';
  return 'text-slate-400 border-slate-600/50 bg-slate-900/50';
}

function formatFragPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'n/a';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export type BlueprintMode = 'edit' | 'create';

interface Props {
  connectionId: string;
  dialect: string;
  onClose: () => void;
  /** Existing table to edit; omit / null for create-new mode. */
  table: TableSchema | null;
  mode?: BlueprintMode;
}

function emptyFkDraft(): BlueprintFkDraft {
  return {
    name: '',
    columns: [],
    referencedTable: '',
    referencedColumns: [],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
  };
}

function emptyIndexDraft(): BlueprintIndexDraft {
  return {
    name: '',
    columns: [],
    orders: [],
    unique: false,
    filter: '',
  };
}

function indexInfoToDraft(idx: IndexInfo): BlueprintIndexDraft {
  return {
    name: idx.name,
    columns: [...idx.columns],
    orders: idx.columns.map(() => 'ASC' as IndexColumnOrder),
    unique: !!idx.unique,
    filter: idx.filter ?? '',
    constraint: idx.constraint,
  };
}

function formatIndexCols(idx: { columns: string[]; orders?: IndexColumnOrder[] }): string {
  const orders = normalizeIndexOrders(idx.columns, idx.orders);
  return idx.columns
    .map((c, i) => `${c} ${orders[i] ?? 'ASC'}`)
    .join(', ');
}

/** Collapse long index column lists in the blueprint index rows. */
const INDEX_COLS_COLLAPSE_AFTER = 3;

function IndexColumnsLine(props: {
  columns: string[];
  orders?: IndexColumnOrder[];
  filter?: string;
  expanded: boolean;
  onToggle: () => void;
  testId?: string;
}): React.ReactElement {
  const { columns, orders, filter, expanded, onToggle, testId } = props;
  const formatted = columns.map((c, i) => {
    const ord = orders?.[i];
    return ord && ord !== 'ASC' ? `${c} ${ord}` : c;
  });
  const needsCollapse = formatted.length > INDEX_COLS_COLLAPSE_AFTER;
  const shown =
    !needsCollapse || expanded
      ? formatted
      : formatted.slice(0, INDEX_COLS_COLLAPSE_AFTER);
  const hidden = needsCollapse && !expanded ? formatted.length - INDEX_COLS_COLLAPSE_AFTER : 0;

  return (
    <div className="mt-1 min-w-0" data-testid={testId}>
      <div className="font-mono text-[11px] text-slate-400 break-words">
        ({shown.join(', ')}
        {hidden > 0 ? `, …` : ''}
        )
        {filter?.trim() ? (
          <span className="text-sky-300/70"> WHERE {filter.trim()}</span>
        ) : null}
      </div>
      {needsCollapse && (
        <button data-testid={`${testId}-toggle`}
          type="button"
          onClick={onToggle}
          className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-bold text-sky-300/90 hover:text-sky-200"
        >
          {expanded ? (
            <>
              <ChevronDown className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
              Hide columns
            </>
          ) : (
            <>
              <ChevronRight className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
              Show {hidden} more column{hidden === 1 ? '' : 's'}
            </>
          )}
        </button>
      )}
    </div>
  );
}

function emptyTriggerDraft(dialect: string): BlueprintTriggerDraft {
  const meta = dialectTriggerForm(dialect);
  return {
    name: '',
    timing: meta.timings[0] ?? 'AFTER',
    event: meta.events[0] ?? 'INSERT',
    definition: '',
  };
}

type BlueprintColumn = ColumnInfo & { unique?: boolean };

function emptyColumn(dialect: string): BlueprintColumn {
  return {
    name: '',
    type: defaultDialectColumnType(dialect),
    nullable: true,
    primaryKey: false,
    unique: false,
  };
}

function cloneColumns(cols: ColumnInfo[]): BlueprintColumn[] {
  return cols.map((c) => ({ ...c, unique: false }));
}

/** Match a cached table by exact, case-insensitive, or bare (schema-stripped) name. */
function findTableByName(
  tables: TableSchema[],
  name: string
): TableSchema | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const bare = trimmed.replace(/^.*\./, '').toLowerCase();
  return (
    tables.find((t) => t.name === trimmed) ??
    tables.find((t) => t.name.toLowerCase() === lower) ??
    tables.find((t) => t.name.toLowerCase() === bare)
  );
}

/** Toggle a name in an ordered list; `multi` false replaces with a single selection. */
function toggleOrderedName(list: string[], name: string, multi: boolean): string[] {
  if (list.includes(name)) return list.filter((c) => c !== name);
  return multi ? [...list, name] : [name];
}

/**
 * Auto-align referenced columns to local FK columns via name matching
 * (e.g. `test1_id2` → `id2`), preferring the parent PK pool.
 */
function syncFkRefColumns(
  localCols: string[],
  table: TableSchema | undefined
): string[] {
  if (!table) return [];
  return matchFkReferencedColumns(
    localCols,
    pkColumnsFromTable(table),
    table.columns.map((c) => c.name)
  );
}

/**
 * One-viewport vertical blueprint: columns (with dialect identity), composite PK,
 * FKs/triggers (edit), create / drop table with existence-safe SQL.
 */
export const TableBlueprintModal: React.FC<Props> = ({
  connectionId,
  table,
  dialect,
  onClose,
  mode: modeProp,
}) => {
  const mode: BlueprintMode = modeProp ?? (table ? 'edit' : 'create');
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const cachedTables = useSqlEditorStore((s) => s.schemaCache[connectionId]?.tables);
  const connectionSchema = useSyncStore(
    (s) => s.connections.find((c) => c.id === connectionId)?.schema?.trim() || ''
  );

  const liveTable =
    mode === 'edit' && table
      ? (cachedTables?.find(
          (t) => t.name === table.name && t.objectType === table.objectType
        ) ?? table)
      : null;

  const [createName, setCreateName] = useState('');
  const [original, setOriginal] = useState<BlueprintColumn[]>([]);
  const [draft, setDraft] = useState<BlueprintColumn[]>([]);
  const [dropped, setDropped] = useState<Set<string>>(() => new Set());
  const [originalPk, setOriginalPk] = useState<string[]>([]);
  const [draftPk, setDraftPk] = useState<string[]>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<BlueprintColumn | null>(null);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState<BlueprintColumn>(() => emptyColumn(dialect));
  const [expandedTrig, setExpandedTrig] = useState<Record<string, boolean>>({});
  /** Expand full column lists on indexes with many columns. */
  const [expandedIndexCols, setExpandedIndexCols] = useState<Record<string, boolean>>({});
  const indexFormRef = useRef<HTMLDivElement | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [pendingFks, setPendingFks] = useState<BlueprintFkDraft[]>([]);
  const [droppedFkNames, setDroppedFkNames] = useState<Set<string>>(() => new Set());
  const [addingFk, setAddingFk] = useState(false);
  const [fkForm, setFkForm] = useState<BlueprintFkDraft>(() => emptyFkDraft());

  const [pendingIndexes, setPendingIndexes] = useState<BlueprintIndexDraft[]>([]);
  const [droppedIndexNames, setDroppedIndexNames] = useState<Set<string>>(() => new Set());
  const [addingIndex, setAddingIndex] = useState(false);
  const [editingPendingIndex, setEditingPendingIndex] = useState<number | null>(null);
  const [replacingExistingIndex, setReplacingExistingIndex] = useState<string | null>(null);
  /** True when editing a live index whose WHERE filter was not loaded from catalog. */
  const [indexFilterUnknown, setIndexFilterUnknown] = useState(false);
  const [confirmNoFilter, setConfirmNoFilter] = useState(false);
  const [indexForm, setIndexForm] = useState<BlueprintIndexDraft>(() => emptyIndexDraft());

  const [pendingTriggers, setPendingTriggers] = useState<BlueprintTriggerDraft[]>([]);
  const [droppedTriggerNames, setDroppedTriggerNames] = useState<Set<string>>(
    () => new Set()
  );
  const [addingTrigger, setAddingTrigger] = useState(false);
  const [triggerForm, setTriggerForm] = useState<BlueprintTriggerDraft>(() =>
    emptyTriggerDraft(dialect)
  );

  const [fragStatus, setFragStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error' | 'unsupported'
  >('idle');
  const [fragRows, setFragRows] = useState<Record<string, IndexFragmentationApiRow>>({});
  const [fragDefrag, setFragDefrag] = useState<Record<string, string[]>>({});
  const [fragError, setFragError] = useState<string | null>(null);
  const [fragWarning, setFragWarning] = useState<string | null>(null);
  const [fragSource, setFragSource] = useState<'default' | 'custom' | null>(null);
  const [fragMode, setFragMode] = useState<string | null>(null);
  const [showCustomFrag, setShowCustomFrag] = useState(false);
  const [customFragSql, setCustomFragSql] = useState('');
  const [customFragTemplate, setCustomFragTemplate] = useState('');

  const fragSupport = useMemo(
    () => dialectSupportsIndexFragmentation(dialect),
    [dialect]
  );

  const applyFragResponse = useCallback((data: IndexFragmentationResponse) => {
    const map: Record<string, IndexFragmentationApiRow> = {};
    for (const row of data.rows ?? []) {
      map[row.indexName] = row;
      map[row.indexName.toLowerCase()] = row;
    }
    setFragRows(map);
    setFragDefrag(data.defrag ?? {});
    setFragSource(data.source);
    setFragMode(data.mode);
    setFragWarning(data.warning ?? null);
    if (data.customSqlTemplate) setCustomFragTemplate(data.customSqlTemplate);
    setFragStatus('ready');
    setFragError(null);
  }, []);

  useEffect(() => {
    if (mode === 'create') {
      setCreateName('');
      setOriginal([]);
      setDraft([]);
      setDropped(new Set());
      setOriginalPk([]);
      setDraftPk([]);
      setEditingName(null);
      setEditForm(null);
      setAdding(false);
      setError(null);
      setFragStatus('idle');
      setFragRows({});
      setFragDefrag({});
      setFragError(null);
      setFragWarning(null);
      setShowCustomFrag(false);
      setCustomFragSql('');
      return;
    }
    if (!liveTable) return;
    const cols = cloneColumns(liveTable.columns ?? []);
    const pk = pkColumnsFromTable(liveTable);
    setOriginal(cols);
    setDraft(cols);
    setDropped(new Set());
    setOriginalPk(pk);
    setDraftPk(pk);
    setEditingName(null);
    setEditForm(null);
    setAdding(false);
    setError(null);
    setPendingFks([]);
    setDroppedFkNames(new Set());
    setAddingFk(false);
    setFkForm(emptyFkDraft());
    setPendingIndexes([]);
    setDroppedIndexNames(new Set());
    setAddingIndex(false);
    setEditingPendingIndex(null);
    setReplacingExistingIndex(null);
    setIndexFilterUnknown(false);
    setConfirmNoFilter(false);
    setIndexForm(emptyIndexDraft());
    setPendingTriggers([]);
    setDroppedTriggerNames(new Set());
    setAddingTrigger(false);
    setTriggerForm(emptyTriggerDraft(dialect));
    setExpandedIndexCols({});
    setFragStatus('idle');
    setFragRows({});
    setFragDefrag({});
    setFragError(null);
    setFragWarning(null);
    setShowCustomFrag(false);
    setCustomFragSql('');
  }, [mode, liveTable, dialect]);

  const tableName = mode === 'create' ? createName.trim() : (liveTable?.name ?? '');
  const activeColumns = draft.filter((c) => !dropped.has(c.name));

  const loadIndexFragmentation = useCallback(
    async (opts?: { customSql?: string; preferCustom?: boolean }) => {
      if (mode !== 'edit' || !tableName) return;
      setFragStatus('loading');
      setFragError(null);
      try {
        const data = await fetchIndexFragmentation(
          {
            connectionId,
            password: sessionPasswords[connectionId] || undefined,
            schema: connectionSchema || undefined,
          },
          {
            table: tableName,
            schema: connectionSchema || undefined,
            customSql: opts?.customSql,
            preferCustom: opts?.preferCustom,
          }
        );
        applyFragResponse(data);
      } catch (err: unknown) {
        const payload =
          err && typeof err === 'object' && 'payload' in err
            ? (err as { payload?: IndexFragmentationResponse }).payload
            : undefined;
        const message = err instanceof Error ? err.message : String(err);
        const template =
          payload?.customSqlTemplate ||
          buildIndexFragmentationCustomTemplate({
            dialect,
            schema: connectionSchema,
            table: tableName,
          });
        setCustomFragTemplate(template);
        if (!fragSupport.query && !opts?.customSql) {
          setFragStatus('unsupported');
          setFragError(payload?.support?.hint || fragSupport.hint || message);
          setShowCustomFrag(true);
          setCustomFragSql((prev) => prev || template);
          return;
        }
        setFragStatus('error');
        setFragError(message);
        setShowCustomFrag(true);
        setCustomFragSql((prev) => prev || template);
      }
    },
    [
      mode,
      tableName,
      connectionId,
      sessionPasswords,
      connectionSchema,
      applyFragResponse,
      dialect,
      fragSupport.query,
      fragSupport.hint,
    ]
  );

  useEffect(() => {
    if (mode !== 'edit' || !tableName) return;
    if (!(liveTable?.indices?.length)) {
      setFragStatus('idle');
      return;
    }
    void loadIndexFragmentation();
  }, [mode, tableName, liveTable?.indices?.length, liveTable?.name, loadIndexFragmentation]);

  // The table being edited stays in the list: self-referencing FKs
  // (employees.manager_id → employees.id) are ordinary, and excluding it left
  // both the picker and the ref-column list unable to offer them at all.
  const refTableOptions = useMemo(() => {
    const list = (cachedTables ?? []).filter(
      (t) => t.objectType === 'TABLE' || t.objectType === 'MQT'
    );
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [cachedTables]);

  const fkRefTable = findTableByName(refTableOptions, fkForm.referencedTable);
  const fkRefColumns = fkRefTable?.columns ?? [];
  const fkRefPk = fkRefTable ? pkColumnsFromTable(fkRefTable) : [];

  const refTableAutocompleteOptions = useMemo(
    () =>
      refTableOptions.map((t) => ({
        value: t.name,
        hint: `${t.columns.length} col${t.columns.length === 1 ? '' : 's'}`,
      })),
    [refTableOptions]
  );

  const columnOps = useMemo(
    () => (mode === 'create' ? [] : diffBlueprintColumns(original, draft, dropped)),
    [mode, original, draft, dropped]
  );

  const statements = useMemo(() => {
    const fkSupport = dialectFkConstraintSupport(dialect);
    // SQLite (and similar): fold FKs into CREATE TABLE; everyone else uses ALTER ADD after.
    const inlineOnCreate = mode === 'create' && !fkSupport.alterAdd && fkSupport.createInline;
    const base =
      mode === 'create'
        ? generateCreateTableSql(
            tableName,
            activeColumns,
            draftPk,
            dialect,
            undefined,
            inlineOnCreate ? pendingFks : undefined,
            connectionSchema
          )
        : generateTableBlueprintSql({
            tableName,
            dialect,
            columnOps,
            previousPk: originalPk,
            nextPk: draftPk.filter((n) => activeColumns.some((c) => c.name === n)),
            pkName: liveTable?.primaryKey?.name,
            schema: connectionSchema,
          });
    return appendFkTriggerSql(base, {
      tableName,
      dialect,
      schema: connectionSchema,
      addFks: inlineOnCreate ? [] : pendingFks,
      dropFkNames: [...droppedFkNames],
      addTriggers: pendingTriggers,
      dropTriggerNames: [...droppedTriggerNames],
      addIndexes: pendingIndexes,
      dropIndexes: [...droppedIndexNames].map((n) => {
        const live = (liveTable?.indices ?? []).find((i) => i.name === n);
        return { name: n, constraint: live?.constraint };
      }),
    });
  }, [
    mode,
    tableName,
    activeColumns,
    draftPk,
    dialect,
    columnOps,
    originalPk,
    liveTable?.primaryKey?.name,
    liveTable?.indices,
    pendingFks,
    droppedFkNames,
    pendingTriggers,
    droppedTriggerNames,
    pendingIndexes,
    droppedIndexNames,
    connectionSchema,
  ]);

  const dropStatements = useMemo(
    () =>
      mode === 'edit' && tableName
        ? generateDropTableSql(tableName, dialect, connectionSchema)
        : [],
    [mode, tableName, dialect, connectionSchema]
  );

  const sqlText = statements.join('\n');
  const hasOps =
    mode === 'create'
      ? !!tableName &&
        activeColumns.length > 0 &&
        (statements.length > 0 ||
          pendingFks.length > 0 ||
          pendingIndexes.length > 0 ||
          pendingTriggers.length > 0)
      : statements.length > 0;
  const pkDirty = mode === 'edit' && !sameStringList(originalPk, draftPk);

  const meta = TYPE_META.TABLE;
  const existingFks = (liveTable?.foreignKeys ?? []).filter(
    (fk) => !droppedFkNames.has(fk.name)
  );
  const existingIndexes = (liveTable?.indices ?? []).filter(
    (idx) => !droppedIndexNames.has(idx.name)
  );
  const existingTriggers = (liveTable?.triggers ?? []).filter(
    (trg) => !droppedTriggerNames.has(trg.name)
  );
  const identityUi = dialectIdentitySupport(dialect);
  const triggerMeta = dialectTriggerForm(dialect);
  const fkActions = dialectFkActions(dialect);
  const fkSupport = dialectFkConstraintSupport(dialect);
  const fkMulti = fkSupport.composite;
  const indexSupport = dialectIndexSupport(dialect);
  const indexFormOpen =
    addingIndex || editingPendingIndex !== null || !!replacingExistingIndex;

  useEffect(() => {
    if (!indexFormOpen) return;
    const id = window.requestAnimationFrame(() => {
      indexFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [indexFormOpen, editingPendingIndex, replacingExistingIndex, addingIndex]);

  const toggleFkLocalColumn = (name: string) => {
    setFkForm((prev) => {
      const columns = toggleOrderedName(prev.columns, name, fkMulti);
      const table = findTableByName(refTableOptions, prev.referencedTable);
      const matched = syncFkRefColumns(columns, table);
      return {
        ...prev,
        columns,
        referencedColumns: matched.length > 0 ? matched : prev.referencedColumns,
        name: prev.name || suggestFkName(tableName || 'table', columns),
      };
    });
  };

  const moveFkLocal = (name: string, dir: -1 | 1) => {
    setFkForm((prev) => {
      const next = moveFkColumnsLockstep(
        prev.columns,
        prev.referencedColumns,
        name,
        dir,
        (cols) => syncFkRefColumns(cols, fkRefTable)
      );
      return { ...prev, ...next };
    });
  };

  const toggleFkRefColumn = (name: string) => {
    setFkForm((prev) => ({
      ...prev,
      referencedColumns: toggleOrderedName(prev.referencedColumns, name, fkMulti),
    }));
  };

  const moveFkRef = (name: string, dir: -1 | 1) => {
    setFkForm((prev) => ({
      ...prev,
      referencedColumns: moveOrderedName(prev.referencedColumns, name, dir),
    }));
  };

  const saveFk = () => {
    const name = fkForm.name.trim() || suggestFkName(tableName || 'table', fkForm.columns);
    if (fkForm.columns.length === 0) {
      setError('Pick at least one local column for the foreign key');
      return;
    }
    if (!fkForm.referencedTable.trim()) {
      setError('Pick a referenced table');
      return;
    }
    const aligned =
      fkForm.referencedColumns.length === fkForm.columns.length
        ? fkForm.referencedColumns
        : syncFkRefColumns(fkForm.columns, fkRefTable);
    // No last-ditch guess here. Falling back to the parent's *first* column
    // satisfies the arity check below for a single-column FK and silently
    // builds a constraint against a column that is almost never a key.
    const refCols =
      aligned.length > 0 ? aligned : fkRefPk.length === fkForm.columns.length ? fkRefPk : [];
    if (refCols.length === 0) {
      setError('Pick referenced column(s)');
      return;
    }
    if (refCols.length !== fkForm.columns.length) {
      setError('Local and referenced column counts must match');
      return;
    }
    setPendingFks((list) => [
      ...list,
      {
        ...fkForm,
        name,
        // Keep schema.table when the user typed a qualified ref; bare names
        // are qualified later via connectionSchema in SQL generation.
        referencedTable: fkForm.referencedTable.trim(),
        referencedColumns: refCols,
      },
    ]);
    setFkForm(emptyFkDraft());
    setAddingFk(false);
    setError(null);
  };

  const closeIndexForm = () => {
    setAddingIndex(false);
    setEditingPendingIndex(null);
    setReplacingExistingIndex(null);
    setIndexFilterUnknown(false);
    setConfirmNoFilter(false);
    setIndexForm(emptyIndexDraft());
  };

  const openAddIndex = () => {
    setAddingFk(false);
    setAddingTrigger(false);
    setEditingPendingIndex(null);
    setReplacingExistingIndex(null);
    setIndexFilterUnknown(false);
    setConfirmNoFilter(false);
    setAddingIndex(true);
    const cols = activeColumns[0] ? [activeColumns[0].name] : [];
    const unique = false;
    setIndexForm({
      ...emptyIndexDraft(),
      columns: cols,
      orders: cols.map(() => 'ASC' as IndexColumnOrder),
      unique,
      name: suggestIndexName(tableName || 'table', cols, unique),
    });
  };

  const openEditExistingIndex = (idx: IndexInfo) => {
    setAddingFk(false);
    setAddingTrigger(false);
    setAddingIndex(false);
    setEditingPendingIndex(null);
    setReplacingExistingIndex(idx.name);
    // Catalog loaders rarely populate IndexInfo.filter yet — treat missing as unknown
    // so we don't silently recreate a partial index without its WHERE clause.
    const unknown = indexSupport.filter && idx.filter == null;
    setIndexFilterUnknown(!!unknown);
    setConfirmNoFilter(false);
    setIndexForm(indexInfoToDraft(idx));
  };

  const openEditPendingIndex = (i: number) => {
    const draftIdx = pendingIndexes[i];
    if (!draftIdx) return;
    setAddingFk(false);
    setAddingTrigger(false);
    setAddingIndex(false);
    setReplacingExistingIndex(draftIdx.replaces ?? null);
    // Pending drafts already carry an explicit filter (or none).
    setIndexFilterUnknown(false);
    setConfirmNoFilter(false);
    setEditingPendingIndex(i);
    setIndexForm({
      ...draftIdx,
      columns: [...draftIdx.columns],
      orders: normalizeIndexOrders(draftIdx.columns, draftIdx.orders),
      filter: draftIdx.filter ?? '',
    });
  };

  const toggleIndexColumn = (colName: string) => {
    setIndexForm((prev) => {
      if (prev.columns.includes(colName)) {
        const i = prev.columns.indexOf(colName);
        const columns = prev.columns.filter((c) => c !== colName);
        return {
          ...prev,
          columns,
          orders: prev.orders.filter((_, j) => j !== i),
          name:
            prev.name.trim() ||
            suggestIndexName(tableName || 'table', columns, prev.unique),
        };
      }
      const columns = [...prev.columns, colName];
      return {
        ...prev,
        columns,
        orders: [...normalizeIndexOrders(prev.columns, prev.orders), 'ASC'],
        name:
          prev.name.trim() ||
          suggestIndexName(tableName || 'table', columns, prev.unique),
      };
    });
  };

  const moveIndexColumn = (colName: string, dir: -1 | 1) => {
    setIndexForm((prev) => {
      const i = prev.columns.indexOf(colName);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.columns.length) return prev;
      const columns = [...prev.columns];
      const orders = normalizeIndexOrders(prev.columns, prev.orders);
      [columns[i], columns[j]] = [columns[j]!, columns[i]!];
      [orders[i], orders[j]] = [orders[j]!, orders[i]!];
      return { ...prev, columns, orders };
    });
  };

  const setIndexColumnOrder = (colName: string, order: IndexColumnOrder) => {
    setIndexForm((prev) => {
      const i = prev.columns.indexOf(colName);
      if (i < 0) return prev;
      const orders = normalizeIndexOrders(prev.columns, prev.orders);
      orders[i] = order;
      return { ...prev, orders };
    });
  };

  const saveIndex = () => {
    if (indexForm.columns.length === 0) {
      setError('Pick at least one column for the index');
      return;
    }
    if (indexForm.unique && !indexSupport.unique) {
      setError(indexSupport.hint || 'This dialect does not support UNIQUE indexes');
      return;
    }
    if (!indexForm.unique && !indexSupport.acceptDuplicates) {
      setError(indexSupport.hint || 'This dialect does not support non-unique indexes');
      return;
    }
    const filter = indexForm.filter?.trim() || '';
    if (filter && !indexSupport.filter) {
      setError('This dialect does not support filtered/partial indexes');
      return;
    }
    if (indexFilterUnknown && !filter && !confirmNoFilter) {
      setError(
        'Original WHERE filter is unknown from catalog. Enter the predicate, or confirm this index has no filter.'
      );
      return;
    }
    const name =
      indexForm.name.trim() ||
      suggestIndexName(tableName || 'table', indexForm.columns, indexForm.unique);
    const replaces =
      editingPendingIndex !== null
        ? pendingIndexes[editingPendingIndex]?.replaces
        : replacingExistingIndex ?? undefined;
    const next: BlueprintIndexDraft = {
      ...indexForm,
      name,
      orders: normalizeIndexOrders(indexForm.columns, indexForm.orders),
      filter: filter || undefined,
      constraint: indexForm.unique ? indexForm.constraint : undefined,
      replaces,
    };
    if (editingPendingIndex !== null) {
      setPendingIndexes((list) =>
        list.map((item, j) => (j === editingPendingIndex ? next : item))
      );
    } else {
      if (replacingExistingIndex) {
        setDroppedIndexNames((s) => new Set(s).add(replacingExistingIndex));
      }
      setPendingIndexes((list) => [...list, next]);
    }
    closeIndexForm();
    setError(null);
  };

  const saveTrigger = () => {
    const name =
      triggerForm.name.trim() ||
      suggestTriggerName(tableName || 'table', triggerForm.timing, triggerForm.event);
    const body = triggerForm.definition.trim();
    if (!body) {
      setError('Trigger body is required');
      return;
    }
    if (body === triggerMeta.bodyPlaceholder.trim()) {
      setError('Replace the trigger body placeholder with real SQL');
      return;
    }
    setPendingTriggers((list) => [...list, { ...triggerForm, name, definition: body }]);
    setTriggerForm(emptyTriggerDraft(dialect));
    setAddingTrigger(false);
    setError(null);
  };

  const syncPkFlags = (pk: string[]) => {
    setDraftPk(pk);
    setDraft((rows) =>
      rows.map((c) => ({
        ...c,
        primaryKey: pk.includes(c.name),
        // PK columns must be NOT NULL
        nullable: pk.includes(c.name) ? false : c.nullable,
      }))
    );
  };

  const toggleAutoIncrement = (name: string) => {
    setDraft((rows) =>
      rows.map((c) => {
        if (c.name !== name) return c;
        if (!isIntegerAutoIncrementType(c.type)) return c;
        return withAutoIncrement(c, !c.identity);
      })
    );
  };

  const togglePkColumn = (name: string) => {
    if (dropped.has(name)) return;
    if (draftPk.includes(name)) {
      syncPkFlags(draftPk.filter((n) => n !== name));
    } else {
      syncPkFlags([...draftPk, name]);
    }
  };

  const movePk = (name: string, dir: -1 | 1) => {
    const i = draftPk.indexOf(name);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= draftPk.length) return;
    const next = [...draftPk];
    [next[i], next[j]] = [next[j]!, next[i]!];
    syncPkFlags(next);
  };

  const startEdit = (col: BlueprintColumn) => {
    if (dropped.has(col.name)) return;
    setEditingName(col.name);
    setEditForm({ ...col });
    setAdding(false);
  };

  const saveEdit = () => {
    if (!editForm || !editingName) return;
    const name = editForm.name.trim();
    if (!name) {
      setError('Column name is required');
      return;
    }
    setDraft((rows) =>
      rows.map((c) => (c.name === editingName ? { ...editForm, name } : c))
    );
    if (editingName !== name) {
      setDraftPk((pk) => pk.map((n) => (n === editingName ? name : n)));
    }
    setEditingName(null);
    setEditForm(null);
    setError(null);
  };

  const markDrop = (name: string) => {
    const isNew = mode === 'create' || !original.some((c) => c.name === name);
    if (isNew) {
      setDraft((rows) => rows.filter((c) => c.name !== name));
      setDraftPk((pk) => pk.filter((n) => n !== name));
      return;
    }
    setDropped((prev) => new Set(prev).add(name));
    setDraftPk((pk) => pk.filter((n) => n !== name));
    if (editingName === name) {
      setEditingName(null);
      setEditForm(null);
    }
  };

  const undoDrop = (name: string) => {
    setDropped((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  const saveAdd = () => {
    const name = addForm.name.trim();
    if (!name) {
      setError('Column name is required');
      return;
    }
    if (draft.some((c) => c.name === name)) {
      setError(`Column "${name}" already exists`);
      return;
    }
    const col = {
      ...addForm,
      name,
      primaryKey: false,
      nullable: addForm.identity ? false : addForm.nullable,
    };
    setDraft((rows) => [...rows, col]);
    setAddForm(emptyColumn(dialect));
    setAdding(false);
    setError(null);
  };

  const insertSql = (stmts: string[] = statements) => {
    if (stmts.length === 0) return;
    const text = stmts.join('\n');
    insertAtCursor(text.endsWith('\n') ? text : `${text}\n`);
    setToast('SQL inserted at cursor');
    setTimeout(() => setToast(null), 2000);
  };

  const runApply = async (stmts: string[] = statements, closeOnSuccess = mode === 'create') => {
    if (stmts.length === 0 || applying) return;
    const toRun = executableSqlStatements(stmts);
    if (toRun.length === 0) {
      setError(
        'Nothing executable to apply — only review comments (e.g. unsupported FK on this dialect). Use Insert SQL to copy them.'
      );
      return;
    }
    // A mixed batch runs the executable part and drops the rest. Saying only
    // "Applied" would hide that (e.g. on SQLite the column lands but the FK
    // never does), so carry the count through to the success message.
    const skipped = stmts.length - toRun.length;
    setApplying(true);
    setError(null);
    setConfirmWrite(false);
    setConfirmDrop(false);
    try {
      const { results } = await executeSql(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        toRun
      );
      const failed = results.find((r) => !r.ok);
      if (failed && !failed.ok) {
        setError(failed.error);
        return;
      }
      await ensureSchema(connectionId, { force: true });
      setToast(
        skipped > 0
          ? `Applied ${toRun.length} statement${toRun.length === 1 ? '' : 's'} — ${skipped} skipped, not supported on this dialect (use Insert SQL to review)`
          : 'Applied — schema refreshed'
      );
      setTimeout(() => setToast(null), skipped > 0 ? 6000 : 2500);
      if (closeOnSuccess) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const onApplyClick = () => {
    if (!hasOps) return;
    if (safeMode) {
      setConfirmWrite(true);
      return;
    }
    void runApply();
  };

  const onDropTableClick = () => {
    if (dropStatements.length === 0) return;
    setConfirmDrop(true);
  };

  const indexFormPanel = indexFormOpen ? (
    <div
      ref={indexFormRef}
      className="mt-2 rounded-lg border border-sky-400/35 bg-sky-950/35 px-3 py-3 space-y-2.5 shadow-[inset_0_1px_0_rgba(56,189,248,0.08)]"
      data-testid="blueprint-index-form"
    >
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                      <label className="block min-w-0">
                        <span className="text-[10px] font-bold uppercase text-slate-500">
                          Index name
                        </span>
                        <input
                          data-testid="blueprint-index-name"
                          value={indexForm.name}
                          onChange={(e) =>
                            setIndexForm({ ...indexForm, name: e.target.value })
                          }
                          className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[12.5px] font-mono text-slate-100"
                        />
                      </label>
                      <div className="flex flex-col justify-end gap-1">
                        {indexSupport.unique && indexSupport.acceptDuplicates ? (
                          <label className="flex items-center gap-2 text-[12px] text-slate-300 cursor-pointer select-none px-1 py-1.5">
                            <input data-testid="blueprint-index-unique"
                              type="checkbox"
                              checked={indexForm.unique}
                              onChange={(e) => {
                                const unique = e.target.checked;
                                setIndexForm((prev) => ({
                                  ...prev,
                                  unique,
                                  constraint: unique ? prev.constraint : undefined,
                                  name:
                                    prev.name.trim() ||
                                    suggestIndexName(
                                      tableName || 'table',
                                      prev.columns,
                                      unique
                                    ),
                                }));
                              }}
                              className="rounded border-slate-600"
                            />
                            <span>
                              Unique
                              <span className="text-slate-500 ml-1">
                                {indexForm.unique
                                  ? '(reject duplicates)'
                                  : '(accept duplicates)'}
                              </span>
                            </span>
                          </label>
                        ) : indexSupport.unique ? (
                          <p className="text-[11px] text-slate-400 px-1">Unique only</p>
                        ) : (
                          <p className="text-[11px] text-slate-400 px-1">
                            Non-unique only (accept duplicates)
                          </p>
                        )}
                      </div>
                    </div>

                    <div>
                      <span className="text-[10px] font-bold uppercase text-slate-500">
                        Columns
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {activeColumns.map((c) => {
                          const on = indexForm.columns.includes(c.name);
                          const ord =
                            indexForm.orders[indexForm.columns.indexOf(c.name)] ?? 'ASC';
                          return (
                            <div
                              key={c.name}
                              className={`inline-flex items-center gap-0.5 rounded-lg border text-[11px] font-mono ${
                                on
                                  ? 'border-sky-400/50 bg-sky-500/20 text-sky-100'
                                  : 'border-slate-700 bg-slate-900/50 text-slate-400'
                              }`}
                            >
                              <button data-testid={`blueprint-index-column-${c.name}`}
                                type="button"
                                onClick={() => toggleIndexColumn(c.name)}
                                className="px-2 py-1"
                              >
                                {c.name}
                              </button>
                              {on && (
                                <>
                                  {indexSupport.columnOrder && (
                                    <button data-testid={`blueprint-index-column-order-${c.name}`}
                                      type="button"
                                      title={`Order: ${ord} (click to toggle)`}
                                      onClick={() =>
                                        setIndexColumnOrder(
                                          c.name,
                                          ord === 'ASC' ? 'DESC' : 'ASC'
                                        )
                                      }
                                      className="px-1.5 py-1 border-l border-sky-400/30 text-[10px] font-bold text-sky-200/90 hover:text-white"
                                    >
                                      {ord}
                                    </button>
                                  )}
                                  <button data-testid={`blueprint-index-column-earlier-${c.name}`}
                                    type="button"
                                    title="Move earlier"
                                    onClick={() => moveIndexColumn(c.name, -1)}
                                    className="p-1 border-l border-sky-400/30 text-slate-400 hover:text-white"
                                  >
                                    <ArrowUp
                                      className="w-3 h-3"
                                      strokeWidth={SQL_ICON_STROKE}
                                    />
                                  </button>
                                  <button data-testid={`blueprint-index-column-later-${c.name}`}
                                    type="button"
                                    title="Move later"
                                    onClick={() => moveIndexColumn(c.name, 1)}
                                    className="p-1 border-l border-sky-400/30 text-slate-400 hover:text-white"
                                  >
                                    <ArrowDown
                                      className="w-3 h-3"
                                      strokeWidth={SQL_ICON_STROKE}
                                    />
                                  </button>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {indexForm.columns.length > 0 && (
                        <p className="mt-1.5 font-mono text-[11px] text-slate-400">
                          ({formatIndexCols(indexForm)})
                          {indexForm.filter?.trim() && indexSupport.filter ? (
                            <span className="text-sky-300/70">
                              {' '}
                              WHERE {indexForm.filter.trim()}
                            </span>
                          ) : null}
                        </p>
                      )}
                      {!indexSupport.columnOrder && (
                        <p className="mt-1 text-[11px] text-slate-500">{indexSupport.hint}</p>
                      )}
                    </div>

                    {indexSupport.filter && (
                      <div className="space-y-1.5">
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase text-slate-500">
                            Filter (optional)
                          </span>
                          <input data-testid="blueprint-index-where"
                            value={indexForm.filter ?? ''}
                            onChange={(e) => {
                              setIndexForm({ ...indexForm, filter: e.target.value });
                              if (e.target.value.trim()) setConfirmNoFilter(false);
                            }}
                            placeholder="e.g. status = 'active' AND deleted_at IS NULL"
                            className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-[12.5px] font-mono text-slate-100 placeholder:text-slate-600"
                          />
                          <span className="mt-0.5 block text-[10px] text-slate-500">
                            Partial / filtered index — rows matching this predicate only (no WHERE
                            keyword).
                          </span>
                        </label>
                        {indexFilterUnknown && !(indexForm.filter ?? '').trim() && (
                          <div className="rounded-lg border border-amber-400/35 bg-amber-950/25 px-2.5 py-2 space-y-1.5">
                            <p className="text-[11px] text-amber-100/90">
                              Catalog did not load a WHERE filter for this index. Enter the
                              predicate if it is partial, or confirm it has none before saving.
                            </p>
                            <label className="flex items-center gap-2 text-[12px] text-amber-50/90 cursor-pointer select-none">
                              <input data-testid="blueprint-index-confirm-no-filter"
                                type="checkbox"
                                checked={confirmNoFilter}
                                onChange={(e) => setConfirmNoFilter(e.target.checked)}
                                className="rounded border-slate-600"
                              />
                              Confirm this index has no filter
                            </label>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex justify-end gap-1.5">
                      <button data-testid="blueprint-index-cancel"
                        type="button"
                        onClick={closeIndexForm}
                        className="px-2.5 py-1 text-[11px] font-semibold text-slate-400"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        data-testid="blueprint-index-save"
                        onClick={saveIndex}
                        className="px-2.5 py-1 text-[11px] font-bold rounded border border-sky-500/40 text-sky-200 bg-sky-950/50"
                      >
                        {editingPendingIndex !== null || replacingExistingIndex
                          ? 'Save index'
                          : 'Add index'}
                      </button>
                    </div>
    </div>
  ) : null;

  return createPortal(
    <>
      <div
        data-testid="table-blueprint-modal"
        className="modal-overlay modal-overlay-soft"
        onClick={onClose}
      >
        <div
          className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl overflow-hidden border border-cyan-400/25 shadow-2xl shadow-cyan-950/30 bg-gradient-to-b from-slate-800 via-slate-800/95 to-slate-900"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-3.5 border-b border-cyan-400/20 bg-gradient-to-r from-sky-500/15 via-cyan-500/10 to-violet-500/15 flex items-center gap-2.5 shrink-0">
            <span className="shrink-0 p-1.5 rounded-lg bg-cyan-400/15 ring-1 ring-cyan-400/30">
              {meta.icon}
            </span>
            <div className="min-w-0 flex-1">
              {mode === 'create' ? (
                <input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="new_table_name"
                  data-testid="blueprint-table-name"
                  className="w-full bg-transparent border-b border-cyan-400/35 accent-focus outline-none text-slate-50 font-bold text-base font-mono py-0.5"
                />
              ) : (
                <h2 className="text-slate-50 font-bold text-base font-mono truncate">
                  {liveTable?.name}
                </h2>
              )}
              <p className="text-[11px] text-cyan-200/70 font-semibold uppercase tracking-wide">
                {mode === 'create' ? 'Create table' : 'Table blueprint'} · {dialect}
              </p>
            </div>
            {toast && (
              <span className="text-[11px] font-semibold text-emerald-300 flex items-center gap-1 shrink-0">
                <Check className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} /> {toast}
              </span>
            )}
            <button
              type="button"
              title="Close"
              data-testid="blueprint-close"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/10 transition"
            >
              <X className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
            {/* Columns */}
            <section>
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <h3 className="text-xs font-bold text-sky-300/90 uppercase tracking-wider flex items-center gap-2">
                  <Columns3 className="w-3.5 h-3.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
                  Columns
                  <span className="text-sky-500/60 font-mono normal-case">({draft.length})</span>
                </h3>
                {!adding && (
                  <button data-testid="blueprint-add-column"
                    type="button"
                    onClick={() => {
                      setAdding(true);
                      setEditingName(null);
                      setAddForm(emptyColumn(dialect));
                    }}
                    className="flex items-center gap-1 text-[11px] font-bold text-emerald-300 hover:text-emerald-200 px-2.5 py-1 rounded-lg border border-emerald-400/35 bg-emerald-500/15"
                  >
                    <Plus className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} /> Add column
                  </button>
                )}
              </div>

              <div className="bg-sky-950/25 border border-sky-400/20 rounded-xl overflow-hidden divide-y divide-sky-400/10 shadow-inner">
                {draft.map((col) => {
                  const isDropped = dropped.has(col.name);
                  const isEditing = editingName === col.name;
                  const isNew = mode === 'create' || !original.some((c) => c.name === col.name);
                  const inPk = draftPk.includes(col.name);
                  const kind = classifyColumnType(col.type);
                  const kindUi = columnTypeKindClasses(kind);
                  const showAutoInc = isIntegerAutoIncrementType(col.type);
                  return (
                    <div
                      key={col.name}
                      className={`px-3 py-2 border-l-4 ${kindUi.bar} ${
                        isDropped ? 'opacity-50 bg-rose-950/20' : ''
                      } ${isNew ? 'bg-emerald-950/10' : ''}`}
                    >
                      {isEditing && editForm ? (
                        <ColumnForm
                          value={editForm}
                          onChange={setEditForm}
                          onSave={saveEdit}
                          onCancel={() => {
                            setEditingName(null);
                            setEditForm(null);
                          }}
                          nameLocked={!isNew && mode === 'edit'}
                          dialect={dialect}
                        />
                      ) : (
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <span
                            className={`font-mono font-semibold text-[13px] truncate ${
                              isDropped ? 'line-through text-rose-300' : 'text-slate-200'
                            }`}
                          >
                            {col.name}
                          </span>
                          {inPk && (
                            <KeyRound
                              className="w-3.5 h-3.5 text-amber-400 shrink-0"
                              aria-label="Primary key"
                            />
                          )}
                          <span
                            className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${kindUi.badge}`}
                          >
                            {kindUi.label}
                          </span>
                          <span className="text-[12px] font-mono truncate text-slate-400">
                            {col.type}
                            {col.identity && showAutoInc
                              ? resolveDialectIdentityPreview(col, dialect)
                              : ''}
                            {!col.nullable ? ' NOT NULL' : ''}
                            {col.unique ? ' UNIQUE' : ''}
                            {col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ''}
                          </span>
                          {!isDropped && showAutoInc && (
                            <label
                              className="flex items-center gap-1.5 shrink-0 text-[11px] font-semibold text-violet-200 cursor-pointer ml-1 px-1.5 py-0.5 rounded border border-violet-500/35 bg-violet-950/40"
                              title={`Auto increment → ${identityUi.clauseHint}`}
                            >
                              <input
                                type="checkbox"
                                checked={!!col.identity}
                                onChange={() => toggleAutoIncrement(col.name)}
                                className="w-3.5 h-3.5 accent-violet-500"
                                data-testid={`blueprint-ai-${col.name}`}
                              />
                              Auto inc
                            </label>
                          )}
                          <div className="ml-auto flex items-center gap-0.5 shrink-0">
                            {isDropped ? (
                              <button data-testid={`blueprint-column-undo-drop-${col.name}`}
                                type="button"
                                title="Undo drop"
                                onClick={() => undoDrop(col.name)}
                                className="px-2 py-1 text-[10px] font-bold text-slate-300 hover:text-white"
                              >
                                Undo
                              </button>
                            ) : (
                              <>
                                <button data-testid={`blueprint-column-edit-${col.name}`}
                                  type="button"
                                  title="Edit column"
                                  onClick={() => startEdit(col)}
                                  className="p-1.5 rounded text-slate-500 hover:text-sky-300 hover:bg-slate-800"
                                >
                                  <Pencil className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                                </button>
                                <button data-testid={`blueprint-column-drop-${col.name}`}
                                  type="button"
                                  title="Drop column"
                                  onClick={() => markDrop(col.name)}
                                  className="p-1.5 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800"
                                >
                                  <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {draft.length === 0 && (
                  <p className="px-3 py-4 text-[12px] text-slate-500">No columns</p>
                )}
                {adding && (
                  <div className="px-3 py-2 bg-emerald-950/20">
                    <ColumnForm
                      value={addForm}
                      onChange={setAddForm}
                      onSave={saveAdd}
                      onCancel={() => setAdding(false)}
                      nameLocked={false}
                      dialect={dialect}
                    />
                  </div>
                )}
              </div>
            </section>

            {/* Primary key (composite) */}
            <section>
              <h3 className="text-xs font-bold text-amber-300/90 uppercase tracking-wider mb-2.5 flex items-center gap-2">
                <KeyRound className="w-3.5 h-3.5 text-amber-400" strokeWidth={SQL_ICON_STROKE} />
                Primary key
                {pkDirty && (
                  <span className="text-[10px] font-bold text-amber-300 normal-case">changed</span>
                )}
              </h3>
              <div className="bg-amber-950/20 border border-amber-400/25 rounded-xl p-3 space-y-2">
                <p className="text-[11px] text-amber-100/50">
                  Check columns to build a single or composite key. Order matters — use arrows to
                  reorder.
                </p>
                {activeColumns.length === 0 ? (
                  <p className="text-[12px] text-slate-500">Add columns first</p>
                ) : (
                  <ul className="space-y-1">
                    {activeColumns.map((col) => {
                      const on = draftPk.includes(col.name);
                      const pkIndex = draftPk.indexOf(col.name);
                      return (
                        <li
                          key={col.name}
                          className="flex items-center gap-2 text-[12.5px] font-mono"
                        >
                          <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                            <input data-testid={`blueprint-pk-column-${col.name}`}
                              type="checkbox"
                              checked={on}
                              onChange={() => togglePkColumn(col.name)}
                              className="w-3.5 h-3.5 accent-amber-500"
                            />
                            <span className="text-slate-200 truncate">{col.name}</span>
                            <span className="text-slate-500 truncate">{col.type}</span>
                          </label>
                          {on && (
                            <span className="flex items-center gap-0.5 shrink-0">
                              <span className="text-[10px] text-amber-400/80 font-bold w-4 text-center">
                                {pkIndex + 1}
                              </span>
                              <button data-testid={`blueprint-pk-column-up-${col.name}`}
                                type="button"
                                title="Move up in key"
                                disabled={pkIndex <= 0}
                                onClick={() => movePk(col.name, -1)}
                                className="p-1 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                              >
                                <ArrowUp className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
                              </button>
                              <button data-testid={`blueprint-pk-column-down-${col.name}`}
                                type="button"
                                title="Move down in key"
                                disabled={pkIndex >= draftPk.length - 1}
                                onClick={() => movePk(col.name, 1)}
                                className="p-1 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                              >
                                <ArrowDown className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
                              </button>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {draftPk.length > 0 && (
                  <p className="text-[12px] font-mono text-amber-200/90 pt-1 border-t border-amber-400/20">
                    PRIMARY KEY ({draftPk.join(', ')})
                  </p>
                )}
              </div>
            </section>

            {/* Indexes */}
            <section data-testid="table-blueprint-indexes">
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <div className="min-w-0">
                  <h3 className="text-xs font-bold text-sky-300/90 uppercase tracking-wider flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-sky-400 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.55)]" />
                    Indexes
                    <span className="text-sky-400/50 font-mono normal-case">
                      ({existingIndexes.length + pendingIndexes.length})
                    </span>
                  </h3>
                  {mode === 'edit' && existingIndexes.length > 0 && (
                    <p
                      className="mt-1 text-[11px] text-slate-500"
                      data-testid="blueprint-frag-legend"
                      title={fragSupport.hint}
                    >
                      % = fragmentation · Defragment inserts rebuild/reorg SQL
                      {fragStatus === 'loading'
                        ? ' · loading…'
                        : fragMode
                          ? ` · ${fragMode}${fragSource === 'custom' ? ' (custom)' : ''}`
                          : ''}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
                  {mode === 'edit' && existingIndexes.length > 0 && (
                    <button
                      type="button"
                      data-testid="blueprint-refresh-frag"
                      title="Refresh index fragmentation"
                      onClick={() => void loadIndexFragmentation()}
                      disabled={fragStatus === 'loading'}
                      className="flex items-center gap-1 text-[11px] font-bold text-slate-200 hover:text-white px-2.5 py-1 rounded-lg border border-amber-400/40 bg-amber-500/15 disabled:opacity-50"
                    >
                      {fragStatus === 'loading' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                      )}
                      Refresh %
                    </button>
                  )}
                  {!indexFormOpen && indexSupport.create && (
                    <button
                      type="button"
                      data-testid="blueprint-add-index"
                      onClick={openAddIndex}
                      className="flex items-center gap-1 text-[11px] font-bold text-sky-200 hover:text-sky-100 px-2.5 py-1 rounded-lg border border-sky-400/35 bg-sky-500/15"
                    >
                      <Plus className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} /> Add index
                    </button>
                  )}
                </div>
              </div>
              {mode === 'edit' && (fragError || fragWarning || showCustomFrag) && (
                <div
                  className="mb-2 rounded-lg border border-amber-500/30 bg-amber-950/25 px-2.5 py-2 text-[11px] text-amber-100/90 space-y-1.5"
                  data-testid="blueprint-frag-custom"
                >
                  {fragError ? <p className="text-rose-200/90">{fragError}</p> : null}
                  {fragWarning ? <p>{fragWarning}</p> : null}
                  <p className="text-slate-400">
                    Default probe failed or unsupported — paste a SELECT that returns{' '}
                    <span className="font-mono text-slate-300">index_name</span>,{' '}
                    <span className="font-mono text-slate-300">fragmentation_percent</span>
                    {fragSupport.customSqlHint ? `. ${fragSupport.customSqlHint}` : '.'}
                  </p>
                  <button data-testid="blueprint-frag-custom-show"
                    type="button"
                    className="text-[11px] font-bold text-sky-300 hover:text-sky-200"
                    onClick={() => {
                      setShowCustomFrag((v) => !v);
                      if (!customFragSql) {
                        setCustomFragSql(
                          customFragTemplate ||
                            buildIndexFragmentationCustomTemplate({
                              dialect,
                              schema: connectionSchema,
                              table: tableName,
                            })
                        );
                      }
                    }}
                  >
                    {showCustomFrag ? 'Hide custom SQL' : 'Use custom SQL'}
                  </button>
                  {showCustomFrag && (
                    <div className="space-y-1.5">
                      <textarea
                        data-testid="blueprint-frag-custom-sql"
                        value={customFragSql}
                        onChange={(e) => setCustomFragSql(e.target.value)}
                        rows={6}
                        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none accent-focus"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        data-testid="blueprint-frag-run-custom"
                        disabled={fragStatus === 'loading' || !customFragSql.trim()}
                        onClick={() =>
                          void loadIndexFragmentation({
                            customSql: customFragSql,
                            preferCustom: true,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[11px] font-bold text-sky-100 hover:bg-sky-500/25 disabled:opacity-50"
                      >
                        <Play className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
                        Run custom probe
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="bg-sky-950/20 border border-sky-400/25 rounded-xl">
                {existingIndexes.length === 0 &&
                pendingIndexes.length === 0 &&
                !indexFormOpen ? (
                  <p className="px-3 py-3 text-[12px] text-slate-500">
                    {indexSupport.create
                      ? indexSupport.filter
                        ? 'No indexes — add UNIQUE or non-unique, ASC/DESC, and optional WHERE filter.'
                        : 'No indexes — add UNIQUE (reject duplicates) or non-unique (accept duplicates), with ASC/DESC per column.'
                      : indexSupport.hint}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-800/80">
                    {mode === 'edit' && existingIndexes.length > 0 && (
                      <li className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 flex items-center gap-2 bg-slate-900/95 sticky top-0 z-[1] border-b border-slate-800/80">
                        <span className="min-w-0 flex-1">Index</span>
                        <span className="w-14 text-center shrink-0">%</span>
                        <span className="w-16 text-center shrink-0">Defrag</span>
                        <span className="w-14 shrink-0" />
                      </li>
                    )}
                    {existingIndexes.map((idx: IndexInfo) => {
                      const frag =
                        fragRows[idx.name] ??
                        fragRows[idx.name.toLowerCase()] ??
                        matchIndexFragmentationRow(idx.name, Object.values(fragRows)) ??
                        undefined;
                      const severity = fragmentationSeverity(frag?.fragmentationPercent);
                      const defragSql =
                        fragDefrag[idx.name] ??
                        fragDefrag[idx.name.toLowerCase()] ??
                        buildIndexDefragSql({
                          dialect,
                          schema: connectionSchema,
                          table: tableName,
                          indexName: idx.name,
                          fragmentationPercent: frag?.fragmentationPercent,
                        });
                      const needsDefrag =
                        severity === 'warn' || severity === 'critical';
                      const colsOpen = !!expandedIndexCols[idx.name];
                      const editingThis =
                        replacingExistingIndex === idx.name &&
                        editingPendingIndex === null &&
                        !addingIndex;
                      return (
                      <li
                        key={idx.name}
                        className={`px-3 py-2.5 text-[12.5px] ${
                          editingThis
                            ? 'bg-sky-500/10 ring-1 ring-inset ring-sky-400/35'
                            : ''
                        }`}
                        data-testid={`blueprint-index-row-${idx.name}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="min-w-0 flex-1">
                            <span className="font-mono font-semibold text-slate-200 truncate inline-block max-w-full align-bottom">
                              {idx.name}
                            </span>
                            <span className="text-slate-500 mx-1.5">·</span>
                            <span className="text-[10px] font-bold uppercase tracking-wide text-sky-300/80">
                              {idx.unique ? 'unique' : 'duplicates ok'}
                            </span>
                            {idx.constraint ? (
                              <span className="ml-1.5 text-[10px] font-bold uppercase text-amber-300/80">
                                constraint
                              </span>
                            ) : null}
                            <span className="ml-1.5 text-[10px] text-slate-500 tabular-nums">
                              {idx.columns.length} col{idx.columns.length === 1 ? '' : 's'}
                            </span>
                          </div>
                          {mode === 'edit' && (
                            <>
                              <div
                                data-testid={`blueprint-index-frag-${idx.name}`}
                                title={
                                  frag?.pageCount != null
                                    ? `Fragmentation · ${fragSupport.hint} · ${frag.pageCount} pages`
                                    : `Fragmentation · ${fragSupport.hint}`
                                }
                                className={`w-14 shrink-0 text-center rounded-md border px-1.5 py-1 text-[12px] font-bold tabular-nums leading-none ${fragBadgeClass(severity)}`}
                              >
                                {fragStatus === 'loading' && !frag
                                  ? '…'
                                  : formatFragPct(frag?.fragmentationPercent)}
                              </div>
                              {defragSql.length > 0 ? (
                                <button
                                  type="button"
                                  title={defragSql.join('\n')}
                                  data-testid={`blueprint-index-defrag-${idx.name}`}
                                  onClick={() => {
                                    insertAtCursor(defragSql.join('\n') + '\n');
                                    setToast('Defragment SQL inserted into editor');
                                    setTimeout(() => setToast(null), 2000);
                                  }}
                                  className={`inline-flex items-center gap-1 shrink-0 rounded-md border px-2 py-1 text-[11px] font-bold ${
                                    needsDefrag
                                      ? 'border-amber-400/50 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
                                      : 'border-slate-600/60 bg-slate-900/50 text-slate-300 hover:text-white hover:border-slate-500'
                                  }`}
                                >
                                  <Wrench className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                                  Defrag
                                </button>
                              ) : null}
                              <div className="flex items-center gap-0.5 shrink-0">
                                {indexSupport.create && (
                                  <button data-testid={`blueprint-index-edit-${idx.name}`}
                                    type="button"
                                    title="Edit index"
                                    onClick={() => openEditExistingIndex(idx)}
                                    className="p-1 text-slate-500 hover:text-sky-300"
                                  >
                                    <Pencil className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                                  </button>
                                )}
                                {indexSupport.drop && (
                                  <button data-testid={`blueprint-index-drop-${idx.name}`}
                                    type="button"
                                    title="Drop index"
                                    onClick={() =>
                                      setDroppedIndexNames((s) => new Set(s).add(idx.name))
                                    }
                                    className="p-1 text-slate-500 hover:text-rose-400"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                          {mode !== 'edit' && indexSupport.create && (
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button data-testid={`blueprint-index-edit-${idx.name}`}
                                type="button"
                                title="Edit index"
                                onClick={() => openEditExistingIndex(idx)}
                                className="p-1 text-slate-500 hover:text-sky-300"
                              >
                                <Pencil className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                              </button>
                            </div>
                          )}
                        </div>
                        <IndexColumnsLine
                          columns={idx.columns}
                          filter={idx.filter}
                          expanded={colsOpen}
                          testId={`blueprint-index-cols-${idx.name}`}
                          onToggle={() =>
                            setExpandedIndexCols((s) => ({
                              ...s,
                              [idx.name]: !s[idx.name],
                            }))
                          }
                        />
                        {replacingExistingIndex === idx.name &&
                          editingPendingIndex === null &&
                          !addingIndex &&
                          indexFormPanel}
                      </li>
                      );
                    })}
                    {[...droppedIndexNames].map((n) => (
                      <li
                        key={`drop-idx-${n}`}
                        className="px-3 py-2 text-[12px] text-rose-300/90 flex items-center gap-2 bg-rose-950/20"
                      >
                        <span className="line-through font-mono">{n}</span>
                        <span className="text-[10px] font-bold uppercase">drop</span>
                        <button data-testid={`blueprint-index-undo-drop-${n}`}
                          type="button"
                          className="ml-auto text-[10px] font-bold text-slate-300"
                          onClick={() => {
                            setDroppedIndexNames((s) => {
                              const n2 = new Set(s);
                              n2.delete(n);
                              return n2;
                            });
                            // Undo a replace-edit: also remove the pending CREATE that
                            // would collide with the restored live index.
                            setPendingIndexes((list) =>
                              list.filter((p) => p.replaces !== n)
                            );
                          }}
                        >
                          Undo
                        </button>
                      </li>
                    ))}
                    {pendingIndexes.map((idx, i) => (
                      <li
                        key={`pending-idx-${idx.name}-${i}`}
                        className={`px-3 py-2.5 text-[12.5px] ${
                          editingPendingIndex === i
                            ? 'bg-sky-500/10 ring-1 ring-inset ring-sky-400/35'
                            : 'bg-emerald-950/15'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="min-w-0 flex-1">
                            <span className="text-[9px] font-bold uppercase text-emerald-400 mr-1.5">
                              {idx.replaces ? 'replace' : 'new'}
                            </span>
                            <span className="font-mono font-semibold text-slate-200">
                              {idx.name}
                            </span>
                            <span className="text-slate-500 mx-1.5">·</span>
                            <span className="text-[10px] font-bold uppercase tracking-wide text-sky-300/80">
                              {idx.unique ? 'unique' : 'duplicates ok'}
                            </span>
                            <span className="ml-1.5 text-[10px] text-slate-500 tabular-nums">
                              {idx.columns.length} col{idx.columns.length === 1 ? '' : 's'}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button data-testid={`blueprint-pending-index-edit-${idx.name}`}
                              type="button"
                              title="Edit"
                              onClick={() => openEditPendingIndex(i)}
                              className="p-1 text-slate-500 hover:text-sky-300"
                            >
                              <Pencil className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                            </button>
                            <button data-testid={`blueprint-pending-index-remove-${idx.name}`}
                              type="button"
                              title="Remove"
                              onClick={() => {
                                const removed = pendingIndexes[i];
                                setPendingIndexes((list) => list.filter((_, j) => j !== i));
                                if (removed?.replaces) {
                                  setDroppedIndexNames((s) => {
                                    const n2 = new Set(s);
                                    n2.delete(removed.replaces!);
                                    return n2;
                                  });
                                }
                              }}
                              className="p-1 text-slate-500 hover:text-rose-400"
                            >
                              <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                            </button>
                          </div>
                        </div>
                        <IndexColumnsLine
                          columns={idx.columns}
                          orders={idx.orders}
                          filter={idx.filter}
                          expanded={!!expandedIndexCols[`pending:${i}:${idx.name}`]}
                          testId={`blueprint-pending-index-cols-${i}`}
                          onToggle={() =>
                            setExpandedIndexCols((s) => {
                              const key = `pending:${i}:${idx.name}`;
                              return { ...s, [key]: !s[key] };
                            })
                          }
                        />
                        {editingPendingIndex === i && indexFormPanel}
                      </li>
                    ))}
                    {addingIndex && (
                      <li className="px-3 py-2.5 bg-sky-500/10 ring-1 ring-inset ring-sky-400/35">
                        {indexFormPanel}
                      </li>
                    )}
                  </ul>
                )}

              </div>
            </section>

            {/* Foreign keys */}
            <section>
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <h3 className="text-xs font-bold text-violet-300/90 uppercase tracking-wider flex items-center gap-2">
                  <span className="w-1.5 h-1.5 bg-violet-400 rounded-full shadow-[0_0_8px_rgba(167,139,250,0.6)]" />
                  Foreign keys
                  <span className="text-violet-400/50 font-mono normal-case">
                    ({existingFks.length + pendingFks.length})
                  </span>
                </h3>
                {!addingFk && (fkSupport.alterAdd || fkSupport.createInline) && (
                  <button data-testid="blueprint-add-fk"
                    type="button"
                    onClick={() => {
                      setAddingFk(true);
                      setAddingTrigger(false);
                      closeIndexForm();
                      const cols = activeColumns[0] ? [activeColumns[0].name] : [];
                      setFkForm({
                        ...emptyFkDraft(),
                        columns: cols,
                        name: suggestFkName(tableName || 'table', cols),
                      });
                    }}
                    className="flex items-center gap-1 text-[11px] font-bold text-violet-200 hover:text-violet-100 px-2.5 py-1 rounded-lg border border-violet-400/35 bg-violet-500/15"
                  >
                    <Plus className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} /> Add foreign key
                  </button>
                )}
              </div>
              <div className="bg-violet-950/20 border border-violet-400/25 rounded-xl overflow-hidden">
                {existingFks.length === 0 && pendingFks.length === 0 && !addingFk ? (
                  <p className="px-3 py-3 text-[12px] text-slate-500">
                    {fkSupport.createInline || fkSupport.alterAdd
                      ? 'No foreign keys — link one or more columns to another table’s key.'
                      : fkSupport.hint}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-800/80">
                    {existingFks.map((fk: ForeignKeyInfo) => (
                      <li
                        key={fk.name}
                        className="px-3 py-2.5 text-[12.5px] flex items-start gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-mono font-semibold text-slate-200">{fk.name}</span>
                          <span className="text-slate-500 mx-1.5">·</span>
                          <span className="font-mono text-slate-400">
                            ({fk.columns.join(', ')}) → {fk.referencedTable}(
                            {(fk.referencedColumns ?? []).join(', ')})
                          </span>
                        </div>
                        {mode === 'edit' && (
                          <button data-testid={`blueprint-fk-drop-${fk.name}`}
                            type="button"
                            title="Drop foreign key"
                            onClick={() =>
                              setDroppedFkNames((s) => new Set(s).add(fk.name))
                            }
                            className="p-1 text-slate-500 hover:text-rose-400 shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                          </button>
                        )}
                      </li>
                    ))}
                    {[...droppedFkNames].map((n) => (
                      <li
                        key={`drop-fk-${n}`}
                        className="px-3 py-2 text-[12px] text-rose-300/90 flex items-center gap-2 bg-rose-950/20"
                      >
                        <span className="line-through font-mono">{n}</span>
                        <span className="text-[10px] font-bold uppercase">drop</span>
                        <button data-testid={`blueprint-fk-undo-drop-${n}`}
                          type="button"
                          className="ml-auto text-[10px] font-bold text-slate-300"
                          onClick={() =>
                            setDroppedFkNames((s) => {
                              const n2 = new Set(s);
                              n2.delete(n);
                              return n2;
                            })
                          }
                        >
                          Undo
                        </button>
                      </li>
                    ))}
                    {pendingFks.map((fk, i) => (
                      <li
                        key={`pending-fk-${fk.name}-${i}`}
                        className="px-3 py-2.5 text-[12.5px] flex items-start gap-2 bg-emerald-950/15"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-[9px] font-bold uppercase text-emerald-400 mr-1.5">
                            new
                          </span>
                          <span className="font-mono font-semibold text-slate-200">{fk.name}</span>
                          <span className="text-slate-500 mx-1.5">·</span>
                          <span className="font-mono text-slate-400">
                            ({fk.columns.join(', ')}) → {fk.referencedTable}(
                            {(fk.referencedColumns ?? []).join(', ')})
                          </span>
                        </div>
                        <button data-testid={`blueprint-pending-fk-remove-${fk.name}`}
                          type="button"
                          title="Remove"
                          onClick={() =>
                            setPendingFks((list) => list.filter((_, j) => j !== i))
                          }
                          className="p-1 text-slate-500 hover:text-rose-400 shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {addingFk && (
                  <div
                    className="px-3 py-3 border-t border-violet-400/20 space-y-2.5 bg-violet-500/10"
                    data-testid="blueprint-fk-form"
                  >
                    <p className="text-[11px] text-violet-100/75">
                      Select one or more local columns and matching parent columns (order
                      matters for composite keys).{' '}
                      <span className="text-violet-200/55">{fkSupport.hint}</span>
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label className="flex flex-col gap-0.5 sm:col-span-2">
                        <span className="text-[10px] font-bold text-violet-300/70 uppercase">
                          Constraint name
                        </span>
                        <input data-testid="blueprint-fk-name"
                          value={fkForm.name}
                          onChange={(e) => setFkForm({ ...fkForm, name: e.target.value })}
                          placeholder={suggestFkName(tableName || 'table', fkForm.columns)}
                          className="bg-white/5 border border-violet-400/30 rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-slate-100 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20"
                        />
                      </label>
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold text-violet-300/70 uppercase">
                          Local column{fkMulti ? 's' : ''}
                        </span>
                        {activeColumns.length === 0 ? (
                          <p className="text-[11px] text-slate-500">Add columns first</p>
                        ) : (
                          <ul className="space-y-0.5 max-h-36 overflow-y-auto rounded-lg border border-violet-400/25 bg-white/5 p-1.5">
                            {activeColumns.map((c) => {
                              const on = fkForm.columns.includes(c.name);
                              const idx = fkForm.columns.indexOf(c.name);
                              return (
                                <li
                                  key={c.name}
                                  className="flex items-center gap-1.5 text-[12px] font-mono"
                                >
                                  <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                                    <input data-testid={`blueprint-fk-column-${c.name}`}
                                      type="checkbox"
                                      checked={on}
                                      onChange={() => toggleFkLocalColumn(c.name)}
                                      className="w-3.5 h-3.5 accent-violet-500"
                                    />
                                    <span className="text-slate-100 truncate">{c.name}</span>
                                    <span className="text-slate-500 truncate">{c.type}</span>
                                  </label>
                                  {on && fkMulti && (
                                    <span className="flex items-center gap-0.5 shrink-0">
                                      <span className="text-[10px] text-violet-300/80 font-bold w-4 text-center">
                                        {idx + 1}
                                      </span>
                                      <button data-testid={`blueprint-fk-column-up-${c.name}`}
                                        type="button"
                                        title="Move up"
                                        disabled={idx <= 0}
                                        onClick={() => moveFkLocal(c.name, -1)}
                                        className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                                      >
                                        <ArrowUp className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
                                      </button>
                                      <button data-testid={`blueprint-fk-column-down-${c.name}`}
                                        type="button"
                                        title="Move down"
                                        disabled={idx >= fkForm.columns.length - 1}
                                        onClick={() => moveFkLocal(c.name, 1)}
                                        className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                                      >
                                        <ArrowDown
                                          className="w-3 h-3"
                                          strokeWidth={SQL_ICON_STROKE}
                                        />
                                      </button>
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold text-violet-300/70 uppercase">
                          References table
                        </span>
                        <Autocomplete
                          theme="violet"
                          maxResults={60}
                          resolveExactOnBlur
                          data-testid="blueprint-fk-ref-table"
                          value={fkForm.referencedTable}
                          options={refTableAutocompleteOptions}
                          placeholder="Type table name…"
                          onChange={(name) => {
                            const t = findTableByName(refTableOptions, name);
                            const referencedColumns = syncFkRefColumns(
                              fkForm.columns,
                              t
                            );
                            setFkForm({
                              ...fkForm,
                              // Keep a typed qualifier ("ref.countries") intact:
                              // qualifyTableName leaves dotted names alone, so
                              // stripping it here re-qualified the FK into the
                              // connection's own schema instead.
                              referencedTable: t?.name ?? name.trim(),
                              referencedColumns,
                            });
                          }}
                        />
                        {fkForm.referencedTable.trim() && (
                          <>
                            <span className="text-[10px] font-bold text-violet-300/70 uppercase mt-1">
                              References column{fkMulti ? 's' : ''}
                            </span>
                            {fkRefColumns.length === 0 ? (
                              <p className="text-[11px] text-slate-500">
                                No columns cached for this table
                              </p>
                            ) : (
                              <ul className="space-y-0.5 max-h-36 overflow-y-auto rounded-lg border border-violet-400/25 bg-white/5 p-1.5">
                                {fkRefColumns.map((c) => {
                                  const on = fkForm.referencedColumns.includes(c.name);
                                  const idx = fkForm.referencedColumns.indexOf(c.name);
                                  return (
                                    <li
                                      key={c.name}
                                      className="flex items-center gap-1.5 text-[12px] font-mono"
                                    >
                                      <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                                        <input data-testid={`blueprint-fk-ref-column-${c.name}`}
                                          type="checkbox"
                                          checked={on}
                                          onChange={() => toggleFkRefColumn(c.name)}
                                          className="w-3.5 h-3.5 accent-violet-500"
                                        />
                                        <span className="text-slate-100 truncate">{c.name}</span>
                                        <span className="text-slate-500 truncate">
                                          {c.type}
                                          {fkRefPk.includes(c.name) ? ' · PK' : ''}
                                        </span>
                                      </label>
                                      {on && fkMulti && (
                                        <span className="flex items-center gap-0.5 shrink-0">
                                          <span className="text-[10px] text-violet-300/80 font-bold w-4 text-center">
                                            {idx + 1}
                                          </span>
                                          <button data-testid={`blueprint-fk-ref-column-up-${c.name}`}
                                            type="button"
                                            title="Move up"
                                            disabled={idx <= 0}
                                            onClick={() => moveFkRef(c.name, -1)}
                                            className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                                          >
                                            <ArrowUp
                                              className="w-3 h-3"
                                              strokeWidth={SQL_ICON_STROKE}
                                            />
                                          </button>
                                          <button data-testid={`blueprint-fk-ref-column-down-${c.name}`}
                                            type="button"
                                            title="Move down"
                                            disabled={
                                              idx >= fkForm.referencedColumns.length - 1
                                            }
                                            onClick={() => moveFkRef(c.name, 1)}
                                            className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-30"
                                          >
                                            <ArrowDown
                                              className="w-3 h-3"
                                              strokeWidth={SQL_ICON_STROKE}
                                            />
                                          </button>
                                        </span>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </>
                        )}
                      </div>
                      {fkActions.length > 0 && (
                        <>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-bold text-violet-300/70 uppercase">
                              On delete
                            </span>
                            <select data-testid="blueprint-fk-on-delete"
                              value={fkForm.onDelete ?? 'NO ACTION'}
                              onChange={(e) =>
                                setFkForm({
                                  ...fkForm,
                                  onDelete: e.target.value as FkReferentialAction,
                                })
                              }
                              className="bg-white/5 border border-violet-400/30 rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-slate-100 outline-none"
                            >
                              {fkActions.map((a) => (
                                <option key={a} value={a}>
                                  {a}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-0.5">
                            <span className="text-[10px] font-bold text-violet-300/70 uppercase">
                              On update
                            </span>
                            <select data-testid="blueprint-fk-on-update"
                              value={fkForm.onUpdate ?? 'NO ACTION'}
                              onChange={(e) =>
                                setFkForm({
                                  ...fkForm,
                                  onUpdate: e.target.value as FkReferentialAction,
                                })
                              }
                              className="bg-white/5 border border-violet-400/30 rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-slate-100 outline-none"
                            >
                              {fkActions.map((a) => (
                                <option key={a} value={a}>
                                  {a}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                    </div>
                    <div className="flex justify-end gap-1.5">
                      <button data-testid="blueprint-fk-cancel"
                        type="button"
                        onClick={() => setAddingFk(false)}
                        className="px-2.5 py-1 text-[11px] font-semibold text-slate-400"
                      >
                        Cancel
                      </button>
                      <button data-testid="blueprint-fk-save"
                        type="button"
                        onClick={saveFk}
                        className="px-2.5 py-1 text-[11px] font-bold rounded border border-purple-500/40 text-purple-200 bg-purple-950/50"
                      >
                        Add FK
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Triggers */}
            <section>
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <h3 className="text-xs font-bold text-orange-300/90 uppercase tracking-wider flex items-center gap-2">
                  <span className="w-1.5 h-1.5 bg-orange-400 rounded-full shadow-[0_0_8px_rgba(251,146,60,0.55)]" />
                  Triggers
                  <span className="text-orange-400/50 font-mono normal-case">
                    ({existingTriggers.length + pendingTriggers.length})
                  </span>
                </h3>
                {!addingTrigger && (
                  <button data-testid="blueprint-add-trigger"
                    type="button"
                    onClick={() => {
                      setAddingTrigger(true);
                      setAddingFk(false);
                      closeIndexForm();
                      const draft = emptyTriggerDraft(dialect);
                      setTriggerForm({
                        ...draft,
                        name: suggestTriggerName(
                          tableName || 'table',
                          draft.timing,
                          draft.event
                        ),
                      });
                    }}
                    className="flex items-center gap-1 text-[11px] font-bold text-orange-200 hover:text-orange-100 px-2.5 py-1 rounded-lg border border-orange-400/35 bg-orange-500/15"
                  >
                    <Plus className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} /> Create trigger
                  </button>
                )}
              </div>
              <div className="bg-orange-950/15 border border-orange-400/25 rounded-xl overflow-hidden">
                {existingTriggers.length === 0 &&
                pendingTriggers.length === 0 &&
                !addingTrigger ? (
                  <p className="px-3 py-3 text-[12px] text-slate-500">
                    No triggers — run logic before/after INSERT, UPDATE, or DELETE.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-800/80">
                    {existingTriggers.map((trg: TriggerInfo) => {
                      const open = !!expandedTrig[trg.name];
                      return (
                        <li key={trg.name}>
                          <div className="flex items-center gap-1">
                            <button data-testid={`blueprint-trigger-expand-${trg.name}`}
                              type="button"
                              onClick={() =>
                                setExpandedTrig((m) => ({ ...m, [trg.name]: !open }))
                              }
                              className="flex-1 flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-900/40 min-w-0"
                            >
                              {open ? (
                                <ChevronDown
                                  className="w-3.5 h-3.5 text-slate-500 shrink-0"
                                  strokeWidth={SQL_ICON_STROKE}
                                />
                              ) : (
                                <ChevronRight
                                  className="w-3.5 h-3.5 text-slate-500 shrink-0"
                                  strokeWidth={SQL_ICON_STROKE}
                                />
                              )}
                              <span className="font-mono font-semibold text-[12.5px] text-slate-200 truncate">
                                {trg.name}
                              </span>
                              <span className="text-[11px] text-slate-500 ml-auto shrink-0">
                                {[trg.timing, trg.event].filter(Boolean).join(' ') || '—'}
                              </span>
                            </button>
                            {mode === 'edit' && (
                              <button data-testid={`blueprint-trigger-drop-${trg.name}`}
                                type="button"
                                title="Drop trigger"
                                onClick={() =>
                                  setDroppedTriggerNames((s) => new Set(s).add(trg.name))
                                }
                                className="p-1.5 mr-2 text-slate-500 hover:text-rose-400 shrink-0"
                              >
                                <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                              </button>
                            )}
                          </div>
                          {open && (
                            <pre className="px-3 pb-3 text-[11px] font-mono text-slate-400 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                              {trg.definition?.trim() || '(no definition)'}
                            </pre>
                          )}
                        </li>
                      );
                    })}
                    {[...droppedTriggerNames].map((n) => (
                      <li
                        key={`drop-trg-${n}`}
                        className="px-3 py-2 text-[12px] text-rose-300/90 flex items-center gap-2 bg-rose-950/20"
                      >
                        <span className="line-through font-mono">{n}</span>
                        <span className="text-[10px] font-bold uppercase">drop</span>
                        <button data-testid={`blueprint-trigger-undo-drop-${n}`}
                          type="button"
                          className="ml-auto text-[10px] font-bold text-slate-300"
                          onClick={() =>
                            setDroppedTriggerNames((s) => {
                              const n2 = new Set(s);
                              n2.delete(n);
                              return n2;
                            })
                          }
                        >
                          Undo
                        </button>
                      </li>
                    ))}
                    {pendingTriggers.map((trg, i) => (
                      <li
                        key={`pending-trg-${trg.name}-${i}`}
                        className="px-3 py-2.5 text-[12.5px] flex items-start gap-2 bg-emerald-950/15"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-[9px] font-bold uppercase text-emerald-400 mr-1.5">
                            new
                          </span>
                          <span className="font-mono font-semibold text-slate-200">{trg.name}</span>
                          <span className="text-slate-500 ml-1.5 text-[11px]">
                            {trg.timing} {trg.event}
                          </span>
                        </div>
                        <button data-testid={`blueprint-pending-trigger-remove-${trg.name}`}
                          type="button"
                          onClick={() =>
                            setPendingTriggers((list) => list.filter((_, j) => j !== i))
                          }
                          className="p-1 text-slate-500 hover:text-rose-400 shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {addingTrigger && (
                  <div
                    className="px-3 py-3 border-t border-slate-800 space-y-2.5 bg-amber-950/15"
                    data-testid="blueprint-trigger-form"
                  >
                    <p className="text-[11px] text-amber-200/80">{triggerMeta.hint}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <label className="flex flex-col gap-0.5 sm:col-span-1">
                        <span className="text-[10px] font-bold text-slate-500 uppercase">Name</span>
                        <input data-testid="blueprint-trigger-name"
                          value={triggerForm.name}
                          onChange={(e) =>
                            setTriggerForm({ ...triggerForm, name: e.target.value })
                          }
                          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono text-slate-200 outline-none accent-focus"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-bold text-slate-500 uppercase">
                          Timing
                        </span>
                        <select data-testid="blueprint-trigger-timing"
                          value={triggerForm.timing}
                          onChange={(e) =>
                            setTriggerForm({
                              ...triggerForm,
                              timing: e.target.value,
                              name:
                                triggerForm.name ||
                                suggestTriggerName(
                                  tableName || 'table',
                                  e.target.value,
                                  triggerForm.event
                                ),
                            })
                          }
                          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono text-slate-200 outline-none"
                        >
                          {triggerMeta.timings.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-bold text-slate-500 uppercase">
                          Event
                        </span>
                        <select data-testid="blueprint-trigger-event"
                          value={triggerForm.event}
                          onChange={(e) =>
                            setTriggerForm({
                              ...triggerForm,
                              event: e.target.value,
                              name:
                                triggerForm.name ||
                                suggestTriggerName(
                                  tableName || 'table',
                                  triggerForm.timing,
                                  e.target.value
                                ),
                            })
                          }
                          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono text-slate-200 outline-none"
                        >
                          {triggerMeta.events.map((ev) => (
                            <option key={ev} value={ev}>
                              {ev}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-bold text-slate-500 uppercase">Body</span>
                      <textarea data-testid="blueprint-trigger-definition"
                        value={triggerForm.definition}
                        onChange={(e) =>
                          setTriggerForm({ ...triggerForm, definition: e.target.value })
                        }
                        placeholder={triggerMeta.bodyPlaceholder}
                        rows={5}
                        className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[12px] font-mono text-slate-200 outline-none accent-focus resize-y min-h-[6rem]"
                      />
                    </label>
                    <div className="flex justify-end gap-1.5">
                      <button data-testid="blueprint-trigger-cancel"
                        type="button"
                        onClick={() => setAddingTrigger(false)}
                        className="px-2.5 py-1 text-[11px] font-semibold text-slate-400"
                      >
                        Cancel
                      </button>
                      <button data-testid="blueprint-trigger-save"
                        type="button"
                        onClick={saveTrigger}
                        className="px-2.5 py-1 text-[11px] font-bold rounded border border-amber-500/40 text-amber-200 bg-amber-950/50"
                      >
                        Add trigger
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {identityUi.hint && (
              <p className="text-[11px] text-slate-500">{identityUi.hint}</p>
            )}
          </div>

          <div className="shrink-0 border-t border-cyan-400/20 bg-gradient-to-r from-sky-500/10 via-slate-800/80 to-violet-500/10 px-5 py-3 space-y-2.5">
            {error && (
              <p
                className="text-[12px] text-rose-300 font-medium break-words"
                data-testid="blueprint-error"
              >
                {error}
              </p>
            )}
            <div className="bg-cyan-950/30 border border-cyan-400/25 rounded-xl px-3 py-2 max-h-28 overflow-y-auto">
              {hasOps ? (
                <pre className="text-[11px] font-mono text-cyan-100/90 whitespace-pre-wrap break-words">
                  {sqlText}
                </pre>
              ) : (
                <p className="text-[11px] text-slate-500">
                  {mode === 'create'
                    ? 'Enter a table name and at least one column'
                    : 'No pending changes'}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {mode === 'edit' && (
                <button
                  type="button"
                  onClick={onDropTableClick}
                  data-testid="blueprint-drop-table"
                  className="px-3 py-1.5 text-[12px] font-bold rounded-md border border-rose-500/40 text-rose-300 bg-rose-950/40 hover:bg-rose-950/70 mr-auto"
                >
                  Drop table
                </button>
              )}
              <button data-testid="blueprint-footer-close"
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-[12px] font-semibold text-slate-400 hover:text-slate-200 rounded-md ml-auto"
              >
                Close
              </button>
              <button
                type="button"
                disabled={!hasOps}
                onClick={() => insertSql()}
                data-testid="blueprint-insert-sql"
                className="px-3 py-1.5 text-[12px] font-bold rounded-md border border-sky-500/35 text-sky-300 bg-sky-950/40 hover:bg-sky-950/70 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Insert SQL
              </button>
              <button
                type="button"
                disabled={!hasOps || applying}
                onClick={onApplyClick}
                data-testid="blueprint-apply"
                className="px-3 py-1.5 text-[12px] font-bold rounded-md border border-emerald-500/40 text-emerald-300 bg-emerald-950/50 hover:bg-emerald-950/80 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {applying ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
                ) : (
                  <Play className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                )}
                Apply
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmWrite && (
        <WriteConfirmDialog
          writeStatements={statements}
          credentialCount={1}
          onCancel={() => setConfirmWrite(false)}
          onConfirm={() => void runApply()}
        />
      )}
      {confirmDrop && (
        <WriteConfirmDialog
          writeStatements={dropStatements}
          credentialCount={1}
          onCancel={() => setConfirmDrop(false)}
          onConfirm={() => void runApply(dropStatements, true)}
        />
      )}
    </>,
    document.body
  );
};

function resolveDialectIdentityPreview(col: ColumnInfo, dialect: string): string {
  if (!col.identity || !isIntegerAutoIncrementType(col.type)) return '';
  const d = dialect.toLowerCase();
  if (dialectFamily(d) === 'mysql') return ' AUTO_INCREMENT';
  if (dialectFamily(d) === 'sqlserver') return ' IDENTITY(1,1)';
  if (d === 'redshift') return ' IDENTITY(0,1)';
  if (d === 'sqlite') return ' AUTOINCREMENT';
  const gen = col.identityGeneration ?? 'ALWAYS';
  return ` GENERATED ${gen} AS IDENTITY`;
}

const CUSTOM_TYPE = '__custom__';

const ColumnForm: React.FC<{
  value: BlueprintColumn;
  onChange: (c: BlueprintColumn) => void;
  onSave: () => void;
  onCancel: () => void;
  nameLocked: boolean;
  dialect: string;
}> = ({ value, onChange, onSave, onCancel, nameLocked, dialect }) => {
  const identityUi = dialectIdentitySupport(dialect);
  const constraints = dialectColumnConstraints(dialect);
  const typeOptions = useMemo(() => listDialectDataTypes(dialect), [dialect]);
  const [forceCustom, setForceCustom] = useState(false);
  const matched = typeOptions.find(
    (t) => t.value.toLowerCase() === value.type.trim().toLowerCase()
  );
  const selectValue = forceCustom || !matched ? CUSTOM_TYPE : matched.value;
  const kind = classifyColumnType(value.type);
  const kindUi = columnTypeKindClasses(kind);
  const intOk = isIntegerAutoIncrementType(value.type);
  const boolOk = isBooleanBitType(value.type);
  const size = parseTypeSize(value.type);
  const boolDefaults = useMemo(
    () => dialectBooleanDefaultOptions(dialect),
    [dialect]
  );

  const setType = (type: string) => {
    let next: BlueprintColumn = { ...value, type };
    if (value.identity && !isIntegerAutoIncrementType(type)) {
      next = withAutoIncrement(next, false);
    }
    // Clear incompatible boolean defaults when leaving boolean
    if (!isBooleanBitType(type) && value.defaultValue) {
      const allowed = new Set(dialectBooleanDefaultOptions(dialect).map((d) => d.value));
      if (allowed.has(value.defaultValue) && /^(TRUE|FALSE|1|0|NULL)$/i.test(value.defaultValue)) {
        // keep numeric defaults for ints; only clear TRUE/FALSE when leaving bool
        if (/^(TRUE|FALSE)$/i.test(value.defaultValue) && !isBooleanBitType(type)) {
          next = { ...next, defaultValue: undefined };
        }
      }
    }
    onChange(next);
  };

  const groups = useMemo(() => {
    const map = new Map<string, typeof typeOptions>();
    for (const opt of typeOptions) {
      const list = map.get(opt.group) ?? [];
      list.push(opt);
      map.set(opt.group, list);
    }
    return [...map.entries()];
  }, [typeOptions]);

  return (
    <div className="flex flex-col gap-2" data-testid="blueprint-column-form">
      <div className="flex items-center gap-2">
        <span
          className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${kindUi.badge}`}
        >
          {kindUi.label}
        </span>
        <span className="text-[10px] text-slate-500">{constraints.hint}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] font-bold text-slate-500 uppercase">Name</span>
          <input data-testid="blueprint-column-name"
            value={value.name}
            disabled={nameLocked}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono text-slate-200 outline-none accent-focus disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-0.5 min-w-0 sm:col-span-2">
          <span className="text-[10px] font-bold text-slate-500 uppercase">
            Type ({dialect})
          </span>
          <select
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === CUSTOM_TYPE) {
                setForceCustom(true);
                return;
              }
              setForceCustom(false);
              setType(v);
            }}
            data-testid="blueprint-type-select"
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono text-slate-200 outline-none accent-focus"
          >
            {groups.map(([group, opts]) => (
              <optgroup key={group} label={group}>
                {opts.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                    {opt.integerLike ? ' · auto-inc' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={CUSTOM_TYPE}>Custom…</option>
          </select>
          {selectValue === CUSTOM_TYPE && (
            <input
              value={value.type}
              onChange={(e) => setType(e.target.value)}
              placeholder="custom type"
              data-testid="blueprint-type-custom"
              className="mt-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono text-slate-200 outline-none accent-focus"
            />
          )}
        </label>

        {boolOk ? (
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] font-bold text-slate-500 uppercase">Default</span>
            <select
              value={value.defaultValue ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  defaultValue: e.target.value ? e.target.value : undefined,
                })
              }
              data-testid="blueprint-bool-default"
              className="bg-slate-900 border border-emerald-500/40 rounded px-2 py-1 text-[12px] font-mono text-emerald-100 outline-none focus:border-emerald-400"
            >
              {boolDefaults.map((o) => (
                <option key={o.label} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] font-bold text-slate-500 uppercase">Default</span>
            <input data-testid="blueprint-column-default"
              value={value.defaultValue ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  defaultValue: e.target.value.trim() ? e.target.value : undefined,
                })
              }
              placeholder="—"
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono text-slate-200 outline-none accent-focus"
            />
          </label>
        )}
      </div>

      {/* Length / precision */}
      {size.kind === 'length' && (
        <label className="flex items-center gap-2 text-[12px] text-amber-100">
          <span className="text-[10px] font-bold text-amber-400/90 uppercase shrink-0">Length</span>
          <input
            type="number"
            min={1}
            value={size.length ?? ''}
            placeholder="e.g. 255"
            data-testid="blueprint-type-length"
            onChange={(e) => {
              const n = e.target.value === '' ? undefined : Number(e.target.value);
              setType(applyTypeSize(value.type, { length: n }));
            }}
            className="w-28 bg-slate-900 border border-amber-500/35 rounded px-2 py-1 text-[12px] font-mono text-amber-50 outline-none accent-focus"
          />
          <span className="text-[11px] font-mono text-slate-500">{value.type}</span>
        </label>
      )}
      {size.kind === 'decimal' && (
        <div className="flex items-center gap-3 flex-wrap text-[12px] text-cyan-100">
          <label className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-cyan-400/90 uppercase">Precision</span>
            <input
              type="number"
              min={1}
              value={size.precision ?? ''}
              placeholder="10"
              data-testid="blueprint-type-precision"
              onChange={(e) => {
                const precision = e.target.value === '' ? undefined : Number(e.target.value);
                setType(
                  applyTypeSize(value.type, {
                    precision,
                    scale: size.scale,
                  })
                );
              }}
              className="w-20 bg-slate-900 border border-cyan-500/35 rounded px-2 py-1 text-[12px] font-mono outline-none accent-focus"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-cyan-400/90 uppercase">Scale</span>
            <input
              type="number"
              min={0}
              value={size.scale ?? ''}
              placeholder="2"
              data-testid="blueprint-type-scale"
              onChange={(e) => {
                const scale = e.target.value === '' ? undefined : Number(e.target.value);
                setType(
                  applyTypeSize(value.type, {
                    precision: size.precision,
                    scale,
                  })
                );
              }}
              className="w-20 bg-slate-900 border border-cyan-500/35 rounded px-2 py-1 text-[12px] font-mono outline-none accent-focus"
            />
          </label>
          <span className="text-[11px] font-mono text-slate-500">{value.type}</span>
        </div>
      )}

      {/* Auto-inc only for integers */}
      {intOk && (
        <div
          className="flex flex-col gap-1.5 rounded-md border border-violet-500/30 bg-violet-950/25 px-2.5 py-2"
          data-testid="blueprint-auto-increment"
        >
          <label className="flex items-center gap-2 text-[12px] text-violet-100 font-semibold cursor-pointer">
            <input data-testid="blueprint-column-identity"
              type="checkbox"
              checked={!!value.identity}
              onChange={(e) => onChange(withAutoIncrement(value, e.target.checked))}
              className="w-4 h-4 accent-violet-500"
            />
            Auto increment
            <span className="text-[10px] font-mono font-medium text-violet-300/90">
              → {identityUi.clauseHint}
            </span>
          </label>
          {value.identity && identityUi.generations && (
            <select data-testid="blueprint-column-identity-generation"
              value={value.identityGeneration ?? 'ALWAYS'}
              onChange={(e) =>
                onChange({
                  ...value,
                  identityGeneration: e.target.value as 'ALWAYS' | 'BY DEFAULT',
                })
              }
              className="ml-6 max-w-[200px] bg-slate-900 border border-violet-500/40 rounded px-2 py-1 text-[11px] font-mono text-violet-100 outline-none"
            >
              {identityUi.generations.map((g) => (
                <option key={g} value={g}>
                  GENERATED {g}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Constraints */}
      <div className="flex items-center gap-3 flex-wrap">
        {constraints.notNull && (
          <label className="flex items-center gap-1.5 text-[12px] text-slate-300 font-medium cursor-pointer">
            <input data-testid="blueprint-column-nullable"
              type="checkbox"
              checked={!value.nullable}
              onChange={(e) => onChange({ ...value, nullable: !e.target.checked })}
              className="w-3.5 h-3.5 accent-cyan-500"
            />
            NOT NULL
          </label>
        )}
        {constraints.unique && (
          <label className="flex items-center gap-1.5 text-[12px] text-slate-300 font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={!!value.unique}
              onChange={(e) => onChange({ ...value, unique: e.target.checked })}
              className="w-3.5 h-3.5 accent-amber-500"
              data-testid="blueprint-unique"
            />
            UNIQUE
          </label>
        )}
        <div className="ml-auto flex gap-1.5">
          <button data-testid="blueprint-column-cancel"
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button data-testid="blueprint-column-save"
            type="button"
            onClick={onSave}
            className="px-2.5 py-1 text-[11px] font-bold rounded border border-cyan-500/35 text-cyan-300 bg-cyan-950/40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
