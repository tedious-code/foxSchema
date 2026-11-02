/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A compare window belongs to the exact source and destination results that
 * started it. A rerun can return different rows with the same timing and count,
 * so result object identity—not response metadata—must invalidate the window.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialRun } from '@/features/sql-editor/state/useSqlEditorStore';

const executeSql = vi.hoisted(() => vi.fn());
const migrateCapture = vi.hoisted(() => ({
  latest: null as null | { source: { rows: unknown[][] }; dest: { rows: unknown[][] } },
}));

vi.mock('@/shared/api/sqlApi', () => ({
  executeSql: (...args: unknown[]) => executeSql(...args),
}));

vi.mock('@/features/compare', () => ({
  useSyncStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      connections: [
        { id: 'source', name: 'Source', dialect: 'postgres', schema: 'public' },
        { id: 'dest', name: 'Destination', dialect: 'postgres', schema: 'public' },
      ],
    }),
}));

vi.mock('./DataMigrateBar', () => ({
  DataMigrateBar: (props: { source: { rows: unknown[][] }; dest: { rows: unknown[][] } }) => {
    migrateCapture.latest = props;
    return null;
  },
}));

import { ResultsPanel } from './ResultsPanel';

const result = (value: string) => ({
  ok: true as const,
  columns: ['id', 'value'],
  rows: [[1, value]],
  rowCount: 1,
  truncated: false,
  durationMs: 7,
});

const initialRuns = (): CredentialRun[] => [
  {
    connectionId: 'source',
    name: 'Source',
    dialect: 'postgres',
    status: 'done',
    results: [result('source-loaded')],
  },
  {
    connectionId: 'dest',
    name: 'Destination',
    dialect: 'postgres',
    status: 'done',
    results: [result('dest-loaded')],
  },
];

describe('ResultsPanel compare-window invalidation', () => {
  it.each(['source', 'dest'] as const)(
    'clears old compare rows when a new %s result has the same duration and row count',
    async (changedSide) => {
      executeSql
        .mockResolvedValueOnce({ results: [result('source-window-old')] })
        .mockResolvedValueOnce({ results: [result('dest-window-old')] });

      const before = initialRuns();
      const view = render(
        <ResultsPanel runs={before} statements={['SELECT id, value FROM items']} layout="sideBySide" />
      );

      fireEvent.click(screen.getByTestId('sql-result-compare-toggle-0'));
      await waitFor(() =>
        expect((screen.getByTestId('sql-result-compare-window-run-0') as HTMLButtonElement).disabled).toBe(false)
      );
      fireEvent.click(screen.getByTestId('sql-result-compare-window-run-0'));
      await screen.findByTestId('sql-result-compare-window-summary-0');
      await waitFor(() => expect(migrateCapture.latest?.source.rows).toEqual([[1, 'source-window-old']]));

      const changedIndex = changedSide === 'source' ? 0 : 1;
      const after = before.map((run, index) =>
        index === changedIndex
          ? { ...run, results: [result(`${changedSide}-rerun-fresh`)] }
          : run
      );
      view.rerender(
        <ResultsPanel runs={after} statements={['SELECT id, value FROM items']} layout="sideBySide" />
      );

      await waitFor(() => expect(screen.queryByTestId('sql-result-compare-window-summary-0')).toBeNull());
      expect(migrateCapture.latest?.source.rows).toEqual([
        [1, changedSide === 'source' ? 'source-rerun-fresh' : 'source-loaded'],
      ]);
      expect(migrateCapture.latest?.dest.rows).toEqual([
        [1, changedSide === 'dest' ? 'dest-rerun-fresh' : 'dest-loaded'],
      ]);
    }
  );
});
