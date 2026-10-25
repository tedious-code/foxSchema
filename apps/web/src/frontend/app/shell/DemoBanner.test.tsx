/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAuthStore } from '@/platform/authStore';
import { DemoBanner } from './DemoBanner';

const signIn = (role: string, demo: { on: boolean } | null) =>
  useAuthStore.setState({
    user: { id: 'u', email: 'u@example.com', onboardingCompleted: true, role, permissions: [] },
    status: 'ready',
    demo,
  } as never);

beforeEach(() => {
  useAuthStore.setState({ demo: null });
});

describe('DemoBanner', () => {
  it('tells a demo visitor what works and that nothing is saved', () => {
    signIn('demo', { on: true });
    render(<DemoBanner />);
    expect(screen.getByTestId('demo-banner').textContent).toMatch(/browse, compare, and run queries.*Nothing here can be saved/);
  });

  it('reminds an admin that demo mode is on', () => {
    signIn('admin', { on: true });
    render(<DemoBanner />);
    expect(screen.getByTestId('demo-banner').textContent).toMatch(/Demo mode is on/);
  });

  it('is absent when demo mode is off, or the server did not say', () => {
    signIn('demo', { on: false });
    const { unmount } = render(<DemoBanner />);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
    unmount();

    signIn('demo', null);
    render(<DemoBanner />);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});
