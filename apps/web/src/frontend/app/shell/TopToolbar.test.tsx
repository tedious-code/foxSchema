/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The toolbar lays out what the active view adds around the shell's own
 * controls, in the places those parts had when the toolbar was one component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUiStore } from '@/app/store/uiStore';
import { TopToolbar } from './TopToolbar';

vi.mock('./ActivityIndicator', () => ({ ActivityIndicator: () => <span data-testid="activity" /> }));

vi.mock('@/app/features/featureRegistry', () => ({
  WORKSPACE_VIEWS: {
    home: {},
    sync: {
      toolbar: {
        start: () => <span data-testid="view-start" />,
        end: () => <span data-testid="view-end" />,
        below: () => <div data-testid="view-below" />,
      },
    },
    snapshots: { toolbar: { start: () => <span data-testid="view-start" /> } },
  },
}));

afterEach(() => useUiStore.setState({ activeView: 'home' }));

/** Test ids of an element's children, in order. */
const childIds = (el: Element) => [...el.children].map((c) => c.getAttribute('data-testid') ?? c.tagName.toLowerCase());

describe('TopToolbar', () => {
  it('puts the view’s start first, its end after the shell’s controls, and its second row below', () => {
    useUiStore.setState({ activeView: 'sync' });
    render(<TopToolbar />);
    const header = screen.getByTestId('toolbar');
    const [row, below] = [...header.children];
    expect(childIds(row!)).toEqual(['view-start', 'div']);
    expect(childIds(row!.lastElementChild!)).toEqual(['activity', 'command-palette-btn', 'view-end']);
    expect(below!.getAttribute('data-testid')).toBe('view-below');
  });

  it('shows a view’s start alone when that is all it adds', () => {
    useUiStore.setState({ activeView: 'snapshots' });
    render(<TopToolbar />);
    expect(screen.getByTestId('view-start')).toBeTruthy();
    expect(screen.queryByTestId('view-end')).toBeNull();
    expect(screen.queryByTestId('view-below')).toBeNull();
  });

  it('shows only the shell’s controls on a view that adds nothing', () => {
    useUiStore.setState({ activeView: 'home' });
    render(<TopToolbar />);
    expect(screen.getByTestId('command-palette-btn')).toBeTruthy();
    expect(screen.getByTestId('activity')).toBeTruthy();
    expect(screen.queryByTestId('view-start')).toBeNull();
    expect(screen.getByTestId('toolbar').children).toHaveLength(1);
  });
});
