/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Run checkbox and per-cell play, one row per statement, sitting on the left
 * of the editor so the statement list does not take a band of vertical space.
 */
import React, { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { isCodeCellKind, type SplitStatement } from '@/shared/lib/sql-splitter';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

const FALLBACK_LINE_PX = 20;
const EDITOR_PAD_PX = 8;

/** Enough of Monaco to line a checkbox up with a statement's first line. */
export interface GutterEditor {
  getTopForLineNumber: (line: number) => number;
  getScrollTop: () => number;
  getLayoutInfo?: () => { height: number };
  onDidScrollChange: (listener: () => void) => { dispose: () => void };
  onDidContentSizeChange: (listener: () => void) => { dispose: () => void };
  onDidLayoutChange: (listener: () => void) => { dispose: () => void };
}

function fallbackTops(statements: SplitStatement[]): number[] {
  return statements.map((stmt) => (stmt.startLine - 1) * FALLBACK_LINE_PX + EDITOR_PAD_PX);
}

function topsFor(editor: GutterEditor, statements: SplitStatement[]): number[] {
  const scroll = editor.getScrollTop();
  const viewH = editor.getLayoutInfo?.().height ?? 0;
  if (!viewH) return fallbackTops(statements);
  const lineH = editor.getTopForLineNumber(2) - editor.getTopForLineNumber(1);
  const rowH = lineH > 0 ? lineH : FALLBACK_LINE_PX;
  return statements.map((stmt) => {
    const y = editor.getTopForLineNumber(stmt.startLine) - scroll;
    if (y < -rowH || y > viewH) return Number.NaN;
    return y + Math.max(0, (rowH - 16) / 2);
  });
}

interface Props {
  statements: SplitStatement[];
  checked: number[];
  editorRef: React.RefObject<GutterEditor | null>;
  /** Bumped when Monaco finishes mounting, so the rail can attach to it. */
  editorEpoch: number;
  running?: boolean;
  sqlNeedsDestination?: boolean;
  onToggle: (index: number) => void;
  onRunCell?: (index: number) => void;
}

export const StatementRunGutter: React.FC<Props> = ({
  statements,
  checked,
  editorRef,
  editorEpoch,
  running = false,
  sqlNeedsDestination = false,
  onToggle,
  onRunCell,
}) => {
  const [tops, setTops] = useState<number[]>(() => fallbackTops(statements));

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
        setTops(topsFor(editor, statements));
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

  return (
    <div
      className="relative w-11 shrink-0 overflow-hidden border-r border-slate-800 bg-slate-950"
      data-testid="sql-statement-gutter"
      aria-label="Statement run checks"
    >
      {statements.map((stmt, i) => {
        const top = tops[i];
        if (top == null || Number.isNaN(top)) return null;
        const isChecked = checked.includes(i);
        const playBlocked = sqlNeedsDestination && !isCodeCellKind(stmt.kind);
        return (
          <div
            key={`${stmt.start}-${stmt.end}`}
            className="absolute left-0 flex h-4 w-full items-center justify-center gap-0.5"
            style={{ top }}
          >
            <button
              type="button"
              data-testid={`sql-statement-run-${i}`}
              title={playBlocked ? 'Check a Destination server to run SQL cells' : `Run cell ${i + 1}`}
              disabled={running || !onRunCell || playBlocked}
              onClick={(e) => {
                e.stopPropagation();
                onRunCell?.(i);
              }}
              className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-cyan-500/15 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={`Run cell ${i + 1}`}
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
                  : 'Include this cell in toolbar Run'
              }
              aria-label={`Include cell ${i + 1} in batch Run`}
            />
          </div>
        );
      })}
    </div>
  );
};
