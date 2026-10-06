/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS } from '@foxschema/shared';
import { useAuthStore } from '@/app/store/authStore';

vi.mock('@/shared/api/updatesApi', () => ({
  checkForUpdates: vi.fn(async () => null),
}));
vi.mock('./updateToast', () => ({
  maybeToastUpdateAvailable: vi.fn(),
}));
vi.mock('@/features/admin/components/AdminAccessPanel', () => ({
  AdminAccessPanel: ({ open }: { open: boolean }) =>
    open ? <div data-testid="admin-access-panel">Access control</div> : null,
}));
vi.mock('@/app/settings/SettingsPanel', () => ({
  SettingsPanel: () => null,
}));
const signOutOthers = vi.hoisted(() => vi.fn(async () => 2));
vi.mock('@/shared/api/authApi', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiSignOutOthers: signOutOthers,
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/app/store/toastStore', () => ({ toast }));

import { ProfileMenu } from './ProfileMenu';

beforeEach(() => {
  useAuthStore.setState({
    user: {
      id: 'local',
      email: 'local@foxschema.app',
      onboardingCompleted: true,
      role: 'admin',
      permissions: [],
    },
    status: 'ready',
    error: null,
    busy: false,
  });
});

describe('ProfileMenu', () => {
  it('signs out the other sessions and says how many', async () => {
    render(<ProfileMenu />);
    fireEvent.click(screen.getByTestId('profile-menu-trigger'));
    fireEvent.click(screen.getByTestId('profile-sign-out-others'));
    expect(signOutOthers).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Signed out 2 other sessions' })));
  });

  it('opens Access control from the avatar menu for the local admin', async () => {
    render(<ProfileMenu />);
    fireEvent.click(screen.getByTestId('profile-menu-trigger'));
    fireEvent.click(screen.getByTestId('profile-access-control'));
    // The panel's code loads on the first open.
    expect(await screen.findByTestId('admin-access-panel')).toBeTruthy();
  });

  it('hides Access control when the signed-in role cannot manage app users', () => {
    useAuthStore.setState({
      user: {
        id: 'u-editor',
        email: 'editor@example.com',
        onboardingCompleted: true,
        role: 'editor',
        permissions: [...DEFAULT_ROLE_PERMISSIONS.editor],
      },
    });
    render(<ProfileMenu />);
    fireEvent.click(screen.getByTestId('profile-menu-trigger'));
    expect(screen.queryByTestId('profile-access-control')).toBeNull();
  });

  it('opens on screen from the avatar at the foot of the left rail', () => {
    // Placed below the avatar and right-aligned to it, the menu opened past the
    // bottom and left edges of the window, so clicking the avatar showed nothing.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 8, right: 48, top: 720, bottom: 760, width: 40, height: 40, x: 8, y: 720, toJSON: () => ({}),
    } as DOMRect);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    try {
      render(<ProfileMenu />);
      fireEvent.click(screen.getByTestId('profile-menu-trigger'));
      const menu = screen.getByTestId('profile-menu-dropdown');
      const top = parseFloat(menu.style.top);
      const left = parseFloat(menu.style.left);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + 256).toBeLessThanOrEqual(window.innerWidth);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + 300).toBeLessThanOrEqual(window.innerHeight);
    } finally {
      rect.mockRestore();
      width.mockRestore();
      height.mockRestore();
    }
  });
});
