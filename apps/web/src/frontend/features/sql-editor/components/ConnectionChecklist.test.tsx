/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Choosing which servers a query runs against.
 *
 * The chips variant used to lay every saved connection out in a horizontal
 * scroller. That is fine with four and unusable with the 254 this developer
 * actually has — most of them off-screen behind a scrollbar, with no way to see
 * what was selected without dragging. It is a dropdown with a filter now, and
 * these are the properties that make it usable rather than merely different.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const toggleConnection = vi.fn();
const setShareDestinations = vi.fn();

const connections = [
  { id: 'c1', name: 'prod-pg', dialect: 'postgres', host: '10.0.0.1', database: 'app' },
  { id: 'c2', name: 'staging-my', dialect: 'mysql', host: '10.0.0.2', database: 'shop' },
  { id: 'c3', name: 'analytics', dialect: 'oracle', host: '10.0.0.3', database: 'warehouse' },
];

vi.mock('@/features/compare/state/useSyncStore', () => ({
  useSyncStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ connections, connectionsLoaded: true }),
}));

vi.mock('@/features/sql-editor/state/useSqlEditorStore', () => ({
  useSqlEditorStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      tabs: [{ id: 't1', selectedConnectionIds: ['c1'] }],
      activeTabId: 't1',
      shareDestinations: false,
      sharedConnectionIds: [],
      toggleConnection,
      setShareDestinations,
      sessionPasswords: {},
      pendingPassword: null,
      submitPendingPassword: vi.fn(),
      cancelPendingPassword: vi.fn(),
    }),
}));

import { ConnectionChecklist } from './ConnectionChecklist';

const open = () => fireEvent.click(screen.getByTestId('sql-destinations-trigger'));

describe('destination picker (chips variant)', () => {
  beforeEach(() => {
    toggleConnection.mockReset();
    setShareDestinations.mockReset();
  });

  it('says what is selected without being opened', () => {
    // The old strip made you scroll to find out. The trigger answers it.
    render(<ConnectionChecklist variant="chips" />);
    expect(screen.getByTestId('sql-destinations-trigger').textContent).toContain('#1');
    expect(screen.getByTestId('sql-destinations-trigger').textContent).toContain('prod-pg');
  });

  it('numbers destinations in the open menu', () => {
    render(<ConnectionChecklist variant="chips" />);
    open();
    expect(screen.getByTestId('sql-dest-group-1').textContent).toBe('#1');
  });

  it('counts rather than lists once more than one is chosen', () => {
    render(<ConnectionChecklist variant="chips" />);
    open();
    fireEvent.click(screen.getByTestId('sql-dest-option-analytics').querySelector('input')!);
    expect(toggleConnection).toHaveBeenCalledWith('c3');
  });

  it('does not render the list until it is opened', () => {
    render(<ConnectionChecklist variant="chips" />);
    expect(screen.queryByTestId('sql-dest-option-prod-pg')).toBeNull();
    open();
    expect(screen.getByTestId('sql-dest-option-prod-pg')).toBeTruthy();
  });

  it('filters on more than the visible name', () => {
    // The row shows name and dialect, but the tooltip carries host and
    // database — searching for what you were told to connect to should work.
    render(<ConnectionChecklist variant="chips" />);
    open();
    const filter = screen.getByTestId('sql-destinations-filter');

    fireEvent.change(filter, { target: { value: 'oracle' } });
    expect(screen.getByTestId('sql-dest-option-analytics')).toBeTruthy();
    expect(screen.queryByTestId('sql-dest-option-prod-pg')).toBeNull();

    fireEvent.change(filter, { target: { value: 'shop' } });
    expect(screen.getByTestId('sql-dest-option-staging-my')).toBeTruthy();

    fireEvent.change(filter, { target: { value: '10.0.0.1' } });
    expect(screen.getByTestId('sql-dest-option-prod-pg')).toBeTruthy();
  });

  it('says so when nothing matches, instead of showing an empty box', () => {
    render(<ConnectionChecklist variant="chips" />);
    open();
    fireEvent.change(screen.getByTestId('sql-destinations-filter'), {
      target: { value: 'zzz-nothing' },
    });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('keeps a filtered-out selection selected', () => {
    // Filtering is a view over the list, not an edit of it. Hiding prod-pg must
    // not quietly drop it from where the query runs.
    render(<ConnectionChecklist variant="chips" />);
    open();
    fireEvent.change(screen.getByTestId('sql-destinations-filter'), {
      target: { value: 'oracle' },
    });
    expect(toggleConnection).not.toHaveBeenCalled();
    expect(screen.getByTestId('sql-destinations-trigger').textContent).toContain('prod-pg');
  });

  it('closes when the click lands outside', () => {
    render(<ConnectionChecklist variant="chips" />);
    open();
    fireEvent.click(screen.getByTestId('sql-destinations-backdrop'));
    expect(screen.queryByTestId('sql-destinations-filter')).toBeNull();
  });

  it('still toggles shared mode, which is a separate decision', () => {
    render(<ConnectionChecklist variant="chips" />);
    fireEvent.click(screen.getByTestId('sql-share-destinations-chip'));
    expect(setShareDestinations).toHaveBeenCalledWith(true);
  });
});
