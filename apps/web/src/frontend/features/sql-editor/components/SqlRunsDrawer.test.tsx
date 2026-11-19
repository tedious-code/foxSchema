/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SqlRunsDrawer } from './SqlRunsDrawer';

const openRecentQuery = vi.fn();
const removeRecentQuery = vi.fn();
const clearRecentQueries = vi.fn();
const copyMock = vi.fn().mockResolvedValue(true);

vi.mock('@/shared/utils/clipboard', () => ({
  writeClipboard: (...args: unknown[]) => copyMock(...args),
}));

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  useSqlEditorStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      recentQueries: [
        { id: 'r1', sql: 'SELECT 1', title: 'Ping', ranAt: Date.now(), ok: true, durationMs: 12, rowCount: 1 },
        { id: 'r2', sql: 'DROP TABLE missing', title: 'Drop', ranAt: Date.now(), ok: false, durationMs: 5, errorSummary: 'no such table' },
      ],
      openRecentQuery,
      removeRecentQuery,
      clearRecentQueries,
    }),
}));

describe('SqlRunsDrawer', () => {
  beforeEach(() => {
    openRecentQuery.mockReset();
    removeRecentQuery.mockReset();
    clearRecentQueries.mockReset();
    copyMock.mockReset();
    copyMock.mockResolvedValue(true);
  });

  it('reopens a recent run and closes', () => {
    const onClose = vi.fn();
    render(<SqlRunsDrawer open onClose={onClose} />);
    expect(screen.getByTestId('sql-runs-drawer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sql-runs-open-r1'));
    expect(openRecentQuery).toHaveBeenCalledWith('r1');
    expect(onClose).toHaveBeenCalled();
  });

  it('filters, copies, removes individual runs, and confirms clear all', () => {
    render(<SqlRunsDrawer open onClose={() => undefined} />);
    fireEvent.change(screen.getByTestId('sql-runs-search'), { target: { value: 'missing' } });
    expect(screen.queryByTestId('sql-runs-open-r1')).toBeNull();
    expect(screen.getByTestId('sql-runs-open-r2')).toBeTruthy();

    fireEvent.click(screen.getByTestId('sql-runs-copy-r2'));
    expect(copyMock).toHaveBeenCalledWith('DROP TABLE missing');

    fireEvent.click(screen.getByTestId('sql-runs-delete-r2'));
    expect(removeRecentQuery).toHaveBeenCalledWith('r2');

    fireEvent.click(screen.getByTestId('sql-runs-clear'));
    expect(clearRecentQueries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sql-runs-clear-confirm'));
    expect(clearRecentQueries).toHaveBeenCalledTimes(1);
  });
});
