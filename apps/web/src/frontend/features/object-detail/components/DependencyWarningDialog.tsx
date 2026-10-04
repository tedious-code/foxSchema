import React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, FileText } from 'lucide-react';
import type { DropDependency } from '@foxschema/sql';

interface Props {
  deps: DropDependency[];
  syncSelection: Record<string, boolean>;
  toggleSyncSelection: (name: string) => void;
  onCancel: () => void;
}

/**
 * Pre-deploy warning shown when a selected drop (table/column) is still
 * referenced by a view/function/procedure in the target. Execute stays disabled
 * while this list is non-empty — there is no bypass. Resolve each entry either
 * by including the dependent in the deploy, or by deselecting the object that
 * drops the referenced column/table.
 */
export const DependencyWarningDialog: React.FC<Props> = ({ deps, syncSelection, toggleSyncSelection, onCancel }) => {
  if (deps.length === 0) return null;
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
          <h2 className="text-slate-100 font-bold text-base">Dependent objects may break</h2>
        </div>
        <div className="p-6 space-y-3 overflow-y-auto">
          <p className="text-sm text-slate-300 leading-relaxed">
            The following object{deps.length === 1 ? '' : 's'} in the{' '}
            <span className="font-bold text-purple-300">target</span> still reference something this
            migration drops. Dropping it may leave {deps.length === 1 ? 'it' : 'them'} invalid.
            Recommended: include the dependent in this deploy (recreates it from source) or update
            it in the target first.
          </p>
          <ul className="space-y-1.5">
            {deps.map((d) => (
              <li
                key={`${d.dependentType}-${d.dependentName}-${d.dropped}`}
                className="flex items-start gap-2.5 px-3 py-2 rounded-lg bg-slate-950/50 border border-slate-800 text-xs"
              >
                <FileText className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <span className="font-mono font-semibold text-slate-200">{d.dependentName}</span>
                  <span className="text-slate-600 ml-1.5 text-[10px] uppercase">{d.dependentType}</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {d.kind === 'column' ? 'uses column ' : 'references table '}
                    <span className="font-mono text-slate-300">{d.dropped}</span>
                  </p>
                </div>
                {d.deployable ? (
                  <button data-testid={`migrate-dependency-${d.dependentType}-${d.dependentName}`}
                    onClick={() => {
                      if (!syncSelection[d.dependentName]) toggleSyncSelection(d.dependentName);
                    }}
                    disabled={!!syncSelection[d.dependentName]}
                    className="shrink-0 text-[10px] font-semibold rounded px-2 py-1 transition disabled:opacity-50 disabled:cursor-default text-emerald-200 bg-emerald-950/50 border border-emerald-500/40 hover:bg-emerald-900/50"
                  >
                    {syncSelection[d.dependentName] ? 'Included' : 'Include in deploy'}
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-slate-500 italic max-w-[140px] text-right">
                    deselect the drop of {d.dropped} to resolve
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 bg-slate-950/60 border-t border-slate-800">
          <button data-testid="migrate-dependency-warning-close"
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
