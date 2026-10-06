import { describe, expect, it, vi } from 'vitest';
import React, { useCallback, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TableDiff } from '@/shared/lib/types';
import { highlightMatch } from '@/features/schema-diff/lib/highlight';
import { SchemaDiffTree } from './SchemaDiffTree';

// Watched, not replaced: each row render highlights its name once.
vi.mock('@/features/schema-diff/lib/highlight', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/features/schema-diff/lib/highlight')>();
  return { ...real, highlightMatch: vi.fn(real.highlightMatch) };
});

const table = (tableName: string) =>
  ({ tableName, status: 'MODIFIED', objectType: 'TABLE', columnDiffs: [], indexDiffs: [] }) as unknown as TableDiff;

const TABLES = Array.from({ length: 50 }, (_, i) => table(`T${i}`));

/** The Compare panel's wiring: a selection map and stable callbacks. */
function Workspace() {
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const toggle = useCallback((name: string) => setSelection((s) => ({ ...s, [name]: !s[name] })), []);
  const select = useCallback(() => {}, []);
  return <SchemaDiffTree tables={TABLES} selection={selection} onToggleSelection={toggle} onSelect={select} />;
}

describe('SchemaDiffTree rows', () => {
  it('re-renders only the row whose box was ticked', () => {
    render(<Workspace />);
    vi.mocked(highlightMatch).mockClear();
    fireEvent.click(screen.getByTestId('diff-tree-toggle-selection-T7'));
    expect((screen.getByTestId('diff-tree-toggle-selection-T7') as HTMLInputElement).checked).toBe(true);
    expect(highlightMatch).toHaveBeenCalledTimes(1);
  });
});
