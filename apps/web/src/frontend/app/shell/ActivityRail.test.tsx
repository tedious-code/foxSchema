/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';
import { useUiStore } from '@/app/store/uiStore';
import { ActivityRail } from './ActivityRail';
import { prefetchView } from '@/app/features/featureRegistry';

// The real rail items; only the network side of prefetch is stubbed.
vi.mock('@/app/features/featureRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/features/featureRegistry')>()),
  prefetchView: vi.fn(),
}));

describe('ActivityRail', () => {
  it('keeps workspace testids and opens Home from the logo', () => {
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
    useUiStore.setState({ activeView: 'sync' });
    render(<ActivityRail />);
    expect(screen.getByTestId('workspace-switcher')).toBeTruthy();
    expect(screen.getByTestId('view-sync-btn')).toBeTruthy();
    expect(screen.getByTestId('view-sync-btn').getAttribute('title')).toBe('Compare');
    expect(screen.getByTestId('view-sql-editor-btn')).toBeTruthy();
    expect(screen.getByTestId('view-utilities-btn')).toBeTruthy();
    expect(screen.getByTestId('view-access-btn')).toBeTruthy();
    expect(screen.getByTestId('view-workflow-btn')).toBeTruthy();
    expect(screen.getByTestId('sync-pane-history-btn')).toBeTruthy();
    expect(screen.getByTestId('credentials-btn')).toBeTruthy();
    expect(screen.getByTestId('history-btn')).toBeTruthy();
    expect(screen.getByTestId('profile-menu-trigger')).toBeTruthy();
    fireEvent.click(screen.getByTestId('view-workflow-btn'));
    expect(useUiStore.getState().activeView).toBe('workflow');
    fireEvent.click(screen.getByTestId('home-open-btn'));
    expect(useUiStore.getState().activeView).toBe('home');
    fireEvent.click(screen.getByTestId('view-settings-btn'));
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('starts loading a view when the pointer or keyboard reaches its button', () => {
    useUiStore.setState({ activeView: 'sync' });
    render(<ActivityRail />);
    fireEvent.pointerEnter(screen.getByTestId('view-access-btn'));
    expect(prefetchView).toHaveBeenLastCalledWith('access');
    fireEvent.focus(screen.getByTestId('view-sql-editor-btn'));
    expect(prefetchView).toHaveBeenLastCalledWith('sqlEditor');
    fireEvent.pointerEnter(screen.getByTestId('view-settings-btn'));
    expect(prefetchView).toHaveBeenLastCalledWith('settings');
  });
});
