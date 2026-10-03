import React, { useState, useMemo, Suspense, lazy } from 'react';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '@/app/store/authStore';
import { Play, RefreshCw, FileText, CheckCircle2, Copy, AlertTriangle, GitCommitHorizontal } from 'lucide-react';
import { CommitMigrationDialog, commitRequirement, useGitStore } from '@/features/git';
import { SqlGeneratorModule } from '@/shared/lib/sql-generator';
import { findDropDependencies } from '@foxschema/sql';
import { findMissingFkTargets, findNarrowingTypeChanges, extractReviewNotices, resolveDialect } from '@/shared/lib/migration-validation';
import { buildIncludedDiffs, applySelectionsForScan, buildMapping } from '@/app/store/sync-helpers';
import { formatSql } from '@/shared/utils/formatSql';
import { SchemaBlueprint, DiffBriefingPanel } from '@/features/schema-diff';
import { DetailTabs, type DetailTab } from '@/features/schema-diff';
import {
  buildTableDdlDiffLines,
  DdlDiffLines,
  stripSchemaQualifiers,
} from '@/features/schema-diff';
import { writeClipboard } from '@/shared/utils/clipboard';
import { MigrationProgressPanel } from '@/features/object-detail/components/MigrationProgressPanel';
import { DeployConfirmDialog } from '@/features/object-detail/components/DeployConfirmDialog';
import { DependencyWarningDialog } from '@/features/object-detail/components/DependencyWarningDialog';
import { ValidationWarningsDialog } from '@/features/object-detail/components/ValidationWarningsDialog';
import { CrossDialectReadinessDialog } from '@/features/object-detail/components/CrossDialectReadinessDialog';
// Monaco is heavy — load it only when a SQL surface is actually shown
const SqlEditor = lazy(() =>
  import('@/features/sql-editor/components/SqlEditor').then((m) => ({ default: m.SqlEditor }))
);
const SqlDiffEditor = lazy(() =>
  import('@/features/sql-editor/components/SqlEditor').then((m) => ({ default: m.SqlDiffEditor }))
);

const EditorFallback: React.FC = () => (
  <div className="flex-1 flex items-center justify-center text-slate-500 text-xs gap-2">
    <RefreshCw className="w-4 h-4 animate-spin" /> Loading editor...
  </div>
);

const ddlGenerator = new SqlGeneratorModule();

/** Skip synchronous format on huge DDL (same gate as Migration SQL tab). */
const FORMAT_SQL_MAX = 50_000;

function formatSqlBounded(sql: string, dialect: string): string {
  if (!sql || sql.length > FORMAT_SQL_MAX) return sql;
  return formatSql(sql, dialect);
}

// Persisted "skip the deploy confirmation" preference.
const SKIP_DEPLOY_CONFIRM_KEY = 'foxschema-skip-deploy-confirm';

export const ObjectDetailPanel: React.FC = () => {
  const canMigrate = useAuthStore((s) => s.can('schema.migrate'));
  // Migrations in Git: committing needs to see repositories and to migrate.
  const canUseGit = useAuthStore((s) => s.can('git.view')) && canMigrate;
  const gitRepos = useGitStore((s) => s.repos);
  const loadGitRepos = useGitStore((s) => s.load);
  const requirement = useGitStore(commitRequirement);
  const commitRequired = requirement === 'required';
  const gitSettingsPending = canUseGit && requirement === 'unknown';
  const committedMigration = useSyncStore((s) => s.committedMigration);
  const commitMatchesPlan = useSyncStore((s) => s.commitMatchesPlan);
  const [showCommit, setShowCommit] = useState(false);
  React.useEffect(() => {
    if (canUseGit) void loadGitRepos();
  }, [canUseGit, loadGitRepos]);
  // Only these fields: a whole-store subscription re-rendered this on every
  // store write (migration progress events included).
  const {
    selectedTable,
    generatedSql,
    applyMigration,
    migrationExecuted,
    isComparing,
    sourceConfig,
    targetConfig,
    targetConnected,
    compareResult,
    browseMode,
    browseSide,
    syncSelection,
    toggleSyncSelection,
    nonDestructive,
    isMigrating,
    searchTerm,
    memberSelection,
    toggleMemberSelection,
    setAllMemberSelection,
    indexSelection,
    toggleIndexSelection,
    setAllIndexSelection,
    columnSelection,
    toggleColumnSelection,
    setAllColumnSelection,
    triggerSelection,
    toggleTriggerSelection,
    setAllTriggerSelection,
    targetServerVersion,
  } = useSyncStore(
    useShallow((s) => ({
      selectedTable: s.selectedTable,
      generatedSql: s.generatedSql,
      applyMigration: s.applyMigration,
      migrationExecuted: s.migrationExecuted,
      isComparing: s.isComparing,
      sourceConfig: s.sourceConfig,
      targetConfig: s.targetConfig,
      targetConnected: s.targetConnected,
      compareResult: s.compareResult,
      browseMode: s.browseMode,
      browseSide: s.browseSide,
      syncSelection: s.syncSelection,
      toggleSyncSelection: s.toggleSyncSelection,
      nonDestructive: s.nonDestructive,
      isMigrating: s.isMigrating,
      searchTerm: s.searchTerm,
      memberSelection: s.memberSelection,
      toggleMemberSelection: s.toggleMemberSelection,
      setAllMemberSelection: s.setAllMemberSelection,
      indexSelection: s.indexSelection,
      toggleIndexSelection: s.toggleIndexSelection,
      setAllIndexSelection: s.setAllIndexSelection,
      columnSelection: s.columnSelection,
      toggleColumnSelection: s.toggleColumnSelection,
      setAllColumnSelection: s.setAllColumnSelection,
      triggerSelection: s.triggerSelection,
      toggleTriggerSelection: s.toggleTriggerSelection,
      setAllTriggerSelection: s.setAllTriggerSelection,
      targetServerVersion: s.targetServerVersion,
    }))
  );

  const includedCount = Object.values(syncSelection).filter(Boolean).length;

  const [activeTab, setActiveTab] = useState<DetailTab>('DIFF');
  const [copied, setCopied] = useState(false);
  const [expandedTriggers, setExpandedTriggers] = useState<Record<string, boolean>>({});
  // Matches the case-insensitive schema compare; toggle off to inspect raw identifier casing
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [inlineDiff, setInlineDiff] = useState(false);
  // Schema Blueprint: off = only changed items, on = include unchanged too
  const [showUnchangedDetail, setShowUnchangedDetail] = useState(false);
  // Deploy confirmation dialog
  const [showConfirm, setShowConfirm] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  // Pre-deploy warning: dropped tables/columns still referenced by views/functions/procedures.
  // The dialog always renders the live scan (below) — this only tracks open/closed.
  const [showDepsDialog, setShowDepsDialog] = useState(false);
  // Explicit acknowledgment for destructive drops / MySQL binlog risk — keyed to the
  // exact generatedSql that was acknowledged, so any change to the plan (new selection,
  // toggling non-destructive, etc.) silently invalidates a stale checkbox instead of
  // carrying forward consent for a plan the user never actually saw.
  const [destructiveAckSql, setDestructiveAckSql] = useState<string | null>(null);
  const [mysqlAckSql, setMysqlAckSql] = useState<string | null>(null);
  const [narrowingAckSql, setNarrowingAckSql] = useState<string | null>(null);
  const [showFkDialog, setShowFkDialog] = useState(false);
  const [showNarrowingDialog, setShowNarrowingDialog] = useState(false);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [showReadinessDialog, setShowReadinessDialog] = useState(false);

  /**
   * The diffs the script is actually built from.
   *
   * The scans below used to read the raw compare, so unticking a dropped or
   * narrowing column left its warning standing — and could keep Execute
   * disabled over a statement the preview no longer contained.
   */
  const selections = useMemo(
    () => ({
      selection: syncSelection,
      memberSelection,
      indexSelection,
      columnSelection,
      triggerSelection,
    }),
    [syncSelection, memberSelection, indexSelection, columnSelection, triggerSelection]
  );
  /**
   * The whole compare, with opt-outs applied to what is being migrated.
   *
   * Passing only the included diffs starved the validators of the objects they
   * reason *about* rather than deploy — an added key whose parent was an
   * existing unticked table read as a missing target, and drop warnings for
   * unselected dependents vanished. The object selection still comes from
   * `syncSelection`, unchanged.
   */
  const scannedDiffs = useMemo(
    () => (compareResult ? applySelectionsForScan(compareResult.tables, selections) : []),
    [compareResult, selections]
  );
  /** Only the objects actually going into the script, for the plan. */
  const includedDiffs = useMemo(
    () => (compareResult ? buildIncludedDiffs(compareResult.tables, selections) : []),
    [compareResult, selections]
  );

  // Live dependency scan — recomputed on every selection/nonDestructive change, not just
  // on Execute click, so the button can stay disabled until conflicts are resolved.
  const liveDropDeps = useMemo(
    () => (compareResult ? findDropDependencies(scannedDiffs, syncSelection, { nonDestructive }) : []),
    [compareResult, scannedDiffs, syncSelection, nonDestructive]
  );
  const hasUnresolvedDropDeps = liveDropDeps.length > 0;

  // Live pre-flight validation — missing FK targets, narrowing type changes, and the
  // generator's own "-- review:" / "MANUAL REVIEW REQUIRED" notices surfaced up front
  // instead of only inside the scrolled SQL preview.
  const missingFkIssues = useMemo(
    () => (compareResult ? findMissingFkTargets(scannedDiffs, syncSelection) : []),
    [compareResult, scannedDiffs, syncSelection]
  );
  const narrowingIssues = useMemo(
    () =>
      compareResult
        ? findNarrowingTypeChanges(scannedDiffs, syncSelection, resolveDialect(targetConfig.dialect))
        : [],
    [compareResult, scannedDiffs, syncSelection, targetConfig.dialect]
  );
  const reviewIssues = useMemo(() => {
    if (!compareResult) return [];
    const steps = ddlGenerator.generateMigrationPlan(
      includedDiffs,
      targetConfig.dialect,
      buildMapping({ sourceConfig, targetConfig, nonDestructive, targetServerVersion }),
      compareResult.tables
    );
    return extractReviewNotices(steps);
  }, [compareResult, includedDiffs, sourceConfig, targetConfig, nonDestructive, targetServerVersion]);
  const hasMissingFkTargets = missingFkIssues.length > 0;
  const hasNarrowingChanges = narrowingIssues.length > 0;
  const narrowingAcked = narrowingAckSql !== null && narrowingAckSql === generatedSql;

  // Destructive drops (DROP TABLE/COLUMN/INDEX) in the generated plan while non-destructive
  // mode is off — require an explicit checkbox acknowledgment before Execute unlocks.
  const hasDestructiveDrops = !nonDestructive && !!generatedSql && /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i.test(generatedSql);
  const destructiveDropsAcked = destructiveAckSql !== null && destructiveAckSql === generatedSql;

  const toggleTriggerDdl = (name: string) =>
    setExpandedTriggers((prev) => ({ ...prev, [name]: !prev[name] }));

  // Pretty-print the migration script — but only when the SQL tab is actually
  // shown, and skip very large scripts: formatting the whole thing (with routine
  // bodies) is synchronous and can freeze the UI on big schemas.
  // NOTE: must stay above any early return — hooks run unconditionally every render.
  const formattedSql = useMemo(() => {
    if (activeTab !== 'SQL' || !generatedSql) return generatedSql ?? '';
    return formatSqlBounded(generatedSql, targetConfig.dialect);
  }, [activeTab, generatedSql, targetConfig.dialect]);

  // Blueprint definition viewer — memoize so re-renders (search, checkboxes) don't reformat.
  const blueprintDefinitionSql = useMemo(() => {
    if (!selectedTable || selectedTable.objectType === 'TABLE') return '';
    const src = selectedTable.sourceTable?.definition;
    const tgt = selectedTable.targetTable?.definition;
    if (src) return formatSqlBounded(src, sourceConfig.dialect);
    if (tgt) return formatSqlBounded(tgt ?? '', targetConfig.dialect);
    return '';
  }, [selectedTable, sourceConfig.dialect, targetConfig.dialect]);

  // Non-table DDL Diff sides — only when that tab is open.
  const ddlDiffSides = useMemo(() => {
    if (!selectedTable || selectedTable.objectType === 'TABLE' || activeTab !== 'DDL_DIFF') {
      return { sourceDdl: '', targetDdl: '' };
    }
    const stripSchemas = (ddl: string) =>
      stripSchemaQualifiers(ddl, [sourceConfig.schema, targetConfig.schema]);
    const rawSource = selectedTable.sourceTable
      ? ddlGenerator.generateObjectDdl(selectedTable.sourceTable, sourceConfig.dialect)
      : '';
    const rawTarget = selectedTable.targetTable
      ? ddlGenerator.generateObjectDdl(selectedTable.targetTable, targetConfig.dialect)
      : '';
    return {
      sourceDdl: stripSchemas(formatSqlBounded(rawSource, sourceConfig.dialect)),
      targetDdl: stripSchemas(formatSqlBounded(rawTarget, targetConfig.dialect)),
    };
  }, [selectedTable, activeTab, sourceConfig.dialect, sourceConfig.schema, targetConfig.dialect, targetConfig.schema]);

  // Expanded trigger DDL diffs — format only when a row is open.
  const formattedTriggerDdls = useMemo(() => {
    if (!selectedTable) return {} as Record<string, { oldDdl: string; newDdl: string }>;
    const out: Record<string, { oldDdl: string; newDdl: string }> = {};
    for (const trg of selectedTable.triggerDiffs ?? []) {
      if (!expandedTriggers[trg.name]) continue;
      out[trg.name] = {
        oldDdl: trg.target?.definition
          ? formatSqlBounded(trg.target.definition, targetConfig.dialect).trim()
          : '',
        newDdl: trg.source?.definition
          ? formatSqlBounded(trg.source.definition, sourceConfig.dialect).trim()
          : '',
      };
    }
    return out;
  }, [selectedTable, expandedTriggers, sourceConfig.dialect, targetConfig.dialect]);

  if (!selectedTable) {
    if (compareResult && !browseMode) {
      return <DiffBriefingPanel />;
    }
    // In Browse the left pane filters one database's objects, so this side
    // should say *which* database that is. Comparing has two connections named
    // in the toolbar already; browsing has one, and it was nowhere on screen.
    const browsed = browseSide === 'target' ? targetConfig : sourceConfig;
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-500 bg-slate-950/20 p-6">
        <FileText className="w-12 h-12 text-slate-800 mb-3 animate-pulse" />
        <p className="text-sm font-semibold text-slate-400">Select Object to View Details</p>
        <p className="text-xs text-slate-600 max-w-xs text-center mt-1">
          Select an object from the left browser tree to inspect columns, indices, definitions,
          {browseMode ? ' and its CREATE script.' : ' and generated migration DDL.'}
        </p>
        {browseMode && (
          <dl
            data-testid="browse-connection-card"
            className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-3 text-xs"
          >
            <dt className="text-slate-500">Dialect</dt>
            <dd className="font-mono text-cyan-300">{browsed.dialect.toUpperCase()}</dd>
            {browsed.option.host && (
              <>
                <dt className="text-slate-500">Host</dt>
                <dd className="font-mono text-slate-300">{browsed.option.host}</dd>
              </>
            )}
            {browsed.option.database && (
              <>
                <dt className="text-slate-500">Database</dt>
                <dd className="font-mono text-slate-300">{browsed.option.database}</dd>
              </>
            )}
            {browsed.schema && (
              <>
                <dt className="text-slate-500">Schema</dt>
                <dd className="font-mono text-slate-300">{browsed.schema}</dd>
              </>
            )}
            <dt className="text-slate-500">Objects</dt>
            <dd className="font-mono text-slate-300">{compareResult?.tables.length ?? 0}</dd>
          </dl>
        )}
      </div>
    );
  }

  // Proceed to the normal confirm step (or deploy directly if the user opted out).
  const proceedToConfirm = () => {
    if (localStorage.getItem(SKIP_DEPLOY_CONFIRM_KEY) === 'true') {
      applyMigration();
    } else {
      setDontAskAgain(false);
      setShowConfirm(true);
    }
  };

  // Execute is disabled whenever hasUnresolvedDropDeps is true (see the disabled
  // expression on the button below), so reaching this handler means the dependency
  // scan is already clean. Kept as a defensive re-check rather than trusting that
  // every call site respects the disabled state.
  const handleExecuteClick = () => {
    if (liveDropDeps.length > 0) {
      setShowDepsDialog(true);
      return;
    }
    proceedToConfirm();
  };

  const confirmExecute = () => {
    if (dontAskAgain) localStorage.setItem(SKIP_DEPLOY_CONFIRM_KEY, 'true');
    setShowConfirm(false);
    applyMigration();
  };

  const handleCopySql = async () => {
    if (!formattedSql) return;
    // Only claim "Copied!" when it was: writeText rejects without focus/permission.
    if (!(await writeClipboard(formattedSql))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderDdlDiff = () => {
    // Catalog definitions are often a single unreadable line — format non-table
    // DDL on both sides so the diff compares structure, not whitespace.
    // Schema qualifiers are stripped in `ddlDiffSides` (false positives across dialects).
    const isTable = selectedTable.objectType === 'TABLE';

    // Tables: status-driven colouring from columnDiffs (aligns by column name, colours
    // by what the migration DOES — see buildTableDdlDiffLines). Everything else
    // (views/functions/triggers/sequences) keeps the Monaco text diff.
    const stripSchemas = (ddl: string) =>
      stripSchemaQualifiers(ddl, [sourceConfig.schema, targetConfig.schema]);
    const tableLines = isTable
      ? buildTableDdlDiffLines(selectedTable, sourceConfig.dialect, targetConfig.dialect, stripSchemas)
      : [];
    const q = searchTerm.trim().toLowerCase();
    const { sourceDdl, targetDdl } = ddlDiffSides;
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-slate-950/90 border-t border-slate-850">
        {/* Diff header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/60">
          <span className="text-xs font-mono text-slate-400 flex items-center gap-2">
            <span className="text-slate-300">{selectedTable.tableName}</span>
            <span className="text-slate-600">—</span>
            {isTable ? (
              /* Tables show a single canonical view (source column order = the desired
                 end state) with each line coloured by its ColumnDiff status. Colour =
                 what the migration DOES to the target: green add, amber change, red drop. */
              <span className="text-slate-500 text-[10px] italic">how the target will look after sync</span>
            ) : (
              <>
                {/* Non-table objects (view/function/procedure/trigger) are replaced
                    wholesale, so we diff in MIGRATION direction: current target (left)
                    → desired source (right). Standard diff colours then read correctly —
                    red = removed by the migration, green = added to reach the source
                    definition — instead of being inverted. */}
                <span className="text-slate-500 text-[10px] italic">Target (current)</span>
                <span className="text-slate-600">→</span>
                <span className="text-slate-500 text-[10px] italic">Source (desired)</span>
              </>
            )}
            <span className="ml-1 flex items-center gap-2 text-[10px]">
              {selectedTable.status === 'ADDED' && (
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/70"></span><span className="text-emerald-300/80">new object</span></span>
              )}
              {selectedTable.status === 'REMOVED' && (
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/70"></span><span className="text-red-300/80">dropped</span></span>
              )}
              {(selectedTable.status === 'MODIFIED' || selectedTable.status === 'UNCHANGED') && (
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/70"></span><span className="text-amber-300/80">modified</span></span>
              )}
            </span>
          </span>
          <div className="flex items-center gap-3">
            {isTable ? (
              <span className="flex items-center gap-2 text-[10px] text-slate-500">
                <span className="flex items-center gap-1"><span className="text-emerald-400 font-bold">+</span>add</span>
                <span className="flex items-center gap-1"><span className="text-amber-400 font-bold">~</span>change</span>
                <span className="flex items-center gap-1"><span className="text-rose-400 font-bold">−</span>drop</span>
              </span>
            ) : (
              <>
                <label className="text-[10px] text-slate-400 flex items-center gap-1.5 cursor-pointer" title="Ignore identifier letter-case, matching how columns are compared">
                  <input
                    type="checkbox"
                    checked={ignoreCase}
                    onChange={(e) => setIgnoreCase(e.target.checked)}
                    className="w-3 h-3 accent-cyan-500 cursor-pointer"
                  />
                  Ignore case
                </label>
                <button
                  onClick={() => setInlineDiff((v) => !v)}
                  className="text-[10px] text-slate-300 border border-slate-700 hover:border-slate-500 rounded px-2 py-0.5 transition"
                >
                  {inlineDiff ? 'Side-by-side' : 'Inline'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 relative">
          {isTable ? (
            <div className="absolute inset-0 overflow-auto bg-slate-950/90">
              <DdlDiffLines lines={tableLines} query={q} />
            </div>
          ) : (
            <div className="absolute inset-0">
              <Suspense fallback={<EditorFallback />}>
                <SqlDiffEditor
                  original={targetDdl}
                  modified={sourceDdl}
                  dialect={targetConfig.dialect}
                  inline={inlineDiff}
                  ignoreCase={ignoreCase}
                  highlight={searchTerm}
                  status={selectedTable.status === 'ADDED' || selectedTable.status === 'REMOVED' ? selectedTable.status : 'MODIFIED'}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSchemaObjectDiff = () => {
    // Highlight the object-browser search keyword in the blueprint (e.g. a
    // matched column name), mirroring the SQL panels.
    const query = searchTerm.trim().toLowerCase();

    return (
      <div className="flex-1 flex flex-col min-h-0 text-xs overflow-y-auto p-6 space-y-6">
        {/* Table Overview Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/50 tracking-wider">
                {selectedTable.objectType}
              </span>
              <h3 className="text-xl font-extrabold text-slate-50 tracking-tight">{selectedTable.tableName}</h3>
            </div>
            <p className="text-xs text-slate-500 mt-2 flex items-center gap-1.5">
              Status:
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                selectedTable.status === 'ADDED'    ? 'text-emerald-400 bg-emerald-950/40 border-emerald-500/25' :
                selectedTable.status === 'REMOVED'  ? 'text-rose-400 bg-rose-950/40 border-rose-500/25' :
                selectedTable.status === 'MODIFIED' ? 'text-amber-400 bg-amber-950/40 border-amber-500/25' :
                                                      'text-slate-400 bg-slate-800/60 border-slate-700/40'
              }`}>
                {selectedTable.status}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!browseMode && (
            <label
              className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-300 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded hover:border-cyan-500/40 transition"
              title="Show unchanged columns, indexes, foreign keys and triggers (off = only changes)"
            >
              <input
                type="checkbox"
                checked={showUnchangedDetail}
                onChange={(e) => setShowUnchangedDetail(e.target.checked)}
                className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
              />
              Show unchanged
            </label>
            )}
            {selectedTable.status !== 'UNCHANGED' && (
              <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-300 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded hover:border-cyan-500/40 transition">
                <input
                  type="checkbox"
                  checked={!!syncSelection[selectedTable.tableName]}
                  onChange={() => toggleSyncSelection(selectedTable.tableName)}
                  className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
                />
                Deploy to Target
              </label>
            )}
            {(() => {
              const ts = selectedTable.sourceTable?.tablespace ?? selectedTable.targetTable?.tablespace;
              return ts ? (
                <div className="text-[10px] text-slate-400 font-mono bg-slate-900 border border-slate-800 px-3 py-1 rounded" title="Storage tablespace">
                  Tablespace: <span className="text-cyan-300">{ts}</span>
                </div>
              ) : null;
            })()}
            <div className="text-[10px] text-slate-500 font-mono bg-slate-900 border border-slate-800 px-3 py-1 rounded">
              Target Dialect: {targetConfig.dialect.toUpperCase()}
            </div>
            {sourceConfig.dialect !== targetConfig.dialect && (
              <button
                onClick={() => setShowReadinessDialog(true)}
                className="text-[10px] text-amber-300 font-mono bg-amber-950/40 border border-amber-500/30 px-3 py-1 rounded hover:bg-amber-900/40 transition cursor-pointer"
                title="Cross-dialect migration — click for a per-object-type breakdown of what's translated vs. flagged for manual review"
              >
                Cross-dialect: {sourceConfig.dialect.toUpperCase()} → {targetConfig.dialect.toUpperCase()} · view readiness
              </button>
            )}
          </div>
        </div>

        {/* The blueprint tables — the same component the version-history compare
            renders, so a stored diff and a live diff never look different. */}
        <SchemaBlueprint
          diff={selectedTable}
          query={query}
          // Browse mode synthesizes every field as UNCHANGED (nothing is being
          // compared), so hiding them would leave the blueprint empty.
          showUnchanged={browseMode || showUnchangedDetail}
          memberSelection={memberSelection[selectedTable.tableName]}
          onToggleMember={(name) => toggleMemberSelection(selectedTable.tableName, name)}
          onSelectAllMembers={(checked) => setAllMemberSelection(selectedTable.tableName, checked)}
          indexSelection={indexSelection[selectedTable.tableName]}
          onToggleIndex={(name) => toggleIndexSelection(selectedTable.tableName, name)}
          onSelectAllIndexes={(checked) => setAllIndexSelection(selectedTable.tableName, checked)}
          siblingDiffs={includedDiffs}
          columnSelection={columnSelection[selectedTable.tableName]}
          onToggleColumn={(name) => toggleColumnSelection(selectedTable.tableName, name)}
          onSelectAllColumns={(checked) => setAllColumnSelection(selectedTable.tableName, checked)}
          triggerSelection={triggerSelection[selectedTable.tableName]}
          onToggleTriggerSelection={(name) => toggleTriggerSelection(selectedTable.tableName, name)}
          onSelectAllTriggers={(checked) => setAllTriggerSelection(selectedTable.tableName, checked)}
          expandedTriggers={expandedTriggers}
          onToggleTrigger={toggleTriggerDdl}
          triggerDdls={formattedTriggerDdls}
          ignoreCase={ignoreCase}
          definitionSlot={
            selectedTable.objectType !== 'TABLE' &&
            (selectedTable.sourceTable?.definition || selectedTable.targetTable?.definition) ? (
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                  <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full"></span> Source DDL Definition
                </h4>
                <div className="bg-slate-950 border border-slate-850 rounded-lg overflow-hidden h-64">
                  <Suspense fallback={<EditorFallback />}>
                    <SqlEditor
                      highlight={searchTerm}
                      dialect={selectedTable.sourceTable?.definition ? sourceConfig.dialect : targetConfig.dialect}
                      value={blueprintDefinitionSql}
                    />
                  </Suspense>
                </div>
              </div>
            ) : null
          }
        />
      </div>
    );
  };

  // MySQL/MariaDB refuse CREATE FUNCTION/PROCEDURE/TRIGGER when binary logging is on
  // and the connecting user lacks SUPER (error 1419), unless
  // log_bin_trust_function_creators=1. Warn when the migration deploys (creates or
  // recreates) any routine or trigger to a MySQL target. Triggers ride inside a
  // table's ALTER step, so check triggerDiffs as well as top-level routine objects.
  const targetIsMySql = ['mysql', 'mariadb'].includes(targetConfig.dialect.toLowerCase());
  const deploysRoutineToMySql =
    targetIsMySql &&
    (compareResult?.tables ?? []).some((t) => {
      if (!syncSelection[t.tableName]) return false;
      if (
        (t.objectType === 'FUNCTION' || t.objectType === 'PROCEDURE' || t.objectType === 'TRIGGER') &&
        (t.status === 'ADDED' || t.status === 'MODIFIED')
      ) {
        return true;
      }
      return (t.triggerDiffs ?? []).some((d) => d.status === 'ADDED' || d.status === 'MODIFIED');
    });
  const mysqlRiskAcked = mysqlAckSql !== null && mysqlAckSql === generatedSql;

  // Display priority for the blocked reason + greyed styling, most severe /
  // least self-service first. `null` means nothing is blocking. Some of these
  // states stay clickable on purpose so the click can open the resolution
  // dialog — see the narrower `disabled` list on the button itself.
  // Committed, and the plan unchanged since: Execute runs it from that commit.
  const planIsCommitted = !!committedMigration && commitMatchesPlan();

  const executeBlockReason: string | null =
    !canMigrate ? 'Your role cannot execute migrations'
    : includedCount === 0 ? 'No objects selected for deployment'
    : !targetConnected ? 'Target connection is not healthy — reconnect before deploying'
    : hasMissingFkTargets ? `${missingFkIssues.length} foreign key(s) reference a table that won't exist in the target — resolve the conflicts below`
    : hasUnresolvedDropDeps ? `${liveDropDeps.length} dependent object(s) would break — resolve the conflicts below`
    : hasNarrowingChanges && !narrowingAcked ? 'Acknowledge the narrowing type changes below before deploying'
    : hasDestructiveDrops && !destructiveDropsAcked ? 'Acknowledge the destructive drops below before deploying'
    : deploysRoutineToMySql && !mysqlRiskAcked ? 'Acknowledge the MySQL binlog privilege risk below before deploying'
    : gitSettingsPending ? 'Checking whether migrations must be committed to Git first'
    : commitRequired && !planIsCommitted ? 'This install runs only committed migrations — commit the plan to Git first'
    : null;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-900 h-full">
      {/* Detail Panel Toolbar */}
      <div className="flex justify-between items-center px-6 py-3 border-b border-slate-800 bg-slate-950/40">
        <DetailTabs
          active={activeTab}
          onSelect={setActiveTab}
          // DDL Diff and Migration SQL are comparison-only — hidden when browsing
          // one schema, where there is no other side to compare against.
          tabs={browseMode ? ['DIFF'] : ['DIFF', 'DDL_DIFF', 'SQL']}
        />

        {/* Action Panel Actions */}
        <div className="flex items-center gap-2">
          {activeTab === 'SQL' && generatedSql && (
            <button
              onClick={handleCopySql}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-350 hover:text-slate-150 border border-slate-800 rounded bg-slate-950/40 hover:bg-slate-900 transition"
            >
              <Copy className="w-3.5 h-3.5" /> {copied ? 'Copied!' : 'Copy SQL'}
            </button>
          )}

          {!browseMode && canUseGit && gitRepos.length > 0 && (
            <button
              type="button"
              data-testid="git-commit-btn"
              onClick={() => setShowCommit(true)}
              disabled={includedCount === 0 || isComparing || isMigrating || migrationExecuted}
              title={planIsCommitted ? `Committed as ${committedMigration!.commit.slice(0, 7)} on ${committedMigration!.branch}` : 'Review and commit this migration to Git'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500 disabled:opacity-40"
            >
              <GitCommitHorizontal className="w-3.5 h-3.5" />
              {planIsCommitted ? 'Committed' : 'Commit to Git'}
            </button>
          )}
          <CommitMigrationDialog open={showCommit} onClose={() => setShowCommit(false)} />

          {!browseMode && (
          <button
            data-testid="execute-btn"
            onClick={handleExecuteClick}
            disabled={
              !canMigrate ||
              isComparing || isMigrating || migrationExecuted || includedCount === 0 ||
              !targetConnected || hasUnresolvedDropDeps ||
              (hasDestructiveDrops && !destructiveDropsAcked) ||
              (deploysRoutineToMySql && !mysqlRiskAcked) ||
              gitSettingsPending || (commitRequired && !planIsCommitted)
            }
            title={executeBlockReason ?? `Deploy ${includedCount} object(s) to target`}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-bold transition shadow ${
              migrationExecuted
                ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-500/25 cursor-default'
                : executeBlockReason
                ? 'bg-slate-800 text-slate-500 border border-slate-700/50 cursor-not-allowed'
                : 'accent-grad on-accent-fg cursor-pointer shadow-emerald-500/5'
            }`}
          >
            {isMigrating ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Migrating...
              </>
            ) : migrationExecuted ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" /> Migration Implemented
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                {planIsCommitted
                  ? `Execute committed ${committedMigration!.commit.slice(0, 7)} (${includedCount})`
                  : `Execute Sync Script (${includedCount})`}
              </>
            )}
          </button>
          )}

          <DependencyWarningDialog
            deps={showDepsDialog ? liveDropDeps : []}
            syncSelection={syncSelection}
            toggleSyncSelection={toggleSyncSelection}
            onCancel={() => setShowDepsDialog(false)}
          />

          <ValidationWarningsDialog
            title="Foreign keys reference a missing table"
            description="These foreign keys point at a table that won't exist in the target once this migration runs. Include the referenced table in the deploy, or deselect the foreign key change."
            issues={showFkDialog ? missingFkIssues : []}
            onCancel={() => setShowFkDialog(false)}
          />

          <ValidationWarningsDialog
            title="Narrowing column type changes"
            description="These columns are changing to a type that can hold less data than before — existing values may be truncated or rejected."
            issues={showNarrowingDialog ? narrowingIssues : []}
            onCancel={() => setShowNarrowingDialog(false)}
          />

          <ValidationWarningsDialog
            title="Manual review notes"
            description="The generator flagged these — usually a cross-dialect type mapping with no exact equivalent, or a procedural body it couldn't auto-translate. The migration is still runnable; review these before deploying."
            issues={showReviewDialog ? reviewIssues : []}
            onCancel={() => setShowReviewDialog(false)}
          />

          <CrossDialectReadinessDialog
            open={showReadinessDialog}
            sourceDialect={sourceConfig.dialect}
            targetDialect={targetConfig.dialect}
            onClose={() => setShowReadinessDialog(false)}
          />

          <DeployConfirmDialog
            open={showConfirm}
            dialect={targetConfig.dialect}
            count={includedCount}
            dontAskAgain={dontAskAgain}
            onToggleDontAsk={setDontAskAgain}
            onCancel={() => setShowConfirm(false)}
            onConfirm={confirmExecute}
          />
        </div>
      </div>

      {/* Safety gate banner — anything that currently blocks Execute, with the
          action needed to clear it. Visible on every tab, not just Migration SQL,
          since Execute lives in the toolbar above regardless of active tab. */}
      {!browseMode && (!targetConnected || hasMissingFkTargets || hasUnresolvedDropDeps || hasNarrowingChanges || (hasDestructiveDrops && !destructiveDropsAcked) || (deploysRoutineToMySql && !mysqlRiskAcked) || reviewIssues.length > 0) && (
        <div className="border-b border-slate-800 bg-slate-950/60 divide-y divide-slate-800/60">
          {!targetConnected && (
            <div className="flex items-center gap-2.5 px-4 py-2 text-[11px] text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
              Target connection is not healthy — reconnect the target before deploying.
            </div>
          )}
          {hasMissingFkTargets && (
            <div className="flex items-center justify-between gap-2.5 px-4 py-2 text-[11px] text-rose-200">
              <span className="flex items-center gap-2.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                {missingFkIssues.length} foreign key{missingFkIssues.length === 1 ? '' : 's'} would reference a table missing from the target.
              </span>
              <button
                onClick={() => setShowFkDialog(true)}
                className="shrink-0 text-[10px] font-semibold rounded px-2 py-1 text-rose-200 bg-rose-950/50 border border-rose-500/40 hover:bg-rose-900/50 transition"
              >
                Review conflicts
              </button>
            </div>
          )}
          {hasUnresolvedDropDeps && (
            <div className="flex items-center justify-between gap-2.5 px-4 py-2 text-[11px] text-amber-200">
              <span className="flex items-center gap-2.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                {liveDropDeps.length} dependent object{liveDropDeps.length === 1 ? '' : 's'} would break from a drop in this deploy.
              </span>
              <button
                onClick={() => setShowDepsDialog(true)}
                className="shrink-0 text-[10px] font-semibold rounded px-2 py-1 text-amber-200 bg-amber-950/50 border border-amber-500/40 hover:bg-amber-900/50 transition"
              >
                Review conflicts
              </button>
            </div>
          )}
          {hasNarrowingChanges && (
            <label className="flex items-center gap-2.5 px-4 py-2 text-[11px] text-amber-200 cursor-pointer">
              <input
                data-testid="ack-narrowing-types"
                type="checkbox"
                checked={narrowingAcked}
                onChange={(e) => setNarrowingAckSql(e.target.checked ? generatedSql : null)}
                className="w-3 h-3 accent-amber-500 cursor-pointer shrink-0"
              />
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
              {narrowingIssues.length} column type change{narrowingIssues.length === 1 ? '' : 's'} may truncate or reject existing data —{' '}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setShowNarrowingDialog(true);
                }}
                className="underline hover:text-amber-100"
              >
                view details
              </button>
              . I understand and want to proceed.
            </label>
          )}
          {reviewIssues.length > 0 && (
            <div className="flex items-center justify-between gap-2.5 px-4 py-2 text-[11px] text-slate-400">
              <span className="flex items-center gap-2.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                {reviewIssues.length} note{reviewIssues.length === 1 ? '' : 's'} in the generated SQL need manual review.
              </span>
              <button
                onClick={() => setShowReviewDialog(true)}
                className="shrink-0 text-[10px] font-semibold rounded px-2 py-1 text-slate-300 bg-slate-800/50 border border-slate-700/40 hover:bg-slate-800 transition"
              >
                View notes
              </button>
            </div>
          )}
          {hasDestructiveDrops && (
            <label className="flex items-center gap-2.5 px-4 py-2 text-[11px] text-amber-200 cursor-pointer">
              <input
                data-testid="ack-destructive-drops"
                type="checkbox"
                checked={destructiveDropsAcked}
                onChange={(e) => setDestructiveAckSql(e.target.checked ? generatedSql : null)}
                className="w-3 h-3 accent-amber-500 cursor-pointer shrink-0"
              />
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
              This migration drops table(s), column(s), or index(es) that cannot be recovered — I understand and want to proceed.
            </label>
          )}
          {deploysRoutineToMySql && (
            <label className="flex items-center gap-2.5 px-4 py-2 text-[11px] text-amber-200 cursor-pointer">
              <input
                data-testid="ack-mysql-binlog-risk"
                type="checkbox"
                checked={mysqlRiskAcked}
                onChange={(e) => setMysqlAckSql(e.target.checked ? generatedSql : null)}
                className="w-3 h-3 accent-amber-500 cursor-pointer shrink-0"
              />
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
              This deploy creates/updates a MySQL function, procedure, or trigger — the connecting user needs SUPER or{' '}
              <code className="text-amber-100">log_bin_trust_function_creators = 1</code> or it will fail. I've confirmed this.
            </label>
          )}
        </div>
      )}

      {/* Main Panel Content Panel */}
      <div className="flex-1 flex flex-col min-h-0">
        {browseMode || activeTab === 'DIFF' ? (
          renderSchemaObjectDiff()
        ) : activeTab === 'DDL_DIFF' ? (
          renderDdlDiff()
        ) : (
          <div className="flex-1 flex flex-col min-h-0 bg-slate-950/90 border-t border-slate-850">
            {deploysRoutineToMySql && (
              <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-950/40 border-b border-amber-500/30 text-[11px] text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                <div className="leading-relaxed">
                  <span className="font-bold text-amber-300">MySQL routine/trigger deploy:</span> with binary
                  logging enabled, <code className="text-amber-100">CREATE FUNCTION/PROCEDURE/TRIGGER</code>{' '}
                  requires the <code className="text-amber-100">SUPER</code> privilege (error 1419). If the
                  connecting user lacks it, have a DBA run{' '}
                  <code className="text-amber-100">SET GLOBAL log_bin_trust_function_creators = 1;</code> once
                  (or set it in <code className="text-amber-100">my.cnf</code>) before deploying — or use{' '}
                  <span className="font-semibold text-amber-100">Skip &amp; retry</span> in the progress panel
                  to deploy everything else.
                </div>
              </div>
            )}
            <div className="flex-1 min-h-0 relative">
              <div className="absolute inset-0">
                <Suspense fallback={<EditorFallback />}>
                  <SqlEditor
                    dialect={targetConfig.dialect}
                    value={formattedSql || '-- No migration script generated.'}
                    highlight={searchTerm}
                  />
                </Suspense>
              </div>
            </div>
          </div>
        )}
      </div>

      <MigrationProgressPanel />
    </div>
  );
};
