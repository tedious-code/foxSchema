/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Auth/setup HTTP helpers: app info, first-run signup, and SSO providers.
 */
import { getApiBase, parseJsonResponse, parseJsonResponseOrNull } from '@/shared/api/apiBase';

/** Non-secret DB/security info for the settings screen. */
export interface AppInfo {
  db: { engine: string; location: string };
  security: { keyScheme: string; emailBound: boolean; boundEmail: string };
}

export async function fetchAppInfo(): Promise<AppInfo> {
  const res = await fetch(`${getApiBase()}/app-info`, { credentials: 'include' });
  return parseJsonResponse<AppInfo>(res);
}

/** Whether the first-run signup wizard has already been resolved (submitted or skipped). */
export async function getSignupState(): Promise<{ shown: boolean }> {
  const res = await fetch(`${getApiBase()}/signup/state`, { credentials: 'include' });
  return parseJsonResponse<{ shown: boolean }>(res);
}

export async function submitSignup(email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${getApiBase()}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, source: 'web' }),
  });
  // Soft: UI shows error from body even when status is non-OK.
  try {
    return await parseJsonResponse<{ ok: boolean; error?: string }>(res);
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function skipSignup(): Promise<void> {
  await fetch(`${getApiBase()}/signup/skip`, { method: 'POST', credentials: 'include' });
}

export type SsoProviderId = 'google' | 'microsoft' | 'github';

export interface SsoProvider {
  id: SsoProviderId;
  label: string;
}

/** Fetch configured SSO providers, throwing on network or non-2xx errors so callers can retry. */
export async function fetchSsoProvidersStrict(): Promise<SsoProvider[]> {
  const res = await fetch(`${getApiBase()}/auth/sso/providers`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`SSO providers request failed (${res.status})`);
  const data = await parseJsonResponseOrNull<{ providers?: SsoProvider[] }>(res);
  if (!data || !Array.isArray(data.providers)) {
    throw new Error('Invalid SSO providers response');
  }
  return data.providers;
}

/** Configured SSO providers (empty if none are set up on the server). */
export async function fetchSsoProviders(): Promise<SsoProvider[]> {
  try {
    return await fetchSsoProvidersStrict();
  } catch {
    return [];
  }
}

/** Full-page redirect into the provider's OAuth flow (returns to the app on success). */
export function startSso(id: SsoProviderId): void {
  window.location.href = `${getApiBase()}/auth/sso/${id}/start`;
}
