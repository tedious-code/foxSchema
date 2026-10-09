/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Starting from a `foxschema open` launch link, and the two reminders that
 * follow: create your account, then verify your email.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiLaunch = vi.fn();
const apiSession = vi.fn();
const apiSetupState = vi.fn();
const apiSendVerification = vi.fn();
const apiVerifyEmail = vi.fn();
vi.mock('@/shared/api/authApi', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiLaunch: (...a: unknown[]) => apiLaunch(...a),
  apiSession: (...a: unknown[]) => apiSession(...a),
  apiSetupState: (...a: unknown[]) => apiSetupState(...a),
  apiSendVerification: (...a: unknown[]) => apiSendVerification(...a),
  apiVerifyEmail: (...a: unknown[]) => apiVerifyEmail(...a),
}));
vi.mock('./SsoButtons', () => ({ SsoButtons: () => null }));

import { useAuthStore } from '@/app/store/authStore';
import type { AuthUser } from '@/shared/api/authApi';
import { AccountBanners, dueIn } from './AccountBanners';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER: AuthUser = { id: 'u1', email: 'local@foxschema.app', onboardingCompleted: true, role: 'admin', permissions: [] };
const SETUP_OPEN = { setupRequired: true, setupEmail: null, setupCodeRequired: false };
const launchSession = (required: boolean) => ({
  user: OWNER,
  launch: true,
  registration: { dueAt: new Date(Date.now() + (required ? -1 : 7) * DAY_MS).toISOString(), required },
  emailVerification: null,
});

beforeEach(() => {
  for (const m of [apiLaunch, apiSession, apiSetupState, apiSendVerification, apiVerifyEmail]) m.mockReset();
  useAuthStore.setState({
    status: 'loading',
    user: null,
    error: null,
    busy: false,
    setupState: null,
    launch: false,
    registration: null,
    emailVerification: null,
    registerDialogOpen: false,
  });
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('starting from a launch link', () => {
  it('signs in with the token, drops it from the address bar, and opens the workspace', async () => {
    window.history.replaceState(null, '', '/#launch=tok-123');
    apiLaunch.mockResolvedValue(OWNER);
    apiSetupState.mockResolvedValue(SETUP_OPEN);
    apiSession.mockResolvedValue(launchSession(false));

    await useAuthStore.getState().init();

    expect(apiLaunch).toHaveBeenCalledWith('tok-123');
    expect(window.location.hash).toBe('');
    expect(useAuthStore.getState()).toMatchObject({ status: 'ready', launch: true });
  });

  it('asks for the account, full screen, once the grace period is over', async () => {
    apiSetupState.mockResolvedValue(SETUP_OPEN);
    apiSession.mockResolvedValue(launchSession(true));
    await useAuthStore.getState().init();
    expect(useAuthStore.getState()).toMatchObject({ status: 'setup', launch: true });
  });

  it('falls back to the usual page when the link no longer works', async () => {
    window.history.replaceState(null, '', '/#launch=used');
    apiLaunch.mockRejectedValue(new Error('expired'));
    apiSetupState.mockResolvedValue(SETUP_OPEN);
    apiSession.mockResolvedValue(null);
    await useAuthStore.getState().init();
    expect(useAuthStore.getState()).toMatchObject({ status: 'setup', launch: false, user: null });
  });
});

describe('dueIn', () => {
  it('rounds up, so a day that has begun still counts', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(dueIn(new Date(now + 6.5 * DAY_MS).toISOString(), now)).toBe('within 7 days');
    expect(dueIn(new Date(now + 0.5 * DAY_MS).toISOString(), now)).toBe('within a day');
    expect(dueIn(new Date(now - DAY_MS).toISOString(), now)).toBe('today');
  });
});

describe('create your account', () => {
  beforeEach(() => {
    const session = launchSession(false);
    useAuthStore.setState({
      status: 'ready',
      user: OWNER,
      launch: true,
      registration: session.registration,
      setupState: SETUP_OPEN,
    });
  });

  it('says how long is left, and opens the first-account form', () => {
    render(<AccountBanners />);
    expect(screen.getByTestId('account-register-banner').textContent).toMatch(/without an account\. Create one within 7 days/);
    fireEvent.click(screen.getByTestId('account-register-open'));
    expect(screen.getByTestId('account-register-dialog')).toBeTruthy();
    expect(screen.getByTestId('auth-setup-form')).toBeTruthy();
    fireEvent.click(screen.getByTestId('account-register-close'));
    expect(screen.queryByTestId('account-register-dialog')).toBeNull();
  });

  it('can be put away until next time, and still opens from the profile menu', () => {
    render(<AccountBanners />);
    fireEvent.click(screen.getByTestId('account-register-dismiss'));
    expect(screen.queryByTestId('account-register-banner')).toBeNull();
    act(() => useAuthStore.getState().setRegisterDialogOpen(true));
    expect(screen.getByTestId('auth-setup-form')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('account-register-dialog')).toBeNull();
  });

  it('takes over the screen if the deadline passes while Fox is open', async () => {
    useAuthStore.setState({ registration: { dueAt: new Date(Date.now() + 20).toISOString(), required: false } });
    render(<AccountBanners />);
    await waitFor(() => expect(useAuthStore.getState().status).toBe('setup'));
    expect(useAuthStore.getState().registration?.required).toBe(true);
  });
});

describe('verify your email', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'ready',
      user: { ...OWNER, email: 'owner@example.com' },
      emailVerification: { verified: false },
    });
  });

  it('takes the emailed code and goes away once it works', async () => {
    apiVerifyEmail.mockResolvedValue(undefined);
    render(<AccountBanners />);
    expect(screen.getByTestId('account-verify-banner').textContent).toContain('owner@example.com');
    fireEvent.change(screen.getByTestId('account-verify-code'), { target: { value: ' abcd-efgh-jkmn ' } });
    fireEvent.click(screen.getByTestId('account-verify-submit'));
    await waitFor(() => expect(screen.queryByTestId('account-verify-banner')).toBeNull());
    expect(apiVerifyEmail).toHaveBeenCalledWith('abcd-efgh-jkmn');
  });

  it('says what went wrong with a code, and when a new one is on its way or could not be sent', async () => {
    apiVerifyEmail.mockRejectedValue(new Error('This code is wrong or has expired. Send a new one.'));
    render(<AccountBanners />);
    fireEvent.change(screen.getByTestId('account-verify-code'), { target: { value: 'WRNG-CODE-0000' } });
    fireEvent.click(screen.getByTestId('account-verify-submit'));
    await waitFor(() => expect(screen.getByTestId('account-verify-status').textContent).toMatch(/wrong or has expired/));

    apiSendVerification.mockResolvedValueOnce({ delivery: 'service', email: 'owner@example.com' });
    fireEvent.click(screen.getByTestId('account-verify-resend'));
    await waitFor(() => expect(screen.getByTestId('account-verify-status').textContent).toMatch(/Code sent to owner@example.com/));

    apiSendVerification.mockRejectedValueOnce(new Error('The Fox mail service could not send it (503).'));
    fireEvent.click(screen.getByTestId('account-verify-resend'));
    await waitFor(() => expect(screen.getByTestId('account-verify-status').textContent).toMatch(/could not send it \(503\)/));
  });

  it('is not shown to a launch session, which has no email of its own yet', () => {
    useAuthStore.setState({ launch: true, registration: { dueAt: new Date(Date.now() + DAY_MS).toISOString(), required: false } });
    render(<AccountBanners />);
    expect(screen.queryByTestId('account-verify-banner')).toBeNull();
  });
});
