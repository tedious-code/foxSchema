/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who may run first-run setup.
 *
 * Setup creates (or claims) the first admin account, so on a freshly started
 * server whoever reaches it first owns the install. Someone at the machine is
 * the owner by definition; anyone else has to prove access to the machine by
 * reading the setup code printed in the server's own log (deterministically
 * derived from the install's encryption key so it survives restarts during
 * initial install, or by supplying the install encryption key itself).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppRequest } from '../http/types';
import { defaultListenHost, isLocalSingleUser, isLoopbackHost } from '../runtime/deployment';

let fallbackCode: string | undefined;
let generation = 0;

function installKeyMaterial(): string {
  return (process.env.APP_ENCRYPTION_KEY || process.env.FOXFLOW_ENCRYPTION_KEY || '').trim();
}

function deriveCodeFromKey(keyMaterial: string, gen: number): string {
  const raw = createHmac('sha256', keyMaterial)
    .update(`foxschema-first-run-setup-code:v1:${gen}`)
    .digest('hex')
    .toUpperCase()
    .slice(0, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * The setup code for this install, derived from the install encryption key
 * (`APP_ENCRYPTION_KEY` / `FOXFLOW_ENCRYPTION_KEY`) when present so it stays
 * stable across server restarts during first-run setup, or generated randomly
 * when no key is set.
 */
export function setupCode(): string {
  const key = installKeyMaterial();
  if (key) {
    return deriveCodeFromKey(key, generation);
  }
  if (!fallbackCode) {
    // 40 bits, grouped for reading off a terminal: ABCD-EFGH.
    const raw = randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
    fallbackCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }
  return fallbackCode;
}

/** Rotate/forget the code (after setup succeeds, on local rotation, and between tests). */
export function resetSetupCode(): void {
  fallbackCode = undefined;
  generation += 1;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function onlyLoopbackForwarded(headers: AppRequest['headers'] | undefined): boolean {
  if (!headers) return true;
  if (headers.forwarded) return false;
  const allLoopback = (raw: string | string[] | undefined): boolean => {
    if (raw === undefined) return true;
    const text = Array.isArray(raw) ? raw.join(',') : raw;
    const parts = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.every((part) => LOOPBACK.has(part));
  };
  return allLoopback(headers['x-forwarded-for']) && allLoopback(headers['x-real-ip']);
}

/**
 * True when the request comes from this machine directly.
 *
 * The raw socket address, never `req.ip`: the server trusts proxy headers, so
 * `req.ip` is whatever `X-Forwarded-For` says. And a request that carries
 * non-loopback forwarding headers is not treated as local even from a loopback
 * socket: a reverse proxy on the same host makes every visitor look local.
 */
export function isDirectLocalRequest(req: AppRequest): boolean {
  // A reverse proxy on this machine is also a loopback peer. Without a
  // forwarding header its Internet clients are indistinguishable from a
  // process on the host, so production servers require the log code unless a
  // launcher that binds only to loopback explicitly enables this exception.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FOX_SETUP_ALLOW_LOCAL_WITHOUT_CODE !== 'true'
  ) {
    return false;
  }
  const address = req.raw?.socket?.remoteAddress ?? '';
  if (!LOOPBACK.has(address)) return false;
  const headers = req.headers ?? {};
  // Only relax forwarding-header rejection when explicitly opted in for a local
  // dev proxy (e.g. `npm run dev` Vite proxy sets FOX_TRUST_LOCAL_DEV_PROXY=true).
  // Bare-metal installs often omit NODE_ENV and must still treat forwarded
  // requests as remote so a same-host reverse proxy cannot bypass setup auth.
  if (process.env.FOX_TRUST_LOCAL_DEV_PROXY === 'true') {
    return onlyLoopbackForwarded(headers);
  }
  return !headers['x-forwarded-for'] && !headers.forwarded && !headers['x-real-ip'];
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Whether `supplied` matches this install's setup code (case-insensitive, with
 * or without the hyphen) or the raw install encryption key itself.
 */
export function setupCodeMatches(supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const trimmed = supplied.trim();
  if (!trimmed) return false;

  const expectedCode = setupCode();
  const normalizedCode = trimmed.toUpperCase();
  const compactSupplied = normalizedCode.replace(/-/g, '');
  const compactExpected = expectedCode.replace(/-/g, '');
  if (
    safeEqualStrings(normalizedCode, expectedCode) ||
    safeEqualStrings(compactSupplied, compactExpected)
  ) {
    return true;
  }

  // Also accept the raw install encryption key (APP_ENCRYPTION_KEY) if the
  // operator pastes their key directly instead of the short derived log code.
  const key = installKeyMaterial();
  if (key.length >= 32) {
    const isHexKey = /^[0-9a-fA-F]{64}$/.test(key);
    if (isHexKey ? safeEqualStrings(trimmed.toLowerCase(), key.toLowerCase()) : safeEqualStrings(trimmed, key)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether this install takes launch links at all: a personal install
 * (`foxschema open`, the desktop app) that listens on this machine only.
 *
 * A shared server never does, and neither does a personal install someone
 * opened to the network: from the moment others can reach it, the owner needs
 * an account, so that is when the link stops standing in for one.
 */
export function launchLinksAllowed(): boolean {
  return isLocalSingleUser() && isLoopbackHost(process.env.LISTEN_HOST ?? defaultListenHost());
}
