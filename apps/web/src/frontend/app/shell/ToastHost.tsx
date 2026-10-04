import React, { useEffect } from 'react';
import { ArrowUpCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useToastStore, type ToastItem, type ToastTone } from '@/app/store/toastStore';

const TONE_ICON: Record<ToastTone, React.ReactNode> = {
  info: <Info className="w-4 h-4 text-sky-300 shrink-0" />,
  success: <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />,
  warning: <ArrowUpCircle className="w-4 h-4 text-amber-300 shrink-0" />,
};

const TONE_BORDER: Record<ToastTone, string> = {
  info: 'border-sky-500/35',
  success: 'border-emerald-500/35',
  warning: 'border-amber-500/40',
};

const ToastCard: React.FC<{ item: ToastItem }> = ({ item }) => {
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    if (!item.durationMs) return;
    const t = window.setTimeout(() => dismiss(item.id), item.durationMs);
    return () => window.clearTimeout(t);
  }, [item.id, item.durationMs, dismiss]);

  return (
    <div
      role="status"
      data-testid="app-toast"
      data-tone={item.tone}
      className={`pointer-events-auto w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border ${TONE_BORDER[item.tone]} bg-slate-900/95 shadow-xl backdrop-blur-sm px-3.5 py-3 animate-toast-in`}
    >
      <div className="flex items-start gap-2.5">
        {TONE_ICON[item.tone]}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100 leading-snug">{item.title}</p>
          {item.body && (
            <p className="mt-0.5 text-xs text-slate-400 leading-relaxed">{item.body}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {item.onAction && item.actionButtonLabel && (
              <button
                type="button"
                data-testid="toast-action-btn"
                onClick={() => {
                  dismiss(item.id);
                  item.onAction?.();
                }}
                className="text-xs font-semibold text-amber-300 hover:text-amber-200 hover:underline"
              >
                {item.actionButtonLabel}
              </button>
            )}
            {item.actionHref && item.actionLabel && (
              <a
                href={item.actionHref}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-semibold text-slate-400 hover:text-slate-200 hover:underline"
              >
                {item.actionLabel}
              </a>
            )}
          </div>
        </div>
        <button data-testid="toast-dismiss"
          type="button"
          aria-label="Dismiss"
          onClick={() => dismiss(item.id)}
          className="shrink-0 p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

/** Fixed toast stack — mount once near the app root. */
export const ToastHost: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      data-testid="toast-host"
      className="pointer-events-none fixed bottom-4 right-4 z-[400] flex flex-col-reverse gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  );
};
