/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The in-flight results state, in both layouts.
 *
 * This is the regression from #214: side-by-side derived its section count
 * purely from finished work, so a dispatched run rendered an empty container
 * with no sign of progress. The e2e version of this needs a deliberately slow
 * query and a MutationObserver to catch a window of tens of milliseconds;
 * here it is a direct assertion.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResultsPanel } from './ResultsPanel';
import type { CredentialRun } from '@/features/sql-editor/state/useSqlEditorStore';

const running: CredentialRun = {
  connectionId: 'c1',
  name: 'Primary',
  dialect: 'postgres',
  status: 'running',
};

const done: CredentialRun = {
  connectionId: 'c1',
  name: 'Primary',
  dialect: 'postgres',
  status: 'done',
  results: [
    { ok: true, columns: ['id'], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1 },
  ],
};

describe('ResultsPanel — a dispatched run must look like something is happening', () => {
  it('shows progress in side-by-side before any statement is reported', () => {
    // `statements` is empty at dispatch: the store fills it in as each
    // statement finishes. That used to leave nothing to iterate.
    render(<ResultsPanel runs={[running]} statements={[]} layout="sideBySide" />);

    expect(screen.getByTestId('sql-results-side-by-side')).toBeDefined();
    expect(screen.getAllByTestId('sql-results-running').length).toBeGreaterThan(0);
  });

  it('does not leave the side-by-side container empty', () => {
    render(<ResultsPanel runs={[running]} statements={[]} layout="sideBySide" />);

    const panel = screen.getByTestId('sql-results-side-by-side');
    expect(panel.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('names the credential that is running', () => {
    render(<ResultsPanel runs={[running]} statements={[]} layout="sideBySide" />);
    expect(screen.getByTestId('sql-results-side-by-side').textContent).toContain('Primary');
  });

  it('labels the pending section rather than leaving a bare Out [n]:', () => {
    render(<ResultsPanel runs={[running]} statements={[]} layout="sideBySide" />);
    expect(screen.getByTestId('sql-results-side-by-side').textContent).toMatch(/running/i);
  });

  it('shows progress in by-credential too', () => {
    render(<ResultsPanel runs={[running]} statements={[]} layout="byCredential" />);

    expect(screen.getByTestId('sql-results-by-credential')).toBeDefined();
    expect(screen.getAllByTestId('sql-results-running').length).toBeGreaterThan(0);
  });

  it('renders the empty state when nothing has been run', () => {
    render(<ResultsPanel runs={[]} statements={[]} layout="sideBySide" />);

    expect(screen.queryByTestId('sql-results-side-by-side')).toBeNull();
    expect(screen.getByTestId('sql-results-peek-instruction')).toBeDefined();
  });

  it('drops the running indicator once the run settles', () => {
    render(<ResultsPanel runs={[done]} statements={['SELECT 1']} layout="sideBySide" />);
    expect(screen.queryByTestId('sql-results-running')).toBeNull();
  });

  it('does not let one in-flight credential collapse an established layout', () => {
    // A partial refresh of one credential must not shrink the section count
    // and blank the comparison.
    render(
      <ResultsPanel
        runs={[done, { ...running, connectionId: 'c2', name: 'Secondary' }]}
        statements={['SELECT 1']}
        layout="sideBySide"
      />
    );
    const panel = screen.getByTestId('sql-results-side-by-side');
    expect(panel.textContent).toContain('SELECT 1');
    expect(screen.getAllByTestId('sql-results-running').length).toBeGreaterThan(0);
  });
});

describe('ResultsPanel — opt-in SVG chart', () => {
  it('draws bars only after Chart is checked on a label + number grid', () => {
    const run: CredentialRun = {
      connectionId: 'c1',
      name: 'Primary',
      dialect: 'postgres',
      status: 'done',
      results: [
        {
          ok: true,
          columns: ['region', 'n'],
          rows: [
            ['east', 12],
            ['west', 7],
          ],
          rowCount: 2,
          truncated: false,
          durationMs: 1,
        },
      ],
    };
    render(
      <ResultsPanel
        runs={[run]}
        statements={['SELECT region, count(*) AS n FROM t GROUP BY 1']}
        layout="sideBySide"
      />
    );
    expect(screen.queryByTestId('sql-result-chart-0')).toBeNull();
    fireEvent.click(screen.getByTestId('sql-result-chart-toggle-0'));
    expect(screen.getByTestId('sql-result-chart-0')).toBeTruthy();
    expect(screen.getByTestId('sql-result-chart-0-bar-0')).toBeTruthy();
    expect(screen.getByTestId('sql-result-chart-0-bar-1')).toBeTruthy();
  });
});
