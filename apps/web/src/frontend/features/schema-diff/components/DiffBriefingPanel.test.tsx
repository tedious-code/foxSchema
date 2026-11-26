/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useSyncStore } from '@/features/compare';
import { DiffBriefingPanel } from './DiffBriefingPanel';
import type { TableDiff } from '@/shared/lib/types';

function table(name: string, status: TableDiff['status']): TableDiff {
  return {
    tableName: name,
    objectType: 'TABLE',
    status,
    columnDiffs: [],
    indexDiffs: [],
    foreignKeyDiffs: [],
  } as TableDiff;
}

describe('DiffBriefingPanel', () => {
  beforeEach(() => {
    useSyncStore.setState({
      compareResult: {
        tables: [
          table('orders', 'ADDED'),
          table('customers', 'MODIFIED'),
          table('legacy', 'REMOVED'),
          table('ok', 'UNCHANGED'),
        ],
        summary: { added: 1, modified: 1, removed: 1, unchanged: 1 },
      } as never,
      syncSelection: { orders: true, customers: true, legacy: false },
      filterStatus: 'ALL',
      selectedTable: null,
      sourceConfig: {
        dialect: 'sqlite',
        schema: 'main',
        option: { host: '', database: '/tmp/a.db' },
      } as never,
      targetConfig: {
        dialect: 'sqlite',
        schema: 'main',
        option: { host: '', database: '/tmp/b.db' },
      } as never,
    });
  });

  it('lands on + / ~ / − from the compare DTO and opens an object without a second query', () => {
    render(<DiffBriefingPanel />);
    expect(screen.getByTestId('diff-briefing-panel')).toBeTruthy();
    expect(screen.getByTestId('diff-briefing-added').textContent).toContain('1');
    expect(screen.getByTestId('diff-briefing-modified').textContent).toContain('1');
    expect(screen.getByTestId('diff-briefing-removed').textContent).toContain('1');
    fireEvent.click(screen.getByTestId('diff-briefing-row-customers'));
    expect(useSyncStore.getState().selectedTable?.tableName).toBe('customers');
  });

  it('offers Copy Migration SQL, Download .sql, and Open in SQL Editor when generatedSql is present', () => {
    useSyncStore.setState({ generatedSql: 'CREATE TABLE orders (id INT);' });
    render(<DiffBriefingPanel />);
    expect(screen.getByTestId('diff-briefing-copy-sql')).toBeTruthy();
    expect(screen.getByTestId('diff-briefing-download-sql')).toBeTruthy();
    expect(screen.getByTestId('diff-briefing-open-sql-editor')).toBeTruthy();
  });
});
