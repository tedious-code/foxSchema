/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The pages before the workspace: sign-up the first time, sign-in with no
 * open registration, forgot password, and a code from an invite or reset
 * email. The password rules shown are the server's own.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiSetupState = vi.fn();
const apiSetup = vi.fn();
const apiMe = vi.fn();
const apiLogin = vi.fn();
const apiForgotPassword = vi.fn();
const apiInspectCode = vi.fn();
const apiRedeemCode = vi.fn();

vi.mock('@/shared/api/authApi', () => ({
  apiSetupState: (...a: unknown[]) => apiSetupState(...a),
  apiSetup: (...a: unknown[]) => apiSetup(...a),
  apiMe: (...a: unknown[]) => apiMe(...a),
  apiLogin: (...a: unknown[]) => apiLogin(...a),
  apiForgotPassword: (...a: unknown[]) => apiForgotPassword(...a),
  apiInspectCode: (...a: unknown[]) => apiInspectCode(...a),
  apiRedeemCode: (...a: unknown[]) => apiRedeemCode(...a),
  apiLogout: vi.fn(async () => undefined),
  apiPutPreferences: vi.fn(async () => ({})),
}));
vi.mock('./SsoButtons', () => ({ SsoButtons: () => null }));

import { useAuthStore } from '@/app/store/authStore';
import { AuthPage } from './AuthPage';

const ADMIN = { id: 'u1', email: 'owner@example.com', onboardingCompleted: true, role: 'admin', permissions: [] };
const GOOD = 'blue-lantern-42';

beforeEach(() => {
  for (const m of [apiSetupState, apiSetup, apiMe, apiLogin, apiForgotPassword, apiInspectCode, apiRedeemCode]) {
    m.mockReset();
  }
  useAuthStore.setState({ status: 'loading', user: null, error: null, busy: false, setupState: null });
  window.history.replaceState(null, '', '/');
});

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('first-time sign-up', () => {
  it('is shown when no account can sign in yet', async () => {
    apiSetupState.mockResolvedValue({ setupRequired: true, setupEmail: null, setupCodeRequired: false });
    await useAuthStore.getState().init();
    expect(useAuthStore.getState().status).toBe('setup');
    expect(apiMe).not.toHaveBeenCalled();
  });

  it('checks the server rules as you type and refuses mismatches before sending', async () => {
    apiSetup.mockResolvedValue(ADMIN);
    useAuthStore.setState({
      status: 'setup',
      setupState: { setupRequired: true, setupEmail: null, setupCodeRequired: false },
    });
    render(<AuthPage />);
    expect(screen.getByRole('heading', { name: /create your account/i })).toBeTruthy();
    expect(screen.queryByLabelText(/setup code/i)).toBeNull();

    type(/^email$/i, 'owner@example.com');
    type(/^password$/i, 'password123');
    expect(screen.getByText(/first ones attackers try/i)).toBeTruthy();

    type(/^password$/i, GOOD);
    type(/confirm password/i, 'blue-lantern-43');
    fireEvent.submit(screen.getByTestId('auth-setup-form'));
    expect(screen.getAllByText(/do not match/i).length).toBeGreaterThan(0);
    expect(apiSetup).not.toHaveBeenCalled();

    type(/confirm password/i, GOOD);
    fireEvent.submit(screen.getByTestId('auth-setup-form'));
    await waitFor(() => expect(apiSetup).toHaveBeenCalledWith('owner@example.com', GOOD, undefined));
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

    type(/^password$/i, GOOD);
    type(/confirm password/i, GOOD);
    type(/setup code/i, 'ABCD-EFGH');
    fireEvent.submit(screen.getByTestId('auth-setup-form'));
    await waitFor(() => expect(apiSetup).toHaveBeenCalledWith('bound@example.com', GOOD, 'ABCD-EFGH'));
  });
});

describe('sign in', () => {
  it('offers sign-in, forgot password and codes, with no way to register', () => {
    useAuthStore.setState({ status: 'anon', setupState: null });
    render(<AuthPage />);
    expect(screen.getByTestId('auth-login-form')).toBeTruthy();
    expect(screen.queryByText(/sign up|register|create account/i)).toBeNull();
    expect(screen.getByText(/ask your administrator/i)).toBeTruthy();
    expect(screen.getByTestId('auth-forgot-link')).toBeTruthy();
    expect(screen.getByTestId('auth-have-code')).toBeTruthy();
  });

  it('warns when Caps Lock is on', () => {
    useAuthStore.setState({ status: 'anon', setupState: null });
    render(<AuthPage />);
    expect(screen.queryByTestId('caps-lock-hint')).toBeNull();
    // jsdom has no Caps Lock state to set, so report it from the event.
    const spy = vi.spyOn(KeyboardEvent.prototype, 'getModifierState').mockImplementation((k) => k === 'CapsLock');
    fireEvent.keyUp(screen.getByLabelText(/^password$/i), { key: 'A' });
    expect(screen.getByTestId('caps-lock-hint')).toBeTruthy();
    spy.mockRestore();
  });
});

describe('forgot password', () => {
  it('sends the code and says where it went, without saying whether the account exists', async () => {
    apiForgotPassword.mockResolvedValue({ delivery: 'email' });
    useAuthStore.setState({ status: 'anon', setupState: null });
    render(<AuthPage />);
    type(/^email$/i, 'ana@example.com');
    fireEvent.click(screen.getByTestId('auth-forgot-link'));
    expect((screen.getByLabelText(/^email$/i) as HTMLInputElement).value).toBe('ana@example.com');
    fireEvent.submit(screen.getByTestId('auth-forgot-form'));
    await waitFor(() => expect(screen.getByTestId('auth-forgot-sent')).toBeTruthy());
    expect(apiForgotPassword).toHaveBeenCalledWith('ana@example.com');
    expect(screen.getByText(/if/i, { selector: 'p' }).textContent).toMatch(/If ana@example.com has an account/);
  });

  it('points at the server log when the install does not send email', async () => {
    apiForgotPassword.mockResolvedValue({ delivery: 'log' });
    useAuthStore.setState({ status: 'anon', setupState: null });
    render(<AuthPage />);
    fireEvent.click(screen.getByTestId('auth-forgot-link'));
    type(/^email$/i, 'ana@example.com');
    fireEvent.submit(screen.getByTestId('auth-forgot-form'));
    await waitFor(() => expect(screen.getByText(/foxschema reset-password/)).toBeTruthy());
  });
});

describe('codes', () => {
  it('opens an emailed invite link, removes the code from the address bar, and signs the person up', async () => {
    window.history.replaceState(null, '', '/#invite=ABCD-EFGH-JKMN');
    apiInspectCode.mockResolvedValue({ email: 'new@example.com', purpose: 'invite' });
    apiRedeemCode.mockResolvedValue({ ...ADMIN, email: 'new@example.com', role: 'viewer' });
    useAuthStore.setState({ status: 'anon', setupState: null });
    render(<AuthPage />);

    await waitFor(() => expect(screen.getByTestId('auth-redeem-form')).toBeTruthy());
    expect(apiInspectCode).toHaveBeenCalledWith('ABCD-EFGH-JKMN');
    expect(window.location.hash).toBe('');
    expect((screen.getByLabelText(/^email$/i) as HTMLInputElement).value).toBe('new@example.com');

    type(/^password$/i, GOOD);
    type(/confirm password/i, GOOD);
    fireEvent.submit(screen.getByTestId('auth-redeem-form'));
    await waitFor(() => expect(apiRedeemCode).toHaveBeenCalledWith('ABCD-EFGH-JKMN', GOOD));
    await waitFor(() => expect(useAuthStore.getState().status).toBe('ready'));
  });

  it('says so when a typed code does not work', async () => {
    apiInspectCode.mockRejectedValue(new Error('This code is wrong or has expired. Ask for a new one.'));
    useAuthStore.setState({ status: 'anon', setupState: null });
    render(<AuthPage />);
    fireEvent.click(screen.getByTestId('auth-have-code'));
    type(/^code$/i, 'NOPE-NOPE-NOPE');
    fireEvent.submit(screen.getByTestId('auth-code-form'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/wrong or has expired/));
    expect(apiRedeemCode).not.toHaveBeenCalled();
  });
});
