import React, { useEffect, useState } from 'react';
import { RefreshCw, CheckCircle2, ArrowUpCircle, Loader2, Download } from 'lucide-react';
import { checkForUpdates, type UpdateInfo } from '@/shared/api/updatesApi';
import { runSelfUpdate, toastUpdateCheckResult } from '@/app/shell/updateToast';
import { toast } from '@/platform/toastStore';

/** Current version + check / one-click update controls, in Settings. */
export const UpdatesSettings: React.FC = () => {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  const run = async (opts?: { toast?: boolean }) => {
    setChecking(true);
    try {
      const next = await checkForUpdates();
      setInfo(next);
      if (opts?.toast) toastUpdateCheckResult(next);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void run();
  }, []);

  const onUpdateNow = async () => {
    setUpdating(true);
    try {
      await runSelfUpdate();
    } finally {
      setUpdating(false);
    }
  };

  const onCopy = async () => {
    const cmd = info?.upgradeCommand || 'npm install -g foxschema@latest';
    try {
      await navigator.clipboard.writeText(cmd);
      toast({ tone: 'success', title: 'Command copied', body: cmd });
    } catch {
      toast({ tone: 'info', title: 'Run in a terminal', body: cmd, durationMs: 12_000 });
    }
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 text-xs flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-slate-300">
          Current version <span className="font-mono text-slate-200">v{info?.current ?? '—'}</span>
        </p>
        {info?.updateAvailable ? (
          <p className="mt-0.5 inline-flex items-center gap-1 text-amber-300">
            <ArrowUpCircle className="w-3.5 h-3.5" /> v{info.latest} available
            {info.url ? (
              <>
                {' · '}
                <a
                  href={info.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-amber-500/50 hover:text-amber-200"
                >
                  What&apos;s new
                </a>
              </>
            ) : null}
          </p>
        ) : info ? (
          <p className="mt-0.5 inline-flex items-center gap-1 text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {info.configured ? 'Up to date' : 'Up to date (check disabled)'}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        {info?.updateAvailable && info.canSelfUpdate && (
          <button
            type="button"
            data-testid="updates-apply-btn"
            onClick={() => void onUpdateNow()}
            disabled={updating || checking}
            className="flex items-center gap-1.5 px-3 py-1.5 font-semibold bg-amber-900/50 hover:bg-amber-800/60 border border-amber-600/50 text-amber-100 rounded-md transition disabled:opacity-50"
          >
            {updating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            Update now
          </button>
        )}
        {info?.updateAvailable && !info.canSelfUpdate && (
          <button
            type="button"
            data-testid="updates-copy-cmd-btn"
            onClick={() => void onCopy()}
            className="flex items-center gap-1.5 px-3 py-1.5 font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition"
          >
            Copy command
          </button>
        )}
        <button
          type="button"
          data-testid="updates-check-btn"
          onClick={() => void run({ toast: true })}
          disabled={checking || updating}
          className="flex items-center gap-1.5 px-3 py-1.5 font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition disabled:opacity-50"
        >
          {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}{' '}
          Check
        </button>
      </div>
    </div>
  );
};
