import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Play } from 'lucide-react';
import {
  checkStatement,
  dmlLacksWhere,
  isCodeCellKind,
  isMutatingDmlStatement,
  statementVerb,
  CODE_CELL_KIND_LABEL,
  type CodeCellKind,
  type SplitStatement,
} from '@/shared/lib/sql-splitter';
import { findVariableRefs, substituteVariables } from '@/shared/lib/sql-variables';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

interface Props {
  statements: SplitStatement[];
  checked: number[];
  /** True while this tab's execute is in flight — disables per-cell Play. */
  running?: boolean;
  /** When true, SQL cells need a Destination (code cells still run). */
  sqlNeedsDestination?: boolean;
  onToggle: (index: number) => void;
  onReveal: (stmt: SplitStatement) => void;
  /** Jupyter-style per-cell run (one statement index). */
  onRunCell?: (index: number) => void;
}

const STORAGE_KEY = 'foxschema-sql-statement-strip-h';
const ROW_PX = 34;
const PAD_PX = 14;
const MIN_ROWS = 1;
const MAX_ROWS = 12;
const DEFAULT_ROWS = 3;

const defaultHeight = () => ROW_PX * DEFAULT_ROWS + PAD_PX;
const minHeight = () => ROW_PX * MIN_ROWS + PAD_PX;
const maxHeight = () => ROW_PX * MAX_ROWS + PAD_PX;

function loadHeight(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(n) && n >= minHeight()) {
      return Math.min(maxHeight(), n);
    }
  } catch {
    /* ignore */
  }
  return defaultHeight();
}

const preview = (text: string, max = 120, codeKind?: CodeCellKind | null): string => {
  let source = text;
  if (codeKind) {
    // Drop fence markers so the strip shows the cell body, not `-- @node` / `-- @end`.
    source = source
      .replace(/^\s*--\s*@(?:js|ts|javascript|typescript|node|nodets|node-typescript)\b[^\n]*\n?/i, '')
      .replace(/\n?\s*--\s*@end\s*$/i, '');
  }
  const compact = source.replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max) + '…' : compact || text.replace(/\s+/g, ' ').trim();
};

const codeCellBadge = (kind: CodeCellKind) => ({
  label: CODE_CELL_KIND_LABEL[kind].short,
  title: `${CODE_CELL_KIND_LABEL[kind].long} code cell (-- @${kind} … -- @end)`,
});

const DML_BADGE: Record<string, string> = {
  update: 'UPD',
  delete: 'DEL',
  merge: 'MRG',
};

function resolveSql(
  stmtText: string,
  variables: ReturnType<typeof useSqlEditorStore.getState>['variables']
): { sql: string; error?: string; hasVars: boolean } {
  const hasVars = findVariableRefs(stmtText).length > 0;
  if (!hasVars) return { sql: stmtText, hasVars: false };
  const expanded = substituteVariables(stmtText, variables, { maskSecrets: true });
  if (!expanded.ok) return { sql: stmtText, error: expanded.error, hasVars: true };
  return { sql: expanded.sql, hasVars: true };
}

type PopoverState = {
  index: number;
  top: number;
  left: number;
  width: number;
  sql: string;
  error?: string;
  hasVars: boolean;
};

/**
 * Notebook-style statement strip (Jupyter-inspired): each row is a cell with
 * In [n], kind badge, preview, and a per-cell Play — same splitter/run pipeline
 * as the toolbar Run.
 */
/** Everything a row shows about its statement, from its text alone. */
function analyse(
  stmt: SplitStatement,
  last: boolean,
  safeMode: boolean,
  variables: ReturnType<typeof useSqlEditorStore.getState>['variables']
) {
  const status = checkStatement(stmt, { last });
  const codeKind = isCodeCellKind(stmt.kind) ? stmt.kind : null;
  const codeBadge = codeKind ? codeCellBadge(codeKind) : null;
  const verb = codeKind ? null : statementVerb(stmt.text);
  const dmlBadge = safeMode && verb && isMutatingDmlStatement(stmt.text) ? DML_BADGE[verb] : null;
  const noWhere = dmlBadge ? dmlLacksWhere(stmt.text) : false;
  const resolved = resolveSql(stmt.text, variables);
  return { status, codeKind, codeBadge, dmlBadge, noWhere, resolved };
}

export const StatementStrip: React.FC<Props> = ({
  statements,
  checked,
  running = false,
  sqlNeedsDestination = false,
  onToggle,
  onReveal,
  onRunCell,
}) => {
  const [height, setHeight] = useState(loadHeight);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const variables = useSqlEditorStore((s) => s.variables);
  // What each row shows about its statement, by statement text. A keystroke
  // changes one statement, so the rest are not checked and resolved again:
  // re-analysing every statement per keystroke was 17 ms at 1,700 of them.
  // Holds only the statements of the last render, and starts over when the
  // variables or Safe mode, which every answer reads, change.
  const analysisCache = useRef<{
    variables: typeof variables;
    safeMode: boolean;
    byText: Map<string, ReturnType<typeof analyse>>;
  } | null>(null);
  const previous =
    analysisCache.current?.variables === variables && analysisCache.current.safeMode === safeMode
      ? analysisCache.current.byText
      : new Map<string, ReturnType<typeof analyse>>();
  const byText = new Map<string, ReturnType<typeof analyse>>();
  const analyses = statements.map((stmt, i) => {
    const last = i === statements.length - 1;
    const key = `${last ? 1 : 0}|${stmt.kind ?? ''}|${stmt.text}`;
    const found = byText.get(key) ?? previous.get(key) ?? analyse(stmt, last, safeMode, variables);
    byText.set(key, found);
    return found;
  });
  analysisCache.current = { variables, safeMode, byText };
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(height));
    } catch {
      /* ignore */
    }
  }, [height]);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const clearHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const scheduleHide = () => {
    clearHide();
    // Long delay so the pointer can move into the overlapping popover / click Copy.
    hideTimer.current = setTimeout(() => {
      setPopover(null);
    }, 500);
  };

  const openPopover = (index: number, el: HTMLElement, stmtText: string) => {
    clearHide();
    const rect = el.getBoundingClientRect();
    const resolved = resolveSql(stmtText, variables);
    const width = Math.min(520, Math.max(280, rect.width));
    let left = rect.left;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    // Overlap the row by a few px so there is no gap that dismisses the popover.
    let top = rect.bottom - 4;
    const approxH = 140;
    if (top + approxH > window.innerHeight - 8) {
      top = Math.max(8, rect.top - approxH + 4);
    }
    setPopover({
      index,
      top,
      left,
      width,
      sql: resolved.sql,
      error: resolved.error,
      hasVars: resolved.hasVars,
    });
  };

  const copyText = async (index: number, text: string, hasError?: boolean) => {
    if (hasError || !text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex((cur) => (cur === index ? null : cur)), 1500);
    } catch {
      /* ignore */
    }
  };

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = height;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(maxHeight(), Math.max(minHeight(), startH + (ev.clientY - startY)));
        setHeight(next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [height]
  );

  if (statements.length === 0) return null;

  return (
    <div className="shrink-0 flex flex-col border-b border-slate-800 bg-slate-950" data-testid="sql-statement-strip">
      <div className="px-2 py-1.5 flex flex-col gap-1 overflow-y-auto" style={{ height }}>
        {statements.map((stmt, i) => {
          const { status, codeKind, codeBadge, dmlBadge, noWhere, resolved } = analyses[i]!;
          const ok = status.level === 'ok';
          const isChecked = checked.includes(i);
          const playBlocked = sqlNeedsDestination && !codeKind;
          const isCopied = copiedIndex === i;
          const accent = codeKind
            ? 'border-l-teal-400/80 bg-teal-950/20'
            : 'border-l-sky-400/80 bg-sky-950/15';
          return (
            <div
              key={`${stmt.start}-${stmt.end}`}
              data-testid={`sql-statement-cell-${i}`}
              className={`flex items-start gap-1.5 text-[13px] font-semibold text-slate-300 rounded-r-md border-l-[3px] ${accent} hover:bg-slate-800/50 px-1.5 py-1 group min-h-[2rem]`}
            >
              <button
                type="button"
                data-testid={`sql-statement-run-${i}`}
                title={
                  playBlocked
                    ? 'Check a Destination server to run SQL cells'
                    : `Run cell ${i + 1}`
                }
                disabled={running || !onRunCell || playBlocked}
                onClick={(e) => {
                  e.stopPropagation();
                  onRunCell?.(i);
                }}
                className="shrink-0 mt-0.5 p-1 rounded-md text-slate-400 hover:text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40 disabled:cursor-not-allowed transition"
                aria-label={`Run cell ${i + 1}`}
              >
                <Play className="w-3.5 h-3.5 fill-current" strokeWidth={SQL_ICON_STROKE} />
              </button>
              <input data-testid={`sql-statement-include-${i}`}
                type="checkbox"
                checked={isChecked}
                onChange={() => onToggle(i)}
                className="w-3.5 h-3.5 accent-cyan-600 cursor-pointer shrink-0 mt-1.5"
                title={
                  checked.length === 0
                    ? 'None checked → toolbar Run uses the first cell'
                    : 'Include this cell in toolbar Run'
                }
                aria-label={`Include cell ${i + 1} in batch Run`}
              />
              <button data-testid={`sql-statement-reveal-${i}`}
                type="button"
                onClick={() => onReveal(stmt)}
                onMouseEnter={(e) => {
                  if (!resolved.hasVars) return;
                  openPopover(i, e.currentTarget, stmt.text);
                }}
                onMouseLeave={() => {
                  if (!resolved.hasVars) return;
                  scheduleHide();
                }}
                className="flex-1 flex items-start gap-1.5 min-w-0 text-left cursor-pointer"
              >
                <span
                  className="text-slate-500 font-mono shrink-0 font-bold tabular-nums"
                  title="Cell input index (notebook-style)"
                >
                  In&nbsp;[{i + 1}]:
                </span>
                <span
                  className={`shrink-0 font-bold ${ok ? 'text-emerald-400' : 'text-amber-400'}`}
                  title={ok ? 'Looks complete' : status.reasons.join(' · ')}
                >
                  {ok ? '✓' : '⚠'}
                </span>
                {codeBadge ? (
                  <span
                    className="shrink-0 text-[10px] font-bold uppercase tracking-wide px-1 py-0.5 rounded mt-0.5 bg-teal-950/50 text-teal-300 border border-teal-500/35"
                    title={codeBadge.title}
                  >
                    {codeBadge.label}
                  </span>
                ) : (
                  <span
                    className="shrink-0 text-[10px] font-bold uppercase tracking-wide px-1 py-0.5 rounded mt-0.5 bg-sky-950/40 text-sky-300 border border-sky-500/35"
                    title="SQL statement"
                  >
                    SQL
                  </span>
                )}
                {dmlBadge && (
                  <span
                    className={`shrink-0 text-[10px] font-bold uppercase tracking-wide px-1 py-0.5 rounded mt-0.5 ${
                      noWhere
                        ? 'bg-rose-950/50 text-rose-300 border border-rose-500/40'
                        : 'bg-amber-950/40 text-amber-300 border border-amber-500/35'
                    }`}
                    title={
                      noWhere
                        ? `${dmlBadge}: no WHERE — may affect all rows`
                        : `Safe mode: ${dmlBadge} requires confirmation on Run`
                    }
                  >
                    {dmlBadge}
                    {noWhere ? '!' : ''}
                  </span>
                )}
                <span className="font-mono text-slate-400 group-hover:text-slate-200 line-clamp-2 break-all font-medium">
                  {preview(stmt.text, 120, codeKind)}
                </span>
              </button>
              <button
                type="button"
                data-testid={`sql-statement-copy-row-${i}`}
                title={
                  resolved.error
                    ? resolved.error
                    : resolved.hasVars
                      ? 'Copy query with values'
                      : 'Copy query'
                }
                disabled={Boolean(resolved.error)}
                onClick={(e) => {
                  e.stopPropagation();
                  void copyText(i, resolved.sql, Boolean(resolved.error));
                }}
                className="shrink-0 mt-0.5 p-0.5 text-slate-500 hover:text-cyan-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition disabled:opacity-30"
                aria-label={`Copy cell ${i + 1}`}
              >
                {isCopied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={SQL_ICON_STROKE} />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-cyan-400" strokeWidth={SQL_ICON_STROKE} />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize statement list"
        data-testid="sql-statement-strip-resize"
        title="Drag to resize statement list"
        onMouseDown={startResize}
        className="h-1.5 shrink-0 cursor-row-resize bg-slate-800 hover:bg-cyan-500/40 active:bg-cyan-500/50 transition-colors"
      />

      {popover &&
        createPortal(
          <div
            data-testid="sql-statement-values-popover"
            className="fixed z-[80] rounded-md border border-slate-700 bg-slate-900 shadow-xl p-2.5"
            style={{ top: popover.top, left: popover.left, width: popover.width }}
            onMouseEnter={clearHide}
            onMouseLeave={scheduleHide}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {popover.hasVars ? 'Query with values' : 'Query'}
              </span>
              <button
                type="button"
                data-testid="sql-statement-copy"
                disabled={Boolean(popover.error)}
                onClick={(e) => {
                  e.stopPropagation();
                  void copyText(popover.index, popover.sql, Boolean(popover.error));
                }}
                className="flex items-center gap-1 text-[10px] font-semibold text-slate-400 hover:text-cyan-300 transition disabled:opacity-40"
              >
                {copiedIndex === popover.index ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" strokeWidth={SQL_ICON_STROKE} /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 text-cyan-400" strokeWidth={SQL_ICON_STROKE} /> Copy
                  </>
                )}
              </button>
            </div>
            {popover.error ? (
              <p className="text-[11px] text-rose-400 font-mono break-all">{popover.error}</p>
            ) : (
              <pre className="text-[11px] font-mono text-cyan-300/95 whitespace-pre-wrap break-all max-h-40 overflow-y-auto m-0 leading-snug">
                {popover.sql}
              </pre>
            )}
          </div>,
          document.body
        )}
    </div>
  );
};
