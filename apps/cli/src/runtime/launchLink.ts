/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The address `foxschema open` opens.
 *
 * While the install's owner has no account yet, it carries a one-time launch
 * link (`#launch=…`), so they land in the workspace rather than on "Create
 * your account"; the app asks for the account later. The link is minted here,
 * in the metadata database the CLI already holds, so it works whether the
 * server was just started or was already running. In the fragment it never
 * reaches a server log.
 *
 * Any failure falls back to the plain address, where setup or sign-in asks
 * as before: a launch link is a convenience, never the only way in.
 */
import { ensureUiEnv } from './ensureUiEnv';

export interface LaunchAddress {
  url: string;
  /** Whether the address carries a launch link. */
  launched: boolean;
}

export async function launchAddress(
  url: string,
  deps: { prepare?: () => unknown; issue?: () => Promise<string | null> } = {}
): Promise<LaunchAddress> {
  const prepare = deps.prepare ?? ensureUiEnv;
  // Loaded only here: `open` otherwise never needs the backend in this process.
  const issue =
    deps.issue ?? (async () => new (await import('@foxschema/server')).AuthModule().issueLaunchToken());
  try {
    // The server's database settings, so the link lands where it will look.
    prepare();
    const token = await issue();
    if (!token) return { url, launched: false };
    return { url: `${url.replace(/\/$/, '')}/#launch=${encodeURIComponent(token)}`, launched: true };
  } catch {
    return { url, launched: false };
  }
}
