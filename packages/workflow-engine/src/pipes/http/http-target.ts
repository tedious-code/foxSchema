/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * HTTP pipes must not reach this process or cloud metadata. A public webhook
 * with a granted connection used to be able to fetch localhost:3210 from inside
 * the API.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

function refused(target: string): Error {
  return new Error(
    `HTTP request refused: ${target} is not a public address (loopback, link-local, and cloud metadata are blocked)`,
  );
}

function isBlockedIp(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, '').toLowerCase();
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 127 || a === 0 || (a === 169 && b === 254);
}

function hostnameOf(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`HTTP request refused: ${parsed.protocol} is not allowed`);
  }
  return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Throw when `url` would hit this host, IPv4/IPv6 loopback, or link-local metadata. */
export async function assertHttpTargetAllowed(
  url: string,
  options: { resolveHost?: boolean } = {},
): Promise<void> {
  let host: string;
  try {
    host = hostnameOf(url);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('HTTP request URL is not valid');
    throw error;
  }
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) throw refused(host);
  if (isIP(host) && isBlockedIp(host)) throw refused(host);
  if (options.resolveHost === false) return;
  const records = await lookup(host, { all: true, verbatim: true });
  for (const record of records) {
    if (isBlockedIp(record.address)) throw refused(host);
  }
}
