/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The run rail. What it must still say about each statement now that the
 * statement strip is gone — its number, and Safe mode's warning on a write
 * with no WHERE — and that every row stays reachable: two statements on one
 * line, and a long one whose first line has scrolled away.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { splitSqlStatements, statementVerb } from '@/shared/lib/sql-splitter';
import { rowTops, StatementRunGutter, type GutterEditor } from './StatementRunGutter';

// Watched, not replaced: counts how many statements the rail reads.
vi.mock('@/shared/lib/sql-splitter', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/lib/sql-splitter')>();
  return { ...real, statementVerb: vi.fn(real.statementVerb) };
});

/** An editor whose line `n` starts at `(n - 1) * 20 + pad`, scrolled to `scroll`. */
function editorDouble({ height = 400, scroll = 0, pad = 0 } = {}): GutterEditor {
  return {
    getTopForLineNumber: (line: number) => (line - 1) * 20 + pad,
    getScrollTop: () => scroll,
    getLayoutInfo: () => ({ height }),
    onDidScrollChange: () => ({ dispose: () => {} }),
    onDidContentSizeChange: () => ({ dispose: () => {} }),
    onDidLayoutChange: () => ({ dispose: () => {} }),
  };
}

function rail(sql: string, props: Partial<React.ComponentProps<typeof StatementRunGutter>> = {}) {
  return (
    <StatementRunGutter
      statements={splitSqlStatements(sql)}
      checked={[]}
      editorRef={{ current: editorDouble() }}
      editorEpoch={1}
      onToggle={() => {}}
      {...props}
    />
  );
}

const topOf = (testId: string) => Number.parseFloat((screen.getByTestId(testId).parentElement as HTMLElement).style.top);

describe('StatementRunGutter', () => {
  it('places a run checkbox on each statement and toggles the one that was clicked', () => {
    const onToggle = vi.fn();
    render(rail('SELECT 1;\nSELECT 2;', { checked: [1], onToggle }));
    const first = screen.getByTestId('sql-statement-include-0') as HTMLInputElement;
    const second = screen.getByTestId('sql-statement-include-1') as HTMLInputElement;
    expect(first.checked).toBe(false);
    expect(second.checked).toBe(true);
    fireEvent.click(first);
    expect(onToggle).toHaveBeenCalledWith(0);
  });

  it('hides a statement that is scrolled out of the editor', async () => {
    render(rail('SELECT 1;\nSELECT 2;', { editorRef: { current: editorDouble({ height: 10 }) } }));
    expect(screen.getByTestId('sql-statement-include-0')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('sql-statement-include-1')).toBeNull();
    });
  });

  it('numbers each statement In [n], the number the Run tooltip and Out [n] refer to', () => {
    render(rail('SELECT 1;\nSELECT 2;\nSELECT 3;'));
    expect(screen.getByTestId('sql-statement-label-0').textContent).toBe('1');
    expect(screen.getByTestId('sql-statement-label-2').textContent).toBe('3');
    expect(screen.getByTestId('sql-statement-label-1').getAttribute('title')).toMatch(/^In \[2\] · SQL/);
  });

  it('marks, in Safe mode, a write Run will confirm — and a DELETE with no WHERE in red', () => {
    render(rail('UPDATE t SET a = 1 WHERE id = 1;\nDELETE FROM t;\nSELECT 1;', { safeMode: true }));
    const update = screen.getByTestId('sql-statement-label-0');
    const del = screen.getByTestId('sql-statement-label-1');
    expect(update.getAttribute('data-dml')).toBe('UPD');
    expect(update.getAttribute('title')).toMatch(/Safe mode: UPD asks for confirmation on Run/);
    expect(del.getAttribute('data-dml')).toBe('DEL!');
    expect(del.textContent).toBe('2!');
    expect(del.getAttribute('title')).toMatch(/DEL: no WHERE — may affect all rows/);
    expect(del.className).toMatch(/text-rose-300/);
    expect(screen.getByTestId('sql-statement-label-2').getAttribute('data-dml')).toBeNull();
  });

  it('marks nothing with Safe mode off, and names a code cell by its kind', () => {
    render(rail('DELETE FROM t;\n-- @js\nreturn [];\n-- @end'));
    expect(screen.getByTestId('sql-statement-label-0').getAttribute('data-dml')).toBeNull();
    expect(screen.getByTestId('sql-statement-label-1').getAttribute('title')).toMatch(/JavaScript code cell/);
  });

  it('selects the statement when its number is clicked', () => {
    const onReveal = vi.fn();
    const statements = splitSqlStatements('SELECT 1;\nSELECT\n  2;');
    render(rail('', { statements, onReveal }));
    fireEvent.click(screen.getByTestId('sql-statement-label-1'));
    expect(onReveal).toHaveBeenCalledWith(statements[1]);
  });

  it('runs one cell, and holds play while running or when SQL has no Destination', () => {
    const onRunCell = vi.fn();
    const sql = 'SELECT 1;\n-- @js\nreturn [];\n-- @end';
    const { rerender } = render(rail(sql, { onRunCell }));
    fireEvent.click(screen.getByTestId('sql-statement-run-1'));
    expect(onRunCell).toHaveBeenCalledWith(1);

    rerender(rail(sql, { onRunCell, running: true }));
    expect((screen.getByTestId('sql-statement-run-0') as HTMLButtonElement).disabled).toBe(true);

    rerender(rail(sql, { onRunCell, sqlNeedsDestination: true }));
    expect((screen.getByTestId('sql-statement-run-0') as HTMLButtonElement).disabled).toBe(true);
    // A code cell runs without a Destination.
    expect((screen.getByTestId('sql-statement-run-1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps two statements on one line apart, so the first stays clickable', async () => {
    const onToggle = vi.fn();
    render(rail('SELECT 1; SELECT 2;', { onToggle }));
    await waitFor(() => expect(topOf('sql-statement-include-1') - topOf('sql-statement-include-0')).toBeGreaterThanOrEqual(16));
    fireEvent.click(screen.getByTestId('sql-statement-include-0'));
    expect(onToggle).toHaveBeenCalledWith(0);
  });

  it('keeps a long statement’s row at the top while its first line is scrolled away', () => {
    const statements = splitSqlStatements(`SELECT\n${Array.from({ length: 9 }, (_, i) => `  c${i},`).join('\n')}\n  z FROM t;\nSELECT 2;`);
    // Lines 1–11 are the first statement; scrolled so line 4 is at the top.
    const tops = rowTops(editorDouble({ height: 100, scroll: 60 }), statements);
    expect(tops[0]).toBe(2);
    // Scrolled past its end, it goes.
    expect(Number.isNaN(rowTops(editorDouble({ height: 100, scroll: 230 }), statements)[0])).toBe(true);
  });

  it('copies a statement with its values, and will not copy one with an undefined variable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copyTextFor = (stmt: { text: string }) =>
      stmt.text.includes('missing')
        ? { sql: stmt.text, error: 'Undefined variable: missing', hasVars: true }
        : { sql: stmt.text.replace('${{id}}', '42'), hasVars: true };
    render(rail('SELECT * FROM t WHERE id = ${{id}};\nSELECT ${{missing}};', { copyTextFor }));
    fireEvent.click(screen.getByTestId('sql-statement-copy-0'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('SELECT * FROM t WHERE id = 42;'));
    const blocked = screen.getByTestId('sql-statement-copy-1') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.getAttribute('title')).toBe('Undefined variable: missing');
  });

  it('re-reads only the statement that changed', () => {
    const script = (lastWord: string) =>
      Array.from({ length: 40 }, (_, i) => `select ${i} from t${i};`).join('\n') + `\nupdate t set a = 1 ${lastWord}`;
    const props = { safeMode: true, editorRef: { current: editorDouble({ height: 5000 }) } };
    const { rerender } = render(rail(script('wher'), props));
    vi.mocked(statementVerb).mockClear();
    rerender(rail(script('where a = 2;'), props));
    expect(statementVerb).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId(/^sql-statement-label-/)).toHaveLength(41);
  });
});
