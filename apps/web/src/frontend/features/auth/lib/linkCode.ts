/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The code in an emailed invite or reset link: `#reset=…` or `#invite=…`.
 *
 * Small and dependency-free on purpose: the signed-in shell asks whether one
 * is in the address bar, and must not pull the sign-in screens in to find out.
 */
import { useEffect, useState } from 'react';

export type LinkCodePurpose = 'reset' | 'invite';

const LINK_CODE = /^#(reset|invite)=([^&]+)/;

/** The link's purpose and code, if the address bar holds one. Leaves it there. */
export function peekLinkCode(): { purpose: LinkCodePurpose; code: string } | null {
  if (typeof window === 'undefined') return null;
  const match = LINK_CODE.exec(window.location.hash);
  return match ? { purpose: match[1] as LinkCodePurpose, code: decodeURIComponent(match[2]!) } : null;
}

/** Remove the link's code from the address bar, so it does not linger in history. */
export function clearLinkCode(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

/**
 * Which kind of emailed link is in the address bar, kept current when a link
 * is pasted into an open tab (that changes only the fragment, no reload).
 * Read again whenever `recheck` changes: the sign-in page takes the code off
 * the address bar without a `hashchange`, so pass the auth status.
 */
export function useLinkCodePurpose(recheck?: unknown): [LinkCodePurpose | null, () => void] {
  const [purpose, setPurpose] = useState<LinkCodePurpose | null>(() => peekLinkCode()?.purpose ?? null);
  useEffect(() => {
    setPurpose(peekLinkCode()?.purpose ?? null);
  }, [recheck]);
  useEffect(() => {
    const onHash = () => setPurpose(peekLinkCode()?.purpose ?? null);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const dismiss = () => {
    clearLinkCode();
    setPurpose(null);
  };
  return [purpose, dismiss];
}
