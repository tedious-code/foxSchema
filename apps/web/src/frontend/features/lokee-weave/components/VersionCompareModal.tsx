/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * "What did this version change?" — a Compare-Schema-shaped diff between a
 * version and the one before it.
 *
 * Served entirely from the object store, so it opens on a database that is
 * offline, moved, or decommissioned. That is the difference from Compare
 * Schema proper, which needs two reachable databases.
 *
 * Grouped by container and collapsed by default: a migration that touches
 * forty columns across three tables is three rows to scan, not forty.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, Play, X } from 'lucide-react';
import type { TableDiff } from '@foxschema/ui-shared';
import {
  compareLokeeVersions,
  executeLokeeRevert,
  planLokeeRevert,
  LokeeRevertError,
  type LokeeRevertPlan,
  type VersionCompare,
} from '../api/lokeeApi';
import { getSessionPassword } from '@/shared/lib/sessionPasswords';
import { toast } from '@/app/store/toastStore';
import { riskStyle } from '@/features/lokee-weave/lib/lokeeColors';
import { SchemaBlueprint } from '@/features/schema-diff';
import { buildMigrationReport, migrationReportFilename } from '@/features/lokee-weave/lib/migrationReport';
import { SchemaDiffTree, orderTablesForDisplay } from '@/features/schema-diff';
import { DetailTabs, type DetailTab } from '@/features/schema-diff';
import { DiffBriefingChips } from '@/features/schema-diff';
import { diffBriefing } from '@/features/schema-diff';
import { buildTableDdlDiffLines, DdlDiffLines } from '@/features/schema-diff';
import { GithubScriptDiff } from './GithubScriptDiff';
import { versionDisplayName } from './graphTypes';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

/**
 * The pane ids are Compare Schema's own — see `DetailTabs`. History used to
 * name them differently, which is how one flow came to look like two.
 */
export type ComparePaneTab = DetailTab;

export interface VersionCompareModalProps {
  databaseId: string;
  /** Connection used to run a revert. Without it, Execute is read-only. */
  captureConnectionId?: string;
  /** Called after a successful revert so the caller can reload the graph. */
  onReverted?: () => void;
  /** The reference side — "Original server" in the bar. */
  versionId: string;
  /**
   * The side that would change — "Target" in the bar. Omit to use the
   * reference's own parent, which is the "what did this version do?" reading.
   */
  againstVersionId?: string;
  /**
   * Newest captured version. A revert always moves the *live* database, so it
   * is only coherent when the Target side is that newest version — otherwise
   * the diff on screen and the DDL that would run describe different pairs.
   */
  latestVersionId?: string;
  /** Put the Target side back on "Current database", so a revert is possible. */
  onRetargetToLatest?: () => void;
  onClose: () => void;
  /**
   * Dock in the Snapshots workspace (same tree as Sync) instead of a modal.
   * Graph still uses the overlay internally.
   */
  embedded?: boolean;
}


/**
 * Header for the selected object. The tables underneath are `SchemaBlueprint`,
 * the very component Compare Schema renders — history showed a thinner,
 * hand-written list before, which is how the two views drifted apart.
 */
function ObjectDetail({ diff }: { diff: TableDiff }): React.ReactElement {
  return (
    <div data-testid="lokee-cmp-detail" className="flex h-full flex-col">
      <div className="border-b border-slate-800 px-2 py-1.5">
        <div className="truncate text-[12px] font-semibold text-slate-100">{diff.tableName}</div>
        <div className="text-[10px] text-slate-500">
          {diff.objectType} · {diff.status}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <SchemaBlueprint diff={diff} density="compact" />
      </div>
    </div>
  );
}

export function VersionCompareModal({
  databaseId,
  captureConnectionId,
  onReverted,
  versionId,
  againstVersionId,
  latestVersionId,
  onRetargetToLatest,
  onClose,
  embedded = false,
}: VersionCompareModalProps): React.ReactElement {
  const [tab, setTab] = useState<ComparePaneTab>('DIFF');
  const [planned, setPlanned] = useState<{
    identity: string;
    value: LokeeRevertPlan;
  } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirmLossy, setConfirmLossy] = useState(false);
  const [running, setRunning] = useState(false);
  const [data, setData] = useState<VersionCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Which objects the user has ticked to revert. Empty means "none selected",
  // which the backend deliberately treats as a no-op rather than "everything".
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const comparisonIdentity = JSON.stringify([databaseId, versionId, againstVersionId]);
  const [renderedComparisonIdentity, setRenderedComparisonIdentity] =
    useState(comparisonIdentity);

  // Prop changes must invalidate executable state before this render can expose
  // controls for the new comparison. Effects run too late: a stale approved
  // plan would otherwise remain clickable until the replacement plan settles.
  if (renderedComparisonIdentity !== comparisonIdentity) {
    setRenderedComparisonIdentity(comparisonIdentity);
    setPlanned(null);
    setPlanning(false);
    setPlanError(null);
    setConfirmLossy(false);
    setSelection({});
    setSelectedName(null);
    setData(null);
    setError(null);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    void compareLokeeVersions(databaseId, versionId, againstVersionId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to compare versions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId, versionId, againstVersionId]);

  // Escape closes, which is what every other dialog in the app does.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    },
    [onClose]
  );

  const toggleSelection = useCallback((name: string) => {
    setSelection((s) => ({ ...s, [name]: !s[name] }));
  }, []);

  // Unchanged objects are the overwhelming majority of any real schema and are
  // not what the reader opened this for.
  const changed = useMemo(
    () => (data?.compare.tables ?? []).filter((t) => t.status !== 'UNCHANGED'),
    [data]
  );

  // Default the detail pane to the first changed object rather than showing an
  // empty pane next to a populated tree.
  const selectedDiff = useMemo(() => {
    const named = changed.find((t) => t.tableName === selectedName);
    if (named) return named;
    // Display order, not array order — the tree groups by type, so `changed[0]`
    // is usually not the row sitting at the top of the list.
    return orderTablesForDisplay(changed)[0] ?? null;
  }, [changed, selectedName]);

  // Object keys for the ticked rows. The tree ticks by table name, so map them
  // back to container keys the backend understands.
  const selectedKeys = useMemo(() => {
    const names = Object.entries(selection)
      .filter(([, on]) => on)
      .map(([name]) => name);
    return names.map((n) => {
      const t = changed.find((x) => x.tableName === n);
      const kind = (t?.objectType ?? 'TABLE').toLowerCase();
      return `${kind}:${n.toUpperCase()}`;
    });
  }, [selection, changed]);

  const planIdentity = JSON.stringify([comparisonIdentity, selectedKeys]);
  const plan = planned?.identity === planIdentity ? planned.value : null;

  // "Make Target match Original" is exactly a revert of Target to Original.
  // Planned whenever the dialog has data — the run button lives in the toolbar
  // now, so it must know the statement count on every tab.
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    setPlanning(true);
    setPlanError(null);
    setPlanned(null);
    void (async () => {
      try {
        const value = await planLokeeRevert(
          databaseId,
          versionId,
          selectedKeys.length > 0 ? selectedKeys : undefined
        );
        if (!cancelled) setPlanned({ identity: planIdentity, value });
      } catch (err) {
        if (!cancelled) setPlanError(err instanceof Error ? err.message : 'Failed to plan');
      } finally {
        if (!cancelled) setPlanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, databaseId, versionId, selectedKeys, planIdentity]);

  /**
   * Why Execute cannot run yet — the empty string means it can.
   *
   * The button lives in the toolbar and the data-loss acknowledgement lives on
   * the Migration SQL tab, so a reader on the Blueprint tab saw a greyed-out
   * button with no stated reason. Comparing before deciding is the whole point
   * of this dialog; the decision has to be reachable from wherever you are.
   */
  const blocked = useMemo((): { code: string; label: string; why: string } | null => {
    if (!captureConnectionId) {
      return {
        code: 'credential',
        label: 'No credential',
        why: 'Choose a credential in the bar above to run this.',
      };
    }
    if (!plan) {
      // A plan for a different selection is being replaced. Between the render
      // that changes the selection and the effect that starts planning,
      // `planning` still reads false, so this said "No plan" for a frame after
      // every tick — and a reader (or a test) looking then saw a dead end.
      const waiting = planning || (!!data && !planError);
      return {
        code: 'planning',
        label: waiting ? 'Planning…' : 'No plan',
        why: waiting ? 'Still planning…' : 'No plan yet.',
      };
    }
    /**
     * A revert restores the Original version onto the *live* database. The diff
     * above, though, is Original vs whatever Target says — so with an older
     * version on Target the reader reviews one script and Execute applies a
     * different, usually larger one. Refuse rather than reconcile: the rule is
     * that a revert only ever runs against the newest version.
     */
    if (latestVersionId && againstVersionId && againstVersionId !== latestVersionId) {
      return {
        code: 'target-not-latest',
        label: 'Target must be current',
        why: 'A revert restores the live database, so Target has to be “Current database”. The diff shown here compares two older versions and is not what would run.',
      };
    }
    // Revert always moves the *live* database to whatever sits on the Original
    // side; the Target picker only chooses what the diff above is showing. So
    // putting the newest version on Original asks to revert to where you
    // already are, and the plan is empty. "(0)" did not say that.
    if (plan.alreadyAtTarget) {
      return {
        code: 'already',
        label: 'Already at Original',
        why: 'Original is the current head — put the version you want to restore on the Original side.',
      };
    }
    if (plan.statements.length === 0) {
      return { code: 'empty', label: 'Nothing to apply', why: 'The plan is empty.' };
    }
    // An empty tick set used to send `undefined`, which the backend reads as
    // "the whole schema" — so pressing Execute with nothing selected reverted
    // the entire database. Selecting nothing must mean nothing.
    if (changed.length > 0 && selectedKeys.length === 0) {
      return {
        code: 'nothing-ticked',
        label: 'Tick objects to revert',
        why: 'Tick the objects to revert in the tree, or use Select all.',
      };
    }
    if (plan.reversal.risk === 'blocked') {
      return {
        code: 'blocked',
        label: 'Blocked',
        why: 'This cannot be applied without losing data the schema cannot restore.',
      };
    }
    if (plan.reversal.risk === 'lossy' && !confirmLossy) {
      return {
        code: 'lossy',
        label: 'Review data loss…',
        why: 'This revert destroys data — review it on Migration SQL and confirm there.',
      };
    }
    return null;
    // selectedKeys and changed belong here: without them, ticking an object
    // left this memo stale and the button kept saying "Tick objects to revert"
    // after the user had ticked one.
  }, [
    captureConnectionId,
    plan,
    planning,
    planError,
    data,
    confirmLossy,
    selectedKeys,
    changed,
    latestVersionId,
    againstVersionId,
  ]);
  const needsLossyAck = blocked?.code === 'lossy';

  /**
   * "Execute migration (3)" says how many statements and nothing about where
   * they take you — and it reads as an undo even when the plan only adds.
   *
   * Direction cannot come from the version numbers: the plan always runs from
   * the head, so the target is always the lower number. What separates the two
   * cases is what the plan *does*. A plan that destroys nothing is bringing a
   * database up to a schema it is missing — catching up, not rolling back —
   * and that is the common shape when a database has fallen behind.
   */
  const catchingUp = plan?.reversal.risk === 'safe';
  const runLabel = plan
    ? `${catchingUp ? 'Update' : 'Revert'} to v${plan.toVersion.number} (${plan.statements.length})`
    : 'Execute migration';

  const runRevert = useCallback(async () => {
    if (!captureConnectionId || !plan) return;
    setRunning(true);
    try {
      await executeLokeeRevert(databaseId, {
        toVersionId: versionId,
        connectionId: captureConnectionId,
        password: getSessionPassword(captureConnectionId),
        confirmLossy,
        // Always explicit: the guard above refuses to run with an empty tick
        // set, so this never silently widens to the whole schema.
        objectKeys: selectedKeys,
      });
      toast({
        tone: 'success',
        title: 'Revert applied',
        body: 'The schema was reverted and recorded as a new version.',
      });
      onReverted?.();
      onClose();
    } catch (err) {
      const message =
        err instanceof LokeeRevertError ? err.message : err instanceof Error ? err.message : 'Revert failed';
      // Drift is not a failure the user caused: the schema moved under the
      // plan, the snapshot caught it, and nothing was applied. Reload so the
      // new version is on screen before they decide again.
      if (err instanceof LokeeRevertError && err.code === 'schema_drifted') {
        toast({ tone: 'warning', title: 'Schema changed — nothing applied', body: message });
        onReverted?.();
        onClose();
        return;
      }
      toast({ tone: 'warning', title: 'Revert failed', body: message });
    } finally {
      setRunning(false);
    }
  }, [
    captureConnectionId,
    plan,
    databaseId,
    versionId,
    confirmLossy,
    selectedKeys,
    onReverted,
    onClose,
  ]);

  // The workspace's builder, fed by a stored version instead of a connection.
  // Both sides are the same dialect here — this is one database over time.
  const ddlLines = useMemo(() => {
    if (!selectedDiff || selectedDiff.objectType !== 'TABLE') return [];
    const dialect = data?.dialect ?? '';
    return buildTableDdlDiffLines(selectedDiff, dialect, dialect, (ddl) => ddl);
  }, [selectedDiff, data]);

  /**
   * Download the change report. A separate artefact from the Migration SQL tab
   * on purpose: this one is for the reviewer or the ticket, so it carries no
   * DDL at all.
   */
  const exportReport = useCallback(() => {
    if (!data) return;
    const meta = {
      originalLabel: versionDisplayName({ number: data.to.number, name: data.to.name }),
      targetLabel: data.from
        ? versionDisplayName({ number: data.from.number, name: data.from.name })
        : 'first capture',
      generatedAt: new Date(),
    };
    const blob = new Blob([buildMigrationReport(data.compare, meta)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = migrationReportFilename(meta);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const heading = useMemo(() => {
    if (!data) return 'Compare versions';
    const reference = versionDisplayName({ number: data.to.number, name: data.to.name });
    if (!data.from) return `${reference} · first capture`;
    const other = versionDisplayName({ number: data.from.number, name: data.from.name });
    // Two entry points ask different questions, so the heading has to say which.
    //
    //   version node click → "what did this version do?"  → parent → version
    //   the Original/Target bar → "what would make Target match Original?"
    //
    // Naming the roles rather than relying on the arrow alone keeps the heading
    // from contradicting the bar, which it did when both used a bare arrow.
    return againstVersionId
      ? `Original ${reference} → Target ${other}`
      : `${other} → ${reference}`;
  }, [data, againstVersionId]);

  return (
    <div
      className={
        embedded
          ? 'flex h-full min-h-0 w-[min(56%,720px)] shrink-0 flex-col border-l border-slate-800 bg-slate-950'
          : 'fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-6'
      }
      role="dialog"
      aria-modal={!embedded}
      aria-label="Compare versions"
      data-testid="lokee-version-compare"
      data-embedded={embedded ? 'true' : 'false'}
      data-state={loading ? 'loading' : error ? 'error' : data ? 'ready' : 'empty'}
      onKeyDown={onKeyDown}
    >
      <div
        className={
          embedded
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
            : 'flex max-h-full w-[1200px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-950 shadow-xl'
        }
      >
        <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Schema compare
            </div>
            <div className="truncate text-sm font-semibold text-slate-100">{heading}</div>
          </div>
          <button
            type="button"
            data-testid="lokee-cmp-export-report"
            onClick={exportReport}
            disabled={!data}
            title="Download a Markdown summary of these changes (no SQL)"
            className="mr-1 inline-flex shrink-0 items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
          >
            <Download className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
            Report
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="lokee-version-compare-close"
            aria-label="Close compare"
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-4 w-4" strokeWidth={SQL_ICON_STROKE} />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-3">
          {loading && (
            <div className="flex items-center gap-2 text-[12px] text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
              Comparing versions…
            </div>
          )}
          {error && <p className="text-[12px] text-rose-300">{error}</p>}

          {data && !loading && (
            <>
              <div
                data-testid="lokee-cmp-summary"
                className="mb-2 flex flex-wrap items-center gap-2 text-[11px]"
              >
                <DiffBriefingChips
                  briefing={diffBriefing(data.compare.tables)}
                  testId="lokee-cmp-briefing"
                  showUnchanged
                />
                {/* Revert reads the Original side and moves the live database to
                    it; the Target picker only frames the diff. Saying so where
                    the sides are chosen beats a disabled button and a tooltip. */}
                {blocked?.code === 'already' && (
                  <span
                    data-testid="lokee-cmp-already-hint"
                    className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200"
                  >
                    Nothing to revert — Original is the current head. Put the version you want to
                    restore on the Original side.
                  </span>
                )}
              </div>

              {changed.length === 0 ? (
                <p data-testid="lokee-cmp-identical" className="text-[12px] text-slate-400">
                  {data.from
                    ? 'Nothing changed between these versions — every object hashes the same.'
                    : 'This is the first capture, so there is no earlier version to compare against.'}
                </p>
              ) : (
                // The same tree the live Compare workspace renders. Selection is
                // the revert picker here and the deploy picker there — one
                // gesture, one component.
                <div className="flex gap-2" style={{ minHeight: 380 }}>
                  <div className="w-[300px] shrink-0 overflow-auto pr-1">
                    <div className="mb-1 flex items-center gap-2 px-1 text-[10px] text-slate-400">
                      <button
                        type="button"
                        data-testid="lokee-cmp-select-all"
                        onClick={() =>
                          setSelection(
                            Object.fromEntries(changed.map((t) => [t.tableName, true]))
                          )
                        }
                        className="rounded border border-slate-700 px-1.5 py-0.5 font-semibold hover:bg-slate-800 hover:text-slate-200"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        data-testid="lokee-cmp-select-none"
                        onClick={() => setSelection({})}
                        className="rounded border border-slate-700 px-1.5 py-0.5 font-semibold hover:bg-slate-800 hover:text-slate-200"
                      >
                        Clear
                      </button>
                      <span className="ml-auto">
                        {selectedKeys.length} of {changed.length} ticked
                      </span>
                    </div>
                    <SchemaDiffTree
                      tables={changed}
                      selectedName={selectedDiff?.tableName ?? null}
                      onSelect={(t) => setSelectedName(t.tableName)}
                      selection={selection}
                      onToggleSelection={toggleSelection}
                      selectionTitle="Include this object when reverting to the earlier version"
                      emptyMessage="No changed objects in this version."
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-slate-800">
                    {/* The workspace's own toolbar: the same three tabs, and
                        the run button top-right. Compare Schema calls it
                        "Execute Sync Script"; here the script is a revert. */}
                    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-800 p-1">
                      <DetailTabs
                        active={tab}
                        onSelect={setTab}
                        testIdPrefix="lokee-cmp"
                        size="compact"
                        labels={{ SQL: 'Revert SQL' }}
                      />
                      <div className="flex shrink-0 items-center gap-2">
                        {/* A dead Execute button with the reason hidden in a
                            tooltip is a dead end; when the fix is one click,
                            offer the click. */}
                        {blocked?.code === 'target-not-latest' && onRetargetToLatest && (
                          <button
                            type="button"
                            data-testid="lokee-cmp-use-current-target"
                            onClick={onRetargetToLatest}
                            title="Put Target back on the current database so this revert can run"
                            className="shrink-0 rounded border border-cyan-500/50 bg-cyan-950/30 px-2 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-900/40"
                          >
                            Use current database
                          </button>
                        )}
                        {/* Risk travels with the button, not just with the tab
                            that happens to show the statements. */}
                        {plan && plan.statements.length > 0 && (
                          <span
                            data-testid="lokee-cmp-risk-chip"
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              riskStyle(plan.reversal.risk).badge
                            }`}
                          >
                            {riskStyle(plan.reversal.risk).label}
                            {plan.reversal.lossyCount > 0 ? ` · ${plan.reversal.lossyCount}` : ''}
                          </span>
                        )}
                        <button
                          type="button"
                          data-testid="lokee-cmp-run-revert"
                          title={
                            blocked?.why ??
                            (catchingUp
                              ? `Bring this database up to v${plan?.toVersion.number} — this plan destroys nothing. Records a new version.`
                              : `Apply ${plan?.statements.length ?? 0} statement(s) to go back to v${plan?.toVersion.number}. Records a new version.`)
                          }
                          // A lossy plan keeps the button live so it can carry the
                          // reader to the acknowledgement; every other blocker is a
                          // genuine dead end and stays disabled.
                          disabled={running || (Boolean(blocked) && !needsLossyAck)}
                          onClick={() => {
                            if (needsLossyAck) {
                              setTab('SQL');
                              return;
                            }
                            void runRevert();
                          }}
                          className="flex shrink-0 items-center gap-1.5 rounded border border-amber-500/50 bg-amber-950/40 px-2.5 py-1 text-[11px] font-bold text-amber-100 transition hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Play className="h-3 w-3 fill-current" strokeWidth={SQL_ICON_STROKE} />
                          {running ? 'Applying…' : (blocked?.label ?? runLabel)}
                        </button>
                      </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-auto">
                      {tab === 'DIFF' &&
                        (selectedDiff ? (
                          <ObjectDetail diff={selectedDiff} />
                        ) : (
                          <p className="p-3 text-[11px] text-slate-500">
                            Select an object to see what changed inside it.
                          </p>
                        ))}

                      {/* Not a second DDL renderer: `buildTableDdlDiffLines` is
                          the workspace's, and a stored version supplies the same
                          TableDiff a live connection does. Non-tables are
                          replaced wholesale, so they read as a script diff. */}
                      {tab === 'DDL_DIFF' && (
                        <div data-testid="lokee-cmp-ddl-diff" className="p-1">
                          {!selectedDiff ? (
                            <p className="p-2 text-[11px] text-slate-500">
                              Select an object to see its DDL.
                            </p>
                          ) : selectedDiff.objectType === 'TABLE' ? (
                            <DdlDiffLines lines={ddlLines} />
                          ) : (
                            <GithubScriptDiff
                              original={selectedDiff.targetTable?.definition ?? ''}
                              modified={selectedDiff.sourceTable?.definition ?? ''}
                            />
                          )}
                        </div>
                      )}

                      {tab === 'SQL' && (
                        <div data-testid="lokee-cmp-ddl" className="flex flex-col gap-2 p-2">
                          {planning && <p className="text-[11px] text-slate-400">Planning…</p>}
                          {planError && <p className="text-[11px] text-rose-300">{planError}</p>}
                          {plan && (
                            <>
                              <div
                                className={`inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                  riskStyle(plan.reversal.risk).badge
                                }`}
                              >
                                {riskStyle(plan.reversal.risk).label}
                                {plan.reversal.lossyCount > 0
                                  ? ` · ${plan.reversal.lossyCount} lossy`
                                  : ''}
                                {plan.reversal.blockedCount > 0
                                  ? ` · ${plan.reversal.blockedCount} blocked`
                                  : ''}
                              </div>
                              <p className="text-[11px] text-slate-300">
                                Applies {plan.statements.length}{' '}
                                {plan.statements.length === 1 ? 'statement' : 'statements'} so the
                                live schema matches{' '}
                                {versionDisplayName({
                                  number: plan.toVersion.number,
                                  name: plan.toVersion.name,
                                })}
                                , then records the result as a new version.
                              </p>
                              {selectedKeys.length > 0 && (
                                <p className="text-[10px] text-cyan-300">
                                  Scoped to {selectedKeys.length} selected{' '}
                                  {selectedKeys.length === 1 ? 'object' : 'objects'}.
                                </p>
                              )}
                              {plan.reversal.risk === 'lossy' && (
                                <label className="flex items-start gap-1.5 text-[11px] text-amber-200">
                                  <input
                                    type="checkbox"
                                    data-testid="lokee-cmp-confirm-lossy"
                                    checked={confirmLossy}
                                    onChange={(e) => setConfirmLossy(e.target.checked)}
                                    className="mt-0.5 h-3 w-3 accent-amber-500"
                                  />
                                  I understand data will be lost permanently.
                                </label>
                              )}
                              {plan.reversal.risk === 'blocked' && (
                                <p className="text-[11px] text-rose-300">
                                  Blocked — this cannot be applied without losing data the schema
                                  cannot restore.
                                </p>
                              )}
                              {!captureConnectionId && (
                                <p className="text-[11px] text-slate-500">
                                  Choose a credential in the bar above to run this.
                                </p>
                              )}
                              {plan.statements.length === 0 && !planning ? (
                                <p className="text-[11px] text-slate-500">
                                  Nothing to apply — Target already matches Original
                                  {selectedKeys.length > 0 ? ' for the selected objects' : ''}.
                                </p>
                              ) : (
                                <pre className="whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-300">
                                  {/* Statements may already be terminated; joining
                                      with ';' unconditionally produced `…;;`. */}
                                  {plan.statements
                                    .map((st) => (st.trimEnd().endsWith(';') ? st : `${st};`))
                                    .join('\n\n')}
                                </pre>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
