/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PeekInsight } from './PeekInsight';

const fetchTableInsight = vi.fn();
vi.mock('@/shared/api/schemaApi', () => ({
  fetchTableInsight: (...args: unknown[]) => fetchTableInsight(...args),
}));

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  // Mirrors the real store's shape, including the empty schemaCache it always
  // starts with — the component reads foreign keys from there.
  useSqlEditorStore: (
    sel: (s: {
      sessionPasswords: Record<string, string>;
      schemaCache: Record<string, { tables?: unknown[] }>;
      openDataPeekOrphans: () => Promise<void>;
    }) => unknown
  ) =>
    sel({
      sessionPasswords: {},
      schemaCache: {},
      openDataPeekOrphans: async () => undefined,
    }),
}));

describe('PeekInsight', () => {
  beforeEach(() => {
    fetchTableInsight.mockReset();
    fetchTableInsight.mockResolvedValue({
      table: 'orders',
      schema: 'public',
      estimatedRows: 1200,
      columns: [{ name: 'id', nDistinct: 1200, nullFrac: 0 }],
      mode: 'catalog',
      support: { mode: 'catalog', query: true, hint: 'pg_stats' },
    });
  });

  it('fetches catalog stats when mounted (Insight tab selected)', async () => {
    render(<PeekInsight connectionId="c1" tableName="public.orders" schema="public" />);
    await waitFor(() => expect(fetchTableInsight).toHaveBeenCalledTimes(1));
    expect(fetchTableInsight).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'c1' }),
      expect.objectContaining({ table: 'orders', schema: 'public' })
    );
    await waitFor(() =>
      expect(screen.getByTestId('data-peek-insight-rows').textContent).toMatch(/1,200/)
    );
    expect(screen.getByTestId('data-peek-insight-col-id')).toBeTruthy();
  });
});
