import React, { useEffect, useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import { getApiBase } from '@/shared/api/apiBase';

interface ActivityTask {
  operation: 'migrate' | 'index-maintenance' | 'clone';
  label: string;
  startedAt: number;
  target: string;
}

/** Slow enough to be free, fast enough that a finished job clears promptly. */
const POLL_MS = 5000;

/**
 * Shows what long-running work is in flight across the whole deployment.
 *
 * These operations hold a lock on their target, so a colleague's migration is
 * the reason your own is refused. Without this the refusal arrives as a bare
 * 409 with no way to see what is actually running or how long it has been
 * going.
 *
 * Renders nothing when no work is running, so its presence itself signals that
 * something is in progress.
 */
export const ActivityIndicator: React.FC = () => {
  const [tasks, setTasks] = useState<ActivityTask[]>([]);
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      // A hidden tab has no one to show this to; it catches up when shown.
      if (document.visibilityState !== 'hidden') {
        try {
          const res = await fetch(`${getApiBase()}/activity`, {
            credentials: 'include',
            cache: 'no-store',
          });
          if (res.ok) {
            const body = (await res.json()) as { tasks?: ActivityTask[] };
            const next = body.tasks ?? [];
            // Nothing running is the usual answer; keep the same empty list so
            // the toolbar is not re-rendered every five seconds for it.
            if (!cancelled) setTasks((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
          }
        } catch {
          // A failed poll is not worth surfacing: the offline banner already
          // reports an unreachable backend, and two alarms for one cause is
          // noise.
        }
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nonce]);

  // Poll at once when the tab is looked at again, rather than up to 5 s later.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (tasks.length === 0) return null;

  const elapsed = (startedAt: number) => {
    const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
  };

  return (
    <div className="relative" data-testid="activity-indicator">
      <button
        type="button"
        data-testid="activity-toggle"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[11px] font-bold text-sky-100"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {tasks.length} running
      </button>

      {open && (
        <div
          data-testid="activity-list"
          className="absolute right-0 z-50 mt-1 w-80 rounded-md border border-slate-700 bg-slate-900 p-2 shadow-2xl"
        >
          <p className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            Running now
          </p>
          <ul className="flex flex-col gap-1">
            {tasks.map((t, i) => (
              <li key={i} className="rounded border border-slate-800 px-2 py-1.5">
                <div className="flex items-center gap-2 text-[11px]">
                  <Loader2 className="w-3 h-3 animate-spin text-sky-400 shrink-0" />
                  <span className="font-semibold text-slate-200">{t.label}</span>
                  <span className="ml-auto text-slate-500">{elapsed(t.startedAt)}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                  {t.target}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 flex items-start gap-1.5 px-1 text-[10px] text-slate-500">
            <Users className="w-3 h-3 shrink-0 mt-0.5" />
            These hold their target, so a migration or index rebuild on the same
            database and schema will wait.
          </p>
        </div>
      )}
    </div>
  );
};
