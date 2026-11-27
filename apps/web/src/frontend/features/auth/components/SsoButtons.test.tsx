/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchSsoProvidersStrict = vi.fn();

vi.mock('../api/authApi', () => ({
  fetchSsoProvidersStrict: () => fetchSsoProvidersStrict(),
  startSso: vi.fn(),
}));

import { SsoButtons, resetSsoProvidersCache } from './SsoButtons';

describe('SsoButtons', () => {
  beforeEach(() => {
    fetchSsoProvidersStrict.mockReset();
    resetSsoProvidersCache();
  });

  it('retries transient fetch failures so Google and GitHub buttons still appear', async () => {
    fetchSsoProvidersStrict
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce([
        { id: 'google', label: 'Google' },
        { id: 'github', label: 'GitHub' },
      ]);

    render(<SsoButtons />);
    await waitFor(
      () => {
        expect(screen.getByTestId('auth-sso-buttons-continue-google')).toBeTruthy();
        expect(screen.getByTestId('auth-sso-buttons-continue-github')).toBeTruthy();
      },
      { timeout: 3000 },
    );
    expect(fetchSsoProvidersStrict).toHaveBeenCalledTimes(2);
  });

  it('keeps showing cached providers immediately on remount even if a refresh fails', async () => {
    fetchSsoProvidersStrict.mockResolvedValueOnce([
      { id: 'google', label: 'Google' },
      { id: 'github', label: 'GitHub' },
    ]);

    const first = render(<SsoButtons />);
    await screen.findByTestId('auth-sso-buttons-continue-google');
    first.unmount();

    fetchSsoProvidersStrict.mockRejectedValue(new Error('offline'));
    render(<SsoButtons />);
    expect(screen.getByTestId('auth-sso-buttons-continue-google')).toBeTruthy();
    expect(screen.getByTestId('auth-sso-buttons-continue-github')).toBeTruthy();
  });
});
