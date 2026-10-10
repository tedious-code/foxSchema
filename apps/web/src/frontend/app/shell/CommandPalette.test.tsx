/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';
import { CommandPalette } from './CommandPalette';

const setActiveView = vi.fn();
const openRecentQuery = vi.fn();
const ensureConnectionSelected = vi.fn();
const ensureSchema = vi.fn();

vi.mock('@/app/store/uiStore', () => ({
  useUiStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ setActiveView }),
}));

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ connections: [{ id: 'c1', name: 'Demo PG', dialect: 'postgres' }] }),
}));

// The shell reads recent queries from the small mirror, and opens them through it.
vi.mock('@/features/sql-editor/state/recentQueries', () => ({
  useRecentQueries: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ recentQueries: [{ id: 'r1', sql: 'SELECT 1', title: 'Ping', ranAt: 1 }] }),
  openRecentQuery: (id: string) => openRecentQuery(id),
  selectEditorConnection: (id: string) => ensureConnectionSelected(id),
}));
// Opening Home or the palette must not touch the SQL editor store.
vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => {
  throw new Error('the shell imported the SQL editor store');
});

describe('CommandPalette', () => {
  beforeEach(() => {
    setActiveView.mockReset();
    openRecentQuery.mockReset();
    ensureConnectionSelected.mockReset();
    ensureSchema.mockReset();
    useAuthStore.setState({
      user: {
        id: 'owner',
        email: 'o@x',
        onboardingCompleted: true,
        role: 'owner',
        permissions: [...DEFAULT_ROLE_PERMISSIONS.owner],
      },
      status: 'ready',
      error: null,
      busy: false,
      refreshMe: vi.fn(async () => {}),
    });
  });

  it('opens on ⌘K and jumps to a workspace without introspecting', () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('command-palette')).toBeTruthy();
    fireEvent.click(screen.getByTestId('command-palette-item-ws-home'));
    expect(setActiveView).toHaveBeenCalledWith('home');
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('filters recents and opens them in the SQL Editor', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'Ping' } });
    fireEvent.click(screen.getByTestId('command-palette-item-recent-r1'));
    expect(openRecentQuery).toHaveBeenCalledWith('r1');
    expect(setActiveView).toHaveBeenCalledWith('sqlEditor');
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it('opens from the custom event the TopBar button fires', () => {
    render(<CommandPalette />);
    fireEvent(window, new Event('foxschema-command-palette'));
    expect(screen.getByTestId('command-palette')).toBeTruthy();
  });

  it('jumps to the Utilities workspace', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByTestId('command-palette-item-ws-utilities'));
    expect(setActiveView).toHaveBeenCalledWith('utilities');
  });

  it('jumps to Preferences', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByTestId('command-palette-item-ws-settings'));
    expect(setActiveView).toHaveBeenCalledWith('settings');
  });
});
