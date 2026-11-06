/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HomeView } from './HomeView';

const openRecentQuery = vi.fn();
const ensureConnectionSelected = vi.fn();
const ensureSchema = vi.fn();
const setActiveView = vi.fn();

// The shell reads recent queries from the small mirror, and opens them through it.
vi.mock('@/features/sql-editor/state/recentQueries', () => ({
  useRecentQueries: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ recentQueries: [
        { id: 'r1', sql: 'SELECT 1', title: 'Ping', ranAt: Date.now() },
      ] }),
  openRecentQuery: (id: string) => openRecentQuery(id),
  selectEditorConnection: (id: string) => ensureConnectionSelected(id),
}));
// Opening Home or the palette must not touch the SQL editor store.
vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => {
  throw new Error('the shell imported the SQL editor store');
});

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      connections: [
        { id: 'c1', name: 'Demo SQLite', dialect: 'sqlite' },
        { id: 'c2', name: 'Warehouse', dialect: 'postgres', host: 'db.internal', port: 5432 },
        { id: 'c3', name: 'Lab SQLite', dialect: 'sqlite' },
      ],
      compareResult: null,
      sourceConfig: { option: {} },
      targetConfig: { option: {} },
    }),
}));

vi.mock('@/platform/uiStore', () => ({
  useUiStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ setActiveView }),
}));

describe('HomeView', () => {
  beforeEach(() => {
    openRecentQuery.mockReset();
    ensureConnectionSelected.mockReset();
    ensureSchema.mockReset();
    setActiveView.mockReset();
  });

  it('opens a recent query in the SQL Editor without introspecting', () => {
    render(<HomeView />);
    expect(screen.getByTestId('home-view')).toBeTruthy();
    fireEvent.click(screen.getByTestId('home-recent-r1'));
    expect(openRecentQuery).toHaveBeenCalledWith('r1');
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('opens Compare from a provider count without listing credentials', () => {
    render(<HomeView />);
    fireEvent.click(screen.getByTestId('home-connections-group-sqlite'));
    expect(setActiveView).toHaveBeenCalledWith('sync');
    expect(ensureConnectionSelected).not.toHaveBeenCalled();
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('continues into Snapshots from the home cards', () => {
    render(<HomeView />);
    fireEvent.click(screen.getByTestId('home-continue-snapshots'));
    expect(setActiveView).toHaveBeenCalledWith('snapshots');
  });

  it('shows the total number of saved connections', () => {
    render(<HomeView />);
    expect(screen.getByTestId('home-connections-count').textContent).toBe('3');
  });

  it('groups connections by provider on the home index', () => {
    render(<HomeView />);
    const section = screen.getByTestId('home-connections');
    expect(section.textContent).toMatch(/Connections by provider/);
    expect(screen.getByTestId('home-connections-count-postgres').textContent).toBe('1');
    expect(screen.getByTestId('home-connections-count-sqlite').textContent).toBe('2');
    expect(section.textContent).not.toMatch(/Demo SQLite|Lab SQLite|Warehouse|db\.internal/);
  });

  it('opens the Utilities workspace from Home', () => {
    render(<HomeView />);
    fireEvent.click(screen.getByTestId('home-continue-utilities'));
    expect(setActiveView).toHaveBeenCalledWith('utilities');
  });
});
