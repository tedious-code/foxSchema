import React from 'react';
import { createPortal } from 'react-dom';
import { GitCompareArrows, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { CROSS_DIALECT_READINESS, type ReadinessLevel } from '@foxschema/ui-shared';

interface Props {
  open: boolean;
  sourceDialect: string;
  targetDialect: string;
  onClose: () => void;
}

const LEVEL_META: Record<ReadinessLevel, { label: string; icon: React.ReactNode; cls: string }> = {
  full: { label: 'Translated', icon: <CheckCircle2 className="w-3.5 h-3.5" />, cls: 'text-emerald-300 bg-emerald-950/40 border-emerald-500/30' },
  partial: { label: 'Partial', icon: <AlertTriangle className="w-3.5 h-3.5" />, cls: 'text-amber-300 bg-amber-950/40 border-amber-500/30' },
  none: { label: 'Not translated', icon: <XCircle className="w-3.5 h-3.5" />, cls: 'text-rose-300 bg-rose-950/40 border-rose-500/30' },
};

/**
 * Per-object-type breakdown of what actually survives a cross-dialect migration —
 * opened from the "Cross-dialect: X → Y" badge. Static/informational: shown before
 * the user commits to a deploy so gaps (Type, View, Check) are visible up front
 * instead of discovered as a runtime error or, worse, silently wrong DDL.
 */
export const CrossDialectReadinessDialog: React.FC<Props> = ({ open, sourceDialect, targetDialect, onClose }) => {
  if (!open) return null;
  return createPortal(
    <div
      className="modal-overlay"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-800 bg-amber-950/30 flex items-center gap-2.5">
          <GitCompareArrows className="w-5 h-5 text-amber-400 shrink-0" />
          <h2 className="text-slate-100 font-bold text-base">
            Cross-dialect readiness: {sourceDialect.toUpperCase()} → {targetDialect.toUpperCase()}
          </h2>
        </div>
        <div className="p-6 space-y-3 overflow-y-auto">
          <p className="text-sm text-slate-300 leading-relaxed">
            What actually gets translated when migrating between dialects, by object type. Objects marked{' '}
            <span className="text-rose-300 font-semibold">Not translated</span> are either skipped entirely or
            flagged for manual review in the generated SQL rather than auto-converted.
          </p>
          <ul className="space-y-1.5">
            {CROSS_DIALECT_READINESS.map((r) => {
              const meta = LEVEL_META[r.level];
              return (
                <li
                  key={r.objectType}
                  className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-slate-950/50 border border-slate-800 text-xs"
                >
                  <span className={`shrink-0 mt-0.5 flex items-center gap-1 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${meta.cls}`}>
                    {meta.icon}
                    {meta.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-mono font-semibold text-slate-200">{r.objectType}</span>
                    <p className="text-[11px] text-slate-400 mt-0.5">{r.note}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 bg-slate-950/60 border-t border-slate-800">
          <button data-testid="migrate-cross-dialect-readiness-close"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-850/50 rounded transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
