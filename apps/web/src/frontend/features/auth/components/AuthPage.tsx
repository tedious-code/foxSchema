import React, { useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { Brand } from '@/app/shell/Brand';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { SsoButtons } from './SsoButtons';

/** Surface an `?sso_error=…` returned by a failed SSO callback. */
function readSsoError(): string | null {
  if (typeof window === 'undefined') return null;
  const err = new URLSearchParams(window.location.search).get('sso_error');
  return err ? decodeURIComponent(err) : null;
}

const inputCls =
  'bg-slate-950 border border-slate-800 accent-focus rounded-md px-3 py-2 text-sm outline-none';
const labelCls = 'text-xs font-semibold text-slate-400 uppercase tracking-wider';

/**
 * Sign in, or on first run create the admin account.
 *
 * Every install signs in; there is no self-registration. Until an account can
 * sign in, this page is first-run setup, which on an install used before keeps
 * its saved connections and history.
 */
export const AuthPage: React.FC = () => {
  const { login, setup, setupState, status, error, busy } = useAuthStore();
  const settingUp = status === 'setup' && !!setupState;
  const boundEmail = setupState?.setupEmail ?? null;
  const [email, setEmail] = useState(boundEmail ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [ssoError] = useState<string | null>(readSsoError);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingUp) {
      login(email, password);
      return;
    }
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setup(boundEmail ?? email, password, setupState?.setupCodeRequired ? code : undefined);
  };

  const shownError = mismatch ? 'The two passwords do not match.' : error || ssoError;

  return (
    <div className="h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Brand logoSize={52} textClassName="text-2xl font-bold" subtitle={false} className="mb-2" />
          <p className="text-sm text-slate-400 mt-1">
            {settingUp ? 'Create the administrator account' : 'Sign in to your workspace'}
          </p>
          <p className="text-xs text-slate-500 mt-2 text-center max-w-xs">
            {settingUp
              ? 'Fox now asks everyone to sign in. Choose the password for this install. Saved connections and history stay as they are.'
              : 'First-time sign-in opens a short setup wizard before you reach the workspace.'}
          </p>
        </div>

        <form
          onSubmit={submit}
          data-testid={settingUp ? 'auth-setup-form' : 'auth-login-form'}
          className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="auth-email" className={labelCls}>Email</label>
            <input
              id="auth-email"
              type="email"
              required
              readOnly={settingUp && !!boundEmail}
              value={settingUp && boundEmail ? boundEmail : email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              autoComplete={settingUp ? 'email' : 'username'}
              className={`${inputCls} read-only:text-slate-400`}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="auth-password" className={labelCls}>Password</label>
            <PasswordInput
              id="auth-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={settingUp ? 'At least 8 characters' : '••••••••'}
              autoComplete={settingUp ? 'new-password' : 'current-password'}
              className={`w-full ${inputCls}`}
            />
          </div>

          {settingUp && (
            <div className="flex flex-col gap-1">
              <label htmlFor="auth-confirm" className={labelCls}>Confirm password</label>
              <PasswordInput
                id="auth-confirm"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className={`w-full ${inputCls}`}
              />
            </div>
          )}

          {settingUp && setupState?.setupCodeRequired && (
            <div className="flex flex-col gap-1">
              <label htmlFor="auth-setup-code" className={labelCls}>Setup code</label>
              <input
                id="auth-setup-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD-EFGH"
                autoComplete="one-time-code"
                className={`${inputCls} font-mono uppercase`}
              />
              <p className="text-xs text-slate-500">
                You are not on the machine Fox runs on, so enter the code printed in the Fox server
                log.
              </p>
            </div>
          )}

          {shownError && (
            <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-950/30 border border-rose-500/20 rounded-md px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{shownError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex items-center justify-center gap-2 accent-grad disabled:opacity-60 on-accent-fg font-bold rounded-md py-2.5 text-sm transition cursor-pointer"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {settingUp ? 'Create admin account' : 'Sign In'}
          </button>

          {!settingUp && <SsoButtons />}

          {!settingUp && (
            <p className="text-xs text-slate-500 text-center">
              No account? Ask your administrator to add you.
            </p>
          )}
        </form>
      </div>
    </div>
  );
};
