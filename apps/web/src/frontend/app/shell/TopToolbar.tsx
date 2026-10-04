import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useShallow } from 'zustand/react/shallow';
import { useUiStore } from '@/app/store/uiStore';
import { ArrowRight, ArrowLeftRight, RefreshCw, AlertCircle, Zap, Settings, KeyRound, X, Layers, Camera, Search } from 'lucide-react';
import { TYPE_META, TYPE_ORDER } from '@/features/schema-diff';
import type { DbObjectType } from '@/shared/lib/types';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { schemaCompareBlocker } from '@/shared/lib/dialect-features';
import { ConnectionModal } from '@/features/connections';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { useAuthStore } from '@/app/store/authStore';
import { captureSchema } from '@/features/lokee-weave/api/lokeeApi';
import { toast } from '@/app/store/toastStore';
import { getSessionPassword, setSessionPassword } from '@/shared/lib/sessionPasswords';
import { HistoryCompareBar } from '@/features/lokee-weave/components/HistoryCompareBar';
import { BrowseBar } from '@/features/object-detail';
import { ActivityIndicator } from './ActivityIndicator';
import { DiffBriefingChips } from '@/features/schema-diff';
import { diffBriefing } from '@/features/schema-diff';
import { ConnectionChip } from './ConnectionChips';
import { pointsToSameDatabase } from './sameDatabase';
import { openCommandPalette } from './commandPaletteEvent';

function connectionSummary(config: {
  schema: string;
  option: { host?: string; database?: string };
}): string | null {
  if (!config.option.database) return null;
  return `${config.option.host ?? 'localhost'} / ${config.option.database}${
    config.schema ? ` / ${config.schema}` : ''
  }`;
}

export const TopToolbar: React.FC = () => {
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
    resetSync,
    selectedObjectTypes,
    toggleObjectTypeFilter,
    typeFilter,
    toggleTypeFilter,
    clearTypeFilter,
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
      resetSync: s.resetSync,
      selectedObjectTypes: s.selectedObjectTypes,
      toggleObjectTypeFilter: s.toggleObjectTypeFilter,
      typeFilter: s.typeFilter,
      toggleTypeFilter: s.toggleTypeFilter,
      clearTypeFilter: s.clearTypeFilter,
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
  const { activeView, syncPane, setSyncPane, bumpLokeeEpoch } = useUiStore();
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

  const typeCounts = (type: 'ALL' | DbObjectType) =>
    type === 'ALL'
      ? (compareResult?.tables.length ?? 0)
      : (compareResult?.tables.filter((t) => t.objectType === type).length ?? 0);

  const briefing = diffBriefing(compareResult?.tables);

  const objectScopeOptions: { type: DbObjectType; label: string }[] = [
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

  return (
    <header data-testid="toolbar" className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-3 py-1 flex flex-col gap-1">
      <div className="flex min-h-9 flex-wrap items-center gap-1.5">
        {activeView === 'sync' && canSchemaBrowse && (
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

        {activeView === 'sync' && syncPane === 'compare' && (
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

        {activeView === 'sync' && syncPane === 'browse' && (
          <div className="min-w-0 flex-1">
            <BrowseBar />
          </div>
        )}

        {activeView === 'sync' && canSchemaBrowse && (
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

        {activeView === 'snapshots' && (
          <div className="min-w-0 flex-1">
            <HistoryCompareBar />
          </div>
        )}

        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
          <ActivityIndicator />
          <button
            type="button"
            data-testid="command-palette-btn"
            onClick={() => openCommandPalette()}
            title="Command palette (⌘K)"
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-100"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-slate-700 bg-slate-950 px-1 font-mono text-[9px] text-slate-500 sm:inline">
              ⌘K
            </kbd>
          </button>
          {compareResult && activeView === 'sync' && syncPane === 'compare' && (
            <button data-testid="toolbar-clear"
              onClick={resetSync}
              className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {activeView === 'sync' && syncPane === 'compare' && (
        <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1 pr-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <Settings className="h-3 w-3 text-cyan-400" /> Scope
            </span>
            {objectScopeOptions.map((opt) => {
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
      )}

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
    </header>
  );
};
