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

function parseIpv6Hextets(address: string): number[] | null {
  let a = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    a = `${a.slice(0, dotted.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

function isBlockedIpv4(ip: string, allowPrivateLan: boolean): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  const c = Number(v4[3]);
  const d = Number(v4[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return true;
  // Always blocked: loopback, unspecified, link-local / cloud metadata.
  if (
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 100 && b === 100 && c === 100 && d === 200)
  ) {
    return true;
  }
  if (allowPrivateLan) return false;
  // Private RFC1918, CGNAT, benchmark, multicast, and reserved ranges.
  return (
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIp(address: string, allowPrivateLan = false): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address, allowPrivateLan);
  if (family === 6) {
    const h = parseIpv6Hextets(address);
    if (!h) return true;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zeroUntil = (n: number) => h.slice(0, n).every((x) => x === 0);
    if (h.every((x) => x === 0)) return true; // ::
    if (zeroUntil(7) && h[7] === 1) return true; // ::1
    if (zeroUntil(5) && h[5] === 0xffff) return isBlockedIpv4(v4(h[6]!, h[7]!), allowPrivateLan);
    if (zeroUntil(6)) return isBlockedIpv4(v4(h[6]!, h[7]!), allowPrivateLan);
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
      return isBlockedIpv4(v4(h[6]!, h[7]!), allowPrivateLan);
    }
    if (h[0] === 0x2002) return isBlockedIpv4(v4(h[1]!, h[2]!), allowPrivateLan);
    const first = h[0]!;
    if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) {
      return true;
    }
    if ((first & 0xfe00) === 0xfc00) {
      // Always block AWS EC2 IPv6 IMDS (fd00:ec2::254); block all ULA unless private LAN opted in.
      if (h[0] === 0xfd00 && h[1] === 0x0ec2 && h[7] === 0x0254) return true;
      return !allowPrivateLan;
    }
    return false;
  }
  return true;
}

function hostnameOf(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`HTTP request refused: ${parsed.protocol} is not allowed`);
  }
  return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Throw when `url` would hit this host, IPv4/IPv6 loopback, link-local metadata, or private LAN. */
export async function assertHttpTargetAllowed(
  url: string,
  options: { resolveHost?: boolean; allowPrivateLan?: boolean } = {},
): Promise<void> {
  const allowPrivateLan =
    options.allowPrivateLan ?? process.env.FOXFLOW_ALLOW_PRIVATE_HTTP === 'true';
  let host: string;
  try {
    host = hostnameOf(url);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('HTTP request URL is not valid');
    throw error;
  }
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) throw refused(host);
  if (isIP(host) && isBlockedIp(host, allowPrivateLan)) throw refused(host);
  if (options.resolveHost === false) return;
  const records = await lookup(host, { all: true, verbatim: true });
  for (const record of records) {
    if (isBlockedIp(record.address, allowPrivateLan)) throw refused(host);
  }
}
