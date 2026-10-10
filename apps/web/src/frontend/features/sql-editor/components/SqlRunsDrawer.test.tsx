/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SqlRunsDrawer } from './SqlRunsDrawer';

const openRecentQuery = vi.fn();
const clearRecentQueries = vi.fn();

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  useSqlEditorStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      recentQueries: [{ id: 'r1', sql: 'SELECT 1', title: 'Ping', ranAt: Date.now() }],
      openRecentQuery,
      clearRecentQueries,
    }),
}));

describe('SqlRunsDrawer', () => {
  beforeEach(() => {
    openRecentQuery.mockReset();
    clearRecentQueries.mockReset();
  });

  it('reopens a recent run and closes', () => {
    const onClose = vi.fn();
    render(<SqlRunsDrawer open onClose={onClose} />);
    expect(screen.getByTestId('sql-runs-drawer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sql-runs-open-r1'));
    expect(openRecentQuery).toHaveBeenCalledWith('r1');
    expect(onClose).toHaveBeenCalled();
  });
});
