/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Signing the browser suites in.
 *
 * Every install requires sign-in. The suites use one admin account
 * (`E2E_APP_EMAIL` / `E2E_APP_PASSWORD` in apps/e2e/.env). On a dev database
 * nobody has set up yet, they create it through first-run setup; after that
 * they sign in.
 *
 * Both calls go to the API port directly. Through the Vite proxy a request
 * carries forwarding headers, so the API treats it as remote and setup would
 * need the code from the server log.
 *
 * The session is cached in a temp file and reused across processes while it is
 * still valid: `run-all.mjs` starts a process per suite, and signing in two
 * dozen times would run into the sign-in limit (20 per 15 minutes).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3210';
const EMAIL = process.env.E2E_APP_EMAIL ?? 'e2e-admin@foxschema.test';
const PASSWORD = process.env.E2E_APP_PASSWORD ?? '';

const CACHE_DIR = join(tmpdir(), 'foxschema-e2e');
const CACHE_FILE = join(CACHE_DIR, `session-${Buffer.from(`${API_URL}|${EMAIL}`).toString('hex')}.txt`);

/** The session cookie's name and value, `sid=…`. */
let cached: string | undefined;

async function stillValid(cookie: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, { headers: { cookie } });
    const body = (await res.json()) as { user?: unknown };
    return res.ok && !!body.user;
  } catch {
    return false;
  }
}

function readCache(): string | undefined {
  try {
    return readFileSync(CACHE_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeCache(cookie: string): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, cookie, { mode: 0o600 });
  } catch {
    /* a cache, not a requirement */
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Sign in (running first-run setup if needed) and return `sid=…`. */
export async function sessionCookie(): Promise<string> {
  if (cached && (await stillValid(cached))) return cached;
  const fromFile = readCache();
  if (fromFile && (await stillValid(fromFile))) return (cached = fromFile);

  if (!PASSWORD) {
    throw new Error('E2E_APP_PASSWORD is not set. Copy it from apps/e2e/.env.example into apps/e2e/.env.');
  }

  const setup = (await (await fetch(`${API_URL}/api/auth/setup`)).json()) as { setupRequired?: boolean };
  const res = setup.setupRequired
    ? await post('/api/auth/setup', { email: EMAIL, password: PASSWORD })
    : await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Could not sign the e2e suites in as ${EMAIL} (HTTP ${res.status} ${detail}). ` +
        'If this dev instance was set up by hand, set E2E_APP_EMAIL / E2E_APP_PASSWORD in ' +
        'apps/e2e/.env to an admin account on it.'
    );
  }
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (!cookie.startsWith('sid=')) throw new Error('Sign-in answered without a session cookie.');
  writeCache(cookie);
  return (cached = cookie);
}

/** Put the session on the browser, for pages served at `baseUrl`. */
export async function signInBrowser(page: Page, baseUrl: string): Promise<void> {
  const [name, ...rest] = (await sessionCookie()).split('=');
  await page.context().addCookies([{ name: name!, value: rest.join('='), url: baseUrl }]);
}
