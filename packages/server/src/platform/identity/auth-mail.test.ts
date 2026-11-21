/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reset and invite codes without an SMTP relay: the Fox mail service on
 * foxschema.com, else the server log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthMailer, DEFAULT_ACCOUNT_MAIL_URL, accountMailServiceUrl } from './auth-mail';
import type { SignInSettings } from './sign-in-settings.service';

const issued = { email: 'ana@example.com', code: 'ABCD-EFGH-JKMN', expiresAt: new Date(Date.now() + 30 * 60000).toISOString() };

function mailer(publicUrl = '') {
  const settings = {
    mail: async () => null,
    publicUrl: async () => ({ url: publicUrl, source: publicUrl ? 'app' : null }),
  } as unknown as SignInSettings;
  return new AuthMailer(settings);
}

const saved = { verify: process.env.FOX_VERIFY_MAIL_URL, account: process.env.FOX_ACCOUNT_MAIL_URL };

beforeEach(() => {
  delete process.env.FOX_VERIFY_MAIL_URL;
  delete process.env.FOX_ACCOUNT_MAIL_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of [
    ['FOX_VERIFY_MAIL_URL', saved.verify],
    ['FOX_ACCOUNT_MAIL_URL', saved.account],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the Fox mail service for reset and invite codes', () => {
  it('is on by default, and off with either switch', () => {
    expect(accountMailServiceUrl()).toBe(DEFAULT_ACCOUNT_MAIL_URL);
    process.env.FOX_ACCOUNT_MAIL_URL = 'off';
    expect(accountMailServiceUrl()).toBeNull();
    delete process.env.FOX_ACCOUNT_MAIL_URL;
    process.env.FOX_VERIFY_MAIL_URL = 'off';
    expect(accountMailServiceUrl()).toBeNull();
  });

  it('sends the purpose, address, code, expiry and link, and nothing else', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const m = mailer('https://fox.example.com');
    expect(await m.delivery()).toBe('email');
    expect(await m.send('invite', issued, 'admin@example.com')).toBe('email');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(DEFAULT_ACCOUNT_MAIL_URL);
    expect(JSON.parse(init.body)).toEqual({
      purpose: 'invite',
      email: issued.email,
      code: issued.code,
      expiresAt: issued.expiresAt,
      link: 'https://fox.example.com/#invite=ABCD-EFGH-JKMN',
    });
  });

  it('leaves the link out without a public URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    await mailer().send('reset', issued);
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).not.toHaveProperty('link');
  });

  it('reports a failed send, so an admin knows the invite did not arrive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    await expect(mailer().send('invite', issued)).rejects.toThrow(/502/);
  });

  it('falls back to the server log when the service is off', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.FOX_ACCOUNT_MAIL_URL = 'off';
    const m = mailer();
    expect(await m.delivery()).toBe('log');
    expect(await m.send('reset', issued)).toBe('log');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
