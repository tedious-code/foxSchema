/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * An emailed invite or reset link opened in a browser that is already signed
 * in. The code form is on the sign-in page, which a signed-in browser never
 * shows, so the link used to land on the workspace and do nothing. This asks
 * instead: sign out and use the code, or stay signed in and drop it.
 */
import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/platform/authStore';
import { Brand } from '@/shared/components/Brand';
import type { LinkCodePurpose } from '../lib/linkCode';
import { authLinkCls, authSubmitCls } from './authStyles';

export const SignedInLinkNotice: React.FC<{ purpose: LinkCodePurpose; onStay: () => void }> = ({ purpose, onStay }) => {
  const email = useAuthStore((s) => s.user?.email ?? '');
  const logout = useAuthStore((s) => s.logout);
  const [busy, setBusy] = useState(false);

  // Signing out leaves the code in the address bar; the sign-in page then reads it.
  const signOut = async () => {
    setBusy(true);
    await logout();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Brand logoSize={52} textClassName="text-2xl font-bold" subtitle={false} className="mb-2" />
          <h1 className="text-base font-semibold text-slate-200 mt-1">
            {purpose === 'reset' ? 'Reset a password' : 'Accept an invite'}
          </h1>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 flex flex-col gap-4" data-testid="auth-link-signed-in">
          <p className="text-sm text-slate-300">
            This {purpose === 'reset' ? 'password-reset' : 'invite'} link is for signing in, but this browser is already
            signed in{email ? (
              <>
                {' '}as <b>{email}</b>
              </>
            ) : null}
            . Sign out to use it.
          </p>
          <button
            data-testid="auth-link-sign-out"
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
            className={authSubmitCls}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Sign out and continue
          </button>
          <button data-testid="auth-link-stay" type="button" disabled={busy} onClick={onStay} className={authLinkCls}>
            Stay signed in as {email || 'this account'}
          </button>
        </div>
      </div>
    </div>
  );
};
