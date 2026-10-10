/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the Compare view adds to the top toolbar: the Compare / Browse switch,
 * the Original and Target connections, the Compare button, the snapshot
 * button and, under them, the object scope and the result filter.
 *
 * Three parts because the shell lays the row out: \`CompareToolbarStart\` leads
 * the first row, \`CompareToolbarEnd\` follows the shell's own controls at its
 * end, and \`CompareToolbarBelow\` is the second row.
 */
import React, { lazy, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { ArrowRight, ArrowLeftRight, RefreshCw, AlertCircle, Zap, Settings, KeyRound, X, Layers, Camera } from 'lucide-react';
import { useUiStore } from '@/app/store/uiStore';
import { useAuthStore } from '@/app/store/authStore';
import { toast } from '@/app/store/toastStore';
import { loadConnectionModal } from '@/features/connections';
import { captureSchema } from '@/features/lokee-weave';
import { DiffBriefingChips, TYPE_META, TYPE_ORDER, diffBriefing } from '@/features/schema-diff';
import type { DbObjectType } from '@/shared/lib/types';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { schemaCompareBlocker } from '@/shared/lib/dialect-features';
import { MountWhenOpened } from '@/shared/components/MountWhenOpened';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { getSessionPassword, setSessionPassword } from '@/shared/lib/sessionPasswords';
import { useSyncStore } from '../state/useSyncStore';
import { pointsToSameDatabase } from '../lib/sameDatabase';
import { BrowseBar } from './BrowseBar';
import { ConnectionChip } from './ConnectionChips';

// Opened on a click: loaded on the first open.
const ConnectionModal = lazy(loadConnectionModal);

function connectionSummary(config: {
  schema: string;
  option: { host?: string; database?: string };
}): string | null {
  if (!config.option.database) return null;
  return `${config.option.host ?? 'localhost'} / ${config.option.database}${
    config.schema ? ` / ${config.schema}` : ''
  }`;
}

const OBJECT_SCOPE_OPTIONS: { type: DbObjectType; label: string }[] = [
  { type: 'TABLE', label: 'Tables' },
  { type: 'MQT', label: 'MQTs' },
  { type: 'VIEW', label: 'Views' },
  { type: 'FUNCTION', label: 'Functions' },
  { type: 'PROCEDURE', label: 'Procedures' },
  { type: 'TRIGGER', label: 'Triggers' },
  { type: 'SEQUENCE', label: 'Sequences' },
  { type: 'TYPE', label: 'Types' },
  { type: 'ROLE', label: 'Roles' },
];

export const CompareToolbarStart: React.FC = () => {
  // useShallow: none of these change on a deploy-checkbox click, so the
  // toolbar no longer re-renders on one. (A bare object selector would loop in zustand 5.)
  const {
    sourceConfig,
    targetConfig,
    setShowConnectionModal,
    isTestingSource,
    isTestingTarget,
    sourceConnected,
    targetConnected,
    testSourceConnection,
    testTargetConnection,
    isComparing,
    runSchemaComparison,
    compareResult,
    selectedObjectTypes,
    showConnectionModal,
    addConnection,
    connections,
    selectedSourceConnectionId,
    selectedTargetConnectionId,
    applySavedConnection,
    swapSourceTarget,
  } = useSyncStore(
    useShallow((s) => ({
      sourceConfig: s.sourceConfig,
      targetConfig: s.targetConfig,
      setShowConnectionModal: s.setShowConnectionModal,
      isTestingSource: s.isTestingSource,
      isTestingTarget: s.isTestingTarget,
      sourceConnected: s.sourceConnected,
      targetConnected: s.targetConnected,
      testSourceConnection: s.testSourceConnection,
      testTargetConnection: s.testTargetConnection,
      isComparing: s.isComparing,
      runSchemaComparison: s.runSchemaComparison,
      compareResult: s.compareResult,
      selectedObjectTypes: s.selectedObjectTypes,
      showConnectionModal: s.showConnectionModal,
      addConnection: s.addConnection,
      connections: s.connections,
      selectedSourceConnectionId: s.selectedSourceConnectionId,
      selectedTargetConnectionId: s.selectedTargetConnectionId,
      applySavedConnection: s.applySavedConnection,
      swapSourceTarget: s.swapSourceTarget,
    }))
  );

  const [activeModalTarget, setActiveModalTarget] = useState<'source' | 'target' | null>(null);
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);
  const { syncPane, setSyncPane, bumpLokeeEpoch } = useUiStore(
    useShallow((s) => ({ syncPane: s.syncPane, setSyncPane: s.setSyncPane, bumpLokeeEpoch: s.bumpLokeeEpoch }))
  );
  const canSchemaBrowse = useAuthStore((s) => s.can('schema.browse'));
  const canSchemaCompare = useAuthStore((s) => s.can('schema.compare'));

  /**
   * Whether the engines in play can be compared at all, as opposed to whether
   * this user is allowed to — different refusals, and the UI only ever
   * expressed the second. `resolveDialect` answers Db2 for a name it does not
   * recognise, so comparing a Redis or MongoDB connection produced Db2 DDL
   * with nothing to say it had.
   *
   * This gates the Compare button and nothing else.
   */
  const compareBlockedBy = schemaCompareBlocker(sourceConfig.dialect, targetConfig.dialect);

  const [pendingPassword, setPendingPassword] = useState<{ side: 'source' | 'target'; id: string; name: string } | null>(null);
  const [pendingPasswordValue, setPendingPasswordValue] = useState('');

  const selectSavedConnection = (side: 'source' | 'target', id: string) => {
    const conn = connections.find((c) => c.id === id);
    if (conn && !conn.hasPassword && connectionNeedsSecret(conn.dialect, conn.authMethod)) {
      const cfg = side === 'source' ? sourceConfig : targetConfig;
      const existing =
        getSessionPassword(id) ||
        (cfg.connectionId === id && cfg.option?.password ? cfg.option.password : undefined);
      if (existing) {
        applySavedConnection(side, id, existing);
        return;
      }
      setPendingPassword({ side, id, name: conn.name });
      setPendingPasswordValue('');
      return;
    }
    applySavedConnection(side, id);
  };

  const confirmPendingPassword = () => {
    if (!pendingPassword) return;
    const trimmed = pendingPasswordValue.trim();
    if (!trimmed) return;
    setSessionPassword(pendingPassword.id, trimmed);
    applySavedConnection(pendingPassword.side, pendingPassword.id, trimmed);
    setPendingPassword(null);
    setPendingPasswordValue('');
  };

  const snapshotTarget = async () => {
    if (!selectedTargetConnectionId || capturingSnapshot) return;
    setCapturingSnapshot(true);
    try {
      const result = await captureSchema({
        connectionId: selectedTargetConnectionId,
        password: getSessionPassword(selectedTargetConnectionId) || undefined,
        source: 'manual',
      });
      bumpLokeeEpoch();
      toast({
        tone: 'success',
        title: result.changed ? `Snapshot v${result.versionNumber}` : `No changes since v${result.versionNumber}`,
        body: result.changed
          ? `${result.changeCount} object change(s) · ${result.objectCount} objects`
          : 'Target schema matches the last snapshot — nothing new to record.',
      });
      setSyncPane('history');
    } catch (err) {
      toast({
        tone: 'warning',
        title: 'Snapshot failed',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCapturingSnapshot(false);
    }
  };

  const sameConfig = pointsToSameDatabase(sourceConfig, targetConfig);

  const compareUnavailable =
    !canSchemaCompare ||
    Boolean(compareBlockedBy) ||
    !sourceConnected ||
    !targetConnected ||
    selectedObjectTypes.length === 0 ||
    sameConfig;

  const compareTitle =
    (!canSchemaCompare && 'Your role cannot compare schemas') ||
    compareBlockedBy ||
    (sameConfig && 'Original Server and Target point to the same database and schema') ||
    (!sourceConnected && !targetConnected && 'Pick an Original and a Target connection first') ||
    (!sourceConnected && 'Pick and connect the Original connection') ||
    (!targetConnected && 'Pick and connect the Target connection') ||
    undefined;

  const briefing = diffBriefing(compareResult?.tables);

  return (
    <>
      {canSchemaBrowse && (
        <div
          data-testid="sync-pane-switcher"
          className="flex shrink-0 items-center gap-0.5 rounded-full border border-slate-800 bg-slate-950/60 p-0.5"
        >
          <button
            type="button"
            data-testid="sync-pane-compare-btn"
            onClick={() => setSyncPane('compare')}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
              syncPane === 'compare'
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Compare
          </button>
          <button
            type="button"
            data-testid="sync-pane-browse-btn"
            onClick={() => setSyncPane('browse')}
            title="Read one database's schema on its own — no comparison."
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
              syncPane === 'browse'
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Browse
          </button>
        </div>
      )}

      {syncPane === 'compare' && (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <ConnectionChip
            side="source"
            label="Original"
            connections={connections}
            selectedId={selectedSourceConnectionId}
            summary={connectionSummary(sourceConfig)}
            connected={sourceConnected}
            connecting={isTestingSource}
            onSelect={(id) => selectSavedConnection('source', id)}
            onEdit={() => {
              setActiveModalTarget('source');
              setShowConnectionModal(true);
            }}
            onConnect={testSourceConnection}
          />
          <button data-testid="toolbar-swap-direction"
            type="button"
            onClick={swapSourceTarget}
            title="Swap Original Server and Target (reverse migration direction)"
            className="group flex shrink-0 flex-col items-center px-0.5"
          >
            <ArrowRight className="h-4 w-4 text-indigo-400 group-hover:hidden" />
            <ArrowLeftRight className="hidden h-4 w-4 text-cyan-400 group-hover:block" />
          </button>
          <ConnectionChip
            side="target"
            label="Target"
            connections={connections}
            selectedId={selectedTargetConnectionId}
            summary={connectionSummary(targetConfig)}
            connected={targetConnected}
            connecting={isTestingTarget}
            onSelect={(id) => selectSavedConnection('target', id)}
            onEdit={() => {
              setActiveModalTarget('target');
              setShowConnectionModal(true);
            }}
            onConnect={testTargetConnection}
          />
          {sameConfig && (
            <span className="flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-950/30 px-2 py-0.5 text-[11px] font-medium text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Same DB
            </span>
          )}
          {compareResult && <DiffBriefingChips briefing={briefing} />}
          <button
            data-testid="compare-btn"
            onClick={runSchemaComparison}
            disabled={compareUnavailable || isComparing}
            title={compareTitle}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold shadow-lg transition ${
              compareUnavailable
                ? 'cursor-not-allowed border border-slate-800/50 bg-slate-850 text-slate-500'
                : 'accent-grad on-accent-fg cursor-pointer shadow-indigo-500/10'
            }`}
          >
            {isComparing ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Analyzing…
              </>
            ) : (
              <>
                <Zap className="h-3.5 w-3.5 fill-current" /> Compare
              </>
            )}
          </button>
        </div>
      )}

      {syncPane === 'browse' && (
        <div className="min-w-0 flex-1">
          <BrowseBar />
        </div>
      )}

      {canSchemaBrowse && (
        <button
          type="button"
          data-testid="lokee-snapshot-target-btn"
          disabled={!selectedTargetConnectionId || capturingSnapshot}
          onClick={() => void snapshotTarget()}
          title="Take an initial snapshot of the Target schema. Later migrates snapshot automatically."
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-950/40 px-2 py-1 text-[11px] font-bold text-cyan-100 hover:bg-cyan-900/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Camera className="h-3.5 w-3.5" />
          {capturingSnapshot ? 'Snapshotting…' : 'Snapshot target'}
        </button>
      )}

      <MountWhenOpened open={showConnectionModal}>
      <ConnectionModal
        open={showConnectionModal}
        mode="credential"
        dialect={activeModalTarget === 'target' ? targetConfig.dialect : sourceConfig.dialect}
        initialOptions={activeModalTarget === 'target' ? targetConfig.option : sourceConfig.option}
        initialName={
          (activeModalTarget === 'target'
            ? connections.find((c) => c.id === selectedTargetConnectionId)?.name
            : connections.find((c) => c.id === selectedSourceConnectionId)?.name) ?? ''
        }
        onClose={() => {
          setShowConnectionModal(false);
          setActiveModalTarget(null);
        }}
        onSaveCredential={async (input) => {
          const side = activeModalTarget === 'target' ? 'target' : 'source';
          const saved = await addConnection(input);
          const sessionPw = saved.hasPassword ? undefined : input.option.password;
          if (sessionPw) setSessionPassword(saved.id, sessionPw);
          applySavedConnection(side, saved.id, sessionPw);
        }}
      />
      </MountWhenOpened>

      {pendingPassword && createPortal(
        <div
          className="modal-overlay"
          onClick={() => setPendingPassword(null)}
        >
          <div
            className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/40">
              <span className="flex items-center gap-2 text-sm font-bold text-slate-100">
                <KeyRound className="w-4 h-4 text-cyan-400" /> Enter Password
              </span>
              <button data-testid="toolbar-password-show"
                onClick={() => setPendingPassword(null)}
                className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-slate-400">
                <span className="font-semibold text-slate-200">{pendingPassword.name}</span> was saved without a
                stored password. Enter it for this session only — it won't be persisted.
              </p>
              <PasswordInput
                autoFocus
                value={pendingPasswordValue}
                onChange={(e) => setPendingPasswordValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmPendingPassword()}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-850 accent-focus text-sm text-slate-200 rounded px-3 py-2 outline-none font-mono"
              />
              <div className="flex justify-end gap-2 pt-1">
                <button data-testid="toolbar-password-cancel"
                  onClick={() => setPendingPassword(null)}
                  className="text-xs font-semibold text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded transition cursor-pointer"
                >
                  Cancel
                </button>
                <button data-testid="toolbar-password-connect"
                  onClick={confirmPendingPassword}
                  disabled={!pendingPasswordValue.trim()}
                  className="text-xs font-bold accent-grad on-accent-fg rounded px-4 py-1.5 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Connect
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

/** Clears the compare result; after the shell's controls, where it always sat. */
export const CompareToolbarEnd: React.FC = () => {
  const compareResult = useSyncStore((s) => s.compareResult);
  const resetSync = useSyncStore((s) => s.resetSync);
  const syncPane = useUiStore((s) => s.syncPane);
  if (!compareResult || syncPane !== 'compare') return null;
  return (
    <button
      data-testid="toolbar-clear"
      onClick={resetSync}
      className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
    >
      Clear
    </button>
  );
};

/** The object scope to compare and, once there is a result, the type filter. */
export const CompareToolbarBelow: React.FC = () => {
  const { compareResult, selectedObjectTypes, toggleObjectTypeFilter, typeFilter, toggleTypeFilter, clearTypeFilter } = useSyncStore(
    useShallow((s) => ({
      compareResult: s.compareResult,
      selectedObjectTypes: s.selectedObjectTypes,
      toggleObjectTypeFilter: s.toggleObjectTypeFilter,
      typeFilter: s.typeFilter,
      toggleTypeFilter: s.toggleTypeFilter,
      clearTypeFilter: s.clearTypeFilter,
    }))
  );
  const syncPane = useUiStore((s) => s.syncPane);

  const typeCounts = (type: 'ALL' | DbObjectType) =>
    type === 'ALL'
      ? (compareResult?.tables.length ?? 0)
      : (compareResult?.tables.filter((t) => t.objectType === type).length ?? 0);

  if (syncPane !== 'compare') return null;
  return (
    <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 pr-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <Settings className="h-3 w-3 text-cyan-400" /> Scope
        </span>
        {OBJECT_SCOPE_OPTIONS.map((opt) => {
          const active = selectedObjectTypes.includes(opt.type);
          return (
            <button data-testid={`toolbar-toggle-object-type-${opt.type}`}
              key={opt.type}
              onClick={() => toggleObjectTypeFilter(opt.type)}
              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold transition ${
                active
                  ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'
                  : 'border-slate-850 bg-slate-900/50 text-slate-500 hover:bg-slate-900 hover:text-slate-400'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {compareResult && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 pr-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <Layers className="h-3 w-3 text-cyan-400" /> Viewing
          </span>
          <button data-testid="toolbar-object-types-all"
            onClick={clearTypeFilter}
            className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold transition ${
              typeFilter.length === 0
                ? 'border-slate-600 bg-slate-800 text-slate-100'
                : 'border-slate-850 bg-slate-900/50 text-slate-500 hover:text-slate-400'
            }`}
          >
            All {typeCounts('ALL')}
          </button>
          {TYPE_ORDER.map((type) => {
            const active = typeFilter.includes(type);
            return (
              <button data-testid={`toolbar-toggle-type-filter-${type}`}
                key={type}
                onClick={() => toggleTypeFilter(type)}
                className={`flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold transition ${
                  active
                    ? 'border-slate-600 bg-slate-800 text-slate-100'
                    : 'border-slate-850 bg-slate-900/50 text-slate-500 hover:text-slate-400'
                }`}
              >
                <span className={TYPE_META[type].color}>{TYPE_META[type].icon}</span>
                {TYPE_META[type].group}
                <span className="text-slate-500">{typeCounts(type)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
