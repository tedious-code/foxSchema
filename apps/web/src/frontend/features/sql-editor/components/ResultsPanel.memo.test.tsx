import { render } from '@testing-library/react';
import React, { useState } from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialRun } from '@/app/store/useSqlEditorStore';
import { DataGrid } from './DataGrid';
import { ResultsPanel } from './ResultsPanel';

// The real grid, counted: each render of a result grid calls it once.
vi.mock('./DataGrid', async (importOriginal) => {
  const real = await importOriginal<typeof import('./DataGrid')>();
  const Real = real.DataGrid;
  return { ...real, DataGrid: vi.fn((props: React.ComponentProps<typeof Real>) => <Real {...props} />) };
});

const done: CredentialRun = {
  connectionId: 'c1',
  name: 'Primary',
  dialect: 'postgres',
  status: 'done',
  results: [{ ok: true, columns: ['id'], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1 }],
};
const RUNS = [done];
const STATEMENTS = ['select 1'];
const onPage = () => {};
const onRefresh = () => {};

let type: (sql: string) => void = () => {};

/** The editor: its own state changes on every keystroke; the results props do not. */
function Editor() {
  const [sql, setSql] = useState('select 1');
  type = setSql;
  return (
    <>
      <pre>{sql}</pre>
      <ResultsPanel runs={RUNS} statements={STATEMENTS} layout="byCredential" onPage={onPage} onRefresh={onRefresh} />
    </>
  );
}

describe('ResultsPanel', () => {
  it('does not re-render the result grids while the editor is typed in', () => {
    render(<Editor />);
    const before = vi.mocked(DataGrid).mock.calls.length;
    expect(before).toBeGreaterThan(0);
    act(() => type('select 12'));
    act(() => type('select 123'));
    expect(vi.mocked(DataGrid).mock.calls.length).toBe(before);
  });
});
