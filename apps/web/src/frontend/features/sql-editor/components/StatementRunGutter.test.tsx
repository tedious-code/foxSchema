import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';
import { StatementRunGutter } from './StatementRunGutter';

describe('StatementRunGutter', () => {
  it('places a run checkbox on each statement and toggles the one that was clicked', () => {
    const onToggle = vi.fn();
    const statements = splitSqlStatements('SELECT 1;\nSELECT 2;');
    const editor = {
      getTopForLineNumber: (line: number) => (line - 1) * 20 + 8,
      getScrollTop: () => 0,
      getLayoutInfo: () => ({ height: 200 }),
      onDidScrollChange: () => ({ dispose: () => {} }),
      onDidContentSizeChange: () => ({ dispose: () => {} }),
      onDidLayoutChange: () => ({ dispose: () => {} }),
    };
    render(
      <StatementRunGutter
        statements={statements}
        checked={[1]}
        editorRef={{ current: editor }}
        editorEpoch={1}
        onToggle={onToggle}
      />
    );
    const first = screen.getByTestId('sql-statement-include-0') as HTMLInputElement;
    const second = screen.getByTestId('sql-statement-include-1') as HTMLInputElement;
    expect(first.checked).toBe(false);
    expect(second.checked).toBe(true);
    fireEvent.click(first);
    expect(onToggle).toHaveBeenCalledWith(0);
  });

  it('hides a statement that is scrolled out of the editor', async () => {
    const statements = splitSqlStatements('SELECT 1;\nSELECT 2;');
    const editor = {
      getTopForLineNumber: (line: number) => (line - 1) * 20,
      getScrollTop: () => 0,
      getLayoutInfo: () => ({ height: 10 }),
      onDidScrollChange: () => ({ dispose: () => {} }),
      onDidContentSizeChange: () => ({ dispose: () => {} }),
      onDidLayoutChange: () => ({ dispose: () => {} }),
    };
    render(
      <StatementRunGutter
        statements={statements}
        checked={[]}
        editorRef={{ current: editor }}
        editorEpoch={1}
        onToggle={() => {}}
      />
    );
    expect(screen.getByTestId('sql-statement-include-0')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('sql-statement-include-1')).toBeNull();
    });
  });
});
