/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The pages before the workspace.
 *
 * - Sign up, the first time: until an account can sign in, the install asks
 *   for its administrator account. On an install used before, that claims
 *   the existing local account, so connections and history stay.
 * - Sign in, with email and password or Google / Microsoft / GitHub.
 * - Forgot password, and a code from an invite or reset email.
 *
 * There is no open registration: after the first account, people join when
 * an administrator invites them.
 */
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { Brand } from '@/app/shell/Brand';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { SsoButtons } from './SsoButtons';
import { AuthError } from './AuthError';
import { NewPasswordFields, NewsOptIn, newPasswordError, useCapsLock, CapsLockHint } from './NewPasswordFields';
import { ForgotPasswordView, RedeemCodeView } from './PasswordRecovery';
import { authInputCls, authLabelCls, authLinkCls, authSubmitCls } from './authStyles';

/** Surface an `?sso_error=…` returned by a failed SSO callback. */
function readSsoError(): string | null {
  if (typeof window === 'undefined') return null;
  const err = new URLSearchParams(window.location.search).get('sso_error');
  return err ? decodeURIComponent(err) : null;
}

/**
 * A code from an emailed link: `#reset=…` or `#invite=…`. Read once and then
 * removed from the address bar, so it does not linger in history or get
 * shared along with the URL.
 */
function takeCodeFromLink(): string {
  if (typeof window === 'undefined') return '';
  const match = /^#(?:reset|invite)=([^&]+)/.exec(window.location.hash);
  if (!match) return '';
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return decodeURIComponent(match[1]!);
}

type View = 'signin' | 'forgot' | 'code';

const TITLES: Record<View | 'setup', { title: string; subtitle: string }> = {
  setup: {
    title: 'Create your account',
    subtitle: 'The first account on this install is its administrator. Saved connections and history stay as they are.',
  },
  signin: { title: 'Sign in to your workspace', subtitle: 'Welcome back.' },
  forgot: { title: 'Forgot your password?', subtitle: '' },
  code: { title: 'Use your code', subtitle: '' },
};

export const AuthPage: React.FC = () => {
  const { status, setupState } = useAuthStore();
  const settingUp = status === 'setup' && !!setupState;
  const [linkCode, setLinkCode] = useState(takeCodeFromLink);
  const [view, setView] = useState<View>(linkCode ? 'code' : 'signin');

  // A link pasted into a tab where Fox is already open changes only the
  // fragment, which does not reload the page: pick the code up from here too.
  useEffect(() => {
    const onHash = () => {
      const code = takeCodeFromLink();
      if (!code) return;
      useAuthStore.getState().clearError();
      setLinkCode(code);
      setView('code');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [email, setEmail] = useState('');
  const clearError = useAuthStore((s) => s.clearError);

  const go = (next: View) => {
    clearError();
    setView(next);
  };

  const heading = TITLES[settingUp ? 'setup' : view];

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Brand logoSize={52} textClassName="text-2xl font-bold" subtitle={false} className="mb-2" />
          <h1 className="text-base font-semibold text-slate-200 mt-1">{heading.title}</h1>
          {heading.subtitle && <p className="text-xs text-slate-500 mt-2 text-center max-w-xs">{heading.subtitle}</p>}
        </div>

        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6">
          {settingUp ? (
            <FirstAccountForm />
          ) : view === 'forgot' ? (
            <ForgotPasswordView initialEmail={email} onBack={() => go('signin')} onHaveCode={() => go('code')} />
          ) : view === 'code' ? (
            <RedeemCodeView key={linkCode} initialCode={linkCode} onBack={() => go('signin')} />
          ) : (
            <SignInForm
              email={email}
              onEmail={setEmail}
              onForgot={() => go('forgot')}
              onHaveCode={() => go('code')}
            />
          )}
        </div>
      </div>
    </div>
  );
};

const SignInForm: React.FC<{
  email: string;
  onEmail: (v: string) => void;
  onForgot: () => void;
  onHaveCode: () => void;
}> = ({ email, onEmail, onForgot, onHaveCode }) => {
  const { login, error, busy } = useAuthStore();
  const [password, setPassword] = useState('');
  const [ssoError] = useState<string | null>(readSsoError);
  const caps = useCapsLock();

  // Drop `?sso_error` from the address bar once shown, so a reload is clean.
  useEffect(() => {
    if (ssoError) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, [ssoError]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void login(email.trim(), password);
  };

  return (
    <form onSubmit={submit} data-testid="auth-login-form" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="auth-email" className={authLabelCls}>
          Email
        </label>
        <input data-testid="auth-login-email"
          id="auth-email"
          type="email"
          required
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          placeholder="your@email.com"
          autoComplete="username"
          className={authInputCls}
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <label htmlFor="auth-password" className={authLabelCls}>
            Password
          </label>
          <button type="button" onClick={onForgot} className={authLinkCls} data-testid="auth-forgot-link">
            Forgot password?
          </button>
        </div>
        <PasswordInput
          id="auth-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          {...caps}
          placeholder="••••••••"
          autoComplete="current-password"
          className={`w-full ${authInputCls}`}
        />
        <CapsLockHint on={caps.capsLock} />
      </div>

      <AuthError message={error || ssoError} />

      <button data-testid="auth-login-submit" type="submit" disabled={busy} className={authSubmitCls}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        Sign in
      </button>

      <SsoButtons />

      <div className="flex flex-col items-center gap-1 pt-1 text-xs text-slate-500">
        <button type="button" onClick={onHaveCode} className={authLinkCls} data-testid="auth-have-code">
          Have an invite or reset code?
        </button>
        <span>No account? Ask your administrator to invite you.</span>
      </div>
    </form>
  );
};

/** Sign up, the first time: the install's administrator account. */
const FirstAccountForm: React.FC = () => {
  const { setup, setupState, error, busy } = useAuthStore();
  const boundEmail = setupState?.setupEmail ?? null;
  const [email, setEmail] = useState(boundEmail ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [news, setNews] = useState(false);
  const accountEmail = boundEmail ?? email.trim();
  const problem = newPasswordError(password, confirm, accountEmail);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (problem) return;
    void setup(accountEmail, password, setupState?.setupCodeRequired ? code.trim() : undefined, news);
  };

  return (
    <form onSubmit={submit} data-testid="auth-setup-form" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="auth-email" className={authLabelCls}>
          Email
        </label>
        <input data-testid="auth-setup-email"
          id="auth-email"
          type="email"
          required
          readOnly={!!boundEmail}
          value={boundEmail ?? email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          autoComplete="username"
          className={`${authInputCls} read-only:text-slate-400`}
        />
      </div>

      <NewPasswordFields
        email={accountEmail}
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
        showMismatch={attempted}
      />

      {setupState?.setupCodeRequired && (
        <div className="flex flex-col gap-1">
          <label htmlFor="auth-setup-code" className={authLabelCls}>
            Setup code
          </label>
          <input data-testid="auth-setup-code"
            id="auth-setup-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
            spellCheck={false}
            className={`${authInputCls} font-mono uppercase`}
          />
          <p className="text-xs text-slate-500">
            You are not on the machine Fox runs on, so enter the code printed in the Fox server log.
          </p>
        </div>
      )}

      <NewsOptIn checked={news} onChange={setNews} />

      <AuthError message={error} />

      <button data-testid="auth-setup-submit" type="submit" disabled={busy || (attempted && !!problem)} className={authSubmitCls}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        Create account
      </button>
    </form>
  );
};
