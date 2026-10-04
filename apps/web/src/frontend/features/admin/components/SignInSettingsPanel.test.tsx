/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin → Sign-in. Secrets are write-only: an empty secret on save keeps the
 * stored one, and what the server environment sets cannot be edited here.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiSignInSettings = vi.fn();
const apiSaveSsoProvider = vi.fn();
const apiSaveMailSettings = vi.fn();
const apiSetSignInService = vi.fn();
const apiSetSignInServiceAdmins = vi.fn();

vi.mock('@/shared/api/authApi', () => ({
  apiSignInSettings: (...a: unknown[]) => apiSignInSettings(...a),
  apiSaveSsoProvider: (...a: unknown[]) => apiSaveSsoProvider(...a),
  apiSaveMailSettings: (...a: unknown[]) => apiSaveMailSettings(...a),
  apiRemoveSsoProvider: vi.fn(),
  apiRemoveMailSettings: vi.fn(),
  apiSavePublicUrl: vi.fn(),
  apiSendTestEmail: vi.fn(),
  apiSetSignInService: (...a: unknown[]) => apiSetSignInService(...a),
  apiSetSignInServiceAdmins: (...a: unknown[]) => apiSetSignInServiceAdmins(...a),
}));

import { SignInSettingsPanel } from './SignInSettingsPanel';

const provider = (id: string, label: string, extra: object = {}) => ({
  id,
  label,
  configured: false,
  source: null,
  clientId: '',
  hasSecret: false,
  redirectUri: `https://fox.example.com/api/auth/sso/${id}/callback`,
  ...extra,
});

beforeEach(() => {
  apiSignInSettings.mockReset();
  apiSaveSsoProvider.mockReset().mockResolvedValue(undefined);
  apiSaveMailSettings.mockReset().mockResolvedValue(undefined);
  apiSignInSettings.mockResolvedValue({
    publicUrl: 'https://fox.example.com',
    publicUrlSource: 'app',
    providers: [
      provider('google', 'Google', { configured: true, source: 'env', clientId: 'env-id', hasSecret: true }),
      provider('microsoft', 'Microsoft', { tenant: '' }),
      provider('github', 'GitHub', { configured: true, source: 'app', clientId: 'gh', hasSecret: true }),
    ],
    mail: { configured: false, source: null, host: '', port: 587, security: 'starttls', username: '', hasPassword: false, from: '' },
    broker: { enabled: false, source: null, url: 'https://foxschema.com/wp-json/foxschema/v1/sso', admins: true, adminsSource: null },
  });
  apiSetSignInService.mockReset().mockResolvedValue(undefined);
});

describe('sign-in settings', () => {
  it('shows each provider with its redirect URL, and locks what the server environment sets', async () => {
    render(<SignInSettingsPanel />);
    const google = await screen.findByTestId('sign-in-provider-google');
    expect(google.textContent).toMatch(/server env/i);
    expect((screen.getByLabelText('Client ID', { selector: '#sso-google-client' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('sign-in-provider-github').textContent).toContain(
      'https://fox.example.com/api/auth/sso/github/callback'
    );
  });

  it('keeps a stored secret when saved with the secret field empty', async () => {
    render(<SignInSettingsPanel />);
    const github = await screen.findByTestId('sign-in-provider-github');
    fireEvent.change(screen.getByLabelText('Client ID', { selector: '#sso-github-client' }), { target: { value: 'gh-2' } });
    fireEvent.click(github.querySelector('button.accent-grad')!);
    await waitFor(() => expect(apiSaveSsoProvider).toHaveBeenCalledWith('github', { clientId: 'gh-2' }));
  });

  it('fills a relay preset and saves email settings', async () => {
    render(<SignInSettingsPanel />);
    await screen.findByTestId('sign-in-mail');
    fireEvent.click(screen.getByRole('button', { name: 'Hostinger' }));
    expect((screen.getByLabelText(/smtp host/i) as HTMLInputElement).value).toBe('smtp.hostinger.com');
    expect((screen.getByLabelText(/^port$/i) as HTMLInputElement).value).toBe('465');
    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText(/send as/i), { target: { value: 'Fox <me@example.com>' } });
    fireEvent.click(screen.getByTestId('sign-in-mail').querySelector('button.accent-grad')!);
    await waitFor(() =>
      expect(apiSaveMailSettings).toHaveBeenCalledWith({
        host: 'smtp.hostinger.com',
        port: 465,
        security: 'tls',
        username: 'me@example.com',
        from: 'Fox <me@example.com>',
      })
    );
  });

  it('turns the Fox sign-in service on only when the admin ticks it, after saying what it trusts', async () => {
    render(<SignInSettingsPanel />);
    const section = await screen.findByTestId('sign-in-service');
    expect(section.textContent).toMatch(/trusting foxschema.com to say who is signing in/);
    const toggle = screen.getByTestId('sign-in-service-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(apiSetSignInService).toHaveBeenCalledWith(true));
  });

  it('lets an admin keep admin accounts off the Fox sign-in service while it is on', async () => {
    apiSignInSettings.mockResolvedValue({
      ...(await apiSignInSettings()),
      broker: { enabled: true, source: 'app', url: 'https://foxschema.com/wp-json/foxschema/v1/sso', admins: true, adminsSource: null },
    });
    render(<SignInSettingsPanel />);
    const admins = (await screen.findByTestId('sign-in-service-admins')) as HTMLInputElement;
    expect(admins.checked).toBe(true);
    fireEvent.click(admins);
    await waitFor(() => expect(apiSetSignInServiceAdmins).toHaveBeenCalledWith(false));
  });
});
