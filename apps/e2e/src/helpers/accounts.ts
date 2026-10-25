/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Calling the API directly, and acting as a second account in a browser.
 *
 * The calls go to the API port, not through the Vite proxy (see app-session.ts).
 */
import type { Page } from 'playwright';
import { buildDriver, BASE_URL } from './driver.js';
import { byTestId } from './test-ids.js';

export const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';

export interface ApiResult {
  status: number;
  json: any;
}

/** One request to `/api<path>` as the session in `cookie`. A body that is not JSON reads as null. */
export async function apiCall(
  method: string,
  path: string,
  body: unknown,
  cookie: string,
  headers: Record<string, string> = {}
): Promise<ApiResult> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Signs `email` in and returns its session cookie as `name=value`. */
export async function signInAs(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`Signing in as ${email} failed: HTTP ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/** A browser signed in with `cookie`, past onboarding. Close it with quitDriver. */
export async function browserAs(cookie: string): Promise<Page> {
  const page = await buildDriver({ signedIn: false });
  const [name, ...rest] = cookie.split('=');
  await page.context().addCookies([{ name: name!, value: rest.join('='), url: BASE_URL }]);
  await page.goto(BASE_URL);
  await page.waitForSelector(`${byTestId('onboarding-skip')}, ${byTestId('profile-menu-trigger')}`, { timeout: 30_000 });
  const skip = page.locator(byTestId('onboarding-skip'));
  if (await skip.count()) await skip.click();
  return page;
}
