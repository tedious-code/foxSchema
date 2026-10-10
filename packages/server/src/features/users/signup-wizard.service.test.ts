import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.APP_DB_PATH = ':memory:';
process.env.APP_ENCRYPTION_KEY = '0'.repeat(64);

import { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { SignupModule } from './signup-wizard.service';

const appSettings = new AppSettingsStore();
const signup = new SignupModule(appSettings);

describe('SignupModule', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.SIGNUP_WEBHOOK_URL;
    delete process.env.SIGNUP_WEBHOOK_SECRET;
    // Each test's assertions assume a fresh "not yet resolved" wizard — reset
    // the shared in-memory app_settings row rather than isolating per-test DBs.
    await appSettings.set('signup.wizard_shown', 'false');
  });

  it('starts unshown', async () => {
    expect(await signup.getState()).toEqual({ shown: false });
  });

  it('skip() marks the wizard shown without any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await signup.skip();
    expect(await signup.getState()).toEqual({ shown: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed email without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.SIGNUP_WEBHOOK_URL = 'https://example.com/hook';
    const result = await signup.submit('not-an-email', 'web');
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submit() resolves the wizard immediately when no webhook is configured', async () => {
    const result = await signup.submit('dev@example.com', 'web');
    expect(result).toEqual({ ok: true });
    expect(await signup.getState()).toEqual({ shown: true });
  });

  it('submit() posts to the configured webhook with the secret header and marks shown on success', async () => {
    process.env.SIGNUP_WEBHOOK_URL = 'https://example.com/hook';
    process.env.SIGNUP_WEBHOOK_SECRET = 's3cret';
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await signup.submit('  New@Example.com  ', 'web');

    expect(result).toEqual({ ok: true });
    expect(await signup.getState()).toEqual({ shown: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Foxschema-Signup-Secret': 's3cret' }),
        body: JSON.stringify({ email: 'New@Example.com', source: 'web' }),
      })
    );
  });

  it('submit() leaves the wizard showing (not marked shown) when the webhook call fails', async () => {
    process.env.SIGNUP_WEBHOOK_URL = 'https://example.com/hook';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await signup.submit('retry@example.com', 'web');

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(await signup.getState()).toEqual({ shown: false });
  });

  it('submit() leaves the wizard showing when the webhook is unreachable', async () => {
    process.env.SIGNUP_WEBHOOK_URL = 'https://example.com/hook';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await signup.submit('offline@example.com', 'web');

    expect(result.ok).toBe(false);
    expect(await signup.getState()).toEqual({ shown: false });
  });

  it('submit() short-circuits (no webhook forward) once the wizard is already resolved', async () => {
    process.env.SIGNUP_WEBHOOK_URL = 'https://example.com/hook';
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    await signup.skip(); // resolve the wizard

    const result = await signup.submit('late@example.com', 'web');

    // Caps external side effects to ~one per install: an already-resolved
    // install can't be driven to POST again to WordPress / send more emails.
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submit() aborts the webhook call with a timeout signal', async () => {
    process.env.SIGNUP_WEBHOOK_URL = 'https://example.com/hook';
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);

    await signup.submit('timeout@example.com', 'web');

    const opts = fetchSpy.mock.calls[0][1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
