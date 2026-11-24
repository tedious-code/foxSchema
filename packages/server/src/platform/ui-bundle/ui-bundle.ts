/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime verification and version comparison for signed UI bundles served from
 * the Cloudflare Workers CDN (docs/plans/2026-11-22-signed-ui-bundles.md).
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { posix } from 'node:path';
import {
  DEFAULT_FOX_UI_FEED_URL,
  UI_BUNDLE_MAX_FILES,
  UI_BUNDLE_MAX_TOTAL_BYTES,
  UI_BUNDLE_PUBLIC_KEYS,
  type UiBundleChannel,
  type UiBundleManifest,
  type UiBundlePublicKey,
} from '@foxschema/shared';

export const UI_ENVELOPE_SCHEMA = 1;
export const UI_MANIFEST_SCHEMA = 1;
export const UI_CHANNEL_SCHEMA = 1;
export const UI_CHANNEL_PATH = 'channels/stable.json';

const SAFE_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
const VALID_VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DISABLED_VALUES = new Set(['off', 'false', '0', 'none']);

export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isValidUiVersion(version: unknown): version is string {
  return typeof version === 'string' && VALID_VERSION.test(version);
}

/**
 * Safe relative path inside a bundle folder: POSIX-clean, no leading `/`, no `\`,
 * no empty / `.` / `..` segments, and plain characters only.
 */
export function isSafeUiPath(relPath: unknown): relPath is string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 256) return false;
  if (!SAFE_PATH_CHARS.test(relPath) || relPath.startsWith('/') || relPath.endsWith('/')) return false;
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return posix.normalize(relPath) === relPath;
}

/** Resolve the Cloudflare CDN UI feed URL; null when disabled via env. */
export function resolveUiFeedUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const updatesRaw = (env.FOX_UI_UPDATES ?? '').trim().toLowerCase();
  if (DISABLED_VALUES.has(updatesRaw)) return null;
  const feedRaw = (env.FOX_UI_FEED_URL ?? '').trim();
  if (DISABLED_VALUES.has(feedRaw.toLowerCase())) return null;
  const base = feedRaw || DEFAULT_FOX_UI_FEED_URL;
  return base.replace(/\/+$/, '');
}

export function isUiUpdatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveUiFeedUrl(env) !== null;
}

/**
 * Pinned Ed25519 keys from code, optionally extended via `FOX_UI_PUBLIC_KEYS`
 * (`JSON` array of `{id,x}` or comma-separated `id:x` pairs).
 */
export function resolveUiPublicKeys(
  env: NodeJS.ProcessEnv = process.env,
  pinned: readonly UiBundlePublicKey[] = UI_BUNDLE_PUBLIC_KEYS
): UiBundlePublicKey[] {
  const out = new Map<string, UiBundlePublicKey>();
  for (const key of pinned) {
    if (key?.id && key?.x) out.set(key.id, { id: key.id, x: key.x });
  }
  const extra = (env.FOX_UI_PUBLIC_KEYS ?? '').trim();
  if (!extra) return [...out.values()];

  if (extra.startsWith('[')) {
    try {
      const parsed = JSON.parse(extra) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && typeof (item as UiBundlePublicKey).id === 'string' && typeof (item as UiBundlePublicKey).x === 'string') {
            const k = item as UiBundlePublicKey;
            if (k.id.trim() && k.x.trim()) out.set(k.id.trim(), { id: k.id.trim(), x: k.x.trim() });
          }
        }
      }
    } catch {
      /* ignore malformed env JSON */
    }
    return [...out.values()];
  }

  for (const entry of extra.split(',')) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const id = entry.slice(0, idx).trim();
    const x = entry.slice(idx + 1).trim();
    if (id && x) out.set(id, { id, x });
  }
  return [...out.values()];
}

/**
 * Verify a signed Ed25519 envelope against `pinnedKeys` and return the verified
 * payload bytes, or null if malformed, unsigned, or signed by an unknown key.
 */
export function verifySignedEnvelope(
  envelopeBytes: Buffer | string,
  pinnedKeys: readonly UiBundlePublicKey[]
): Buffer | null {
  if (pinnedKeys.length === 0) return null;
  let envelope: { schema?: unknown; alg?: unknown; keyId?: unknown; signature?: unknown; payload?: unknown };
  try {
    const text = typeof envelopeBytes === 'string' ? envelopeBytes : envelopeBytes.toString('utf8');
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    return null;
  }
  if (envelope?.schema !== UI_ENVELOPE_SCHEMA || envelope?.alg !== 'Ed25519') return null;
  if (typeof envelope.keyId !== 'string' || typeof envelope.signature !== 'string' || typeof envelope.payload !== 'string') {
    return null;
  }
  const pinned = pinnedKeys.find((k) => k.id === envelope.keyId);
  if (!pinned) return null;

  try {
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: pinned.x },
      format: 'jwk',
    });
    const payload = Buffer.from(envelope.payload, 'base64');
    const signature = Buffer.from(envelope.signature, 'base64');
    return verify(null, payload, publicKey, signature) ? payload : null;
  } catch {
    return null;
  }
}

/** Validate a signed channel document and refuse expired channels. */
export function parseUiChannel(payloadBytes: Buffer, now = new Date()): UiBundleChannel {
  const channel = JSON.parse(payloadBytes.toString('utf8')) as Partial<UiBundleChannel>;
  if (channel?.schema !== UI_CHANNEL_SCHEMA) throw new Error('Unsupported UI channel schema');
  if (!Number.isInteger(channel.sequence) || (channel.sequence ?? 0) < 1) {
    throw new Error('UI channel has an invalid sequence');
  }
  const expiresMs = typeof channel.expiresAt === 'string' ? Date.parse(channel.expiresAt) : NaN;
  if (!Number.isFinite(expiresMs)) throw new Error('UI channel has an invalid expiresAt timestamp');
  if (expiresMs <= now.getTime()) throw new Error('UI channel has expired');
  if (!channel.releases || typeof channel.releases !== 'object') {
    throw new Error('UI channel lists no releases');
  }
  for (const [contract, entry] of Object.entries(channel.releases)) {
    if (!/^\d+$/.test(contract)) throw new Error(`Invalid contract key in channel: ${contract}`);
    if (!entry || typeof entry !== 'object') throw new Error(`Missing release entry for contract ${contract}`);
    if (!isValidUiVersion(entry.version)) throw new Error(`Invalid version in channel: ${String(entry.version)}`);
    if (!Number.isInteger(entry.sequence) || entry.sequence < 1) {
      throw new Error(`Invalid sequence in channel for ${entry.version}`);
    }
    if (!isSafeUiPath(entry.manifest)) throw new Error(`Unsafe manifest path in channel: ${String(entry.manifest)}`);
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
      throw new Error(`Invalid manifest sha256 in channel for ${entry.version}`);
    }
  }
  return channel as UiBundleChannel;
}

/** Validate a signed UI manifest document before downloading or unpacking its pack. */
export function parseUiManifest(payloadBytes: Buffer): UiBundleManifest {
  const manifest = JSON.parse(payloadBytes.toString('utf8')) as Partial<UiBundleManifest>;
  if (manifest?.schema !== UI_MANIFEST_SCHEMA) throw new Error('Unsupported UI manifest schema');
  if (!isValidUiVersion(manifest.version)) throw new Error('UI manifest has an invalid version');
  if (!Number.isInteger(manifest.sequence) || (manifest.sequence ?? 0) < 1) {
    throw new Error('UI manifest has an invalid sequence');
  }
  if (!Number.isInteger(manifest.apiContract) || (manifest.apiContract ?? 0) < 1) {
    throw new Error('UI manifest has an invalid apiContract');
  }
  if (!manifest.pack || typeof manifest.pack.sha256 !== 'string' || !SHA256_HEX.test(manifest.pack.sha256)) {
    throw new Error('UI manifest has an invalid pack sha256');
  }
  if (!Number.isInteger(manifest.pack.size) || manifest.pack.size <= 0 || manifest.pack.size > UI_BUNDLE_MAX_TOTAL_BYTES) {
    throw new Error('UI manifest has an invalid pack size');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > UI_BUNDLE_MAX_FILES) {
    throw new Error('UI manifest has an invalid files list');
  }

  let total = 0;
  let hasIndex = false;
  for (const file of manifest.files) {
    if (!isSafeUiPath(file?.path)) throw new Error(`UI manifest has an unsafe path: ${String(file?.path)}`);
    if (typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)) {
      throw new Error(`UI manifest has a bad hash for ${file.path}`);
    }
    if (!Number.isInteger(file.size) || file.size < 0) {
      throw new Error(`UI manifest has a bad size for ${file.path}`);
    }
    if (file.path === 'index.html') hasIndex = true;
    total += file.size;
  }
  if (!hasIndex) throw new Error('UI manifest is missing index.html');
  if (total !== manifest.pack.size) throw new Error('UI manifest file sizes do not match pack size');
  return manifest as UiBundleManifest;
}

/**
 * Compare two semver-like UI bundle versions (`a` vs `b`), returning > 0 when
 * `a` is newer than `b`, < 0 when older, and 0 when numerically identical.
 */
export function compareUiVersions(a: string, b: string): number {
  const cleanA = a.replace(/^v/i, '').trim();
  const cleanB = b.replace(/^v/i, '').trim();
  const [coreA, preA = ''] = cleanA.split('-', 2);
  const [coreB, preB = ''] = cleanB.split('-', 2);
  const partsA = coreA.split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = coreB.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA.at(i) ?? 0) - (partsB.at(i) ?? 0);
    if (diff !== 0) return diff;
  }
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return preA.localeCompare(preB);
}

export function isNewerUiVersion(candidate: string, current: string): boolean {
  return compareUiVersions(candidate, current) > 0;
}
