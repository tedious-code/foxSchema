/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — the container that fetches history and hands it to the graph.
 *
 * `LokeeWeavePage` stays a pure function of its DTO. Everything that can fail,
 * load, or be empty is handled here, so the graph itself remains trivially
 * testable with a fixture and has no idea a network exists.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, GitBranch, Loader2, RefreshCw, TriangleAlert, Upload } from 'lucide-react';
import { LokeeWeavePage } from './LokeeWeavePage';
import { VersionCompareModal } from './VersionCompareModal';
import { ForceMigrateModal } from './ForceMigrateModal';
import { LokeeObjectInspector } from './LokeeObjectInspector';
import { VersionTimeline } from './VersionTimeline';
import { VersionChangeChart, VersionBriefing } from './VersionChangeChart';
import type { SchemaObjectNodeData, VersionGraphDTO } from './graphTypes';
import {
  captureSchema,
  listLokeeDatabases,
  listLokeeVersions,
  loadVersionGraph,
  updateLokeeVersionMeta,
  type LokeeDatabase,
} from '../api/lokeeApi';
import { getSessionPassword } from '@/shared/lib/sessionPasswords';
import { toast } from '@/app/store/toastStore';
import { useSyncStore } from '@/features/compare';
import { useAuthStore } from '@/app/store/authStore';
import { useUiStore } from '@/app/store/uiStore';
import { useLokeeHistoryStore } from '@/features/lokee-weave/store/lokeeHistoryStore';
import {
  databaseLocation,
  resolveHistoryCompare,
  sortVersionsNewestFirst,
} from '@/features/lokee-weave/lib/historyCompare';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export interface LokeeWeaveViewProps {
  /** When set, that database is shown; otherwise the picker / most recent one is. */
  databaseId?: string;
  /** How many versions to draw. The backend caps this well below the UI cap. */
  versionLimit?: number;
  onSelectObject?: (selected: SchemaObjectNodeData) => void;
  /** Compact chrome when mounted inside Schema Sync rather than as its own workspace. */
  embedded?: boolean;
}

const EMPTY_DTO: VersionGraphDTO = {
  databaseId: '',
  versions: [],
  objects: [],
  totalVersions: 0,
  totalObjects: 0,
  truncatedObjects: false,
};

function describe(database: LokeeDatabase | undefined): string | undefined {
  if (!database) return undefined;
  const where = databaseLocation(database);
  // ` · schema`, not `.schema`: a SQLite path already ends in `.db`, so the
  // dotted form rendered as `/tmp/app.db.main` and read like a file extension.
  const schema = database.schema ? ` · ${database.schema}` : '';
  return `${database.dialect} · ${where}${schema}`;
}

export function LokeeWeaveView({
  databaseId,
  versionLimit = 20,
  onSelectObject,
  embedded = false,
}: LokeeWeaveViewProps): React.ReactElement {
  const connections = useSyncStore((s) => s.connections);
  const selectedTargetConnectionId = useSyncStore((s) => s.selectedTargetConnectionId);
  const targetConfig = useSyncStore((s) => s.targetConfig);
  const lokeeEpoch = useUiStore((s) => s.lokeeEpoch);
  const bumpLokeeEpoch = useUiStore((s) => s.bumpLokeeEpoch);
  const storeDatabaseId = useLokeeHistoryStore((s) => s.databaseId);
  const setStoreDatabaseId = useLokeeHistoryStore((s) => s.setDatabaseId);
  const setStoreDatabases = useLokeeHistoryStore((s) => s.setDatabases);
  const setStoreVersions = useLokeeHistoryStore((s) => s.setVersions);
  const originalVersionId = useLokeeHistoryStore((s) => s.originalVersionId);
  const captureConnectionId = useLokeeHistoryStore((s) => s.captureConnectionId);
  const setCaptureConnectionId = useLokeeHistoryStore((s) => s.setCaptureConnectionId);
  const capturing = useLokeeHistoryStore((s) => s.capturing);
  const setCapturing = useLokeeHistoryStore((s) => s.setCapturing);
  const captureRequest = useLokeeHistoryStore((s) => s.captureRequest);
  const refreshRequest = useLokeeHistoryStore((s) => s.refreshRequest);
  const targetVersionId = useLokeeHistoryStore((s) => s.targetVersionId);
  const setTargetVersionId = useLokeeHistoryStore((s) => s.setTargetVersionId);
  const [databases, setDatabases] = useState<LokeeDatabase[]>([]);
  /**
   * Whether the database list has answered at least once, success or failure.
   *
   * Until it has, "no active database" means "not known yet", not "none". The
   * view used to treat the two alike: on open it rendered the "No schema history
   * yet" empty state, then a spinner the moment the list arrived and picked a
   * database, then the empty state again once that database's versions came
   * back empty — a flash of the wrong answer on every first open, and the cause
   * of an intermittent test failure that asserted during the flash.
   */
  const [databasesLoaded, setDatabasesLoaded] = useState(false);
  /**
   * The database whose versions are currently in `dto` (or whose load failed).
   *
   * `loading` is set by an effect, so it is updated *after* the render in which
   * `activeId` changes — for one commit it still describes the previous
   * database. When the list arrived and picked a database, that one commit
   * rendered "No schema history yet" for a database whose versions had not been
   * requested. Comparing against this instead is correct on the same render.
   */
  const [versionsFor, setVersionsFor] = useState<string | null>(null);

  const [dto, setDto] = useState<VersionGraphDTO>(EMPTY_DTO);
  /**
   * The graph, kept apart from the timeline in `dto`.
   *
   * Both reload on every refresh and they used to write the same state, so
   * whichever request answered last won. When the timeline list (which carries
   * no objects and no revert provenance) landed after the graph, it replaced
   * the graph: the canvas lost its objects and "reverted to vN" marks until the
   * next refresh.
   */
  const [graphDto, setGraphDto] = useState<VersionGraphDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);
  const [selectedObject, setSelectedObject] = useState<SchemaObjectNodeData | null>(null);
  /** React Flow reconstructs object nodes — off until the reader asks. */
  const [showGraph, setShowGraph] = useState(false);
  /**
   * Force-migrate is withheld from owner by default, so the action is hidden
   * rather than shown-and-refused: an affordance that always 403s teaches the
   * reader nothing about why it is refused.
   */
  const canForceMigrate = useAuthStore((s) => s.can('schema.migrate.force'));
  const [forceMigrateOpen, setForceMigrateOpen] = useState(false);
  // Bumped to re-run the effect; a plain refetch() would race the in-flight one.
  const [reloadToken, setReloadToken] = useState(0);
  // Which pair the pane is showing. The two *sides* live in the history store,
  // because the picker that sets them is HistoryCompareBar up in the toolbar.
  const [comparePair, setComparePair] = useState<{ original: string; target?: string } | null>(
    null
  );
  /** Newest captured version — the only Target a revert can legally run against. */
  const latestVersionId = useMemo(
    () => sortVersionsNewestFirst(dto?.versions ?? [])[0]?.id ?? null,
    [dto?.versions]
  );

  const matchedTargetId = useMemo(() => {
    const host = (targetConfig.option.host ?? '').toLowerCase();
    const database = (targetConfig.option.database ?? '').toLowerCase();
    const schemaName = (targetConfig.schema ?? '').toLowerCase();
    const dialect = targetConfig.dialect.toLowerCase();
    return databases.find(
      (d) =>
        d.dialect.toLowerCase() === dialect &&
        (d.host ?? '').toLowerCase() === host &&
        (d.database ?? '').toLowerCase() === database &&
        (d.schema ?? '').toLowerCase() === schemaName
    )?.id;
  }, [databases, targetConfig]);

  const storedId =
    storeDatabaseId &&
    (databases.length === 0 || databases.some((d) => d.id === storeDatabaseId))
      ? storeDatabaseId
      : undefined;
  // Prop wins; otherwise the History Original picker; otherwise Target; else most recent.
  const activeId = databaseId ?? storedId ?? matchedTargetId ?? databases[0]?.id;

  useEffect(() => {
    setStoreDatabases(databases);
  }, [databases, setStoreDatabases]);

  useEffect(() => {
    if (databaseId) return;
    if (activeId && storeDatabaseId !== activeId) setStoreDatabaseId(activeId);
  }, [databaseId, activeId, storeDatabaseId, setStoreDatabaseId]);

  useEffect(() => {
    setStoreVersions(
      dto.versions.map((v) => ({ id: v.id, number: v.number, name: v.name }))
    );
  }, [dto.versions, setStoreVersions]);

  const compareVersionIds = useMemo(() => {
    const resolved = resolveHistoryCompare(
      dto.versions.map((v) => ({ id: v.id, number: v.number, name: v.name })),
      { originalVersionId, targetVersionId }
    );
    const ids = [resolved.original?.id, resolved.target?.id].filter(
      (id): id is string => Boolean(id)
    );
    return [...new Set(ids)];
  }, [dto.versions, originalVersionId, targetVersionId]);

  /**
   * Default the capture credential to the saved connection that *is* the history
   * database being viewed. Two connection-shaped controls sitting side by side
   * with unrelated values is what made the bar read as "which of these two
   * databases am I looking at?" — when they are the same database, one recorded
   * and one live. Compare's Target is the fallback, as before.
   */
  const activeDatabase = useMemo(
    () => databases.find((d) => d.id === activeId),
    [databases, activeId]
  );
  const matchingCredentialId = useMemo(() => {
    if (!activeDatabase) return undefined;
    const same = (a?: string | null, b?: string | null) =>
      (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
    return connections.find(
      (c) =>
        same(c.dialect, activeDatabase.dialect) &&
        same(c.host, activeDatabase.host) &&
        same(c.database, activeDatabase.database)
    )?.id;
  }, [connections, activeDatabase]);

  useEffect(() => {
    if (captureConnectionId) return;
    const next = matchingCredentialId ?? selectedTargetConnectionId;
    if (next) setCaptureConnectionId(next);
  }, [
    captureConnectionId,
    matchingCredentialId,
    selectedTargetConnectionId,
    setCaptureConnectionId,
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listLokeeDatabases();
        if (!cancelled) setDatabases(rows);
      } catch (err) {
        // A failure here is not fatal — the graph below reports its own error.
        if (!cancelled) setDatabases([]);
        void err;
      } finally {
        if (!cancelled) setDatabasesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken, lokeeEpoch]);

  useEffect(() => {
    if (!activeId) {
      setDto(EMPTY_DTO);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // Timeline is GET /versions — cheap. The graph DTO reconstructs object
        // nodes and is loaded only when the Graph toggle is on.
        const versions = await listLokeeVersions(activeId, 100);
        if (cancelled) return;
        setDto({
          ...EMPTY_DTO,
          databaseId: activeId,
          versions,
          totalVersions: versions.length,
        });
        setVersionsFor(activeId);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load schema history');
        setDto(EMPTY_DTO);
        setVersionsFor(activeId);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, reloadToken, lokeeEpoch]);

  useEffect(() => {
    if (!showGraph || !activeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const graph = await loadVersionGraph(activeId, versionLimit);
        if (cancelled) return;
        setGraphDto(graph);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load schema history');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showGraph, activeId, versionLimit, reloadToken, lokeeEpoch]);

  const subtitle = useMemo(
    () => describe(databases.find((d) => d.id === activeId)),
    [databases, activeId]
  );

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // HistoryCompareBar renders in TopToolbar, so it asks for work by bumping a
  // counter rather than holding a callback. 0 is the initial value — acting on
  // it would refetch on every mount.
  const seenRefreshRequest = useRef(refreshRequest);
  useEffect(() => {
    if (refreshRequest === seenRefreshRequest.current) return;
    seenRefreshRequest.current = refreshRequest;
    refresh();
  }, [refreshRequest, refresh]);

  const saveVersionMeta = useCallback(
    async (versionId: string, patch: { name: string; description: string }) => {
      if (!activeId) return;
      try {
        const version = await updateLokeeVersionMeta(activeId, versionId, patch);
        const rename = <T extends VersionGraphDTO>(prev: T): T => ({
          ...prev,
          versions: prev.versions.map((v) =>
            v.id === versionId
              ? {
                  ...v,
                  name: version.name,
                  description: version.description,
                  author: version.author ?? v.author,
                }
              : v
          ),
        });
        setDto(rename);
        setGraphDto((prev) => (prev ? rename(prev) : prev));
        toast({ tone: 'success', title: 'Version updated', body: 'Name and description saved.' });
      } catch (err) {
        toast({
          tone: 'warning',
          title: 'Could not save version',
          body: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    [activeId]
  );

  const handleSelectObject = useCallback(
    (selected: SchemaObjectNodeData) => {
      setSelectedObject(selected);
      onSelectObject?.(selected);
    },
    [onSelectObject]
  );

  const runCapture = useCallback(async () => {
    if (!captureConnectionId || capturing) return;
    const conn = connections.find((c) => c.id === captureConnectionId);
    if (!conn) {
      toast({ tone: 'warning', title: 'Pick a credential', body: 'Choose a saved connection to capture.' });
      return;
    }
    setCapturing(true);
    try {
      const result = await captureSchema({
        connectionId: captureConnectionId,
        password: getSessionPassword(captureConnectionId) || undefined,
        source: 'manual',
      });
      setStoreDatabaseId(result.databaseId);
      refresh();
      bumpLokeeEpoch();
      toast({
        tone: 'success',
        title: result.changed
          ? `Captured v${result.versionNumber}`
          : `No changes since v${result.versionNumber}`,
        body: result.changed
          ? `${result.changeCount} object change(s) · ${result.objectCount} objects`
          : 'Observation recorded on the version already at the head.',
      });
    } catch (err) {
      toast({
        tone: 'warning',
        title: 'Capture failed',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCapturing(false);
    }
  }, [
    captureConnectionId,
    capturing,
    connections,
    refresh,
    bumpLokeeEpoch,
    setStoreDatabaseId,
    setCapturing,
  ]);

  // Fire on the counter alone, through a ref. Depending on `runCapture` here
  // is an infinite loop: it reads `capturing`, and it also *sets* it, so every
  // toggle gives the callback a new identity, re-runs this effect while the
  // counter is still non-zero, and captures again. Caught by a hanging test.
  //
  // The baseline is whatever the counter held at mount, not zero: the store
  // outlives this component, so leaving History after a capture and coming
  // back would otherwise re-fire that request and snapshot the database again.
  const runCaptureRef = useRef(runCapture);
  runCaptureRef.current = runCapture;
  const seenCaptureRequest = useRef(captureRequest);
  useEffect(() => {
    if (captureRequest === seenCaptureRequest.current) return;
    seenCaptureRequest.current = captureRequest;
    void runCaptureRef.current();
  }, [captureRequest]);




  // HistoryCompareBar's Target card owns the Compare button now, so this view
  // only has to open the modal for the pair the bar resolved.
  const compareRequest = useLokeeHistoryStore((s) => s.compareRequest);
  const seenCompareRequest = useRef(compareRequest);
  useEffect(() => {
    if (compareRequest === seenCompareRequest.current) return;
    seenCompareRequest.current = compareRequest;
    if (compareVersionIds.length >= 1) {
      setComparePair({
        original: compareVersionIds[0]!,
        target: compareVersionIds[1],
      });
    }
  }, [compareRequest, compareVersionIds]);

  /**
   * Keep an open dialog on the sides the bar is showing.
   *
   * The pair used to be snapshotted when the dialog opened, so "Use current
   * database" moved the picker behind the modal and the modal carried on
   * refusing — a button that visibly did nothing. The guard on equality is what
   * stops this from looping.
   */
  useEffect(() => {
    if (!comparePair) return;
    if (compareVersionIds.length === 0) return;
    const original = compareVersionIds[0]!;
    const target = compareVersionIds[1];
    setComparePair((prev) =>
      prev && (prev.original !== original || prev.target !== target) ? { original, target } : prev
    );
  }, [comparePair, compareVersionIds]);

  // Every hook above any early return — a rules-of-hooks crash has happened in
  // this codebase before.
  // Nothing is known yet: either the list has not answered (and no explicit
  // `databaseId` was given), or a database is chosen but its versions are not in.
  //
  // Only then. A refresh of the database already on screen (after a capture, a
  // revert, a pressed Refresh) keeps showing it until the new list arrives:
  // swapping the whole view for a spinner took the graph and its toggle off
  // the page mid-reload, so a click aimed at the toggle landed after the
  // reload and switched the graph off.
  const undecided = activeId ? versionsFor !== activeId : !databasesLoaded;
  // The graph for this database once it has loaded; the timeline until then.
  const graph = graphDto && graphDto.databaseId === activeId ? graphDto : dto;
  if (undecided || (loading && !activeId)) {
    return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden" data-testid="lokee-weave-view">
          <div className="flex flex-1 items-center justify-center text-slate-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" strokeWidth={SQL_ICON_STROKE} />
          Loading schema history…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden" data-testid="lokee-weave-view">
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <TriangleAlert className="h-6 w-6 text-rose-400" strokeWidth={SQL_ICON_STROKE} />
          <div className="text-sm font-semibold text-slate-100">Could not load schema history</div>
          <div className="max-w-md text-xs text-slate-400">{error}</div>
          <button data-testid="lokee-try-again"
            type="button"
            onClick={refresh}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={SQL_ICON_STROKE} />
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!activeId || dto.versions.length === 0) {
    /**
     * First run. This used to be a paragraph telling the reader to go and find
     * a button somewhere else — the one screen where a newcomer has nothing to
     * act on was the one screen with no action on it. The credential picker and
     * the button now live here, and the explanation is two lines under them.
     */
    const chosen = connections.find((c) => c.id === captureConnectionId);
    return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden" data-testid="lokee-weave-view">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <GitBranch className="h-7 w-7 text-slate-500" strokeWidth={SQL_ICON_STROKE} />
          <div>
            <div className="text-sm font-semibold text-slate-100">No schema history yet</div>
            <div className="mt-1 max-w-sm text-xs text-slate-400">
              Take the first snapshot and Fox Schema starts tracking every change to this
              database — what changed, when, and by whom.
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <select
              data-testid="lokee-empty-credential"
              value={captureConnectionId}
              onChange={(e) => setCaptureConnectionId(e.target.value)}
              className="min-w-[200px] rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 accent-focus focus:outline-none"
            >
              <option value="">Choose a database…</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} [{c.dialect}]
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="lokee-empty-capture"
              disabled={!chosen || capturing}
              onClick={() => void runCapture()}
              className="inline-flex items-center gap-1.5 rounded bg-cyan-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-400"
            >
              {capturing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
              ) : (
                <Camera className="h-3.5 w-3.5" strokeWidth={SQL_ICON_STROKE} />
              )}
              {capturing ? 'Taking snapshot…' : 'Take first snapshot'}
            </button>
          </div>
          {connections.length === 0 && (
            <p className="text-[11px] text-slate-500">
              No saved connections yet — add one from <span className="text-slate-300">Credentials</span> first.
            </p>
          )}
          <p className="max-w-sm text-[11px] leading-relaxed text-slate-500">
            After that, every migration you run records a version automatically. You can compare
            any two, and restore the database to an earlier one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden" data-testid="lokee-weave-view">
      {graph.truncatedObjects && showGraph && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-1.5 text-[11px] text-amber-200">
          Showing the objects that changed in this window. This schema has more objects than the
          graph draws at once.
        </div>
      )}
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-slate-800 px-4 py-1">
        <button
          type="button"
          data-testid="lokee-graph-toggle"
          aria-pressed={showGraph}
          onClick={() => setShowGraph((on) => !on)}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-semibold transition ${
            showGraph
              ? 'bg-violet-700/80 text-violet-50'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          <GitBranch className="h-3.5 w-3.5" strokeWidth={SQL_ICON_STROKE} />
          Graph
        </button>
        {canForceMigrate && activeId && (
          <button
            type="button"
            data-testid="lokee-force-migrate-btn"
            onClick={() => setForceMigrateOpen(true)}
            title="Apply a stored version to a database it was not captured from"
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-semibold text-amber-200/90 transition hover:bg-amber-900/30 hover:text-amber-100"
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={SQL_ICON_STROKE} />
            Force migrate…
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {showGraph ? (
            <LokeeWeavePage
              dto={graph}
              subtitle={subtitle}
              embedded={embedded}
              onSelectObject={handleSelectObject}
              selectedObject={selectedObject}
              onClearSelection={() => setSelectedObject(null)}
              onSaveVersionMeta={saveVersionMeta}
            />
          ) : (
            <>
              <VersionChangeChart versions={dto.versions} />
              <VersionBriefing
                versions={dto.versions}
                selectedId={originalVersionId}
              />
              <VersionTimeline
                versions={dto.versions}
                totalVersions={dto.totalVersions || dto.versions.length}
                selectedId={originalVersionId}
                subtitle={subtitle}
                onSelect={(id) => {
                  useLokeeHistoryStore.getState().setOriginalVersionId(id);
                  setComparePair({ original: id });
                }}
              />
            </>
          )}
        </div>
        {comparePair && activeId && (
          <VersionCompareModal
            databaseId={activeId}
            versionId={comparePair.original}
            againstVersionId={comparePair.target}
            embedded
            // Reverting restores the live database, so it is only coherent
            // while Target is the newest version — the modal refuses otherwise.
            latestVersionId={latestVersionId ?? undefined}
            onRetargetToLatest={() => setTargetVersionId(null)}
            captureConnectionId={captureConnectionId || undefined}
            onReverted={refresh}
            onClose={() => setComparePair(null)}
          />
        )}
        {forceMigrateOpen && activeId && (
          <ForceMigrateModal
            databaseId={activeId}
            onApplied={refresh}
            onClose={() => setForceMigrateOpen(false)}
          />
        )}
        {selectedObject && activeId && (
          <LokeeObjectInspector
            databaseId={activeId}
            selected={selectedObject}
            onClose={() => setSelectedObject(null)}
            onSelectVersion={(versionId) => {
              setSelectedObject((prev) => {
                if (!prev) return prev;
                const at = graph.objects.find(
                  (o) => o.objectKey === prev.objectKey && o.versionId === versionId
                );
                return {
                  ...prev,
                  versionId,
                  objectHash: at?.objectHash ?? prev.objectHash,
                  status: at?.status ?? prev.status,
                };
              });
            }}
          />
        )}
      </div>
    </div>
  );
}
