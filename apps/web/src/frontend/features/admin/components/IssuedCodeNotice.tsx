/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The invite or reset code an admin just issued: whether it was emailed, and
 * the code and link to pass on by hand when it was not (or did not arrive).
 */
import React, { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { CodePurpose, IssuedCode } from '@/shared/api/authApi';

type Props = IssuedCode & { email: string; purpose: CodePurpose; onDismiss: () => void };

function deliveryText(p: Props): string {
  const what = p.purpose === 'invite' ? 'Invite' : 'Password-reset code';
  if (p.delivery === 'email') return `${what} emailed to ${p.email}.`;
  if (p.delivery === 'failed') {
    return `${what} for ${p.email} could not be emailed (${p.deliveryError ?? 'unknown error'}). Pass it on yourself:`;
  }
  return `Email is not set up, so pass this ${p.purpose === 'invite' ? 'invite' : 'code'} to ${p.email} yourself:`;
}

export const IssuedCodeNotice: React.FC<Props> = (props) => {
  const [copied, setCopied] = useState(false);
  const share = props.link || props.code;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(share);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the code is on screen to copy by hand */
    }
  };
  const tone =
    props.delivery === 'failed'
      ? 'border-rose-500/30 bg-rose-950/20'
      : props.delivery === 'email'
        ? 'border-emerald-500/30 bg-emerald-950/20'
        : 'border-amber-500/30 bg-amber-950/20';

  return (
    <div data-testid="admin-issued-code" className={`rounded-lg border px-3 py-2.5 text-xs text-slate-200 ${tone}`}>
      <div className="flex items-start gap-2">
        <p className="flex-1">{deliveryText(props)}</p>
        <button type="button" aria-label="Dismiss" onClick={props.onDismiss} className="text-slate-400 hover:text-slate-100">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code data-testid="admin-issued-code-value" className="font-mono text-sm tracking-wider text-slate-100">
          {props.code}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300 hover:text-white"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : props.link ? 'Copy link' : 'Copy code'}
        </button>
        <span className="text-[11px] text-slate-500">
          Works once, until {new Date(props.expiresAt).toLocaleString()}.
        </span>
      </div>
      {props.link && <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{props.link}</p>}
      {!props.link && (
        <p className="mt-1 text-[11px] text-slate-500">
          They enter it under “Have an invite or reset code?” on the sign-in page. Set the public URL on the
          Sign-in tab to send a link instead.
        </p>
      )}
    </div>
  );
};
