import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  Play,
  Eraser,
  AlignLeft,
  Columns2,
  Rows3,
  RefreshCw,
  BookmarkPlus,
  Database,
  Bookmark,
  Network,
  Shield,
  Braces,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  History,
} from 'lucide-react';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { useAuthStore } from '@/app/store/authStore';
import { splitSqlStatements, type SplitStatement } from '@/shared/lib/sql-splitter';
import { formatEditorSql } from '@/shared/utils/formatSql';
import {
  effectiveConnectionIds,
  canExecuteWithoutDestination,
  indicesToRun,
  resolveRunStatements,
} from '@/app/store/sqlEditorTabLogic';
import { getSelectedSql, setCompletionContextGetter, setSqlMutator } from '../lib/sqlEditorBridge';
import { ConnectionChecklist } from './ConnectionChecklist';
import { EditorTabBar } from './EditorTabBar';
import { ResultsPanel } from './ResultsPanel';
import { DataPeekPanel } from './DataPeekPanel';
import { StatementStrip } from './StatementStrip';
import { SqlBookmarksPanel } from './SqlBookmarksPanel';
import { SqlVariablesPanel } from './SqlVariablesPanel';
import { SqlSecretsPanel, type SqlSecretsPanelHandle } from './SqlSecretsPanel';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { SqlSchemaExplorer, type SqlSchemaExplorerHandle } from './SqlSchemaExplorer';
import {
  SqlSidebarSection,
  useSidebarSectionHeights,
  useSidebarSectionOrder,
  useSidebarSectionsOpen,
  type SidebarSectionId,
} from './SqlSidebarSection';
import { WriteConfirmDialog } from './WriteConfirmDialog';
import { SqlRunsDrawer } from './SqlRunsDrawer';
import type { RevealRequest } from './SqlEditorPane';

const SqlEditorPane = lazy(() => import('./SqlEditorPane'));

const EditorFallback: React.FC = () => (
  <div
    className="flex-1 flex items-center justify-center text-slate-600"
    data-testid="sql-editor-loading"
  >
    <Loader2 className="w-5 h-5 animate-spin text-cyan-400" strokeWidth={SQL_ICON_STROKE} />
  </div>
);

const EDITOR_PCT_MIN = 15;
const EDITOR_PCT_MAX = 70;
const EDITOR_PCT_DEFAULT = 26;

const SIDEBAR_WIDTH_KEY = 'foxschema-sql-sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'foxschema-sql-sidebar-collapsed';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 288;

function loadSidebarWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(n)) return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
  } catch {
    /* ignore */
  }
  return SIDEBAR_DEFAULT;
}

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * SQL Editor workspace: multi-tab buffers, destination servers, schema explorer,
 * statement strip, layout toggle, Format/CSV. Results are per-tab and not persisted.
 */
export const SqlEditorView: React.FC = () => {
  const canEditorDestinations = useAuthStore((s) => s.can('editor.sidebar.destinations'));
  const canEditorBookmarks = useAuthStore((s) => s.can('editor.sidebar.bookmarks'));
  const canEditorVariables = useAuthStore((s) => s.can('editor.sidebar.variables'));
  const canEditorSecrets = useAuthStore((s) => s.can('editor.sidebar.secrets'));
  const canEditorSchema = useAuthStore((s) => s.can('editor.sidebar.schema'));
  const canSecretsView = useAuthStore((s) => s.can('secrets.view'));
  const canVariablesRead = useAuthStore((s) => s.can('editor.variables.read'));

  const connections = useSyncStore((s) => s.connections);
  const tabs = useSqlEditorStore((s) => s.tabs);
  const activeTabId = useSqlEditorStore((s) => s.activeTabId);
  const resultsByTab = useSqlEditorStore((s) => s.resultsByTab);
  const runningTabId = useSqlEditorStore((s) => s.runningTabId);
  const pendingWriteConfirm = useSqlEditorStore((s) => s.pendingWriteConfirm);
  const setSql = useSqlEditorStore((s) => s.setSql);
  const execute = useSqlEditorStore((s) => s.execute);
  const cancelWriteConfirm = useSqlEditorStore((s) => s.cancelWriteConfirm);
  const clearResults = useSqlEditorStore((s) => s.clearResults);
  const toggleStatement = useSqlEditorStore((s) => s.toggleStatement);
  const setLayout = useSqlEditorStore((s) => s.setLayout);
  const addTab = useSqlEditorStore((s) => s.addTab);
  const closeTab = useSqlEditorStore((s) => s.closeTab);
  const setActiveTab = useSqlEditorStore((s) => s.setActiveTab);
  const renameTab = useSqlEditorStore((s) => s.renameTab);
  const moveTab = useSqlEditorStore((s) => s.moveTab);
  const setMaxRows = useSqlEditorStore((s) => s.setMaxRows);
  const maxRows = useSqlEditorStore((s) => s.maxRows);
  const saveBookmark = useSqlEditorStore((s) => s.saveBookmark);
  const shareDestinations = useSqlEditorStore((s) => s.shareDestinations);
  const sharedConnectionIds = useSqlEditorStore((s) => s.sharedConnectionIds);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const setSafeMode = useSqlEditorStore((s) => s.setSafeMode);
  const multiTableConfirmThreshold = useSqlEditorStore((s) => s.multiTableConfirmThreshold);
  const setMultiTableConfirmThreshold = useSqlEditorStore((s) => s.setMultiTableConfirmThreshold);

  const tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!;
  // Drop connection ids that no longer exist in the saved list (persist-safe).
  const liveSelectedIds = effectiveConnectionIds(
    tab,
    shareDestinations,
    sharedConnectionIds
  ).filter((id) => connections.some((c) => c.id === id));

  const statements = useMemo(() => splitSqlStatements(tab.sql), [tab.sql]);
  const results = resultsByTab[tab.id];
  const running = runningTabId === tab.id;

  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [editorPct, setEditorPct] = useState(EDITOR_PCT_DEFAULT);
  const [hasSelection, setHasSelection] = useState(false);
  const [caretOffset, setCaretOffset] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const splitRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, , selectSidebar] = useSidebarSectionsOpen();
  const [sectionHeights, setSectionHeight] = useSidebarSectionHeights();
  const [sectionOrder, moveSection] = useSidebarSectionOrder();
  const prevDestCount = useRef(liveSelectedIds.length);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const secretsPanelRef = useRef<SqlSecretsPanelHandle>(null);
  const schemaExplorerRef = useRef<SqlSchemaExplorerHandle>(null);
  const [secretsRefreshing, setSecretsRefreshing] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);

  const onSecretsRefresh = useCallback(async () => {
    setSecretsRefreshing(true);
    try {
      await secretsPanelRef.current?.refresh();
    } finally {
      setSecretsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      /* ignore */
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const n = liveSelectedIds.length;
    if (n >= 2 && prevDestCount.current < 2 && tab.layout !== 'sideBySide') {
      setLayout('sideBySide');
    }
    prevDestCount.current = n;
  }, [liveSelectedIds.length, setLayout, tab.layout]);

  // Completion provider reads active SQL + checked schemas + variables via this getter.
  // Cold destinations warm lazily on first completion — not N+1 on every mount.
  useEffect(() => {
    setCompletionContextGetter(() => {
      const state = useSqlEditorStore.getState();
      const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0]!;
      const destIds = state.activeConnectionIds();
      const connections = useSyncStore.getState().connections;
      const schemas = destIds
        .map((id) => {
          const entry = state.schemaCache[id];
          if (entry?.status !== 'ready' || !entry.tables) {
            if (entry?.status !== 'loading') void state.ensureSchema(id);
            return null;
          }
          return {
            connectionId: id,
            tables: entry.tables,
            schema: connections.find((c) => c.id === id)?.schema,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
      return { sql: active.sql, schemas, variables: state.variables };
    });
    setSqlMutator((fn) => {
      const state = useSqlEditorStore.getState();
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      if (!active) return;
      state.setSql(fn(active.sql));
    });
    return () => setSqlMutator(null);
  }, []);

  const startEditorResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const root = splitRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setEditorPct(Math.min(EDITOR_PCT_MAX, Math.max(EDITOR_PCT_MIN, pct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (sidebarCollapsed) return;
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        setSidebarWidth(
          Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX))
        );
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
    },
    [sidebarCollapsed, sidebarWidth]
  );

  const firstSelected = connections.find((c) => liveSelectedIds.includes(c.id));
  const dialect = firstSelected?.dialect ?? 'sql';

  const selectedSqlForRun = hasSelection ? getSelectedSql() : null;
  // The caret decides which statement Run defaults to, so the button's count and
  // title have to follow it — otherwise the label disagrees with what runs.
  const runStatements = useMemo(
    () => resolveRunStatements(tab.sql, tab.checkedStatements, selectedSqlForRun, caretOffset),
    [tab.sql, tab.checkedStatements, selectedSqlForRun, caretOffset]
  );
  const canRunLocal = useMemo(
    () => canExecuteWithoutDestination(runStatements),
    [runStatements]
  );
  const runCount = runStatements.length;
  // Which cell(s) Run will send. With nothing checked or selected that is the
  // one under the caret, and saying so is the difference between "Run" doing
  // something invisible and the user knowing their UPDATE is the one going out.
  const runIndices = useMemo(
    () =>
      hasSelection ? [] : indicesToRun(tab.sql, tab.checkedStatements, caretOffset),
    [hasSelection, tab.sql, tab.checkedStatements, caretOffset]
  );
  const runWhich =
    tab.checkedStatements.length === 0 && runIndices.length === 1
      ? ` — In [${runIndices[0]! + 1}] at the caret`
      : '';
  const canRun = !runningTabId && (liveSelectedIds.length > 0 || canRunLocal);
  const runTitle = liveSelectedIds.length
    ? hasSelection
      ? 'Run the selected SQL  (⌘/Ctrl+Enter)'
      : !runCount
        ? `Run with empty editor against ${liveSelectedIds.length} server(s)  (⌘/Ctrl+Enter)`
        : `Run ${runCount} statement(s)${runWhich} against ${liveSelectedIds.length} server(s)  (⌘/Ctrl+Enter)`
    : canRunLocal
      ? `Run ${runCount} code cell(s) locally — no destination needed  (⌘/Ctrl+Enter)`
      : 'Check at least one destination server to run SQL, or use a JS/TS/Node code cell';

  const [formatNote, setFormatNote] = useState<string | null>(null);
  const formatNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onReveal = (stmt: SplitStatement) => {
    setReveal({ startLine: stmt.startLine, endLine: stmt.endLine, nonce: Date.now() });
  };

  const onFormat = () => {
    void (async () => {
      const before = tab.sql;
      const formatted = await formatEditorSql(before, dialect);
      if (formatted !== before) setSql(formatted);
      const fences = (before.match(/^\s*--\s*@(?:js|ts|node|nodets)\b/gim) ?? []).length;
      const note =
        formatted === before
          ? fences > 0
            ? 'Already formatted (SQL + Prettier JS/TS)'
            : 'Already formatted'
          : fences > 0
            ? `Formatted SQL + ${fences} JS/TS cell${fences === 1 ? '' : 's'} (Prettier)`
            : 'Formatted SQL';
      setFormatNote(note);
      if (formatNoteTimer.current) clearTimeout(formatNoteTimer.current);
      formatNoteTimer.current = setTimeout(() => setFormatNote(null), 2800);
    })();
  };

  useEffect(() => {
    return () => {
      if (formatNoteTimer.current) clearTimeout(formatNoteTimer.current);
    };
  }, []);

  const sidebarDragProps = useCallback(
    (orderIndex: number) => ({
      draggable: true as const,
      isDragging: dragFrom === orderIndex,
      isDragOver: dragOver === orderIndex && dragFrom !== orderIndex,
      onDragStart: (e: React.DragEvent) => {
        setDragFrom(orderIndex);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOver(orderIndex);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragFrom !== null && dragFrom !== orderIndex) {
          moveSection(dragFrom, orderIndex);
        }
        setDragFrom(null);
        setDragOver(null);
      },
      onDragEnd: () => {
        setDragFrom(null);
        setDragOver(null);
      },
    }),
    [dragFrom, dragOver, moveSection]
  );

  const renderSidebarSection = useCallback(
    (id: SidebarSectionId, orderIndex: number): React.ReactNode => {
      const drag = sidebarDragProps(orderIndex);
      switch (id) {
        case 'destinations':
          if (!canEditorDestinations) return null;
          return (
            <SqlSidebarSection
              railPanel
              id="destinations"
              title="Destinations"
              icon={<Database className="text-[#0284c7]" strokeWidth={SQL_ICON_STROKE} />}
              open={sidebarOpen.destinations}
              onToggle={() => selectSidebar('destinations')}
              height={sectionHeights.destinations}
              onResizeHeight={(h) => setSectionHeight('destinations', h)}
              {...drag}
            >
              <ConnectionChecklist />
            </SqlSidebarSection>
          );
        case 'bookmarks':
          if (!canEditorBookmarks) return null;
          return (
            <SqlSidebarSection
              railPanel
              id="bookmarks"
              title="Bookmarks"
              icon={<Bookmark className="text-[#f59e0b]" strokeWidth={SQL_ICON_STROKE} />}
              open={sidebarOpen.bookmarks}
              onToggle={() => selectSidebar('bookmarks')}
              height={sectionHeights.bookmarks}
              onResizeHeight={(h) => setSectionHeight('bookmarks', h)}
              actions={
                <button
                  type="button"
                  data-testid="sql-bookmark-save"
                  title="Save current query as a bookmark (uses the tab title)"
                  disabled={!tab.sql.trim()}
                  onClick={() => saveBookmark()}
                  className="flex items-center gap-0.5 text-[12px] font-bold text-[#d97706] hover:text-[#b45309] transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <BookmarkPlus className="w-3.5 h-3.5 text-[#f59e0b]" strokeWidth={SQL_ICON_STROKE} /> Save
                </button>
              }
              {...drag}
            >
              <SqlBookmarksPanel />
            </SqlSidebarSection>
          );
        case 'variables':
          if (!canEditorVariables || !canVariablesRead) return null;
          return (
            <SqlSidebarSection
              railPanel
              id="variables"
              title="Variables"
              icon={<Braces className="text-[#7c3aed]" strokeWidth={SQL_ICON_STROKE} />}
              open={sidebarOpen.variables}
              onToggle={() => selectSidebar('variables')}
              height={sectionHeights.variables}
              onResizeHeight={(h) => setSectionHeight('variables', h)}
              {...drag}
            >
              <SqlVariablesPanel />
            </SqlSidebarSection>
          );
        case 'vault':
          if (!canEditorSecrets || !canSecretsView) return null;
          return (
            <SqlSidebarSection
              railPanel
              id="vault"
              title="Secrets"
              icon={<KeyRound className="text-[#d97706]" strokeWidth={SQL_ICON_STROKE} />}
              open={sidebarOpen.vault}
              onToggle={() => selectSidebar('vault')}
              height={sectionHeights.vault}
              onResizeHeight={(h) => setSectionHeight('vault', h)}
              actions={
                <button
                  type="button"
                  data-testid="sql-secrets-refresh"
                  title="Re-fetch cloud secrets into Variables"
                  disabled={secretsRefreshing}
                  onClick={() => void onSecretsRefresh()}
                  className="flex items-center gap-0.5 text-[12px] font-bold text-[#0284c7] hover:text-[#0369a1] transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 text-[#0284c7] ${secretsRefreshing ? 'animate-spin' : ''}`}
                    strokeWidth={SQL_ICON_STROKE}
                  />
                  Refresh
                </button>
              }
              {...drag}
            >
              <SqlSecretsPanel ref={secretsPanelRef} />
            </SqlSidebarSection>
          );
        case 'utilities':
        case 'files':
          return null;
        case 'schema':
          if (!canEditorSchema) return null;
          return (
            <SqlSidebarSection
              railPanel
              id="schema"
              title="Schema"
              icon={<Network className="text-[#059669]" strokeWidth={SQL_ICON_STROKE} />}
              open={sidebarOpen.schema}
              onToggle={() => selectSidebar('schema')}
              grow
              height={sectionHeights.schema}
              onResizeHeight={(h) => setSectionHeight('schema', h)}
              actions={
                <button
                  type="button"
                  data-testid="sql-schema-new-table"
                  title="Create table — opens blueprint to add columns"
                  onClick={() => schemaExplorerRef.current?.openCreateTable()}
                  className="flex items-center gap-0.5 text-[12px] font-bold text-[#059669] hover:text-[#047857] transition"
                >
                  <Plus className="w-3.5 h-3.5 text-[#059669]" strokeWidth={SQL_ICON_STROKE} />
                  New table
                </button>
              }
              {...drag}
            >
              <SqlSchemaExplorer ref={schemaExplorerRef} />
            </SqlSidebarSection>
          );
        default:
          return null;
      }
    },
    [
      canEditorDestinations,
      canEditorBookmarks,
      canEditorVariables,
      canVariablesRead,
      canEditorSecrets,
      canSecretsView,
      canEditorSchema,
      sidebarOpen,
      selectSidebar,
      sectionHeights,
      setSectionHeight,
      tab.sql,
      saveBookmark,
      secretsRefreshing,
      onSecretsRefresh,
      sidebarDragProps,
    ]
  );

  const railIcons: {
    id: SidebarSectionId;
    title: string;
    visible: boolean;
    icon: React.ReactNode;
  }[] = [
    {
      id: 'schema',
      title: 'Schema',
      visible: canEditorSchema,
      icon: <Network className="text-[#059669]" strokeWidth={SQL_ICON_STROKE} />,
    },
    {
      id: 'destinations',
      title: 'Destinations',
      visible: canEditorDestinations,
      icon: <Database className="text-[#0284c7]" strokeWidth={SQL_ICON_STROKE} />,
    },
    {
      id: 'bookmarks',
      title: 'Bookmarks',
      visible: canEditorBookmarks,
      icon: <Bookmark className="text-[#f59e0b]" strokeWidth={SQL_ICON_STROKE} />,
    },
    {
      id: 'variables',
      title: 'Variables',
      visible: canEditorVariables && canVariablesRead,
      icon: <Braces className="text-[#7c3aed]" strokeWidth={SQL_ICON_STROKE} />,
    },
    {
      id: 'vault',
      title: 'Secrets',
      visible: canEditorSecrets && canSecretsView,
      icon: <KeyRound className="text-[#d97706]" strokeWidth={SQL_ICON_STROKE} />,
    },
  ];
  const orderedRail = sectionOrder
    .map((id) => railIcons.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r?.visible));
  const openRailId = orderedRail.find((r) => sidebarOpen[r.id])?.id ?? orderedRail[0]?.id ?? null;

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden" data-testid="sql-editor-view">
      <aside
        className="relative shrink-0 border-r border-slate-800 bg-slate-950 overflow-hidden flex min-h-0"
        style={{ width: sidebarCollapsed ? 48 : 48 + sidebarWidth }}
        data-testid={sidebarCollapsed ? 'sql-sidebar-collapsed' : 'sql-sidebar'}
      >
        <nav
          className="flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-slate-800 py-1"
          aria-label="SQL sections"
        >
          {sidebarCollapsed ? (
            <button
              type="button"
              data-testid="sql-sidebar-expand"
              title="Show sidebar"
              aria-label="Show sidebar"
              onClick={() => setSidebarCollapsed(false)}
              className="rounded p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            >
              <PanelLeftOpen className="h-4 w-4 text-sky-500" strokeWidth={SQL_ICON_STROKE} />
            </button>
          ) : (
            <button
              type="button"
              data-testid="sql-sidebar-collapse"
              title="Hide sidebar"
              aria-label="Hide sidebar"
              onClick={() => setSidebarCollapsed(true)}
              className="rounded p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            >
              <PanelLeftClose className="h-3.5 w-3.5 text-sky-500" strokeWidth={SQL_ICON_STROKE} />
            </button>
          )}
          {orderedRail.map((item) => {
            const on = item.id === openRailId && !sidebarCollapsed;
            // Only DOM-safe drag fields on the <div>; isDragging / isDragOver
            // are React-only and must not land as unknown attributes.
            const {
              isDragging,
              isDragOver,
              draggable,
              onDragStart,
              onDragOver,
              onDrop,
              onDragEnd,
            } = sidebarDragProps(sectionOrder.indexOf(item.id));
            return (
              <div
                key={item.id}
                data-testid={!on ? `sql-sidebar-${item.id}` : undefined}
                className={`flex w-full justify-center ${isDragging ? 'opacity-50' : ''} ${
                  isDragOver ? 'ring-1 ring-inset ring-cyan-500/40' : ''
                }`}
                draggable={draggable}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
              >
                <button
                  type="button"
                  data-testid={`sql-sidebar-toggle-${item.id}`}
                  title={item.title}
                  aria-label={item.title}
                  aria-expanded={on}
                  onClick={() => {
                    selectSidebar(item.id);
                    setSidebarCollapsed(false);
                  }}
                  className={`flex h-10 w-10 items-center justify-center rounded-md transition ${
                    on
                      ? 'bg-slate-800 text-slate-100 ring-1 ring-slate-600'
                      : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                  }`}
                >
                  <span className="flex items-center [&_svg]:h-4 [&_svg]:w-4">{item.icon}</span>
                </button>
              </div>
            );
          })}
        </nav>
        {!sidebarCollapsed && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-950">
            {sectionOrder.map((id, index) =>
              id === openRailId ? (
                <React.Fragment key={id}>{renderSidebarSection(id, index)}</React.Fragment>
              ) : null
            )}
          </div>
        )}
        {!sidebarCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            data-testid="sql-sidebar-resize"
            title="Drag to resize sidebar"
            onMouseDown={startSidebarResize}
            className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-cyan-500/40 active:bg-cyan-500/60"
          />
        )}
      </aside>

      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <EditorTabBar
          tabs={tabs}
          activeTabId={tab.id}
          onSelect={setActiveTab}
          onClose={closeTab}
          onAdd={addTab}
          onRename={renameTab}
          onMove={moveTab}
        />

        {/* Every control below is `whitespace-nowrap shrink-0`. Without both,
            a narrow window squeezed the flex items until their labels wrapped
            *inside* the buttons — "Run · 3" over two lines, "Format SQL+JS"
            over two, "Safe mode" over two.
            One row that scrolls, not a wrapping row: letting it wrap keeps the
            labels intact but grows the toolbar to three stacked rows (87px) even
            at 1440, and toolbar height is the thing that was already too big. */}
        <div className="flex items-center gap-2 overflow-x-auto px-4 py-2 border-b border-slate-800 bg-slate-900/60 shrink-0">
          {canEditorDestinations && (
            <div className="min-w-[9rem] max-w-[min(100%,28rem)] shrink">
              <ConnectionChecklist variant="chips" />
            </div>
          )}
          <button
            data-testid="sql-run-btn"
            onClick={() => execute()}
            disabled={!canRun}
            title={runTitle}
            /* Hover was missing entirely: the primary action of the workspace
               gave no feedback under the cursor. `brightness`, not a colour
               swap — the enabled state is the themed accent gradient, and a
               filter lifts it without re-stating any `--color-*` var. */
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-4 py-1.5 rounded text-xs font-bold transition shadow ${
              canRun
                ? 'accent-grad on-accent-fg cursor-pointer hover:brightness-110 hover:shadow-lg active:brightness-95'
                : 'bg-slate-800 text-slate-500 border border-slate-700/50 cursor-not-allowed'
            }`}
          >
            {running ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-200" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current text-emerald-50" strokeWidth={SQL_ICON_STROKE} />
            )}
            {hasSelection
              ? 'Run selection'
              : liveSelectedIds.length > 0
                ? `Run · ${liveSelectedIds.length}`
                : 'Run'}
          </button>
          <button
            type="button"
            data-testid="sql-refresh-btn"
            onClick={() => execute()}
            disabled={!canRun || !results}
            title={results ? 'Refresh results (re-run on all checked servers)' : 'Run a query first'}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1.5 rounded text-[11px] font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-cyan-400 ${running ? 'animate-spin' : ''}`}
              strokeWidth={SQL_ICON_STROKE}
            />{' '}
            Refresh
          </button>
          <button
            type="button"
            data-testid="sql-format-btn"
            onClick={onFormat}
            disabled={!tab.sql.trim()}
            title="Pretty-print SQL (sql-formatter) and JS/TS/Node cells (Prettier)"
            className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1.5 rounded text-[11px] font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <AlignLeft className="w-3.5 h-3.5 text-teal-400" strokeWidth={SQL_ICON_STROKE} /> Format
            SQL+JS
          </button>
          {formatNote && (
            <span
              data-testid="sql-format-note"
              className="text-[10px] font-semibold text-teal-300/90 animate-pulse max-w-[14rem] truncate"
              title={formatNote}
            >
              {formatNote}
            </span>
          )}
          <button
            type="button"
            data-testid="sql-bookmark-save-toolbar"
            onClick={() => saveBookmark()}
            disabled={!tab.sql.trim()}
            title="Bookmark this query (uses the tab title)"
            className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1.5 rounded text-[11px] font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <BookmarkPlus className="w-3.5 h-3.5 text-amber-400" strokeWidth={SQL_ICON_STROKE} /> Bookmark
          </button>
          <button
            type="button"
            data-testid="sql-runs-drawer-btn"
            aria-pressed={runsOpen}
            onClick={() => setRunsOpen((v) => !v)}
            title="Recent runs"
            className={`flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1.5 rounded text-[11px] font-semibold transition ${
              runsOpen
                ? 'bg-slate-800 text-cyan-300'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <History className="w-3.5 h-3.5 text-cyan-400" strokeWidth={SQL_ICON_STROKE} /> Runs
          </button>

          {/* `shrink-0`: a segmented control has no slack to give. Letting it
              shrink clips its second button behind `overflow-hidden`, which
              leaves the button hit-testable but not clickable. */}
          <div className="flex shrink-0 items-center rounded border border-slate-800 overflow-hidden ml-1">
            <button
              type="button"
              title="By credential — statements stacked vertically"
              data-testid="sql-layout-by-credential"
              onClick={() => setLayout('byCredential')}
              className={`flex items-center gap-1 whitespace-nowrap px-2 py-1 text-[10px] font-bold transition ${
                tab.layout === 'byCredential'
                  ? 'bg-slate-800 text-cyan-400'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <Rows3 className="w-3 h-3 text-cyan-400" strokeWidth={SQL_ICON_STROKE} /> By cred
            </button>
            <button
              type="button"
              title="Side by side (per statement) — compare cell values across servers"
              data-testid="sql-layout-side-by-side"
              onClick={() => setLayout('sideBySide')}
              className={`flex items-center gap-1 whitespace-nowrap px-2 py-1 text-[10px] font-bold transition border-l border-slate-800 ${
                tab.layout === 'sideBySide'
                  ? 'bg-slate-800 text-cyan-400'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <Columns2 className="w-3 h-3 text-sky-400" strokeWidth={SQL_ICON_STROKE} /> Side-by-side
            </button>
          </div>

          <label
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-semibold ml-1 cursor-pointer select-none transition hover:bg-slate-800/60"
            title="When on, UPDATE / DELETE / MERGE (and other writes) require confirmation before Run"
          >
            <input
              type="checkbox"
              data-testid="sql-safe-mode"
              checked={safeMode}
              onChange={(e) => setSafeMode(e.target.checked)}
              className="w-3.5 h-3.5 accent-rose-500 cursor-pointer"
            />
            <Shield
              className={`w-3 h-3 ${safeMode ? 'text-rose-400' : 'text-slate-500'}`}
              strokeWidth={SQL_ICON_STROKE}
            />
            <span className={safeMode ? 'text-rose-300' : 'text-slate-500'}>Safe mode</span>
          </label>

          <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] font-semibold text-slate-500 ml-1" title="Rows fetched per page (Next/Prev use this size)">
            Rows/page
            <input
              data-testid="sql-max-rows"
              type="number"
              min={1}
              max={5000}
              value={maxRows}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return;
                setMaxRows(Math.min(5000, Math.max(1, Math.floor(n))));
              }}
              className="w-14 bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-[11px] text-slate-200 font-mono outline-none accent-focus"
            />
          </label>

          <label
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] font-semibold text-slate-500 ml-1"
            title="When Safe mode is on, confirm writes that reference this many tables in one statement (0 = off). SELECT / JOIN reads skip this check. Suggests wrapping related writes in a transaction."
          >
            Tables≥
            <input
              data-testid="sql-multi-table-threshold"
              type="number"
              min={0}
              max={50}
              value={multiTableConfirmThreshold}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return;
                setMultiTableConfirmThreshold(n);
              }}
              className="w-10 bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-[11px] text-slate-200 font-mono outline-none accent-focus"
            />
          </label>

          <span className="shrink-0 whitespace-nowrap text-[11px] text-slate-500 ml-1">
            {runCount} statement{runCount === 1 ? '' : 's'} · {liveSelectedIds.length} server
            {liveSelectedIds.length === 1 ? '' : 's'}
          </span>
          <div className="flex-1" />
          {results && results.runs.length > 0 && (
            <button data-testid="sql-clear-results"
              onClick={clearResults}
              className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-semibold text-slate-500 hover:text-slate-300 transition"
            >
              <Eraser className="w-3 h-3 text-orange-400" strokeWidth={SQL_ICON_STROKE} /> Clear results
            </button>
          )}
        </div>

        <div ref={splitRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="min-h-[6rem] overflow-hidden border-b border-slate-800" style={{ height: `${editorPct}%` }}>
            <Suspense fallback={<EditorFallback />}>
              <SqlEditorPane
                key={tab.id}
                value={tab.sql}
                statements={statements}
                dialect={dialect}
                onChange={setSql}
                onRun={() => execute()}
                onSelectionChange={setHasSelection}
                onCaretChange={setCaretOffset}
                reveal={reveal}
              />
            </Suspense>
          </div>

          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize editor and results"
            data-testid="sql-editor-resize"
            onMouseDown={startEditorResize}
            title="Drag to resize editor / results"
            className="h-1.5 shrink-0 cursor-row-resize bg-slate-900 hover:bg-cyan-500/40 active:bg-cyan-500/60 transition-colors border-y border-slate-800/80"
          />

          <StatementStrip
            statements={statements}
            checked={tab.checkedStatements}
            running={running}
            sqlNeedsDestination={liveSelectedIds.length === 0}
            onToggle={toggleStatement}
            onReveal={onReveal}
            onRunCell={(index) => void execute({ statementIndices: [index] })}
          />

          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <ResultsPanel
              runs={results?.runs ?? []}
              statements={results?.ranStatements ?? []}
              statementIndices={results?.ranStatementIndices}
              layout={tab.layout}
              refreshing={running}
              warnings={results?.warnings}
              pageState={results?.pageMeta}
              onPage={(args) => void useSqlEditorStore.getState().loadResultPage(args)}
              onRefresh={(connectionId) =>
                execute(connectionId ? { connectionIds: [connectionId] } : undefined)
              }
            />
          </div>
        </div>
      </section>
      <SqlRunsDrawer open={runsOpen} onClose={() => setRunsOpen(false)} />

      {pendingWriteConfirm && pendingWriteConfirm.tabId === tab.id && (
        <WriteConfirmDialog
          writeStatements={pendingWriteConfirm.writeStatements}
          credentialCount={pendingWriteConfirm.credentialCount}
          readonlyTargets={pendingWriteConfirm.readonlyTargets}
          multiTableStatements={pendingWriteConfirm.multiTableStatements}
          requireMissingWhereAck
          onCancel={cancelWriteConfirm}
          onConfirm={() =>
            execute({
              confirmedWrites: true,
              connectionIds: pendingWriteConfirm.connectionIds,
              statementIndices: pendingWriteConfirm.statementIndices,
            })
          }
        />
      )}
      {/* Always mounted so FK clicks from results work even when Schema is collapsed. */}
      <DataPeekPanel />
    </div>
  );
};
