/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The two account reminders in the workspace.
 *
 * - Create your account: the owner came in through a `foxschema open` launch
 *   link and has no account yet. Says how long until one is required; the
 *   button (and the profile menu) opens the form first-run setup uses.
 *   Dismissing hides it until the page is reloaded. When the time is up the
 *   form takes the whole screen.
 * - Verify your email: the account was asked to prove its address. The code
 *   was emailed when the account was created; entering it ends the reminder.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MailCheck, UserPlus, X } from 'lucide-react';
import { useAuthStore } from '@/app/store/authStore';
import { FirstAccountForm } from './AuthPage';
import { authInputCls } from './authStyles';

const DAY_MS = 24 * 60 * 60 * 1000;
/** setTimeout's ceiling; a longer wait is re-armed on the next render instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** "within 6 days", "within a day", "today": rounded up, so a day that has begun still counts. */
export function dueIn(dueAt: string, now = Date.now()): string {
  const days = Math.ceil((Date.parse(dueAt) - now) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0) return 'today';
  if (days === 1) return 'within a day';
  return `within ${days} days`;
}

export const AccountBanners: React.FC = () => {
  const launch = useAuthStore((s) => s.launch);
  const registration = useAuthStore((s) => s.registration);
  const verification = useAuthStore((s) => s.emailVerification);
  return (
    <>
      {launch && registration && !registration.required && <RegisterBanner dueAt={registration.dueAt} />}
      {!launch && verification && !verification.verified && <VerifyEmailBanner />}
    </>
  );
};

export default AccountBanners;

const bannerCls = 'border-y px-6 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs font-medium animate-slide-down';
const dismissCls = 'ml-auto p-1 rounded accent-focus focus:outline-none opacity-70 hover:opacity-100';

const RegisterBanner: React.FC<{ dueAt: string }> = ({ dueAt }) => {
  const [hidden, setHidden] = useState(false);
  // In the store, so the profile menu's "Create your account" opens it too,
  // even with the banner put away.
  const open = useAuthStore((s) => s.registerDialogOpen);
  const setOpen = useAuthStore((s) => s.setRegisterDialogOpen);

  // Still open when the time runs out: the account form takes over, as it
  // would on the next load (the server stops taking this session then too).
  useEffect(() => {
    const wait = Date.parse(dueAt) - Date.now();
    if (!Number.isFinite(wait) || wait > MAX_TIMER_MS) return;
    const timer = window.setTimeout(() => {
      useAuthStore.setState((s) => ({
        registration: s.registration ? { ...s.registration, required: true } : s.registration,
        status: 'setup',
      }));
    }, Math.max(0, wait));
    return () => window.clearTimeout(timer);
  }, [dueAt]);

  return (
    <>
      {!hidden && (
        <div data-testid="account-register-banner" className={`${bannerCls} bg-amber-950/50 border-amber-500/20 text-amber-200`}>
          <UserPlus className="w-4 h-4 text-amber-400 shrink-0" />
          <span>
            You are using Fox without an account. Create one {dueIn(dueAt)}: it keeps this install yours, and your
            connections and history stay as they are.
          </span>
          <button
            type="button"
            data-testid="account-register-open"
            onClick={() => setOpen(true)}
            className="rounded-md border border-amber-400/40 bg-amber-400/15 px-2.5 py-1 font-bold text-amber-100 accent-focus focus:outline-none"
          >
            Create account
          </button>
          <button
            type="button"
            data-testid="account-register-dismiss"
            aria-label="Hide until next time"
            onClick={() => setHidden(true)}
            className={dismissCls}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {open && <RegisterDialog onClose={() => setOpen(false)} />}
    </>
  );
};

/** The first-run account form, over the workspace. Closes itself once the account exists. */
const RegisterDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      data-testid="account-register-dialog"
      className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-register-title"
        className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pt-4">
          <h2 id="account-register-title" className="flex-1 text-sm font-bold text-slate-100">
            Create your account
          </h2>
          <button
            type="button"
            data-testid="account-register-close"
            aria-label="Close"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-100 rounded accent-focus focus:outline-none"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="px-5 pt-1 text-xs text-slate-500">
          It becomes this install&apos;s administrator. We will email you a code to confirm the address.
        </p>
        <div className="p-5">
          <FirstAccountForm />
        </div>
      </div>
    </div>,
    document.body
  );
};

const VerifyEmailBanner: React.FC = () => {
  const email = useAuthStore((s) => s.user?.email ?? '');
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const verifyEmail = useAuthStore((s) => s.verifyEmail);
  const sendVerification = useAuthStore((s) => s.sendVerification);
  const clearError = useAuthStore((s) => s.clearError);
  const [code, setCode] = useState('');
  const [hidden, setHidden] = useState(false);
  const [sent, setSent] = useState<{ ok: boolean; message: string } | null>(null);
  const [sending, setSending] = useState(false);

  if (hidden) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim()) void verifyEmail(code.trim());
  };
  const resend = async () => {
    clearError();
    setSending(true);
    setSent(await sendVerification());
    setSending(false);
  };

  return (
    <form
      data-testid="account-verify-banner"
      onSubmit={submit}
      className={`${bannerCls} bg-sky-950/50 border-sky-500/20 text-sky-200`}
    >
      <MailCheck className="w-4 h-4 text-sky-400 shrink-0" />
      <span>
        Verify your email: enter the code we sent to <b className="text-sky-100">{email}</b>.
      </span>
      <input
        data-testid="account-verify-code"
        aria-label="Verification code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="ABCD-EFGH-JKMN"
        autoComplete="one-time-code"
        spellCheck={false}
        className={`${authInputCls} !py-1 !text-xs font-mono uppercase w-40`}
      />
      <button
        type="submit"
        data-testid="account-verify-submit"
        disabled={busy || !code.trim()}
        className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/40 bg-sky-400/15 px-2.5 py-1 font-bold text-sky-100 disabled:opacity-50 accent-focus focus:outline-none"
      >
        {busy && <Loader2 className="w-3 h-3 animate-spin" />}
        Verify
      </button>
      <button
        type="button"
        data-testid="account-verify-resend"
        disabled={sending}
        onClick={() => void resend()}
        className="underline underline-offset-2 text-sky-300 hover:text-sky-100 disabled:opacity-50 accent-focus focus:outline-none rounded"
      >
        {sending ? 'Sending…' : 'Send a new code'}
      </button>
      {(error || sent) && (
        <span
          data-testid="account-verify-status"
          className={error || (sent && !sent.ok) ? 'text-rose-300' : 'text-emerald-300'}
        >
          {error || sent?.message}
        </span>
      )}
      <button
        type="button"
        data-testid="account-verify-dismiss"
        aria-label="Hide until next time"
        onClick={() => setHidden(true)}
        className={dismissCls}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </form>
  );
};
