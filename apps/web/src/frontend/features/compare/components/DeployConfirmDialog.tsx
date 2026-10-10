import React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Play } from 'lucide-react';

interface Props {
  open: boolean;
  dialect: string;
  count: number;
  dontAskAgain: boolean;
  onToggleDontAsk: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Final "are you sure?" gate before a migration runs against the target. */
export const DeployConfirmDialog: React.FC<Props> = ({ open, dialect, count, dontAskAgain, onToggleDontAsk, onCancel, onConfirm }) => {
  if (!open) return null;
  return createPortal(
    <div
      data-testid="deploy-confirm-dialog"
      className="modal-overlay"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[440px] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/40 flex items-center gap-2.5">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
          <h2 className="text-slate-100 font-bold text-base">Execute sync script?</h2>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-sm text-slate-300 leading-relaxed">
            This runs the generated migration against the{' '}
            <span className="font-bold text-purple-300">target</span> database
            {' '}(<span className="font-mono text-xs">{dialect.toUpperCase()}</span>), applying{' '}
            <span className="font-bold text-slate-100">{count}</span> object change{count === 1 ? '' : 's'}.
            This cannot be undone automatically.
          </p>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input data-testid="deploy-dont-ask-again"
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => onToggleDontAsk(e.target.checked)}
              className="w-4 h-4 accent-cyan-500 cursor-pointer"
            />
            Don't show this again
          </label>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 bg-slate-950/60 border-t border-slate-800">
          <button
            data-testid="deploy-cancel-btn"
            onClick={onCancel}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-850/50 rounded transition"
          >
            Cancel
          </button>
          <button
            data-testid="deploy-confirm-btn"
            onClick={onConfirm}
            className="px-4 py-2 text-xs font-bold accent-grad on-accent-fg rounded transition shadow flex items-center gap-1.5"
          >
            <Play className="w-3.5 h-3.5 fill-current" /> Execute
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
