/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The run rail: one row per statement on the left of the editor — its In [n]
 * number, per-cell play, and the include checkbox — so the statement list no
 * longer takes a band of vertical space.
 *
 * The number carries what the old statement strip showed about each cell: it
 * turns amber for a write Safe mode will confirm and red with `!` for one with
 * no WHERE, its tooltip names the cell's kind, and a click selects the
 * statement. The copy button (shown on hover) copies it with its values.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Play } from 'lucide-react';
import { isCodeCellKind, type SplitStatement } from '@/shared/lib/sql-splitter';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { statementBadge, statementTitle, type StatementBadge } from '../lib/statementBadges';

const FALLBACK_LINE_PX = 20;
const EDITOR_PAD_PX = 8;
/** Height of one row of controls (`h-4`). */
const ROW_PX = 16;

/** Enough of Monaco to line a row up with a statement's first line. */
export interface GutterEditor {
  getTopForLineNumber: (line: number) => number;
  getScrollTop: () => number;
  getLayoutInfo?: () => { height: number };
  onDidScrollChange: (listener: () => void) => { dispose: () => void };
  onDidContentSizeChange: (listener: () => void) => { dispose: () => void };
  onDidLayoutChange: (listener: () => void) => { dispose: () => void };
}

/**
 * Never let two rows overlap. Statements that start on the same line
 * (`SELECT 1; SELECT 2;`), or inside a folded region, map to the same y; drawn
 * there, the later row covers the earlier one and its controls cannot be
 * reached. Each row goes at its line or just below the row before, and the
 * In [n] number says which statement it is.
 */
function stack(tops: number[], viewH: number): number[] {
  let floor = 0;
  return tops.map((top) => {
    if (Number.isNaN(top)) return top;
    const y = Math.max(top, floor);
    if (viewH > 0 && y > viewH - ROW_PX / 2) return Number.NaN;
    floor = y + ROW_PX;
    return y;
  });
}

function fallbackTops(statements: SplitStatement[]): number[] {
  return stack(
    statements.map((stmt) => (stmt.startLine - 1) * FALLBACK_LINE_PX + EDITOR_PAD_PX),
    0
  );
}

export function rowTops(editor: GutterEditor, statements: SplitStatement[]): number[] {
  const viewH = editor.getLayoutInfo?.().height ?? 0;
  if (!viewH) return fallbackTops(statements);
  const scroll = editor.getScrollTop();
  const lineH = editor.getTopForLineNumber(2) - editor.getTopForLineNumber(1);
  const rowH = lineH > 0 ? lineH : FALLBACK_LINE_PX;
  const center = Math.max(0, (rowH - ROW_PX) / 2);
  return stack(
    statements.map((stmt) => {
      const top = editor.getTopForLineNumber(stmt.startLine) - scroll;
      const bottom = editor.getTopForLineNumber(stmt.endLine) + rowH - scroll;
      if (bottom <= 0 || top > viewH) return Number.NaN;
      // First line scrolled above the editor while the rest is on screen: keep
      // the row at the top, or a long statement cannot be run while reading it.
      return Math.max(top, 0) + center;
    }),
    viewH
  );
}

interface Props {
  statements: SplitStatement[];
  checked: number[];
  editorRef: React.RefObject<GutterEditor | null>;
  /** Bumped when Monaco finishes mounting, so the rail can attach to it. */
  editorEpoch: number;
  running?: boolean;
  sqlNeedsDestination?: boolean;
  /** Safe mode marks the writes it will ask to confirm. */
  safeMode?: boolean;
  onToggle: (index: number) => void;
  onRunCell?: (index: number) => void;
  /** Select a statement in the editor (the number was clicked). */
  onReveal?: (stmt: SplitStatement) => void;
  /** The statement with its variables filled in (secrets masked), for the copy button. */
  copyTextFor?: (stmt: SplitStatement) => { sql: string; error?: string; hasVars: boolean };
}

function labelTone(badge: StatementBadge): string {
  if (badge.dml?.noWhere) return 'text-rose-300 font-bold';
  if (badge.dml) return 'text-amber-300 font-bold';
  if (badge.codeKind) return 'text-violet-300/80';
  return 'text-slate-500';
}

export const StatementRunGutter: React.FC<Props> = ({
  statements,
  checked,
  editorRef,
  editorEpoch,
  running = false,
  sqlNeedsDestination = false,
  safeMode = false,
  onToggle,
  onRunCell,
  onReveal,
  copyTextFor,
}) => {
  const [copied, setCopied] = useState<number | null>(null);
  const [tops, setTops] = useState<number[]>(() => fallbackTops(statements));
  // Badges by statement text, so a keystroke re-reads only the statement it
  // changed — the strip measured 17 ms per keystroke at 1,700 statements when
  // it re-read them all. Keeps only what the last render showed.
  const badgeCache = useRef(new Map<string, StatementBadge>());

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      setTops(fallbackTops(statements));
      return;
    }
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTops(rowTops(editor, statements));
      });
    };
    refresh();
    const subs = [
      editor.onDidScrollChange(refresh),
      editor.onDidContentSizeChange(refresh),
      editor.onDidLayoutChange(refresh),
    ];
    return () => {
      if (frame) cancelAnimationFrame(frame);
      subs.forEach((sub) => sub.dispose());
    };
  }, [editorRef, editorEpoch, statements]);

  const shown = new Map<string, StatementBadge>();
  const badgeOf = (stmt: SplitStatement): StatementBadge => {
    const key = `${safeMode ? 1 : 0}|${stmt.kind}|${stmt.text}`;
    const found = shown.get(key) ?? badgeCache.current.get(key) ?? statementBadge(stmt, safeMode);
    shown.set(key, found);
    return found;
  };

  const copy = async (i: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      window.setTimeout(() => setCopied((cur) => (cur === i ? null : cur)), 1500);
    } catch {
      // No clipboard (insecure origin, denied): nothing to show but the icon.
    }
  };

  const rows = statements.map((stmt, i) => {
    const top = tops[i];
    if (top == null || Number.isNaN(top)) return null;
    const badge = badgeOf(stmt);
    const title = statementTitle(i, badge);
    const isChecked = checked.includes(i);
    const playBlocked = sqlNeedsDestination && !isCodeCellKind(stmt.kind);
    const copyText = copyTextFor?.(stmt);
    return (
      <div
        key={`${stmt.start}-${stmt.end}`}
        className="group absolute left-0 flex h-4 w-full items-center justify-end gap-0.5 pr-1"
        style={{ top }}
      >
        {copyText ? (
          <button
            type="button"
            data-testid={`sql-statement-copy-${i}`}
            title={copyText.error ?? (copyText.hasVars ? 'Copy with values' : 'Copy statement')}
            aria-label={`Copy In [${i + 1}]${copyText.hasVars ? ' with values' : ''}`}
            disabled={Boolean(copyText.error)}
            onClick={() => void copy(i, copyText.sql)}
            className="shrink-0 rounded p-0.5 text-slate-500 opacity-0 hover:text-cyan-300 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
          >
            {copied === i ? (
              <Check className="h-3 w-3 text-emerald-400" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <Copy className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          data-testid={`sql-statement-label-${i}`}
          data-dml={badge.dml ? `${badge.dml.badge}${badge.dml.noWhere ? '!' : ''}` : undefined}
          title={title}
          aria-label={title}
          onClick={() => onReveal?.(stmt)}
          className={`min-w-[1.1rem] rounded px-0.5 text-right font-mono text-[10px] leading-4 hover:bg-slate-800 hover:text-slate-100 ${labelTone(badge)}`}
        >
          {i + 1}
          {badge.dml?.noWhere ? '!' : ''}
        </button>
        <button
          type="button"
          data-testid={`sql-statement-run-${i}`}
          title={playBlocked ? 'Check a Destination server to run SQL cells' : `Run In [${i + 1}]`}
          disabled={running || !onRunCell || playBlocked}
          onClick={(e) => {
            e.stopPropagation();
            onRunCell?.(i);
          }}
          className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-cyan-500/15 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Run In [${i + 1}]`}
        >
          <Play className="h-3 w-3 fill-current" strokeWidth={SQL_ICON_STROKE} />
        </button>
        <input
          data-testid={`sql-statement-include-${i}`}
          type="checkbox"
          checked={isChecked}
          onChange={() => onToggle(i)}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-cyan-600"
          title={
            checked.length === 0
              ? 'None checked → toolbar Run uses the cell at the caret'
              : `Include In [${i + 1}] in toolbar Run`
          }
          aria-label={`Include In [${i + 1}] in batch Run`}
        />
      </div>
    );
  });
  badgeCache.current = shown;

  return (
    <div
      className="relative w-[4.75rem] shrink-0 overflow-hidden border-r border-slate-800 bg-slate-950"
      data-testid="sql-statement-gutter"
      aria-label="Statement run checks"
    >
      {rows}
    </div>
  );
};
