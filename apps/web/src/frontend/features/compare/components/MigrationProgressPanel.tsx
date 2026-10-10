import React from 'react';
import { useSyncStore } from '@/features/compare/state/useSyncStore';
import { useShallow } from 'zustand/react/shallow';
import { RefreshCw, CheckCircle2, XCircle, Circle, AlertCircle, Download, X, Undo2, SkipForward, MinusCircle } from 'lucide-react';

const fileSafe = (s?: string) => (s ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

/**
 * Floating bottom-right panel that streams per-object migration progress and the
 * final outcome (success / rollback / dependent-view conflict guidance). Fully
 * store-driven — it renders whenever there's progress to show.
 */
export const MigrationProgressPanel: React.FC = () => {
  // Only these fields: a whole-store subscription re-rendered this on every
  // store write (migration progress events included).
  const {
    isMigrating,
    migrationProgress,
    snapshotDdl,
    migrationError,
    migrationRolledBack,
    clearMigrationProgress,
    skipObjectAndRetry,
    setNonDestructive,
    targetConfig,
  } = useSyncStore(
    useShallow((s) => ({
      isMigrating: s.isMigrating,
      migrationProgress: s.migrationProgress,
      snapshotDdl: s.snapshotDdl,
      migrationError: s.migrationError,
      migrationRolledBack: s.migrationRolledBack,
      clearMigrationProgress: s.clearMigrationProgress,
      skipObjectAndRetry: s.skipObjectAndRetry,
      setNonDestructive: s.setNonDestructive,
      targetConfig: s.targetConfig,
    }))
  );

  if (migrationProgress.length === 0) return null;

  // continueOnError can finish with migrationError === null (the run committed)
  // while individual objects still failed and were skipped — distinguish that
  // from a clean run without treating it as the hard-failure/rollback case.
  const failedCount = migrationProgress.filter((i) => i.status === 'FAILED').length;

  const downloadSnapshot = () => {
    if (!snapshotDdl) return;
    const url = URL.createObjectURL(new Blob([snapshotDdl], { type: 'text/sql' }));
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `snapshot_${fileSafe(targetConfig.option.host)}_${fileSafe(targetConfig.option.database)}_${fileSafe(targetConfig.schema)}_${stamp}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div data-testid="migration-progress-panel" className="fixed bottom-6 right-6 w-[380px] max-h-[60vh] flex flex-col bg-slate-900/95 border border-slate-700 rounded-xl shadow-2xl backdrop-blur-md z-50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-950/60">
        <h4
          data-testid={isMigrating ? 'migration-running' : migrationError ? 'migration-failed' : failedCount > 0 ? 'migration-partial' : 'migration-complete'}
          className="text-xs font-bold text-slate-100 flex items-center gap-2"
        >
          {isMigrating ? (
            <><RefreshCw className="w-4 h-4 animate-spin text-cyan-400" /> Migrating Target...</>
          ) : migrationError ? (
            <><XCircle className="w-4 h-4 text-rose-400" /> Migration Failed</>
          ) : failedCount > 0 ? (
            <><AlertCircle className="w-4 h-4 text-amber-400" /> Completed With Failures</>
          ) : (
            <><CheckCircle2 className="w-4 h-4 text-emerald-400" /> Migration Complete</>
          )}
        </h4>
        <div className="flex items-center gap-1.5">
          {snapshotDdl && (
            <button data-testid="migration-download-pre-migration"
              onClick={downloadSnapshot}
              title="Download pre-migration schema snapshot"
              className="flex items-center gap-1 text-[10px] text-slate-300 hover:text-slate-100 border border-slate-700 rounded px-2 py-1 hover:bg-slate-800 transition"
            >
              <Download className="w-3 h-3" /> Snapshot
            </button>
          )}
          {!isMigrating && (
            <button data-testid="migration-clear-migration-progress"
              onClick={clearMigrationProgress}
              className="p-1 text-slate-500 hover:text-slate-200 hover:bg-slate-800 rounded transition"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {migrationProgress.map((item) => (
          <div
            key={`${item.action}-${item.objectName}`}
            data-testid="migration-progress-item"
            data-object={item.objectName}
            data-status={item.status}
            className={`flex items-start gap-2.5 px-3 py-2 rounded-lg text-xs ${
              item.status === 'FAILED' ? 'bg-rose-950/30 border border-rose-500/20' :
              item.status === 'SKIPPED' ? 'bg-amber-950/20 border border-amber-500/20' :
              'bg-slate-950/40'
            }`}
          >
            <span className="mt-0.5 shrink-0">
              {item.status === 'PENDING' && <Circle className="w-3.5 h-3.5 text-slate-600" />}
              {item.status === 'RUNNING' && <RefreshCw className="w-3.5 h-3.5 text-cyan-400 animate-spin" />}
              {item.status === 'SUCCESS' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
              {item.status === 'FAILED' && <XCircle className="w-3.5 h-3.5 text-rose-400" />}
              {item.status === 'SKIPPED' && <MinusCircle className="w-3.5 h-3.5 text-amber-400" />}
            </span>
            <div className="min-w-0">
              <span className="font-mono font-semibold text-slate-200">
                <span className="text-slate-500 font-sans font-bold text-[10px] mr-1.5">{item.action}</span>
                {item.objectName}
              </span>
              <span className="text-slate-600 ml-1.5 text-[10px] uppercase">{item.objectType}</span>
              {item.error && item.status === 'SKIPPED' && (
                <p className="text-[10px] text-amber-400 mt-1 break-all">{item.error}</p>
              )}
              {item.error && item.status === 'FAILED' && (
                <p className="text-[10px] text-rose-400 mt-1 font-mono break-all">{item.error}</p>
              )}
              {item.status === 'FAILED' && !isMigrating && (
                <button data-testid={`migration-skip-retry-${item.objectName}`}
                  onClick={() => skipObjectAndRetry(item.objectName)}
                  title={`Exclude ${item.objectName} and re-run the migration with the remaining objects`}
                  className="mt-2 flex items-center gap-1 text-[10px] font-semibold text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 rounded px-2 py-1 transition"
                >
                  <SkipForward className="w-3 h-3" /> Skip &amp; retry
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {!isMigrating && migrationError && (
        <div className="px-4 py-3 border-t border-slate-800 bg-rose-950/30 flex items-start gap-2">
          <Undo2 className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-slate-300">
            {migrationRolledBack
              ? 'All changes were rolled back — the target is unchanged.'
              : 'Rollback could not be confirmed — verify the target manually (snapshot available above).'}
          </p>
        </div>
      )}

      {/* Actionable guidance for the dependent-view conflict, with a one-click fix. */}
      {!isMigrating && migrationError && /cannot restore dependent view/i.test(migrationError) && (() => {
        const view = /dependent view\s+([^\s]+)/i.exec(migrationError)?.[1];
        return (
          <div className="px-4 py-3 border-t border-slate-800 bg-amber-950/20">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-[11px] text-slate-300 space-y-2">
                <p className="font-semibold text-amber-200">
                  A view{view ? <> (<span className="font-mono">{view}</span>)</> : null} depends on a column this migration changes
                </p>
                <p className="text-slate-400">
                  The migration drops or retypes a column that view uses, so it can&apos;t be rebuilt afterwards.
                  The target was left unchanged. Choose how to proceed:
                </p>
                <ul className="space-y-2">
                  <li className="flex items-start gap-2">
                    <button data-testid="migration-switch-non-destructive"
                      onClick={() => { setNonDestructive(true); clearMigrationProgress(); }}
                      className="shrink-0 text-[11px] font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded px-2 py-1 transition on-accent-fg"
                    >
                      Switch to non-destructive
                    </button>
                    <span className="text-slate-400 mt-0.5">
                      Keeps the column (no drop), so the view stays valid. Then press <span className="text-slate-200 font-semibold">Execute</span> again.
                    </span>
                  </li>
                  <li className="text-slate-400 pl-1">
                    Or drop / update <span className="font-mono text-slate-300">{view ?? 'the view'}</span> in the target yourself
                    {view ? <> — e.g. <code className="text-slate-300">DROP VIEW {view};</code></> : null}, then re-run.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        );
      })()}

      {!isMigrating && !migrationError && (() => {
        const skipped = migrationProgress.filter((i) => i.status === 'SKIPPED').length;
        const deployed = migrationProgress.length - skipped - failedCount;
        return (
          <div className={`px-4 py-3 border-t border-slate-800 ${failedCount > 0 ? 'bg-amber-950/20' : 'bg-emerald-950/20'}`}>
            <p className="text-[11px] text-slate-300">
              {deployed} object(s) deployed and committed to the target.
              {failedCount > 0 && (
                <span className="text-amber-400 ml-1">
                  {failedCount} failed and {failedCount === 1 ? 'was' : 'were'} skipped — objects depending on{' '}
                  {failedCount === 1 ? 'it' : 'them'} may have failed too; review the errors above.
                </span>
              )}
              {skipped > 0 && (
                <span className="text-amber-400 ml-1">{skipped} skipped (no definition available).</span>
              )}
            </p>
          </div>
        );
      })()}
    </div>
  );
};
