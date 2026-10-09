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
 * reading a one-time code from the server's own log.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppRequest } from '../../platform/http/types';
import { defaultListenHost, isLocalSingleUser, isLoopbackHost } from '../../api/deployment';

let code: string | undefined;

/** The one-time setup code for this process, generated on first use. */
export function setupCode(): string {
  if (!code) {
    // 40 bits, grouped for reading off a terminal: ABCD-EFGH.
    const raw = randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
    code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }
  return code;
}

/** Forget the code (after setup succeeds, and between tests). */
export function resetSetupCode(): void {
  code = undefined;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True when the request comes from this machine directly.
 *
 * The raw socket address, never `req.ip`: the server trusts proxy headers, so
 * `req.ip` is whatever `X-Forwarded-For` says. And a request that carries
 * forwarding headers is not treated as local even from a loopback socket: a
 * reverse proxy on the same host makes every visitor look local.
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
  return !headers['x-forwarded-for'] && !headers.forwarded && !headers['x-real-ip'];
}

/** Whether `supplied` matches this process's setup code (case-insensitive). */
export function setupCodeMatches(supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const want = Buffer.from(setupCode());
  const got = Buffer.from(supplied.trim().toUpperCase());
  return got.length === want.length && timingSafeEqual(got, want);
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
