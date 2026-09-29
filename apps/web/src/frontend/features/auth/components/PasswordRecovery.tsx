/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Getting in without a password: forgot password, entering a code, and
 * choosing a password with it. One code covers both a reset and an invite;
 * the server says which it is and whose account it opens.
 */
import React, { useEffect, useState } from 'react';
import { Loader2, MailCheck, ScrollText } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { apiForgotPassword, apiInspectCode, type CodeDelivery, type CodePurpose } from '@/shared/api/authApi';
import { NewPasswordFields, newPasswordError } from './NewPasswordFields';
import { authInputCls, authLabelCls, authLinkCls, authSubmitCls } from './authStyles';
import { AuthError } from './AuthError';

interface NavProps {
  onBack: () => void;
}

export const ForgotPasswordView: React.FC<NavProps & { initialEmail: string; onHaveCode: () => void }> = ({
  initialEmail,
  onBack,
  onHaveCode,
}) => {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<CodeDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent((await apiForgotPassword(email.trim())).delivery);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col gap-4" data-testid="auth-forgot-sent">
        <div className="flex items-start gap-3 text-sm text-slate-300">
          {sent === 'email' ? (
            <MailCheck className="w-5 h-5 shrink-0 text-emerald-300" />
          ) : (
            <ScrollText className="w-5 h-5 shrink-0 text-amber-300" />
          )}
          <p>
            {sent === 'email' ? (
              <>
                If <b>{email.trim()}</b> has an account, a reset code is on its way. It works once, for 30 minutes.
              </>
            ) : (
              <>
                This install does not send email. If <b>{email.trim()}</b> has an account, its reset code was written
                to the Fox server log. Ask whoever runs Fox for it, or run <code>foxschema reset-password</code> on
                that machine.
              </>
            )}
          </p>
        </div>
        <button type="button" onClick={onHaveCode} className={authSubmitCls}>
          I have a code
        </button>
        <button type="button" onClick={onBack} className={authLinkCls}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} data-testid="auth-forgot-form" className="flex flex-col gap-4">
      <p className="text-sm text-slate-400">Enter your account's email. We'll send a one-time code to reset it.</p>
      <div className="flex flex-col gap-1">
        <label htmlFor="auth-forgot-email" className={authLabelCls}>
          Email
        </label>
        <input
          id="auth-forgot-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          placeholder="your@email.com"
          className={authInputCls}
        />
      </div>
      <AuthError message={error} />
      <button type="submit" disabled={busy} className={authSubmitCls}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        Send reset code
      </button>
      <div className="flex justify-between">
        <button type="button" onClick={onBack} className={authLinkCls}>
          Back to sign in
        </button>
        <button type="button" onClick={onHaveCode} className={authLinkCls}>
          I have a code
        </button>
      </div>
    </form>
  );
};

/**
 * Enter a reset or invite code (or arrive with one from an emailed link),
 * then choose the password.
 */
export const RedeemCodeView: React.FC<NavProps & { initialCode?: string }> = ({ initialCode = '', onBack }) => {
  const { redeem, busy, error, clearError } = useAuthStore();
  const [code, setCode] = useState(initialCode);
  const [target, setTarget] = useState<{ email: string; purpose: CodePurpose } | null>(null);
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [attempted, setAttempted] = useState(false);

  const check = async (value: string) => {
    setChecking(true);
    setCodeError(null);
    try {
      setTarget(await apiInspectCode(value.trim()));
    } catch (err: unknown) {
      setCodeError(err instanceof Error ? err.message : 'This code does not work.');
    } finally {
      setChecking(false);
    }
  };

  // A code from an emailed link is checked straight away.
  useEffect(() => {
    clearError();
    if (initialCode) void check(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!target) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void check(code);
        }}
        data-testid="auth-code-form"
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-slate-400">Enter the code from your invite or reset email.</p>
        <div className="flex flex-col gap-1">
          <label htmlFor="auth-code" className={authLabelCls}>
            Code
          </label>
          <input
            id="auth-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH-JKMN"
            autoComplete="one-time-code"
            spellCheck={false}
            className={`${authInputCls} font-mono uppercase tracking-wider`}
          />
        </div>
        <AuthError message={codeError} />
        <button type="submit" disabled={checking} className={authSubmitCls}>
          {checking && <Loader2 className="w-4 h-4 animate-spin" />}
          Continue
        </button>
        <button type="button" onClick={onBack} className={authLinkCls}>
          Back to sign in
        </button>
      </form>
    );
  }

  const problem = newPasswordError(password, confirm, target.email);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (problem) return;
    await redeem(code.trim(), password);
  };

  return (
    <form onSubmit={submit} data-testid="auth-redeem-form" className="flex flex-col gap-4">
      <p className="text-sm text-slate-400">
        {target.purpose === 'invite'
          ? 'Welcome! Choose the password for your new account.'
          : 'Choose a new password. Every other session of this account will be signed out.'}
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor="auth-redeem-email" className={authLabelCls}>
          Email
        </label>
        <input
          id="auth-redeem-email"
          type="email"
          readOnly
          value={target.email}
          autoComplete="username"
          className={`${authInputCls} text-slate-400`}
        />
      </div>
      <NewPasswordFields
        email={target.email}
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
        showMismatch={attempted}
        label={target.purpose === 'invite' ? 'Password' : 'New password'}
      />
      <AuthError message={error} />
      <button type="submit" disabled={busy || (attempted && !!problem)} className={authSubmitCls}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {target.purpose === 'invite' ? 'Create my account' : 'Set new password'}
      </button>
      <button type="button" onClick={onBack} className={authLinkCls}>
        Back to sign in
      </button>
    </form>
  );
};
