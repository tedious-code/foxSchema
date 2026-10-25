/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const apiDemoMode = vi.fn();
vi.mock('@/shared/api/authApi', () => ({ apiDemoMode: (...a: unknown[]) => apiDemoMode(...a) }));

import { useAuthStore } from '@/platform/authStore';
import { resetDemoMode } from '@/shared/lib/useDemoMode';
import { DemoBanner } from './DemoBanner';

const signIn = (role: string) =>
  useAuthStore.setState({
    user: { id: 'u', email: 'u@example.com', onboardingCompleted: true, role, permissions: [] },
    status: 'ready',
  } as never);

beforeEach(() => {
  resetDemoMode();
  apiDemoMode.mockReset();
});

describe('DemoBanner', () => {
  it('tells a demo visitor what works and that nothing is saved', async () => {
    apiDemoMode.mockResolvedValue({ on: true });
    signIn('demo');
    render(<DemoBanner />);
    expect((await screen.findByTestId('demo-banner')).textContent).toMatch(/browse, compare, and run queries.*Nothing here can be saved/);
  });

  it('reminds an admin that demo mode is on', async () => {
    apiDemoMode.mockResolvedValue({ on: true });
    signIn('admin');
    render(<DemoBanner />);
    expect((await screen.findByTestId('demo-banner')).textContent).toMatch(/Demo mode is on/);
  });

  it('is absent when demo mode is off, or the server cannot say', async () => {
    apiDemoMode.mockResolvedValue({ on: false });
    signIn('demo');
    const { unmount } = render(<DemoBanner />);
    await waitFor(() => expect(apiDemoMode).toHaveBeenCalled());
    expect(screen.queryByTestId('demo-banner')).toBeNull();
    unmount();

    resetDemoMode();
    apiDemoMode.mockRejectedValue(new Error('offline'));
    render(<DemoBanner />);
    await waitFor(() => expect(apiDemoMode).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});
