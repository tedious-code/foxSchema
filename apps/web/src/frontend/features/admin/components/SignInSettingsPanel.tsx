/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin → Sign-in: Google / Microsoft / GitHub sign-in, the email relay that
 * sends invite and reset codes, and the public URL their links point to.
 *
 * Secrets are write-only: the server says whether one is stored, never what
 * it is, so an empty secret field on save keeps the stored one. Anything set
 * by environment variables on the server is shown read-only.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import {
  apiRemoveMailSettings,
  apiRemoveSsoProvider,
  apiSaveMailSettings,
  apiSavePublicUrl,
  apiSaveSsoProvider,
  apiSendTestEmail,
  apiSetSignInService,
  apiSetSignInServiceAdmins,
  apiSignInSettings,
  type MailSettings,
  type SignInSettingsState,
  type SsoProviderSettings,
} from '@/shared/api/authApi';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { useAuthStore } from '@/app/store/authStore';

const inputCls =
  'w-full rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs outline-none accent-focus disabled:opacity-60';
const labelCls = 'text-[10px] font-semibold uppercase tracking-wider text-slate-400';
const buttonCls =
  'rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40';
const primaryCls = 'rounded-md accent-grad on-accent-fg px-3 py-1 text-xs font-bold disabled:opacity-60';

/** Where to create each provider's OAuth app. */
const CONSOLES: Record<SsoProviderSettings['id'], { url: string; name: string }> = {
  google: { url: 'https://console.cloud.google.com/apis/credentials', name: 'Google Cloud console → Credentials' },
  microsoft: {
    url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    name: 'Microsoft Entra → App registrations',
  },
  github: { url: 'https://github.com/settings/developers', name: 'GitHub → Settings → Developer settings → OAuth Apps' },
};

/** Common relays, to fill host, port and security in one click. */
const MAIL_PRESETS: Array<{ label: string; host: string; port: number; security: MailSettings['security'] }> = [
  { label: 'Hostinger', host: 'smtp.hostinger.com', port: 465, security: 'tls' },
  { label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  { label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls' },
];

const Status: React.FC<{ configured: boolean; source: 'env' | 'app' | null }> = ({ configured, source }) => (
  <span
    className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-1.5 py-0.5 border ${
      configured ? 'text-emerald-300 border-emerald-500/30' : 'text-slate-500 border-slate-700'
    }`}
  >
    {configured ? (source === 'env' ? 'On · server env' : 'On') : 'Off'}
  </span>
);

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="text-slate-400 hover:text-slate-100"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

export const SignInSettingsPanel: React.FC = () => {
  const [state, setState] = useState<SignInSettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await apiSignInSettings());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load sign-in settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a save, then reload so the screen shows what the server now has. */
  const run = async (action: () => Promise<void>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  if (!state) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400 py-8 justify-center">
        {error ?? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </>
        )}
      </div>
    );
  }

  return (
    <div data-testid="admin-sign-in-settings" className="space-y-4">
      <p className="text-[11px] text-slate-400 leading-snug">
        How people sign in. Everyone needs an account an admin invited; Google, Microsoft and GitHub sign
        in an existing account whose email the provider has verified.
      </p>
      {error && (
        <div role="alert" className="text-xs text-rose-300 border border-rose-500/30 bg-rose-950/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      {notice && <div className="text-xs text-emerald-300">{notice}</div>}

      <SignInServiceSection state={state} run={run} />

      <PublicUrlSection state={state} run={run} />

      <section className="space-y-2">
        <h3 className="text-xs font-bold text-slate-200">Sign in with…</h3>
        {state.providers.map((p) => (
          <ProviderCard key={p.id} provider={p} run={run} />
        ))}
      </section>

      <MailSection mail={state.mail} run={run} />
    </div>
  );
};

type Run = (action: () => Promise<void>, done: string) => Promise<void>;

/**
 * Google and GitHub with no OAuth app of your own, through foxschema.com.
 * Off by default: turning it on trusts foxschema.com to say who is signing in.
 */
const SignInServiceSection: React.FC<{ state: SignInSettingsState; run: Run }> = ({ state, run }) => {
  const { enabled, source } = state.broker;
  const locked = source === 'env';
  return (
    <section data-testid="sign-in-service" className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-bold text-slate-200 flex-1">Google and GitHub through foxschema.com</h3>
        <Status configured={enabled} source={source} />
      </div>
      <p className="text-[11px] text-slate-400 leading-snug">
        Sign in with Google or GitHub without creating your own OAuth apps. foxschema.com does the sign-in
        and sends back a signed, single-use confirmation of the verified email; this install still decides
        who has an account. Turning it on means <b className="text-slate-200">trusting foxschema.com to say
        who is signing in</b>, and it sees the emails used (it does not keep them). Your own Google or
        GitHub app, if set below, is used instead.
      </p>
      {!locked && (
        <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
          <input
            type="checkbox"
            data-testid="sign-in-service-toggle"
            checked={enabled}
            onChange={(e) =>
              void run(
                () => apiSetSignInService(e.target.checked),
                e.target.checked ? 'Google and GitHub sign-in through foxschema.com is on.' : 'Sign-in through foxschema.com is off.'
              )
            }
          />
          Use the Fox sign-in service
        </label>
      )}
      {locked && <p className="text-[11px] text-slate-500">Set on the server (FOX_SSO_BROKER).</p>}
      {enabled && (
        <div className="space-y-1">
          {state.broker.adminsSource !== 'env' ? (
            <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                data-testid="sign-in-service-admins"
                checked={state.broker.admins}
                onChange={(e) =>
                  void run(
                    () => apiSetSignInServiceAdmins(e.target.checked),
                    e.target.checked ? 'Admins can sign in through foxschema.com.' : 'Admins now sign in with a password or this install’s own apps.'
                  )
                }
              />
              Let admin accounts sign in through it
            </label>
          ) : (
            <p className="text-[11px] text-slate-500">
              Admin accounts {state.broker.admins ? 'may' : 'may not'} use it (FOX_SSO_BROKER_ADMINS).
            </p>
          )}
          <p className="text-[11px] text-slate-500 leading-snug">
            Off, whoever controls foxschema.com or its signing key cannot sign in as an admin here.
          </p>
        </div>
      )}
    </section>
  );
};

const PublicUrlSection: React.FC<{ state: SignInSettingsState; run: Run }> = ({ state, run }) => {
  const [url, setUrl] = useState(state.publicUrl);
  const locked = state.publicUrlSource === 'env';
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 space-y-1.5">
      <label htmlFor="sign-in-public-url" className={labelCls}>
        Public URL
      </label>
      <div className="flex gap-2">
        <input
          id="sign-in-public-url"
          value={url}
          disabled={locked}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://fox.example.com"
          className={inputCls}
        />
        {!locked && (
          <button type="button" className={buttonCls} onClick={() => void run(() => apiSavePublicUrl(url), 'Public URL saved.')}>
            Save
          </button>
        )}
      </div>
      <p className="text-[11px] text-slate-500">
        Where people reach Fox. Invite and reset emails link here, and SSO providers send people back here.
        {locked && ' Set on the server (APP_PUBLIC_URL).'}
      </p>
    </section>
  );
};

const ProviderCard: React.FC<{ provider: SsoProviderSettings; run: Run }> = ({ provider: p, run }) => {
  const [clientId, setClientId] = useState(p.clientId);
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState(p.tenant ?? '');
  const locked = p.source === 'env';
  const providerConsole = CONSOLES[p.id];
  const save = () =>
    run(
      () => apiSaveSsoProvider(p.id, { clientId, ...(secret ? { clientSecret: secret } : {}), ...(p.id === 'microsoft' ? { tenant } : {}) }),
      `${p.label} sign-in saved.`
    ).then(() => setSecret(''));

  return (
    <div data-testid={`sign-in-provider-${p.id}`} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-200 flex-1">{p.label}</span>
        <Status configured={p.configured} source={p.source} />
      </div>
      <p className="text-[11px] text-slate-500">
        Create an OAuth app in{' '}
        <a href={providerConsole.url} target="_blank" rel="noreferrer noopener" className="underline hover:text-slate-300">
          {providerConsole.name}
        </a>{' '}
        with this redirect URL:
      </p>
      <div className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-2 py-1">
        <code className="flex-1 break-all font-mono text-[11px] text-slate-300">{p.redirectUri}</code>
        <CopyText text={p.redirectUri} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`sso-${p.id}-client`} className={labelCls}>
            Client ID
          </label>
          <input id={`sso-${p.id}-client`} value={clientId} disabled={locked} onChange={(e) => setClientId(e.target.value)} className={inputCls} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`sso-${p.id}-secret`} className={labelCls}>
            Client secret
          </label>
          <PasswordInput
            id={`sso-${p.id}-secret`}
            value={secret}
            disabled={locked}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={p.hasSecret ? 'Stored — leave empty to keep' : ''}
            autoComplete="off"
            className={inputCls}
          />
        </div>
        {p.id === 'microsoft' && (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor="sso-microsoft-tenant" className={labelCls}>
              Tenant (directory) ID
            </label>
            <input
              id="sso-microsoft-tenant"
              value={tenant}
              disabled={locked}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="common"
              className={inputCls}
            />
            <p className="text-[11px] text-slate-500">
              Empty or <code>common</code>: personal Microsoft accounts only, plus work accounts whose domain
              Microsoft has verified. Enter your organization's tenant ID to let its work accounts sign in.
            </p>
          </div>
        )}
      </div>
      {!locked && (
        <div className="flex gap-2">
          <button type="button" className={primaryCls} onClick={() => void save()}>
            Save
          </button>
          {p.configured && (
            <button
              type="button"
              className={buttonCls}
              onClick={() => void run(() => apiRemoveSsoProvider(p.id), `${p.label} sign-in turned off.`)}
            >
              Turn off
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const MailSection: React.FC<{ mail: MailSettings; run: Run }> = ({ mail, run }) => {
  const me = useAuthStore((s) => s.user?.email ?? '');
  const [host, setHost] = useState(mail.host);
  const [port, setPort] = useState(String(mail.port || 587));
  const [security, setSecurity] = useState<MailSettings['security']>(mail.security);
  const [username, setUsername] = useState(mail.username);
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(mail.from);
  const [testTo, setTestTo] = useState(me);
  const locked = mail.source === 'env';

  const preset = (label: string) => {
    const p = MAIL_PRESETS.find((x) => x.label === label);
    if (!p) return;
    setHost(p.host);
    setPort(String(p.port));
    setSecurity(p.security);
  };

  const save = () =>
    run(
      () =>
        apiSaveMailSettings({
          host,
          port: Number(port),
          security,
          username,
          ...(password ? { password } : {}),
          from,
        }),
      'Email settings saved.'
    ).then(() => setPassword(''));

  return (
    <section data-testid="sign-in-mail" className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-bold text-slate-200 flex-1">Email for invites and password resets</h3>
        <Status configured={mail.configured} source={mail.source} />
      </div>
      <p className="text-[11px] text-slate-500">
        Without email, invite and reset codes are shown to you here and written to the server log.
      </p>
      {!locked && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500">Fill in for:</span>
          {MAIL_PRESETS.map((p) => (
            <button key={p.label} type="button" className={buttonCls} onClick={() => preset(p.label)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-4">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="mail-host" className={labelCls}>
            SMTP host
          </label>
          <input id="mail-host" value={host} disabled={locked} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" className={inputCls} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="mail-port" className={labelCls}>
            Port
          </label>
          <input id="mail-port" inputMode="numeric" value={port} disabled={locked} onChange={(e) => setPort(e.target.value)} className={inputCls} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="mail-security" className={labelCls}>
            Security
          </label>
          <select
            id="mail-security"
            value={security}
            disabled={locked}
            onChange={(e) => setSecurity(e.target.value as MailSettings['security'])}
            className={inputCls}
          >
            <option value="tls">TLS (465)</option>
            <option value="starttls">STARTTLS (587)</option>
            <option value="none">None (local relay)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="mail-username" className={labelCls}>
            Username
          </label>
          <input id="mail-username" value={username} disabled={locked} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className={inputCls} />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor="mail-password" className={labelCls}>
            Password
          </label>
          <PasswordInput
            id="mail-password"
            value={password}
            disabled={locked}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mail.hasPassword ? 'Stored — leave empty to keep' : ''}
            autoComplete="new-password"
            className={inputCls}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-4">
          <label htmlFor="mail-from" className={labelCls}>
            Send as
          </label>
          <input id="mail-from" value={from} disabled={locked} onChange={(e) => setFrom(e.target.value)} placeholder="Fox <fox@example.com>" className={inputCls} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!locked && (
          <button type="button" className={primaryCls} onClick={() => void save()}>
            Save
          </button>
        )}
        {mail.configured && (
          <>
            <input
              aria-label="Send a test to"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com"
              className={`${inputCls} max-w-[14rem]`}
            />
            <button
              type="button"
              className={buttonCls}
              onClick={() => void run(() => apiSendTestEmail(testTo), `Test email sent to ${testTo}.`)}
            >
              Send test email
            </button>
            {!locked && (
              <button type="button" className={buttonCls} onClick={() => void run(() => apiRemoveMailSettings(), 'Email turned off.')}>
                Turn off
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
};
