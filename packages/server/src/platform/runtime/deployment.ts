/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which deployment shape this process is running as.
 *
 * The answer decides more than which auth guard is installed: a handful of
 * routes are only safe when the caller is the person sitting at the machine
 * (probing an arbitrary metadata-DB URL, installing a driver, self-updating).
 * Those checks used to be described in comments while the code did nothing, so
 * the predicate lives here where a route can actually call it.
 *
 * Read per call rather than captured at import: tests flip the variable, and a
 * module-load snapshot silently ignores them.
 */

/**
 * A personal install (desktop app, `fox open`) rather than a shared server.
 * `LOCAL_SINGLE_USER=false` declares a shared server.
 *
 * This no longer decides whether anyone signs in: every install does. It
 * decides only which machine-level actions a signed-in user may take.
 */
export function isLocalSingleUser(): boolean {
  return process.env.LOCAL_SINGLE_USER !== 'false';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether a listen address is reachable only from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Where to listen when nobody says: the network in production (Docker), this machine otherwise. */
export function defaultListenHost(): string {
  return process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Refuse to serve the network without production settings.
 *
 * Outside `NODE_ENV=production` Fox encrypts saved credentials with a fixed
 * development key when `APP_ENCRYPTION_KEY` is unset, sends its session cookie
 * without the Secure flag, and lets a request from this machine skip the
 * first-run setup code. Harmless on loopback; on a network address it is a
 * server anyone nearby can read the secrets of. `FOX_INSECURE_DEV=1` is the
 * deliberate opt-in for a development server on a network you trust.
 */
export function assertListenPosture(host: string): void {
  if (isLoopbackHost(host) || process.env.NODE_ENV === 'production' || process.env.FOX_INSECURE_DEV === '1') return;
  throw new Error(
    `Fox will not listen on ${host} outside production: it would encrypt saved credentials with a ` +
      'development key and send its session cookie without the Secure flag. Set NODE_ENV=production ' +
      '(with APP_ENCRYPTION_KEY) to serve on the network, or FOX_INSECURE_DEV=1 for a development server on a network you trust.'
  );
}
