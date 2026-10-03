/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The HTTP client isomorphic-git talks to remotes through.
 *
 * Written here rather than using isomorphic-git's own Node client because a
 * repository URL is user input that the server dials: it must not become a
 * way to reach the internal network. Three things the stock client does not
 * do:
 *
 * - **Every address is checked when the socket connects**, not once when the
 *   URL is saved, so a name that resolves to a public address at save time
 *   and to 10.0.0.5 later (DNS rebinding) is still refused.
 * - **Redirects are not followed.** A remote that redirects elsewhere gets a
 *   clear error instead of quietly sending the token to another host.
 * - **Size and time are bounded.** A huge or slow remote cannot exhaust the
 *   server.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';

export interface GitNetworkPolicy {
  /** Refuse loopback, private, link-local and unique-local addresses. */
  blockPrivateAddresses: boolean;
  /** Allow `http://` remotes. Only for tests and local development. */
  allowInsecureHttp: boolean;
  /** Largest response body accepted, bytes. */
  maxResponseBytes: number;
  /** Longest a single request may take, ms. */
  timeoutMs: number;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 200 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];

/** Whether `address` is not a public Internet address. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = v4ToInt(address);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') ||
      a.startsWith('fd') || // unique local fc00::/7
      /^fe[89ab]/.test(a) || // link-local fe80::/10
      a.startsWith('ff') // multicast
    );
  }
  return true; // not an IP at all: refuse rather than guess
}

/** A DNS lookup that refuses non-public addresses when the policy says so. */
export function guardedLookup(policy: Pick<GitNetworkPolicy, 'blockPrivateAddresses'>): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
      if (policy.blockPrivateAddresses) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          const e = new Error(`Refusing to connect to ${hostname}: it resolves to a private address.`) as NodeJS.ErrnoException;
          e.code = 'EFOXPRIVATE';
          return callback(e, '', 0);
        }
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      const first = list[0];
      if (!first) return callback(new Error(`No address for ${hostname}.`), '', 0);
      callback(null, first.address, first.family);
    });
  };
}

async function collect(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Buffer | undefined> {
  if (!body) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function* readBody(res: IncomingMessage, maxBytes: number): AsyncIterableIterator<Uint8Array> {
  let total = 0;
  for await (const chunk of res) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      res.destroy();
      throw new Error(`The remote sent more than ${Math.round(maxBytes / 1024 / 1024)} MB; refusing the rest.`);
    }
    yield chunk as Uint8Array;
  }
}

/** An isomorphic-git HTTP client that enforces `policy`. */
export function createGitHttpClient(policy: GitNetworkPolicy): HttpClient {
  const lookup = guardedLookup(policy);
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const url = new URL(req.url);
      if (url.protocol !== 'https:' && !(policy.allowInsecureHttp && url.protocol === 'http:')) {
        throw new Error('Git remotes must use https://.');
      }
      // A literal IP skips DNS, so check it here too.
      if (policy.blockPrivateAddresses && isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
        throw new Error(`Refusing to connect to ${url.hostname}: it is a private address.`);
      }
      const body = await collect(req.body);
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      return new Promise<GitHttpResponse>((resolve, reject) => {
        const r = send(
          url,
          {
            method: req.method ?? 'GET',
            headers: { ...(req.headers ?? {}), ...(body ? { 'content-length': String(body.length) } : {}) },
            lookup,
            timeout: policy.timeoutMs,
            signal: req.signal,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.resume();
              reject(new Error(`The remote redirected to ${res.headers.location ?? 'another address'}; use that URL instead.`));
              return;
            }
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
            resolve({
              url: req.url,
              method: req.method,
              statusCode: status,
              statusMessage: res.statusMessage ?? '',
              headers,
              body: readBody(res, policy.maxResponseBytes),
            });
          }
        );
        r.on('timeout', () => r.destroy(new Error('The remote took too long to answer.')));
        r.on('error', reject);
        if (body) r.end(body);
        else r.end();
      });
    },
  };
}
