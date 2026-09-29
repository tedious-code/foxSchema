/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every install signs in. Before any account can, the sign-in page is
 * first-run setup; after, it is sign-in with no way to register yourself.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiSetupState = vi.fn();
const apiSetup = vi.fn();
const apiMe = vi.fn();
const apiLogin = vi.fn();

vi.mock('@/shared/api/authApi', () => ({
  apiSetupState: (...a: unknown[]) => apiSetupState(...a),
  apiSetup: (...a: unknown[]) => apiSetup(...a),
  apiMe: (...a: unknown[]) => apiMe(...a),
  apiLogin: (...a: unknown[]) => apiLogin(...a),
  apiLogout: vi.fn(async () => undefined),
  apiPutPreferences: vi.fn(async () => ({})),
}));
vi.mock('./SsoButtons', () => ({ SsoButtons: () => null }));

import { useAuthStore } from '@/app/store/authStore';
import { AuthPage } from './AuthPage';

const ADMIN = { id: 'u1', email: 'owner@example.com', onboardingCompleted: true, role: 'admin', permissions: [] };

beforeEach(() => {
  for (const m of [apiSetupState, apiSetup, apiMe, apiLogin]) m.mockReset();
  useAuthStore.setState({ status: 'loading', user: null, error: null, busy: false, setupState: null });
});

const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the sign-in page', () => {
  it('goes to setup when no account can sign in yet', async () => {
    apiSetupState.mockResolvedValue({ setupRequired: true, setupEmail: null, setupCodeRequired: false });
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().status).toBe('setup');
    expect(apiMe).not.toHaveBeenCalled();
  });

  it('creates the admin account, refusing mismatched passwords first', async () => {
    apiSetup.mockResolvedValue(ADMIN);
    useAuthStore.setState({
      status: 'setup',
      setupState: { setupRequired: true, setupEmail: null, setupCodeRequired: false },
    });
    render(<AuthPage />);
    expect(screen.queryByLabelText(/setup code/i)).toBeNull();

    type(/^email$/i, 'owner@example.com');
    type(/^password$/i, 'owner-pass-1');
    type(/confirm password/i, 'owner-pass-2');
    fireEvent.submit(screen.getByTestId('auth-setup-form'));
    expect(screen.getByText(/do not match/i)).toBeTruthy();
    expect(apiSetup).not.toHaveBeenCalled();

    type(/confirm password/i, 'owner-pass-1');
    fireEvent.submit(screen.getByTestId('auth-setup-form'));
    await waitFor(() => expect(apiSetup).toHaveBeenCalledWith('owner@example.com', 'owner-pass-1', undefined));
    await waitFor(() => expect(useAuthStore.getState().status).toBe('ready'));
  });

  it('uses the bound email and asks for the setup code when not on the server machine', async () => {
    apiSetup.mockResolvedValue(ADMIN);
    useAuthStore.setState({
      status: 'setup',
      setupState: { setupRequired: true, setupEmail: 'bound@example.com', setupCodeRequired: true },
    });
    render(<AuthPage />);
    const email = screen.getByLabelText(/^email$/i) as HTMLInputElement;
    expect(email.value).toBe('bound@example.com');
    expect(email.readOnly).toBe(true);

    type(/^password$/i, 'owner-pass-1');
    type(/confirm password/i, 'owner-pass-1');
    type(/setup code/i, 'ABCD-EFGH');
    fireEvent.submit(screen.getByTestId('auth-setup-form'));
    await waitFor(() =>
      expect(apiSetup).toHaveBeenCalledWith('bound@example.com', 'owner-pass-1', 'ABCD-EFGH')
    );
  });

  it('offers sign-in only, with no way to register', async () => {
    useAuthStore.setState({ status: 'anon', setupState: null });
    render(<AuthPage />);
    expect(screen.getByTestId('auth-login-form')).toBeTruthy();
    expect(screen.queryByText(/sign up/i)).toBeNull();
    expect(screen.getByText(/ask your administrator/i)).toBeTruthy();
  });
});
