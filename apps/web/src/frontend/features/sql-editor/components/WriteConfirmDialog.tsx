import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Play, Info, ShieldAlert } from 'lucide-react';
import type { ReadonlyWriteTarget } from '@/app/store/useSqlEditorStore';
import {
  dmlLacksWhere,
  isMutatingDmlStatement,
  statementVerb,
} from '@/shared/lib/sql-splitter';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export type MultiTableWarn = {
  text: string;
  tableCount: number;
  tables: string[];
};

interface Props {
  writeStatements: string[];
  credentialCount: number;
  /** sqlite / clickhouse targets that cannot execute writes. */
  readonlyTargets?: ReadonlyWriteTarget[];
  /** Statements that touch many tables (writes only; SELECT/JOIN reads skip). */
  multiTableStatements?: MultiTableWarn[];
  /**
   * When true (default), UPDATE/DELETE without WHERE require an explicit
   * checkbox acknowledgment before Run.
   */
  requireMissingWhereAck?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const DML_LABEL: Record<string, string> = {
  update: 'UPDATE',
  delete: 'DELETE',
  merge: 'MERGE',
};

/**
 * Safe-mode confirmation before writes / large multi-table *writes*.
 * Read-only SELECT / JOIN queries never reach this dialog.
 * Flags UPDATE/DELETE with no WHERE and asks for acknowledgment.
 */
export const WriteConfirmDialog: React.FC<Props> = ({
  writeStatements,
  credentialCount,
  readonlyTargets = [],
  multiTableStatements = [],
  requireMissingWhereAck = true,
  onCancel,
  onConfirm,
}) => {
  const mutating = useMemo(
    () => writeStatements.filter((s) => isMutatingDmlStatement(s)),
    [writeStatements]
  );
  const missingWhere = useMemo(
    () => mutating.filter((s) => dmlLacksWhere(s)),
    [mutating]
  );
  const verbs = useMemo(() => {
    const set = new Set<string>();
    for (const s of mutating) {
      const v = statementVerb(s);
      if (v && DML_LABEL[v]) set.add(DML_LABEL[v]);
    }
    return [...set];
  }, [mutating]);

  const [ackedMissingWhere, setAckedMissingWhere] = useState(false);
  const needsWhereAck = requireMissingWhereAck && missingWhere.length > 0;
  const canConfirm = !needsWhereAck || ackedMissingWhere;

  const title =
    writeStatements.length === 0 && multiTableStatements.length > 0
      ? 'Safe mode: multi-table query'
      : mutating.length > 0
        ? `Safe mode: run ${verbs.join(' / ') || 'mutating'} statements?`
        : writeStatements.length > 0
          ? 'Run write statements?'
          : 'Confirm run?';

  return createPortal(
    <div
      data-testid="sql-write-confirm"
      className="modal-overlay"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[520px] bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/40 flex items-center gap-2.5">
          <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0" strokeWidth={SQL_ICON_STROKE} />
          <h2 className="text-slate-100 font-bold text-base">{title}</h2>
        </div>
        <div className="p-6 space-y-3">
          {mutating.length > 0 && (
            <div
              data-testid="sql-safe-dml-warn"
              className="flex items-start gap-2 text-xs text-rose-100/90 bg-rose-950/50 border border-rose-500/30 rounded-md px-3 py-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" strokeWidth={SQL_ICON_STROKE} />
              <div>
                <p className="font-semibold text-rose-300 mb-0.5">
                  {mutating.length} UPDATE / DELETE / MERGE statement
                  {mutating.length === 1 ? '' : 's'} will modify data
                </p>
                <p className="text-rose-200/80 leading-relaxed">
                  These run against{' '}
                  <span className="font-bold text-rose-100">{credentialCount}</span> database
                  {credentialCount === 1 ? '' : 's'}. Changes are not rolled back automatically.
                </p>
              </div>
            </div>
          )}

          {missingWhere.length > 0 && (
            <div
              data-testid="sql-safe-no-where-warn"
              className="flex items-start gap-2 text-xs text-amber-100/90 bg-amber-950/50 border border-amber-500/35 rounded-md px-3 py-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" strokeWidth={SQL_ICON_STROKE} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-amber-300 mb-0.5">
                  Missing WHERE — {missingWhere.length} statement
                  {missingWhere.length === 1 ? '' : 's'}
                </p>
                <p className="text-amber-200/80 leading-relaxed mb-2">
                  UPDATE or DELETE with no WHERE can affect every row in the table. Add a WHERE
                  filter unless that is intentional.
                </p>
                {needsWhereAck && (
                  <label
                    data-testid="sql-safe-no-where-ack"
                    className="flex items-start gap-2 cursor-pointer select-none"
                  >
                    <input data-testid="sql-safe-no-where-ack-check"
                      type="checkbox"
                      checked={ackedMissingWhere}
                      onChange={(e) => setAckedMissingWhere(e.target.checked)}
                      className="mt-0.5 accent-amber-500"
                    />
                    <span className="text-amber-100 font-semibold">
                      I understand this can update or delete all rows without a WHERE clause
                    </span>
                  </label>
                )}
              </div>
            </div>
          )}

          {multiTableStatements.length > 0 && (
            <div
              data-testid="sql-safe-multi-table-warn"
              className="flex items-start gap-2 text-xs text-sky-100/90 bg-sky-950/40 border border-sky-500/30 rounded-md px-3 py-2"
            >
              <Info className="w-4 h-4 shrink-0 mt-0.5 text-sky-400" strokeWidth={SQL_ICON_STROKE} />
              <div>
                <p className="font-semibold text-sky-300 mb-0.5">
                  Multi-table query — consider a transaction
                </p>
                <p className="text-sky-200/80 leading-relaxed">
                  {multiTableStatements.length} statement
                  {multiTableStatements.length === 1 ? '' : 's'} reference{' '}
                  {multiTableStatements[0]!.tableCount}+ tables
                  {multiTableStatements[0]?.tables?.length
                    ? ` (${multiTableStatements
                        .flatMap((s) => s.tables)
                        .filter((t, i, a) => a.indexOf(t) === i)
                        .slice(0, 6)
                        .join(', ')})`
                    : ''}
                  . Wrap related writes in BEGIN/COMMIT so a failure does not leave partial
                  changes.
                </p>
              </div>
            </div>
          )}

          {mutating.length === 0 && writeStatements.length > 0 && (
            <p className="text-sm text-slate-300 leading-relaxed">
              This run includes{' '}
              <span className="font-bold text-amber-300">{writeStatements.length}</span> statement
              {writeStatements.length === 1 ? '' : 's'} that modif
              {writeStatements.length === 1 ? 'ies' : 'y'} data or schema, executing against{' '}
              <span className="font-bold text-slate-100">{credentialCount}</span> database
              {credentialCount === 1 ? '' : 's'}.
            </p>
          )}

          {readonlyTargets.length > 0 && (
            <div
              data-testid="sql-readonly-write-warn"
              className="flex items-start gap-2 text-xs text-amber-200/90 bg-amber-950/40 border border-amber-500/25 rounded-md px-3 py-2"
            >
              <Info className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" strokeWidth={SQL_ICON_STROKE} />
              <div>
                <p className="font-semibold text-amber-300 mb-0.5">
                  Read-only adapters will reject these writes
                </p>
                <p className="text-amber-200/80 leading-relaxed">
                  {readonlyTargets.map((t) => `${t.name} [${t.dialect}]`).join(', ')} — only
                  SELECT runs on these connections in FoxSchema. Those cells will show a friendly
                  error; the other connections still run the writes.
                </p>
              </div>
            </div>
          )}

          {writeStatements.length > 0 && (
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg max-h-40 overflow-y-auto divide-y divide-slate-850">
              {writeStatements.map((s, i) => {
                const verb = statementVerb(s);
                const isDml = verb !== null && Boolean(DML_LABEL[verb]);
                const noWhere = dmlLacksWhere(s);
                return (
                  <div
                    key={i}
                    className="px-3 py-1.5 text-xs font-mono flex items-start gap-2"
                    title={s}
                  >
                    {isDml && (
                      <span
                        className={`shrink-0 text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded ${
                          noWhere
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {DML_LABEL[verb!]}
                        {noWhere ? ' · no WHERE' : ''}
                      </span>
                    )}
                    <span className="text-slate-400 truncate min-w-0">{s.replace(/\s+/g, ' ')}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 bg-slate-950/60 border-t border-slate-800">
          <button data-testid="sql-write-confirm-cancel"
            onClick={onCancel}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-850/50 rounded transition"
          >
            Cancel
          </button>
          <button
            data-testid="sql-write-confirm-btn"
            disabled={!canConfirm}
            onClick={onConfirm}
            className="px-4 py-2 text-xs font-bold bg-gradient-to-r from-rose-600 to-orange-600 hover:from-rose-500 hover:to-orange-500 on-accent-fg rounded transition shadow flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play className="w-3.5 h-3.5 fill-current text-emerald-50" strokeWidth={SQL_ICON_STROKE} />{' '}
            Run anyway
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
