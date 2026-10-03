/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * How people sign in, as an admin configured it.
 *
 * Three things: the SSO providers (Google, Microsoft, GitHub), the SMTP relay
 * that sends password-reset and invite emails, and the public URL those emails
 * link to. Each can come from environment variables — for Docker and servers —
 * or from the admin screen, for the desktop app where there is no environment
 * to edit. Environment wins, and an item set there is read-only on screen.
 *
 * Stored in `app_settings` as JSON; client secrets and the SMTP password are
 * encrypted with the install key, and nothing here ever returns them.
 */
import type { SmtpOptions, SmtpSecurity } from '@foxschema/db/mail';
import { AppSettingsStore } from '../admin/app-settings.service';
import { decryptSecret, encryptSecret } from '../../platform/crypto/crypto';
import { brokerUrl } from './sso-broker';

export type SsoProviderId = 'google' | 'microsoft' | 'github';
export const SSO_PROVIDER_IDS: SsoProviderId[] = ['google', 'microsoft', 'github'];

const LABELS: Record<SsoProviderId, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub' };
const ENV: Record<SsoProviderId, { id: string; secret: string; tenant?: string }> = {
  google: { id: 'SSO_GOOGLE_CLIENT_ID', secret: 'SSO_GOOGLE_CLIENT_SECRET' },
  microsoft: {
    id: 'SSO_MICROSOFT_CLIENT_ID',
    secret: 'SSO_MICROSOFT_CLIENT_SECRET',
    tenant: 'SSO_MICROSOFT_TENANT',
  },
  github: { id: 'SSO_GITHUB_CLIENT_ID', secret: 'SSO_GITHUB_CLIENT_SECRET' },
};

export type SettingSource = 'env' | 'app';

export interface SsoProviderConfig {
  id: SsoProviderId;
  label: string;
  clientId: string;
  clientSecret: string;
  /** Microsoft only: a tenant id or domain, or `common` / `organizations` / `consumers`. */
  tenant?: string;
  source: SettingSource;
}

export interface MailConfig {
  smtp: SmtpOptions;
  /** The sender, e.g. `Fox <fox@example.com>`. */
  from: string;
  source: SettingSource;
}

/** What the admin screen may see: no secret, only whether one is set. */
export interface SsoProviderSummary {
  id: SsoProviderId;
  label: string;
  configured: boolean;
  source: SettingSource | null;
  clientId: string;
  hasSecret: boolean;
  tenant?: string;
}

export interface MailSummary {
  configured: boolean;
  source: SettingSource | null;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  hasPassword: boolean;
  from: string;
}

export interface BrokerSummary {
  /** Google / GitHub through the Fox sign-in service on foxschema.com. */
  enabled: boolean;
  source: SettingSource | null;
  url: string;
  /** Whether admin accounts may sign in through it. */
  admins: boolean;
  adminsSource: SettingSource | null;
}

export interface SignInSettingsSummary {
  publicUrl: string;
  publicUrlSource: SettingSource | null;
  providers: SsoProviderSummary[];
  mail: MailSummary;
  broker: BrokerSummary;
}

interface StoredProvider {
  clientId: string;
  secret: string;
  tenant?: string;
}

interface StoredMail {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
  from: string;
}

const providerKey = (id: SsoProviderId) => `auth.sso.${id}`;
const MAIL_KEY = 'auth.mail';
const PUBLIC_URL_KEY = 'auth.public_url';
const BROKER_KEY = 'auth.broker';
const BROKER_ADMINS_KEY = 'auth.broker.admins';
const SECURITIES: SmtpSecurity[] = ['tls', 'starttls', 'none'];

function env(name: string | undefined): string {
  return name ? (process.env[name] ?? '').trim() : '';
}

function parse<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function isSsoProviderId(id: string): id is SsoProviderId {
  return (SSO_PROVIDER_IDS as string[]).includes(id);
}

/** A public URL an email may link to: http(s), no path beyond `/`, no credentials. */
export function normalizePublicUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter a full URL, such as https://fox.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The URL must start with https://.');
  if (url.username || url.password) throw new Error('The URL must not contain a user name or password.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class SignInSettings {
  constructor(private settings = new AppSettingsStore()) {}

  private envProvider(id: SsoProviderId): SsoProviderConfig | null {
    const names = ENV[id];
    const clientId = env(names.id);
    const clientSecret = env(names.secret);
    if (!clientId || !clientSecret) return null;
    return {
      id,
      label: LABELS[id],
      clientId,
      clientSecret,
      tenant: names.tenant ? env(names.tenant) || 'common' : undefined,
      source: 'env',
    };
  }

  private async storedProvider(id: SsoProviderId): Promise<StoredProvider | null> {
    return parse<StoredProvider>(await this.settings.get(providerKey(id)));
  }

  /** One provider with its secret, for the sign-in flow; null when not configured. */
  async provider(id: string): Promise<SsoProviderConfig | null> {
    if (!isSsoProviderId(id)) return null;
    const fromEnv = this.envProvider(id);
    if (fromEnv) return fromEnv;
    const stored = await this.storedProvider(id);
    if (!stored?.clientId || !stored.secret) return null;
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(stored.secret);
    } catch {
      return null; // encrypted under another key: treat as not configured
    }
    return {
      id,
      label: LABELS[id],
      clientId: stored.clientId,
      clientSecret,
      tenant: id === 'microsoft' ? stored.tenant || 'common' : undefined,
      source: 'app',
    };
  }

  /** The configured providers, in button order. */
  async providers(): Promise<SsoProviderConfig[]> {
    const all = await Promise.all(SSO_PROVIDER_IDS.map((id) => this.provider(id)));
    return all.filter((p): p is SsoProviderConfig => p !== null);
  }

  async saveProvider(
    id: SsoProviderId,
    input: { clientId?: string; clientSecret?: string; tenant?: string }
  ): Promise<void> {
    if (this.envProvider(id)) throw new Error(`${LABELS[id]} is set by environment variables on the server.`);
    const clientId = (input.clientId ?? '').trim();
    if (!clientId) throw new Error('Client ID is required.');
    const existing = await this.storedProvider(id);
    const newSecret = (input.clientSecret ?? '').trim();
    const secret = newSecret ? encryptSecret(newSecret) : existing?.secret;
    if (!secret) throw new Error('Client secret is required.');
    const tenant = (input.tenant ?? '').trim();
    if (tenant && !/^[A-Za-z0-9.-]+$/.test(tenant)) throw new Error('Tenant must be a tenant id or domain.');
    const stored: StoredProvider = { clientId, secret, ...(id === 'microsoft' && tenant ? { tenant } : {}) };
    await this.settings.set(providerKey(id), JSON.stringify(stored));
  }

  async removeProvider(id: SsoProviderId): Promise<void> {
    await this.settings.set(providerKey(id), '');
  }

  private envMail(): MailConfig | null {
    const host = env('SMTP_HOST');
    const from = env('SMTP_FROM');
    if (!host || !from) return null;
    const security = (env('SMTP_SECURITY') || 'starttls') as SmtpSecurity;
    return {
      smtp: {
        host,
        port: Number(env('SMTP_PORT')) || (security === 'tls' ? 465 : 587),
        security: SECURITIES.includes(security) ? security : 'starttls',
        username: env('SMTP_USERNAME') || undefined,
        password: env('SMTP_PASSWORD') || undefined,
      },
      from,
      source: 'env',
    };
  }

  /** How to send email, or null when no relay is configured. */
  async mail(): Promise<MailConfig | null> {
    const fromEnv = this.envMail();
    if (fromEnv) return fromEnv;
    const stored = parse<StoredMail>(await this.settings.get(MAIL_KEY));
    if (!stored?.host || !stored.from) return null;
    let password: string | undefined;
    try {
      password = stored.password ? decryptSecret(stored.password) : undefined;
    } catch {
      return null;
    }
    return {
      smtp: { host: stored.host, port: stored.port, security: stored.security, username: stored.username, password },
      from: stored.from,
      source: 'app',
    };
  }

  async saveMail(input: {
    host?: string;
    port?: number;
    security?: string;
    username?: string;
    password?: string;
    from?: string;
  }): Promise<void> {
    if (this.envMail()) throw new Error('Email is set by environment variables on the server.');
    const host = (input.host ?? '').trim();
    const from = (input.from ?? '').trim();
    const security = (input.security ?? 'starttls') as SmtpSecurity;
    const port = Number(input.port);
    if (!host) throw new Error('SMTP host is required.');
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(from.replace(/^.*<([^>]+)>\s*$/, '$1'))) {
      throw new Error('Sender must be an email address, optionally with a name: Fox <fox@example.com>.');
    }
    if (!SECURITIES.includes(security)) throw new Error('Security must be tls, starttls or none.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    const existing = parse<StoredMail>(await this.settings.get(MAIL_KEY));
    const newPassword = input.password ?? '';
    const stored: StoredMail = {
      host,
      port,
      security,
      username: (input.username ?? '').trim() || undefined,
      password: newPassword ? encryptSecret(newPassword) : existing?.password,
      from,
    };
    await this.settings.set(MAIL_KEY, JSON.stringify(stored));
  }

  async removeMail(): Promise<void> {
    await this.settings.set(MAIL_KEY, '');
  }

  /**
   * The address people reach this install at, for links in emails and SSO
   * callbacks. Empty when nobody set it: emails then carry the code alone,
   * because a link built from the request's Host header would let anyone who
   * can send a request choose where a victim's reset link points.
   */
  async publicUrl(): Promise<{ url: string; source: SettingSource | null }> {
    const fromEnv = env('APP_PUBLIC_URL') || env('SSO_REDIRECT_BASE');
    if (fromEnv) return { url: normalizePublicUrl(fromEnv), source: 'env' };
    const stored = (await this.settings.get(PUBLIC_URL_KEY)) ?? '';
    return { url: stored, source: stored ? 'app' : null };
  }

  async savePublicUrl(raw: string): Promise<void> {
    if (env('APP_PUBLIC_URL') || env('SSO_REDIRECT_BASE')) {
      throw new Error('The public URL is set by environment variables on the server.');
    }
    await this.settings.set(PUBLIC_URL_KEY, normalizePublicUrl(raw));
  }

  /**
   * Whether this install signs people in with Google / GitHub through the
   * Fox sign-in service. Off until an admin turns it on (or FOX_SSO_BROKER=on):
   * it means trusting foxschema.com to say who is signing in.
   */
  async broker(): Promise<{ enabled: boolean; source: SettingSource | null }> {
    const fromEnv = env('FOX_SSO_BROKER').toLowerCase();
    if (fromEnv === 'on' || fromEnv === 'true') return { enabled: true, source: 'env' };
    if (fromEnv === 'off' || fromEnv === 'false') return { enabled: false, source: 'env' };
    const stored = await this.settings.get(BROKER_KEY);
    return { enabled: stored === 'on', source: stored ? 'app' : null };
  }

  async setBroker(enabled: boolean): Promise<void> {
    if (env('FOX_SSO_BROKER')) throw new Error('The Fox sign-in service is set by FOX_SSO_BROKER on the server.');
    await this.settings.set(BROKER_KEY, enabled ? 'on' : 'off');
  }

  /**
   * Whether admin accounts may sign in through the Fox sign-in service. On by
   * default; turned off, whoever controls foxschema.com or its signing key
   * still cannot sign in as an admin here, only as people with less power.
   * FOX_SSO_BROKER_ADMINS=off sets it on the server.
   */
  async brokerAdmins(): Promise<{ allowed: boolean; source: SettingSource | null }> {
    const fromEnv = env('FOX_SSO_BROKER_ADMINS').toLowerCase();
    if (fromEnv === 'on' || fromEnv === 'true') return { allowed: true, source: 'env' };
    if (fromEnv === 'off' || fromEnv === 'false') return { allowed: false, source: 'env' };
    const stored = await this.settings.get(BROKER_ADMINS_KEY);
    return { allowed: stored !== 'off', source: stored ? 'app' : null };
  }

  async setBrokerAdmins(allowed: boolean): Promise<void> {
    if (env('FOX_SSO_BROKER_ADMINS')) throw new Error('Whether admins may use the Fox sign-in service is set by FOX_SSO_BROKER_ADMINS on the server.');
    await this.settings.set(BROKER_ADMINS_KEY, allowed ? 'on' : 'off');
  }

  async summary(): Promise<SignInSettingsSummary> {
    const { url, source } = await this.publicUrl();
    const providers = await Promise.all(
      SSO_PROVIDER_IDS.map(async (id): Promise<SsoProviderSummary> => {
        const fromEnv = this.envProvider(id);
        const stored = fromEnv ? null : await this.storedProvider(id);
        const active = await this.provider(id);
        return {
          id,
          label: LABELS[id],
          configured: !!active,
          source: fromEnv ? 'env' : stored?.clientId ? 'app' : null,
          clientId: fromEnv?.clientId ?? stored?.clientId ?? '',
          hasSecret: !!(fromEnv?.clientSecret || stored?.secret),
          ...(id === 'microsoft' ? { tenant: fromEnv?.tenant ?? stored?.tenant ?? '' } : {}),
        };
      })
    );
    const envMail = this.envMail();
    const storedMail = envMail ? null : parse<StoredMail>(await this.settings.get(MAIL_KEY));
    const mailSmtp = envMail?.smtp ?? storedMail;
    const mail: MailSummary = {
      configured: !!(await this.mail()),
      source: envMail ? 'env' : storedMail?.host ? 'app' : null,
      host: mailSmtp?.host ?? '',
      port: mailSmtp?.port ?? 587,
      security: mailSmtp?.security ?? 'starttls',
      username: mailSmtp?.username ?? '',
      hasPassword: !!mailSmtp?.password,
      from: envMail?.from ?? storedMail?.from ?? '',
    };
    const broker = await this.broker();
    const admins = await this.brokerAdmins();
    return {
      publicUrl: url,
      publicUrlSource: source,
      providers,
      mail,
      broker: { ...broker, url: brokerUrl(), admins: admins.allowed, adminsSource: admins.source },
    };
  }
}
