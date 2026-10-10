/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sign-in settings: SSO providers and email, from the environment or the
 * admin screen. Secrets are stored encrypted and never read back out; the
 * environment wins and cannot be changed from the screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY ||= '0'.repeat(64);

import { normalizePublicUrl, SignInSettings } from './sign-in-settings.service';
import { getStore } from '../../database/store';

const ENV_KEYS = [
  'SSO_GOOGLE_CLIENT_ID',
  'SSO_GOOGLE_CLIENT_SECRET',
  'SMTP_HOST',
  'SMTP_FROM',
  'APP_PUBLIC_URL',
  'SSO_REDIRECT_BASE',
];
const saved: Record<string, string | undefined> = {};
const settings = new SignInSettings();

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const store = await getStore();
  await store.run(`DELETE FROM app_settings WHERE "key" LIKE 'auth.%'`);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('SSO providers', () => {
  it('stores a provider from the screen, encrypted, and never shows its secret again', async () => {
    expect(await settings.providers()).toEqual([]);
    await settings.saveProvider('github', { clientId: 'gh-id', clientSecret: 'gh-very-secret' });

    const github = await settings.provider('github');
    expect(github).toMatchObject({ clientId: 'gh-id', clientSecret: 'gh-very-secret', source: 'app' });

    const raw = await (await getStore()).get<{ value: string }>(
      `SELECT "value" FROM app_settings WHERE "key" = 'auth.sso.github'`
    );
    expect(raw?.value).not.toContain('gh-very-secret');
    expect(JSON.stringify(await settings.summary())).not.toContain('gh-very-secret');

    // Saving without a secret keeps the one stored.
    await settings.saveProvider('github', { clientId: 'gh-id-2' });
    expect(await settings.provider('github')).toMatchObject({ clientId: 'gh-id-2', clientSecret: 'gh-very-secret' });

    await settings.removeProvider('github');
    expect(await settings.provider('github')).toBeNull();
  });

  it('prefers the environment, and refuses to edit what it sets', async () => {
    process.env.SSO_GOOGLE_CLIENT_ID = 'env-id';
    process.env.SSO_GOOGLE_CLIENT_SECRET = 'env-secret';
    expect(await settings.provider('google')).toMatchObject({ clientId: 'env-id', source: 'env' });
    await expect(settings.saveProvider('google', { clientId: 'x', clientSecret: 'y' })).rejects.toThrow(
      /environment variables/
    );
  });

  it('needs a secret the first time', async () => {
    await expect(settings.saveProvider('google', { clientId: 'id' })).rejects.toThrow(/secret is required/);
  });
});

describe('email', () => {
  it('stores the relay with its password encrypted', async () => {
    expect(await settings.mail()).toBeNull();
    await settings.saveMail({
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      username: 'fox',
      password: 'smtp-secret',
      from: 'Fox <fox@example.com>',
    });
    expect((await settings.mail())?.smtp).toMatchObject({ host: 'smtp.example.com', password: 'smtp-secret' });
    const summary = await settings.summary();
    expect(summary.mail).toMatchObject({ configured: true, hasPassword: true, source: 'app' });
    expect(JSON.stringify(summary)).not.toContain('smtp-secret');
  });

  it('refuses a bad sender or port', async () => {
    await expect(settings.saveMail({ host: 'h', port: 587, from: 'not an address' })).rejects.toThrow(/Sender/);
    await expect(settings.saveMail({ host: 'h', port: 0, from: 'a@b.com' })).rejects.toThrow(/Port/);
  });
});

describe('public URL', () => {
  it('keeps the origin and path, and refuses anything that is not a plain http(s) URL', () => {
    expect(normalizePublicUrl('https://fox.example.com/')).toBe('https://fox.example.com');
    expect(normalizePublicUrl('https://example.com/fox/')).toBe('https://example.com/fox');
    expect(normalizePublicUrl('')).toBe('');
    expect(() => normalizePublicUrl('javascript:alert(1)')).toThrow(/https/);
    expect(() => normalizePublicUrl('https://user:pw@fox.example.com')).toThrow(/user name/);
    expect(() => normalizePublicUrl('fox.example.com')).toThrow(/full URL/);
  });

  it('comes from the environment first', async () => {
    await settings.savePublicUrl('https://screen.example.com');
    expect(await settings.publicUrl()).toEqual({ url: 'https://screen.example.com', source: 'app' });
    process.env.APP_PUBLIC_URL = 'https://env.example.com/';
    expect(await settings.publicUrl()).toEqual({ url: 'https://env.example.com', source: 'env' });
  });
});
