import React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, FileText } from 'lucide-react';
import type { ValidationIssue } from '@/shared/lib/migration-validation';

interface Props {
  title: string;
  description: string;
  issues: ValidationIssue[];
  onCancel: () => void;
}

/**
 * Read-only pre-flight warning list — missing FK targets, narrowing type changes,
 * or generator "-- review:" / "MANUAL REVIEW REQUIRED" notices. Unlike
 * DependencyWarningDialog, there's no per-item fix action here: resolution means
 * adjusting the selection or acknowledging the risk via the banner checkbox.
 */
export const ValidationWarningsDialog: React.FC<Props> = ({ title, description, issues, onCancel }) => {
  if (issues.length === 0) return null;
  return createPortal(
    <div
      className="modal-overlay"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[520px] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-800 bg-amber-950/30 flex items-center gap-2.5">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
          <h2 className="text-slate-100 font-bold text-base">{title}</h2>
        </div>
        <div className="p-6 space-y-3 overflow-y-auto">
          <p className="text-sm text-slate-300 leading-relaxed">{description}</p>
          <ul className="space-y-1.5">
            {issues.map((issue, i) => (
              <li
                key={`${issue.code}-${issue.tableName}-${i}`}
                className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-slate-950/50 border border-slate-800 text-xs"
              >
                <FileText className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <span className="font-mono font-semibold text-slate-200">{issue.tableName}</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">{issue.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 bg-slate-950/60 border-t border-slate-800">
          <button data-testid="migrate-validation-warnings-close"
            onClick={onCancel}
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
