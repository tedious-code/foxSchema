/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Choosing a password: the field, a confirmation, and the rules checked as
 * you type. The rules are the server's own (`@foxschema/shared`), so the page
 * never accepts what the server will refuse, or the other way round.
 */
import React, { useState } from 'react';
import { Check, AlertTriangle, Copy, Sparkles } from 'lucide-react';
import { PASSWORD_MIN_LENGTH, passwordProblem } from '@foxschema/shared';
import { PasswordInput } from '@/shared/components/PasswordInput';
import { writeClipboard } from '@/shared/utils/clipboard';
import { authInputCls, authLabelCls, authLinkCls } from './authStyles';

const LOWER_CHARS = 'abcdefghjkmnpqrstuvwxyz';
const UPPER_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGIT_CHARS = '23456789';
const GENERATED_CHARSET = `${LOWER_CHARS}${UPPER_CHARS}${DIGIT_CHARS}`;

/** Generate a random grouped passphrase (e.g. `k9Xm-pQ3z-vR7n-W2bT`) that passes server rules. */
export function generateStrongPassword(email = ''): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const buf = new Uint32Array(16);
    crypto.getRandomValues(buf);
    const chars = Array.from(buf, (v) => GENERATED_CHARSET[v % GENERATED_CHARSET.length]!);
    const candidate = [
      chars.slice(0, 4).join(''),
      chars.slice(4, 8).join(''),
      chars.slice(8, 12).join(''),
      chars.slice(12, 16).join(''),
    ].join('-');
    if (!passwordProblem(candidate, email)) return candidate;
  }
  // Unreachable in practice, but guarantees compliance.
  return `Fox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Caps Lock is the usual reason a known password "stops working". */
export function useCapsLock() {
  const [on, setOn] = useState(false);
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') setOn(e.getModifierState('CapsLock'));
  };
  return { capsLock: on, inputProps: { onKeyDown: onKey, onKeyUp: onKey } };
}

export const CapsLockHint: React.FC<{ on: boolean }> = ({ on }) =>
  on ? (
    <p className="flex items-center gap-1.5 text-xs text-amber-300" role="status" data-testid="caps-lock-hint">
      <AlertTriangle className="w-3.5 h-3.5" /> Caps Lock is on
    </p>
  ) : null;

/**
 * "Email me Fox news" on a new account. Unticked until the person ticks it:
 * a pre-ticked box is not consent (CASL, GDPR).
 */
export const NewsOptIn: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <label className="flex items-start gap-2 text-xs text-slate-400 cursor-pointer">
    <input
      type="checkbox"
      data-testid="auth-news-opt-in"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 rounded border-slate-600 bg-slate-900"
    />
    <span>Email me Fox news and updates. Unsubscribe any time.</span>
  </label>
);

/** Why the pair cannot be submitted yet, or null when it can. */
export function newPasswordError(password: string, confirm: string, email: string): string | null {
  return passwordProblem(password, email) ?? (password !== confirm ? 'The two passwords do not match.' : null);
}

interface Props {
  email: string;
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  /** Show the confirm mismatch (after a submit attempt), not while still typing. */
  showMismatch: boolean;
  label?: string;
}

export const NewPasswordFields: React.FC<Props> = ({
  email,
  password,
  confirm,
  onPassword,
  onConfirm,
  showMismatch,
  label = 'Password',
}) => {
  const caps = useCapsLock();
  const [generated, setGenerated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const longEnough = password.length >= PASSWORD_MIN_LENGTH;
  const problem = password ? passwordProblem(password, email) : null;
  const ruleProblem = longEnough ? problem : null;
  const mismatch = showMismatch && confirm !== password;

  const handleGenerate = async () => {
    const next = generateStrongPassword(email);
    onPassword(next);
    onConfirm(next);
    setGenerated(next);
    const didCopy = await writeClipboard(next);
    setCopied(didCopy);
    if (didCopy) setTimeout(() => setCopied(false), 1800);
  };

  const copyGenerated = async () => {
    if (!generated) return;
    if (await writeClipboard(generated)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="auth-new-password" className={authLabelCls}>
            {label}
          </label>
          <button
            type="button"
            data-testid="auth-password-generate"
            onClick={() => void handleGenerate()}
            className={`${authLinkCls} inline-flex items-center gap-1`}
          >
            <Sparkles className="w-3 h-3" />
            Auto-generate
          </button>
        </div>
        <PasswordInput
          id="auth-new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => {
            if (generated && e.target.value !== generated) setGenerated(null);
            onPassword(e.target.value);
          }}
          {...caps.inputProps}
          placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
          autoComplete="new-password"
          aria-describedby="auth-password-rules"
          className={`w-full ${authInputCls}`}
        />
        {generated && (
          <div
            data-testid="auth-password-generated-notice"
            className="mt-1 rounded-md border border-cyan-500/30 bg-cyan-950/25 px-2.5 py-2 text-xs text-cyan-100 space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-xs select-all text-cyan-200">{generated}</code>
              <button
                type="button"
                data-testid="auth-password-copy-generated"
                onClick={() => void copyGenerated()}
                className="inline-flex items-center gap-1 rounded border border-cyan-500/40 px-1.5 py-0.5 text-[11px] text-cyan-100 hover:bg-cyan-900/40"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              Generated and filled both password fields — copy and save it in your password manager.
            </p>
          </div>
        )}
        <ul id="auth-password-rules" className="mt-1 flex flex-col gap-0.5 text-xs" data-testid="password-rules">
          <li className={longEnough ? 'text-emerald-300' : 'text-slate-500'}>
            <Check className={`inline w-3 h-3 mr-1 ${longEnough ? '' : 'opacity-30'}`} />
            At least {PASSWORD_MIN_LENGTH} characters
          </li>
          <li className={longEnough && !ruleProblem ? 'text-emerald-300' : 'text-slate-500'}>
            <Check className={`inline w-3 h-3 mr-1 ${longEnough && !ruleProblem ? '' : 'opacity-30'}`} />
            Not a common password or your email name
          </li>
          {ruleProblem && <li className="text-rose-300">{ruleProblem}</li>}
        </ul>
        <CapsLockHint on={caps.capsLock} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="auth-confirm" className={authLabelCls}>
          Confirm password
        </label>
        <PasswordInput
          id="auth-confirm"
          required
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          {...caps.inputProps}
          autoComplete="new-password"
          aria-invalid={mismatch || undefined}
          className={`w-full ${authInputCls}`}
        />
        {mismatch && <p className="text-xs text-rose-300">The two passwords do not match.</p>}
      </div>
    </>
  );
};
