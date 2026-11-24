import { randomUUID } from 'node:crypto';
import { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { getStore } from '../../database/store';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SHOWN_KEY = 'signup.wizard_shown';
// Cap on how long the outbound webhook call may block a request —
// without it a hung/slow endpoint ties up the Node request indefinitely.
const WEBHOOK_TIMEOUT_MS = 5000;
export const DEFAULT_SIGNUP_WEBHOOK_URL = 'https://foxschema.com/wp-json/foxschema/v1/signup';
export const DEFAULT_CLOUDFLARE_SIGNUP_URL = 'https://fox-ui.foxschema.workers.dev/signup';

export type SignupRemoteStatus = 'pending' | 'synced' | 'local';

export interface SignupRecord {
  id: string;
  email: string;
  kind: string;
  source: string;
  remoteStatus: SignupRemoteStatus;
  remoteError: string | null;
  syncedAt: string | null;
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SignupRow {
  id: string;
  email: string;
  kind: string;
  source: string;
  remote_status: string;
  remote_error: string | null;
  synced_at: string | null;
  submission_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Where an opt-in goes: the Fox sign-up archive on foxschema.com unless
 * `SIGNUP_WEBHOOK_URL` names another (or `cloudflare` for the Fox Cloudflare
 * Worker); null when `off`. Local persistence in `email_signups` still runs
 * either way so no sign-up is lost.
 */
export function signupWebhookUrl(): string | null {
  const raw = (process.env.SIGNUP_WEBHOOK_URL ?? '').trim();
  if (raw.toLowerCase() === 'off') return null;
  if (raw.toLowerCase() === 'cloudflare') {
    const feed = (process.env.FOX_UI_FEED_URL ?? '').trim().replace(/\/+$/, '');
    return feed ? `${feed}/signup` : DEFAULT_CLOUDFLARE_SIGNUP_URL;
  }
  return raw || DEFAULT_SIGNUP_WEBHOOK_URL;
}

/**
 * First-run "stay in the loop" wizard: captures an email, saves it locally in
 * `email_signups`, forwards it to the configured signup endpoint (Cloudflare
 * Worker or WordPress webhook), and remembers (via app_settings) that the
 * wizard has been resolved (submitted OR skipped) so it never shows again.
 */
export class SignupModule {
  constructor(private appSettings: AppSettingsStore) {}

  async getState(): Promise<{ shown: boolean }> {
    return { shown: (await this.appSettings.get(SHOWN_KEY)) === 'true' };
  }

  async skip(): Promise<void> {
    await this.appSettings.set(SHOWN_KEY, 'true');
  }

  /**
   * Save `email` locally in `email_signups` and forward it to the configured
   * webhook (if enabled). Only marks the wizard as shown on a confirmed remote
   * accept (or when remote forwarding is `off`) — a transient failure leaves the
   * wizard showing next launch while still preserving the local record.
   */
  async submit(email: string, source: 'web' | 'cli' = 'web'): Promise<{ ok: boolean; error?: string }> {
    // The wizard is a one-time flow: once it's been resolved (submitted or
    // skipped) there's nothing more to forward. Short-circuiting here caps the
    // outbound side effects to essentially one per install.
    if ((await this.getState()).shown) return { ok: true };

    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) return { ok: false, error: 'Enter a valid email address.' };

    const url = signupWebhookUrl();
    const recordId = await this.saveLocal(trimmed, 'news', source, url ? 'pending' : 'local', null);

    if (url) {
      try {
        await this.postWebhook(url, trimmed, source);
        await this.markSyncResult(recordId, 'synced', null);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Could not reach the signup service';
        await this.markSyncResult(recordId, 'pending', message);
        return { ok: false, error: `Couldn't save your email right now (${message}). Try again, or skip for now.` };
      }
    }

    await this.appSettings.set(SHOWN_KEY, 'true');
    return { ok: true };
  }

  /**
   * Someone creating their account ticked "Email me Fox news". Saves their
   * email locally, forwards to the signup endpoint, and resolves the wizard so
   * it does not ask again. A remote failure is logged by the caller and never
   * blocks account creation.
   */
  async subscribeNewAccount(email: string): Promise<void> {
    const trimmed = (email ?? '').trim();
    if (!EMAIL_RE.test(trimmed)) return;
    const url = signupWebhookUrl();
    const recordId = await this.saveLocal(trimmed, 'news', 'web', url ? 'pending' : 'local', null);
    if (url) {
      try {
        await this.postWebhook(url, trimmed, 'web');
        await this.markSyncResult(recordId, 'synced', null);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.markSyncResult(recordId, 'pending', message);
        throw error;
      }
    }
    await this.appSettings.set(SHOWN_KEY, 'true');
  }

  /** List locally archived sign-ups, newest first. */
  async listSignups(): Promise<SignupRecord[]> {
    const store = await getStore();
    const rows = await store.all<SignupRow>(
      'SELECT id, email, kind, source, remote_status, remote_error, synced_at, submission_count, created_at, updated_at ' +
        'FROM email_signups ORDER BY updated_at DESC'
    );
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      kind: row.kind,
      source: row.source,
      remoteStatus: (row.remote_status as SignupRemoteStatus) || 'pending',
      remoteError: row.remote_error,
      syncedAt: row.synced_at,
      submissionCount: Number(row.submission_count) || 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Retry remote delivery for locally stored `pending` sign-ups. */
  async retryPendingSignups(): Promise<{ synced: number; failed: number }> {
    const url = signupWebhookUrl();
    if (!url) return { synced: 0, failed: 0 };
    const store = await getStore();
    const pending = await store.all<Pick<SignupRow, 'id' | 'email' | 'source'>>(
      'SELECT id, email, source FROM email_signups WHERE remote_status = ?',
      ['pending']
    );
    let synced = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        await this.postWebhook(url, row.email, row.source === 'cli' ? 'cli' : 'web');
        await this.markSyncResult(row.id, 'synced', null);
        synced += 1;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.markSyncResult(row.id, 'pending', message);
        failed += 1;
      }
    }
    return { synced, failed };
  }

  private async saveLocal(
    email: string,
    kind: string,
    source: 'web' | 'cli',
    remoteStatus: SignupRemoteStatus,
    remoteError: string | null
  ): Promise<string> {
    const store = await getStore();
    const normalized = email.trim().toLowerCase();
    const now = new Date().toISOString();
    const existing = await store.get<{ id: string }>('SELECT id FROM email_signups WHERE email = ?', [normalized]);
    if (existing) {
      await store.run(
        'UPDATE email_signups SET kind = ?, source = ?, remote_status = ?, remote_error = ?, ' +
          'submission_count = submission_count + 1, updated_at = ? WHERE id = ?',
        [kind, source, remoteStatus, remoteError, now, existing.id]
      );
      return existing.id;
    }
    const id = randomUUID();
    await store.run(
      'INSERT INTO email_signups (id, email, kind, source, remote_status, remote_error, synced_at, submission_count, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      [id, normalized, kind, source, remoteStatus, remoteError, null, now, now]
    );
    return id;
  }

  private async markSyncResult(id: string, status: SignupRemoteStatus, error: string | null): Promise<void> {
    const store = await getStore();
    const now = new Date().toISOString();
    await store.run(
      'UPDATE email_signups SET remote_status = ?, remote_error = ?, synced_at = ?, updated_at = ? WHERE id = ?',
      [status, error, status === 'synced' ? now : null, now, id]
    );
  }

  /** POST to the configured signup archive (Cloudflare Worker / foxschema.com / `SIGNUP_WEBHOOK_URL`). */
  private async postWebhook(url: string, email: string, source: 'web' | 'cli'): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.SIGNUP_WEBHOOK_SECRET ? { 'X-Foxschema-Signup-Secret': process.env.SIGNUP_WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify({ email, source }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
  }
}
