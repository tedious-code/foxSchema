/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * First-open welcome wizard: optional email subscriber capture (WordPress webhook).
 * Shown once per install before login / workspace. Skippable.
 */
import React, { useState } from 'react';
import { Loader2, AlertCircle, Mail, Sparkles } from 'lucide-react';
import { submitSignup, skipSignup } from '../api/authApi';
import { Brand } from '@/shared/components/Brand';
import { sectionLabelCls } from '@/shared/components/surfaces';

/**
 * One-time, skippable first-run prompt: collect a subscriber email when the
 * app is opened for the first time. Submitting or skipping dismisses it for
 * the install (see signup-wizard.service.ts).
 */
export const SignupWizard: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'submit' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('submit');
    setError(null);
    try {
      const result = await submitSignup(email.trim());
      if (result.ok) {
        onDone();
      } else {
        setError(result.error ?? 'Something went wrong. Try again, or skip for now.');
      }
    } catch {
      setError("Couldn't reach the server. Try again, or skip for now.");
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    setBusy('skip');
    try {
      await skipSignup();
    } catch {
      /* best-effort — don't trap the user behind a network hiccup */
    } finally {
      onDone();
    }
  };

  return (
    <div
      data-testid="signup-wizard"
      className="h-screen flex items-center justify-center bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-slate-100 p-4"
    >
      <div className="w-full max-w-lg flex flex-col items-center gap-7">
        <Brand logoSize={52} textClassName="text-2xl font-bold" subtitle={false} />

        <form
          onSubmit={submit}
          className="w-full rounded-2xl border border-cyan-500/20 bg-slate-900/70 shadow-2xl shadow-cyan-950/30 overflow-hidden"
        >
          <div className="px-6 pt-6 pb-4 border-b border-slate-800/80 bg-gradient-to-r from-cyan-500/10 via-transparent to-transparent">
            <div className="flex items-center gap-2 text-cyan-300/90 text-[11px] font-bold uppercase tracking-wider mb-2">
              <Sparkles className="w-3.5 h-3.5" />
              Welcome
            </div>
            <h1 className="text-xl font-bold text-slate-50">Get product updates</h1>
            <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
              Drop your email to hear about new dialects, releases, and features. Optional —
              skip anytime. No spam; unsubscribe whenever you like.
            </p>
          </div>

          <div className="px-6 py-5 flex flex-col gap-3.5">
            <label className="block">
              <span className={sectionLabelCls}>
                Email
              </span>
              <input
                type="email"
                required
                autoFocus
                data-testid="signup-wizard-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="mt-1 w-full bg-slate-950 border border-slate-700 accent-focus rounded-lg px-3 py-2.5 text-sm outline-none"
              />
            </label>

            {error && (
              <div
                data-testid="signup-wizard-error"
                className="flex items-start gap-2 text-xs text-rose-400 bg-rose-950/40 border border-rose-500/20 rounded-md px-3 py-2"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              data-testid="signup-wizard-submit"
              disabled={busy !== null}
              className="w-full accent-grad on-accent-fg font-semibold text-sm rounded-lg px-4 py-2.5 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {busy === 'submit' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
              Subscribe & continue
            </button>

            <button
              type="button"
              data-testid="signup-wizard-skip"
              onClick={skip}
              disabled={busy !== null}
              className="text-xs font-semibold text-slate-400 hover:text-slate-200 transition cursor-pointer disabled:opacity-50 py-1"
            >
              {busy === 'skip' ? 'Skipping…' : 'Skip for now'}
            </button>
          </div>
        </form>

        <p className="text-[11px] text-slate-600 text-center max-w-sm">
          Shown once on first open. Your email is used only for Fox Schema product updates.
        </p>
      </div>
    </div>
  );
};
